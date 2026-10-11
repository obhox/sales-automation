// @vitest-environment jsdom
//
// The readers that run inside LinkedIn's pages, exercised against markup shaped like what
// LinkedIn served on 2026-10-09. jsdom has no layout, so visibility is judged from styles
// (`layout: false`) and the fixtures mark LinkedIn's hidden duplicates with display:none —
// the same duplicates that are zero-size in a real browser.
import { beforeEach, describe, expect, it } from "vitest";
import {
  readLinkedinPage,
  type AccountStats,
  type InviteDialog,
  type MessageThread,
  type PageAlerts,
  type ProfileCard,
  type ProfileMenu,
  type WithdrawDialog,
} from "@/lib/linkedin/dom";

const read = <T>(kind: "profile" | "menu" | "invite" | "withdraw" | "thread" | "alerts" | "stats") =>
  readLinkedinPage({ kind, layout: false }) as T;

const PROFILE_ID = "ACoAABexampleProfileId-0000000000_sample";
const COMPOSE = `/messaging/compose/?profileUrn=urn%3Ali%3Afsd_profile%3A${PROFILE_ID}&recipient=${PROFILE_ID}&screenContext=NON_SELF_PROFILE_VIEW&interop=msgOverlay`;
const HIDDEN = 'style="display:none"';

/** A profile page: sticky header, top card, and a "people you may know" rail. */
function profilePage(opts: { degree: string; hiddenDegree?: string; actions: string }): string {
  return `
    <div class="sticky"><button>More</button><a href="${COMPOSE}">Message</a></div>
    <main>
      <div componentkey="com.linkedin.sdui.profile.card.ref${PROFILE_ID}Topcard">
        <section>
          <div><h2>Avery Stone</h2>
            ${opts.hiddenDegree ? `<p ${HIDDEN}>· ${opts.hiddenDegree}</p>` : ""}
            <p>· ${opts.degree}</p>
          </div>
          <p>Active sunglasses for anyone!</p>
          <a href="https://www.linkedin.com/in/avery-stone/overlay/contact-info/">Contact info</a>
          <div>${opts.actions}</div>
        </section>
      </div>
      <div componentkey="com.linkedin.sdui.profile.card.ref${PROFILE_ID}About"><section><h2>About</h2></section></div>
      <section><h2>People you may know</h2>
        <p>· 1st</p>
        <button componentkey="ConnectButtonstate:invitation:urn:li:member:100000002_connect" aria-label="Invite Riley Chen to connect">Connect</button>
        <a href="/preload/custom-invite/?vanityName=someone-else" aria-label="Invite Someone Else to connect">Connect</a>
      </section>
    </main>`;
}

const MESSAGE = `<a href="${COMPOSE}">Message</a>`;
const MORE = `<button type="button" aria-expanded="false"><span><span>More</span></span></button><button aria-label="More" ${HIDDEN}></button>`;
const CONNECT = `<a aria-label="Invite Avery Stone to connect" href="/preload/custom-invite/?vanityName=avery-stone" componentkey="ConnectButtonstate:invitation:urn:li:member:100000001_connect">Connect</a>`;
// What LinkedIn shows once an invitation has been withdrawn (the shape of a live profile
// minutes after one was): a Connect button in a "withdrawn" state, with no invitation link.
const WITHDRAWN = `<button type="button" componentkey="ConnectButtonstate:invitation:urn:li:member:100000001_withdrawn" aria-label="Invite Avery Stone to connect"><span><span>Connect</span></span></button>`;
const PENDING = `<a aria-label="Pending, click to withdraw invitation sent to Avery Stone" href="https://www.linkedin.com/in/avery-stone/" componentkey="ConnectButtonstate:invitation:urn:li:member:100000001_pending"><span>Pending</span></a>`;

beforeEach(() => { document.body.innerHTML = ""; });

