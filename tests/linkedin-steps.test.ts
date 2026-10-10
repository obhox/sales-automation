// The connect, withdraw and message steps, driven against a scripted stand-in for the browser page.
//
// What LinkedIn renders is covered by linkedin-dom.test.ts. This file covers what the steps
// DO with it: which pages they open, what they click, and — above all — what they refuse
// to do. Nothing here launches a browser; `page.evaluate` is answered from the script.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "playwright";
import {
  AlreadyConnectedError,
  ConnectUnavailableError,
  InviteBlockedError,
  PendingInviteError,
  WeeklyLimitError,
  sendConnectionRequest,
} from "@/lib/linkedin/connect";
import {
  MessageUnconfirmedError,
  NotConnectedError,
  RecipientMismatchError,
  RecipientRepliedError,
  sendMessage,
} from "@/lib/linkedin/message";
import { NoPendingInviteError, WithdrawUnconfirmedError, withdrawInvitation } from "@/lib/linkedin/withdraw";
import { SessionExpiredError } from "@/lib/linkedin/navigation";
import type { InviteDialog, MessageThread, PageAlerts, ProfileCard, ProfileMenu, WithdrawDialog } from "@/lib/linkedin/dom";

const PROFILE_ID = "ACoAAAexampleMemberId00000";
const PROFILE_URL = "https://www.linkedin.com/in/jordan-reyes/";
const INVITE_HREF = "/preload/custom-invite/?vanityName=jordan-reyes";
const INVITE_URL = `https://www.linkedin.com${INVITE_HREF}`;
const MESSAGE_HREF = `/messaging/compose/?profileUrn=urn%3Ali%3Afsd_profile%3A${PROFILE_ID}&recipient=${PROFILE_ID}&screenContext=NON_SELF_PROFILE_VIEW&interop=msgOverlay`;

const card = (over: Partial<ProfileCard> = {}): ProfileCard => ({
  found: true, reason: null, name: "Jordan Reyes", profileId: PROFILE_ID, degree: 3,
  relation: "unknown", inviteHref: null, pendingFor: null, inviteBlocked: false, messageHref: MESSAGE_HREF, hasMoreMenu: true, ...over,
});
const dialog = (over: Partial<InviteDialog> = {}): InviteDialog => ({
  open: true, text: "Add a note to your invitation?", canSendWithoutNote: true, canAddNote: true,
  noteFieldOpen: false, noteSendEnabled: false, notesRemaining: null, noteLimit: null,
  weeklyLimitReached: false, emailRequired: false, ...over,
});
const confirmation = (over: Partial<WithdrawDialog> = {}): WithdrawDialog => ({
  open: true, text: "Withdraw invitation If you withdraw now, you won’t be able to resend to this person for up to 3 weeks.",
  canWithdraw: true, recipient: "Jordan Reyes", ...over,
});
const NO_CONFIRMATION: WithdrawDialog = { open: false, text: "", canWithdraw: false, recipient: null };
const thread = (over: Partial<MessageThread> = {}): MessageThread => ({
  ready: true, participantId: PROFILE_ID, paneText: "Jordan Reyes", messageCount: 0, inboundCount: 0,
  lastMessageInbound: false, lastMessageText: "", draft: "", sendEnabled: false, ...over,
});

/** What the scripted LinkedIn looks like, and how it reacts. Tests override the pieces they need. */
interface World {
  profile: ProfileCard;
  menu: ProfileMenu;
  dialog: InviteDialog;
  withdraw: WithdrawDialog;
  thread: MessageThread;
  alerts: PageAlerts;
  /** Where a navigation actually lands (defaults to the URL asked for). */
  landOn?: (url: string) => string;
  onClick?: (what: string) => void;
  onFill?: (what: string, value: string) => void;
  onKey?: (key: string) => void;
  onInsert?: (text: string) => void;
  onType?: (text: string) => void;
}

