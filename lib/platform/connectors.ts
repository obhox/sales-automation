import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { emitDomainEvent } from "@/lib/platform/events";

type Provider = "hubspot" | "salesforce" | "ical" | "google_calendar" | "microsoft_calendar";
type Connection = {
  id: string;
  workspace_id: string;
  provider: Provider;
  config_json: string;
  secret_value: string | null;
};

type Contact = {
  id: string;
  email: string | null;
  full_name: string | null;
  first_name: string | null;
  last_name: string | null;
  headline: string | null;
  phone: string | null;
  company: string | null;
};

type CalendarEvent = {
  externalId: string;
  title: string;
  startsAt: string;
  endsAt?: string;
  status?: string;
  attendees: string[];
};

export async function syncConnection(connectionId: string, workspaceId?: string) {
  const db = getDb();
  const connection = db.prepare(`SELECT * FROM external_connections WHERE id = ?${workspaceId ? " AND workspace_id = ?" : ""}`)
    .get(...(workspaceId ? [connectionId, workspaceId] : [connectionId])) as Connection | undefined;
  if (!connection) throw new Error("Connection not found");
  const config = safeJson<Record<string, unknown>>(connection.config_json, {});
  const secret = connection.secret_value ? decryptSecret(connection.secret_value) : null;
  try {
    let result: Record<string, unknown>;
    if (connection.provider === "hubspot") result = await syncHubSpot(connection, secret, config);
    else if (connection.provider === "salesforce") result = await syncSalesforce(connection, secret, config);
    else if (connection.provider === "google_calendar") result = await syncGoogleCalendar(connection, secret, config);
    else if (connection.provider === "microsoft_calendar") result = await syncMicrosoftCalendar(connection, secret, config);
    else result = await syncIcal(connection, config);
    db.prepare("UPDATE external_connections SET last_synced_at = datetime('now'), sync_error = NULL, config_json = ? WHERE id = ?")
      .run(JSON.stringify(config), connection.id);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    db.prepare("UPDATE external_connections SET sync_error = ? WHERE id = ?").run(message.slice(0, 2000), connection.id);
    throw error;
  }
}

export async function syncDueConnections(limit = 3) {
  const rows = getDb().prepare(`SELECT id FROM external_connections
    WHERE enabled = 1 AND (last_synced_at IS NULL OR last_synced_at <= datetime('now', '-15 minutes'))
    ORDER BY COALESCE(last_synced_at, '1970-01-01') LIMIT ?`).all(limit) as Array<{ id: string }>;
  let synced = 0;
  for (const row of rows) {
    try { await syncConnection(row.id); synced += 1; } catch (error) { console.warn("[connectors] sync failed", row.id, error); }
  }
  return synced;
}

async function syncHubSpot(connection: Connection, token: string | null, config: Record<string, unknown>) {
  if (!token) throw new Error("HubSpot private app access token is required");
  const contacts = workspaceContacts(connection.workspace_id);
  let synced = 0;
  for (const batch of chunks(contacts.filter((x) => x.email), 100)) {
    const response = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/batch/upsert", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ inputs: batch.map((contact) => ({ id: contact.email, idProperty: "email", properties: contactProperties(contact) })) }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json().catch(() => ({})) as { results?: Array<{ id?: string; properties?: { email?: string } }>; message?: string };
    if (!response.ok) throw new Error(`HubSpot ${response.status}: ${body.message ?? JSON.stringify(body).slice(0, 500)}`);
    for (const item of body.results ?? []) {
      const local = batch.find((x) => x.email?.toLowerCase() === item.properties?.email?.toLowerCase());
      if (local) saveSyncRecord(connection, "contact", local.id, item.id ?? null, contactProperties(local));
    }
    synced += batch.length;
  }
  const imported = await importHubSpotContacts(connection, token);
  config.last_contact_export_at = new Date().toISOString();
  return { provider: "hubspot", contacts_exported: synced, contacts_imported: imported };
}

