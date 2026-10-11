import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["@modelcontextprotocol/sdk", "better-sqlite3", "playwright", "playwright-extra", "puppeteer-extra-plugin-stealth"],

  // Screens that moved in the UI rebuild. Temporary until the release, so that an address
  // can still be given back to its old page; they become permanent with the last phase.
  async redirects() {
    return [
      { source: "/workflows", destination: "/campaigns", permanent: false },
      // The old Settings page is gone: each of its tabs became a screen.
      ...([["linkedin", "/linkedin-accounts"], ["ai", "/ai"], ["email", "/mailboxes"], ["integrations", "/integrations"], ["templates", "/templates"]] as const).map(([tab, destination]) => (
        { source: "/settings", has: [{ type: "query" as const, key: "tab", value: tab }], destination, permanent: false }
      )),
      { source: "/settings", destination: "/account", permanent: false },
      { source: "/brand-system", destination: "/", permanent: false },
      { source: "/workflows/:id", destination: "/campaigns/:id", permanent: false },
      // Tasks moved into the pipeline screen.
      { source: "/todos", destination: "/pipeline?view=tasks", permanent: false },
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
