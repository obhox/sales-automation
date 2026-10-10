import { createHmac } from "crypto";
import { getDb } from "@/lib/db";
import {
  CONTEXT_SIGNATURE_HEADER, ROLE_HEADER, SESSION_IAT_HEADER, USER_HEADER, WORKSPACE_HEADER,
  contextSigningInput,
} from "@/lib/auth";
import type { WorkspaceRole } from "@/lib/workspace";

process.env.NEXTAUTH_SECRET ||= "test-secret-for-signing-workspace-context";

/**
 * The context headers proxy.ts forwards to a route, signed as it signs them, for tests that
 * call a handler directly. A route reads a user's role from workspace_members, not from the
 * header, so naming a user also gives them that role in the workspace (which must exist).
 * Without a user it is an internal service call and the signed role stands.
 */
export function ctxHeaders(workspaceId: string, opts: { userId?: string; role?: string; iat?: string } = {}): Record<string, string> {
  const role = opts.role ?? "owner";
  if (opts.userId) {
    const db = getDb();
    db.prepare("INSERT OR IGNORE INTO users (id, email, password_hash) VALUES (?, ?, 'x')").run(opts.userId, `${opts.userId}@ctx.test`);
    db.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)
      ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = excluded.role`).run(workspaceId, opts.userId, role as WorkspaceRole);
  }
  return signedHeaders({ workspaceId, userId: opts.userId ?? "", role, iat: opts.iat ?? "" });
}

/** Sign claims exactly as given, touching no rows — for tests about the signature itself. */
export function signedHeaders(claims: { workspaceId: string; userId: string; role: string; iat: string }): Record<string, string> {
  const signature = createHmac("sha256", process.env.NEXTAUTH_SECRET!).update(contextSigningInput(claims)).digest("hex");
  const headers: Record<string, string> = { [WORKSPACE_HEADER]: claims.workspaceId, [CONTEXT_SIGNATURE_HEADER]: signature };
  if (claims.userId) headers[USER_HEADER] = claims.userId;
  if (claims.role) headers[ROLE_HEADER] = claims.role;
  if (claims.iat) headers[SESSION_IAT_HEADER] = claims.iat;
  return headers;
}