describe("profile top card", () => {
  it("reads a profile whose main action is Connect", () => {
    document.body.innerHTML = profilePage({ degree: "2nd", actions: CONNECT + MESSAGE + MORE });
    const card = read<ProfileCard>("profile");
    expect(card).toMatchObject({
      found: true, name: "Avery Stone", profileId: PROFILE_ID, degree: 2,
      relation: "connectable", inviteHref: "/preload/custom-invite/?vanityName=avery-stone",
      messageHref: COMPOSE, hasMoreMenu: true,
    });
  });

  it("is not fooled by the hidden '1st' LinkedIn pre-renders beside a pending invitation", () => {
    // The shape of a live profile with an invitation sent hours earlier.
    document.body.innerHTML = profilePage({ degree: "2nd", hiddenDegree: "1st", actions: MESSAGE + PENDING + MORE });
    const card = read<ProfileCard>("profile");
    expect(card.degree).toBe(2);
    expect(card.relation).toBe("pending");
    expect(card.inviteHref).toBeNull();
  });

  it("reads who the Pending control says the invitation went to", () => {
    // The withdraw step holds LinkedIn's confirmation to this name before it confirms.
    document.body.innerHTML = profilePage({ degree: "2nd", actions: MESSAGE + PENDING + MORE });
    expect(read<ProfileCard>("profile").pendingFor).toBe("Avery Stone");
    document.body.innerHTML = profilePage({ degree: "2nd", actions: CONNECT + MESSAGE + MORE });
    expect(read<ProfileCard>("profile").pendingFor).toBeNull();
  });

  it("tells a withdrawn invitation's Connect button from one that can be used", () => {
    // During LinkedIn's block on re-inviting, Connect is there but leads nowhere. Read as
    // plain "no Connect", the member looks like someone who can never be invited.
    document.body.innerHTML = profilePage({ degree: "3rd", actions: MESSAGE + WITHDRAWN + MORE + WITHDRAWN.replace("<button ", `<button ${HIDDEN} `) });
    expect(read<ProfileCard>("profile")).toMatchObject({ relation: "unknown", inviteHref: null, pendingFor: null, inviteBlocked: true, hasMoreMenu: true });

    document.body.innerHTML = profilePage({ degree: "2nd", actions: CONNECT + MESSAGE + MORE });
    expect(read<ProfileCard>("profile").inviteBlocked).toBe(false);
    document.body.innerHTML = profilePage({ degree: "2nd", actions: MESSAGE + PENDING + MORE });
    expect(read<ProfileCard>("profile").inviteBlocked).toBe(false);
  });

  it("reads a first-degree connection", () => {
    document.body.innerHTML = profilePage({ degree: "1st", actions: MESSAGE + MORE });
    expect(read<ProfileCard>("profile")).toMatchObject({ degree: 1, relation: "connected", messageHref: COMPOSE });
  });

  it("reports 'unknown' when Connect is only in the More menu", () => {
    // The layout every production failure was on: Message / Follow / More, no Connect.
    document.body.innerHTML = profilePage({
      degree: "3rd",
      actions: MESSAGE + `<button aria-label="Follow Avery Stone">Follow</button>` + MORE,
    });
    expect(read<ProfileCard>("profile")).toMatchObject({ degree: 3, relation: "unknown", inviteHref: null, hasMoreMenu: true });
  });

  it("ignores a hidden duplicate Connect control", () => {
    document.body.innerHTML = profilePage({
      degree: "3rd",
      actions: MESSAGE + CONNECT.replace("<a ", `<a ${HIDDEN} `) + MORE,
    });
    expect(read<ProfileCard>("profile")).toMatchObject({ relation: "unknown", inviteHref: null });
  });

  it("never reads another member's Connect button or degree from elsewhere on the page", () => {
    document.body.innerHTML = profilePage({ degree: "3rd", actions: MESSAGE + MORE });
    const card = read<ProfileCard>("profile");
    expect(card.inviteHref).toBeNull();
    expect(card.degree).toBe(3);
  });

  it("finds the More button whether it is labelled by text or by aria-label", () => {
    document.body.innerHTML = profilePage({ degree: "3rd", actions: MESSAGE + `<button aria-label="More"></button>` });
    expect(read<ProfileCard>("profile").hasMoreMenu).toBe(true);
  });

  it("falls back to the first heading's section when the component key is absent", () => {
    document.body.innerHTML = `<main><section><h1>Jane Doe</h1><span>· 2nd</span>${CONNECT}</section></main>`;
    expect(read<ProfileCard>("profile")).toMatchObject({ found: true, name: "Jane Doe", profileId: null, relation: "connectable" });
  });

  it("reports why when there is no profile on the page", () => {
    document.body.innerHTML = `<div>Sign in</div>`;
    expect(read<ProfileCard>("profile")).toMatchObject({ found: false, reason: "no-main" });
    document.body.innerHTML = `<main><div>loading</div></main>`;
    expect(read<ProfileCard>("profile")).toMatchObject({ found: false, reason: "no-top-card" });
  });
});

