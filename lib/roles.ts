// Workspace roles, in one place that both the server and the browser can import
// (lib/workspace.ts pulls in the database and cannot be bundled for the client).

export type WorkspaceRole = "owner" | "admin" | "manager" | "member" | "viewer";

export const ROLE_LEVEL: Record<WorkspaceRole, number> = { viewer: 0, member: 1, manager: 2, admin: 3, owner: 4 };

export const ROLES: WorkspaceRole[] = ["owner", "admin", "manager", "member", "viewer"];

export const ROLE_LABEL: Record<WorkspaceRole, string> = { owner: "Owner", admin: "Admin", manager: "Manager", member: "Member", viewer: "Viewer" };

export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(ROLE_LEVEL, value);
}

/** True when `role` is `minimum` or above. An unknown or missing role is never enough. */
export function roleAtLeast(role: WorkspaceRole | null | undefined, minimum: WorkspaceRole): boolean {
  return isWorkspaceRole(role) && ROLE_LEVEL[role] >= ROLE_LEVEL[minimum];
}
