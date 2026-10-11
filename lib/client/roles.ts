import { useSession } from "next-auth/react";
import { roleAtLeast, type WorkspaceRole } from "@/lib/roles";

/**
 * The signed-in member's role in the current workspace, for deciding what to
 * show. It comes from the session, which can lag behind a role change; the API
 * checks the real role on every request, so this only ever hides or shows
 * controls. A missing session counts as a viewer.
 */
export function useRole(): WorkspaceRole {
  const { data: session } = useSession();
  return session?.user?.role ?? "viewer";
}

/** Whether the member is at least `minimum`. Members can change data; viewers only read. */
export function useCan(minimum: WorkspaceRole): boolean {
  return roleAtLeast(useRole(), minimum);
}