describe("profile More menu", () => {
  const menu = (items: string) => `<main></main><div data-floating-ui-portal><div data-floating-ui-focusable><div role="menu">${items}</div></div></div>`;

  it("finds Connect and its invitation link", () => {
    document.body.innerHTML = menu(`
      <a role="menuitem" href="/messaging/compose/?screenContext=NON_SELF_PROFILE_VIEW&body=https%3A%2F%2Fwww.linkedin.com%2Fin%2Fjordan-reyes">Send profile in a message</a>
      <div role="menuitem">Save to PDF</div>
      <a role="menuitem" href="/preload/custom-invite/?vanityName=jordan-reyes" componentkey="ConnectButtonstate:invitation:urn:li:member:100000003_connect">Connect</a>
      <a role="menuitem" href="https://www.linkedin.com/in/jordan-reyes/">Report Jordan</a>`);
    expect(read<ProfileMenu>("menu")).toMatchObject({
      open: true, relation: "connectable", inviteHref: "/preload/custom-invite/?vanityName=jordan-reyes",
      items: ["Send profile in a message", "Save to PDF", "Connect", "Report Jordan"],
    });
  });

  it("recognises a connection by 'Remove connection'", () => {
    document.body.innerHTML = menu(`<div role="menuitem">Following</div><div role="menuitem">Remove connection</div>`);
    expect(read<ProfileMenu>("menu")).toMatchObject({ relation: "connected", inviteHref: null });
  });

  it("recognises a pending invitation", () => {
    document.body.innerHTML = menu(`<a role="menuitem" href="#" componentkey="ConnectButtonstate:invitation:urn:li:member:100000003_pending">Pending</a>`);
    expect(read<ProfileMenu>("menu").relation).toBe("pending");
  });

  it("reports a menu with no Connect at all, and a closed menu", () => {
    document.body.innerHTML = menu(`<div role="menuitem">Save to PDF</div>`);
    expect(read<ProfileMenu>("menu")).toMatchObject({ open: true, relation: "unknown", inviteHref: null });
    document.body.innerHTML = `<main></main>`;
    expect(read<ProfileMenu>("menu")).toMatchObject({ open: false });
  });
});