function scripted(world: World) {
  const log = { gotos: [] as string[], clicks: [] as string[], keys: [] as string[], inserted: [] as string[], typed: [] as string[] };
  let current = "about:blank";

  const locator = (what: string) => ({
    locator: (inner: string) => locator(`${what} >> ${inner}`),
    filter: (o: { hasText?: RegExp }) => locator(`${what} [text ${o.hasText}]`),
    or: (other: { what: string }) => locator(`${what} | ${other.what}`),
    and: (other: { what: string }) => locator(`${what} & ${other.what}`),
    first() { return this; },
    what,
    count: async () => 1,
    click: async () => { log.clicks.push(what); world.onClick?.(what); },
    fill: async (value: string) => { world.onFill?.(what, value); },
  });

  const page = {
    url: () => current,
    goto: async (url: string) => { log.gotos.push(url); current = world.landOn?.(url) ?? url; },
    reload: async () => {},
    // Polling is deadline-based; advancing the fake clock here is what lets it finish.
    waitForTimeout: async (ms: number) => { vi.advanceTimersByTime(ms); },
    evaluate: async (_fn: unknown, request: { kind: string }) => {
      switch (request.kind) {
        case "profile": return world.profile;
        case "menu": return world.menu;
        case "invite": return world.dialog;
        case "withdraw": return world.withdraw;
        case "thread": return world.thread;
        case "alerts": return world.alerts;
        default: throw new Error(`unscripted read: ${request.kind}`);
      }
    },
    locator,
    keyboard: {
      press: async (key: string) => { log.keys.push(key); world.onKey?.(key); },
      insertText: async (text: string) => { log.inserted.push(text); world.onInsert?.(text); },
      type: async (text: string) => { log.typed.push(text); world.onType?.(text); },
    },
  };
  return { page: page as unknown as Page, log };
}

const base = (): World => ({
  profile: card(),
  menu: { open: false, relation: "unknown", inviteHref: null, items: [] },
  dialog: dialog(),
  withdraw: NO_CONFIRMATION,
  thread: thread(),
  alerts: { weeklyLimitReached: false, error: null, notices: [] },
});

const clicked = (log: { clicks: string[] }, label: string) => log.clicks.some((c) => c.includes(label));

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

