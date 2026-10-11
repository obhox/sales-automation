import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["@modelcontextprotocol/sdk", "better-sqlite3", "playwright", "playwright-extra", "puppeteer-extra-plugin-stealth"],

  // Addresses from before the UI was rebuilt. Each old page became one or more screens;
  // a link someone kept still lands on the screen that took over.
  async redirects() {
    const tabs = (source: string, pairs: ReadonlyArray<readonly [string, string]>) =>
      pairs.map(([tab, destination]) => ({ source, has: [{ type: "query" as const, key: "tab", value: tab }], destination, permanent: true }));
    return [
      { source: "/workflows", destination: "/campaigns", permanent: true },
      { source: "/workflows/:id", destination: "/campaigns/:id", permanent: true },
      // The old Settings page: each of its tabs became a screen.
      ...tabs("/settings", [["linkedin", "/linkedin-accounts"], ["ai", "/ai"], ["email", "/mailboxes"], ["integrations", "/integrations"], ["templates", "/templates"]]),
      { source: "/settings", destination: "/account", permanent: true },
      // The old Platform page, likewise. Its overview is the dashboard now.
      ...tabs("/platform", [["automation", "/signals"], ["deliverability", "/deliverability"], ["integrations", "/integrations"], ["admin", "/inbox"], ["workspace", "/team"]]),
      { source: "/platform", destination: "/", permanent: true },
      { source: "/email-health", destination: "/deliverability", permanent: true },
      { source: "/brand-system", destination: "/", permanent: true },
      // Tasks moved into the pipeline screen.
      { source: "/todos", destination: "/pipeline?view=tasks", permanent: true },
    ];
  },

  // OAuth discovery for the hosted MCP server must live at /.well-known/* (RFC 8414 / 9728).
  // Map those well-known paths to the pages-router API routes that serve the metadata.
  async rewrites() {
    return [
      {
        source: "/.well-known/oauth-authorization-server",
        destination: "/api/oauth/metadata-authorization-server",
      },
      {
        source: "/.well-known/oauth-protected-resource",
        destination: "/api/oauth/metadata-protected-resource",
      },
      {
        // Clients probe the resource-scoped variant too.
        source: "/.well-known/oauth-protected-resource/api/mcp",
        destination: "/api/oauth/metadata-protected-resource",
      },
    ];
  },
};

export default nextConfig;
