/**
 * Readers for LinkedIn's pages.
 *
 * Everything the automation needs to know about a page is read by ONE function,
 * {@link readLinkedinPage}, which runs inside the page through `page.evaluate` and returns
 * plain data. The Playwright code then only navigates, clicks, and decides on that data.
 *
 * Why it is shaped this way:
 *
 *  - LinkedIn's profile page ships obfuscated, per-build class names (`fmbk8d fmbk8c …`),
 *    so nothing here selects on a class there. It anchors on what is stable: ARIA roles,
 *    hrefs (`/preload/custom-invite/`, `/messaging/compose/`), and the `componentkey`
 *    attributes LinkedIn's own renderer keys components by.
 *  - The page pre-renders HIDDEN duplicates of its controls and of the degree badge — a
 *    profile with a pending invite carries an invisible "· 1st" next to the visible
 *    "· 2nd". Every reader therefore considers visible elements only; reading text
 *    without that check reports people as connected who are not.
 *  - Keeping the reading in one data-returning function means the exact code that runs in
 *    production can be exercised against saved markup in a unit test, with no browser.
 *
 * `readLinkedinPage` is serialised and shipped to the browser, so it must stay
 * self-contained: no imports, no references to anything outside its own body.
 *
 * Markup verified against live LinkedIn on 2026-10-09 (profile, invitation dialog,
 * message thread). Messaging is still LinkedIn's older, class-named app, so the thread
 * reader does use its `msg-*` classes.
 */
import type { Page } from "playwright";

export type Relation = "connected" | "pending" | "connectable" | "unknown";

export interface ProfileCard {
  /** False when the profile's top card is not on the page (not loaded, or not a profile). */
  found: boolean;
  reason: string | null;
  name: string | null;
  /** LinkedIn's opaque member id for this profile (`ACoAA…`), from the top card itself. */
  profileId: string | null;
  degree: 1 | 2 | 3 | null;
  /** `unknown` means the top card shows neither Connect nor Pending — look in the More menu. */
  relation: Relation;
  /** LinkedIn's own invitation link for this member, when Connect is a visible action. */
  inviteHref: string | null;
  /** LinkedIn's own compose link for this member (carries the member's profile URN). */
  messageHref: string | null;
  hasMoreMenu: boolean;
}

export interface ProfileMenu {
  open: boolean;
  relation: Relation;
  inviteHref: string | null;
  items: string[];
}

export interface InviteDialog {
  open: boolean;
  text: string;
  canSendWithoutNote: boolean;
  canAddNote: boolean;
  /** The note textarea is showing (after "Add a note"). */
  noteFieldOpen: boolean;
  noteSendEnabled: boolean;
  /** "N personalized invitations remaining for this month" — null when LinkedIn shows no quota. */
  notesRemaining: number | null;
  /** Character limit shown next to the note field (200 on a free account, 300 on Premium). */
  noteLimit: number | null;
  weeklyLimitReached: boolean;
  /** LinkedIn is asking for the member's email address before it will send the invitation. */
  emailRequired: boolean;
}

export interface MessageThread {
  /** A message box is on the page. */
  ready: boolean;
  /** Member id (`ACoAA…`) the open conversation's header links to; null in a new conversation. */
  participantId: string | null;
  /** Text of the conversation pane (header, recipients) — NOT the message history. */
  paneText: string;
  messageCount: number;
  /** Messages in this conversation written by the other person. */
  inboundCount: number;
  lastMessageInbound: boolean;
  lastMessageText: string;
  draft: string;
  sendEnabled: boolean;
}

export interface PageAlerts {
  weeklyLimitReached: boolean;
  /** Text of a visible error toast, or null. */
  error: string | null;
}

export interface AccountStats {
  /** "1,204 connections" on the connections page. */
  connections: number | null;
  /** "People (37)" on the sent-invitations page. */
  pendingInvitations: number | null;
  /** "45 / Profile viewers in the past 90 days" on the profile-views page. */
  profileViews: number | null;
}

type ReadRequest = {
  kind: "profile" | "menu" | "invite" | "thread" | "alerts" | "stats";
  /** Use rendered size to judge visibility. False only in unit tests, where there is no layout. */
  layout: boolean;
};