// ─────────────────────────────────────────────────────────────────────────────
describe("sending a connection request", () => {
  /** LinkedIn accepting the click: the profile reads Pending from then on. */
  const acceptsSend = (world: World, button = "Send without a note") => {
    world.onClick = (what) => { if (what.includes(button)) world.profile = card({ relation: "pending" }); };
  };

  it("follows LinkedIn's own invitation link when Connect is the main action", async () => {
    const world = base();
    world.profile = card({ degree: 2, relation: "connectable", inviteHref: INVITE_HREF });
    acceptsSend(world);
    const { page, log } = scripted(world);

    await expect(sendConnectionRequest(page, PROFILE_URL)).resolves.toEqual({ noteSent: false, noteSkipped: null });
    expect(log.gotos).toEqual([PROFILE_URL, INVITE_URL]);
    expect(clicked(log, "Send without a note")).toBe(true);
    expect(clicked(log, "More")).toBe(false);
  });

  it("finds Connect inside the More menu — the case that failed on every such profile", async () => {
    const world = base(); // top card: Message / Follow / More, no Connect
    world.onClick = (what) => {
      if (what.includes("More")) world.menu = { open: true, relation: "connectable", inviteHref: INVITE_HREF, items: ["Save to PDF", "Connect"] };
      if (what.includes("Send without a note")) world.profile = card({ relation: "pending" });
    };
    const { page, log } = scripted(world);

    await sendConnectionRequest(page, PROFILE_URL);
    expect(log.gotos).toEqual([PROFILE_URL, INVITE_URL]);
    expect(log.keys).toContain("Escape"); // the menu is closed again before navigating
  });

  it("navigates to the canonical profile whatever shape the stored URL has", async () => {
    const world = base();
    world.profile = card({ relation: "connectable", inviteHref: INVITE_HREF });
    acceptsSend(world);
    const { page, log } = scripted(world);

    await sendConnectionRequest(page, "http://linkedin.com/in/jordan-reyes?trk=x");
    expect(log.gotos[0]).toBe(PROFILE_URL);
  });

  it("does not report success when LinkedIn never shows the invitation as pending", async () => {
    // The old step returned normally here, so the runner logged "Connection request sent",
    // stamped the contact and spent a daily slot on a request that never left.
    const world = base();
    world.profile = card({ relation: "connectable", inviteHref: INVITE_HREF }); // and stays that way
    const { page, log } = scripted(world);

    await expect(sendConnectionRequest(page, PROFILE_URL)).rejects.toThrow(/did not confirm the invitation/);
    expect(log.gotos).toEqual([PROFILE_URL, INVITE_URL, PROFILE_URL]); // it looked again on a fresh load first
  });

  it("confirms a pending invitation that only shows inside the More menu", async () => {
    const world = base();
    let sent = false;
    world.onClick = (what) => {
      if (what.includes("Send without a note")) sent = true;
      if (what.includes("More")) {
        world.menu = sent
          ? { open: true, relation: "pending", inviteHref: null, items: ["Pending"] }
          : { open: true, relation: "connectable", inviteHref: INVITE_HREF, items: ["Connect"] };
      }
    };
    const { page } = scripted(world);
    await expect(sendConnectionRequest(page, PROFILE_URL)).resolves.toMatchObject({ noteSent: false });
  });

  it.each([
    ["an existing connection", card({ degree: 1, relation: "connected" }), AlreadyConnectedError],
    ["a pending invitation", card({ relation: "pending" }), PendingInviteError],
  ] as const)("stops at %s without opening the invitation dialog", async (_label, profile, expected) => {
    const world = base();
    world.profile = profile;
    const { page, log } = scripted(world);

    await expect(sendConnectionRequest(page, PROFILE_URL)).rejects.toBeInstanceOf(expected);
    expect(log.gotos).toEqual([PROFILE_URL]);
    expect(log.clicks).toEqual([]);
  });

  it("reads 'already connected' and 'pending' out of the More menu too", async () => {
    for (const [relation, expected] of [["connected", AlreadyConnectedError], ["pending", PendingInviteError]] as const) {
      const world = base();
      world.onClick = () => { world.menu = { open: true, relation, inviteHref: null, items: ["x"] }; };
      const { page } = scripted(world);
      await expect(sendConnectionRequest(page, PROFILE_URL)).rejects.toBeInstanceOf(expected);
    }
  });

  it("reports a profile LinkedIn offers no Connect for, instead of timing out", async () => {
    const world = base();
    world.onClick = () => { world.menu = { open: true, relation: "unknown", inviteHref: null, items: ["Save to PDF", "Report"] }; };
    const { page } = scripted(world);
    await expect(sendConnectionRequest(page, PROFILE_URL)).rejects.toBeInstanceOf(ConnectUnavailableError);
  });

  it("says so when Connect is missing only because an invitation was withdrawn recently", async () => {
    // LinkedIn's block passes, so the caller can wait; any other missing Connect does not.
    const world = base();
    world.profile = card({ inviteBlocked: true });
    world.onClick = () => { world.menu = { open: true, relation: "unknown", inviteHref: null, items: ["Save to PDF", "Report"] }; };
    const { page, log } = scripted(world);

    const error = await sendConnectionRequest(page, PROFILE_URL).catch((e) => e);
    expect(error).toBeInstanceOf(InviteBlockedError);
    expect(error).toBeInstanceOf(ConnectUnavailableError); // still "cannot connect" to anyone who does not ask further
    expect(log.gotos).toEqual([PROFILE_URL]);
  });

  it("recognises the weekly limit before and after pressing send", async () => {
    const before = base();
    before.profile = card({ relation: "connectable", inviteHref: INVITE_HREF });
    before.dialog = dialog({ canSendWithoutNote: false, canAddNote: false, weeklyLimitReached: true });
    await expect(sendConnectionRequest(scripted(before).page, PROFILE_URL)).rejects.toBeInstanceOf(WeeklyLimitError);

    const after = base();
    after.profile = card({ relation: "connectable", inviteHref: INVITE_HREF });
    after.onClick = (what) => { if (what.includes("Send without a note")) after.alerts = { weeklyLimitReached: true, error: null }; };
    await expect(sendConnectionRequest(scripted(after).page, PROFILE_URL)).rejects.toBeInstanceOf(WeeklyLimitError);
  });

  it("will not press send when LinkedIn asks for the member's email", async () => {
    const world = base();
    world.profile = card({ relation: "connectable", inviteHref: INVITE_HREF });
    world.dialog = dialog({ canSendWithoutNote: false, canAddNote: false, emailRequired: true });
    const { page, log } = scripted(world);
    await expect(sendConnectionRequest(page, PROFILE_URL)).rejects.toBeInstanceOf(ConnectUnavailableError);
    expect(log.clicks).toEqual([]);
  });

  it("surfaces LinkedIn's own error toast", async () => {
    const world = base();
    world.profile = card({ relation: "connectable", inviteHref: INVITE_HREF });
    world.onClick = (what) => { if (what.includes("Send without a note")) world.alerts = { weeklyLimitReached: false, error: "Unable to connect. Try again later." }; };
    await expect(sendConnectionRequest(scripted(world).page, PROFILE_URL)).rejects.toThrow(/Unable to connect/);
  });

  it("flags a signed-out session instead of failing the contact", async () => {
    const world = base();
    world.landOn = () => "https://www.linkedin.com/login/?session_redirect=x";
    await expect(sendConnectionRequest(scripted(world).page, PROFILE_URL)).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it("rejects a URL that is not a LinkedIn profile before touching the browser", async () => {
    const { page, log } = scripted(base());
    await expect(sendConnectionRequest(page, "https://www.linkedin.com/sales/lead/ACwAA,NAME,x")).rejects.toThrow(/Not a LinkedIn profile URL/);
    expect(log.gotos).toEqual([]);
  });

  describe("with a note", () => {
    const withNoteField = (world: World, field: Partial<InviteDialog>) => {
      world.profile = card({ relation: "connectable", inviteHref: INVITE_HREF });
      world.onClick = (what) => {
        if (what.includes("Add a note")) world.dialog = dialog({ canSendWithoutNote: false, canAddNote: false, noteFieldOpen: true, notesRemaining: 3, noteLimit: 200, ...field });
        if (what.includes("Cancel adding a note")) world.dialog = dialog();
        if (what.includes("Send invitation") || what.includes("Send without a note")) world.profile = card({ relation: "pending" });
      };
      world.onFill = () => { world.dialog = { ...world.dialog, noteSendEnabled: true }; };
    };

    it("attaches the note and sends with it", async () => {
      const world = base();
      withNoteField(world, {});
      const filled: string[] = [];
      const fill = world.onFill!;
      world.onFill = (what, value) => { filled.push(value); fill(what, value); };
      const { page, log } = scripted(world);

      await expect(sendConnectionRequest(page, PROFILE_URL, { note: "  Enjoyed your talk on CX.  " })).resolves.toEqual({ noteSent: true, noteSkipped: null });
      expect(filled).toEqual(["Enjoyed your talk on CX."]);
      expect(clicked(log, "Send invitation")).toBe(true);
      expect(clicked(log, "Send without a note")).toBe(false);
    });

    it("sends without the note when it is over the account's limit, and says why", async () => {
      const world = base();
      withNoteField(world, { noteLimit: 200 });
      const { page, log } = scripted(world);

      const outcome = await sendConnectionRequest(page, PROFILE_URL, { note: "x".repeat(201) });
      expect(outcome.noteSent).toBe(false);
      expect(outcome.noteSkipped).toMatch(/201 characters.*limit is 200/);
      expect(clicked(log, "Send without a note")).toBe(true);
    });

    it("sends without the note when the month's personalised invitations are used up", async () => {
      const world = base();
      withNoteField(world, { notesRemaining: 0 });
      const outcome = await sendConnectionRequest(scripted(world).page, PROFILE_URL, { note: "Hello" });
      expect(outcome).toEqual({ noteSent: false, noteSkipped: "this account has no personalised invitations left this month" });
    });

    it("treats a blank note as no note", async () => {
      const world = base();
      world.profile = card({ relation: "connectable", inviteHref: INVITE_HREF });
      world.onClick = (what) => { if (what.includes("Send without a note")) world.profile = card({ relation: "pending" }); };
      const { page, log } = scripted(world);
      await expect(sendConnectionRequest(page, PROFILE_URL, { note: "   " })).resolves.toEqual({ noteSent: false, noteSkipped: null });
      expect(clicked(log, "Add a note")).toBe(false);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("withdrawing an invitation", () => {
  const pendingCard = () => card({ degree: 2, relation: "pending", pendingFor: "Jordan Reyes" });
  const WITHDRAW = "Withdraw invitation sent to";

  /** A LinkedIn that behaves: Pending opens the confirmation, Withdraw takes the invitation back. */
  function working(world: World, opts: { confirmation?: Partial<WithdrawDialog>; withdraws?: boolean; closes?: boolean } = {}) {
    world.onClick = (what) => {
      if (what.includes(WITHDRAW)) {
        if (opts.closes !== false) world.withdraw = NO_CONFIRMATION;
        if (opts.withdraws !== false) world.profile = card({ degree: 2, relation: "connectable", inviteHref: INVITE_HREF });
      } else if (what.includes("_pending")) {
        world.withdraw = confirmation(opts.confirmation);
      }
    };
  }

  it("opens the confirmation from the profile's own Pending control and confirms it", async () => {
    const world = base();
    world.profile = pendingCard();
    working(world);
    const { page, log } = scripted(world);

    await expect(withdrawInvitation(page, "http://linkedin.com/in/jordan-reyes?trk=x")).resolves.toBeUndefined();
    // Pending inside the top card (not the sticky header's or a suggestion's), then Withdraw
    // inside the confirmation — and nothing else.
    expect(log.clicks).toHaveLength(2);
    expect(log.clicks[0]).toContain("Topcard");
    expect(log.clicks[0]).toContain("_pending");
    expect(log.clicks[1]).toContain("dialog[open]");
    expect(log.clicks[1]).toContain(WITHDRAW);
    // The profile is loaded afresh to ask LinkedIn, rather than trusting the page it clicked in.
    expect(log.gotos).toEqual([PROFILE_URL, PROFILE_URL]);
  });

  it("does not report success while the profile still reads Pending", async () => {
    // LinkedIn closes the confirmation but the invitation is still out.
    const world = base();
    world.profile = pendingCard();
    working(world, { withdraws: false });
    const { page, log } = scripted(world);

    await expect(withdrawInvitation(page, PROFILE_URL)).rejects.toThrow(/did not confirm the withdrawal/);
    expect(log.gotos).toEqual([PROFILE_URL, PROFILE_URL, PROFILE_URL]); // it looked twice before saying so
  });

  it("will not confirm a dialog that names a different member", async () => {
    const world = base();
    world.profile = pendingCard();
    working(world, { confirmation: { recipient: "Someone Else" } });
    const { page, log } = scripted(world);

    await expect(withdrawInvitation(page, PROFILE_URL)).rejects.toThrow(/is for Someone Else, not Jordan Reyes — nothing was withdrawn/);
    expect(clicked(log, WITHDRAW)).toBe(false);
  });

  it("compares the names exactly — a namesake with a longer name is a different member", async () => {
    const world = base();
    world.profile = pendingCard();
    working(world, { confirmation: { recipient: "Jordan Reyes Jr." } });
    const { page, log } = scripted(world);
    await expect(withdrawInvitation(page, PROFILE_URL)).rejects.toThrow(/nothing was withdrawn/);
    expect(clicked(log, WITHDRAW)).toBe(false);
  });

  it("reports a confirmation that never opens, without pressing anything else", async () => {
    const world = base();
    world.profile = pendingCard(); // and clicking Pending does nothing
    const { page, log } = scripted(world);

    await expect(withdrawInvitation(page, PROFILE_URL)).rejects.toThrow(/withdraw confirmation did not open/);
    expect(log.clicks).toHaveLength(1);
  });

  it("will not press a Withdraw button that is disabled", async () => {
    const world = base();
    world.profile = pendingCard();
    working(world, { confirmation: { canWithdraw: false } });
    const { page, log } = scripted(world);
    await expect(withdrawInvitation(page, PROFILE_URL)).rejects.toThrow(/no usable Withdraw button/);
    expect(clicked(log, WITHDRAW)).toBe(false);
  });

  it("reports a Withdraw click LinkedIn did not act on, with its error", async () => {
    const world = base();
    world.profile = pendingCard();
    working(world, { closes: false, withdraws: false });
    world.alerts = { weeklyLimitReached: false, error: "Something went wrong. Please try again.", notices: [] };
    const { page } = scripted(world);
    await expect(withdrawInvitation(page, PROFILE_URL)).rejects.toThrow(/confirmation stayed open \(Something went wrong/);
  });

  describe("when LinkedIn says it withdrew the invitation and goes on showing it", () => {
    // Seen live on 2026-10-09, for the automation and for a person clicking alike: the page
    // showed "Invitation to … withdrawn" and a Connect button, the server call answered
    // with success, and a fresh load of the profile said Pending again.
    it("reports that as its own error, quoting LinkedIn, and never as a withdrawal", async () => {
      const world = base();
      world.profile = pendingCard();
      working(world, { withdraws: false });
      const click = world.onClick!;
      world.onClick = (what) => { click(what); if (what.includes(WITHDRAW)) world.alerts = { weeklyLimitReached: false, error: null, notices: ["Invitation to Jordan withdrawn."] }; };
      const { page } = scripted(world);

      const error = await withdrawInvitation(page, PROFILE_URL).catch((e) => e);
      expect(error).toBeInstanceOf(WithdrawUnconfirmedError);
      expect(error.message).toMatch(/reported the withdrawal \("Invitation to Jordan withdrawn\."\) but the profile still shows the invitation as pending/);
    });

    it("recognises it from the button alone, when no message was showing", async () => {
      const world = base();
      world.profile = pendingCard();
      let pressed = false;
      world.onClick = (what) => {
        if (what.includes(WITHDRAW)) { pressed = true; world.withdraw = NO_CONFIRMATION; world.profile = card({ degree: 2, relation: "unknown", inviteBlocked: true }); }
        else if (what.includes("_pending")) world.withdraw = confirmation();
      };
      // What the page shows in place does not survive a reload.
      world.landOn = (url) => { if (pressed) world.profile = pendingCard(); return url; };
      const { page } = scripted(world);

      await expect(withdrawInvitation(page, PROFILE_URL)).rejects.toBeInstanceOf(WithdrawUnconfirmedError);
    });

    it("keeps an ordinary failure ordinary when LinkedIn never claimed anything", async () => {
      const world = base();
      world.profile = pendingCard();
      working(world, { withdraws: false }); // the confirmation closes; nothing else happens
      const error = await withdrawInvitation(scripted(world).page, PROFILE_URL).catch((e) => e);
      expect(error).not.toBeInstanceOf(WithdrawUnconfirmedError);
      expect(error.message).toMatch(/did not confirm the withdrawal/);
    });
  });

  it("reports LinkedIn's own refusal in its own words", async () => {
    const world = base();
    world.profile = pendingCard();
    working(world, { withdraws: false });
    const click = world.onClick!;
    world.onClick = (what) => { click(what); if (what.includes(WITHDRAW)) world.alerts = { weeklyLimitReached: false, error: null, notices: ["Sorry, unable to withdraw invitation to Jordan. Please try again."] }; };
    const { page, log } = scripted(world);

    await expect(withdrawInvitation(page, PROFILE_URL)).rejects.toThrow(/LinkedIn refused the withdrawal: Sorry, unable to withdraw invitation to Jordan/);
    expect(log.gotos).toEqual([PROFILE_URL]); // no need to load the profile again to know
  });

  it("finds a Pending that only shows inside the More menu", async () => {
    const world = base(); // top card: Message / Follow / More
    world.onClick = (what) => {
      if (what.includes(WITHDRAW)) {
        world.withdraw = NO_CONFIRMATION;
        world.menu = { open: true, relation: "connectable", inviteHref: INVITE_HREF, items: ["Connect"] };
      } else if (what.includes("_pending")) {
        world.withdraw = confirmation();
      } else if (what.includes("More") && !world.menu.open) {
        world.menu = { open: true, relation: "pending", inviteHref: null, items: ["Save to PDF", "Pending"] };
      }
    };
    const { page, log } = scripted(world);

    await expect(withdrawInvitation(page, PROFILE_URL)).resolves.toBeUndefined();
    expect(log.clicks.some((c) => c.includes('[role="menuitem"]') && c.includes("Pending"))).toBe(true);
    expect(clicked(log, WITHDRAW)).toBe(true);
  });

  it.each([
    ["offers Connect", card({ degree: 2, relation: "connectable", inviteHref: INVITE_HREF })],
    ["offers nothing", card({ degree: 3, relation: "unknown", hasMoreMenu: false })],
  ] as const)("has nothing to withdraw on a profile that %s", async (_label, profile) => {
    const world = base();
    world.profile = profile;
    const { page, log } = scripted(world);

    const error = await withdrawInvitation(page, PROFILE_URL).catch((e) => e);
    expect(error).toBeInstanceOf(NoPendingInviteError);
    expect((error as NoPendingInviteError).alreadyWithdrawn).toBe(false);
    expect(log.clicks).toEqual([]);
  });

  it("reports an invitation LinkedIn shows as withdrawn already", async () => {
    // How a retry learns that an earlier, unconfirmed attempt did go through.
    const world = base();
    world.profile = card({ degree: 3, relation: "unknown", inviteBlocked: true });
    world.onClick = () => { world.menu = { open: true, relation: "unknown", inviteHref: null, items: ["Save to PDF"] }; };
    const { page, log } = scripted(world);

    const error = await withdrawInvitation(page, PROFILE_URL).catch((e) => e);
    expect(error).toBeInstanceOf(NoPendingInviteError);
    expect((error as NoPendingInviteError).alreadyWithdrawn).toBe(true);
    expect(clicked(log, WITHDRAW)).toBe(false);
  });

  it("reports a member who has accepted in the meantime instead of touching anything", async () => {
    const world = base();
    world.profile = card({ degree: 1, relation: "connected" });
    const { page, log } = scripted(world);
    await expect(withdrawInvitation(page, PROFILE_URL)).rejects.toBeInstanceOf(AlreadyConnectedError);
    expect(log.clicks).toEqual([]);
  });

  it("flags a signed-out session", async () => {
    const world = base();
    world.landOn = () => "https://www.linkedin.com/checkpoint/challenge/x";
    await expect(withdrawInvitation(scripted(world).page, PROFILE_URL)).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it("rejects a URL that is not a LinkedIn profile before touching the browser", async () => {
    const { page, log } = scripted(base());
    await expect(withdrawInvitation(page, "https://www.linkedin.com/mynetwork/invitation-manager/sent/")).rejects.toThrow(/Not a LinkedIn profile URL/);
    expect(log.gotos).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("sending a message", () => {
  const connected = () => card({ degree: 1, relation: "connected" });

  /** A message box that behaves: holds what is typed, and delivers on Send. */
  function workingBox(world: World, opts: { insertWorks?: boolean; delivers?: boolean } = {}) {
    let draft = "";
    const sync = () => { world.thread = { ...world.thread, draft: draft.replace(/\n/g, " "), sendEnabled: draft.trim() !== "" }; };
    world.onInsert = (text) => { if (opts.insertWorks !== false) { draft += text; sync(); } };
    world.onType = (text) => { draft += text; sync(); };
    world.onKey = (key) => {
      if (key === "Shift+Enter") { draft += "\n"; sync(); }
      if (key === "Backspace") { draft = ""; sync(); }
    };
    world.onClick = (what) => {
      if (!what.includes("msg-form__send-button") || opts.delivers === false) return;
      world.thread = { ...world.thread, messageCount: world.thread.messageCount + 1, lastMessageInbound: false, lastMessageText: draft, draft: "", sendEnabled: false };
      draft = "";
    };
  }

  it("opens the conversation from the member's own profile, not from a name search", async () => {
    const world = base();
    world.profile = connected();
    workingBox(world);
    const { page, log } = scripted(world);

    await expect(sendMessage(page, "http://www.linkedin.com/in/jordan-reyes", "Thanks for connecting, Jordan.")).resolves.toBe("sent");
    expect(log.gotos[0]).toBe(PROFILE_URL);
    // LinkedIn's compose link for THIS member, opened as a full page rather than the overlay.
    expect(log.gotos[1]).toContain(`recipient=${PROFILE_ID}`);
    expect(log.gotos[1]).not.toContain("interop");
    expect(log.gotos).toHaveLength(2);
  });

  it("types line breaks as Shift+Enter and never presses a bare Enter", async () => {
    const world = base();
    world.profile = connected();
    workingBox(world);
    const { page, log } = scripted(world);

    await sendMessage(page, PROFILE_URL, "Line one\n\nLine three");
    expect(log.inserted).toEqual(["Line one", "Line three"]);
    expect(log.keys.filter((k) => k === "Shift+Enter")).toHaveLength(2);
    expect(log.keys).not.toContain("Enter");
  });

  it.each([
    ["pending", card({ degree: 2, relation: "pending" })],
    ["never connected", card({ degree: 2, relation: "connectable", inviteHref: INVITE_HREF })],
    ["unknown", card({ degree: 3, relation: "unknown" })],
  ] as const)("refuses to message a member who is %s, though their profile has a Message button", async (_label, profile) => {
    const world = base();
    world.profile = profile; // messageHref is present on all of these — it would open InMail
    const { page, log } = scripted(world);

    const error = await sendMessage(page, PROFILE_URL, "Hi").catch((e) => e);
    expect(error).toBeInstanceOf(NotConnectedError);
    expect((error as NotConnectedError).relation).toBe(profile.relation);
    expect(log.gotos).toEqual([PROFILE_URL]);
  });

  it("refuses when the open conversation belongs to a different member", async () => {
    const world = base();
    world.profile = connected();
    world.thread = thread({ participantId: "ACoAAsomeoneElse", paneText: "Jordan Reyes" }); // same name, different person
    workingBox(world);
    const { page, log } = scripted(world);

    await expect(sendMessage(page, PROFILE_URL, "Hi")).rejects.toBeInstanceOf(RecipientMismatchError);
    expect(log.inserted).toEqual([]);
    expect(log.clicks).toEqual([]);
  });

  it("accepts a brand-new conversation only when the recipient shown is the member", async () => {
    const fresh = base();
    fresh.profile = connected();
    fresh.thread = thread({ participantId: null, paneText: "New message Jordan Reyes" });
    workingBox(fresh);
    await expect(sendMessage(scripted(fresh).page, PROFILE_URL, "Hi")).resolves.toBe("sent");

    const wrong = base();
    wrong.profile = connected();
    wrong.thread = thread({ participantId: null, paneText: "New message Jane Reyes" });
    workingBox(wrong);
    const { page, log } = scripted(wrong);
    await expect(sendMessage(page, PROFILE_URL, "Hi")).rejects.toBeInstanceOf(RecipientMismatchError);
    expect(log.clicks).toEqual([]);
  });

  it("stops when the contact has already written back", async () => {
    const world = base();
    world.profile = connected();
    world.thread = thread({ messageCount: 2, inboundCount: 1, lastMessageInbound: true, lastMessageText: "Sure, send details" });
    workingBox(world);
    const { page, log } = scripted(world);

    const error = await sendMessage(page, PROFILE_URL, "Following up…").catch((e) => e);
    expect(error).toBeInstanceOf(RecipientRepliedError);
    expect((error as RecipientRepliedError).lastMessage).toBe("Sure, send details");
    expect(log.inserted).toEqual([]);
    expect(log.clicks).toEqual([]);
  });

  it("answers a contact who has written back when a person is replying by hand", async () => {
    const world = base();
    world.profile = connected();
    world.thread = thread({ messageCount: 2, inboundCount: 1, lastMessageInbound: true, lastMessageText: "Sure, send details" });
    workingBox(world);
    const { page, log } = scripted(world);

    expect(await sendMessage(page, PROFILE_URL, "Here they are.", { allowReplied: true })).toBe("sent");
    expect(log.inserted).toEqual(["Here they are."]);
  });

  it("does not take the contact's own words for a message already sent", async () => {
    const world = base();
    world.profile = connected();
    // They wrote exactly what is about to be sent. That is their message, not a trace of ours.
    world.thread = thread({ messageCount: 1, inboundCount: 1, lastMessageInbound: true, lastMessageText: "Thanks" });
    workingBox(world);
    const { page, log } = scripted(world);

    expect(await sendMessage(page, PROFILE_URL, "Thanks", { allowReplied: true })).toBe("sent");
    expect(log.inserted).toEqual(["Thanks"]);
  });

  it("does not send a message the thread already ends with", async () => {
    // A previous attempt delivered but could not be confirmed; the retry must not double up.
    const world = base();
    world.profile = connected();
    world.thread = thread({ messageCount: 1, lastMessageText: "Thanks for connecting,\nJordan." });
    workingBox(world);
    const { page, log } = scripted(world);

    await expect(sendMessage(page, PROFILE_URL, "Thanks for connecting,\n\nJordan.")).resolves.toBe("already-sent");
    expect(log.inserted).toEqual([]);
    expect(log.clicks).toEqual([]);
  });

  it("falls back to typing when the editor ignores inserted text", async () => {
    const world = base();
    world.profile = connected();
    workingBox(world, { insertWorks: false });
    const { page, log } = scripted(world);

    await expect(sendMessage(page, PROFILE_URL, "Hello Jordan")).resolves.toBe("sent");
    expect(log.typed).toEqual(["Hello Jordan"]);
  });

  it("will not press Send unless the box holds exactly the message", async () => {
    const world = base();
    world.profile = connected();
    world.onInsert = () => { world.thread = { ...world.thread, draft: "Hello Jo", sendEnabled: true }; }; // truncated
    world.onType = () => { world.thread = { ...world.thread, draft: "Hello Jo", sendEnabled: true }; };
    const { page, log } = scripted(world);

    await expect(sendMessage(page, PROFILE_URL, "Hello Jordan")).rejects.toThrow(/does not hold the message/);
    expect(clicked(log, "msg-form__send-button")).toBe(false);
  });

  it("reports an unconfirmed send as its own error, so it is never retried blindly", async () => {
    const world = base();
    world.profile = connected();
    workingBox(world, { delivers: false });
    await expect(sendMessage(scripted(world).page, PROFILE_URL, "Hello Jordan")).rejects.toBeInstanceOf(MessageUnconfirmedError);
  });

  it("flags a signed-out session", async () => {
    const world = base();
    world.landOn = () => "https://www.linkedin.com/authwall?trk=x";
    await expect(sendMessage(scripted(world).page, PROFILE_URL, "Hi")).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it("rejects an empty message and a non-profile URL up front", async () => {
    const { page, log } = scripted(base());
    await expect(sendMessage(page, PROFILE_URL, "   ")).rejects.toThrow(/empty/);
    await expect(sendMessage(page, "https://example.com/x", "Hi")).rejects.toThrow(/Not a LinkedIn profile URL/);
    expect(log.gotos).toEqual([]);
  });
});