async function syncSalesforce(connection: Connection, token: string | null, config: Record<string, unknown>) {
  if (!token) throw new Error("Salesforce access token is required");
  const instanceUrl = String(config.instance_url ?? "").replace(/\/$/, "");
  const apiVersion = String(config.api_version ?? "v67.0");
  const externalField = String(config.external_id_field ?? "");
  if (!instanceUrl || !externalField) throw new Error("Salesforce instance_url and an External ID field are required");
  const contacts = workspaceContacts(connection.workspace_id).filter((x) => x.email);
  let synced = 0;
  for (const batch of chunks(contacts, 25)) {
    const compositeRequest = batch.map((contact, index) => ({
      method: "PATCH",
      url: `/services/data/${apiVersion}/sobjects/Contact/${encodeURIComponent(externalField)}/${encodeURIComponent(contact.email!)}`,
      referenceId: `contact${index}`,
      body: salesforceProperties(contact),
    }));
    const response = await fetch(`${instanceUrl}/services/data/${apiVersion}/composite`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ allOrNone: false, compositeRequest }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json().catch(() => ({})) as { compositeResponse?: Array<{ httpStatusCode: number; body?: { id?: string } | Array<{ message?: string }> }> };
    if (!response.ok) throw new Error(`Salesforce ${response.status}: ${JSON.stringify(body).slice(0, 500)}`);
    (body.compositeResponse ?? []).forEach((item, index) => {
      const local = batch[index];
      if (item.httpStatusCode >= 300) throw new Error(`Salesforce contact sync failed: ${JSON.stringify(item.body).slice(0, 500)}`);
      const externalId = !Array.isArray(item.body) ? item.body?.id : undefined;
      saveSyncRecord(connection, "contact", local.id, externalId ?? local.email, salesforceProperties(local));
      synced += 1;
    });
  }
  const imported=await importSalesforceContacts(connection,token,instanceUrl,apiVersion);
  config.last_contact_export_at = new Date().toISOString();
  return { provider: "salesforce", contacts_exported: synced, contacts_imported: imported };
}

async function importHubSpotContacts(connection:Connection,token:string) {
  let after:string|undefined, imported=0;
  for(let pages=0;pages<40;pages+=1){
    const params=new URLSearchParams({limit:"100",properties:"email,firstname,lastname,jobtitle,phone,company"}); if(after)params.set("after",after);
    const response=await fetch(`https://api.hubapi.com/crm/v3/objects/contacts?${params}`,{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(30_000)});
    const body=await response.json().catch(()=>({})) as {results?:Array<{id:string;properties?:Record<string,string|null>}>;paging?:{next?:{after?:string}};message?:string};
    if(!response.ok)throw new Error(`HubSpot import ${response.status}: ${body.message??JSON.stringify(body).slice(0,500)}`);
    for(const item of body.results??[]){const p=item.properties??{};if(!p.email)continue; const localId=upsertExternalContact(connection,p.email,{first_name:p.firstname,last_name:p.lastname,title:p.jobtitle,phone:p.phone,company:p.company},"hubspot",item.id);if(localId)imported+=1;}
    after=body.paging?.next?.after; if(!after)break;
  }
  return imported;
}

async function importSalesforceContacts(connection:Connection,token:string,instanceUrl:string,apiVersion:string){
  const query=encodeURIComponent("SELECT Id,Email,FirstName,LastName,Title,Phone,Account.Name FROM Contact WHERE Email != null ORDER BY LastModifiedDate DESC LIMIT 10000");
  let url=`${instanceUrl}/services/data/${apiVersion}/query?q=${query}`,imported=0;
  for(let pages=0;url&&pages<40;pages+=1){
    const response=await fetch(url,{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(30_000)});
    const body=await response.json().catch(()=>({})) as {records?:Array<Record<string,unknown>>;nextRecordsUrl?:string;message?:string};
    if(!response.ok)throw new Error(`Salesforce import ${response.status}: ${body.message??JSON.stringify(body).slice(0,500)}`);
    for(const item of body.records??[]){if(!item.Email)continue;const account=item.Account as {Name?:string}|null;const localId=upsertExternalContact(connection,String(item.Email),{first_name:item.FirstName,last_name:item.LastName,title:item.Title,phone:item.Phone,company:account?.Name},"salesforce",String(item.Id));if(localId)imported+=1;}
    url=body.nextRecordsUrl?`${instanceUrl}${body.nextRecordsUrl}`:"";
  }
  return imported;
}

