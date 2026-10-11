// Everything the public page says, in one place, so the words can be changed without
// touching the layout. Each statement here is true of the product as built: before adding
// one, check the code does it. Nothing about cost or commercial terms belongs on this
// page (tests/welcome.test.ts holds it to that).
import sizes from "./shots.json";

/** Where the source lives. The page links here and nowhere else outside the app. */
export const REPOSITORY_URL = "https://github.com/obhox/sales-automation";
export const LICENSE_URL = `${REPOSITORY_URL}/blob/main/LICENSE`;
export const SETUP_URL = `${REPOSITORY_URL}#readme`;

export const META = {
  title: "Linki: LinkedIn and email outreach in one sequence",
  description:
    "Linki runs LinkedIn steps and emails in one sequence, keeps every account and mailbox inside its limits, and brings each reply into one inbox. It runs on your own server.",
  /** The picture a link to the page is shown with. Taken by scripts/screenshots.mjs. */
  image: { src: "/welcome/preview.png", width: 1200, height: 630, alt: "A campaign's figures in Linki: reply rate, open rate and daily activity." },
};

export type ShotName = keyof typeof sizes;

/** A picture of the demo workspace, from public/welcome. `alt` says what it shows to someone who cannot see it. */
export interface Shot {
  name: ShotName;
  alt: string;
  /** The picture stops part-way down a panel, so it fades out rather than ending in a hard edge. */
  cut?: boolean;
}

export const HERO = {
  eyebrow: "Sales outreach on your own server",
  title: "LinkedIn and email, in one sequence.",
  lede: "Linki sends LinkedIn steps and emails side by side, hands a contact from one channel to the other, and brings every reply into a single inbox.",
  shot: {
    name: "sequence-builder",
    alt: "The sequence builder: a LinkedIn track and an email track side by side, with conditions between the steps, and one email step open showing its four versions and its wording.",
  } satisfies Shot,
};

export interface Section {
  /** The anchor a link in the header jumps to. */
  id: string;
  /** The short name used in the header's navigation; sections without one are not listed there. */
  nav?: string;
  eyebrow: string;
  /** Which channel's mark sits beside the eyebrow, where the section is about one channel. */
  channel?: "linkedin" | "email";
  title: string;
  body: string;
  points: string[];
  /** One picture sits beside the words; two sit under them, the first twice the width of the second unless `even`. */
  shots: Shot[];
  even?: boolean;
  /** A command shown with the section. `{origin}` becomes the address of this instance. */
  code?: { text: string; caption: string }[];
}