describe("invitation dialog", () => {
  const dialog = (body: string) => `<div role="dialog" aria-labelledby="send-invite-modal">${body}</div>`;

  it("reads the first step", () => {
    document.body.innerHTML = dialog(`
      <h2 id="send-invite-modal">Add a note to your invitation?</h2>
      <button aria-label="Dismiss"></button>
      <button aria-label="Add a note">Add a note</button>
      <button aria-label="Send without a note">Send without a note</button>`);
    expect(read<InviteDialog>("invite")).toMatchObject({
      open: true, canSendWithoutNote: true, canAddNote: true, noteFieldOpen: false, weeklyLimitReached: false, emailRequired: false,
    });
  });

  it("reads the note step, its quota and its length limit", () => {
    document.body.innerHTML = dialog(`
      <h2>Add a note to your invitation</h2>
      <p>3 personalized invitations remaining for this month.</p>
      <label>Please limit personal note to 300 characters.</label>
      <textarea id="custom-message" name="message"></textarea><span>0/200</span>
      <button aria-label="Cancel adding a note">Cancel</button>
      <button aria-label="Send invitation" disabled>Send</button>`);
    expect(read<InviteDialog>("invite")).toMatchObject({
      noteFieldOpen: true, noteSendEnabled: false, notesRemaining: 3, noteLimit: 200, canSendWithoutNote: false,
    });
  });

  it("sees the note Send button enable once there is text", () => {
    document.body.innerHTML = dialog(`<textarea name="message">Hi</textarea><span>2/200</span><button aria-label="Send invitation">Send</button>`);
    expect(read<InviteDialog>("invite")).toMatchObject({ noteSendEnabled: true, noteLimit: 200 });
  });

  it("detects the weekly limit and an email gate", () => {
    document.body.innerHTML = dialog(`<h2>You've reached the weekly invitation limit</h2><button>Got it</button>`);
    expect(read<InviteDialog>("invite").weeklyLimitReached).toBe(true);
    document.body.innerHTML = dialog(`<p>To verify this member knows you, please enter their email</p><input type="email">`);
    expect(read<InviteDialog>("invite")).toMatchObject({ emailRequired: true, canSendWithoutNote: false });
  });

  it("reports no dialog", () => {
    document.body.innerHTML = `<main></main>`;
    expect(read<InviteDialog>("invite").open).toBe(false);
  });
});

describe("withdraw confirmation", () => {
  // The markup LinkedIn served on 2026-10-09 after a click on a profile's Pending control
  // (classes and icons dropped, the member renamed). It is a native <dialog> with no ARIA
  // role, and it hosts the page's toast region while it is open.
  const confirmation = (opts: { name?: string; disabled?: boolean } = {}) => `
    <dialog data-testid="dialog" aria-labelledby="dialog-header" open="">
      <button type="button" aria-label="Dismiss"><span></span></button>
      <div><header id="dialog-header"><h2>Withdraw invitation</h2></header>
        <div data-testid="dialog-content">
          <div data-sdui-screen="com.linkedin.sdui.flagshipnav.mynetwork.invitations.WithdrawConfirmationDialog"><div>
            <p>If you withdraw now, you won’t be able to resend to this person for up to 3 weeks.</p>
            <hr role="presentation">
            <div>
              <button type="button"><span><span>Cancel</span></span></button>
              <div data-display-contents="true">
                <button type="button" componentkey="3f2b6c1e-0000-4000-8000-000000000001" aria-label="Withdraw invitation sent to ${opts.name ?? "Avery Stone"}" ${opts.disabled ? "disabled" : ""}><span><span>Withdraw</span></span></button>
              </div>
            </div>
          </div></div>
        </div>
      </div>
      <section><h2 data-testid="toasts-title">0 notifications</h2></section>
    </dialog>`;

  it("reads the confirmation and who it is for", () => {
    document.body.innerHTML = profilePage({ degree: "2nd", actions: MESSAGE + PENDING + MORE }) + confirmation();
    expect(read<WithdrawDialog>("withdraw")).toEqual({
      open: true, canWithdraw: true, recipient: "Avery Stone",
      text: "Withdraw invitation If you withdraw now, you won’t be able to resend to this person for up to 3 weeks. Cancel Withdraw",
    });
  });

  it("is invisible to the invitation-dialog reader, which looks for an ARIA role", () => {
    // Why this dialog has a reader of its own: the selector every other dialog is found by
    // matches nothing here.
    document.body.innerHTML = confirmation();
    expect(read<InviteDialog>("invite").open).toBe(false);
  });

  it("sees a Withdraw button that is not usable", () => {
    document.body.innerHTML = confirmation({ disabled: true });
    expect(read<WithdrawDialog>("withdraw")).toMatchObject({ open: true, canWithdraw: false });
  });

  it("is not fooled by another dialog, or by the sent-invitations list's Withdraw links", () => {
    // The list labels each row's link with the same words the dialog's button carries.
    document.body.innerHTML = `
      <main><a aria-disabled="false" href="https://www.linkedin.com/" aria-label="Withdraw invitation sent to Avery Stone">Withdraw</a></main>
      <div role="dialog"><h2 id="send-invite-modal">Add a note to your invitation?</h2><button aria-label="Send without a note">Send without a note</button></div>`;
    expect(read<WithdrawDialog>("withdraw")).toEqual({ open: false, text: "", canWithdraw: false, recipient: null });
  });

  it("reports no confirmation once LinkedIn has removed it", () => {
    document.body.innerHTML = profilePage({ degree: "2nd", actions: MESSAGE + PENDING + MORE }) + `<section><h2 data-testid="toasts-title">0 notifications</h2></section>`;
    expect(read<WithdrawDialog>("withdraw").open).toBe(false);
  });

  it("ignores a confirmation that is in the page but not open", () => {
    document.body.innerHTML = confirmation().replace(' open=""', "");
    expect(read<WithdrawDialog>("withdraw").open).toBe(false);
  });
});