function upsertExternalContact(connection:Connection,email:string,fields:Record<string,unknown>,provider:string,externalId:string){
  const db=getDb(),normalized=email.trim().toLowerCase();
  let row=db.prepare("SELECT id FROM targets WHERE workspace_id=? AND lower(email)=? LIMIT 1").get(connection.workspace_id,normalized) as {id:string}|undefined;
  let created=false;
  if(!row){row={id:randomUUID()};created=true;db.prepare(`INSERT INTO targets (id,workspace_id,email,first_name,last_name,full_name,title,phone,company) VALUES (?,?,?,?,?,?,?,?,?)`).run(row.id,connection.workspace_id,normalized,fields.first_name??null,fields.last_name??null,[fields.first_name,fields.last_name].filter(Boolean).join(" ")||normalized,fields.title??null,fields.phone??null,fields.company??null);}
  else db.prepare(`UPDATE targets SET first_name=COALESCE(?,first_name),last_name=COALESCE(?,last_name),title=COALESCE(?,title),phone=COALESCE(?,phone),company=COALESCE(?,company) WHERE id=?`).run(fields.first_name??null,fields.last_name??null,fields.title??null,fields.phone??null,fields.company??null,row.id);
  getDb().prepare(`INSERT INTO external_sync_records (id,workspace_id,connection_id,entity_type,local_id,external_id,direction,status,payload_json,synced_at)
    VALUES (?,?,?,?,?,?,'inbound','synced',?,datetime('now')) ON CONFLICT(connection_id,entity_type,local_id) DO UPDATE SET external_id=excluded.external_id,direction='inbound',status='synced',payload_json=excluded.payload_json,synced_at=datetime('now')`)
    .run(randomUUID(),connection.workspace_id,connection.id,"contact",row.id,externalId,JSON.stringify(fields));
  if(created)emitDomainEvent({workspaceId:connection.workspace_id,type:"contact.created",entityType:"contact",entityId:row.id,payload:{source:provider,external_id:externalId,email:normalized}});
  return row.id;
}

async function syncGoogleCalendar(connection: Connection, token: string | null, config: Record<string, unknown>) {
  if (!token) throw new Error("Google Calendar access token is required");
  const calendarId = encodeURIComponent(String(config.calendar_id ?? "primary"));
  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;
  let imported = 0;
  do {
    const params = new URLSearchParams({ singleEvents: "true", maxResults: "2500" });
    if (config.sync_token) params.set("syncToken", String(config.sync_token));
    else params.set("timeMin", new Date(Date.now() - 30 * 86400_000).toISOString());
    if (pageToken) params.set("pageToken", pageToken);
    const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?${params}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
    if (response.status === 410 && config.sync_token) {
      delete config.sync_token;
      return syncGoogleCalendar(connection, token, config);
    }
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(`Google Calendar ${response.status}: ${String(body.error ?? JSON.stringify(body)).slice(0, 500)}`);
    const items = Array.isArray(body.items) ? body.items as Array<Record<string, unknown>> : [];
    for (const item of items) {
      const start = item.start as Record<string, unknown> | undefined;
      const end = item.end as Record<string, unknown> | undefined;
      if (!item.id || !(start?.dateTime || start?.date)) continue;
      imported += upsertMeeting(connection, {
        externalId: String(item.id), title: String(item.summary ?? "Calendar meeting"),
        startsAt: String(start.dateTime ?? start.date), endsAt: end ? String(end.dateTime ?? end.date ?? "") : undefined,
        status: String(item.status ?? "confirmed"), attendees: emailsFromGoogle(item.attendees),
      });
    }
    pageToken = typeof body.nextPageToken === "string" ? body.nextPageToken : undefined;
    nextSyncToken = typeof body.nextSyncToken === "string" ? body.nextSyncToken : nextSyncToken;
  } while (pageToken);
  if (nextSyncToken) config.sync_token = nextSyncToken;
  return { provider: "google_calendar", meetings_imported: imported };
}

