#!/usr/bin/env node
// Which API routes does the rebuilt UI actually use?
//
// The rebuild replaces every screen. A capability that only an old screen
// reached (a button on the old settings page, say) is lost silently if no new
// screen calls its route. This lists every route under pages/api and says
// which of four things is true of it:
//
//   new UI      a file on the new design system calls it
//   API-only    it is listed in scripts/api-only-routes.json with a reason
//   old UI only only files that still belong to the old system call it
//   uncalled    nothing in the app's own UI calls it
//
//   node scripts/check-route-coverage.mjs            report
//   node scripts/check-route-coverage.mjs --strict   exit 1 unless every route is "new UI" or "API-only"
//   node scripts/check-route-coverage.mjs --list     also print every route in each group
//
// --strict is for the end of the rebuild, when no old screens are left.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LEGACY_UI_FILES } from "../eslint.config.mjs";

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
const isLegacy = file => LEGACY_UI_FILES.some(pattern => matchesPattern(file, pattern));

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
const calls = [];
for (const file of uiFiles) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  for (const match of source.matchAll(/\/api\/(?:\$\{[^}]*\}|[A-Za-z0-9_\-./\[\]])+/g)) {
    const called = match[0].replace(/\$\{[^}]*\}/g, "param").replace(/\/+$/, "");
    calls.push({ file, called, legacy: isLegacy(file) });
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
const groups = { "new UI": [], "API-only": [], "old UI only": [], uncalled: [] };
for (const route of routes) {
  const callers = calls.filter(call => route.regex.test(call.called));
  if (callers.some(call => !call.legacy)) groups["new UI"].push(route);
  else if (apiOnlyReason(route.route)) groups["API-only"].push(route);
  else if (callers.length) groups["old UI only"].push({ ...route, callers: [...new Set(callers.map(call => call.file))] });
  else groups.uncalled.push(route);
}

console.log(`${routes.length} API routes`);
for (const [name, members] of Object.entries(groups)) {
  console.log(`  ${String(members.length).padStart(4)}  ${name}`);
  if (list && (name === "old UI only" || name === "uncalled")) {
    for (const member of members.sort((a, b) => a.route.localeCompare(b.route))) {
      console.log(`          ${member.route}${member.callers ? `   ← ${member.callers.join(", ")}` : ""}`);
    }
  }
}
if (unknownPatterns.length) {
  console.log(`\nscripts/api-only-routes.json lists patterns that match no route: ${unknownPatterns.join(", ")}`);
}

const missing = groups["old UI only"].length + groups.uncalled.length;
if (strict && (missing > 0 || unknownPatterns.length > 0)) {
  console.error(`\n${missing} route(s) are neither called by the new UI nor listed as API-only.`);
  process.exit(1);
}
