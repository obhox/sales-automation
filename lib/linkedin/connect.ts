import type { Page } from "playwright";
import {
  TOP_CARD,
  pollUntil,
  readInviteDialog,
  readPageAlerts,
  readProfileCard,
  readProfileMenu,
  waitForProfileCard,
  type ProfileCard,
  type Relation,
} from "@/lib/linkedin/dom";
import { gotoLinkedin, throwIfSignedOut } from "@/lib/linkedin/navigation";
import { absoluteLinkedinUrl, canonicalLinkedinUrl, profileVanity } from "@/lib/linkedin/url";

export class WeeklyLimitError extends Error {}
export class AlreadyConnectedError extends Error {}
export class PendingInviteError extends Error {}
/** LinkedIn does not offer Connect for this member (follow-only, or it wants their email). */
export class ConnectUnavailableError extends Error {}
/**
 * LinkedIn is not taking a new invitation to this member yet, because an earlier one was
 * withdrawn (it says "up to 3 weeks"). Unlike the other reasons Connect can be unavailable
 * this one passes, so a caller can wait instead of giving up on the member.
 */
export class InviteBlockedError extends ConnectUnavailableError {}

export interface ConnectOptions {
  /** Personal note to attach. Empty or missing sends the invitation without one. */
  note?: string | null;
}

export interface ConnectOutcome {
  /** Whether the note was actually attached. */
  noteSent: boolean;
  /** Why a requested note was left off — the invitation still went out. */
  noteSkipped: string | null;
}

// LinkedIn's limit for a free account. The dialog reports the real one (200, or 300 on
// Premium); this is only the fallback for when it does not.
const DEFAULT_NOTE_LIMIT = 200;

/**
 * Send a LinkedIn connection request, and return only once LinkedIn shows it as pending.
 *
 * The flow is LinkedIn's own: read the profile, follow the member's invitation link
 * (`/preload/custom-invite/?vanityName=…` — the href of the Connect control wherever it
 * sits), and press send in the dialog that opens.
 *
 * Two things the previous version got wrong, both visible in production:
 *
 *  - Where Connect lives. On most profiles it is inside the More menu, and the visible More
 *    button carries no `aria-label`, so `button[aria-label="More"]` matched nothing and
 *    every such profile waited out a 30s timeout and was failed.
 *  - Whether it worked. If the send button was not found the function simply returned, so
 *    the runner logged "Connection request sent", stamped the contact and spent a daily
 *    slot on a request that never left. Now the profile must read Pending afterwards.
 *
 * Throws {@link AlreadyConnectedError} / {@link PendingInviteError} when the member is
 * already in that state, {@link WeeklyLimitError} at LinkedIn's weekly cap, and
 * {@link ConnectUnavailableError} when LinkedIn offers no way to invite them — as
 * {@link InviteBlockedError} when that is only because an invitation was withdrawn recently.
 */
export async function sendConnectionRequest(page: Page, linkedinUrl: string, opts: ConnectOptions = {}): Promise<ConnectOutcome> {
  if (!profileVanity(linkedinUrl)) throw new Error(`Not a LinkedIn profile URL: ${linkedinUrl}`);
  const profileUrl = canonicalLinkedinUrl(linkedinUrl);

  await gotoLinkedin(page, profileUrl);
  await page.waitForTimeout(1500 + Math.random() * 1500);

  const { card, relation, inviteHref } = await readRelation(page);
  if (relation === "connected") throw new AlreadyConnectedError("Already connected");
  if (relation === "pending") throw new PendingInviteError("Invitation already pending");
  if (!inviteHref && card.inviteBlocked) {
    throw new InviteBlockedError("An invitation to this member was withdrawn recently — LinkedIn is not taking a new one yet");
  }
  if (!inviteHref) throw new ConnectUnavailableError("LinkedIn does not offer Connect on this profile");

  await gotoLinkedin(page, absoluteLinkedinUrl(inviteHref));
  const dialog = await pollUntil(
    page, readInviteDialog,
    (d) => d.open && (d.canSendWithoutNote || d.canAddNote || d.weeklyLimitReached || d.emailRequired),
    15_000,
  );
  if (dialog.weeklyLimitReached) throw new WeeklyLimitError("Weekly connection limit reached");
  if (dialog.emailRequired) throw new ConnectUnavailableError("LinkedIn requires this member's email address to connect");
  if (!dialog.open) throw new Error("LinkedIn's invitation dialog did not open");
  if (!dialog.canSendWithoutNote && !dialog.canAddNote) {
    throw new Error(`Invitation dialog has no send option: "${dialog.text.slice(0, 120)}"`);
  }

  const note = (opts.note ?? "").trim();
  const outcome: ConnectOutcome = { noteSent: false, noteSkipped: null };
  if (note) outcome.noteSkipped = await tryAddNote(page, note, dialog.canAddNote);
  outcome.noteSent = note !== "" && outcome.noteSkipped === null;

  // Scoped to the dialog and to LinkedIn's own label for each button, so a look-alike
  // elsewhere on the page can never be the thing that gets clicked.
  const sendLabel = outcome.noteSent ? "Send invitation" : "Send without a note";
  await page.locator(`[role="dialog"] button[aria-label="${sendLabel}"]:visible`).first().click({ timeout: 10_000 });
  await page.waitForTimeout(1500);

  const alerts = await readPageAlerts(page);
  if (alerts.weeklyLimitReached) throw new WeeklyLimitError("Weekly connection limit reached");
  if (alerts.error) throw new Error(`LinkedIn rejected the invitation: ${alerts.error}`);

  await confirmPending(page, profileUrl);
  return outcome;
}