async function syncMicrosoftCalendar(connection: Connection, token: string | null, config: Record<string, unknown>) {
  if (!token) throw new Error("Microsoft Graph access token is required");
  let url = typeof config.delta_url === "string" ? config.delta_url : undefined;
  if (!url) {
    const start = new Date(Date.now() - 30 * 86400_000).toISOString();
    const end = new Date(Date.now() + 365 * 86400_000).toISOString();
    url = `https://graph.microsoft.com/v1.0/me/calendarView/delta?startDateTime=${encodeURIComponent(start)}&endDateTime=${encodeURIComponent(end)}`;
  }
  let imported = 0;
  for (let pages = 0; url && pages < 50; pages += 1) {
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}`, prefer: 'outlook.timezone="UTC"' }, signal: AbortSignal.timeout(30_000) });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(`Microsoft Graph ${response.status}: ${String(body.error ?? JSON.stringify(body)).slice(0, 500)}`);
    const items = Array.isArray(body.value) ? body.value as Array<Record<string, unknown>> : [];
    for (const item of items) {
      if (item["@removed"]) continue;
      const start = item.start as Record<string, unknown> | undefined;
      const end = item.end as Record<string, unknown> | undefined;
      if (!item.id || !start?.dateTime) continue;
      imported += upsertMeeting(connection, {
        externalId: String(item.id), title: String(item.subject ?? "Calendar meeting"), startsAt: normalizeGraphDate(start.dateTime),
        endsAt: end?.dateTime ? normalizeGraphDate(end.dateTime) : undefined, status: item.isCancelled ? "cancelled" : "confirmed",
        attendees: emailsFromMicrosoft(item.attendees),
      });
    }
    const next = body["@odata.nextLink"];
    const delta = body["@odata.deltaLink"];
    if (typeof delta === "string") config.delta_url = delta;
    url = typeof next === "string" ? next : undefined;
  }
  return { provider: "microsoft_calendar", meetings_imported: imported };
}

async function syncIcal(connection: Connection, config: Record<string, unknown>) {
  const url = String(config.url ?? "");
  if (!/^https?:\/\//.test(url)) throw new Error("iCal feed URL is required");
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`iCal ${response.status}`);
  const text = (await response.text()).replace(/\r?\n[ \t]/g, "");
  let imported = 0;
  for (const block of text.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) ?? []) {
    const value = (key: string) => block.match(new RegExp(`^${key}(?:;[^:]*)?:(.*)$`, "m"))?.[1]?.trim();
    const id = value("UID"), start = value("DTSTART");
    if (!id || !start) continue;
    imported += upsertMeeting(connection, { externalId: id, title: unescapeIcal(value("SUMMARY") ?? "Calendar meeting"), startsAt: icalDate(start), endsAt: value("DTEND") ? icalDate(value("DTEND")!) : undefined, status: value("STATUS")?.toLowerCase(), attendees: [...block.matchAll(/^ATTENDEE(?:;[^:]*)?:mailto:([^\r\n]+)/gim)].map((m) => m[1].trim().toLowerCase()) });
  }
  return { provider: "ical", meetings_imported: imported };
}

function upsertMeeting(connection: Connection, event: CalendarEvent): number {
  const db = getDb();
  const existing = db.prepare("SELECT id FROM meetings WHERE connection_id = ? AND external_id = ?").get(connection.id, event.externalId) as { id: string } | undefined;
  const target = event.attendees.length ? db.prepare(`SELECT id FROM targets WHERE workspace_id = ? AND lower(email) IN (${event.attendees.map(() => "?").join(",")}) LIMIT 1`).get(connection.workspace_id, ...event.attendees.map((x) => x.toLowerCase())) as { id: string } | undefined : undefined;
  const opportunity = target ? db.prepare("SELECT id FROM opportunities WHERE workspace_id = ? AND target_id = ? ORDER BY updated_at DESC LIMIT 1").get(connection.workspace_id, target.id) as { id: string } | undefined : undefined;
  if (existing) {
    db.prepare(`UPDATE meetings SET target_id = COALESCE(?, target_id), opportunity_id = COALESCE(?, opportunity_id),
      title = ?, starts_at = ?, ends_at = ?, attendees_json = ?, status = ? WHERE id = ?`)
      .run(target?.id ?? null, opportunity?.id ?? null, event.title, event.startsAt, event.endsAt ?? null, JSON.stringify(event.attendees), event.status ?? null, existing.id);
    return 0;
  }
  const id = randomUUID();
  db.prepare(`INSERT INTO meetings (id, workspace_id, connection_id, target_id, opportunity_id, external_id, title, starts_at, ends_at, attendees_json, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, connection.workspace_id, connection.id, target?.id ?? null, opportunity?.id ?? null, event.externalId, event.title, event.startsAt, event.endsAt ?? null, JSON.stringify(event.attendees), event.status ?? null);
  emitDomainEvent({ workspaceId: connection.workspace_id, type: "meeting.booked", entityType: "meeting", entityId: id, payload: { ...event, target_id: target?.id ?? null, opportunity_id: opportunity?.id ?? null } });
  return 1;
}

