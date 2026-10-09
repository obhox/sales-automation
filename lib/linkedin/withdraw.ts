import type { Page } from "playwright";
import {
  TOP_CARD,
  pollUntil,
  readPageAlerts,
  readProfileCard,
  readWithdrawDialog,
  type WithdrawDialog,
} from "@/lib/linkedin/dom";
import { AlreadyConnectedError, openMoreMenu, readRelation } from "@/lib/linkedin/connect";
import { gotoLinkedin } from "@/lib/linkedin/navigation";
import { canonicalLinkedinUrl, profileVanity } from "@/lib/linkedin/url";

/** The profile shows no pending invitation, so there is nothing to withdraw. */
export class NoPendingInviteError extends Error {
  /** LinkedIn shows an invitation to this member as already withdrawn — by an earlier
   *  attempt that could not be confirmed, or by hand — rather than as never sent or declined. */
  constructor(readonly alreadyWithdrawn: boolean) {
    super(alreadyWithdrawn ? "The invitation to this member has already been withdrawn" : "No pending invitation on this profile");
  }
}

// LinkedIn's confirmation is a native <dialog> with no ARIA role (see dom.ts); the role
// forms are accepted too so the click looks exactly where the reader looked.
const CONFIRMATION = ':is(dialog[open], [role="dialog"], [role="alertdialog"])';
const PENDING_CONTROL = '[componentkey^="ConnectButtonstate"][componentkey$="_pending"]:visible, [aria-label^="Pending"]:visible';

/**
 * Withdraw the pending connection invitation to one member, and return only once their
 * profile no longer reads Pending.
 *
 * The flow is LinkedIn's own: on the member's profile the Pending control opens a "Withdraw
 * invitation" confirmation, and its Withdraw button takes the invitation back. LinkedIn then
 * refuses a new invitation to that member for up to three weeks (the confirmation says so),
 * which is the caller's to remember.
 *
 * It works from the profile rather than from the sent-invitations list because that list
 * holds hundreds of rows and loads lazily: a member who is not on screen there has not
 * necessarily accepted, and scrolling it to find one row is the slow, fragile way round.
 *
 * Two guards before the click that cannot be undone, and one after:
 *
 *  - the confirmation must name the member the Pending control named, so a dialog that
 *    belongs to anyone else on the page is never confirmed;
 *  - only the Withdraw button inside that confirmation is pressed, by LinkedIn's own label;
 *  - success is the profile, loaded afresh, no longer reading Pending. The click is handled
 *    in the page, so what the page shows straight after it is not yet LinkedIn's answer.
 *
 * Afterwards LinkedIn shows the profile's Connect control in a "withdrawn" state with no
 * invitation link behind it (seen live on 2026-10-09), which is how a later visit can tell
 * a withdrawn invitation from one that was never sent.
 *
 * Throws {@link NoPendingInviteError} when the profile shows no pending invitation, and
 * {@link AlreadyConnectedError} when the member has accepted in the meantime.
 */
export async function withdrawInvitation(page: Page, linkedinUrl: string): Promise<void> {
  if (!profileVanity(linkedinUrl)) throw new Error(`Not a LinkedIn profile URL: ${linkedinUrl}`);
  const profileUrl = canonicalLinkedinUrl(linkedinUrl);

  await gotoLinkedin(page, profileUrl);
  await page.waitForTimeout(1500 + Math.random() * 1500);

  const { card, relation, via } = await readRelation(page);
  if (relation === "connected") throw new AlreadyConnectedError("Already connected");
  if (relation !== "pending") throw new NoPendingInviteError(card.inviteBlocked);

  if (via === "menu") {
    // Pending sits where Connect did: inside the More menu, which readRelation closed again.
    await openMoreMenu(page);
    const items = page.locator('[role="menu"]:visible [role="menuitem"]:visible');
    await items.filter({ hasText: /^\s*Pending\s*$/ }).or(items.and(page.locator('[componentkey$="_pending"]'))).first().click({ timeout: 8_000 });
  } else {
    // The top card holds a visible Pending control and a hidden duplicate; the sticky
    // header and the suggestion rails hold others, which is why this is scoped to the card.
    const scope = (await page.locator(TOP_CARD).count()) > 0 ? page.locator(TOP_CARD) : page.locator("main");
    await scope.locator(PENDING_CONTROL).first().click({ timeout: 8_000 });
  }

  const dialog = await pollUntil(page, readWithdrawDialog, (d) => d.open && d.canWithdraw, 10_000, 250);
  if (!dialog.open) throw new Error("LinkedIn's withdraw confirmation did not open");
  if (!dialog.canWithdraw) throw new Error(`Withdraw confirmation has no usable Withdraw button: "${dialog.text.slice(0, 120)}"`);
  assertRecipient(dialog, card.pendingFor, card.name);
  await page.waitForTimeout(600 + Math.random() * 900);

  await page.locator(`${CONFIRMATION} button[aria-label^="Withdraw invitation sent to"]:visible`).first().click({ timeout: 10_000 });

  await confirmWithdrawn(page, profileUrl);
}

/**
 * Refuse to confirm unless the dialog is for the member whose profile this is.
 *
 * The Pending control and the dialog's Withdraw button carry the same LinkedIn wording
 * ("…invitation sent to <name>"), so the two names are compared exactly. Without a label on
 * the Pending control (it was a More-menu entry) the profile's own heading stands in, which
 * can differ from the label by a suffix, so that comparison allows one to contain the other.
 */
function assertRecipient(dialog: WithdrawDialog, pendingFor: string | null, name: string | null): void {
  const shown = normalise(dialog.recipient ?? "");
  const matches = pendingFor
    ? shown === normalise(pendingFor)
    : !!name && shown !== "" && (shown.includes(normalise(name)) || normalise(name).includes(shown));
  if (!matches) {
    throw new Error(`The withdraw confirmation is for ${dialog.recipient ?? "an unnamed member"}, not ${pendingFor ?? name ?? "this profile"} — nothing was withdrawn`);
  }
}

/**
 * The post-condition for a withdrawal: the member's profile, loaded afresh, is not Pending.
 *
 * Waits for the confirmation to close and the card to change first — navigating away the
 * instant Withdraw is pressed could cut the request off — then asks LinkedIn again. A
 * profile that still reads Pending after that means the invitation is still out, and the
 * caller must not record a withdrawal.
 */
async function confirmWithdrawn(page: Page, profileUrl: string): Promise<void> {
  const dialog = await pollUntil(page, readWithdrawDialog, (d) => !d.open, 8_000, 250);
  if (dialog.open) {
    const alerts = await readPageAlerts(page);
    await page.keyboard.press("Escape").catch(() => {});
    throw new Error(`LinkedIn did not act on Withdraw — the confirmation stayed open${alerts.error ? ` (${alerts.error})` : ""}`);
  }
  await pollUntil(page, readProfileCard, (c) => c.found && c.relation !== "pending", 6_000);
  await page.waitForTimeout(1500);

  for (let attempt = 0; attempt < 2; attempt++) {
    // One more look after a pause: LinkedIn can serve the old state for a moment.
    if (attempt > 0) await page.waitForTimeout(4_000);
    await gotoLinkedin(page, profileUrl);
    const { relation } = await readRelation(page);
    if (relation !== "pending") return;
  }
  throw new Error("LinkedIn did not confirm the withdrawal — the profile still shows the invitation as pending");
}

const normalise = (value: string) => value.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
