// The connect, withdraw, message and visit steps run for real — real Playwright, real Chromium, real
// clicks and keystrokes — against a stand-in for LinkedIn served by request interception.
// Nothing leaves the machine: every request to linkedin.com is answered from this file.
//
// The other LinkedIn tests script what the page says; this one proves the steps can
// actually find and operate the controls: that the More-menu locator resolves to the one
// visible button, that the Pending control clicked is the profile's own and the Withdraw
// pressed is the one inside LinkedIn's native <dialog>, that typed text really lands in a
// contenteditable, that Shift+Enter makes a line break instead of sending.
//
// The markup mirrors what LinkedIn served on 2026-10-09, including its hidden duplicates.
//
// Opt-in, because it takes over a minute (the steps pause like a person does) and needs a
// browser:  npx playwright install chromium && npm run test:browser
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import {
  AlreadyConnectedError, ConnectUnavailableError, InviteBlockedError, PendingInviteError, sendConnectionRequest,
} from "@/lib/linkedin/connect";
import { NotConnectedError, RecipientRepliedError, RecipientMismatchError, sendMessage } from "@/lib/linkedin/message";
import { NoPendingInviteError, WithdrawUnconfirmedError, withdrawInvitation } from "@/lib/linkedin/withdraw";
import { visitProfile } from "@/lib/linkedin/visit";
import { SessionExpiredError } from "@/lib/linkedin/navigation";
import { readProfileCard, readWithdrawDialog } from "@/lib/linkedin/dom";

const enabled = process.env.LINKEDIN_BROWSER_TESTS === "1"
  && (() => { try { return fs.existsSync(chromium.executablePath()); } catch { return false; } })();

const ID = "ACoAAAexampleMemberId00000";
const VANITY = "jordan-reyes";
const PROFILE = `https://www.linkedin.com/in/${VANITY}/`;
const HIDE = 'style="display:none"';

/** The stand-in's state. Tests set it up; the pages' own scripts and the routes change it. */
interface Site {
  /** `menu` / `pending-menu`: Connect, or Pending, is only inside the More menu.
   *  `withdrawn`: an invitation was withdrawn, and LinkedIn is not taking another yet. */
  relation: "connectable" | "menu" | "pending" | "pending-menu" | "withdrawn" | "connected" | "follow-only";
  signedOut: boolean;
  /** Messages already in the conversation: who wrote them, and the text. */
  history: Array<{ from: "me" | "them"; text: string }>;
  /** Member id the conversation header links to (set to someone else to simulate a mix-up). */
  threadParticipant: string;
  sendsInvite: boolean;
  invitesSent: Array<{ note: string | null }>;
  messagesSent: string[];
  notesRemaining: number;
  /** LinkedIn acts on Withdraw (false: it closes the confirmation and does nothing). */
  withdraws: boolean;
  /** The withdrawal is still there on the next load. False is what live LinkedIn did on
   *  2026-10-09: a success toast and a Connect button, then Pending again after a reload. */
  withdrawalHolds: boolean;
  withdrawals: number;
  /** Which Pending controls were clicked: the top card's, the sticky header's, the menu's. */
  pendingClicks: string[];
  /** Who the withdraw confirmation names (set to someone else to simulate a mix-up). */
  confirmationFor: string;
}
let site: Site;

const compose = `/messaging/compose/?profileUrn=urn%3Ali%3Afsd_profile%3A${ID}&recipient=${ID}&screenContext=NON_SELF_PROFILE_VIEW&interop=msgOverlay`;
const connectLink = (extra = "") =>
  `<a ${extra} aria-label="Invite Jordan Reyes to connect" href="/preload/custom-invite/?vanityName=${VANITY}" componentkey="ConnectButtonstate:invitation:urn:li:member:100000003_connect">Connect</a>`;

const PENDING_KEY = "ConnectButtonstate:invitation:urn:li:member:100000003_pending";
// As LinkedIn renders it: an anchor whose href goes nowhere useful, handled by script.
const pendingLink = (where: string, extra = "") =>
  `<a ${extra} data-where="${where}" aria-label="Pending, click to withdraw invitation sent to Jordan Reyes" href="https://www.linkedin.com/" componentkey="${PENDING_KEY}"><span>Pending</span></a>`;

