// The real outbound request behind webhook delivery and connection syncs (the other tests
// stub it): that it refuses to connect inwards, and that what it sends and reads back is right.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import http from "http";
import type https from "https";
import type { AddressInfo } from "net";
import zlib from "zlib";
import { TooLargeError, connectionPrivateNetworksAllowed, connectionUrlProblem, privateNetworksAllowed, safeGet, safePost, safeRequest, webhookUrlProblem } from "@/lib/platform/safe-fetch";

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
      if (req.url === "/moved") { res.writeHead(301, { location: "https://93.184.216.35/feed" }); res.end(); return; }
      if (req.url === "/moved-nearby") { res.writeHead(307, { location: "/feed" }); res.end(); return; }
      if (req.url === "/moved-inside") { res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }); res.end(); return; }
      if (req.url === "/moved-to-plain") { res.writeHead(302, { location: "http://93.184.216.35/feed" }); res.end(); return; }
      if (req.url === "/round") { res.writeHead(302, { location: "/round" }); res.end(); return; }
      if (req.url === "/packed") { res.writeHead(200, { "content-encoding": "gzip" }); res.end(zlib.gzipSync("unpacked ".repeat(2_000))); return; }
      if (req.url === "/feed") { res.writeHead(200, { "content-type": "text/calendar" }); res.end("BEGIN:VCALENDAR"); return; }
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
beforeEach(() => { delete process.env.WEBHOOK_ALLOW_PRIVATE_NETWORKS; delete process.env.CONNECTIONS_ALLOW_PRIVATE_NETWORKS; seen.length = 0; });

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

// ─────────────────────────────────────────────────────────────────────
// The same guard for the addresses a connection syncs with: a calendar feed (a GET, which
// may be plain http and may redirect) and a Salesforce instance (never redirected).

const get = (path: string, options: Parameters<typeof safeGet>[1] = {}) => safeGet(`https://feeds.example${path}`, options, toLocalServer);

describe("safeRequest", () => {
  it("makes a GET and hands back the status, the body and where a redirect points", async () => {
    expect(await safeRequest("https://feeds.example/feed", { headers: { accept: "text/calendar" } }, toLocalServer)).toEqual({ status: 200, body: "BEGIN:VCALENDAR", location: null });
    expect(seen[0]).toMatchObject({ method: "GET", path: "/feed", body: "" });
    expect(seen[0].headers.accept).toBe("text/calendar");
    expect(seen[0].headers["content-length"]).toBeUndefined();
    expect(await safeRequest("https://feeds.example/moved", {}, toLocalServer)).toMatchObject({ status: 301, location: "https://93.184.216.35/feed" });
    // One request each: the redirect was reported, not followed.
    expect(seen.map((request) => request.path)).toEqual(["/feed", "/moved"]);
  });

  it("will not use plain http unless told it may, and never an address with a password in it", async () => {
    await expect(safeRequest("http://93.184.216.34/feed")).rejects.toThrow(/Only https/);
    await expect(safeRequest("ftp://93.184.216.34/feed", { allowHttp: true })).rejects.toThrow(/Only http and https/);
    await expect(safeRequest("https://user:secret@93.184.216.34/feed")).rejects.toThrow(/username or password/);
    await expect(safeRequest("not an address")).rejects.toThrow(/Invalid URL/);
  });

  it("refuses a private or local address whether it is https or http, by number or by name", async () => {
    for (const url of ["http://127.0.0.1/feed.ics", "http://10.0.0.5:8080/feed.ics", "https://169.254.169.254/latest/meta-data/", "http://[::1]/feed.ics", "http://localhost/feed.ics"]) {
      await expect(safeRequest(url, { allowHttp: true }), url).rejects.toThrow(/private or local/);
    }
    expect(seen).toEqual([]);
  });

  it("is let through to a private address only by the setting for what it is doing", async () => {
    // Nothing listens on port 1: getting as far as a refused connection shows the guard stood aside.
    process.env.WEBHOOK_ALLOW_PRIVATE_NETWORKS = "true";
    await expect(safeRequest("http://127.0.0.1:1/feed.ics", { allowHttp: true, allowPrivate: connectionPrivateNetworksAllowed(), timeoutMs: 2000 })).rejects.toThrow(/private or local/);
    process.env.CONNECTIONS_ALLOW_PRIVATE_NETWORKS = "true";
    await expect(safeRequest("http://127.0.0.1:1/feed.ics", { allowHttp: true, allowPrivate: connectionPrivateNetworksAllowed(), timeoutMs: 2000 })).rejects.not.toThrow(/private or local/);
    // And the other way: the setting for connections does not open webhooks.
    delete process.env.WEBHOOK_ALLOW_PRIVATE_NETWORKS;
    await expect(safePost("https://127.0.0.1:1/hook", { headers: {}, body: "{}" })).rejects.toThrow(/private or local/);
    expect(privateNetworksAllowed()).toBe(false);
    expect(connectionPrivateNetworksAllowed()).toBe(true);
  });

  it("reads a real plain-http address once private addresses are allowed", async () => {
    process.env.CONNECTIONS_ALLOW_PRIVATE_NETWORKS = "true";
    expect(await safeRequest(`http://127.0.0.1:${port}/feed`, { allowHttp: true, allowPrivate: connectionPrivateNetworksAllowed() })).toEqual({ status: 200, body: "BEGIN:VCALENDAR", location: null });
  });

  it("gives up on an answer longer than it was told to read, when asked to", async () => {
    const tooLong = safeRequest("https://feeds.example/big", { maxBytes: 10_000, onTooLarge: "fail" }, toLocalServer);
    await expect(tooLong).rejects.toBeInstanceOf(TooLargeError);
    await expect(tooLong).rejects.toThrow(/larger than 10 KB/);
    // Told nothing, it keeps the start, as webhook delivery does.
    expect((await safeRequest("https://feeds.example/big", { maxBytes: 10_000 }, toLocalServer)).body.length).toBe(10_000);
    // An answer that fits is read whole.
    expect((await safeRequest("https://feeds.example/big", { maxBytes: 60_000, onTooLarge: "fail" }, toLocalServer)).body.length).toBe(50_000);
  });

  it("unpacks an answer the server chose to compress, and counts its size unpacked", async () => {
    expect((await safeRequest("https://feeds.example/packed", { maxBytes: 100_000 }, toLocalServer)).body).toBe("unpacked ".repeat(2_000));
    await expect(safeRequest("https://feeds.example/packed", { maxBytes: 5_000, onTooLarge: "fail" }, toLocalServer)).rejects.toBeInstanceOf(TooLargeError);
  });
});

