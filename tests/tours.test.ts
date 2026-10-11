// The guided tours as data: which page each belongs to, what is shown first, and that
// every step has something to say.
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { NAV } from "@/lib/client/nav";
import { TOURS, TOUR_IDS, isTourId, seenKey, tourFor, tourToShow } from "@/lib/client/tours";
import tourHandler from "@/pages/api/tour";
import { getDb } from "@/lib/db";
import { ctxHeaders } from "./helpers/ctx";
import type { NextApiRequest, NextApiResponse } from "next";

describe("the tours", () => {
  it("each have a name and steps with a title and something to say", () => {
    for (const id of TOUR_IDS) {
      const tour = TOURS[id];
      expect(tour.name.length, id).toBeGreaterThan(2);
      expect(tour.steps.length, id).toBeGreaterThan(0);
      for (const step of tour.steps) {
        expect(step.title.length, `${id}: ${step.title}`).toBeGreaterThan(3);
        expect(step.body.length, `${id}: ${step.title}`).toBeGreaterThan(30);
        expect(step.body.length, `${id}: ${step.title}`).toBeLessThan(260);
        expect(step.target === null || step.target.length > 3, `${id}: ${step.title}`).toBe(true);
      }
    }
  });

  it("say nothing about price, plans or seats", () => {
    const words = TOUR_IDS.flatMap((id) => TOURS[id].steps.map((step) => `${step.title} ${step.body}`)).join(" ");
    expect(words).not.toMatch(/pric|\bplan\b|seat|trial|billing|upgrade/i);
  });

  it("only the welcome opens in the middle of the screen", () => {
    for (const id of TOUR_IDS) {
      const centred = TOURS[id].steps.filter((step) => step.target === null);
      expect(centred.length, id).toBe(id === "welcome" ? 1 : 0);
    }
  });

  it("point at a sidebar group for every group the sidebar has", () => {
    const targets = TOURS.welcome.steps.map((step) => step.target);
    for (const section of NAV) expect(targets, section.label).toContain(`[data-tour="nav-${section.label.toLowerCase()}"]`);
  });

  it("point only at anchors that some component sets", () => {
    const source = ["components", "lib/client"].flatMap(function read(dir: string): string[] {
      return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? read(path.join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [fs.readFileSync(path.join(dir, entry.name), "utf8")] : []));
    }).join("\n");
    const anchors = new Set(TOUR_IDS.flatMap((id) => TOURS[id].steps.flatMap((step) => [...(step.target ?? "").matchAll(/data-tour="([^"]+)"/g)].map((match) => match[1]))));
    for (const anchor of anchors) {
      const set = source.includes(`data-tour="${anchor}"`) || (anchor.startsWith("nav-") && source.includes("data-tour={`nav-${"));
      expect(set, `nothing sets data-tour="${anchor}"`).toBe(true);
    }
  });
});

describe("which tour belongs to which page", () => {
  it("is found from the page's address, and every page tour has an address", () => {
    expect(tourFor("/")).toBe("dashboard");
    expect(tourFor("/campaigns")).toBe("campaigns");
    expect(tourFor("/campaigns/[id]")).toBe("campaign");
    expect(tourFor("/campaigns/[id]/sequence")).toBe("sequence");
    expect(tourFor("/linkedin-accounts")).toBe("linkedin");
    expect(tourFor("/campaigns/[id]/settings")).toBeNull();
    expect(tourFor("/nowhere")).toBeNull();
    expect(tourFor("/companies/[[...id]]")).toBe("companies");
    expect(tourFor("/pipeline")).toBe("pipeline");
    // Every page tour belongs to a page that exists: the addresses are read from the pages folder.
    const pages = (function read(dir: string): string[] {
      return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? (entry.name === "api" ? [] : read(path.join(dir, entry.name))) : /\.tsx$/.test(entry.name) ? [path.join(dir, entry.name)] : []));
    })("pages").map((file) => "/" + file.replace(/^pages\//, "").replace(/\.tsx$/, "").replace(/(^|\/)index$/, "")).map((route) => route.replace(/\/$/, "") || "/");
    expect(pages).toContain("/campaigns/[id]/sequence");
    const reachable = new Set(pages.map(tourFor));
    for (const id of TOUR_IDS) if (id !== "welcome") expect(reachable.has(id), id).toBe(true);
  });

  it("shows the welcome first, then each page's own once", () => {
    expect(tourToShow("/contacts", new Set())).toBe("welcome");
    const afterWelcome = new Set([seenKey("welcome")]);
    expect(tourToShow("/contacts", afterWelcome)).toBe("contacts");
    expect(tourToShow("/contacts", new Set([...afterWelcome, seenKey("contacts")]))).toBeNull();
    expect(tourToShow("/campaigns/[id]/settings", afterWelcome)).toBeNull();
  });

  it("is not put off by the tours someone saw under the old navigation", () => {
    // The old tours were filed under bare page names.
    const old = new Set(["dashboard", "lists", "contacts", "companies", "workflows", "inbox", "settings"]);
    expect(tourToShow("/", old)).toBe("welcome");
    expect(tourToShow("/", new Set([...old, seenKey("welcome")]))).toBe("dashboard");
    expect(isTourId("dashboard")).toBe(true);
    expect(isTourId("workflows")).toBe(false);
  });
});

describe("remembering what someone has seen", () => {
  async function call(req: Partial<NextApiRequest>) {
    const res: Record<string, unknown> = { statusCode: 200, body: undefined };
    res.status = (code: number) => { res.statusCode = code; return res; };
    res.json = (payload: unknown) => { res.body = payload; return res; };
    res.end = () => res;
    res.setHeader = () => res;
    await tourHandler({ query: {}, body: {}, ...req } as unknown as NextApiRequest, res as unknown as NextApiResponse);
    return res as unknown as { statusCode: number; body: { seen?: string[] } };
  }

  it("is kept per person, under the key the tours ask by", async () => {
    getDb().prepare("INSERT INTO workspaces (id, name, slug) VALUES ('ws-tours', 'Tours', 'ws-tours')").run();
    const ada = ctxHeaders("ws-tours", { userId: "tour-ada", role: "member" });
    const ben = ctxHeaders("ws-tours", { userId: "tour-ben", role: "viewer" });
    expect((await call({ method: "GET", headers: ada })).body.seen).toEqual([]);
    expect((await call({ method: "POST", headers: ada, body: { page: seenKey("welcome") } })).statusCode).toBe(200);
    expect((await call({ method: "POST", headers: ada, body: { page: seenKey("welcome") } })).statusCode).toBe(200);
    expect((await call({ method: "GET", headers: ada })).body.seen).toEqual([seenKey("welcome")]);
    // A viewer has tours too, and one person's say nothing about another's.
    expect((await call({ method: "GET", headers: ben })).body.seen).toEqual([]);
    expect((await call({ method: "POST", headers: ben, body: { page: seenKey("dashboard") } })).statusCode).toBe(200);
    expect((await call({ method: "POST", headers: ada, body: {} })).statusCode).toBe(400);
  });
});