/* eslint-disable no-var -- runs in the page; deliberately plain so no build step can inject a helper */
export function readLinkedinPage(request: ReadRequest): unknown {
  var layout = request.layout !== false;

  function isVisible(el: Element): boolean {
    if (layout) {
      var rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      return getComputedStyle(el).visibility !== "hidden";
    }
    for (var node: Element | null = el; node; node = node.parentElement) {
      var style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || node.hasAttribute("hidden")) return false;
    }
    return true;
  }
  // innerText is what a person reads (it leaves out hidden descendants and separates
  // blocks); it does not exist without layout, where textContent stands in. The two differ
  // in the whitespace BETWEEN elements, so no pattern below may depend on that whitespace.
  function text(el: Element | null): string {
    if (!el) return "";
    var rendered = layout ? (el as HTMLElement).innerText : undefined;
    return (typeof rendered === "string" ? rendered : el.textContent || "").replace(/\s+/g, " ").trim();
  }
  function visibleAll(root: ParentNode, selector: string): Element[] {
    var out: Element[] = [];
    var found = root.querySelectorAll(selector);
    for (var i = 0; i < found.length; i++) if (isVisible(found[i])) out.push(found[i]);
    return out;
  }
  function key(el: Element): string {
    return el.getAttribute("componentkey") || "";
  }
  function isDisabled(el: Element): boolean {
    return (el as HTMLButtonElement).disabled === true || el.getAttribute("aria-disabled") === "true";
  }
  function firstNumber(source: string, pattern: RegExp): number | null {
    var match = source.match(pattern);
    if (!match) return null;
    var value = parseInt(match[1].replace(/[^0-9]/g, ""), 10);
    return isNaN(value) ? null : value;
  }
  /** Classify one Connect control by LinkedIn's own state key, falling back to its label. */
  function connectState(el: Element): Relation | null {
    var k = key(el);
    if (k.indexOf("ConnectButtonstate") === 0) {
      if (/_pending$/.test(k)) return "pending";
      if (/_connect$/.test(k)) return "connectable";
    }
    var label = (el.getAttribute("aria-label") || "") + " " + text(el);
    if (/^\s*Pending\b/i.test(label) || /withdraw invitation/i.test(label)) return "pending";
    if ((el.getAttribute("href") || "").indexOf("/preload/custom-invite/") !== -1) return "connectable";
    return null;
  }

  // ── profile top card ───────────────────────────────────────────────────────
  if (request.kind === "profile") {
    var card: ProfileCard = {
      found: false, reason: null, name: null, profileId: null, degree: null,
      relation: "unknown", inviteHref: null, messageHref: null, hasMoreMenu: false,
    };
    var main = document.querySelector("main");
    if (!main) { card.reason = "no-main"; return card; }

    var root: Element | null = document.querySelector('[componentkey*="profile.card"][componentkey$="Topcard"]');
    if (root) {
      var idMatch = key(root).match(/profile\.card\.ref(.+)Topcard$/);
      if (idMatch) card.profileId = idMatch[1];
    } else {
      // Layout without the component key: the top card is the section holding the first heading.
      var headings = visibleAll(main, "h1, h2");
      root = headings.length ? headings[0].closest("section") : null;
    }
    if (!root) { card.reason = "no-top-card"; return card; }

    var nameEl = visibleAll(root, "h1, h2")[0];
    if (!nameEl) { card.reason = "no-name"; return card; }
    card.found = true;
    card.name = text(nameEl);

    var badges = visibleAll(root, "span, p");
    for (var b = 0; b < badges.length; b++) {
      var badge = text(badges[b]).match(/^·?\s*(1st|2nd|3rd\+?)$/);
      if (badge) { card.degree = badge[1] === "1st" ? 1 : badge[1] === "2nd" ? 2 : 3; break; }
    }

    var controls = visibleAll(root, "a, button, [role='button']");
    var pending = false;
    for (var c = 0; c < controls.length; c++) {
      var control = controls[c];
      var href = control.getAttribute("href") || "";
      var state = connectState(control);
      if (state === "pending") pending = true;
      if (state === "connectable" && href && !card.inviteHref) card.inviteHref = href;
      if (!card.messageHref && href.indexOf("/messaging/compose/") !== -1 && href.indexOf("profileUrn=") !== -1) card.messageHref = href;
      if (control.tagName === "BUTTON" && (text(control) === "More" || control.getAttribute("aria-label") === "More")) card.hasMoreMenu = true;
    }

    if (card.degree === 1) card.relation = "connected";
    else if (pending) card.relation = "pending";
    else if (card.inviteHref) card.relation = "connectable";
    return card;
  }

  // ── the profile's More menu (must already be open) ─────────────────────────
  if (request.kind === "menu") {
    var menu: ProfileMenu = { open: false, relation: "unknown", inviteHref: null, items: [] };
    var menus = visibleAll(document, '[role="menu"]');
    if (!menus.length) return menu;
    menu.open = true;
    var entries = visibleAll(menus[menus.length - 1], '[role="menuitem"]');
    var connected = false, menuPending = false;
    for (var m = 0; m < entries.length; m++) {
      var entry = entries[m];
      var label = text(entry);
      menu.items.push(label);
      var entryState = connectState(entry);
      if (entryState === "pending") menuPending = true;
      if ((entryState === "connectable" || /^Connect$/i.test(label)) && !menu.inviteHref) menu.inviteHref = entry.getAttribute("href");
      if (/^Remove connection$/i.test(label)) connected = true;
    }
    if (connected) menu.relation = "connected";
    else if (menuPending) menu.relation = "pending";
    else if (menu.inviteHref) menu.relation = "connectable";
    return menu;
  }

  // ── invitation dialog ──────────────────────────────────────────────────────
  if (request.kind === "invite") {
    var invite: InviteDialog = {
      open: false, text: "", canSendWithoutNote: false, canAddNote: false, noteFieldOpen: false,
      noteSendEnabled: false, notesRemaining: null, noteLimit: null, weeklyLimitReached: false, emailRequired: false,
    };
    var dialogs = visibleAll(document, '[role="dialog"], [role="alertdialog"]');
    if (!dialogs.length) return invite;
    invite.open = true;
    var allText = "";
    for (var d = 0; d < dialogs.length; d++) {
      var dialog = dialogs[d];
      allText += " " + text(dialog);
      var sendPlain = visibleAll(dialog, 'button[aria-label="Send without a note"]')[0];
      if (sendPlain && !isDisabled(sendPlain)) invite.canSendWithoutNote = true;
      var addNote = visibleAll(dialog, 'button[aria-label="Add a note"]')[0];
      if (addNote && !isDisabled(addNote)) invite.canAddNote = true;
      if (visibleAll(dialog, 'textarea#custom-message, textarea[name="message"]').length) invite.noteFieldOpen = true;
      var sendNote = visibleAll(dialog, 'button[aria-label="Send invitation"]')[0];
      if (sendNote && !isDisabled(sendNote)) invite.noteSendEnabled = true;
      if (visibleAll(dialog, 'input[type="email"]').length) invite.emailRequired = true;
    }
    invite.text = allText.trim().slice(0, 400);
    invite.notesRemaining = firstNumber(allText, /(\d+)\s+personalized invitations?\s+remaining/i);
    invite.noteLimit = firstNumber(allText, /\d+\s*\/\s*(\d{2,4})(?!\d)/);
    invite.weeklyLimitReached = /weekly (invitation )?limit|reached the weekly/i.test(allText)
      || document.querySelector('[class*="ip-fuse-limit-alert"]') !== null;
    return invite;
  }

  // ── message thread / compose pane ──────────────────────────────────────────
  if (request.kind === "thread") {
    var thread: MessageThread = {
      ready: false, participantId: null, paneText: "", messageCount: 0, inboundCount: 0,
      lastMessageInbound: false, lastMessageText: "", draft: "", sendEnabled: false,
    };
    var box = visibleAll(document, 'div.msg-form__contenteditable, [role="textbox"][contenteditable="true"]')[0];
    if (!box) return thread;
    thread.ready = true;
    thread.draft = text(box);

    // The pane is the largest ancestor of the message box that excludes the conversation
    // list, so recipient checks never read a name out of some other conversation's row.
    var pane: Element = box;
    while (pane.parentElement && pane.parentElement !== document.body
      && !pane.parentElement.querySelector(".msg-conversations-container, li.msg-conversation-listitem")) {
      pane = pane.parentElement;
    }

    var profileLink = visibleAll(pane, "a.msg-thread__link-to-profile, .msg-overlay-bubble-header a[href*='/in/'], .msg-title-bar a[href*='/in/']")[0];
    if (profileLink) {
      var linkMatch = (profileLink.getAttribute("href") || "").match(/\/in\/([^/?#]+)/);
      if (linkMatch) thread.participantId = linkMatch[1];
    }

    var events = pane.querySelectorAll(".msg-s-event-listitem");
    thread.messageCount = events.length;
    for (var e = 0; e < events.length; e++) {
      if (/msg-s-event-listitem--other/.test(String(events[e].className))) thread.inboundCount++;
    }
    if (events.length) {
      var last = events[events.length - 1];
      thread.lastMessageInbound = /msg-s-event-listitem--other/.test(String(last.className));
      thread.lastMessageText = text(last.querySelector(".msg-s-event-listitem__body") || last);
    }

    // Header and recipients only: clone the pane and drop the history and the draft from it.
    var copy = pane.cloneNode(true) as Element;
    var drop = copy.querySelectorAll(".msg-s-message-list, .msg-s-message-list-container, .msg-form__contenteditable, [contenteditable='true']");
    for (var x = 0; x < drop.length; x++) { var parent = drop[x].parentNode; if (parent) parent.removeChild(drop[x]); }
    thread.paneText = text(copy).slice(0, 600);

    var send = visibleAll(pane, "button.msg-form__send-button, form button[type='submit']")[0];
    thread.sendEnabled = !!send && !isDisabled(send);
    return thread;
  }

  // ── limit dialogs and error toasts after an action ─────────────────────────
  if (request.kind === "alerts") {
    var alerts: PageAlerts = { weeklyLimitReached: false, error: null };
    var open = visibleAll(document, '[role="dialog"], [role="alertdialog"]');
    var dialogText = "";
    for (var o = 0; o < open.length; o++) dialogText += " " + text(open[o]);
    alerts.weeklyLimitReached = /weekly (invitation )?limit|reached the weekly/i.test(dialogText)
      || document.querySelector('[class*="ip-fuse-limit-alert"]') !== null;
    var toast = visibleAll(document, '[data-test-artdeco-toast-item-type="error"], .artdeco-toast-item--error')[0];
    if (toast) alerts.error = text(toast).slice(0, 200);
    return alerts;
  }

  // ── account numbers (connections / sent invitations / profile views) ───────
  var stats: AccountStats = { connections: null, pendingInvitations: null, profileViews: null };
  var scope = document.querySelector("main") || document.body;
  // innerText keeps line breaks, which the profile-views figure is laid out with.
  var pageText = (scope as HTMLElement).innerText || scope.textContent || "";
  stats.connections = firstNumber(pageText, /([\d.,]+)\s+connections?/i);
  stats.pendingInvitations = firstNumber(pageText, /People\s*\(([\d.,]+)\)/i);
  stats.profileViews = firstNumber(pageText, /([\d.,]+)\s*Profile viewers/i);
  return stats;
}
/* eslint-enable no-var */

// ─── typed wrappers ───────────────────────────────────────────────────────────

const read = <T>(page: Page, kind: ReadRequest["kind"]) =>
  page.evaluate(readLinkedinPage, { kind, layout: true }) as Promise<T>;

export const readProfileCard = (page: Page) => read<ProfileCard>(page, "profile");
export const readProfileMenu = (page: Page) => read<ProfileMenu>(page, "menu");
export const readInviteDialog = (page: Page) => read<InviteDialog>(page, "invite");
export const readMessageThread = (page: Page) => read<MessageThread>(page, "thread");
export const readPageAlerts = (page: Page) => read<PageAlerts>(page, "alerts");
export const readAccountStats = (page: Page) => read<AccountStats>(page, "stats");

/**
 * Poll a reader until `done` accepts its result, returning the last reading either way.
 * LinkedIn renders these surfaces after `domcontentloaded`, at no fixed delay, so a fixed
 * sleep either wastes time or reads a half-built page.
 */
export async function pollUntil<T>(
  page: Page,
  readOnce: (page: Page) => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs: number,
  intervalMs = 400,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await readOnce(page);
  while (!done(value) && Date.now() < deadline) {
    await page.waitForTimeout(intervalMs);
    value = await readOnce(page);
  }
  return value;
}

/** The profile's top card once its action row has rendered. A top card without a
 *  Connect/Pending/1st state and without a More button is still loading. */
export function waitForProfileCard(page: Page, timeoutMs = 15_000): Promise<ProfileCard> {
  return pollUntil(page, readProfileCard, (c) => c.found && (c.relation !== "unknown" || c.hasMoreMenu), timeoutMs);
}

/** Top-card container, for clicking controls inside it. */
export const TOP_CARD = '[componentkey*="profile.card"][componentkey$="Topcard"]';
