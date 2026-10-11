// What the Developer API and Integrations screens say, and whether the reference page
// tells the truth: every endpoint it lists is asked of the real route, with a key that
// lacks the scope the page names and with one that has every scope.
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import type { NextApiRequest, NextApiResponse } from "next";
import {
  HEALTH, SCOPES, MAX_RATE_LIMIT, deadLetterTotal, deliveryDetail, eventChips, expiryCell, expiryFor, foldedLoops, formatBytes, healthPill, hookName, instanceContext,
  isLive, lastDeliveryCell, lastUsed, maskedKey, mcpSnippets, rateLimitLabel, rateLimitSummary, readRateLimit, scopeChips, serviceRows, shownGroups, successCell, uptimeLabel,
  type ApiKeyRow, type InstanceHealth, type WebhookRow,
} from "@/components/developers/model";
import { ENDPOINT_GROUPS, ERRORS, WEBHOOK_EVENTS, documentedResources, endpointCount } from "@/components/developers/reference";
import {
  INTEGRATIONS, connectionLine, connectionSettings, connectionState, integrationStatuses, integrationSummary, settingsProblem, syncResult,
  type ConnectionRow, type ProviderKey,
} from "@/components/integrations/model";
import { MAX_RATE_LIMIT as SERVER_MAX_RATE_LIMIT } from "@/lib/api/key-rate-limit";
import { createApiKey } from "@/lib/api-keys";
import { getDb } from "@/lib/db";
import { EVENT_TYPES } from "@/lib/platform/event-types";
import { API_KEY_SCOPES } from "@/pages/api/platform/api-keys";
import { CONNECTION_PROVIDERS, CONNECTION_SETTINGS } from "@/pages/api/platform/connections";
import v1 from "@/pages/api/v1/[...path]";

const NOW = new Date("2026-10-10T12:00:00Z");
const key = (over: Partial<ApiKeyRow> = {}): ApiKeyRow => ({
  id: "k1", name: "Backend", key_prefix: "lnk_8f2cAbCd", scopes: "contacts:read contacts:write campaigns:read", last_used_at: null, expires_at: null, revoked_at: null,
  created_at: "2026-07-01 10:00:00", rate_limit_per_minute: null, created_by_name: "Jordan", ...over,
});
const hook = (over: Partial<WebhookRow> = {}): WebhookRow => ({
  id: "h1", name: null, url: "https://hooks.acme.example/linki", event_types: "*", enabled: 1, created_at: "2026-07-01 10:00:00", delivery_count: 0, delivered: 0, retrying: 0, dead_letters: 0,
  success_rate: null, last_delivery_at: null, last_status: null, health: "idle", ...over,
});

