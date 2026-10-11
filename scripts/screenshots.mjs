/**
 * Retakes every product screenshot: the README's (docs/images) and the public page's
 * (public/welcome), from the demo workspace of a running app.
 *
 *   mkdir -p .demo
 *   LINKI_DB_PATH=.demo/linki-demo.db npm run seed:demo -- --fresh
 *   LINKI_DB_PATH=.demo/linki-demo.db LINKI_RUNNER=off npm run dev
 *   node scripts/screenshots.mjs                              # the app on http://localhost:3000
 *   node scripts/screenshots.mjs http://demo.localhost:3100   # or wherever it runs
 *   node scripts/screenshots.mjs --only inbox,ab-results      # only some of them
 *
 * Safety: it signs in as the demo account from scripts/seed-demo.ts and stops unless the
 * app answers with the demo workspace, so it cannot photograph anybody's real contacts.
 * It only reads: nothing is saved, sent or changed in the app.
 *
 * A screen added by a later phase gets one line in SCREENS; a new close-up for the public
 * page gets one in CLOSE_UPS and is then named in components/welcome/content.ts. The size
 * of each of the page's pictures is written to components/welcome/shots.json, which the
 * page reads so that it can leave the right room for a picture before it has loaded.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const README_DIR = path.join(ROOT, "docs", "images");
const PAGE_DIR = path.join(ROOT, "public", "welcome");
const PAGE_SIZES = path.join(ROOT, "components", "welcome", "shots.json");
/** The size the design was drawn at, and the size every screen is checked at. */
const SCREEN = { width: 1440, height: 1024 };
/** What link previews expect. */
const PREVIEW = { width: 1200, height: 630 };
const TOO_BIG = 400 * 1024;

const args = process.argv.slice(2);
const only = args.includes("--only") ? new Set(args[args.indexOf("--only") + 1]?.split(",").map((name) => name.trim()).filter(Boolean)) : null;
const base = (args.find((arg) => /^https?:\/\//.test(arg)) ?? process.env.LINKI_URL ?? "http://localhost:3000").replace(/\/$/, "");

// The demo sign-in lives in one place, the seed. Read it from there.
const seed = fs.readFileSync(path.join(ROOT, "scripts", "seed-demo.ts"), "utf8");
const fromSeed = (pattern, what) => {
  const found = pattern.exec(seed);
  if (!found) throw new Error(`Could not read ${what} from scripts/seed-demo.ts`);
  return found[1];
};
const DEMO_LOGIN = fromSeed(/const DEMO_LOGIN = "([^"]+)"/, "the demo sign-in");
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || fromSeed(/const DEMO_PASSWORD = process\.env\.DEMO_PASSWORD \|\| "([^"]+)"/, "the demo password");
const DEMO_WORKSPACE = fromSeed(/const WORKSPACE_NAME = "([^"]+)"/, "the demo workspace's name");

/** The campaign, list and person the seed fills in most fully. Each falls back to the first one there is. */
const SHOWCASE = { campaign: "Q4 Enterprise", list: "Enterprise VP Sales", person: "Kenji Bianchi", linkedinAccount: "Marcus Oyelaran" };

// ── What is photographed ──────────────────────────────────────────────────────

/**
 * Whole screens, for the README. `path` may use the ids found in the demo workspace;
 * `prepare` puts the screen in the state worth showing before the picture is taken.
 */
