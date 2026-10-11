// Where a CRM or calendar connection may be pointed. A sync fetches a calendar feed's
// address and posts to a Salesforce instance's, both typed by a workspace admin, so neither
// may lead to this server, the cloud metadata service or the private network: refused when
// the connection is saved, and again when it syncs.
//
// Real (throwaway) database and the real guard. A "public" address here is a literal one,
// so nothing is looked up, and the connection itself lands on a plain-HTTP server on this
// machine. Nothing leaves it.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "http";
import type { AddressInfo } from "net";
import type { NextApiRequest, NextApiResponse } from "next";

const wire = vi.hoisted(() => ({ port: 0, local: true }));
vi.mock("@/lib/platform/safe-fetch", async (original) => {
  const real = await original<typeof import("@/lib/platform/safe-fetch")>();
  const plain = await import("http");
  type Send = NonNullable<Parameters<typeof real.safeRequest>[2]>;
  // Stands in for the connection only: the same call, landing on the local server, which is
  // told which host was asked for. Every check before the connection is the real one.
  const toLocalServer = ((url: URL, options: http.RequestOptions, callback: (res: http.IncomingMessage) => void) =>
    plain.request({ ...options, host: "127.0.0.1", port: wire.port, path: url.pathname + url.search, headers: { ...options.headers, "x-asked": url.origin }, lookup: undefined }, callback)) as unknown as Send;
  return {
    ...real,
    safeRequest: (url: string, options?: Parameters<typeof real.safeRequest>[1], transport?: Send) => real.safeRequest(url, options, wire.local ? toLocalServer : transport),
    safeGet: (url: string, options?: Parameters<typeof real.safeGet>[1], transport?: Send) => real.safeGet(url, options, wire.local ? toLocalServer : transport),
  };
});

import { getDb } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import connections, { type ConnectionRow } from "@/pages/api/platform/connections";
import { ctxHeaders } from "./helpers/ctx";

type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown;
interface Answer { statusCode: number; body: unknown }
interface Asked { method?: string; path?: string; origin: string; authorization?: string; body: string }

const db = () => getDb();
const PUBLIC = "https://93.184.216.34";
// The same sentence whether the address is caught at saving or at syncing: it is what the connection's card shows.
const REFUSED = "That address is on a private or local network, which Linki does not connect to. Whoever runs this instance can allow it.";
const FEED = ["BEGIN:VCALENDAR", "VERSION:2.0",
  "BEGIN:VEVENT", "UID:intro-1@feeds.test", "DTSTART:20261101T100000Z", "SUMMARY:Intro call", "ATTENDEE;CN=Lee:mailto:lee@prospect.test", "END:VEVENT",
  "BEGIN:VEVENT", "UID:followup-2@feeds.test", "DTSTART:20261108T100000Z", "SUMMARY:Follow-up", "END:VEVENT",
  "END:VCALENDAR"].join("\r\n");

let server: http.Server;
const seen: Asked[] = [];
let seq = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const origin = String(req.headers["x-asked"] ?? `http://${req.headers.host}`);
      const path = req.url ?? "";
      seen.push({ method: req.method, path, origin, authorization: req.headers.authorization, body });
      const send = (status: number, text: string, headers: http.OutgoingHttpHeaders = {}) => { res.writeHead(status, headers); res.end(text); };
      if (path === "/calendar.ics") return send(200, FEED, { "content-type": "text/calendar" });
      if (path === "/moved.ics") return send(301, "", { location: "https://93.184.216.35/calendar.ics" });
      if (path === "/inside.ics") return send(302, "", { location: "http://169.254.169.254/latest/meta-data/iam/security-credentials/" });
      if (path === "/huge.ics") return send(200, "X".repeat(10 * 1024 * 1024 + 2048));
      if (path === "/gone.ics") return send(404, "no such calendar");
      // A Salesforce instance that has moved: it answers every call with a redirect.
      if (origin === "https://93.184.216.40") return send(307, "", { location: `https://93.184.216.41${path}` });
      if (path.endsWith("/composite") && req.method === "POST") {
        const asked = JSON.parse(body) as { compositeRequest: Array<{ referenceId: string }> };
        return send(200, JSON.stringify({ compositeResponse: asked.compositeRequest.map((item, index) => ({ httpStatusCode: 201, referenceId: item.referenceId, body: { id: `003-${index}` } })) }), { "content-type": "application/json" });
      }
      if (path.includes("/query")) return send(200, JSON.stringify({ records: [{ Id: "003-new", Email: "dana@customer.test", FirstName: "Dana", LastName: "Okoye", Title: "COO", Phone: null, Account: { Name: "Customer Co" } }] }), { "content-type": "application/json" });
      return send(404, "not here");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  wire.port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
