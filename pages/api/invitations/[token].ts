import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { acceptWorkspaceInvitation, getInvitationByToken } from "@/lib/workspace-invitations";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const token = String(req.query.token ?? "");
  const invitation = token ? getInvitationByToken(token) : null;
  if (!invitation) return res.status(404).json({ error: "Invitation not found" });
  if (req.method === "GET") return res.json(invitation);
  if (req.method === "POST") {
    const session = await getServerSession(req, res, authOptions);
    if (!session?.user?.id || !session.user.email) return res.status(401).json({ error: "Sign in with the invited email address", sign_in_required: true });
    try {
      const accepted = acceptWorkspaceInvitation(token, session.user.id, session.user.email);
      return res.json({ ok: true, workspace_id: accepted.workspace_id, workspace_name: accepted.workspace_name });
    } catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  }
  return res.status(405).end();
}
