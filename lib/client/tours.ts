// The guided tours: what each one points at and says. Plain data, so it can be checked
// without a browser; components/shell/TourHost.tsx is what runs them.
//
// A tour is shown once by itself, the first time a member reaches its page on a screen
// wide enough for it, and can be started again from the Help menu. "welcome" is the tour
// of the frame around every page, and is the first anyone sees.

export interface TourStep {
  /** A CSS selector for what the step points at. Null: the step stands in the middle of the screen. */
  target: string | null;
  title: string;
  body: string;
  side?: "top" | "right" | "bottom" | "left";
}

export interface Tour {
  /** What the Help menu calls it. */
  name: string;
  steps: TourStep[];
}

const nav = (href: string) => `aside nav a[href="${href}"]`;
// Anchors every page has, set by the shell: its title, its buttons, its tabs, and its body.
const TITLE = '[data-tour="page-title"]';
const ACTIONS = '[data-tour="page-actions"]';
const TABS = '[data-tour="page-tabs"]';
const BODY = '[data-tour="page-body"]';

export const TOURS = {
  welcome: {
    name: "Getting around Linki",
    steps: [
      { target: null, title: "Welcome to Linki", body: "Linki runs outreach on LinkedIn and email from one place. Here is where everything lives. It takes under a minute, and you can leave at any point." },
      { target: '[data-tour="workspace"]', side: "right", title: "Your workspace", body: "Everything you see belongs to one workspace. If you are a member of several, switch between them here." },
      { target: '[data-tour="new-campaign"]', side: "right", title: "Start a campaign", body: "A campaign is a sequence of LinkedIn and email steps, run over a list of contacts. This walks you through building one." },
      { target: '[data-tour="search"]', side: "right", title: "Search and jump", body: "Find a contact, a company, a campaign or a list, or jump to any page. Press ⌘K (Ctrl K on Windows) from anywhere." },
      { target: '[data-tour="nav-workspace"]', side: "right", title: "Your day", body: "The dashboard, the inbox where every reply lands, and your tasks." },
      { target: '[data-tour="nav-outreach"]', side: "right", title: "Outreach", body: "Campaigns, the message templates they draw on, and signals worth acting on." },
      { target: '[data-tour="nav-audience"]', side: "right", title: "Audience", body: "The people and companies you contact, and the lists you gather them into." },
      { target: '[data-tour="nav-channels"]', side: "right", title: "Channels", body: "The LinkedIn accounts and mailboxes campaigns send from, with their limits, and how well your email is being delivered." },
      { target: '[data-tour="nav-configure"]', side: "right", title: "Configure", body: "AI writing and its budget, integrations, your team and their roles, and the API." },
      { target: '[data-tour="health"]', side: "right", title: "Is it running?", body: "Sending and reading replies happen in the background, at a human pace. This says whether that work is going on." },
      { target: '[data-tour="help"]', side: "bottom", title: "Help is here", body: "Each page has a short tour of its own. Start it, or this one, again from this menu whenever you like." },
    ],
  },
  dashboard: {
    name: "Dashboard",
    steps: [
      { target: '[data-tour="dashboard-filters"]', side: "bottom", title: "Choose what to look at", body: "The last 7, 30 or 90 days, and optionally one campaign, one list or one member's campaigns. The choice is kept in the address, so a view can be shared as a link." },
      { target: '[data-tour="dashboard-kpis"]', side: "bottom", title: "The period at a glance", body: "Each figure is set beside the period before. A reply is counted for the message it answers, so a week is not credited with answers to older mail." },
      { target: '[data-tour="dashboard-funnel"]', side: "top", title: "How far contacts get", body: "Added up over the campaigns that are running. Switch it to LinkedIn or email alone with the button at its corner." },
      { target: '[data-tour="dashboard-alerts"]', side: "left", title: "What needs you", body: "A mailbox that paused itself, an account that signed out, a limit about to be reached. Each has a button to the screen that deals with it, and goes away by itself once it is dealt with." },
      { target: '[data-tour="dashboard-today"]', side: "left", title: "Today against your limits", body: "What has gone out today, set against what your senders are allowed to send." },
    ],
  },
  campaigns: {
    name: "Campaigns",
    steps: [
      { target: TITLE, side: "bottom", title: "Every campaign", body: "With where each stands and what has come of it: who is enrolled, how many replied, how many accepted." },
      { target: ACTIONS, side: "bottom", title: "Start one, or take the list away", body: "New campaign opens the setup: the list, the brief for the AI writer, the steps, the senders, and a check before launch." },
      { target: BODY, side: "top", title: "Find and act", body: "Filter by status, channel or owner. Tick several to pause, resume, duplicate or archive them together. A draft opens its setup; anything else opens its own pages." },
    ],
  },
  campaign: {
    name: "A campaign",
    steps: [
      { target: TABS, side: "bottom", title: "Four views of one campaign", body: "Overview for results, Sequence for the steps, Prospects for the people in it, Settings for who it sends from and what it tracks." },
      { target: '[data-tour="campaign-period"]', side: "bottom", title: "Period and channel", body: "The rates and the chart are for what was sent in the period. The funnel and the A/B results are for the whole campaign." },
      { target: ACTIONS, side: "bottom", title: "Share, export, add people", body: "Share report makes a link for someone with no account. Add prospects enrols more contacts in a campaign that is already running." },
    ],
  },
  sequence: {
    name: "Sequence builder",
    steps: [
      { target: BODY, side: "top", title: "Two tracks, side by side", body: "LinkedIn steps and email steps each run in their own order. A condition can hand a contact from one track to the other, or stop there." },
      { target: ACTIONS, side: "bottom", title: "Nothing changes until you publish", body: "Edits are kept as a draft. Publishing puts them live; contacts part-way through stay on the step they were on." },
    ],
  },
  inbox: {
    name: "Inbox",
    steps: [
      { target: nav("/inbox"), side: "right", title: "Every reply, both channels", body: "Email and LinkedIn conversations land here together. The number is the conversations waiting on you." },
      { target: BODY, side: "top", title: "Triage, read, answer", body: "Filters on the left, conversations in the middle, the thread on the right with what the reply seems to want and a suggested next step." },
    ],
  },
  contacts: {
    name: "Contacts",
    steps: [
      { target: TITLE, side: "bottom", title: "Everyone you might contact", body: "With how interested they seem, who owns them, the lists and campaigns they are in, and when they last heard from you." },
      { target: BODY, side: "top", title: "Filter, save, act on many", body: "Filter by campaign, intent, owner or tag and keep a filter as a saved view. Tick several to add them to a campaign, tag them or export them." },
    ],
  },
  lists: {
    name: "Lists",
    steps: [
      { target: TITLE, side: "bottom", title: "Lists gather contacts", body: "A campaign runs over a list. Fill one from a CSV file or a Sales Navigator search, or by hand." },
      { target: ACTIONS, side: "bottom", title: "Bring people in", body: "Create a list, then import into it. Duplicates are matched before anything is added." },
    ],
  },
  companies: {
    name: "Companies",
    steps: [
      { target: TITLE, side: "bottom", title: "Where your contacts work", body: "Every company you have a contact at, with how interested it seems, how many people you know there, and whether email to its domain is bouncing." },
      { target: BODY, side: "top", title: "The list, and the company beside it", body: "Pick a company to read what is known about it, the people you have there, people worth adding, and the signals about it. Mark it a target account to keep it in view." },
      { target: ACTIONS, side: "bottom", title: "Add, import, look up", body: "Looking companies up on Apollo fills in funding, headcount and tools. It spends Apollo credits, so the cost is shown first and nothing is spent until you agree." },
    ],
  },
  pipeline: {
    name: "Pipeline",
    steps: [
      { target: TITLE, side: "bottom", title: "From reply to deal", body: "Opportunities by stage, with the tasks, meetings and activity that go with them. Each of those also has a view of its own, chosen beside the title." },
      { target: BODY, side: "top", title: "Move a card as it progresses", body: "Drag an opportunity to its next stage, or open it to change the amount, the owner or the close date. Won and lost are stages too." },
      { target: ACTIONS, side: "bottom", title: "Whose, and a new one", body: "Show everyone's or one member's. A positive reply can open an opportunity by itself; that is a setting under Edit stages." },
    ],
  },
  linkedin: {
    name: "LinkedIn accounts",
    steps: [
      { target: TITLE, side: "bottom", title: "The accounts campaigns act from", body: "Each has its own daily limits, working hours and weekly invitation limit, and warms up gradually when it is new." },
      { target: ACTIONS, side: "bottom", title: "Connect an account", body: "Sign in through Linki or with a session cookie. Nothing runs on LinkedIn until an account is signed in." },
      { target: BODY, side: "top", title: "Limits you can see", body: "Today's use against each limit. An account that reaches its weekly invitations waits by itself; the others carry on." },
    ],
  },
  mailboxes: {
    name: "Mailboxes",
    steps: [
      { target: TITLE, side: "bottom", title: "The mailboxes campaigns send from", body: "Grouped by sending domain, with each domain's SPF, DKIM and DMARC at a glance." },
      { target: BODY, side: "top", title: "Each one looks after itself", body: "A daily limit that ramps up, warm-up, and a guard that pauses the mailbox if bounces or complaints climb. Open one to test it or change how it sends." },
    ],
  },
  deliverability: {
    name: "Deliverability",
    steps: [
      { target: TITLE, side: "bottom", title: "Is your email arriving?", body: "Per sending domain: its health, its DNS records with what to fix, what the guards have done, and who must not be contacted." },
      { target: BODY, side: "top", title: "Check before it costs you", body: "Run a placement test to see where mail from each mailbox lands, and re-check DNS after changing a record." },
    ],
  },
  ai: {
    name: "AI & models",
    steps: [
      { target: TITLE, side: "bottom", title: "How Linki writes", body: "The model, a fallback for when it is unavailable, your tone and examples, and what each campaign's steps ask for." },
      { target: BODY, side: "top", title: "Spend with a ceiling", body: "Set a monthly budget. When it is reached, AI-written steps wait rather than fail, and you are told." },
    ],
  },
  templates: {
    name: "Templates",
    steps: [
      { target: TITLE, side: "bottom", title: "Messages worth reusing", body: "A library by channel and category. A step in a sequence can draw on one template, or rotate through several." },
      { target: BODY, side: "top", title: "See what earns replies", body: "Each template shows how often it has been used and how many of those sends were answered." },
    ],
  },
  signals: {
    name: "Signals",
    steps: [
      { target: TITLE, side: "bottom", title: "Reasons to reach out", body: "A hire, a funding round, a change of tools: things that happened at an account you care about." },
      { target: TABS, side: "bottom", title: "The feed, the rules, and detection", body: "Rules decide what a signal does, such as enrolling the contact in a campaign. Detection looks for new ones on a schedule, within a monthly cap you set." },
    ],
  },
  csv_import: {
    name: "CSV import",
    steps: [
      { target: BODY, side: "top", title: "Four steps, and you can leave", body: "Upload the file, match its columns to fields, decide what to do with people you already have, then check before anything is added. An import you leave can be picked up again." },
    ],
  },
  team: {
    name: "Team & roles",
    steps: [
      { target: TITLE, side: "bottom", title: "Who can do what", body: "Invite people and give each a role, from viewer to owner. Every change is written to the audit log below." },
    ],
  },
  developers: {
    name: "Developer API",
    steps: [
      { target: TITLE, side: "bottom", title: "Linki from your own tools", body: "API keys with their own rate limits, webhooks with a delivery log, and the address an AI client connects to over MCP." },
    ],
  },
} satisfies Record<string, Tour>;

