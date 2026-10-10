import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["@modelcontextprotocol/sdk", "better-sqlite3", "playwright", "playwright-extra", "puppeteer-extra-plugin-stealth"],

  // Screens that moved in the UI rebuild. Temporary until the release, so that an address
  // can still be given back to its old page; they become permanent with the last phase.
  async redirects() {
    return [
      { source: "/workflows", destination: "/campaigns", permanent: false },
      // A campaign's Sequence tab is rebuilt; its other tabs are still the old page.
      { source: "/campaigns/:id", destination: "/workflows/:id", permanent: false },
      { source: "/campaigns/:id/prospects", destination: "/workflows/:id", permanent: false },
      { source: "/campaigns/:id/settings", destination: "/workflows/:id", permanent: false },
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