const SCREENS = [
  { name: "dashboard", path: () => "/" },
  { name: "campaigns", path: () => "/campaigns" },
  { name: "sequence-builder", path: (ids) => `/campaigns/${ids.campaign}/sequence`, prepare: openFirstEmailStep, alsoForPage: true },
  { name: "campaign-overview", path: (ids) => `/campaigns/${ids.campaign}` },
  { name: "campaign-prospects", path: (ids) => `/campaigns/${ids.campaign}/prospects` },
  { name: "inbox", path: () => "/inbox", prepare: openShowcaseConversation },
  { name: "contacts", path: () => "/contacts" },
  { name: "contact-profile", path: (ids) => `/contacts/${ids.contact}` },
  { name: "lists", path: () => "/lists" },
  { name: "list-detail", path: (ids) => `/lists/${ids.list}` },
  { name: "linkedin-accounts", path: () => "/linkedin-accounts" },
  { name: "mailboxes", path: () => "/mailboxes" },
  { name: "deliverability", path: () => "/deliverability" },
  { name: "ai-models", path: () => "/ai" },
  { name: "integrations", path: () => "/integrations" },
  { name: "team-roles", path: () => "/team" },
  { name: "developer-api", path: () => "/developers" },
];

/**
 * Parts of a screen, for the public page, at twice the density so they stay sharp.
 * `find` returns the element to photograph. A panel taller than what matters is cut
 * short: `endAt` returns the last element to keep (with `pad` pixels below it), and
 * `through` returns a later element the picture should run on to include.
 */
const CLOSE_UPS = [
  { name: "linkedin-track", path: (ids) => `/campaigns/${ids.campaign}/sequence`, find: (page) => page.locator('section[aria-label="LinkedIn track"]'), endAt: (page) => page.getByRole("button", { name: "Add LinkedIn step" }) },
  { name: "email-track", path: (ids) => `/campaigns/${ids.campaign}/sequence`, find: (page) => page.locator('section[aria-label="Email track"]'), endAt: (page) => page.getByRole("button", { name: "Add email step" }) },
  { name: "linkedin-accounts", path: () => "/linkedin-accounts", find: (page) => accountCard(page), through: (page) => page.locator('main [role="group"]').filter({ hasText: "Warming up" }).first() },
  { name: "mailbox-domain", path: () => "/mailboxes", find: (page) => page.locator('[role="group"][aria-label^="Mailboxes on"]').first() },
  { name: "domain-authentication", path: () => "/deliverability", find: (page) => card(page, "Domain authentication") },
  { name: "guard-log", path: () => "/deliverability", find: (page) => card(page, "Limit-guard log") },
  { name: "inbox-thread", path: () => "/inbox", prepare: openShowcaseConversation, find: (page) => page.locator('section[aria-label^="Conversation with"]'), endAt: (page) => page.locator('section[aria-label^="Conversation with"] article').last(), pad: 14 },
  { name: "ai-budget", path: () => "/ai", find: (page) => page.locator(".shadow-card").filter({ hasText: "Monthly budget" }).last() },
  { name: "writing-style", path: () => "/ai", find: (page) => card(page, "Workspace writing style") },
  { name: "contact-timeline", path: (ids) => `/contacts/${ids.contact}`, find: (page) => card(page, "Outreach timeline") },
  { name: "ab-results", path: (ids) => `/campaigns/${ids.campaign}`, find: (page) => card(page, "A/B variant results") },
  { name: "funnel", path: (ids) => `/campaigns/${ids.campaign}`, find: (page) => card(page, "Conversion funnel") },
  { name: "audit-log", path: () => "/team", find: (page) => card(page, "Audit log") },
  { name: "roles", path: () => "/team", find: (page) => card(page, "Roles & permissions") },
  { name: "webhooks", path: () => "/developers", find: (page) => card(page, "Outbound webhooks") },
  { name: "mcp-server", path: () => "/developers", find: (page) => card(page, "MCP server") },
];

/** The white panel with this heading. The innermost one, when panels are nested. */
function card(page, heading) {
  return page.locator(".shadow-card").filter({ has: page.getByRole("heading", { name: heading }) }).last();
}

function accountCard(page) {
  const named = page.locator(`main [role="group"][aria-label="${SHOWCASE.linkedinAccount}"]`);
  return named.or(page.locator('main [role="group"]').first()).first();
}

async function openFirstEmailStep(page) {
  const step = page.locator('section[aria-label="Email track"]').getByText(/^Email 1\b/).first();
  if (await step.count()) await step.click();
  await page.locator('aside[aria-label="Step settings"]').waitFor({ timeout: 5000 }).catch(() => {});
}

