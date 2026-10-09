import type { Page } from "playwright";
import { pollUntil, readMessageThread, waitForProfileCard, type MessageThread, type Relation } from "@/lib/linkedin/dom";
import { gotoLinkedin, throwIfSignedOut } from "@/lib/linkedin/navigation";
import { absoluteLinkedinUrl, canonicalLinkedinUrl, profileVanity } from "@/lib/linkedin/url";

/** The member is not a first-degree connection, so LinkedIn will not deliver a message. */
export class NotConnectedError extends Error {
  constructor(readonly relation: Relation, readonly degree: number | null) {
    super(relation === "pending" ? "Connection request is still pending" : "Not connected on LinkedIn");
  }
}

/** The conversation already holds a message from the other person. */
export class RecipientRepliedError extends Error {
  constructor(readonly lastMessage: string) {
    super("Contact has already replied on LinkedIn");
  }
}

/** The open conversation could not be proven to be with the intended member. Nothing was sent. */
export class RecipientMismatchError extends Error {}

/**
 * Send was pressed but the message never showed up in the conversation. It may or may not
 * have been delivered, so this must NOT be retried automatically — a blind retry is how a
 * contact ends up with the same message twice.
 */
export class MessageUnconfirmedError extends Error {}

/**
 * Send a LinkedIn message to one specific member, and return only once it is in the thread.
 *
 * The recipient is chosen by identity, not by name. The previous version opened a blank
 * "new message", typed the contact's full name into the search box and took the first
 * result — so a namesake among the sender's connections would have received the message,
 * and nothing checked. This version starts from the member's own profile and follows
 * LinkedIn's Message link, which carries that member's profile URN; where the conversation
 * already exists, its header must link back to the same member id before anything is typed.
 *
 * It also reads the thread first. If the other person has written anything, it stops with
 * {@link RecipientRepliedError}: an automated follow-up into a conversation they have
 * answered is the mistake this product must never make, and LinkedIn replies are not
 * detected anywhere else.
 *
 * Returns `already-sent` without typing anything when the last message in the thread is
 * already this exact text from us — the trace left by an earlier attempt that delivered
 * but could not be confirmed.
 */
export async function sendMessage(page: Page, linkedinUrl: string, text: string): Promise<"sent" | "already-sent"> {
  if (!profileVanity(linkedinUrl)) throw new Error(`Not a LinkedIn profile URL: ${linkedinUrl}`);
  const body = text.replace(/\r\n?/g, "\n").trim();
  if (!body) throw new Error("Message is empty");

  await gotoLinkedin(page, canonicalLinkedinUrl(linkedinUrl));
  await page.waitForTimeout(1500 + Math.random() * 1500);

  const card = await waitForProfileCard(page);
  if (!card.found) {
    throwIfSignedOut(page);
    throw new Error(`LinkedIn profile did not load (${card.reason ?? "unknown"})`);
  }
  // A non-connection's profile has a Message button too — it opens InMail. Degree decides.
  if (card.relation !== "connected") throw new NotConnectedError(card.relation, card.degree);
  if (!card.messageHref) throw new Error("This profile has no Message action");

  await gotoLinkedin(page, composeUrl(card.messageHref));
  const thread = await pollUntil(page, readMessageThread, (t) => t.ready, 20_000);
  if (!thread.ready) {
    throwIfSignedOut(page);
    throw new Error("LinkedIn's message box did not open");
  }
  assertRecipient(thread, card.profileId, card.name);
  if (thread.inboundCount > 0) throw new RecipientRepliedError(thread.lastMessageText);
  if (thread.messageCount > 0 && sameText(thread.lastMessageText, body)) return "already-sent";

  const box = page.locator('div.msg-form__contenteditable:visible, [role="textbox"][contenteditable="true"]:visible').first();
  await box.click();
  const holdsMessage = (t: MessageThread) => t.sendEnabled && sameText(t.draft, body);
  await typeMessage(page, body, "insert");
  let drafted = await pollUntil(page, readMessageThread, holdsMessage, 4_000, 250);
  if (!sameText(drafted.draft, body)) {
    // The editor ignored the inserted text. Clear whatever landed and type it key by key.
    await box.click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("Backspace");
    await typeMessage(page, body, "keys");
    drafted = await pollUntil(page, readMessageThread, holdsMessage, 5_000, 250);
  }
  if (!sameText(drafted.draft, body)) throw new Error("The message box does not hold the message that was typed — not sending");
  if (!drafted.sendEnabled) throw new Error("LinkedIn's Send button stayed disabled — not sending");

  await page.locator("button.msg-form__send-button:visible").first().click({ timeout: 8_000 });

  // Sent means: one more message in the thread, ours, last, and the box is empty again.
  const sent = await pollUntil(
    page, readMessageThread,
    (t) => t.messageCount > thread.messageCount && !t.lastMessageInbound && t.draft === "",
    12_000,
  );
  if (sent.messageCount <= thread.messageCount || sent.lastMessageInbound) {
    throw new MessageUnconfirmedError("Send was pressed but LinkedIn did not show the message in the conversation — check the thread before retrying");
  }
  // Once a first message lands, a new conversation gains its header — check it was the right one.
  assertRecipient(sent, card.profileId, card.name);
  return "sent";
}

/** LinkedIn's Message link, made absolute and pointed at the full messaging page rather
 *  than the chat overlay (`interop=msgOverlay` opens a bubble on top of the profile). */
function composeUrl(messageHref: string): string {
  const url = new URL(absoluteLinkedinUrl(messageHref));
  url.searchParams.delete("interop");
  return url.toString();
}

/**
 * Refuse to proceed unless the open conversation is provably with the intended member.
 *
 * An existing conversation links to its participant by member id, which is compared
 * directly. A brand-new one has no such link yet, so the recipient shown in the compose
 * pane must be the member whose profile we came from.
 */
function assertRecipient(thread: MessageThread, profileId: string | null, name: string | null): void {
  if (thread.participantId) {
    if (profileId && thread.participantId !== profileId) {
      throw new RecipientMismatchError(`The open conversation is with a different member (${thread.participantId}), not ${name ?? profileId}`);
    }
    if (profileId) return;
  }
  if (!name || !normalise(thread.paneText).includes(normalise(name))) {
    throw new RecipientMismatchError(`Could not confirm the conversation is with ${name ?? "the intended member"}`);
  }
}

/**
 * Put the message in the box without ever pressing a bare Enter, which sends.
 *
 * `insert` commits each line as a single input event — no per-key timing to get wrong and
 * no clipboard permission to depend on, which is what the old paste-based version needed
 * and silently lost in headless Chromium. `keys` types character by character, as the
 * fallback for an editor that ignores inserted text. Line breaks are always Shift+Enter,
 * LinkedIn's own shortcut for a new line.
 */
async function typeMessage(page: Page, body: string, mode: "insert" | "keys"): Promise<void> {
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]) {
      if (mode === "insert") await page.keyboard.insertText(lines[i]);
      else await page.keyboard.type(lines[i], { delay: 15 + Math.random() * 25 });
    }
    if (i < lines.length - 1) await page.keyboard.press("Shift+Enter");
    await page.waitForTimeout(80 + Math.random() * 120);
  }
}

const normalise = (value: string) => value.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
/** Compare what was typed with what the box holds, ignoring how line breaks are rendered. */
const sameText = (a: string, b: string) => normalise(a).replace(/ /g, "") === normalise(b).replace(/ /g, "");
