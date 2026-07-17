<p align="center">
  <img src="public/logo_linki.png" alt="Linki" width="56" />
</p>

<h1 align="center">Linki</h1>
<p align="center">Open-source AI SDR for B2B outreach. LinkedIn sequences, cold email, and lead enrichment — self-hosted, no per-seat pricing.</p>

<p align="center">
  <a href="https://opsily.com/hosting/linki?utm_source=github&utm_medium=readme&utm_campaign=linki">
    <img src="public/deploy-with-opsily.svg" alt="Deploy with Opsily" height="36" />
  </a>
  &nbsp;
  <a href="https://discord.gg/8VPeFDJMn">
    <img src="https://img.shields.io/badge/Discord-Join%20our%20community-5865F2?logo=discord&logoColor=white" alt="Join our Discord" height="36" />
  </a>
</p>

---

<p align="center">
  <strong>▶ Full demo &nbsp;|&nbsp;</strong>
  <a href="https://youtu.be/S6n4RHULq3E">https://youtu.be/S6n4RHULq3E</a>
</p>
<p align="center">
  <a href="https://youtu.be/S6n4RHULq3E">
    <img src="https://img.youtube.com/vi/S6n4RHULq3E/maxresdefault.jpg" alt="Click to watch the full demo on YouTube" width="720" />
  </a>
</p>

---

## What is Linki

Linki is an open-source AI SDR built for B2B founders and sales teams who want full control over their outreach. You build multichannel campaigns — LinkedIn sequences, cold email, or both — enrich your leads, and run everything on your own server. Your data never leaves your machine.

No SaaS middleman. No per-seat pricing. No black box.

---

## Features

### 📬 Multichannel Campaigns

- **LinkedIn + email in one campaign**: run LinkedIn actions (visit, connect, message) and email actions in parallel within a single campaign sequence
- **Flexible step builder**: chain visit → connect → delay → message → cold email in any order, with configurable delays between steps
- **Per-lead state tracking**: see exactly where every lead is across both channels, with a live pipeline view broken down by step and status
- **A/B template pools**: assign multiple message templates to a step and rotate them automatically

### 🔐 Server-Side LinkedIn Login

- **Headless server-side authentication**: log in to LinkedIn directly on your server — no cookie-pasting — so the session is born under the exact browser fingerprint the automation runs with
- **Handles LinkedIn's real challenges**: email/SMS codes **and** mobile-app device approval, plus LinkedIn's dynamic React login fields
- **Longer, more stable sessions**: a pinned browser fingerprint keeps sessions alive far longer, enabling more complex and more frequent LinkedIn activity without forced logouts
- **Captures the full session**: including the httpOnly Sales Navigator seat cookie that cookie-paste can't reach — so Sales Nav import and enrichment just work

### 🔍 Data & Enrichment

- **Sales Navigator import**: paste a list URL and Linki pulls in all leads with name, title, company, location, seniority, and LinkedIn URL
- **CSV import**: bring in leads from anywhere else — a downloadable template covers LinkedIn URL, Sales Nav URL, email, and every contact field; each row just needs a LinkedIn URL and/or an email, so LinkedIn-only, email-only, and mixed lists all work
- **Batched & scheduled imports**: large lists split across days automatically under a global daily cap, with human-like pacing so imports never look like a bot burst
- **Apollo.io enrichment**: connect your Apollo API key and enrich any list with verified email addresses, company data, and seniority in one click
- **Sales Nav profile enrichment**: pull richer profile data (headline, positions) for better targeting, gathered at runner time to stay under the radar
- **Company model**: enriched company records (description, headcount, industry, location) linked from contacts; never duplicated across leads
- **Contact detail pages**: full profile view with outreach history, enrichment status, and all campaign activity per contact

### 📥 Unified Inbox

- **Aggregated reply feed**: all email replies from active campaigns surface in one inbox regardless of which email account received them
- **Email + LinkedIn reply detection**: the runner passively monitors both email and LinkedIn conversations and flags contacts who replied
- **Reply filtering**: only shows contacts who actually replied; noise-free by design
- **Inline reply composer**: read the full email thread and reply without leaving Linki
- **Reply intelligence**: classifies positive, negative, out-of-office, unsubscribe, and ambiguous replies and dispatches the safe next action
- **Team inbox controls**: assignment, expiring collision locks, tags, saved replies, bulk status/assignment, SLA due dates, sentiment, and overdue filters

### 🧩 Revenue Platform

