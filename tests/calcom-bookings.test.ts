// Reading Cal.com bookings onto contacts. Cal.com is never reached: fetch is replaced for
// the whole file and a call nobody scripted fails the test.
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.NEXTAUTH_SECRET ||= "test-secret-for-calcom-tests";

import { getDb } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { calcomEvent, syncConnection } from "@/lib/platform/connectors";

type Reply = { status?: number; body?: unknown };
const net = { calls: [] as { url: string; version: string | null; auth: string | null }[], replies: [] as Reply[] };

vi.stubGlobal("fetch", async (input: unknown, init?: { headers?: Record<string, string> }) => {
  const url = String(input);
  if (!url.startsWith("https://api.cal.com") && !url.startsWith("https://cal.acme-example.com")) throw new Error(`A test reached the network: ${url}`);
  net.calls.push({ url, version: init?.headers?.["cal-api-version"] ?? null, auth: init?.headers?.authorization ?? null });
  const reply = net.replies.shift();
  if (!reply) throw new Error(`Cal.com was asked something no test scripted: ${url}`);
  const status = reply.status ?? 200;
  return { ok: status >= 200 && status < 300, status, json: async () => reply.body ?? {} };
});

const page = (data: unknown[], nextCursor: string | null = null) => ({
  body: { status: "success", data, pagination: { nextCursor, hasMore: nextCursor !== null } },
});
/** Both passes answer, since each sync asks by updated and then by created. */
const bothPasses = (data: unknown[]) => { net.replies.push(page(data)); net.replies.push(page(data)); };

const booking = (over: Record<string, unknown> = {}) => ({
  uid: "bk-1", title: "Discovery call", start: "2026-10-14T15:30:00.000Z", end: "2026-10-14T16:00:00.000Z",
  status: "accepted", createdAt: "2026-10-11T09:00:00.000Z", updatedAt: "2026-10-11T09:00:00.000Z",
  hosts: [{ email: "jane@mycompany.example", displayEmail: "jane@mycompany.example" }],
  attendees: [{ name: "John Prospect", email: "john@prospect-example.com", displayEmail: "john@prospect-example.com" }],
  ...over,
});

let seq = 0;
function workspace(config: Record<string, unknown> = {}) {
  const db = getDb();
  const ws = `ws-cal-${++seq}`;
  const id = `conn-cal-${seq}`;
  db.prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, `Cal ${seq}`, `cal-ws-${seq}`);
  db.prepare("INSERT INTO external_connections (id, workspace_id, provider, name, config_json, secret_value) VALUES (?, ?, 'cal_com', 'Cal', ?, ?)")
    .run(id, ws, JSON.stringify(config), encryptSecret("cal_live_test"));
  return { ws, id };
}
const contact = (ws: string, email: string) => {
  const id = `t-${ws}-${Math.random().toString(36).slice(2, 7)}`;
  getDb().prepare("INSERT INTO targets (id, workspace_id, full_name, email, linkedin_url) VALUES (?, ?, 'John Prospect', ?, ?)")
    .run(id, ws, email, `https://linkedin.com/in/${id}`);
  return id;
};
const meetings = (ws: string) => getDb().prepare("SELECT target_id, title, starts_at, status, attendees_json FROM meetings WHERE workspace_id = ?").all(ws) as Record<string, string>[];

beforeEach(() => { net.calls = []; net.replies = []; });

describe("calcomEvent", () => {
  it("dedupes on uid, which is the identifier that survives", () => {
    expect(calcomEvent(booking())?.externalId).toBe("bk-1");
    // id is a per-database sequence; a booking with no uid is not one this can file.
    expect(calcomEvent(booking({ uid: undefined }))).toBeNull();
    expect(calcomEvent(booking({ start: undefined }))).toBeNull();
  });

  it("leaves the host out of the attendees, and the co-hosts a team event adds", () => {
    // Cal.com writes team members into the attendee table, so matching on attendees alone
    // would file a co-hosted meeting against your own colleague rather than the prospect.
    const event = calcomEvent(booking({
      hosts: [{ email: "jane@mycompany.example" }],
      attendees: [
        { email: "jane@mycompany.example" },
        { email: "sam@mycompany.example", displayEmail: "sam@mycompany.example" },
        { email: "john@prospect-example.com" },
      ],
    }));
    // sam is a co-host only if listed as one; here only jane is, so sam stays an attendee.
    expect(event?.attendees).toEqual(["sam@mycompany.example", "john@prospect-example.com"]);
    expect(event?.attendees).not.toContain("jane@mycompany.example");
  });

  it("prefers displayEmail, because the raw one can carry a suffix no contact has", () => {
    const event = calcomEvent(booking({
      attendees: [{ email: "john+a1b2c3d4e5f6g7h8i9j0k1l2m@prospect-example.com", displayEmail: "john@prospect-example.com" }],
    }));
    expect(event?.attendees).toEqual(["john@prospect-example.com"]);
  });

  it("maps a rejection onto a cancellation, which is what a meeting row means by it", () => {
    expect(calcomEvent(booking({ status: "cancelled" }))?.status).toBe("cancelled");
    expect(calcomEvent(booking({ status: "rejected" }))?.status).toBe("cancelled");
    expect(calcomEvent(booking({ status: "accepted" }))?.status).toBe("confirmed");
  });
});