describe("safeGet", () => {
  it("follows a redirect to another public address, or to another path on the same one", async () => {
    expect(await get("/moved")).toMatchObject({ status: 200, body: "BEGIN:VCALENDAR" });
    expect(await get("/moved-nearby")).toMatchObject({ status: 200, body: "BEGIN:VCALENDAR" });
    expect(seen.map((request) => request.path)).toEqual(["/moved", "/feed", "/moved-nearby", "/feed"]);
  });

  it("does not follow a redirect to a private address: the next hop is held to the same rule", async () => {
    await expect(get("/moved-inside", { allowHttp: true })).rejects.toThrow(/private or local/);
    // The public address was asked; the address it pointed at was not.
    expect(seen.map((request) => request.path)).toEqual(["/moved-inside"]);
  });

  it("does not follow a redirect from https down to http unless http is allowed", async () => {
    await expect(get("/moved-to-plain")).rejects.toThrow(/Only https/);
    expect(await get("/moved-to-plain", { allowHttp: true })).toMatchObject({ status: 200 });
  });

  it("stops after five redirects, or as many as it is told", async () => {
    await expect(get("/round")).rejects.toThrow(/Too many redirects/);
    expect(seen).toHaveLength(6);
    seen.length = 0;
    await expect(get("/round", { maxRedirects: 1 })).rejects.toThrow(/Too many redirects/);
    expect(seen).toHaveLength(2);
    // An answer that is not a redirect is handed back as it is, whatever its status.
    expect(await get("/fail")).toMatchObject({ status: 500, body: "boom" });
  });
});

describe("where a connection may point", () => {
  it("is anywhere public, over https, or over http when that is allowed", async () => {
    expect(await connectionUrlProblem("https://93.184.216.34/calendar.ics")).toBeNull();
    expect(await connectionUrlProblem("http://93.184.216.34/calendar.ics", { allowHttp: true })).toBeNull();
    expect(await connectionUrlProblem("http://93.184.216.34/calendar.ics")).toMatch(/starting with https:\/\/$/);
    expect(await connectionUrlProblem("webcal://93.184.216.34/calendar.ics", { allowHttp: true })).toMatch(/https:\/\/ or http:\/\//);
    expect(await connectionUrlProblem("calendar", { allowHttp: true })).toMatch(/full address/);
    expect(await connectionUrlProblem("https://user:secret@93.184.216.34/calendar.ics")).toMatch(/username or password/);
  });

  it("is never a private or local address, by number or by name, and says who can allow it", async () => {
    for (const url of ["https://127.0.0.1/a.ics", "http://10.1.2.3/a.ics", "https://192.168.1.10:8443", "https://169.254.169.254/latest/meta-data", "https://[::1]/a.ics", "https://[fd00::1]/a.ics", "http://localhost:8080/a.ics"]) {
      expect(await connectionUrlProblem(url, { allowHttp: true }), url).toMatch(/private or local network.*Whoever runs this instance can allow it/);
    }
  });

  it("is not fooled by another way of writing a local address", async () => {
    // One number, hexadecimal, a short form, octal, and IPv4 inside IPv6, in both spellings: all 127.0.0.1 or 10.0.0.5.
    for (const url of ["http://2130706433/a.ics", "http://0x7f000001/a.ics", "http://127.1/a.ics", "http://017700000001/a.ics", "http://[::ffff:127.0.0.1]/a.ics", "http://[::ffff:7f00:1]/a.ics", "http://[0:0:0:0:0:ffff:a00:5]/a.ics", "http://0/a.ics"]) {
      expect(await connectionUrlProblem(url, { allowHttp: true }), url).toMatch(/private or local network/);
      await expect(safeRequest(url, { allowHttp: true }), url).rejects.toThrow(/private or local/);
    }
    expect(seen).toEqual([]);
  });

  it("follows its own setting, not the one for webhooks", async () => {
    process.env.WEBHOOK_ALLOW_PRIVATE_NETWORKS = "true";
    expect(await connectionUrlProblem("https://10.1.2.3/a.ics")).toMatch(/private or local/);
    expect(await webhookUrlProblem("https://10.1.2.3/hook")).toBeNull();
    delete process.env.WEBHOOK_ALLOW_PRIVATE_NETWORKS;
    process.env.CONNECTIONS_ALLOW_PRIVATE_NETWORKS = "true";
    expect(await connectionUrlProblem("https://10.1.2.3/a.ics")).toBeNull();
    expect(await connectionUrlProblem("http://localhost:8080/a.ics", { allowHttp: true })).toBeNull();
    expect(await webhookUrlProblem("https://10.1.2.3/hook")).not.toBeNull();
    // Allowing private addresses does not allow a malformed one.
    expect(await connectionUrlProblem("10.1.2.3/a.ics")).toMatch(/full address/);
  });
});