export interface ProfileRelation {
  card: ProfileCard;
  relation: Relation;
  /** LinkedIn's invitation link for this member, when they can be invited. */
  inviteHref: string | null;
  /** Where the answer was found: on the top card, or inside its More menu. */
  via: "card" | "menu";
}

/**
 * Where the member on the open profile page stands: connected, pending, or connectable.
 * Looks at the top card first and opens the More menu only when the card does not say.
 * Read-only — it opens a menu and closes it again.
 */
export async function readRelation(page: Page): Promise<ProfileRelation> {
  const card = await waitForProfileCard(page);
  if (!card.found) {
    throwIfSignedOut(page); // LinkedIn can bounce to the sign-in page after the first paint
    throw new Error(`LinkedIn profile did not load (${card.reason ?? "unknown"})`);
  }
  if (card.relation !== "unknown" || !card.hasMoreMenu) {
    return { card, relation: card.relation, inviteHref: card.inviteHref, via: "card" };
  }

  const menu = await openMoreMenu(page);
  await page.keyboard.press("Escape").catch(() => {});
  if (!menu.open) throw new Error("The profile's More menu did not open");
  return { card, relation: menu.relation, inviteHref: menu.inviteHref, via: "menu" };
}

export async function openMoreMenu(page: Page) {
  // The top card holds one visible More button (labelled by its text) and hidden,
  // aria-labelled duplicates for other breakpoints; `:visible` is what tells them apart.
  const inCard = page.locator(TOP_CARD).locator("button:visible");
  const anywhere = page.locator("main button:visible");
  const scope = (await page.locator(TOP_CARD).count()) > 0 ? inCard : anywhere;
  const more = scope.filter({ hasText: /^\s*More\s*$/ }).or(scope.and(page.locator('button[aria-label="More"]'))).first();
  await more.click({ timeout: 8_000 });
  return pollUntil(page, readProfileMenu, (m) => m.open && m.items.length > 0, 6_000, 250);
}

/**
 * Open the note field and type the note. Returns null when the note is in place, or the
 * reason it was left off — in which case the dialog is back on its first step and the
 * invitation goes out without one. A note is worth less than the invitation it rides on.
 */
async function tryAddNote(page: Page, note: string, canAddNote: boolean): Promise<string | null> {
  if (!canAddNote) return "LinkedIn did not offer a note on this invitation";

  await page.locator('[role="dialog"] button[aria-label="Add a note"]:visible').first().click({ timeout: 8_000 });
  const withField = await pollUntil(page, readInviteDialog, (d) => d.noteFieldOpen || !d.open, 6_000, 250);
  if (!withField.noteFieldOpen) {
    // Out of free notes: LinkedIn swaps the field for a Premium upsell. Start the dialog over.
    await page.reload({ waitUntil: "domcontentloaded" });
    await pollUntil(page, readInviteDialog, (d) => d.canSendWithoutNote, 15_000);
    return "this account has no personalised invitations left this month";
  }

  const limit = withField.noteLimit ?? DEFAULT_NOTE_LIMIT;
  const tooLong = note.length > limit;
  const exhausted = withField.notesRemaining !== null && withField.notesRemaining <= 0;
  if (!tooLong && !exhausted) {
    await page.locator('[role="dialog"] textarea[name="message"]:visible').first().fill(note);
    const typed = await pollUntil(page, readInviteDialog, (d) => d.noteSendEnabled, 4_000, 200);
    if (typed.noteSendEnabled) return null;
  }

  await page.locator('[role="dialog"] button[aria-label="Cancel adding a note"]:visible').first().click({ timeout: 5_000 });
  await pollUntil(page, readInviteDialog, (d) => d.canSendWithoutNote, 6_000, 250);
  if (tooLong) return `the note is ${note.length} characters and this account's limit is ${limit}`;
  if (exhausted) return "this account has no personalised invitations left this month";
  return "LinkedIn did not accept the note";
}

/**
 * The post-condition for a sent invitation: the member's profile reads Pending.
 *
 * Checked on whatever page LinkedIn left us on first, then on a fresh load of the profile.
 * A profile that still offers Connect after that means nothing was sent, and the caller
 * must not record a request.
 */
async function confirmPending(page: Page, profileUrl: string): Promise<void> {
  const settled = (card: ProfileCard) => card.relation === "pending" || card.relation === "connected";

  if (settled(await pollUntil(page, readProfileCard, settled, 6_000))) return;

  await gotoLinkedin(page, profileUrl);
  const card = await pollUntil(page, readProfileCard, (c) => c.found && (c.relation !== "unknown" || c.hasMoreMenu), 15_000);
  if (settled(card)) return;

  if (card.relation === "unknown" && card.hasMoreMenu) {
    const menu = await openMoreMenu(page).catch(() => null);
    await page.keyboard.press("Escape").catch(() => {});
    if (menu && (menu.relation === "pending" || menu.relation === "connected")) return;
  }
  throw new Error("LinkedIn did not confirm the invitation — the profile does not show it as pending");
}