// ─────────────────────────────────────────────────────────────────────
describe("an API key's row", () => {
  it("shows the part of the key that is kept, and that the rest is not", () => {
    expect(maskedKey("lnk_8f2cAbCd")).toBe("lnk_8f2cAbCd••••");
  });

  it("shows the scopes there is room for and counts the rest", () => {
    expect(scopeChips("contacts:read contacts:write campaigns:read")).toEqual({ shown: ["contacts:read", "contacts:write"], more: 1 });
    expect(scopeChips("contacts:read")).toEqual({ shown: ["contacts:read"], more: 0 });
    expect(scopeChips("a:read, b:read", 5)).toEqual({ shown: ["a:read", "b:read"], more: 0 });
  });

  it("says when a key stops working, and marks one that is close", () => {
    expect(expiryCell(key(), NOW)).toEqual({ date: "Never", note: "No expiry set", tone: "neutral" });
    expect(expiryCell(key({ expires_at: "2027-07-13 12:00:00" }), NOW)).toEqual({ date: "Jul 13, 2027", note: "in 276 days", tone: "neutral" });
    expect(expiryCell(key({ expires_at: "2026-10-20 12:00:00" }), NOW)).toMatchObject({ note: "in 10 days", tone: "warn" });
    expect(expiryCell(key({ expires_at: "2026-10-11 09:00:00" }), NOW)).toMatchObject({ note: "in 1 day", tone: "warn" });
    expect(expiryCell(key({ expires_at: "2026-10-09 12:00:00" }), NOW)).toMatchObject({ note: "Expired", tone: "bad" });
    // An ISO time, as older keys have it, reads the same.
    expect(expiryCell(key({ expires_at: "2026-10-20T12:00:00.000Z" }), NOW)).toMatchObject({ note: "in 10 days" });
    expect(expiryCell(key({ expires_at: "2027-07-13 12:00:00", revoked_at: "2026-10-02 08:00:00" }), NOW)).toEqual({ date: "Revoked Oct 2", note: "No longer works", tone: "bad" });
    expect(isLive(key({ revoked_at: "2026-10-02 08:00:00" }), NOW)).toBe(false);
    expect(isLive(key({ expires_at: "2026-10-09 12:00:00" }), NOW)).toBe(false);
    expect(isLive(key({ expires_at: "2026-10-20 12:00:00" }), NOW)).toBe(true);
  });

  it("says when it was last used", () => {
    expect(lastUsed(null, NOW)).toBe("Never used");
    expect(lastUsed("2026-10-10 11:56:00", NOW)).toBe("4 min ago");
  });

  it("puts a rate limit in words, and sums up the keys that work", () => {
    expect(rateLimitLabel(600)).toBe("600 req / min");
    expect(rateLimitLabel(10_000)).toBe("10,000 req / min");
    expect(rateLimitLabel(null)).toBe("No rate limit");
    expect(rateLimitSummary([], NOW)).toBeNull();
    expect(rateLimitSummary([key(), key({ id: "k2" })], NOW)).toBe("No rate limit");
    expect(rateLimitSummary([key({ rate_limit_per_minute: 600 }), key({ id: "k2", rate_limit_per_minute: 600 })], NOW)).toBe("600 req / min");
    expect(rateLimitSummary([key({ rate_limit_per_minute: 600 }), key({ id: "k2", rate_limit_per_minute: 120 }), key({ id: "k3" })], NOW)).toBe("2 of 3 keys rate limited");
    // A key that no longer works does not count.
    expect(rateLimitSummary([key({ rate_limit_per_minute: 600 }), key({ id: "k2", revoked_at: "2026-10-02 08:00:00" })], NOW)).toBe("600 req / min");
    expect(rateLimitSummary([key({ revoked_at: "2026-10-02 08:00:00" })], NOW)).toBeNull();
  });

  it("reads a limit typed in the dialog", () => {
    expect(readRateLimit("")).toEqual({ value: null, error: null });
    expect(readRateLimit("  600 ")).toEqual({ value: 600, error: null });
    for (const wrong of ["0", "10001", "1.5", "fast", "-3"]) expect(readRateLimit(wrong).error, wrong).toMatch(/whole number from 1 to 10,000/);
    expect(MAX_RATE_LIMIT).toBe(SERVER_MAX_RATE_LIMIT);
  });

  it("works out an expiry in the form the API stores", () => {
    expect(expiryFor("never", NOW)).toBeUndefined();
    expect(expiryFor("30", NOW)).toBe("2026-11-09 12:00:00");
    expect(expiryFor("365", NOW)).toBe("2027-10-10 12:00:00");
  });

  it("offers exactly the scopes the API accepts", () => {
    expect(SCOPES.map((item) => item.scope).sort()).toEqual([...API_KEY_SCOPES].sort());
    for (const item of SCOPES) expect(item.detail.length, item.scope).toBeGreaterThan(10);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("a webhook's row", () => {
  it("is called by its name, or by its host when it has none", () => {
    expect(hookName(hook({ name: "Reply router" }))).toBe("Reply router");
    expect(hookName(hook())).toBe("hooks.acme.example");
    expect(hookName(hook({ url: "not a url" }))).toBe("not a url");
  });

  it("shows the first event and counts the rest", () => {
    expect(eventChips("*")).toEqual({ first: "All events", more: null });
    expect(eventChips("reply.received")).toEqual({ first: "reply.received", more: null });
    expect(eventChips("reply.received,email.bounced")).toEqual({ first: "reply.received", more: "+1 more event" });
    expect(eventChips("reply.received, email.bounced, meeting.booked")).toEqual({ first: "reply.received", more: "+2 more events" });
  });

  it("shows the share of deliveries accepted, marked when it is low", () => {
    expect(successCell(hook())).toEqual({ label: "—", tone: "neutral" });
    expect(successCell(hook({ success_rate: 1 }))).toEqual({ label: "100%", tone: "good" });
    expect(successCell(hook({ success_rate: 0.998 }))).toEqual({ label: "99.8%", tone: "good" });
    expect(successCell(hook({ success_rate: 0.9 }))).toEqual({ label: "90.0%", tone: "warn" });
    expect(successCell(hook({ success_rate: 0.624 }))).toEqual({ label: "62.4%", tone: "bad" });
    expect(successCell(hook({ success_rate: 0 }))).toEqual({ label: "0%", tone: "bad" });
  });

  it("says when the last delivery was, and that it failed if it did", () => {
    expect(lastDeliveryCell(hook(), NOW)).toEqual({ label: "—", failed: false });
    expect(lastDeliveryCell(hook({ last_delivery_at: "2026-10-10 11:58:00", last_status: "delivered" }), NOW)).toEqual({ label: "2 min ago", failed: false });
    expect(lastDeliveryCell(hook({ last_delivery_at: "2026-10-10 11:26:00", last_status: "retrying" }), NOW)).toEqual({ label: "Failed 34 min ago", failed: true });
    expect(lastDeliveryCell(hook({ last_delivery_at: "2026-10-10 09:00:00", last_status: "dead_letter" }), NOW)).toEqual({ label: "Failed 3 h ago", failed: true });
  });

  it("has a word and an explanation for every health the route can give", () => {
    expect(Object.keys(HEALTH).sort()).toEqual(["failing", "healthy", "idle", "paused", "retrying"]);
    expect(HEALTH.paused.explain).toMatch(/not kept/);
    expect(deadLetterTotal([hook({ dead_letters: 1 }), hook({ dead_letters: 4 }), hook()])).toBe(5);
  });

  it("describes one delivery in a line", () => {
    expect(deliveryDetail({ status: "delivered", attempt: 1, response_status: 200, last_error: null, next_attempt_at: null }, NOW)).toBe("Answered 200 · 1 attempt");
    expect(deliveryDetail({ status: "pending", attempt: 0, response_status: null, last_error: null, next_attempt_at: null }, NOW)).toBe("Not sent yet");
    expect(deliveryDetail({ status: "retrying", attempt: 3, response_status: 503, last_error: "HTTP 503: down", next_attempt_at: "2026-10-10 12:08:00" }, NOW)).toBe("HTTP 503: down · 3 attempts · next in 8 min");
    expect(deliveryDetail({ status: "retrying", attempt: 7, response_status: null, last_error: "Timed out", next_attempt_at: "2026-10-10 14:08:00" }, NOW)).toBe("Timed out · 7 attempts · next in 2 h");
    expect(deliveryDetail({ status: "dead_letter", attempt: 8, response_status: 500, last_error: null, next_attempt_at: null }, NOW)).toBe("Answered 500 · 8 attempts");
    expect(deliveryDetail({ status: "dead_letter", attempt: 8, response_status: null, last_error: " ", next_attempt_at: null }, NOW)).toBe("No answer · 8 attempts");
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("the MCP card", () => {
  it("gives a command and a config entry with the address and no key in either", () => {
    const snippets = mcpSnippets("https://linki.acme.example/api/mcp");
    expect(snippets.cli).toBe("claude mcp add --transport http linki https://linki.acme.example/api/mcp");
    expect(JSON.parse(snippets.json)).toEqual({ mcpServers: { linki: { type: "http", url: "https://linki.acme.example/api/mcp" } } });
    expect(`${snippets.cli}${snippets.json}${snippets.opencode}`).not.toMatch(/lnk_|Bearer|Authorization|relay/i);
  });

  it("gives opencode a remote entry that signs in on its own", () => {
    const entry = JSON.parse(mcpSnippets("https://linki.acme.example/api/mcp").opencode).mcp.linki;
    expect(entry).toMatchObject({ type: "remote", url: "https://linki.acme.example/api/mcp", enabled: true });
    expect(entry.oauth).toBeUndefined();
    expect(entry.headers).toBeUndefined();
  });

  it("gives the terminal forms a header that reads the key from the environment, never the key itself", () => {
    const snippets = mcpSnippets("https://linki.acme.example/api/mcp");
    expect(snippets.key).toBe('claude mcp add --transport http linki https://linki.acme.example/api/mcp --header "Authorization: Bearer $LINKI_API_KEY"');
    const entry = JSON.parse(snippets.opencodeKey).mcp.linki;
    expect(entry).toMatchObject({ type: "remote", oauth: false, headers: { Authorization: "Bearer {env:LINKI_API_KEY}" } });
    expect(`${snippets.key}${snippets.opencodeKey}`).not.toMatch(/lnk_[A-Za-z0-9_-]{8}/);
  });

  it("shows the largest groups and counts the rest", () => {
    expect(shownGroups([1, 2, 3, 4, 5, 6, 7])).toEqual({ shown: [1, 2, 3], more: 4 });
    expect(shownGroups([1, 2])).toEqual({ shown: [1, 2], more: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("the instance health card", () => {
  const loop = (name: string, label: string, minutes: number, waiting: number | null = null, noun: string | null = null) =>
    ({ name, label, heartbeat_at: "2026-10-10T12:00:00Z", minutes_since: minutes, stalled: minutes >= 12, waiting, waiting_noun: noun });
  const health = (over: Partial<InstanceHealth> = {}): InstanceHealth => ({
    status: "healthy", summary: "All runners healthy", version: "2.4.1", node: "v22.11.0", uptime_seconds: 18 * 86_400 + 300,
    database: { bytes: 13_314_398_618, free_bytes: 40_000_000_000 },
    loops: [loop("email-jobs-runner", "Email sender", 0, 128, "queued"), loop("linkedin-runner", "LinkedIn runner", 3, 2, "running"), loop("warmup-runner", "Warm-up", 1), loop("webhook-runner", "Webhooks", 1, 0, "waiting"), loop("imports-runner", "Imports", 2)],
    ...over,
  });

  it("writes sizes and uptime the way a person would", () => {
    expect(formatBytes(13_314_398_618)).toBe("12.4 GB");
    expect(formatBytes(15_400_000)).toBe("14.7 MB");
    expect(formatBytes(900)).toBe("900 B");
    expect(formatBytes(0)).toBe("—");
    expect(uptimeLabel(20)).toBe("Just started");
    expect(uptimeLabel(12 * 60)).toBe("Up 12 min");
    expect(uptimeLabel(3_600)).toBe("Up 1 hour");
    expect(uptimeLabel(5 * 3_600)).toBe("Up 5 hours");
    expect(uptimeLabel(18 * 86_400)).toBe("Up 18 days");
    expect(instanceContext("linki.acme.example", "2.4.1")).toBe("Self-hosted · linki.acme.example · v2.4.1");
    expect(instanceContext("", "dev")).toBe("Self-hosted · dev");
  });

  it("shows the app, the loops with a queue, the rest folded into one row, and the database", () => {
    const rows = serviceRows(health());
    expect(rows.map((row) => row.name)).toEqual(["Web app and API", "Email sender", "LinkedIn runner", "Webhooks", "2 other loops", "Database"]);
    expect(rows[0].meta).toBe("v2.4.1 · Node 22.11.0");
    expect(rows[1]).toMatchObject({ meta: "Last pass just now · 128 queued", status: "healthy", status_label: "Healthy" });
    expect(rows[2].meta).toBe("Last pass 3 min ago · 2 running");
    expect(rows[5].meta).toBe("SQLite · 12.4 GB · 37.3 GB free on its volume");
    expect(foldedLoops(health())).toBe(2);
    expect(serviceRows(health(), true).map((row) => row.name)).toEqual(["Web app and API", "Email sender", "LinkedIn runner", "Warm-up", "Webhooks", "Imports", "Database"]);
    expect(healthPill(health())).toEqual({ label: "Up 18 days", tone: "good" });
  });

  it("brings a stalled loop out of the fold and says which it is", () => {
    const stalled = health({ status: "degraded", summary: "Warm-up stalled", loops: [...health().loops.slice(0, 2), loop("warmup-runner", "Warm-up", 31), ...health().loops.slice(3)] });
    const rows = serviceRows(stalled);
    expect(rows.map((row) => row.name)).toEqual(["Web app and API", "Email sender", "LinkedIn runner", "Warm-up", "Webhooks", "1 other loop", "Database"]);
    expect(rows[3]).toMatchObject({ meta: "Last pass 31 min ago", status: "degraded", status_label: "Stalled" });
    expect(healthPill(stalled)).toEqual({ label: "Warm-up stalled", tone: "warn" });
  });

  it("says so when background work is off or has not started", () => {
    const off = serviceRows(health({ status: "off", summary: "Background work is off", loops: [] }));
    expect(off.map((row) => [row.name, row.status_label])).toEqual([["Web app and API", "Healthy"], ["Background work", "Off"], ["Database", "Healthy"]]);
    expect(healthPill(health({ status: "off", loops: [] }))).toEqual({ label: "Background work off", tone: "neutral" });
    const idle = serviceRows(health({ status: "idle", summary: "Runners not started yet", loops: [] }));
    expect(idle[1]).toMatchObject({ name: "Background work", status_label: "Not started" });
    expect(foldedLoops(health({ status: "off", loops: [] }))).toBe(0);
    // A system that does not say how much space is free is not guessed at.
    expect(serviceRows(health({ database: { bytes: 1024, free_bytes: null } })).at(-1)?.meta).toBe("SQLite · 1.0 KB");
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("the integrations screen", () => {
  const providerKey = (id: string, last = "4f1a"): ProviderKey => ({ key: id, configured: true, api_key_masked: `••••••••${last}`, updated_at: "2026-08-08 10:00:00" });
  const connection = (over: Partial<ConnectionRow> = {}): ConnectionRow => ({
    id: "c1", provider: "hubspot", name: "HubSpot", config_json: "{}", enabled: 1, last_synced_at: "2026-10-10 11:54:00", sync_error: null, created_at: "2026-08-01 10:00:00", sync_record_count: 180, ...over,
  });

  it("offers a card for every provider the server can connect, with the settings the server accepts", () => {
    const connections = INTEGRATIONS.filter((integration) => integration.kind === "connection");
    expect(connections.map((integration) => integration.id).sort()).toEqual([...CONNECTION_PROVIDERS].sort());
    for (const integration of connections) {
      expect(integration.settings.map((setting) => setting.key).sort(), integration.id).toEqual([...CONNECTION_SETTINGS[integration.id as keyof typeof CONNECTION_SETTINGS]].sort());
      // Only a feed needs no token.
      expect(Boolean(integration.secret), integration.id).toBe(integration.id !== "ical");
    }
    expect(INTEGRATIONS.filter((integration) => integration.kind === "key").map((integration) => integration.id)).toEqual(["apollo", "openrouter", "gemini", "firecrawl", "tinyfish"]);
    for (const integration of INTEGRATIONS) expect(`${integration.name} ${integration.about} ${integration.purpose}`).not.toMatch(/deal|seat|plan\b|relay/i);
  });

  it("knows where each connection stands", () => {
    expect(connectionState(connection())).toBe("connected");
    expect(connectionState(connection({ sync_error: "HubSpot 401: expired" }))).toBe("failing");
    expect(connectionState(connection({ enabled: 0, sync_error: "x" }))).toBe("paused");
    expect(connectionState(connection({ last_synced_at: null }))).toBe("waiting");
    expect(connectionLine(connection(), NOW)).toBe("Synced 6 min ago");
    expect(connectionLine(connection({ sync_error: "x" }), NOW)).toBe("Last synced 6 min ago · the latest sync failed");
    expect(connectionLine(connection({ sync_error: "x", last_synced_at: null }), NOW)).toBe("The first sync failed");
    expect(connectionLine(connection({ enabled: 0 }), NOW)).toBe("Paused · last synced 6 min ago");
    expect(connectionLine(connection({ enabled: 0, last_synced_at: null }), NOW)).toBe("Paused · never synced");
    expect(connectionLine(connection({ last_synced_at: null }), NOW)).toBe("Syncs within 15 minutes, or now if you ask");
  });

  it("sums up what is connected, with a line for each", () => {
    const statuses = integrationStatuses(
      [providerKey("apollo"), providerKey("openrouter", "7d2c")],
      [connection(), connection({ id: "c2", provider: "google_calendar", name: "Jordan's calendar", config_json: '{"calendar_id":"primary"}' })],
      NOW, { openrouter: "$38.42 spent this month" },
    );
    expect(integrationSummary(statuses)).toBe("4 connected · 7 available");
    const line = Object.fromEntries(statuses.map((status) => [status.integration.id, status.line]));
    expect(line.apollo).toBe("Enrichment · key ending 4f1a");
    expect(line.openrouter).toBe("AI models · $38.42 spent this month");
    expect(line.hubspot).toBe("Two-way contact sync · synced 6 min ago");
    expect(line.google_calendar).toBe("Meetings · synced 6 min ago");
    expect(line.salesforce).toBe("Two-way contact sync");
    expect(statuses.find((status) => status.integration.id === "salesforce")).toMatchObject({ connected: false, connections: [], failing: false });
  });

  it("counts several connections of one kind, and says when one is failing", () => {
    const statuses = integrationStatuses([], [connection({ provider: "ical", name: "A" }), connection({ id: "c2", provider: "ical", name: "B", sync_error: "iCal 404" })], NOW);
    const feed = statuses.find((status) => status.integration.id === "ical")!;
    expect(feed).toMatchObject({ connected: true, failing: true, line: "Meetings · 2 connections, one failing" });
    expect(integrationSummary(statuses)).toBe("1 connected · 10 available");
    // A key the route lists but that holds nothing is not a connection.
    expect(integrationStatuses([{ key: "apollo", configured: false, api_key_masked: null, updated_at: "" }], [], NOW)[0].connected).toBe(false);
  });

  it("reads a connection's settings, and puts a sync's result in words", () => {
    expect(connectionSettings(connection({ config_json: '{"instance_url":"https://acme.my.salesforce.com","api_version":"v67.0","n":3,"nested":{"a":1}}' }))).toEqual({ instance_url: "https://acme.my.salesforce.com", api_version: "v67.0", n: "3" });
    expect(connectionSettings(connection({ config_json: "not json" }))).toEqual({});
    expect(syncResult({ provider: "hubspot", contacts_exported: 12, contacts_imported: 3 })).toBe("12 contacts sent, 3 brought in");
    expect(syncResult({ provider: "salesforce", contacts_exported: 1 })).toBe("1 contact sent");
    expect(syncResult({ provider: "ical", meetings_imported: 2 })).toBe("2 meetings read");
    expect(syncResult({ provider: "x" })).toBe("Sync finished");
  });

  it("checks a connect form before it is sent", () => {
    const by = Object.fromEntries(INTEGRATIONS.map((integration) => [integration.id, integration]));
    expect(settingsProblem(by.hubspot, {}, "", false)).toMatchObject({ field: "secret" });
    expect(settingsProblem(by.hubspot, {}, "pat-1", false)).toBeNull();
    // Changing a connection: an empty token keeps the one saved.
    expect(settingsProblem(by.hubspot, {}, "", true)).toBeNull();
    expect(settingsProblem(by.salesforce, {}, "t", false)).toMatchObject({ field: "instance_url" });
    expect(settingsProblem(by.salesforce, { instance_url: "acme.my.salesforce.com", external_id_field: "Linki_Email__c" }, "t", false)).toMatchObject({ field: "instance_url", message: expect.stringMatching(/https/) });
    expect(settingsProblem(by.salesforce, { instance_url: "https://acme.my.salesforce.com" }, "t", false)).toMatchObject({ field: "external_id_field" });
    expect(settingsProblem(by.salesforce, { instance_url: "https://acme.my.salesforce.com", external_id_field: "Linki_Email__c" }, "t", false)).toBeNull();
    expect(settingsProblem(by.google_calendar, {}, "t", false)).toBeNull();
    expect(settingsProblem(by.ical, {}, "", false)).toMatchObject({ field: "url" });
    expect(settingsProblem(by.ical, { url: "https://calendar.acme.example/a.ics" }, "", false)).toBeNull();
    // A saved feed address comes back as its host only: left empty when changing, it is kept.
    expect(settingsProblem(by.ical, { url: "" }, "", true)).toBeNull();
    expect(settingsProblem(by.ical, { url: "calendar.acme.example/a.ics" }, "", true)).toMatchObject({ field: "url" });
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("the API reference", () => {
  const source = readFileSync(path.join(process.cwd(), "pages/api/v1/[...path].ts"), "utf8");
  const endpoints = ENDPOINT_GROUPS.flatMap((group) => group.endpoints);

  async function ask(apiKey: string, method: string, apiPath: string, query: Record<string, string> = {}) {
    const res: Record<string, unknown> = { statusCode: 200, body: undefined };
    res.status = (code: number) => { res.statusCode = code; return res; };
    res.json = (payload: unknown) => { res.body = payload; return res; };
    res.end = () => res;
    res.setHeader = () => res;
    const parts = apiPath.replace("{id}", "no-such-id").split("/").filter(Boolean);
    await v1({ method, headers: { authorization: `Bearer ${apiKey}` }, query: { path: parts, ...query }, body: {}, socket: {} } as unknown as NextApiRequest, res as unknown as NextApiResponse);
    return res as unknown as { statusCode: number; body: { error?: string; required?: string } };
  }

  it("documents every resource the route answers for", () => {
    const handled = [...new Set([...source.matchAll(/resource === "([a-z_]+)"/g)].map((match) => match[1]))].sort();
    expect(documentedResources().sort()).toEqual(handled);
    expect(endpointCount()).toBe(endpoints.length);
    expect(new Set(endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`)).size).toBe(endpoints.length);
  });

  it("names, for each endpoint, the scope the route really asks for", async () => {
    getDb().prepare("INSERT OR IGNORE INTO workspaces (id, name, slug) VALUES ('ws-reference', 'Reference', 'ws-reference')").run();
    for (const endpoint of endpoints) {
      expect(API_KEY_SCOPES, endpoint.path).toContain(endpoint.scope);
      const without = createApiKey({ workspaceId: "ws-reference", name: "Without", scopes: API_KEY_SCOPES.filter((scope) => scope !== endpoint.scope) });
      const refused = await ask(without.key, endpoint.method, endpoint.path);
      expect([refused.statusCode, refused.body], `${endpoint.method} ${endpoint.path}`).toEqual([403, { error: "insufficient_scope", required: endpoint.scope }]);
    }
  });

  it("lists only endpoints that exist", async () => {
    getDb().prepare("INSERT OR IGNORE INTO workspaces (id, name, slug) VALUES ('ws-reference', 'Reference', 'ws-reference')").run();
    const all = createApiKey({ workspaceId: "ws-reference", name: "Everything", scopes: [...API_KEY_SCOPES] });
    for (const endpoint of endpoints) {
      const answer = await ask(all.key, endpoint.method, endpoint.path);
      // With made-up ids and an empty body a real endpoint says what is missing; only a path that is not there says these.
      expect(["unknown_resource", "unsupported_operation"], `${endpoint.method} ${endpoint.path}`).not.toContain(answer.body?.error);
      expect(answer.statusCode, `${endpoint.method} ${endpoint.path}`).not.toBe(500);
    }
    // The route does say so for a path that is not there.
    expect((await ask(all.key, "GET", "/nothing")).body.error).toBe("unknown_resource");
    expect((await ask(all.key, "POST", "/lists")).body.error).toBe("unsupported_operation");
  });

  it("marks what each endpoint needs, and lists the errors and the events as they are", () => {
    const required = (method: string, apiPath: string) => endpoints.find((endpoint) => endpoint.method === method && endpoint.path === apiPath)?.fields?.filter((field) => field.includes("*")).map((field) => field.split("*")[0]);
    expect(required("POST", "/contacts")).toEqual(["full_name"]);
    expect(required("POST", "/contacts/{id}/send")).toEqual(["subject", "body"]);
    expect(required("GET", "/run_profiles")).toEqual(["run_id"]);
    expect(required("GET", "/list_members")).toEqual(["list_id"]);
    expect(required("POST", "/signals")).toEqual(["type", "title"]);
    expect(required("POST", "/opportunities")).toEqual(["name"]);
    expect(ERRORS.map((row) => row.status)).toEqual([400, 401, 403, 404, 409, 429]);
    for (const row of ERRORS) expect(source, row.code).toContain(row.code);
    expect(WEBHOOK_EVENTS).toEqual(EVENT_TYPES);
  });
});