async function openShowcaseConversation(page) {
  const row = page.getByRole("listbox", { name: "Conversations" }).getByText(SHOWCASE.person, { exact: true }).first();
  if (await row.count()) await row.click();
  await page.locator('section[aria-label^="Conversation with"]').waitFor({ timeout: 5000 }).catch(() => {});
}

// ── Taking them ───────────────────────────────────────────────────────────────

const wanted = (name) => !only || only.has(name);
const taken = [];
const failed = [];
/** Kept from the last run, so retaking only some pictures does not forget the rest. */
const pageSizes = fs.existsSync(PAGE_SIZES) ? JSON.parse(fs.readFileSync(PAGE_SIZES, "utf8")) : {};

/** Open a page of the app and wait until it has finished drawing. */
async function open(page, route) {
  await page.goto(`${base}${route}`, { waitUntil: "networkidle" });
  // The development build's own badge sits over the corner of the sidebar.
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => !document.querySelector('main [aria-busy="true"]'), null, { timeout: 8000 }).catch(() => {});
}

async function settle(page) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(350);
}

/** `density` is given for the page's pictures: how many image pixels there are to one on the page. */
function record(file, density) {
  const bytes = fs.readFileSync(file);
  taken.push({ file: path.relative(ROOT, file), size: bytes.length });
  // A PNG states its width and height at fixed places in its header.
  if (density) pageSizes[path.basename(file, ".png")] = { width: Math.round(bytes.readUInt32BE(16) / density), height: Math.round(bytes.readUInt32BE(20) / density) };
}

async function signIn(context) {
  let csrf;
  try {
    csrf = await (await context.request.get(`${base}/api/auth/csrf`)).json();
  } catch {
    throw new Error(`Nothing answered at ${base}. Start the app on the demo database first (see the top of this file).`);
  }
  await context.request.post(`${base}/api/auth/callback/credentials`, { form: { csrfToken: csrf.csrfToken, email: DEMO_LOGIN, password: DEMO_PASSWORD, json: "true" } });
  const shell = await context.request.get(`${base}/api/shell`);
  if (!shell.ok()) throw new Error(`Could not sign in as ${DEMO_LOGIN} at ${base}. Is the app running on a seeded demo database?`);
  const { user, workspace } = await shell.json();
  if (user?.email !== DEMO_LOGIN || workspace?.name !== DEMO_WORKSPACE) {
    throw new Error(`Signed in to "${workspace?.name}", not the demo workspace "${DEMO_WORKSPACE}". Screenshots are only ever taken of demo data.`);
  }
}

/** The records the pictures are of, looked up by name because ids change with every seed. */
async function findIds(context) {
  const read = async (route) => (await context.request.get(`${base}${route}`)).json();
  const campaigns = await read("/api/workflows");
  const lists = await read("/api/lists");
  const named = await read(`/api/targets?limit=1&search=${encodeURIComponent(SHOWCASE.person)}`);
  const { contacts } = named.contacts?.length ? named : await read("/api/targets?limit=1");
  const ids = {
    campaign: (campaigns.find((campaign) => campaign.name.startsWith(SHOWCASE.campaign)) ?? campaigns[0])?.id,
    list: (lists.find((list) => list.name === SHOWCASE.list) ?? lists[0])?.id,
    contact: contacts?.[0]?.id,
  };
  for (const [what, id] of Object.entries(ids)) if (!id) throw new Error(`The demo workspace has no ${what}. Seed it again with --fresh.`);
  return ids;
}

async function attempt(name, work) {
  try {
    await work();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed.push(name);
    console.error(`  ✗ ${name}: ${String(error?.message ?? error).split("\n")[0]}`);
  }
}

