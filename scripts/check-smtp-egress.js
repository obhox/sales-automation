#!/usr/bin/env node
/**
 * Does this host have outbound port 25?
 *
 * Email verification can only return "verified" via an SMTP RCPT probe (lib/email/verify.ts),
 * and that probe dials port 25 directly. Most VPS providers block outbound 25 by default to
 * limit spam. When it is blocked every probe times out and every address is reported
 * "unverified" — which looks identical to verification simply not working.
 *
 * Run this ON THE SERVER that runs Linki (inside the container is ideal — that is the network
 * namespace the probe actually uses):
 *
 *   node scripts/check-smtp-egress.js
 *
 * No arguments, no dependencies, read-only: it opens a TCP connection, reads the SMTP
 * greeting, and hangs up without sending mail.
 */
const net = require("net");
const { resolveMx } = require("dns/promises");

const PROBE_DOMAINS = ["gmail.com", "outlook.com", "protonmail.com"];
const CONNECT_TIMEOUT_MS = 10_000;

/** Resolve a domain's lowest-priority MX host. */
async function lowestMx(domain) {
  const records = await resolveMx(domain);
  if (!records.length) throw new Error("no MX records");
  return records.slice().sort((a, b) => a.priority - b.priority)[0].exchange;
}

/**
 * Connect to host:25 and wait for the 220 greeting. Distinguishes the three outcomes that
 * matter: a real greeting (open), a refused/unreachable socket (blocked at the network),
 * and a connection that opens but never speaks (blocked by a silent drop or a filtering
 * middlebox) — the last is the one a plain "can I connect" check gets wrong.
 */
function probeGreeting(host) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.createConnection(25, host);
    socket.setTimeout(CONNECT_TIMEOUT_MS);

    let connected = false;
    let buffer = "";
    const done = (outcome, detail) => {
      try { socket.destroy(); } catch { /* ignore */ }
      resolve({ outcome, detail, ms: Date.now() - started });
    };

    socket.on("connect", () => { connected = true; });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (/\r?\n/.test(buffer)) done("open", buffer.split(/\r?\n/)[0].trim());
    });
    socket.on("timeout", () => done(
      connected ? "silent" : "timeout",
      connected ? "connected but no SMTP greeting within the timeout" : "no response — packets are being dropped",
    ));
    socket.on("error", (err) => done("refused", err.code || err.message));
  });
}

(async () => {
  console.log(`Checking outbound TCP/25 (timeout ${CONNECT_TIMEOUT_MS / 1000}s per host)\n`);
  const results = [];

  for (const domain of PROBE_DOMAINS) {
    let host;
    try {
      host = await lowestMx(domain);
    } catch (err) {
      console.log(`  ${domain.padEnd(16)} DNS FAILED   ${err.message}`);
      results.push("dns");
      continue;
    }
    const { outcome, detail, ms } = await probeGreeting(host);
    const label = { open: "OPEN", refused: "REFUSED", timeout: "BLOCKED", silent: "BLOCKED" }[outcome];
    console.log(`  ${domain.padEnd(16)} ${label.padEnd(12)} ${host} (${ms}ms) — ${detail}`);
    results.push(outcome);
  }

  const open = results.filter((r) => r === "open").length;
  console.log("");

  if (open === results.length) {
    console.log("VERDICT: outbound port 25 is OPEN. SMTP mailbox probing can work from this host,");
    console.log("so restoring the probe in the bulk verification paths will produce real");
    console.log('"verified" verdicts.');
    process.exit(0);
  }
  if (open === 0) {
    console.log("VERDICT: outbound port 25 is BLOCKED. The SMTP probe cannot work from this host —");
    console.log('every address will come back "unverified" no matter what the code does. Verifying');
    console.log("mailboxes needs a provider that does RCPT checks over HTTP; the current free API");
    console.log("only checks syntax, domain and MX, which is why nothing is ever marked verified.");
    process.exit(1);
  }
  console.log(`VERDICT: MIXED — ${open}/${results.length} hosts reachable. Egress is likely filtered per`);
  console.log("destination or rate-limited rather than blocked outright. Treat probing as unreliable.");
  process.exit(2);
})();