describe("message thread", () => {
  const thread = (opts: { events: string; draft?: string; sendDisabled?: boolean; header?: boolean }) => `
    <main>
      <div class="msg-conversations-container"><ul>
        <li class="msg-conversation-listitem"><h3 class="msg-conversation-listitem__participant-names">Somebody Else</h3></li>
      </ul></div>
      <div class="msg-thread">
        ${opts.header === false ? "" : `<a class="msg-thread__link-to-profile" href="https://www.linkedin.com/in/${PROFILE_ID}"><h2 class="msg-entity-lockup__entity-title">Avery Stone</h2></a>`}
        <div class="msg-s-message-list"><ul>${opts.events}</ul></div>
        <form class="msg-form">
          <div class="msg-form__contenteditable" role="textbox" contenteditable="true" aria-label="Write a message…"><p>${opts.draft ?? ""}</p></div>
          <button class="msg-form__send-button" type="submit" ${opts.sendDisabled === false ? "" : "disabled"}>Send</button>
          <button class="msg-form__send-toggle" type="button">Open send option</button>
        </form>
      </div>
    </main>`;
  const mine = (text: string) => `<li><div class="msg-s-event-listitem" data-event-urn="x"><p class="msg-s-event-listitem__body">${text}</p></div></li>`;
  const theirs = (text: string) => `<li><div class="msg-s-event-listitem msg-s-event-listitem--other" data-event-urn="y"><p class="msg-s-event-listitem__body">${text}</p></div></li>`;

  it("identifies who the open conversation is with", () => {
    document.body.innerHTML = thread({ events: mine("Hi Avery") });
    expect(read<MessageThread>("thread")).toMatchObject({
      ready: true, participantId: PROFILE_ID, messageCount: 1, inboundCount: 0, lastMessageInbound: false,
      lastMessageText: "Hi Avery", draft: "", sendEnabled: false,
    });
  });

  it("counts the other person's messages, which is how a reply is detected", () => {
    document.body.innerHTML = thread({ events: mine("Hi Avery") + theirs("Thanks for reaching out!") });
    expect(read<MessageThread>("thread")).toMatchObject({ messageCount: 2, inboundCount: 1, lastMessageInbound: true });
  });

  it("reads the draft and the Send button state", () => {
    document.body.innerHTML = thread({ events: "", draft: "Hello there", sendDisabled: false });
    expect(read<MessageThread>("thread")).toMatchObject({ draft: "Hello there", sendEnabled: true });
  });

  it("keeps the recipient text free of other conversations, the history and the draft", () => {
    document.body.innerHTML = thread({ events: theirs("call me Somebody Else"), draft: "draft text" });
    const { paneText } = read<MessageThread>("thread");
    expect(paneText).toContain("Avery Stone");
    expect(paneText).not.toContain("Somebody Else");
    expect(paneText).not.toContain("draft text");
  });

  it("reports a new conversation, which has no profile link yet", () => {
    document.body.innerHTML = thread({ events: "", header: false });
    expect(read<MessageThread>("thread")).toMatchObject({ ready: true, participantId: null, messageCount: 0 });
  });

  it("reports when there is no message box", () => {
    document.body.innerHTML = `<main><div class="msg-thread"></div></main>`;
    expect(read<MessageThread>("thread").ready).toBe(false);
  });
});

