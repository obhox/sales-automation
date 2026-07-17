import Head from "next/head";
import Image from "next/image";
import type { GetServerSideProps } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { clientRedirectAllowed, getOAuthClient, MCP_SCOPES, mcpResourceUrl, normalizeScopes } from "@/lib/mcp/auth";

interface Props { clientName: string; params: Record<string, string>; scopes: string[]; workspaceName: string }

export default function OAuthAuthorize({ clientName, params, scopes, workspaceName }: Props) {
  return <>
    <Head><title>Authorize MCP — Linki</title><meta name="robots" content="noindex,nofollow" /></Head>
    <main className="flex min-h-screen items-center justify-center bg-base-200 px-5 py-10 sm:px-8">
      <div className="w-full max-w-[420px]">
        <div className="mb-8 flex justify-center">
          <Image src="/linki-wordmark.svg" alt="Linki" width={104} height={30} priority />
        </div>
        <div className="rounded-2xl border border-[var(--border-subtle)] bg-base-100 p-6 shadow-[var(--shadow-raised)] sm:p-8">
          <div className="mb-6">
            <p className="mb-2 text-xs font-semibold text-primary">Authorization request</p>
            <h1 className="text-[30px] font-semibold leading-[1.1] tracking-[-.03em] text-base-content">Connect {clientName}</h1>
            <p className="mt-3 text-[15px] leading-6 text-base-content/50">This MCP client is requesting access to <strong className="font-medium text-base-content/75">{workspaceName}</strong>.</p>
          </div>
          <ul className="mb-6 space-y-2">
            {scopes.map((scope) => <li key={scope} className="flex gap-3 rounded-[10px] border border-[var(--border-subtle)] bg-base-200 px-3.5 py-3 text-sm leading-5 text-base-content/70">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-base-content/30" aria-hidden="true" />
              <span>
              {scope === "mcp:read" ? "Read contacts, campaigns, inbox, analytics and configuration" :
               scope === "mcp:write" ? "Create and update CRM records, lists, templates and workflows" :
               "Launch campaigns, send replies, import and enrich data"}
              </span>
            </li>)}
          </ul>
          <form method="post" action="/api/oauth/authorize" className="flex flex-col gap-2.5">
            {Object.entries(params).map(([key, value]) => <input key={key} type="hidden" name={key} value={value} />)}
            <button type="submit" className="btn btn-primary h-11 w-full px-4">Authorize access</button>
            <button type="button" className="btn btn-ghost h-11 w-full px-4" onClick={() => history.back()}>Cancel</button>
          </form>
        </div>
        <p className="mt-7 text-center text-[11px] leading-5 text-base-content/45">
          You can revoke this connection at any time from your workspace settings.
        </p>
      </div>
    </main>
  </>;
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
