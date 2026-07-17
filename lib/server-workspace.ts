import type { GetServerSidePropsContext } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { workspaceFromSession, type WorkspaceContext } from "@/lib/workspace";

type PageRequest = GetServerSidePropsContext["req"];
type PageResponse = GetServerSidePropsContext["res"];

/** Resolve the active workspace from the signed browser session during SSR. */
export async function getServerWorkspace(
  req: PageRequest,
  res: PageResponse
): Promise<WorkspaceContext | null> {
  const session = await getServerSession(req, res, authOptions);
  return workspaceFromSession(session);
}

/** Keep unauthenticated page requests out of workspace-scoped server rendering. */
export function loginRedirect(req: PageRequest) {
  const callbackUrl = req.url || "/";
  return {
    redirect: {
      destination: `/login?callbackUrl=${encodeURIComponent(callbackUrl)}`,
      permanent: false,
    },
  } as const;
}
