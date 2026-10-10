import { describe, expect, it } from "vitest";
import { apiUrl } from "@/lib/client/api";
import {
  changeInCount, changeInRate, changeInTally, formatAge, formatCompact, formatCount, formatDate, formatDateTime, formatMoney, formatPercent, formatRelative,
  parseTime, plural, rate,
} from "@/lib/client/format";
import { readTableState, writeTableState } from "@/lib/client/table-state";
import { parsePaging, parseSort, paged } from "@/lib/api/paging";
import { roleAtLeast } from "@/lib/roles";

describe("numbers", () => {
  it("writes counts with separators and a dash for missing values", () => {
    expect(formatCount(1240)).toBe("1,240");
    expect(formatCount(0)).toBe("0");
    expect(formatCount(null)).toBe("—");
    expect(formatCount(undefined)).toBe("—");
  });

  it("shortens large numbers", () => {
    expect(formatCompact(950)).toBe("950");
    expect(formatCompact(1200)).toBe("1.2k");
    expect(formatCompact(12000)).toBe("12k");
    expect(formatCompact(2_400_000)).toBe("2.4M");
  });

  it("shows a rate only when there is something to divide by", () => {
    expect(rate(141, 1240)).toBeCloseTo(0.1137, 4);
    expect(rate(0, 0)).toBeNull();
    expect(rate(5, null)).toBeNull();
    expect(formatPercent(rate(141, 1240))).toBe("11.4%");
    expect(formatPercent(null)).toBe("—");
    expect(formatPercent(0)).toBe("0.0%");
  });

  it("writes money in whole units", () => {
    expect(formatMoney(18000)).toBe("$18,000");
    expect(formatMoney(412800.4, "EUR")).toBe("€412,800");
    expect(formatMoney(null)).toBe("—");
  });

  it("picks singular or plural", () => {
    expect(plural(1, "campaign", "campaigns")).toBe("campaign");
    expect(plural(0, "campaign", "campaigns")).toBe("campaigns");
  });
});

describe("change against the previous period", () => {
  it("reports a count as a percentage", () => {
    expect(changeInCount(12480, 11534)).toEqual({ label: "+8.2%", direction: "up" });
    expect(changeInCount(90, 100)).toEqual({ label: "-10.0%", direction: "down" });
    expect(changeInCount(5, 5)).toEqual({ label: "0.0%", direction: "flat" });
  });

  it("says nothing when the previous period was empty, since any growth from zero is infinite", () => {
    expect(changeInCount(40, 0)).toBeNull();
    expect(changeInCount(0, 0)).toEqual({ label: "0%", direction: "flat" });
    expect(changeInCount(40, null)).toBeNull();
  });

  it("reports a small tally as a difference and a rate in points", () => {
    expect(changeInTally(318, 296)).toEqual({ label: "+22", direction: "up" });
    expect(changeInTally(47, 50)).toEqual({ label: "-3", direction: "down" });
    expect(changeInRate(0.114, 0.101)).toEqual({ label: "+1.3 pts", direction: "up" });
    expect(changeInRate(0.426, 0.434)).toEqual({ label: "−0.8 pts", direction: "down" });
    expect(changeInRate(null, 0.4)).toBeNull();
  });
});

describe("times", () => {
  const now = new Date("2026-10-10T14:20:00Z");

  it("reads SQLite's zoneless timestamps as UTC", () => {
    expect(parseTime("2026-10-10 14:02:11")?.toISOString()).toBe("2026-10-10T14:02:11.000Z");
    expect(parseTime("2026-10-10T14:02:11.000Z")?.toISOString()).toBe("2026-10-10T14:02:11.000Z");
    expect(parseTime("not a date")).toBeNull();
    expect(parseTime(null)).toBeNull();
  });

  it("writes how long ago something happened", () => {
    expect(formatRelative("2026-10-10 14:19:50", now)).toBe("just now");
    expect(formatRelative("2026-10-10 14:16:00", now)).toBe("4 min ago");
    expect(formatRelative("2026-10-10 12:20:00", now)).toBe("2 h ago");
    expect(formatRelative("2026-10-07 14:20:00", now)).toBe("3 d ago");
    expect(formatRelative(null, now)).toBe("—");
  });

  it("falls back to a date once it is over a month old, adding the year when it differs", () => {
    expect(formatRelative("2026-07-04T12:00:00Z", now)).toBe("Jul 4");
    expect(formatDate("2025-07-04T12:00:00Z", now)).toBe("Jul 4, 2025");
  });

  it("writes the short age used in the inbox", () => {
    expect(formatAge("2026-10-10T14:18:00Z", now)).toBe("2m");
    expect(formatAge("2026-10-10T14:19:45Z", now)).toBe("now");
  });

  it("names today and yesterday in a date with a time", () => {
    const local = new Date(2026, 9, 10, 15, 0, 0);
    expect(formatDateTime(new Date(2026, 9, 10, 14, 4, 0), local)).toBe("Today · 2:04 PM");
    expect(formatDateTime(new Date(2026, 9, 9, 17, 0, 0), local)).toBe("Yesterday · 5:00 PM");
    expect(formatDateTime(new Date(2026, 9, 7, 9, 12, 0), local)).toBe("Oct 7 · 9:12 AM");
  });
});

