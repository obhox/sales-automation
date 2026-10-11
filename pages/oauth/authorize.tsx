import type { GetServerSideProps } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { AuthFrame } from "@/components/auth/AuthFrame";
import { scopeWords } from "@/components/auth/model";
import { Button } from "@/components/ui";
import { clientRedirectAllowed, getOAuthClient, MCP_SCOPES, mcpResourceUrl, normalizeScopes } from "@/lib/mcp/auth";

interface Props { clientName: string; params: Record<string, string>; scopes: string[]; workspaceName: string }

export default function OAuthAuthorize({ clientName, params, scopes, workspaceName }: Props) {
  return (
    <AuthFrame
      title="Authorize an MCP client"
      heading={`Connect ${clientName}`}
      lead={<>This MCP client is asking for access to <span className="font-medium text-ink">{workspaceName}</span>, acting as you.</>}
      footer="You can end this connection at any time from Developer API."
    >
      <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
        {scopes.map((scope) => {
          const words = scopeWords(scope);
          return (
            <li key={scope} className="flex items-start gap-3 px-3 py-2.5">
              <span className="mt-0.5 inline-flex h-5 shrink-0 items-center rounded-full bg-control px-2 text-105 font-semibold text-ink-2">{words.title}</span>
              <span className="text-12 leading-[18px] text-ink-2">{words.detail}</span>
            </li>
          );
        })}
      </ul>
      <form method="post" action="/api/oauth/authorize" className="flex flex-col gap-2">
        {Object.entries(params).map(([key, value]) => <input key={key} type="hidden" name={key} value={value} />)}
        <Button type="submit" variant="primary" className="h-9 w-full">Authorize access</Button>
        <Button type="button" variant="ghost" className="h-9 w-full" onClick={() => history.back()}>Cancel</Button>
      </form>
    </AuthFrame>
  );
}

export const getServerSideProps: GetServerSideProps<Props> = async (ctx) => {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  const callbackUrl = ctx.resolvedUrl;
  if (!session) return { redirect: { destination: `/login?callbackUrl=${encodeURIComponent(callbackUrl)}`, permanent: false } };
  const q = ctx.query;
  const clientId = typeof q.client_id === "string" ? q.client_id : "";
  const redirectUri = typeof q.redirect_uri === "string" ? q.redirect_uri : "";
  const client = getOAuthClient(clientId);
  if (!client || !clientRedirectAllowed(client, redirectUri) || q.response_type !== "code" || q.code_challenge_method !== "S256" || typeof q.code_challenge !== "string") return { notFound: true };
  const resource = typeof q.resource === "string" ? q.resource : mcpResourceUrl(ctx.req as never);
  const scopes = normalizeScopes(q.scope);
  const params: Record<string, string> = {
    client_id: clientId, redirect_uri: redirectUri, response_type: "code",
    code_challenge: q.code_challenge, code_challenge_method: "S256",
    scope: scopes.join(" "), resource,
  };
  if (typeof q.state === "string") params.state = q.state;
  return { props: { clientName: client.client_name || "MCP client", params, scopes: scopes.length ? scopes : [...MCP_SCOPES], workspaceName: session.user?.workspaceName ?? "your Linki workspace" } };
};