const WITHDRAWN_KEY = "ConnectButtonstate:invitation:urn:li:member:100000003_withdrawn";
// After a withdrawal: a Connect button in a "withdrawn" state, with no invitation link.
const withdrawnButton = (extra = "") =>
  `<button ${extra} type="button" componentkey="${WITHDRAWN_KEY}" aria-label="Invite Jordan Reyes to connect"><span><span>Connect</span></span></button>`;

/** LinkedIn's withdraw confirmation, as served on 2026-10-09: a native <dialog>, no ARIA role. */
function confirmationHtml(): string {
  return `<button type="button" aria-label="Dismiss"><span></span></button>
    <div><header id="dialog-header"><h2>Withdraw invitation</h2></header>
      <div data-testid="dialog-content"><div data-sdui-screen="com.linkedin.sdui.flagshipnav.mynetwork.invitations.WithdrawConfirmationDialog"><div>
        <p>If you withdraw now, you won’t be able to resend to this person for up to 3 weeks.</p><hr role="presentation">
        <div><button type="button" id="cancel"><span><span>Cancel</span></span></button>
          <div data-display-contents="true"><button type="button" id="confirm" componentkey="3f2b6c1e-0000-4000-8000-000000000001" aria-label="Withdraw invitation sent to ${site.confirmationFor}"><span><span>Withdraw</span></span></button></div></div>
      </div></div></div>
    </div>
    <section><h2 data-testid="toasts-title">0 notifications</h2></section>`;
}

function profileHtml(): string {
  const degree = site.relation === "connected" ? "1st" : "2nd";
  const action =
    site.relation === "connectable" ? connectLink() :
    site.relation === "pending" ? pendingLink("card") + pendingLink("hidden", HIDE) :
    site.relation === "withdrawn" ? withdrawnButton() + withdrawnButton(HIDE) :
    site.relation === "connected" ? "" : `<button aria-label="Follow Jordan Reyes">Follow</button>`;
  const menuItems =
    site.relation === "menu" ? `<a role="menuitem" href="/preload/custom-invite/?vanityName=${VANITY}" componentkey="ConnectButtonstate:invitation:urn:li:member:100000003_connect">Connect</a>` :
    site.relation === "pending-menu" ? `<a role="menuitem" data-where="menu" href="https://www.linkedin.com/" componentkey="${PENDING_KEY}">Pending</a>` :
    site.relation === "connected" ? `<div role="menuitem">Remove connection</div>` : "";
  return `<!doctype html><title>Jordan Reyes | LinkedIn</title>
    <div class="sticky"><button>More</button><a href="${compose}">Message</a>${site.relation === "pending" ? pendingLink("sticky") : ""}</div>
    <main>
      <div componentkey="com.linkedin.sdui.profile.card.ref${ID}Topcard"><section>
        <h2>Jordan Reyes</h2>
        <p ${HIDE}>· 1st</p><p>· ${degree}</p>
        <a href="${compose}">Message</a>
        ${action}
        ${site.relation === "connectable" ? connectLink(HIDE) : ""}
        <button type="button" id="more" aria-expanded="false"><span><span>More</span></span></button>
        <button aria-label="More" ${HIDE}></button>
      </section></div>
      <section><h2>People you may know</h2>
        <button componentkey="ConnectButtonstate:invitation:urn:li:member:1_connect" aria-label="Invite Someone Else to connect">Connect</button>
        <a data-where="suggestion" aria-label="Pending, click to withdraw invitation sent to Yet Another" href="https://www.linkedin.com/" componentkey="ConnectButtonstate:invitation:urn:li:member:2_pending"><span>Pending</span></a>
      </section>
    </main>
    <section id="toasts"><h2 data-testid="toasts-title">0 notifications</h2></section>
    <script>
      // Pending opens the confirmation in the page; Withdraw acts without a navigation.
      document.addEventListener("click", (e) => {
        const pending = e.target.closest('[componentkey$="_pending"]');
        if (!pending) return;
        e.preventDefault();
        fetch("/__pending-click", { method: "POST", body: pending.dataset.where });
        document.querySelector("[role=menu]")?.parentElement.remove();
        if (document.querySelector("dialog")) return;
        const sheet = document.createElement("dialog");
        sheet.setAttribute("data-testid", "dialog");
        sheet.setAttribute("aria-labelledby", "dialog-header");
        sheet.innerHTML = ${JSON.stringify(confirmationHtml())};
        document.body.appendChild(sheet);
        sheet.showModal();
        sheet.querySelector("#cancel").onclick = () => sheet.remove();
        sheet.querySelector("#confirm").onclick = async () => {
          const { withdrawn } = await (await fetch("/__withdraw", { method: "POST" })).json();
          sheet.remove();
          if (!withdrawn) return;
          document.querySelectorAll('[componentkey="${PENDING_KEY}"]').forEach((el) => {
            el.setAttribute("componentkey", "${WITHDRAWN_KEY}");
            el.setAttribute("aria-label", "Invite Jordan Reyes to connect");
            el.removeAttribute("href");
            el.textContent = "Connect";
          });
          const toasts = document.getElementById("toasts");
          toasts.querySelector("h2").textContent = "1 notification";
          toasts.insertAdjacentHTML("beforeend", '<div style="opacity: 1"><div tabindex="0" aria-hidden="false"><div role="alert"><div><div><p>Invitation to Jordan withdrawn.</p></div><button type="button" aria-label="Dismiss"><span></span></button></div></div></div></div>');
        };
      });
      document.getElementById("more").addEventListener("click", () => {
        if (document.querySelector("[role=menu]")) return;
        const portal = document.createElement("div");
        portal.innerHTML = '<div role="menu"><div role="menuitem">Save to PDF</div>${menuItems.replace(/'/g, "\\'")}<a role="menuitem" href="${PROFILE}">Report Jordan</a></div>';
        document.body.appendChild(portal);
      });
      document.addEventListener("keydown", (e) => { if (e.key === "Escape") document.querySelector("[role=menu]")?.parentElement.remove(); });
    </script>`;
}

