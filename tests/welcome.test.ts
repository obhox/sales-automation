// The public page and the front door: where a signed-out visitor to "/" is sent with the
// switch off and on, that the page is open to anyone and stands outside the old styles,
// that what it says keeps to what may be said, and that every picture the page and the
// README name is really in the repository.
import fs from "fs";
import path from "path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import type { GetServerSidePropsContext } from "next";
import { encode } from "next-auth/jwt";
import { getDb } from "@/lib/db";
import { isPublicPage, proxy } from "@/proxy";
import { WelcomePage } from "@/components/welcome/WelcomePage";
import { getServerSideProps } from "@/pages/welcome";
import { CLOSING, HERO, LICENSE_URL, META, REPOSITORY_URL, SECTIONS, SELF_HOSTED, SETUP_URL, shotSize, shotSrc, type Shot } from "@/components/welcome/content";
// Sets the secret a session cookie is sealed with.
import "./helpers/ctx";

const ROOT = path.resolve(__dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8");
/** A PNG states its width and height at fixed places in its header. */
const pngSize = (file: string) => {
  const bytes = fs.readFileSync(path.join(ROOT, file));
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};

afterEach(() => {
  delete process.env.LINKI_WELCOME_PAGE;
});

// ── The front door ────────────────────────────────────────────────────────────
describe("where a signed-out visitor to the home page is sent", () => {
  const visit = (route: string, cookie?: string) => proxy(new NextRequest(`http://localhost:3000${route}`, { headers: cookie ? { cookie } : {} }));
  const sentTo = async (route: string, cookie?: string) => {
    const location = (await visit(route, cookie)).headers.get("location");
    return location ? new URL(location) : null;
  };
  let cookie: string;
  beforeAll(async () => {
    cookie = `next-auth.session-token=${await encode({ token: { userId: "u-welcome", workspaceId: "ws-welcome", role: "member" }, secret: process.env.NEXTAUTH_SECRET! })}`;
  });

  it("is sign in, as it always was, when the instance has not asked for anything else", async () => {
    const target = await sentTo("/");
    expect(target?.pathname).toBe("/login");
    expect(target?.search).toBe("");
  });

  it("is the public page when the instance sets LINKI_WELCOME_PAGE=on", async () => {
    process.env.LINKI_WELCOME_PAGE = "on";
    const target = await sentTo("/");
    expect(target?.pathname).toBe("/welcome");
    expect(target?.search).toBe("");
  });

  it("stays sign in for any other value of the switch", async () => {
    for (const value of ["off", "", "0", "false", "ON", "true"]) {
      process.env.LINKI_WELCOME_PAGE = value;
      expect((await sentTo("/"))?.pathname, `LINKI_WELCOME_PAGE=${value}`).toBe("/login");
    }
  });

  it("only changes the home page: a link into the app still goes to sign in and comes back", async () => {
    process.env.LINKI_WELCOME_PAGE = "on";
    const deep = await sentTo("/contacts/abc?tab=timeline");
    expect(deep?.pathname).toBe("/login");
    expect(deep?.searchParams.get("callbackUrl")).toBe("/contacts/abc?tab=timeline");
    // The home page with something after it is somewhere the visitor meant to go.
    const home = await sentTo("/?range=30d");
    expect(home?.pathname).toBe("/login");
    expect(home?.searchParams.get("callbackUrl")).toBe("/?range=30d");
  });

  it("never sends someone who is signed in anywhere but their dashboard", async () => {
    for (const value of [undefined, "on"]) {
      if (value) process.env.LINKI_WELCOME_PAGE = value;
      expect(await sentTo("/", cookie)).toBeNull();
    }
  });
});

describe("the public page", () => {
  it("is open to anyone, whether or not it is the front door", async () => {
    for (const value of [undefined, "on"]) {
      if (value) process.env.LINKI_WELCOME_PAGE = value;
      const res = await proxy(new NextRequest("http://localhost:3000/welcome"));
      expect(res.headers.get("location")).toBeNull();
    }
    expect(isPublicPage("/welcome")).toBe(true);
    // Only that page: nothing beneath it is opened by accident.
    expect(isPublicPage("/welcome/anything")).toBe(false);
    expect(isPublicPage("/welcomes")).toBe(false);
  });

  // What the route hands the page, for a request with this cookie (or none) and this configured address.
  async function serve(cookie?: string, headers: Record<string, string> = {}) {
    const token = cookie?.split("=").slice(1).join("=");
    const req = { headers: { host: "linki.example.test", ...(cookie ? { cookie } : {}), ...headers }, cookies: token ? { "next-auth.session-token": token } : {} };
    const res = { getHeader: () => undefined, setHeader: () => res };
    const result = await getServerSideProps({ req, res, query: {}, resolvedUrl: "/welcome" } as unknown as GetServerSidePropsContext);
    return (result as { props: { session: unknown; signedIn: boolean; origin: string } }).props;
  }

  it("arrives whole for a visitor: the route hands it no session and does not wait for one", async () => {
    expect(await serve()).toMatchObject({ session: null, signedIn: false });
  });

  it("opens for someone signed in, whatever their session holds", async () => {
    // A session whose user has no name carries an undefined field, which once made this page fail for anyone signed in.
    const db = getDb();
    db.prepare("INSERT INTO users (id, email, password_hash) VALUES ('u-welcome-page', 'reader@welcome.test', 'x')").run();
    db.prepare("INSERT INTO workspaces (id, name, slug) VALUES ('ws-welcome-page', 'Welcome', 'ws-welcome-page')").run();
    db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws-welcome-page', 'u-welcome-page', 'member')").run();
    const cookie = `next-auth.session-token=${await encode({ token: { userId: "u-welcome-page", workspaceId: "ws-welcome-page", role: "member" }, secret: process.env.NEXTAUTH_SECRET! })}`;
    const props = await serve(cookie);
    expect(props.session).toMatchObject({ user: { id: "u-welcome-page", workspaceId: "ws-welcome-page", role: "member" } });
    // Said apart from the session, which pages/_app.tsx keeps for itself.
    expect(props.signedIn).toBe(true);
    // Strictly: a field that is present but undefined is exactly what cannot be sent to the page.
    expect(props).toStrictEqual(JSON.parse(JSON.stringify(props)));
  });

  it("gives its own address as configured, or else as it was asked for", async () => {
    expect((await serve(undefined, { "x-forwarded-proto": "https" })).origin).toBe("https://linki.example.test");
    process.env.NEXTAUTH_URL = "https://outreach.example.test/";
    try {
      expect((await serve()).origin).toBe("https://outreach.example.test");
    } finally {
      delete process.env.NEXTAUTH_URL;
    }
  });

  const html = (signedIn: boolean) => renderToStaticMarkup(createElement(WelcomePage, { origin: "https://linki.example.test", signedIn }));

  it("offers sign in to a visitor, and the way back in to someone already signed in", () => {
    const visitor = html(false);
    expect(visitor).toContain('href="/login"');
    expect(visitor).toContain("Sign in");
    expect(visitor).not.toContain("Open Linki");
    const member = html(true);
    expect(member).toContain("Open Linki");
    expect(member).not.toContain('href="/login"');
    expect(member).toContain(CLOSING.signedIn);
  });

  it("shows its commands with this instance's own address", () => {
    const page = html(false);
    expect(page).toContain("https://linki.example.test/api/mcp");
    expect(page).toContain("https://linki.example.test/api/v1/contacts");
    expect(page).not.toContain("{origin}");
  });

  it("links only into the app and to the repository", () => {
    const hrefs = [...html(false).matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)].map((match) => match[1]);
    expect(hrefs.length).toBeGreaterThan(8);
    const sections = new Set(SECTIONS.map((section) => `#${section.id}`));
    for (const href of hrefs) {
      const known = href === "/login" || href === "/welcome" || sections.has(href) || href.startsWith(REPOSITORY_URL);
      expect(known, href).toBe(true);
    }
    for (const url of [REPOSITORY_URL, LICENSE_URL, SETUP_URL]) expect(url).toMatch(/^https:\/\/github\.com\//);
    expect(new Set(SECTIONS.map((section) => section.id)).size).toBe(SECTIONS.length);
  });
});

// ── What it says ──────────────────────────────────────────────────────────────
describe("what the public page says", () => {
  const words = JSON.stringify([META, HERO, SECTIONS, SELF_HOSTED, CLOSING]);

  it("says nothing about cost or commercial terms", () => {
    // The licence question is open, so none of this is the page's to say.
    expect(words).not.toMatch(/\b(pricing|price[sd]?|per[- ]seat|seats?|trials?|billing|billed|invoices?|subscriptions?|plans?|upgrade|discount|free)\b/i);
  });

  it("makes no claim it cannot back: no customers, awards, rivals or figures about users", () => {
    expect(words).not.toMatch(/\b(testimonials?|trusted by|customers? love|awards?|(market|industry)[- ]leading|best[- ]in[- ]class|thousands of|millions of)\b/i);
    expect(words).not.toMatch(/\b(lemlist|instantly|smartlead|outreach\.io|salesloft|expandi|dripify|waalaxy|heyreach|la growth machine)\b/i);
  });

  it("names nothing that was left out of the product on purpose, or that is not built", () => {
    // Placeholder names from the design, data sources it only sketched, sending that does not happen, mailbox sign-in not wired up.
    expect(words).not.toMatch(/\b(Relay|rl_live|G2|Clearbit|Prospeo|Dropcontact|InMail|Google sign-in|Microsoft sign-in|OAuth 2\.1)\b/);
  });
});

// ── Pictures ──────────────────────────────────────────────────────────────────
describe("pictures", () => {
  const shots: Shot[] = [HERO.shot, ...SECTIONS.flatMap((section) => section.shots)];

  it("of the public page are all in public/welcome, at the size the page leaves room for", () => {
    for (const shot of shots) {
      const file = path.join("public", shotSrc(shot.name));
      expect(fs.existsSync(path.join(ROOT, file)), file).toBe(true);
      const real = pngSize(file);
      const room = shotSize(shot.name);
      // A close-up is taken at twice its drawn size, a whole screen at its own.
      expect([1, 2], file).toContain(Math.round(real.width / room.width));
      expect(real.height / real.width, file).toBeCloseTo(room.height / room.width, 2);
      expect(shot.alt.length, `${shot.name} needs words for someone who cannot see it`).toBeGreaterThan(30);
    }
  });

  it("for a link preview is the size previews expect", () => {
    const file = path.join("public", META.image.src);
    expect(pngSize(file)).toEqual({ width: META.image.width, height: META.image.height });
    expect(META.image).toMatchObject({ width: 1200, height: 630 });
  });

  it("in the README all exist, and none in docs/images is left unused", () => {
    const readme = read("README.md");
    const named = [...readme.matchAll(/docs\/images\/[\w-]+\.png/g)].map((match) => match[0]);
    expect(named.length).toBeGreaterThanOrEqual(15);
    for (const file of named) expect(fs.existsSync(path.join(ROOT, file)), file).toBe(true);
    for (const file of fs.readdirSync(path.join(ROOT, "docs", "images")).filter((name) => name.endsWith(".png"))) {
      expect(named, `docs/images/${file} is not shown in the README`).toContain(`docs/images/${file}`);
    }
  });

  it("are every one retaken by scripts/screenshots.mjs", () => {
    const script = read("scripts/screenshots.mjs");
    const retaken = new Set([...script.matchAll(/\{ name: "([\w-]+)"/g)].map((match) => match[1]));
    retaken.add("preview");
    for (const file of fs.readdirSync(path.join(ROOT, "docs", "images")).filter((name) => name.endsWith(".png"))) expect(retaken, `docs/images/${file}`).toContain(path.basename(file, ".png"));
    for (const file of fs.readdirSync(path.join(ROOT, "public", "welcome")).filter((name) => name.endsWith(".png"))) expect(retaken, `public/welcome/${file}`).toContain(path.basename(file, ".png"));
  });
});

// ── Where it is written down ──────────────────────────────────────────────────
describe("the front-door switch", () => {
  it("is documented wherever the other settings are", () => {
    for (const file of [".env.example", "DEPLOYMENT.md", "README.md"]) expect(read(file), file).toContain("LINKI_WELCOME_PAGE");
  });
});

describe("the README", () => {
  it("says nothing about cost either", () => {
    expect(read("README.md")).not.toMatch(/\b(pricing|per[- ]seat|billing|free trial)\b/i);
  });
});