describe("syncing a Cal.com connection", () => {
  it("pins the endpoint version and files the booking on the contact who booked", async () => {
    const { ws, id } = workspace();
    const target = contact(ws, "john@prospect-example.com");
    bothPasses([booking()]);
    const result = await syncConnection(id);

    expect(result).toMatchObject({ provider: "cal_com", meetings_imported: 1, bookings_read: 1 });
    expect(meetings(ws)[0]).toMatchObject({ target_id: target, title: "Discovery call", status: "confirmed" });
    // Omitting the version header may quietly serve an older contract whose pagination is
    // take/skip, which would read page one forever.
    expect(net.calls.every((call) => call.version === "2026-05-01")).toBe(true);
    expect(net.calls[0].auth).toBe("Bearer cal_live_test");
  });

  it("asks by updated AND by created, because updatedAt is nullable", async () => {
    // Prisma only sets updatedAt on update, so a booking made and never touched has none —
    // and a filter on afterUpdatedAt drops exactly those, which are the new ones.
    const { ws, id } = workspace();
    contact(ws, "john@prospect-example.com");
    net.replies.push(page([]));
    net.replies.push(page([booking({ updatedAt: null })]));
    const result = await syncConnection(id);

    expect(result).toMatchObject({ meetings_imported: 1 });
    const filters = net.calls.map((call) => new URL(call.url).searchParams.keys().next().value);
    expect(filters).toContain("afterUpdatedAt");
    expect(filters).toContain("afterCreatedAt");
  });

  it("reads a booking found by both passes once", async () => {
    const { ws, id } = workspace();
    contact(ws, "john@prospect-example.com");
    bothPasses([booking()]);
    expect(await syncConnection(id)).toMatchObject({ bookings_read: 1, meetings_imported: 1 });
    expect(meetings(ws)).toHaveLength(1);
  });

  it("does not filter by status, so a cancellation can come through", async () => {
    // A cancellation is exactly what must arrive for a meeting to stop counting. The five
    // values `status` filters by are view names, not the booking's own field.
    const { ws, id } = workspace();
    contact(ws, "john@prospect-example.com");
    bothPasses([booking()]);
    await syncConnection(id);
    expect(net.calls.every((call) => !new URL(call.url).searchParams.has("status"))).toBe(true);

    net.calls = [];
    bothPasses([booking({ status: "cancelled", updatedAt: "2026-10-11T10:00:00.000Z" })]);
    const result = await syncConnection(id);
    expect(result).toMatchObject({ meetings_imported: 0, meetings_updated: 1 });
    expect(meetings(ws)[0].status).toBe("cancelled");
  });

  it("follows the cursor, and stops when there is no more", async () => {
    const { ws, id } = workspace();
    contact(ws, "john@prospect-example.com");
    net.replies.push(page([booking({ uid: "bk-1" })], "cur-2"));
    net.replies.push(page([booking({ uid: "bk-2" })]));
    net.replies.push(page([]));
    const result = await syncConnection(id);
    expect(result).toMatchObject({ bookings_read: 2 });
    expect(new URL(net.calls[1].url).searchParams.get("cursor")).toBe("cur-2");
  });

  it("remembers where it got to, and re-reads a little before it next time", async () => {
    const { ws, id } = workspace();
    contact(ws, "john@prospect-example.com");
    bothPasses([booking()]);
    await syncConnection(id);

    const config = JSON.parse((getDb().prepare("SELECT config_json FROM external_connections WHERE id = ?").get(id) as { config_json: string }).config_json);
    expect(typeof config.synced_through).toBe("string");

    net.calls = [];
    bothPasses([]);
    await syncConnection(id);
    // Overlapping is free because bookings upsert by uid, and without it a booking written
    // while the last pass ran would fall between two windows and never be seen.
    const asked = Date.parse(new URL(net.calls[0].url).searchParams.get("afterUpdatedAt")!);
    expect(asked).toBeLessThan(Date.parse(config.synced_through));
  });

  it("counts a booking it cannot file against anyone, rather than dropping it quietly", async () => {
    const { ws, id } = workspace();
    bothPasses([booking({ attendees: [] })]);
    const result = await syncConnection(id);
    expect(result).toMatchObject({ without_attendee: 1, meetings_imported: 1 });
    expect(meetings(ws)[0].target_id).toBeNull();
  });

  it("talks to a self-hosted instance when one is configured", async () => {
    // Self-hosted Cal.com serves the API under /api/v2 rather than /v2, so the whole base
    // is one setting instead of a host with a path assumed onto it.
    const { id } = workspace({ base_url: "https://cal.acme-example.com/api/v2" });
    bothPasses([]);
    await syncConnection(id);
    expect(net.calls[0].url.startsWith("https://cal.acme-example.com/api/v2/bookings?")).toBe(true);
  });

  it("records why a sync failed on the connection, rather than losing it", async () => {
    const { id } = workspace();
    net.replies.push({ status: 401, body: { status: "error", error: { code: "UnauthorizedException", message: "Your api key is not valid" } } });
    await expect(syncConnection(id)).rejects.toThrow(/not valid/);
    const row = getDb().prepare("SELECT sync_error FROM external_connections WHERE id = ?").get(id) as { sync_error: string };
    expect(row.sync_error).toContain("Cal.com 401");
  });

  it("treats a 200 that says error as an error", async () => {
    const { id } = workspace();
    net.replies.push({ status: 200, body: { status: "error", error: { message: "something went wrong" } } });
    await expect(syncConnection(id)).rejects.toThrow(/something went wrong/);
  });
});