function inviteHtml(): string {
  return `<!doctype html><title>LinkedIn</title><main></main>
    <div role="dialog" aria-labelledby="send-invite-modal">
      <div id="first">
        <h2 id="send-invite-modal">Add a note to your invitation?</h2>
        <button aria-label="Dismiss"></button>
        <button aria-label="Add a note" id="add">Add a note</button>
        <button aria-label="Send without a note" id="plain">Send without a note</button>
      </div>
      <div id="note" hidden>
        <h2>Add a note to your invitation</h2>
        <p>${site.notesRemaining} personalized invitations remaining for this month.</p>
        <textarea id="custom-message" name="message"></textarea><span id="count">0/200</span>
        <button aria-label="Cancel adding a note" id="cancel">Cancel</button>
        <button aria-label="Send invitation" id="send" disabled>Send</button>
      </div>
    </div>
    <script>
      const first = document.getElementById("first"), note = document.getElementById("note"), box = document.getElementById("custom-message"), send = document.getElementById("send");
      document.getElementById("add").onclick = () => { first.hidden = true; note.hidden = false; };
      document.getElementById("cancel").onclick = () => { note.hidden = true; first.hidden = false; };
      box.addEventListener("input", () => { send.disabled = box.value.trim() === ""; document.getElementById("count").textContent = box.value.length + "/200"; });
      const submit = async (text) => { await fetch("/__invite", { method: "POST", body: JSON.stringify({ note: text }) }); location.href = "${PROFILE}"; };
      document.getElementById("plain").onclick = () => submit(null);
      send.onclick = () => submit(box.value);
    </script>`;
}

function threadHtml(): string {
  const events = site.history.map((m) =>
    `<li><div class="msg-s-event-listitem${m.from === "them" ? " msg-s-event-listitem--other" : ""}"><p class="msg-s-event-listitem__body">${m.text}</p></div></li>`).join("");
  return `<!doctype html><title>Messaging | LinkedIn</title>
    <main>
      <div class="msg-conversations-container"><ul><li class="msg-conversation-listitem"><h3 class="msg-conversation-listitem__participant-names">Somebody Else</h3></li></ul></div>
      <div class="msg-thread">
        <a class="msg-thread__link-to-profile" href="https://www.linkedin.com/in/${site.threadParticipant}"><h2 class="msg-entity-lockup__entity-title">Jordan Reyes</h2></a>
        <div class="msg-s-message-list"><ul id="events">${events}</ul></div>
        <form class="msg-form" onsubmit="return false">
          <div class="msg-form__contenteditable" role="textbox" contenteditable="true" aria-multiline="true" aria-label="Write a message…" style="min-height:40px;width:400px"><p><br></p></div>
          <button class="msg-form__send-button" type="submit" disabled>Send</button>
        </form>
      </div>
    </main>
    <script>
      const box = document.querySelector(".msg-form__contenteditable"), send = document.querySelector(".msg-form__send-button");
      box.addEventListener("input", () => { send.disabled = box.innerText.trim() === ""; });
      // A bare Enter sends, as on LinkedIn. The step must never cause this.
      box.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); fetch("/__bare-enter", { method: "POST" }); } });
      send.addEventListener("click", async () => {
        const text = box.innerText;
        await fetch("/__message", { method: "POST", body: JSON.stringify({ text }) });
        const li = document.createElement("li");
        li.innerHTML = '<div class="msg-s-event-listitem"><p class="msg-s-event-listitem__body"></p></div>';
        li.querySelector("p").innerText = text;
        document.getElementById("events").appendChild(li);
        box.innerHTML = "<p><br></p>"; send.disabled = true;
      });
    </script>`;
}