- **Isolated team workspaces and RBAC**: owner, admin, manager, member, and viewer roles; tenant-scoped records; audit logs; encrypted secrets; per-workspace API keys; expiring email invitations; and workspace switching
- **Conditional campaigns**: forward-only branches on connected/replied state, email availability, intent score, signals, target properties, and custom CRM fields
- **Global suppression/DNC**: email, domain, LinkedIn, and phone suppression checked immediately before every automated and manual send
- **Deliverability center**: live SPF, DKIM, DMARC and MX checks, sender-health scoring, placement tests, bounce-rate recommendations, and reciprocal mailbox warmup
- **Signals and scoring**: job-change, funding, hiring, technology, product-intent, and custom signals can raise intent and enroll contacts through configurable rules
- **CRM, calendar, and revenue**: two-way HubSpot/Salesforce contact synchronization, incremental Google/Microsoft Calendar or iCal ingestion, meeting attribution, opportunity stages, owners, weighted pipeline, and won revenue
- **Public API and webhooks**: hashed scoped API keys, versioned `/api/v1` resources, durable domain events, HMAC-signed delivery, exponential retries, and dead-letter state
- **MCP-native operation**: Streamable HTTP, OAuth 2.1/PKCE, dynamic client registration, workspace-bound access tokens, dedicated tools for every platform area, resources, prompts, and MCP audit logs

### ⚡ Reliability & Safety

- **Pinned browser fingerprint**: Chromium and its base image are version-pinned so a rebuild never changes the fingerprint LinkedIn sees — the single biggest cause of forced logouts, eliminated
- **63% improvement in connection reliability**: rewritten LinkedIn automation with smarter DOM targeting, clipboard-based message delivery, and graceful handling of LinkedIn's UI variants
- **Human-like import behavior**: lead list imports use randomized delays and pacing patterns to avoid triggering LinkedIn's bot detection
- **Email account ramp-up**: gradually increase sending volume on new email accounts to build sender reputation safely
- **Multiple accounts**: connect as many SMTP/IMAP email accounts and LinkedIn accounts as you need, each with its own daily limits
- **Daily limits & auto-reschedule**: set max connections and messages per day; when a limit is hit the runner reschedules work for the next day automatically instead of stopping the campaign

### 📊 Analytics

- **Campaign pipeline view**: funnel breakdown by step with prospect counts per stage; click any step to drill into the exact contacts at that point
- **Stats bar**: live counts for total prospects, in progress, completed, failed/skipped, connections sent, accepted, and messages sent
- **Acceptance rate**: tracks connection request → acceptance ratio per campaign
- **Dashboard overview**: cross-campaign summary of active runs, total contacts, recent activity

---

## What's new

- **CSV import** — bring your own leads from any source (a prior export, a website scrape, another tool). One template covers everything: LinkedIn URL, Sales Navigator URL, email, and every contact field — each row just needs a LinkedIn URL and/or an email
- **Generic inboxes supported** — role-based addresses (`info@`, `contact@`, `sales@…`) import as regular contacts, ready for email-only campaigns
- **Phone number field** — track a contact's phone alongside email and LinkedIn, editable inline on the contact page or via CSV/API
- **Bulk contact deletion** — permanently delete contacts (and their run history) from the Contacts page, with a confirmation step
- **Server-side headless LinkedIn login** — logs in on your server (email/SMS code **or** mobile-app approval), captures the full session incl. the Sales Navigator seat cookie, and unlocks longer, more frequent, more complex LinkedIn sessions
- **Pinned browser fingerprint** — Chromium + base image are version-pinned so rebuilds never trigger a forced logout
- **Batched & scheduled imports** — big Sales Nav lists split across days under a global daily cap with human-like pacing
- **Better reply sync** — reply detection for **both** email and LinkedIn, with accurate accepted-connection sync via LinkedIn's own APIs
- **Lead enrichment built in** — Apollo.io + Sales Nav profile enrichment, one-click on any list

---

## Hosting options

### One-click on Opsily (recommended)

