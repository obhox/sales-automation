import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { clientRedirectAllowed, getOAuthClient, issueAuthorizationCode, mcpResourceUrl, normalizeScopes } from "@/lib/mcp/auth";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  const session = await getServerSession(req, res, authOptions);
  if (!session?.user) return res.status(401).json({ error: "login_required" });
  const body = req.body as Record<string, string | undefined>;
  const client = body.client_id ? getOAuthClient(body.client_id) : undefined;
  if (!client || !body.redirect_uri || !clientRedirectAllowed(client, body.redirect_uri)) {
    return res.status(400).json({ error: "invalid_client" });
  }
  if (body.response_type !== "code" || body.code_challenge_method !== "S256" || !body.code_challenge) {
    return redirectError(res, body.redirect_uri, body.state, "invalid_request", "OAuth PKCE with S256 is required");
  }
  const expectedResource = mcpResourceUrl(req);
  if (body.resource && body.resource !== expectedResource) {
    return redirectError(res, body.redirect_uri, body.state, "invalid_target", "Unknown MCP resource");
  }
  const scopes = normalizeScopes(body.scope);
  if (scopes.length === 0) return redirectError(res, body.redirect_uri, body.state, "invalid_scope", "No supported scope requested");
  const code = issueAuthorizationCode({
    clientId: client.client_id,
    userId: String((session.user as { id?: string }).id ?? session.user.email),
    redirectUri: body.redirect_uri,
    codeChallenge: body.code_challenge,
    scopes,
    resource: expectedResource,
    workspaceId: session.user.workspaceId,
  });
  const destination = new URL(body.redirect_uri);
  destination.searchParams.set("code", code);
  if (body.state) destination.searchParams.set("state", body.state);
  return res.redirect(302, destination.toString());
}

function redirectError(res: NextApiResponse, redirectUri: string, state: string | undefined, error: string, description: string) {
  const destination = new URL(redirectUri);
  destination.searchParams.set("error", error);
  destination.searchParams.set("error_description", description);
  if (state) destination.searchParams.set("state", state);
  return res.redirect(302, destination.toString());
}
