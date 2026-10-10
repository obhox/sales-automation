// The workspace's booking link: the page a contact is sent to to pick a meeting time (a
// Calendly, Cal.com or similar address the workspace already has). The contact profile's
// "Book meeting" opens it and the inbox can paste it into a reply. It stands in until
// calendars are connected, when a meeting can be booked from inside Linki.
import type DatabaseType from "better-sqlite3";
import { getDb } from "@/lib/db";
import { getWorkspaceSetting, setWorkspaceSetting } from "@/lib/workspace-settings";

type DB = DatabaseType.Database;

export const BOOKING_URL_KEY = "booking_url";
const MAX_LENGTH = 500;

export function getBookingUrl(workspaceId: string, db: DB = getDb()): string | null {
  return getWorkspaceSetting(workspaceId, BOOKING_URL_KEY, db) || null;
}

/** The address as it will be stored, or a sentence saying why it was refused. An empty value clears the link. */
export function bookingUrlProblem(value: unknown): { url: string | null } | string {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return { url: null };
  if (typeof value !== "string") return "The booking link must be a web address";
  const text = value.trim();
  if (text.length > MAX_LENGTH) return `The booking link can be up to ${MAX_LENGTH} characters`;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return "The booking link must be a full web address, starting with https://";
  }
  // It is opened in a browser and may be sent to contacts, so it has to be an ordinary web page.
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "The booking link must start with https://";
  return { url: parsed.toString() };
}

export function setBookingUrl(workspaceId: string, url: string | null, db: DB = getDb()): void {
  setWorkspaceSetting(workspaceId, BOOKING_URL_KEY, url ?? "", db);
}
