// Webhooks: where one may point, what a test and a redelivery do, and what the delivery
// log shows. Real (throwaway) database; the outbound request itself is stubbed, and the
// address checks are exercised with literal addresses so nothing is looked up.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "crypto";
import type { NextApiRequest, NextApiResponse } from "next";

const wire = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; headers: Record<string, string>; body: string }>,
  answer: { status: 200, body: "ok" } as { status: number; body: string } | Error,
}));
vi.mock("@/lib/platform/safe-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/platform/safe-fetch")>()),
  safePost: async (url: string, options: { headers: Record<string, string>; body: string }) => {
    wire.calls.push({ url, headers: options.headers, body: options.body });
    if (wire.answer instanceof Error) throw wire.answer;
    return wire.answer;
  },
}));

import { getDb } from "@/lib/db";
import { emitDomainEvent, processWebhookDeliveries } from "@/lib/platform/events";
import { isPrivateAddress, webhookUrlProblem } from "@/lib/platform/safe-fetch";
import webhooks from "@/pages/api/platform/webhooks";
import { ctxHeaders } from "./helpers/ctx";

const db = () => getDb();
let seq = 0;
const PUBLIC = "https://93.184.216.34/hooks/linki";

async function call(req: Partial<NextApiRequest>) {
  const res: Record<string, unknown> = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  res.end = () => res;
  res.setHeader = () => res;
  await webhooks({ query: {}, body: {}, ...req } as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return res as unknown as { statusCode: number; body: Record<string, unknown> & unknown[] };
}

function workspace() {
  const ws = `ws-hooks-${++seq}`;
  db().prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, ws, ws);
  return { ws, headers: ctxHeaders(ws, { userId: `hooks-admin-${seq}`, role: "admin" }) };
}
async function endpoint(w: { headers: Record<string, string> }, body: Record<string, unknown> = {}) {
  const res = await call({ method: "POST", body: { url: PUBLIC, ...body }, headers: w.headers });
  expect(res.statusCode).toBe(201);
  return { id: String(res.body.id), secret: String(res.body.secret) };
}
const log = async (w: { headers: Record<string, string> }, id: string) =>
  (await call({ method: "GET", query: { deliveries: id }, headers: w.headers })).body as unknown as Array<Record<string, unknown>>;

beforeEach(() => {
  delete process.env.WEBHOOK_ALLOW_PRIVATE_NETWORKS;
  wire.calls.length = 0;
  wire.answer = { status: 200, body: "ok" };
  // Deliveries left pending by an earlier case would be picked up by the next one.
  db().prepare("UPDATE webhook_deliveries SET status = 'delivered' WHERE status IN ('pending','retrying')").run();
});

describe("where a webhook may point", () => {
  it("knows a private or local address from a public one", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.10", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:10.0.0.1", "::ffff:127.0.0.1", "not-an-address"]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "172.15.0.1", "100.63.255.255", "2606:4700:4700::1111"]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it("refuses anything but a public https address", async () => {
    expect(await webhookUrlProblem(PUBLIC)).toBeNull();
    for (const url of ["http://93.184.216.34/x", "https://127.0.0.1/x", "https://169.254.169.254/latest/meta-data", "https://10.0.0.5:8443/x", "https://[::1]/x", "https://user:pass@93.184.216.34/x", "ftp://93.184.216.34/x", "nonsense", ""]) {
      expect(await webhookUrlProblem(url), url).not.toBeNull();
    }
  });

  it("lets an operator allow private addresses for the whole instance", async () => {
    process.env.WEBHOOK_ALLOW_PRIVATE_NETWORKS = "true";
    expect(await webhookUrlProblem("https://10.0.0.5/x")).toBeNull();
    expect(await webhookUrlProblem("http://10.0.0.5/x")).not.toBeNull();
  });

  it("is checked when an endpoint is created", async () => {
    const w = workspace();
    expect((await call({ method: "POST", body: { url: "https://192.168.0.1/hook" }, headers: w.headers })).statusCode).toBe(400);
    expect((await call({ method: "GET", headers: w.headers })).body).toEqual([]);
  });
});

