// The public API, written down for the reference page. tests/developer-screen-model.test.ts
// checks this list against the route, so an endpoint added there without a line here fails.
import { EVENT_TYPES } from "@/lib/platform/event-types";

export const API_VERSION = "2026-07-17";

export type Method = "GET" | "POST" | "PATCH";

export interface Endpoint {
  method: Method;
  /** Under /api/v1. "{id}" is a record's id. */
  path: string;
  scope: string;
  does: string;
  /** Query parameters or body fields. A trailing * marks one that is required. */
  fields?: string[];
}

export interface EndpointGroup {
  id: string;
  title: string;
  about: string;
  endpoints: Endpoint[];
}

const readOne = (path: string, scope: string, many: string, one: string): Endpoint[] => [
  { method: "GET", path, scope, does: many, fields: ["limit", "offset"] },
  { method: "GET", path: `${path}/{id}`, scope, does: one },
];

export const ENDPOINT_GROUPS: EndpointGroup[] = [
  {
    id: "contacts", title: "Contacts", about: "The people you reach out to, and the addresses that must not be contacted.",
    endpoints: [
      ...readOne("/contacts", "contacts:read", "List contacts, newest first.", "Read one contact."),
      { method: "POST", path: "/contacts", scope: "contacts:write", does: "Create a contact. Emits contact.created.", fields: ["full_name*", "email", "linkedin_url", "title", "company", "location"] },
      { method: "PATCH", path: "/contacts/{id}", scope: "contacts:write", does: "Change a contact. Send only the fields to change.", fields: ["full_name", "first_name", "last_name", "email", "phone", "title", "company", "location", "notes", "owner_id"] },
      { method: "POST", path: "/contacts/verify", scope: "contacts:write", does: "Check contacts' email addresses and suppress the ones that cannot receive mail.", fields: ["contact_ids*"] },
      { method: "POST", path: "/contacts/{id}/send", scope: "email:send", does: "Send one email to a contact. Refused with 409 when the address is suppressed. Sending the same subject and body to the same contact twice sends once.", fields: ["subject*", "body*", "email_account_id"] },
      ...readOne("/suppressions", "contacts:read", "List the do-not-contact entries.", "Read one entry."),
    ],
  },
  {
    id: "audience", title: "Companies and lists", about: "Read-only.",
    endpoints: [
      ...readOne("/companies", "campaigns:read", "List companies.", "Read one company."),
      ...readOne("/lists", "campaigns:read", "List the lists.", "Read one list."),
      { method: "GET", path: "/list_members", scope: "campaigns:read", does: "The contacts in one list, as pairs of list and contact id.", fields: ["list_id*", "limit", "offset"] },
    ],
  },
  {
    id: "campaigns", title: "Campaigns and runs", about: "Read-only. A campaign is called a workflow here; a run is one launch of it on a list.",
    endpoints: [
      ...readOne("/workflows", "campaigns:read", "List campaigns.", "Read one campaign."),
      ...readOne("/runs", "campaigns:read", "List runs.", "Read one run."),
      { method: "GET", path: "/run_profiles", scope: "campaigns:read", does: "The contacts enrolled in one run.", fields: ["run_id*", "limit", "offset"] },
      { method: "GET", path: "/run_profile_tracks", scope: "campaigns:read", does: "Each enrolled contact's progress on each channel of one run.", fields: ["run_id*", "limit", "offset"] },
      { method: "GET", path: "/email_accounts", scope: "campaigns:read", does: "List mailboxes: address, provider and whether it is verified. Never a password.", fields: ["limit", "offset"] },
      ...readOne("/sent_messages", "campaigns:read", "List emails that were sent.", "Read one sent email."),
    ],
  },
  {
    id: "events", title: "Events and signals", about: "What has happened in the workspace, and what you tell it has happened elsewhere.",
    endpoints: [
      { method: "GET", path: "/events", scope: "events:read", does: "List events, newest first. The same events webhooks deliver.", fields: ["limit", "offset"] },
      { method: "POST", path: "/events", scope: "events:write", does: "Report something that happened outside Linki. Answers 202; webhooks subscribed to the type are sent it.", fields: ["type* (email.delivered, email.bounced, reply.received, linkedin.connected or meeting.booked)", "entity_type", "entity_id", "data"] },
      { method: "GET", path: "/signals", scope: "events:read", does: "List signals, newest first.", fields: ["limit", "offset"] },
      { method: "POST", path: "/signals", scope: "signals:write", does: "Send in a signal about a contact or a company. Signal rules may start a campaign from it.", fields: ["type*", "title*", "target_id", "company_id", "description", "score", "source", "occurred_at", "metadata"] },
      ...readOne("/signal_rules", "events:read", "List the rules that act on signals.", "Read one rule."),
    ],
  },
  {
    id: "pipeline", title: "Pipeline", about: "Opportunities and the stages they move through.",
    endpoints: [
      ...readOne("/opportunities", "crm:read", "List opportunities, most recently changed first.", "Read one opportunity."),
      { method: "POST", path: "/opportunities", scope: "crm:write", does: "Create an opportunity.", fields: ["name*", "target_id", "company_id", "stage_id", "owner_id", "amount", "currency", "expected_close_date", "source"] },
      { method: "PATCH", path: "/opportunities/{id}", scope: "crm:write", does: "Change an opportunity. Moving it to another stage emits opportunity.stage_changed.", fields: ["stage_id", "owner_id", "name", "amount", "currency", "expected_close_date", "source"] },
      ...readOne("/pipeline_stages", "crm:read", "List pipeline stages in order.", "Read one stage."),
    ],
  },
];