export const SECTIONS: Section[] = [
  {
    id: "sequences",
    nav: "Sequences",
    eyebrow: "Sequences",
    title: "Two tracks, and a plan for each contact.",
    body: "A campaign has a LinkedIn track and an email track that run side by side. Conditions between the steps decide what happens next, and each branch shows how many contacts took it.",
    points: [
      "Profile visits, connection requests, LinkedIn messages and emails, with waits in hours or days.",
      "Conditions on an accepted connection, a reply, a verified email address, or what is known about the contact, such as an intent score.",
      "You choose each outcome: continue, jump ahead, end the track, leave the sequence, or hand over to the email track.",
      "Up to four versions of an email, split by the weights you set.",
    ],
    shots: [
      { name: "linkedin-track", alt: "The LinkedIn track of a campaign: a profile visit, a connection request, a condition that hands contacts who do not accept over to the email track, a message, and a follow-up." },
      { name: "email-track", alt: "The email track of the same campaign: three emails, the first in four versions, with a condition on a verified email address and another on intent score." },
    ],
    even: true,
  },
  {
    id: "linkedin",
    nav: "Channels",
    eyebrow: "LinkedIn accounts",
    channel: "linkedin",
    title: "Several accounts, each inside its own limits.",
    body: "A campaign can send from a pool of LinkedIn accounts, in turn or by how much room each has left. Every account keeps its own limits, working hours and time zone, and a contact stays with the account that first reached them.",
    points: [
      "Daily limits for invitations, messages, profile visits and withdrawals, and a weekly invitation limit counted over a rolling seven days.",
      "A warm-up that raises a new account's invitations day by day.",
      "When LinkedIn ends a session or refuses an invitation, that account waits. The other accounts and the email steps carry on.",
      "Sign in on the server with LinkedIn's verification code or app approval, or paste a session cookie.",
    ],
    shots: [
      { name: "linkedin-accounts", alt: "Three LinkedIn accounts, each with today's use against its limits for connections, messages, profile visits and withdrawals. One is on hold at its weekly invitation limit and one is on day 6 of a 21-day warm-up." },
    ],
  },
  {
    id: "mailboxes",
    eyebrow: "Mailboxes and deliverability",
    channel: "email",
    title: "Mailboxes that protect their own reputation.",
    body: "Connect Gmail with an app password, or any mailbox over SMTP and IMAP. A new mailbox starts on a low daily limit that rises each day, with warm-up running beside it.",
    points: [
      "A guard pauses a mailbox when its bounce or complaint rate over 30 days crosses the threshold you set.",
      "SPF, DKIM, DMARC and MX records are checked every day, and a change to one is written to the log.",
      "Inbox placement tests show where a test email landed.",
      "One do-not-contact list for email addresses, domains, LinkedIn profiles and phone numbers, checked before every step on both channels.",
    ],
    shots: [
      { name: "mailbox-domain", alt: "Four mailboxes on one sending domain with their daily limits, warm-up state, reputation and bounce rate. One has been paused automatically after its bounce rate rose." },
      { name: "domain-authentication", alt: "A sending domain scored 82 out of 100, with SPF, DKIM and MX passing and DMARC marked weak." },
    ],
  },
  {
    id: "inbox",
    nav: "Inbox",
    eyebrow: "Inbox",
    title: "Every reply in one place, already read.",
    body: "Email replies and LinkedIn replies arrive in the same inbox, one thread per contact. With an AI model connected, each reply is classified and summed up, and the contact's campaign is stopped or put back to match.",
    points: [
      "Five readings of a reply: positive, needs review, out of office, negative, unsubscribe. Each comes with a confidence figure.",
      "Answer by email or on LinkedIn from the same box.",
      "Assign, snooze, tag and close. A lock shows when a teammate is already replying.",
      "Saved replies, and a time by which each waiting conversation is due an answer.",
    ],
    shots: [
      { name: "inbox-thread", alt: "A conversation holding an email, a LinkedIn message and the contact's reply. The reply is classified as out of office with 77% confidence, and the next campaign step has been put back.", cut: true },
    ],
  },
  {
    id: "ai",
    eyebrow: "AI writing",
    title: "AI writing on your own key, with a ceiling.",
    body: "Linki writes through OpenRouter with a key you supply, in a style you describe once for the workspace. Each step can have its own model, instruction, length and language.",
    points: [
      "A default model, and a fallback that takes over when the first does not answer.",
      "A monthly budget. When it is reached, steps written by AI wait and everything else keeps sending.",
      "Spend shown by kind of step and by model.",
      "Try the wording on one of your contacts before anything goes out.",
    ],
    shots: [
      { name: "writing-style", alt: "The workspace's writing style: a tone, a written instruction, and example emails and LinkedIn messages for the AI to follow." },
      { name: "ai-budget", alt: "This month's AI spend, day by day, against a monthly budget of 100 dollars." },
    ],
  },
  {
    id: "audience",
    eyebrow: "Audience",
    title: "Contacts, lists and companies.",
    body: "Bring people in from a Sales Navigator list or a CSV file, add what Apollo knows about them, and verify email addresses before anything is sent.",
    points: [
      "One timeline per contact: every send, open, reply and list change, across both channels.",
      "Custom fields, tags and saved views.",
      "Each company is kept once and linked from its contacts.",
    ],
    shots: [
      { name: "contact-timeline", alt: "One contact's timeline: emails sent and opened, an enrichment from Apollo, and a reply on LinkedIn." },
    ],
  },
  {
    id: "reporting",
    nav: "Reporting",
    eyebrow: "Reporting",
    title: "Figures you can act on, and pass along.",
    body: "A campaign shows acceptance, replies, opens, clicks and completion against the period before, a funnel from enrolled to meeting booked, and how each version of an email is doing.",
    points: [
      "A leading version is called only when its lead is unlikely to be chance: at least 30 sends each, judged on replies before opens.",
      "Opens made by security scanners and mail privacy features are counted apart from people's.",
      "A read-only report link for someone with no account, which you can switch off at any time.",
      "Contacts, replies, prospects and campaign figures download as CSV.",
    ],
    shots: [
      { name: "ab-results", alt: "Four versions of one email with the number sent, open rate and reply rate for each. It is too early to call a winner: each version needs 30 sends." },
      { name: "funnel", alt: "A campaign's funnel from 22 contacts enrolled, through contacted, accepted or opened and replied, to 2 meetings booked." },
    ],
  },
  {
    id: "team",
    eyebrow: "Team",
    title: "Five roles, and a record of every change.",
    body: "Owner, admin, manager, member and viewer. The same roles hold in the app, the API and the MCP server.",
    points: [
      "Invite a teammate by email with a link that works once and expires after seven days.",
      "An audit log of changes made on the web, through the API and through MCP, kept for 12 months.",
      "Separate workspaces, each with its own contacts, mailboxes and accounts.",
    ],
    shots: [
      { name: "audit-log", alt: "The audit log: who paused a campaign, changed a role or connected an account, when, from which address, and whether through the web, the API or MCP." },
    ],
  },
  {
    id: "developers",
    nav: "Developers",
    eyebrow: "Developers",
    title: "An API, webhooks and an MCP server.",
    body: "Read contacts, campaigns and their progress over a versioned API, add contacts and signals from your own systems, receive signed webhooks, or let an AI client work in Linki through its MCP server.",
    points: [
      "API keys with scopes, an expiry date and their own rate limit. Only a hash of a key is stored.",
      "Webhooks signed with HMAC-SHA256 and tried up to eight times before they are set aside for you to look at.",
      "An MCP client signs in through the browser and then acts with your role in the workspace you chose.",
    ],
    shots: [
      { name: "webhooks", alt: "Four webhook endpoints with the events each receives, its success rate, last delivery and status." },
      { name: "mcp-server", alt: "The MCP server card: 79 tools, the command that adds Linki to a client, and the groups the tools fall into." },
    ],
    code: [
      { text: 'curl -H "Authorization: Bearer lnk_…" {origin}/api/v1/contacts', caption: "The public API" },
      { text: "claude mcp add --transport http linki {origin}/api/mcp", caption: "The MCP server" },
    ],
  },
];

export const SELF_HOSTED = {
  id: "self-hosted",
  eyebrow: "Your server",
  title: "One container, and your data stays where you put it.",
  body: "Linki is software you run yourself, with no database server or queue to set up beside it.",
  facts: [
    { title: "One process", detail: "The app, the API, the MCP server and the background work that sends and reads all run as a single container." },
    { title: "One database file", detail: "Everything is kept in a SQLite database on your own disk, so a backup is a copy of it." },
    { title: "Secrets locked away", detail: "Mailbox passwords, LinkedIn sessions and the keys for connected services are encrypted where they are stored. Of an API key, only a hash is kept." },
  ],
};

export const CLOSING = {
  title: "Open your workspace.",
  /** Shown to a visitor who is not signed in. Sign-in is the only way in that this page offers. */
  body: "Sign in to this Linki. If a teammate invited you, the link in their email takes you straight into their workspace.",
  signedIn: "You are signed in. Your workspace is one click away.",
};

/** The size a picture is drawn at, so the page keeps its place before it loads. */
export function shotSize(name: ShotName): { width: number; height: number } {
  return sizes[name];
}

export function shotSrc(name: ShotName): string {
  return `/welcome/${name}.png`;
}