beforeEach(() => {
  delete process.env.CONNECTIONS_ALLOW_PRIVATE_NETWORKS;
  delete process.env.WEBHOOK_ALLOW_PRIVATE_NETWORKS;
  wire.local = true;
  seen.length = 0;
  // Neither sync here may reach for fetch, which has no address check. If one ever does again,
  // this fails it at once instead of letting the request out.
  vi.stubGlobal("fetch", () => { throw new Error("A sync used fetch for an address a workspace typed"); });
});
afterEach(() => vi.unstubAllGlobals());

async function call(req: Partial<NextApiRequest>): Promise<Answer> {
  const res: Record<string, unknown> = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  res.end = () => res;
  res.setHeader = () => res;
  await (connections as Handler)({ query: {}, body: {}, headers: {}, ...req } as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return res as unknown as Answer;
}

function workspace() {
  const ws = `ws-sync-${++seq}`;
  db().prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, ws, ws);
  db().prepare("INSERT INTO targets (id, workspace_id, linkedin_url, full_name, first_name, last_name, email) VALUES (?, ?, ?, 'Lee Park', 'Lee', 'Park', 'lee@prospect.test')").run(`${ws}-lee`, ws, `https://www.linkedin.com/in/${ws}-lee`);
  return { ws, admin: ctxHeaders(ws, { userId: `${ws}-admin`, role: "admin" }) };
}
type Workspace = ReturnType<typeof workspace>;

const create = (w: Workspace, body: Record<string, unknown>) => call({ method: "POST", headers: w.admin, body });
const sync = (w: Workspace, id: string) => call({ method: "PUT", headers: w.admin, body: { id } });
const row = async (w: Workspace, id: string) => ((await call({ method: "GET", headers: w.admin })).body as ConnectionRow[]).find((item) => item.id === id)!;
const meetings = (id: string) => (db().prepare("SELECT title FROM meetings WHERE connection_id = ? ORDER BY starts_at").all(id) as Array<{ title: string }>).map((meeting) => meeting.title);
const errorOf = (answer: Answer) => String((answer.body as { error?: string }).error ?? "");