function workspaceContacts(workspaceId: string): Contact[] {
  return getDb().prepare(`SELECT id, email, full_name, first_name, last_name, headline, phone, company
    FROM targets WHERE workspace_id = ? AND email IS NOT NULL ORDER BY created_at DESC`).all(workspaceId) as Contact[];
}

function saveSyncRecord(connection: Connection, entityType: string, localId: string, externalId: string | null, payload: unknown) {
  getDb().prepare(`INSERT INTO external_sync_records (id, workspace_id, connection_id, entity_type, local_id, external_id, direction, status, payload_json, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, 'outbound', 'synced', ?, datetime('now'))
    ON CONFLICT(connection_id, entity_type, local_id) DO UPDATE SET external_id=excluded.external_id, status='synced', payload_json=excluded.payload_json, error=NULL, synced_at=datetime('now')`)
    .run(randomUUID(), connection.workspace_id, connection.id, entityType, localId, externalId, JSON.stringify(payload));
}

function contactProperties(contact: Contact) {
  return compact({ email: contact.email, firstname: contact.first_name, lastname: contact.last_name, jobtitle: contact.headline, phone: contact.phone, company: contact.company });
}

function salesforceProperties(contact: Contact) {
  return compact({ Email: contact.email, FirstName: contact.first_name, LastName: contact.last_name || contact.full_name || "Unknown", Title: contact.headline, Phone: contact.phone });
}

function emailsFromGoogle(value: unknown): string[] {
  return Array.isArray(value) ? value.map((x) => typeof x === "object" && x ? String((x as { email?: string }).email ?? "").toLowerCase() : "").filter(Boolean) : [];
}

function emailsFromMicrosoft(value: unknown): string[] {
  return Array.isArray(value) ? value.map((x) => typeof x === "object" && x ? String(((x as { emailAddress?: { address?: string } }).emailAddress?.address) ?? "").toLowerCase() : "").filter(Boolean) : [];
}

function normalizeGraphDate(value: unknown) { const s = String(value); return /Z$|[+-]\d\d:\d\d$/.test(s) ? s : `${s}Z`; }
function icalDate(value: string) { return /^\d{8}T\d{6}Z?$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}${value.endsWith("Z") ? "Z" : ""}` : value; }
function unescapeIcal(value: string) { return value.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1"); }
function compact<T extends Record<string, unknown>>(value: T) { return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null && v !== undefined && v !== "")); }
function chunks<T>(items: T[], size: number) { const result: T[][] = []; for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size)); return result; }
function safeJson<T>(value: string, fallback: T): T { try { return JSON.parse(value) as T; } catch { return fallback; } }
