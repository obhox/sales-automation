// The real outbound request behind webhook delivery (the other webhook tests stub it):
// that it refuses to connect inwards, and that what it sends and reads back is right.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import http from "http";
import type https from "https";
import type { AddressInfo } from "net";
import { safePost } from "@/lib/platform/safe-fetch";

let server: http.Server;
let port = 0;
const seen: Array<{ method?: string; path?: string; headers: http.IncomingHttpHeaders; body: string }> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      seen.push({ method: req.method, path: req.url, headers: req.headers, body });
      if (req.url === "/redirect") { res.writeHead(302, { location: "http://127.0.0.1:1/elsewhere" }); res.end(); return; }
      if (req.url === "/slow") return; // never answers
      if (req.url === "/big") { res.writeHead(200); res.end("x".repeat(50_000)); return; }
      res.writeHead(req.url === "/fail" ? 500 : 200, { "content-type": "text/plain" });
      res.end(req.url === "/fail" ? "boom" : "received");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
beforeEach(() => { delete process.env.WEBHOOK_ALLOW_PRIVATE_NETWORKS; seen.length = 0; });

/** Stands in for https.request: same call, but lands on the local plain-HTTP server. */
const toLocalServer = ((url: URL, options: http.RequestOptions, callback: (res: http.IncomingMessage) => void) =>
  http.request({ ...options, host: "127.0.0.1", port, path: url.pathname, lookup: undefined }, callback)) as unknown as typeof https.request;

const post = (path: string, timeoutMs?: number) =>
  safePost(`https://hooks.example${path}`, { headers: { "content-type": "application/json", "x-linki-event": "webhook.test" }, body: '{"hello":"world"}', timeoutMs }, toLocalServer);

describe("safePost", () => {
  it("refuses to connect to a private or local address, by number or by name", async () => {
    await expect(safePost("https://127.0.0.1/hook", { headers: {}, body: "{}" })).rejects.toThrow(/private or local/);
    await expect(safePost("https://169.254.169.254/latest/meta-data", { headers: {}, body: "{}" })).rejects.toThrow(/private or local/);
    // "localhost" passes for a hostname; it is the address it resolves to that is refused.
    await expect(safePost("https://localhost/hook", { headers: {}, body: "{}" })).rejects.toThrow(/private or local/);
    await expect(safePost("http://93.184.216.34/hook", { headers: {}, body: "{}" })).rejects.toThrow(/https/);
  });

  it("tries the connection once an operator allows private addresses", async () => {
    process.env.WEBHOOK_ALLOW_PRIVATE_NETWORKS = "true";
    // Nothing listens on port 1: getting as far as a refused connection shows the guard stood aside.
    await expect(safePost("https://127.0.0.1:1/hook", { headers: {}, body: "{}", timeoutMs: 2000 })).rejects.not.toThrow(/private or local/);
  });

  it("posts the body and headers it was given and returns the answer", async () => {
    expect(await post("/hook")).toEqual({ status: 200, body: "received" });
    expect(seen[0]).toMatchObject({ method: "POST", path: "/hook", body: '{"hello":"world"}' });
    expect(seen[0].headers).toMatchObject({ "content-type": "application/json", "x-linki-event": "webhook.test", "content-length": "17" });
  });

  it("hands back an error status rather than throwing, and does not follow a redirect", async () => {
    expect(await post("/fail")).toEqual({ status: 500, body: "boom" });
    expect(await post("/redirect")).toMatchObject({ status: 302 });
    expect(seen.map((request) => request.path)).toEqual(["/fail", "/redirect"]);
  });

  it("keeps only the start of a long answer, and gives up on one that never comes", async () => {
    expect((await post("/big")).body.length).toBeLessThanOrEqual(4000);
    await expect(post("/slow", 300)).rejects.toThrow(/Timed out/);
  });
});