export type TourId = keyof typeof TOURS;
export const TOUR_IDS = Object.keys(TOURS) as TourId[];
export const isTourId = (value: unknown): value is TourId => typeof value === "string" && value in TOURS;

/** The tour of the page at this address (a Next.js pathname such as "/campaigns/[id]"), if it has one. */
export function tourFor(pathname: string): Exclude<TourId, "welcome"> | null {
  switch (pathname) {
    case "/": return "dashboard";
    case "/campaigns": return "campaigns";
    case "/campaigns/[id]": return "campaign";
    case "/campaigns/[id]/sequence": return "sequence";
    case "/inbox": return "inbox";
    case "/contacts": return "contacts";
    case "/lists": return "lists";
    case "/lists/import/[id]": return "csv_import";
    case "/templates": return "templates";
    case "/signals": return "signals";
    case "/companies/[[...id]]": return "companies";
    case "/pipeline": return "pipeline";
    case "/linkedin-accounts": return "linkedin";
    case "/mailboxes": return "mailboxes";
    case "/deliverability": return "deliverability";
    case "/ai": return "ai";
    case "/team": return "team";
    case "/developers": return "developers";
    default: return null;
  }
}

/**
 * What a tour is filed under once seen. The tours written for the old navigation used
 * bare page names ("dashboard"); these are told apart from them, so that someone who saw
 * the old ones is shown the new ones once.
 */
export const seenKey = (id: TourId) => `v2.${id}`;

/** Which tour to start by itself on reaching a page: the welcome first, then the page's own. Null when both have been seen. */
export function tourToShow(pathname: string, seen: ReadonlySet<string>): TourId | null {
  if (!seen.has(seenKey("welcome"))) return "welcome";
  const own = tourFor(pathname);
  return own && !seen.has(seenKey(own)) ? own : null;
}

/** Tours are for a screen with the sidebar on it: below this width the steps would point at things that are not there. */
export const TOUR_MIN_WIDTH = 1024;
