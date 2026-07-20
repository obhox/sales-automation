// Shared zod schemas for externally-reachable, non-LinkedIn API routes.
//
// Goals: reject wrong-typed input, bound string lengths (an oversized password
// makes bcrypt slow; oversized text fields bloat SQLite), and prevent crashes on
// a missing/undefined body - WITHOUT changing the success-path contract or the
// documented error codes of existing endpoints.
import { z } from "zod";

/** First zod issue rendered as a short message (matches the repo's existing pattern). */
export function firstIssue(error: z.ZodError, fallback = "Invalid request."): string {
  return error.issues[0]?.message ?? fallback;
}

// --- Auth ---------------------------------------------------------------

// Preserves signup's existing messages while adding type-safety and length caps.
// Order matters: min(1) fires before the >=8 refine, so a blank field still yields
// "Email and password are required." exactly as before.
export const signupSchema = z.object({
  email: z
    .string({ error: "Email and password are required." })
    .trim()
    .min(1, "Email and password are required.")
    .max(320, "Email is too long."),
  password: z
    .string({ error: "Email and password are required." })
    .min(1, "Email and password are required.")
    .max(200, "Password is too long.")
    .refine((p) => p.length >= 8, "Password must be at least 8 characters."),
  invite_token: z.string().max(400).optional(),
});

// --- Public API (pages/api/v1) -----------------------------------------
// These validate types/bounds only. The route keeps its own required-field
// checks first so documented error codes (full_name_required, etc.) are unchanged.

export const apiContactCreateSchema = z.object({
  full_name: z.string().trim().max(300).optional(),
  linkedin_url: z.string().trim().max(1000).nullish(),
  email: z.string().trim().max(320).nullish(),
  title: z.string().trim().max(300).nullish(),
  company: z.string().trim().max(300).nullish(),
  location: z.string().trim().max(300).nullish(),
});

export const apiSignalCreateSchema = z.object({
  type: z.string().trim().max(100).optional(),
  title: z.string().trim().max(500).optional(),
  description: z.string().trim().max(5000).nullish(),
  score: z.number().finite().optional(),
  source: z.string().trim().max(200).nullish(),
  target_id: z.string().trim().max(100).nullish(),
  company_id: z.string().trim().max(100).nullish(),
  occurred_at: z.string().trim().max(100).nullish(),
  // Forwarded verbatim to ingestSignal; kept as opaque so callers can attach context.
  metadata: z.unknown().optional(),
});

// --- Contacts: manually recording a reply -------------------------------

// `channel` is an enum because the route interpolates it into a column name;
// keeping it a closed set is what makes that interpolation safe.
export const markRepliedSchema = z.object({
  channel: z.enum(["linkedin", "email"]).default("linkedin"),
  replied_at: z
    .string()
    .trim()
    .max(64)
    .refine((v) => !Number.isNaN(Date.parse(v)), "replied_at must be a valid date")
    .optional(),
});

// --- Platform: suppressions --------------------------------------------

export const suppressionCreateSchema = z.object({
  kind: z.enum(["email", "domain", "linkedin", "phone"], {
    error: "Valid kind and value are required",
  }),
  value: z
    .string({ error: "Valid kind and value are required" })
    .trim()
    .min(1, "Valid kind and value are required")
    .max(500, "Value is too long"),
  reason: z.string().trim().max(500).optional(),
  target_id: z.string().trim().max(100).optional(),
});