describe("the events an endpoint receives", () => {
  it("default to all, can be a chosen few, and cannot name an event that does not exist", async () => {
    const w = workspace();
    const all = await call({ method: "POST", body: { url: PUBLIC }, headers: w.headers });
    expect(all.body.event_types).toBe("*");
    const some = await call({ method: "POST", body: { url: PUBLIC, event_types: ["reply.received", "email.bounced", "reply.received"] }, headers: w.headers });
    expect(some.body.event_types).toBe("reply.received,email.bounced");
    expect((await call({ method: "POST", body: { url: PUBLIC, event_types: ["reply.recieved"] }, headers: w.headers })).statusCode).toBe(400);
    expect((await call({ method: "PATCH", body: { id: all.body.id, event_types: "nonsense" }, headers: w.headers })).statusCode).toBe(400);
  });

  it("are the only ones delivered to it", async () => {
    const w = workspace();
    const hook = await endpoint(w, { event_types: ["reply.received"] });
    emitDomainEvent({ workspaceId: w.ws, type: "email.sent", payload: {} });
    emitDomainEvent({ workspaceId: w.ws, type: "reply.received", payload: { from: "lee@prospect.test" } });
    await processWebhookDeliveries();
    expect((await log(w, hook.id)).map((d) => d.event_type)).toEqual(["reply.received"]);
  });
});

describe("a test", () => {
  it("reaches the endpoint whatever it is subscribed to, signed with its secret", async () => {
    const w = workspace();
    const hook = await endpoint(w, { event_types: ["reply.received"] });

    const res = await call({ method: "PUT", body: { id: hook.id }, headers: w.headers });

    expect((res.body.deliveries as Array<{ status: string }>)[0].status).toBe("delivered");
    const sent = wire.calls[0];
    expect(sent.url).toBe(PUBLIC);
    expect(sent.headers["x-linki-event"]).toBe("webhook.test");
    const expected = createHmac("sha256", hook.secret).update(`${sent.headers["x-linki-timestamp"]}.${sent.body}`).digest("hex");
    expect(sent.headers["x-linki-signature"]).toBe(`sha256=${expected}`);
  });

  it("goes only to the endpoint asked for", async () => {
    const w = workspace();
    const first = await endpoint(w);
    const second = await endpoint(w);
    await call({ method: "PUT", body: { id: first.id }, headers: w.headers });
    expect(await log(w, first.id)).toHaveLength(1);
    expect(await log(w, second.id)).toHaveLength(0);
  });

  it("is refused for an endpoint that is turned off, or that belongs to someone else", async () => {
    const w = workspace();
    const hook = await endpoint(w);
    await call({ method: "PATCH", body: { id: hook.id, enabled: false }, headers: w.headers });
    expect((await call({ method: "PUT", body: { id: hook.id }, headers: w.headers })).statusCode).toBe(400);
    expect((await call({ method: "PUT", body: { id: hook.id }, headers: workspace().headers })).statusCode).toBe(404);
    expect(wire.calls).toHaveLength(0);
  });
});

describe("the delivery log", () => {
  it("shows what was answered, and a failure can be sent again", async () => {
    const w = workspace();
    const hook = await endpoint(w);
    wire.answer = { status: 500, body: "boom" };
    await call({ method: "PUT", body: { id: hook.id }, headers: w.headers });

    const [failed] = await log(w, hook.id);
    expect(failed).toMatchObject({ event_type: "webhook.test", status: "retrying", attempt: 1, response_status: 500 });
    expect(String(failed.last_error)).toContain("HTTP 500");

    wire.answer = { status: 204, body: "" };
    const again = await call({ method: "PUT", body: { delivery_id: failed.id }, headers: w.headers });
    expect(again.body).toMatchObject({ status: "delivered", response_status: 204, last_error: null });
    expect((await log(w, hook.id))[0]).toMatchObject({ status: "delivered" });
  });

  it("records a connection that was refused", async () => {
    const w = workspace();
    const hook = await endpoint(w);
    wire.answer = new Error("Refusing to deliver to a private or local address");
    await call({ method: "PUT", body: { id: hook.id }, headers: w.headers });
    expect((await log(w, hook.id))[0]).toMatchObject({ status: "retrying", last_error: "Refusing to deliver to a private or local address" });
  });

  it("cannot be read, or resent from, by another workspace", async () => {
    const w = workspace();
    const hook = await endpoint(w);
    await call({ method: "PUT", body: { id: hook.id }, headers: w.headers });
    const [delivery] = await log(w, hook.id);
    const other = workspace();

    expect(await log(other, hook.id)).toEqual([]);
    expect((await call({ method: "PUT", body: { delivery_id: delivery.id }, headers: other.headers })).statusCode).toBe(404);
  });
});

describe("the signing secret", () => {
  it("is returned when the endpoint is created and never again", async () => {
    const w = workspace();
    const hook = await endpoint(w);
    expect(hook.secret).toMatch(/^whsec_/);
    const listed = await call({ method: "GET", headers: w.headers });
    expect(JSON.stringify(listed.body)).not.toContain(hook.secret);
    expect(JSON.stringify(listed.body)).not.toContain("secret");
  });
});
