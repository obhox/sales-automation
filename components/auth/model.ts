// What the sign-in and other signed-out pages say, apart from how they draw it. No React.

/** What another page sends people back to sign in to be told (?notice=...). */
export const NOTICES: Record<string, string> = {
  "password-reset": "Your password has been reset. Sign in with the new one.",
  "password-changed": "Your password has been changed. Sign in again.",
  "email-verified": "Your email is confirmed. You can sign in now.",
  "session-ended": "Your session has ended. Sign in again.",
};

/** Where to go after signing in: only ever a path on this site. */
export function safeCallback(value: unknown): string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\") ? value : "/";
}

/** What Linki does, for the panel beside the sign-in form. Each is true of the product as built. */
export const HIGHLIGHTS = [
  { title: "LinkedIn and email in one sequence", detail: "Steps on both channels, with conditions that hand a contact from one to the other." },
  { title: "One inbox for every reply", detail: "Email and LinkedIn conversations together, read and sorted as they arrive." },
  { title: "Senders that look after themselves", detail: "Daily and weekly limits, warm-up, and a guard that pauses a mailbox before it does harm." },
  { title: "Figures you can act on", detail: "Reply rates by step and version, with how sure an A/B result is." },
] as const;

/** What an MCP client is asking to be allowed to do, in a sentence a person can weigh. */
export const SCOPE_WORDS: Record<string, { title: string; detail: string }> = {
  "mcp:read": { title: "Read", detail: "Contacts, campaigns, the inbox, figures and settings." },
  "mcp:write": { title: "Change", detail: "Create and update contacts, lists, templates and campaigns." },
  "mcp:execute": { title: "Act", detail: "Launch campaigns, send replies, import and enrich data." },
};
export const scopeWords = (scope: string) => SCOPE_WORDS[scope] ?? { title: scope, detail: "A permission this version of Linki has no description for." };

const ROLE_WORDS: Record<string, string> = { owner: "an owner", admin: "an admin", manager: "a manager", member: "a member", viewer: "a viewer" };
export const asRole = (role: string) => ROLE_WORDS[role] ?? `a ${role}`;

export interface Invite { email: string; role: string; workspace_id: string; workspace_name: string; status: string; expires_at: string; existing_user: boolean }

/** Why an invitation that is not waiting to be accepted cannot be used. */
export function inviteProblem(invite: Pick<Invite, "status">): string | null {
  if (invite.status === "pending") return null;
  if (invite.status === "accepted") return "This invitation has already been used. Sign in to open the workspace.";
  if (invite.status === "expired") return "This invitation has expired. Ask whoever invited you to send a new one.";
  if (invite.status === "revoked") return "This invitation was withdrawn. Ask whoever invited you to send a new one.";
  return `This invitation is ${invite.status} and cannot be used.`;
}

/** Why a new password cannot be set as typed, or null. */
export function passwordProblem(password: string, confirm: string): string | null {
  if (password.length < 8) return "Use at least 8 characters.";
  if (password !== confirm) return "The two passwords don't match.";
  return null;
}