const browser = await chromium.launch();
try {
  const flat = await browser.newContext({ viewport: SCREEN, deviceScaleFactor: 1 });
  await signIn(flat);
  const ids = await findIds(flat);
  const session = await flat.storageState();
  fs.mkdirSync(README_DIR, { recursive: true });
  fs.mkdirSync(PAGE_DIR, { recursive: true });

  console.log(`Screens → ${path.relative(ROOT, README_DIR)}`);
  const page = await flat.newPage();
  for (const screen of SCREENS.filter((screen) => wanted(screen.name))) {
    await attempt(screen.name, async () => {
      await open(page, screen.path(ids));
      if (screen.prepare) await screen.prepare(page);
      await settle(page);
      const file = path.join(README_DIR, `${screen.name}.png`);
      await page.screenshot({ path: file, animations: "disabled", caret: "hide" });
      record(file);
      // The public page opens with one whole screen. The same file, so the two never drift.
      if (screen.alsoForPage) {
        fs.copyFileSync(file, path.join(PAGE_DIR, `${screen.name}.png`));
        record(path.join(PAGE_DIR, `${screen.name}.png`), 1);
      }
    });
  }
  await flat.close();

  console.log(`Close-ups → ${path.relative(ROOT, PAGE_DIR)}`);
  const sharp = await browser.newContext({ viewport: SCREEN, deviceScaleFactor: 2, storageState: session });
  const close = await sharp.newPage();
  let at = "";
  for (const shot of CLOSE_UPS.filter((shot) => wanted(shot.name))) {
    await attempt(shot.name, async () => {
      const route = shot.path(ids);
      // Several close-ups come from one screen: open it once.
      if (route !== at || shot.prepare) {
        await open(close, route);
        if (shot.prepare) await shot.prepare(close);
        await settle(close);
        at = shot.prepare ? "" : route;
      }
      const target = shot.find(close);
      await target.scrollIntoViewIfNeeded({ timeout: 5000 });
      const box = await target.boundingBox();
      if (!box) throw new Error("the part to photograph is not on the screen");
      let bottom = box.y + box.height;
      const last = shot.endAt ? await shot.endAt(close).boundingBox() : null;
      if (last) bottom = Math.min(bottom, last.y + last.height + (shot.pad ?? 0));
      const further = shot.through ? await shot.through(close).boundingBox() : null;
      if (further) bottom = Math.max(bottom, further.y + further.height);
      const file = path.join(PAGE_DIR, `${shot.name}.png`);
      await close.screenshot({ path: file, animations: "disabled", caret: "hide", clip: { x: box.x, y: box.y, width: box.width, height: Math.max(1, bottom - box.y) } });
      record(file, 2);
    });
  }
  await sharp.close();

  if (wanted("preview")) {
    console.log(`Link preview → ${path.relative(ROOT, PAGE_DIR)}`);
    const small = await browser.newContext({ viewport: PREVIEW, deviceScaleFactor: 1, storageState: session });
    const preview = await small.newPage();
    await attempt("preview", async () => {
      await open(preview, `/campaigns/${ids.campaign}`);
      await settle(preview);
      const file = path.join(PAGE_DIR, "preview.png");
      await preview.screenshot({ path: file, animations: "disabled", caret: "hide" });
      record(file, 1);
    });
    await small.close();
  }
} finally {
  await browser.close();
}

fs.writeFileSync(PAGE_SIZES, `${JSON.stringify(Object.fromEntries(Object.entries(pageSizes).sort(([a], [b]) => a.localeCompare(b))), null, 2)}\n`);

const kb = (bytes) => `${Math.round(bytes / 1024)} KB`;
const heavy = taken.filter((shot) => shot.size > TOO_BIG);
console.log(`\n${taken.length} pictures, ${kb(taken.reduce((sum, shot) => sum + shot.size, 0))} in all.`);
for (const shot of heavy) console.warn(`  over ${kb(TOO_BIG)}: ${shot.file} (${kb(shot.size)})`);
if (failed.length) {
  console.error(`Not taken: ${failed.join(", ")}`);
  process.exitCode = 1;
}