describe("API addresses", () => {
  it("leaves out empty values and repeats array keys", () => {
    expect(apiUrl("/api/campaigns", { page: 2, q: "", status: undefined, owner: null, tag: ["a", "b"], archived: false })).toBe("/api/campaigns?page=2&tag=a&tag=b&archived=false");
    expect(apiUrl("/api/campaigns")).toBe("/api/campaigns");
    expect(apiUrl("/api/x?a=1", { b: 2 })).toBe("/api/x?a=1&b=2");
  });
});

describe("table state in the address bar", () => {
  const options = { pageSize: 25, sort: { key: "activity", direction: "desc" as const }, filters: { status: "all", owner: "anyone" } };

  it("starts from the defaults", () => {
    expect(readTableState({}, options)).toEqual({ page: 1, pageSize: 25, sort: { key: "activity", direction: "desc" }, search: "", filters: { status: "all", owner: "anyone" } });
  });

  it("reads what the address says and ignores what it cannot use", () => {
    const state = readTableState({ page: "3", per: "50", sort: "reply:asc", q: "revops", status: "active", unknown: "x", owner: "" }, options);
    expect(state).toEqual({ page: 3, pageSize: 50, sort: { key: "reply", direction: "asc" }, search: "revops", filters: { status: "active", owner: "anyone" } });
    expect(readTableState({ page: "-2", per: "9999" }, options).page).toBe(1);
    expect(readTableState({ page: "-2", per: "9999" }, options).pageSize).toBe(25);
  });

  it("writes only what differs from the defaults, so a plain view has a plain address", () => {
    expect(writeTableState(readTableState({}, options), options)).toEqual({});
    const state = readTableState({ page: "3", per: "50", sort: "reply:asc", q: "revops", status: "active" }, options);
    expect(writeTableState(state, options)).toEqual({ page: "3", per: "50", sort: "reply:asc", q: "revops", status: "active" });
  });

  it("refuses a filter named like one of its own keys", () => {
    const clash = { sort: { key: "a", direction: "desc" as const }, filters: { page: "all" } };
    expect(() => writeTableState(readTableState({ page: "2" }, clash), clash)).toThrow(/reserved/);
  });
});

describe("paging on the server", () => {
  it("defaults, caps and computes the offset", () => {
    expect(parsePaging({})).toEqual({ page: 1, limit: 25, offset: 0 });
    expect(parsePaging({ page: "3", limit: "50" })).toEqual({ page: 3, limit: 50, offset: 100 });
    expect(parsePaging({ limit: "100000" })).toEqual({ page: 1, limit: 200, offset: 0 });
    expect(parsePaging({ limit: "100" }, { maxLimit: 50 }).limit).toBe(50);
  });

  it("falls back on anything that is not a positive whole number", () => {
    for (const bad of ["0", "-1", "1.5", "abc", "1; DROP TABLE x", ""]) {
      expect(parsePaging({ page: bad, limit: bad })).toEqual({ page: 1, limit: 25, offset: 0 });
    }
    expect(parsePaging({ page: ["4", "9"] }).page).toBe(4);
  });

  it("wraps a page of rows", () => {
    expect(paged(["a"], 41, parsePaging({ page: "2", limit: "20" }))).toEqual({ items: ["a"], total: 41, page: 2, limit: 20 });
  });

  it("sorts only by columns it was told about", () => {
    const columns = { name: "w.name COLLATE NOCASE", activity: "last_activity_at" };
    const fallback = { key: "activity", direction: "desc" as const };
    expect(parseSort({ sort: "name:asc" }, columns, fallback).orderBy).toBe("w.name COLLATE NOCASE ASC");
    expect(parseSort({ sort: "name" }, columns, fallback).orderBy).toBe("w.name COLLATE NOCASE DESC");
    expect(parseSort({}, columns, fallback)).toEqual({ sort: fallback, orderBy: "last_activity_at DESC" });
    // Anything else, including an attempt to reach the SQL, falls back.
    expect(parseSort({ sort: "name; DROP TABLE workflows:asc" }, columns, fallback).orderBy).toBe("last_activity_at DESC");
    expect(parseSort({ sort: "constructor:asc" }, columns, fallback).orderBy).toBe("last_activity_at DESC");
  });
});