let browser: Browser;
let context: BrowserContext;
let page: Page;
let bareEnters = 0;

describe.skipIf(!enabled)("LinkedIn steps in a real browser", () => {
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const html = (body: string) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body });
      if (url.hostname !== "www.linkedin.com") return route.abort();

      if (site.signedOut && request.isNavigationRequest()) {
        if (url.pathname.startsWith("/login")) return html("<!doctype html><title>Sign in</title><main><h1>Sign in</h1></main>");
        return route.fulfill({ status: 302, headers: { location: "https://www.linkedin.com/login/?session_redirect=x" } });
      }
      if (url.pathname === "/__invite") {
        if (site.sendsInvite) { site.invitesSent.push(JSON.parse(request.postData() ?? "{}")); site.relation = "pending"; }
        return route.fulfill({ status: 200, body: "ok" });
      }
      if (url.pathname === "/__message") {
        const { text } = JSON.parse(request.postData() ?? "{}");
        site.messagesSent.push(text);
        site.history.push({ from: "me", text });
        return route.fulfill({ status: 200, body: "ok" });
      }
      if (url.pathname === "/__bare-enter") { bareEnters++; return route.fulfill({ status: 200, body: "ok" }); }
      if (url.pathname === "/__pending-click") { site.pendingClicks.push(request.postData() ?? ""); return route.fulfill({ status: 200, body: "ok" }); }
      if (url.pathname === "/__withdraw") {
        if (site.withdraws && site.withdrawalHolds) { site.withdrawals++; site.relation = site.relation === "pending-menu" ? "follow-only" : "withdrawn"; }
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ withdrawn: site.withdraws }) });
      }
      if (url.pathname.startsWith(`/in/${VANITY}`)) return html(profileHtml());
      if (url.pathname.startsWith("/preload/custom-invite")) return html(inviteHtml());
      if (url.pathname.startsWith("/messaging/compose")) return html(threadHtml());
      return route.fulfill({ status: 404, contentType: "text/html", body: "<!doctype html><main><h1>Not found</h1></main>" });
    });
  }, 60_000);

  afterAll(async () => { await browser?.close(); });

  beforeEach(async () => {
    site = {
      relation: "connectable", signedOut: false, history: [], threadParticipant: ID,
      sendsInvite: true, invitesSent: [], messagesSent: [], notesRemaining: 3,
      withdraws: true, withdrawalHolds: true, withdrawals: 0, pendingClicks: [], confirmationFor: "Jordan Reyes",
    };
    bareEnters = 0;
    await page?.close().catch(() => {});
    page = await context.newPage();
  });

  describe("connect", () => {
    it("sends from a profile whose main action is Connect", async () => {
      await expect(sendConnectionRequest(page, "http://linkedin.com/in/jordan-reyes")).resolves.toEqual({ noteSent: false, noteSkipped: null });
      expect(site.invitesSent).toEqual([{ note: null }]);
      expect((await readProfileCard(page)).relation).toBe("pending");
    }, 60_000);

    it("opens the More menu when Connect is only in there — the production failure", async () => {
      site.relation = "menu";
      // What the old step waited 30 seconds for and never found.
      await page.goto(PROFILE);
      expect(await page.locator('button[aria-label="More"]:visible').count()).toBe(0);

      await sendConnectionRequest(page, PROFILE);
      expect(site.invitesSent).toHaveLength(1);
    }, 60_000);

    it("attaches a note", async () => {
      await expect(sendConnectionRequest(page, PROFILE, { note: "Enjoyed your piece on CX." })).resolves.toEqual({ noteSent: true, noteSkipped: null });
      expect(site.invitesSent).toEqual([{ note: "Enjoyed your piece on CX." }]);
    }, 60_000);

    it("sends without a note that is too long, rather than a cut-off one", async () => {
      const outcome = await sendConnectionRequest(page, PROFILE, { note: "x".repeat(240) });
      expect(outcome.noteSent).toBe(false);
      expect(outcome.noteSkipped).toMatch(/240 characters/);
      expect(site.invitesSent).toEqual([{ note: null }]);
    }, 60_000);

    it("sends without a note when the month's quota is spent", async () => {
      site.notesRemaining = 0;
      const outcome = await sendConnectionRequest(page, PROFILE, { note: "Hello" });
      expect(outcome).toEqual({ noteSent: false, noteSkipped: "this account has no personalised invitations left this month" });
      expect(site.invitesSent).toEqual([{ note: null }]);
    }, 60_000);

    it("reports failure when the invitation does not go through", async () => {
      site.sendsInvite = false; // LinkedIn swallows the click
      await expect(sendConnectionRequest(page, PROFILE)).rejects.toThrow(/did not confirm the invitation/);
    }, 90_000);

    it("recognises pending, connected and not-connectable profiles without sending", async () => {
      site.relation = "pending";
      await expect(sendConnectionRequest(page, PROFILE)).rejects.toBeInstanceOf(PendingInviteError);
      site.relation = "connected";
      await expect(sendConnectionRequest(page, PROFILE)).rejects.toBeInstanceOf(AlreadyConnectedError);
      site.relation = "follow-only";
      await expect(sendConnectionRequest(page, PROFILE)).rejects.toBeInstanceOf(ConnectUnavailableError);
      expect(site.invitesSent).toEqual([]);
    }, 90_000);

    it("reports a signed-out session", async () => {
      site.signedOut = true;
      await expect(sendConnectionRequest(page, PROFILE)).rejects.toBeInstanceOf(SessionExpiredError);
    }, 60_000);
  });

  describe("withdraw", () => {
    beforeEach(() => { site.relation = "pending"; });

    it("withdraws through the profile's own Pending control and LinkedIn's confirmation", async () => {
      // What the role-based dialog selector would have waited for and never found.
      await page.goto(PROFILE);
      await page.locator('[data-where="card"]').click();
      expect(await page.locator('[role="dialog"], [role="alertdialog"]').count()).toBe(0);
      expect(await readWithdrawDialog(page)).toMatchObject({ open: true, canWithdraw: true, recipient: "Jordan Reyes" });
      await page.locator("dialog #cancel").click();
      site.pendingClicks = [];

      await expect(withdrawInvitation(page, "http://linkedin.com/in/jordan-reyes")).resolves.toBeUndefined();

      expect(site.withdrawals).toBe(1);
      // Three visible Pending controls on the page — sticky header, top card, a suggested
      // member's — and a hidden duplicate. Only the top card's was clicked.
      expect(site.pendingClicks).toEqual(["card"]);
      expect(await readProfileCard(page)).toMatchObject({ relation: "unknown", inviteBlocked: true });

      // What comes next for that member: nothing left to withdraw, and no new invitation yet.
      const again = await withdrawInvitation(page, PROFILE).catch((e) => e);
      expect(again).toBeInstanceOf(NoPendingInviteError);
      expect((again as NoPendingInviteError).alreadyWithdrawn).toBe(true);
      await expect(sendConnectionRequest(page, PROFILE)).rejects.toBeInstanceOf(InviteBlockedError);
      expect(site.withdrawals).toBe(1);
      expect(site.invitesSent).toEqual([]);
    }, 90_000);

    it("withdraws when Pending is only inside the More menu", async () => {
      site.relation = "pending-menu";
      await expect(withdrawInvitation(page, PROFILE)).resolves.toBeUndefined();
      expect(site.withdrawals).toBe(1);
      expect(site.pendingClicks).toEqual(["menu"]);
    }, 60_000);

    it("leaves a confirmation that names someone else unconfirmed", async () => {
      site.confirmationFor = "Yet Another";
      await expect(withdrawInvitation(page, PROFILE)).rejects.toThrow(/is for Yet Another, not Jordan Reyes/);
      expect(site.withdrawals).toBe(0);
      expect((await readWithdrawDialog(page)).open).toBe(true); // Withdraw was never pressed
    }, 60_000);

    it("reports failure when the invitation is still pending afterwards", async () => {
      site.withdraws = false; // LinkedIn closes the confirmation and does nothing
      const error = await withdrawInvitation(page, PROFILE).catch((e) => e);
      expect(error.message).toMatch(/did not confirm the withdrawal/);
      expect(error).not.toBeInstanceOf(WithdrawUnconfirmedError);
      expect(site.withdrawals).toBe(0);
    }, 90_000);

    it("does not believe LinkedIn's own success message when the invitation is still there on reload", async () => {
      // The page says "Invitation to Jordan withdrawn." and shows Connect; the next load says Pending.
      site.withdrawalHolds = false;
      const error = await withdrawInvitation(page, PROFILE).catch((e) => e);
      expect(error).toBeInstanceOf(WithdrawUnconfirmedError);
      expect(error.message).toContain('"Invitation to Jordan withdrawn."');
      expect(site.pendingClicks).toEqual(["card"]);
      expect((await readProfileCard(page)).relation).toBe("pending");
    }, 90_000);

    it("recognises profiles with nothing to withdraw, an acceptance, and a signed-out session", async () => {
      site.relation = "connectable";
      await expect(withdrawInvitation(page, PROFILE)).rejects.toBeInstanceOf(NoPendingInviteError);
      site.relation = "menu";
      await expect(withdrawInvitation(page, PROFILE)).rejects.toBeInstanceOf(NoPendingInviteError);
      site.relation = "connected";
      await expect(withdrawInvitation(page, PROFILE)).rejects.toBeInstanceOf(AlreadyConnectedError);
      expect(site.pendingClicks).toEqual([]);
      site.relation = "pending";
      site.signedOut = true;
      await expect(withdrawInvitation(page, PROFILE)).rejects.toBeInstanceOf(SessionExpiredError);
      expect(site.withdrawals).toBe(0);
    }, 90_000);
  });

  describe("message", () => {
    beforeEach(() => { site.relation = "connected"; });

    it("delivers a multi-line message without ever pressing a bare Enter", async () => {
      const text = "Thanks for connecting, Jordan.\n\nWorth a look, or not a live topic right now?";
      await expect(sendMessage(page, PROFILE, text)).resolves.toBe("sent");

      expect(site.messagesSent).toHaveLength(1);
      expect(site.messagesSent[0].replace(/\s+/g, " ").trim()).toBe(text.replace(/\s+/g, " "));
      expect(site.messagesSent[0]).toMatch(/Jordan\.\s*\n[\s\S]*Worth/); // the line break survived
      expect(bareEnters).toBe(0);
    }, 60_000);

    it("refuses a member who is not a connection, although their profile has a Message button", async () => {
      site.relation = "pending";
      await expect(sendMessage(page, PROFILE, "Hi")).rejects.toBeInstanceOf(NotConnectedError);
      expect(site.messagesSent).toEqual([]);
    }, 60_000);

    it("refuses when the conversation that opens belongs to someone else", async () => {
      site.threadParticipant = "ACoAAsomeoneElse";
      await expect(sendMessage(page, PROFILE, "Hi")).rejects.toBeInstanceOf(RecipientMismatchError);
      expect(site.messagesSent).toEqual([]);
    }, 60_000);

    it("stops when the contact has replied", async () => {
      site.history = [{ from: "me", text: "Thanks for connecting" }, { from: "them", text: "Sure, send details" }];
      await expect(sendMessage(page, PROFILE, "Following up")).rejects.toBeInstanceOf(RecipientRepliedError);
      expect(site.messagesSent).toEqual([]);
    }, 60_000);

    it("does not send the same message twice", async () => {
      await sendMessage(page, PROFILE, "Thanks for connecting, Jordan.");
      await expect(sendMessage(page, PROFILE, "Thanks for connecting, Jordan.")).resolves.toBe("already-sent");
      expect(site.messagesSent).toHaveLength(1);
    }, 60_000);
  });

  describe("visit", () => {
    it("visits a profile, and reports a signed-out session instead of a visit", async () => {
      await expect(visitProfile(page, PROFILE)).resolves.toBeUndefined();
      site.signedOut = true;
      await expect(visitProfile(page, PROFILE)).rejects.toBeInstanceOf(SessionExpiredError);
    }, 60_000);
  });
});
