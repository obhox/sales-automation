import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["@modelcontextprotocol/sdk", "better-sqlite3", "playwright", "playwright-extra", "puppeteer-extra-plugin-stealth"],

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
