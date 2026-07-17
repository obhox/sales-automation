import "next-auth";
import "next-auth/jwt";
import type { WorkspaceRole } from "@/lib/workspace";

declare module "next-auth" {
  interface Session { user?: { id: string; email?: string | null; name?: string | null; image?: string | null; workspaceId: string; workspaceName: string; role: WorkspaceRole } }
}

declare module "next-auth/jwt" {
  interface JWT { userId?: string; workspaceId?: string; workspaceName?: string; role?: WorkspaceRole }
}