export interface ErrorRow {
  status: number;
  code: string;
  means: string;
}

export const ERRORS: ErrorRow[] = [
  { status: 400, code: "invalid_request", means: "The body is not what the endpoint takes. `detail` says which field. Other 400 codes name the problem: full_name_required, run_id_required, no_editable_fields." },
  { status: 401, code: "invalid_api_key", means: "No key was sent, or it is wrong, revoked or expired." },
  { status: 403, code: "insufficient_scope", means: "The key may not do this. `required` names the scope it would need." },
  { status: 404, code: "not_found", means: "No such record in this workspace. unknown_resource and unsupported_operation mean the path or the method is not part of the API." },
  { status: 409, code: "recipient_suppressed", means: "The contact's address is on the do-not-contact list, so nothing was sent." },
  { status: 429, code: "rate_limited", means: "The key has made as many requests this minute as its limit allows. `retry_after` and the Retry-After header say how many seconds to wait." },
];

export const WEBHOOK_EVENTS: readonly string[] = EVENT_TYPES;

/** The resources the reference documents, from its paths: "/contacts/{id}/send" → "contacts". */
export function documentedResources(): string[] {
  return [...new Set(ENDPOINT_GROUPS.flatMap((group) => group.endpoints.map((endpoint) => endpoint.path.split("/")[1])))];
}

export function endpointCount(): number {
  return ENDPOINT_GROUPS.reduce((sum, group) => sum + group.endpoints.length, 0);
}

export function curlExample(origin: string): string {
  return `curl "${origin}/api/v1/contacts?limit=2" \\\n  -H "Authorization: Bearer lnk_your_key"`;
}

export const LIST_SHAPE = `{
  "data": [ { "id": "…", "full_name": "…" } ],
  "pagination": { "limit": 2, "offset": 0 }
}`;

export const WEBHOOK_BODY = `{
  "id": "…",
  "type": "reply.received",
  "entity_type": "contact",
  "entity_id": "…",
  "occurred_at": "2026-10-10 14:02:11",
  "data": { }
}`;

export const SIGNATURE = `expected = hex(hmac_sha256(signing_secret, timestamp + "." + raw_body))

x-linki-timestamp: 1791627000
x-linki-signature: sha256=<expected>
x-linki-event:     reply.received`;