describe("alerts after an action", () => {
  it("is quiet on a normal page", () => {
    document.body.innerHTML = `<main></main>`;
    expect(read<PageAlerts>("alerts")).toEqual({ weeklyLimitReached: false, error: null, notices: [] });
  });

  // The toast region of the current layout, as served on 2026-10-09 (classes and icons
  // dropped): a count heading, then one role="alert" per toast.
  const toasts = (...said: string[]) => `<section><h2 data-testid="toasts-title">${said.length} notification${said.length === 1 ? "" : "s"}</h2>${
    said.map((text) => `<div style="opacity: 1"><div tabindex="0" aria-hidden="false"><div role="alert"><div><div><p>${text}</p></div><button type="button" aria-label="Dismiss"><span></span></button></div></div></div></div>`).join("")}</section>`;

  it("reads what LinkedIn's toasts say about an action", () => {
    document.body.innerHTML = `<main></main>` + toasts("Invitation to Avery withdrawn.");
    expect(read<PageAlerts>("alerts").notices).toEqual(["Invitation to Avery withdrawn."]);
    document.body.innerHTML = `<main></main>` + toasts("Sorry, unable to withdraw invitation to Avery. Please try again.");
    expect(read<PageAlerts>("alerts").notices).toEqual(["Sorry, unable to withdraw invitation to Avery. Please try again."]);
  });

  it("finds the toast region inside a modal dialog too, and reads an empty one as nothing", () => {
    // While a dialog is open LinkedIn moves the region into it.
    document.body.innerHTML = `<main></main><dialog open="">${toasts("Invitation to Avery withdrawn.")}</dialog>`;
    expect(read<PageAlerts>("alerts").notices).toEqual(["Invitation to Avery withdrawn."]);
    document.body.innerHTML = `<main></main>` + toasts();
    expect(read<PageAlerts>("alerts").notices).toEqual([]);
  });

  it("reports the weekly limit and an error toast", () => {
    document.body.innerHTML = `<div class="ip-fuse-limit-alert__warning">limit</div><div data-test-artdeco-toast-item-type="error">Unable to connect. Try again.</div>`;
    expect(read<PageAlerts>("alerts")).toEqual({ weeklyLimitReached: true, error: "Unable to connect. Try again.", notices: [] });
  });
});

describe("account numbers", () => {
  it("reads the connection count", () => {
    document.body.innerHTML = `<main><p>1,204 connections</p><p>Sort by: Recently added</p></main>`;
    expect(read<AccountStats>("stats").connections).toBe(1204);
  });

  it("reads the pending-invitation count", () => {
    document.body.innerHTML = `<main><h1>Manage invitations</h1><button>People (37)</button><button>Pages (4)</button></main>`;
    expect(read<AccountStats>("stats").pendingInvitations).toBe(37);
  });

  it("reads profile views from the page, not from its title", () => {
    // The old scraper matched the <title> first and always reported 0.
    document.head.innerHTML = `<title>Profile Viewers | LinkedIn</title>`;
    document.body.innerHTML = `<main><h1>Who's viewed your profile</h1><span>Past 90 days</span><p>45</p><p>Profile viewers in the past 90 days</p></main>`;
    expect(read<AccountStats>("stats").profileViews).toBe(45);
  });

  it("returns null, never zero, for a number it cannot find", () => {
    document.body.innerHTML = `<main><p>Sign in to LinkedIn</p></main>`;
    expect(read<AccountStats>("stats")).toEqual({ connections: null, pendingInvitations: null, profileViews: null });
  });
});