describe("roles", () => {
  it("orders the five roles and treats anything else as no role", () => {
    expect(roleAtLeast("owner", "admin")).toBe(true);
    expect(roleAtLeast("manager", "manager")).toBe(true);
    expect(roleAtLeast("member", "manager")).toBe(false);
    expect(roleAtLeast("viewer", "member")).toBe(false);
    expect(roleAtLeast(undefined, "viewer")).toBe(false);
    expect(roleAtLeast("constructor" as never, "viewer")).toBe(false);
  });
});

import { NAV, isNavItemActive, navHref, recordHref } from "@/lib/client/nav";

describe("navigation", () => {
  const item = (key: string) => NAV.flatMap(section => section.items).find(candidate => candidate.key === key)!;
  const activeKeys = (pathname: string, tab?: string) => NAV.flatMap(section => section.items).filter(candidate => isNavItemActive(candidate, pathname, tab)).map(candidate => candidate.key);

  it("has the design's five sections in order", () => {
    expect(NAV.map(section => section.label)).toEqual(["Workspace", "Outreach", "Audience", "Channels", "Configure"]);
    expect(NAV.flatMap(section => section.items).map(candidate => candidate.label)).toEqual([
      "Dashboard", "Inbox", "Tasks", "Campaigns", "Templates", "Signals", "Contacts", "Lists", "Companies",
      "LinkedIn accounts", "Mailboxes", "Deliverability", "AI & models", "Integrations", "Team & roles", "Developer API",
    ]);
  });

  it("sends an item whose screen is not rebuilt yet to its place in the old UI", () => {
    expect(navHref(item("contacts"))).toBe("/contacts");
    expect(navHref(item("campaigns"))).toBe("/workflows");
    expect(navHref(item("mailboxes"))).toBe("/settings?tab=email");
    expect(navHref(item("signals"))).toBe("/platform?tab=automation");
  });

  it("marks exactly one item as the current place", () => {
    expect(activeKeys("/")).toEqual(["dashboard"]);
    expect(activeKeys("/contacts/[id]")).toEqual(["contacts"]);
    expect(activeKeys("/workflows/[id]")).toEqual(["campaigns"]);
    expect(activeKeys("/email-health")).toEqual(["deliverability"]);
    expect(activeKeys("/pipeline")).toEqual(["tasks"]);
    // A tabbed old page: only the item for the open tab.
    expect(activeKeys("/settings", "email")).toEqual(["mailboxes"]);
    expect(activeKeys("/settings", "ai")).toEqual(["ai"]);
    expect(activeKeys("/settings")).toEqual(["linkedin-accounts"]);
    expect(activeKeys("/settings", "general")).toEqual([]);
    expect(activeKeys("/platform", "automation")).toEqual(["signals"]);
    // Two items share the old "admin" tab; only one lights up.
    expect(activeKeys("/platform", "admin")).toEqual(["team"]);
    expect(activeKeys("/platform")).toEqual([]);
    // Dashboard is the home page only, not every page.
    expect(activeKeys("/inbox")).toEqual(["inbox"]);
    expect(activeKeys("/dev/ui")).toEqual([]);
  });

  it("links a record to its page by kind", () => {
    expect(recordHref("contact", "c1")).toBe("/contacts/c1");
    expect(recordHref("company", "c2")).toBe("/companies/c2");
    expect(recordHref("list", "l1")).toBe("/lists/l1");
  });
});