[Opsily](https://opsily.com/hosting/linki?utm_source=github&utm_medium=readme&utm_campaign=linki) is the easiest way to run Linki. Create a server, deploy Linki from the app store, and you get a live URL in under a minute: no terminal required.

[![Deploy with Opsily](public/deploy-with-opsily.svg)](https://opsily.com/hosting/linki?utm_source=github&utm_medium=readme&utm_campaign=linki)

### Self-host with Docker

**1. Create your environment file**

```bash
cp .env.example .env.local
```

Fill in `.env.local`:

```env
# Public URL of the app (e.g. https://linki.yourdomain.com or http://localhost:3456)
NEXTAUTH_URL=http://localhost:3456

# Random secret: generate with: openssl rand -base64 32
NEXTAUTH_SECRET=your_random_secret_here
```

**2. Start the container**

```bash
docker compose up -d
```

Or pull the image directly:

```bash
docker run -d -p 3456:3000 \
  -e NEXTAUTH_URL=http://localhost:3456 \
  -e NEXTAUTH_SECRET=your_random_secret_here \
  -v $(pwd)/data:/data \
  moaljumaa/linki:latest
```

Linki is now running at `http://localhost:3456`. The SQLite database is persisted in `./data/linki.db` on your host machine.
Open the sign-in page, choose **Sign up**, and create an account with your email and password.

> **Security:** Registration is open by default, but every signup receives an isolated workspace. Invite teammates from **Platform → Workspace & API** and grant the minimum role they need. Put production deployments behind HTTPS and use a strong `NEXTAUTH_SECRET`.

### Self-host manually (Node.js)

Requires Node.js 22+.

```bash
npm install
npm run build
npm start
```

---

## Setup

### 1. Add a LinkedIn account

Go to **Settings → LinkedIn** and add your account. Set conservative daily limits to start (recommended: 20 connections/day, 30 messages/day).

### 2. Authenticate LinkedIn

Click **Authenticate** and use **Server login** — Linki logs in on the server and walks you through LinkedIn's verification (email/SMS code or a tap in the LinkedIn mobile app). This captures a full, long-lived session, including the Sales Navigator seat needed for imports.

### 3. Add email accounts (optional)

Go to **Settings → Email** and add your SMTP/IMAP accounts. You can add as many as you need. Enable ramp-up on new accounts to build sender reputation gradually.

### 4. Connect Apollo (optional)

Go to **Settings → Integrations** and add your Apollo API key. Once connected, open any lead list and click **Enrich** to pull in verified emails and company data.

### 5. Import a lead list

Go to **Lists → New list** and paste a LinkedIn Sales Navigator list URL. Linki imports all leads with human-like pacing to avoid detection.

> **Note:** A LinkedIn Sales Navigator subscription is required to import leads.

### 6. Build and launch a campaign

Go to **Workflows → New workflow**. Add your steps — LinkedIn actions, email steps, delays — write your messages (or use templates and A/B pools), then create a run and launch.

---

## Optional hosted services

This fork runs standalone and includes per-lead AI writing through your own OpenRouter key, CRM Todos, contact activity tracking, deliverability, signals, pipeline, team inbox, public API/webhooks, and a native MCP server at `/api/mcp`.

### Public API

Create a scoped key in **Platform → Workspace & API**, then send it as a bearer token:

```bash
curl -H "Authorization: Bearer lnk_…" \
  http://localhost:3000/api/v1/contacts
```

Resources include `contacts`, `companies`, `lists`, `workflows`, `runs`, `events`, `signals`, and `opportunities`. Pagination uses `limit` and `offset`. Delivery providers can report `email.delivered` or `email.bounced` through `POST /api/v1/events` with an `events:write` key.

Webhook signatures use `HMAC-SHA256(secret, "<x-linki-timestamp>.<raw-body>")` and arrive in `x-linki-signature` as `sha256=<hex>`.

### MCP

Connect an MCP client to `https://your-linki-host/api/mcp`. Authorization discovery, OAuth client registration, PKCE authorization, refresh tokens, and resource binding are exposed automatically. MCP access tokens carry the authorizing user's workspace and role, so tool calls preserve the same tenant and permission boundary as the web app.

Claude's official web origins are accepted automatically. For another browser-based MCP client, add its HTTPS origin to the comma-separated `MCP_ALLOWED_ORIGINS` environment variable.

Every authenticated workspace operation is MCP-usable. Dedicated tools cover contacts, companies, custom fields, lists/imports, templates, conditional workflows and steps, campaign runs/enrollments, LinkedIn and email senders, reply intelligence, the collaborative inbox, suppression, deliverability, signals, pipeline/meetings, CRM/calendar sync, integration credentials, AI configuration, events/webhooks, API keys, workspace invitations/members, audit logs, and application settings. `linki_api_request` provides a permission-aware compatibility path for future authenticated endpoints, while `linki://workspace/capabilities` reports the live coverage map.

Security/bootstrap operations—password login/signup, OAuth token issuance, MCP transport, host updates, and public invitation acceptance—remain outside authenticated MCP tools by design. OAuth authorization binds the resulting token to the workspace currently selected in Linki.

### Team invitations

Open **Platform → Workspace & API**, enter a teammate's email, and select a role. Linki creates a single-use link that expires after seven days and sends it through the workspace's configured SMTP account; if no sender is available, copy the returned link. Existing users sign in before accepting, new users create their account from the invitation, and members of multiple workspaces can switch from the same screen. Owners and administrators can list or revoke pending invitations from the UI, REST endpoint, or `workspace_invitation_manage` MCP tool.

---

## License

Linki is source-available under the [Linki Sustainable Use License](LICENSE).

**You can:** use it personally, use it for your business, self-host it on your own VPS or laptop, modify it, contribute to it.
