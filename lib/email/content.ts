import { createHmac, timingSafeEqual } from "crypto";

export type EmailDeliveryMode = "plain" | "enhanced";

type ContentOptions = {
  mode: EmailDeliveryMode;
  jobId: string;
  trackOpens?: boolean;
  trackClicks?: boolean;
};

const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<]+/gi;

export function hasLinks(value: string): boolean {
  return /(?:https?:\/\/|www\.|\[[^\]]+\]\(https?:\/\/|<a\s)/i.test(value);
}

export function toPlainText(value: string, removeLinks = false): string {
  let text = value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n\n")
    .replace(/\[([^\]]+)\]\((?:https?:\/\/|www\.)[^)]+\)/gi, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");

  if (removeLinks) text = text.replace(URL_PATTERN, "");
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function buildEmailContent(body: string, options: ContentOptions): { text: string; html?: string } {
  if (options.mode === "plain") {
    return { text: toPlainText(body, true) };
  }

  const text = toPlainText(body, false);
  const htmlBody = linkify(text, options.jobId, Boolean(options.trackClicks));
  const openPixel = options.trackOpens ? trackingOpenUrl(options.jobId) : null;
  const pixel = openPixel
    ? `<img src="${escapeAttribute(openPixel)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0" />`
    : "";
  return {
    text,
    html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1A2029">${htmlBody}${pixel}</div>`,
  };
}

export function trackingOpenUrl(jobId: string): string | null {
  const base = trackingBaseUrl();
  const token = signToken("open", jobId);
  return base && token ? `${base}/api/t/o/${token}` : null;
}

export function trackingClickUrl(jobId: string, destination: string): string | null {
  const base = trackingBaseUrl();
  const normalized = normalizeDestination(destination);
  const token = normalized ? signToken("click", jobId, normalized) : null;
  return base && token && normalized
    ? `${base}/api/t/c/${token}?u=${Buffer.from(normalized).toString("base64url")}`
    : null;
}

export function verifyTrackingToken(kind: "open" | "click", token: string, destination = ""): string | null {
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  const encodedId = token.slice(0, dot);
  const supplied = token.slice(dot + 1);
  let jobId = "";
  try { jobId = Buffer.from(encodedId, "base64url").toString("utf8"); } catch { return null; }
  if (!/^[0-9a-f-]{20,}$/i.test(jobId)) return null;
  const expected = signature(kind, jobId, destination);
  if (!expected || supplied.length !== expected.length) return null;
  try {
    return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected)) ? jobId : null;
  } catch {
    return null;
  }
}

export function decodeTrackingDestination(value: string): string | null {
  try { return normalizeDestination(Buffer.from(value, "base64url").toString("utf8")); } catch { return null; }
}

function linkify(text: string, jobId: string, trackClicks: boolean): string {
  let cursor = 0;
  let html = "";
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    const raw = match[0];
    const { url, suffix } = trimUrlPunctuation(raw);
    const destination = normalizeDestination(url);
    html += escapeHtml(text.slice(cursor, start)).replace(/\n/g, "<br />");
    if (destination) {
      const tracked = trackClicks ? trackingClickUrl(jobId, destination) : null;
      html += `<a href="${escapeAttribute(tracked ?? destination)}" style="color:#2450E6;text-decoration:underline">${escapeHtml(url)}</a>${escapeHtml(suffix)}`;
    } else {
      html += escapeHtml(raw);
    }
    cursor = start + raw.length;
  }
  return html + escapeHtml(text.slice(cursor)).replace(/\n/g, "<br />");
}

function trimUrlPunctuation(value: string): { url: string; suffix: string } {
  const match = value.match(/^(.*?)([),.!?;:]*)$/);
  return { url: match?.[1] ?? value, suffix: match?.[2] ?? "" };
}

function normalizeDestination(value: string): string | null {
  const candidate = value.startsWith("www.") ? `https://${value}` : value;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function signToken(kind: "open" | "click", jobId: string, destination = ""): string | null {
  const sig = signature(kind, jobId, destination);
  return sig ? `${Buffer.from(jobId).toString("base64url")}.${sig}` : null;
}

function signature(kind: "open" | "click", jobId: string, destination = ""): string | null {
  const secret = process.env.EMAIL_TRACKING_SECRET || process.env.NEXTAUTH_SECRET;
  if (!secret) return null;
  return createHmac("sha256", secret).update(`${kind}:${jobId}:${destination}`).digest("base64url");
}

function trackingBaseUrl(): string | null {
  const value = (process.env.EMAIL_TRACKING_BASE_URL || process.env.NEXTAUTH_URL || "").replace(/\/$/, "");
  return /^https?:\/\//i.test(value) ? value : null;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char] as string));
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}