/** A connection as an earlier version would have stored it: straight into the table, with no check on its address. */
function stored(w: Workspace, provider: "ical" | "salesforce", config: Record<string, unknown>): string {
  const id = `${w.ws}-${provider}-${++seq}`;
  db().prepare("INSERT INTO external_connections (id, workspace_id, provider, name, config_json, secret_value) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, w.ws, provider, provider, JSON.stringify(config), provider === "salesforce" ? encryptSecret("sf-token") : null);
  return id;
}

const INSIDE = [
  "http://127.0.0.1:8080/calendar.ics", "https://127.0.0.1/calendar.ics", "http://10.0.0.5/calendar.ics", "https://172.16.4.4/calendar.ics", "https://192.168.1.20/calendar.ics",
  "http://169.254.169.254/latest/meta-data/", "https://100.64.0.1/calendar.ics", "http://[::1]/calendar.ics", "https://[fd12:3456::1]/calendar.ics", "http://0.0.0.0/calendar.ics",
  // A name, not a number: it is the address it resolves to that is refused.
  "http://localhost:8080/calendar.ics",
];

// ─────────────────────────────────────────────────────────────────────
describe("saving a connection", () => {
  it("refuses a calendar feed on a private or local address, and saves nothing", async () => {
    const w = workspace();
    for (const url of INSIDE) {
      const refused = await create(w, { provider: "ical", name: "Feed", config: { url } });
      expect([refused.statusCode, errorOf(refused)], url).toEqual([400, REFUSED]);
    }
    expect((await call({ method: "GET", headers: w.admin })).body).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("refuses a Salesforce instance on a private or local address", async () => {
    const w = workspace();
    for (const instance_url of ["https://10.1.2.3", "https://127.0.0.1:8443", "https://169.254.169.254", "https://[::1]", "https://localhost"]) {
      const refused = await create(w, { provider: "salesforce", name: "Salesforce", secret: "t", config: { instance_url, external_id_field: "Linki_Email__c" } });
      expect([refused.statusCode, errorOf(refused)], instance_url).toEqual([400, expect.stringMatching(/private or local network/)]);
    }
    expect((await call({ method: "GET", headers: w.admin })).body).toEqual([]);
  });

  it("refuses an address with a password in it, and still takes a public one over https or http", async () => {
    const w = workspace();
    expect(errorOf(await create(w, { provider: "ical", name: "Feed", config: { url: "https://lee:hunter2@93.184.216.34/calendar.ics" } }))).toMatch(/username or password/);
    expect((await create(w, { provider: "ical", name: "Https feed", config: { url: `${PUBLIC}/calendar.ics` } })).statusCode).toBe(201);
    expect((await create(w, { provider: "ical", name: "Http feed", config: { url: "http://93.184.216.34/calendar.ics" } })).statusCode).toBe(201);
    expect((await create(w, { provider: "salesforce", name: "Salesforce", secret: "t", config: { instance_url: PUBLIC, external_id_field: "Linki_Email__c" } })).statusCode).toBe(201);
    // Saving asks nothing of the address.
    expect(seen).toEqual([]);
  });

  it("refuses the same when a setting is changed, whichever way it is sent, and keeps what was saved", async () => {
    const w = workspace();
    const feed = ((await create(w, { provider: "ical", name: "Feed", config: { url: `${PUBLIC}/calendar.ics` } })).body as { id: string }).id;
    const salesforce = ((await create(w, { provider: "salesforce", name: "Salesforce", secret: "t", config: { instance_url: PUBLIC, external_id_field: "Linki_Email__c" } })).body as { id: string }).id;
    const config = (id: string) => JSON.parse((db().prepare("SELECT config_json FROM external_connections WHERE id = ?").get(id) as { config_json: string }).config_json);

    for (const body of [
      { id: feed, config_merge: { url: "http://169.254.169.254/latest/meta-data/" } },
      { id: feed, config: { url: "http://10.0.0.5/calendar.ics" } },
      { id: salesforce, config_merge: { instance_url: "https://192.168.1.20" } },
      { id: salesforce, config: { instance_url: "https://127.0.0.1", external_id_field: "Linki_Email__c" } },
    ]) {
      const refused = await call({ method: "PATCH", headers: w.admin, body });
      expect([refused.statusCode, errorOf(refused)], JSON.stringify(body)).toEqual([400, expect.stringMatching(/private or local network/)]);
    }
    expect(config(feed)).toEqual({ url: `${PUBLIC}/calendar.ics` });
    expect(config(salesforce)).toEqual({ instance_url: PUBLIC, external_id_field: "Linki_Email__c" });
    // A change to somewhere public, and one that touches no address, go through.
    expect((await call({ method: "PATCH", headers: w.admin, body: { id: feed, config_merge: { url: "https://93.184.216.35/other.ics" } } })).statusCode).toBe(200);
    expect((await call({ method: "PATCH", headers: w.admin, body: { id: feed, name: "Team calendar", enabled: false } })).statusCode).toBe(200);
    expect(config(feed)).toEqual({ url: "https://93.184.216.35/other.ics" });
  });

  it("takes a private address once the operator allows them for connections, and not because webhooks are allowed", async () => {
    const w = workspace();
    process.env.WEBHOOK_ALLOW_PRIVATE_NETWORKS = "true";
    expect((await create(w, { provider: "ical", name: "Feed", config: { url: "http://10.0.0.5/calendar.ics" } })).statusCode).toBe(400);
    process.env.CONNECTIONS_ALLOW_PRIVATE_NETWORKS = "true";
    expect((await create(w, { provider: "ical", name: "Feed", config: { url: "http://10.0.0.5/calendar.ics" } })).statusCode).toBe(201);
    expect((await create(w, { provider: "salesforce", name: "Salesforce", secret: "t", config: { instance_url: "https://10.1.2.3", external_id_field: "Linki_Email__c" } })).statusCode).toBe(201);
    // It allows where the address is, not what it looks like.
    expect((await create(w, { provider: "salesforce", name: "Salesforce", secret: "t", config: { instance_url: "http://10.1.2.3", external_id_field: "Linki_Email__c" } })).statusCode).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("syncing a calendar feed", () => {
  it("reads a feed at a public address, and files a meeting on the contact who was invited", async () => {
    const w = workspace();
    const id = ((await create(w, { provider: "ical", name: "Feed", config: { url: `${PUBLIC}/calendar.ics` } })).body as { id: string }).id;
    const synced = await sync(w, id);
    expect([synced.statusCode, synced.body]).toEqual([200, { provider: "ical", meetings_imported: 2 }]);
    expect(seen).toEqual([{ method: "GET", path: "/calendar.ics", origin: PUBLIC, authorization: undefined, body: "" }]);
    expect(meetings(id)).toEqual(["Intro call", "Follow-up"]);
    expect((db().prepare("SELECT target_id FROM meetings WHERE connection_id = ? AND title = 'Intro call'").get(id) as { target_id: string }).target_id).toBe(`${w.ws}-lee`);
    expect(await row(w, id)).toMatchObject({ sync_error: null });
    expect((await row(w, id)).last_synced_at).not.toBeNull();
  });

  it("follows a feed that has moved to another public address", async () => {
    const w = workspace();
    const id = ((await create(w, { provider: "ical", name: "Feed", config: { url: `${PUBLIC}/moved.ics` } })).body as { id: string }).id;
    expect((await sync(w, id)).body).toEqual({ provider: "ical", meetings_imported: 2 });
    expect(seen.map((request) => `${request.origin}${request.path}`)).toEqual([`${PUBLIC}/moved.ics`, "https://93.184.216.35/calendar.ics"]);
  });

  it("does not follow a public address that redirects inside, and says why on the connection", async () => {
    const w = workspace();
    const id = ((await create(w, { provider: "ical", name: "Feed", config: { url: `${PUBLIC}/inside.ics` } })).body as { id: string }).id;
    const refused = await sync(w, id);
    expect([refused.statusCode, errorOf(refused)]).toEqual([502, REFUSED]);
    // The public address was asked. The metadata address it pointed at was not.
    expect(seen.map((request) => `${request.origin}${request.path}`)).toEqual([`${PUBLIC}/inside.ics`]);
    expect(meetings(id)).toEqual([]);
    expect(await row(w, id)).toMatchObject({ sync_error: REFUSED, last_synced_at: null });
  });

  it("refuses a connection saved before the check existed, without asking its address anything", async () => {
    const w = workspace();
    // No stand-in for the connection here: these go as far as the real one would.
    wire.local = false;
    for (const url of [`http://127.0.0.1:${wire.port}/calendar.ics`, `http://localhost:${wire.port}/calendar.ics`, "http://169.254.169.254/latest/meta-data/"]) {
      const id = stored(w, "ical", { url });
      const refused = await sync(w, id);
      expect([refused.statusCode, errorOf(refused)], url).toEqual([502, REFUSED]);
      expect(meetings(id)).toEqual([]);
    }
    // The first two addresses are this test's own server. It heard nothing.
    expect(seen).toEqual([]);
  });

  it("reads the same private feed once the operator allows private addresses for connections", async () => {
    const w = workspace();
    wire.local = false;
    const id = stored(w, "ical", { url: `http://127.0.0.1:${wire.port}/calendar.ics` });
    process.env.WEBHOOK_ALLOW_PRIVATE_NETWORKS = "true";
    expect((await sync(w, id)).statusCode).toBe(502);
    process.env.CONNECTIONS_ALLOW_PRIVATE_NETWORKS = "true";
    const synced = await sync(w, id);
    expect([synced.statusCode, synced.body]).toEqual([200, { provider: "ical", meetings_imported: 2 }]);
    // A real request this time, to the server on this machine.
    expect(seen).toEqual([{ method: "GET", path: "/calendar.ics", origin: `http://127.0.0.1:${wire.port}`, authorization: undefined, body: "" }]);
    expect(await row(w, id)).toMatchObject({ sync_error: null });
  });

  it("gives up on a feed larger than 10 MB, and reports a feed that is not there", async () => {
    const w = workspace();
    const huge = ((await create(w, { provider: "ical", name: "Huge", config: { url: `${PUBLIC}/huge.ics` } })).body as { id: string }).id;
    expect(errorOf(await sync(w, huge))).toBe("The calendar feed is larger than 10 MB, which is more than is read");
    const gone = ((await create(w, { provider: "ical", name: "Gone", config: { url: `${PUBLIC}/gone.ics` } })).body as { id: string }).id;
    expect(errorOf(await sync(w, gone))).toBe("iCal 404");
    expect(await row(w, gone)).toMatchObject({ sync_error: "iCal 404" });
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("syncing with Salesforce", () => {
  const salesforce = async (w: Workspace, instance_url: string) =>
    ((await create(w, { provider: "salesforce", name: "Salesforce", secret: "sf-token", config: { instance_url, external_id_field: "Linki_Email__c" } })).body as { id: string }).id;

  it("sends contacts to a public instance and brings its contacts in, with the token on each request", async () => {
    const w = workspace();
    const id = await salesforce(w, PUBLIC);
    const synced = await sync(w, id);
    expect([synced.statusCode, synced.body]).toEqual([200, { provider: "salesforce", contacts_exported: 1, contacts_imported: 1 }]);
    expect(seen.map((request) => [request.method, request.origin, request.path.split("?")[0], request.authorization])).toEqual([
      ["POST", PUBLIC, "/services/data/v67.0/composite", "Bearer sf-token"],
      ["GET", PUBLIC, "/services/data/v67.0/query", "Bearer sf-token"],
    ]);
    const sent = JSON.parse(seen[0].body) as { compositeRequest: Array<{ method: string; url: string; body: Record<string, string> }> };
    expect(sent.compositeRequest).toEqual([{ method: "PATCH", url: "/services/data/v67.0/sobjects/Contact/Linki_Email__c/lee%40prospect.test", referenceId: "contact0", body: { Email: "lee@prospect.test", FirstName: "Lee", LastName: "Park" } }]);
    expect(db().prepare("SELECT full_name, company FROM targets WHERE workspace_id = ? AND email = 'dana@customer.test'").get(w.ws)).toEqual({ full_name: "Dana Okoye", company: "Customer Co" });
    expect(await row(w, id)).toMatchObject({ sync_error: null, sync_record_count: 2 });
  });

  it("does not follow an instance that redirects, so the token goes nowhere it was not sent", async () => {
    const w = workspace();
    const id = await salesforce(w, "https://93.184.216.40");
    const refused = await sync(w, id);
    expect([refused.statusCode, errorOf(refused)]).toEqual([502, expect.stringMatching(/^Salesforce 307/)]);
    expect(seen.map((request) => request.origin)).toEqual(["https://93.184.216.40"]);
  });

  it("refuses an instance saved before the check existed that is on a private or local address, and sends nothing", async () => {
    const w = workspace();
    wire.local = false;
    for (const instance_url of [`https://127.0.0.1:${wire.port}`, "https://10.1.2.3", "https://localhost", `http://127.0.0.1:${wire.port}`]) {
      const id = stored(w, "salesforce", { instance_url, external_id_field: "Linki_Email__c" });
      const refused = await sync(w, id);
      expect(refused.statusCode, instance_url).toBe(502);
      // Private addresses are refused as such; plain http is refused for Salesforce whatever the address.
      expect(errorOf(refused), instance_url).toMatch(instance_url.startsWith("http://") ? /Only https/ : /private or local/);
    }
    expect(seen).toEqual([]);
    expect(db().prepare("SELECT COUNT(*) AS c FROM external_sync_records WHERE workspace_id = ?").get(w.ws)).toEqual({ c: 0 });
  });
});
