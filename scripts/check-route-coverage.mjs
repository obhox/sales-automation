#!/usr/bin/env node
// Which API routes does the app's own UI use?
//
// A capability whose route no screen calls is one nobody can reach by clicking.
// Sometimes that is right (a route kept for API callers or the MCP server) and
// sometimes it is a button that was lost. This lists every route under pages/api
// and says which of three things is true of it:
//
//   UI          a screen calls it
//   API-only    it is listed in scripts/api-only-routes.json with a reason
//   uncalled    neither: nothing in the app calls it and nobody has said why
//
//   node scripts/check-route-coverage.mjs            report
//   node scripts/check-route-coverage.mjs --strict   exit 1 if any route is uncalled
//   node scripts/check-route-coverage.mjs --list     also print the uncalled routes
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const strict = process.argv.includes("--strict");
const list = process.argv.includes("--list") || strict;

function walk(dir, keep) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(relative, keep));
    else if (keep(relative)) out.push(relative);
  }
  return out;
}

const matchesPattern = (file, pattern) => (pattern.endsWith("/**") ? file.startsWith(pattern.slice(0, -2)) : file === pattern);

// ── Routes ────────────────────────────────────────────────────────────────────
const routes = walk("pages/api", file => /\.(ts|tsx)$/.test(file)).map(file => {
  const route = "/" + file.replace(/^pages\//, "").replace(/\.(ts|tsx)$/, "").replace(/\/index$/, "");
  const pattern = route
    .split("/")
    .map(segment => (segment.startsWith("[...") ? ".+" : segment.startsWith("[") ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return { file, route, regex: new RegExp(`^${pattern}$`) };
});

// ── Calls made by UI code ─────────────────────────────────────────────────────
// Any string or template that starts with /api/. `${…}` stands for one path segment.
const uiFiles = [
  ...walk("components", file => /\.(ts|tsx)$/.test(file)),
  // pages/dev is the design-system specimen: its sample text is not a call.
  ...walk("pages", file => /\.tsx$/.test(file) && !file.startsWith("pages/api/") && !file.startsWith("pages/dev/")),
  ...walk("lib/client", file => /\.(ts|tsx)$/.test(file)),
];
const sources = new Map(uiFiles.map(file => [file, fs.readFileSync(path.join(root, file), "utf8")]));
// A screen often builds an address from a named path: `${listPath(id)}/import`, where
// listPath is `(id) => \`/api/lists/${id}\`` in its model file. Those names are collected
// first, so that a call made through one is seen as a call.
const pathHelpers = new Map();
for (const source of sources.values()) {
  for (const match of source.matchAll(/const\s+(\w+)\s*=\s*(?:\([^)]*\)\s*=>\s*)?[`"](\/api\/[^`"\s]*)[`"]/g)) pathHelpers.set(match[1], match[2]);
}
const asCalled = text => text.replace(/\$\{[^}]*\}/g, "param").replace(/\/+$/, "");
const calls = [];
for (const [file, source] of sources) {
  for (const match of source.matchAll(/\/api\/(?:\$\{[^}]*\}|[A-Za-z0-9_\-./\[\]])+/g)) calls.push({ file, called: asCalled(match[0]) });
  for (const match of source.matchAll(/\$\{(\w+)(?:\([^)]*\))?\}((?:\/(?:\$\{[^}]*\}|[A-Za-z0-9_\-.\[\]]+))+)/g)) {
    const base = pathHelpers.get(match[1]);
    if (base) calls.push({ file, called: asCalled(base + match[2]) });
  }
}

// ── API-only allow-list ───────────────────────────────────────────────────────
const apiOnly = JSON.parse(fs.readFileSync(path.join(root, "scripts/api-only-routes.json"), "utf8")).routes;
const apiOnlyReason = route => {
  for (const [pattern, reason] of Object.entries(apiOnly)) if (matchesPattern(route, pattern)) return reason;
  return null;
};
const unknownPatterns = Object.keys(apiOnly).filter(pattern => !routes.some(route => matchesPattern(route.route, pattern)));

// ── Classify ──────────────────────────────────────────────────────────────────
const groups = { UI: [], "API-only": [], uncalled: [] };
for (const route of routes) {
  if (calls.some(call => route.regex.test(call.called))) groups.UI.push(route);
  else if (apiOnlyReason(route.route)) groups["API-only"].push(route);
  else groups.uncalled.push(route);
}

console.log(`${routes.length} API routes`);
for (const [name, members] of Object.entries(groups)) {
  console.log(`  ${String(members.length).padStart(4)}  ${name}`);
  if (list && name === "uncalled") {
    for (const member of members.sort((a, b) => a.route.localeCompare(b.route))) console.log(`          ${member.route}`);
  }
}
if (unknownPatterns.length) {
  console.log(`\nscripts/api-only-routes.json lists patterns that match no route: ${unknownPatterns.join(", ")}`);
}

if (strict && (groups.uncalled.length > 0 || unknownPatterns.length > 0)) {
  console.error(`\n${groups.uncalled.length} route(s) are neither called by a screen nor listed as API-only.`);
  process.exit(1);
}
