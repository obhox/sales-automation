/**
 * The numbers that pace invitations: how long one may stay unanswered, how many may be
 * withdrawn in a day, and how long LinkedIn blocks a new one afterwards.
 *
 * Apart from the runner so the stale-invitation clean-up reads the same values without
 * importing the campaign engine.
 */

export function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Days to keep waiting for a connection request to be accepted before giving up on the
// contact. Was 7. Measured against the account's real connections list in Oct 2026: of 16
// invitations that were accepted, 6 were accepted after day 7 (on days 15, 19, 32, 35, 35
// and 57), so a 7-day cutoff wrote off more than a third of the people who said yes.
// Waiting costs nothing — a recheck is a database read.
export const CONNECTION_MAX_WAIT_DAYS = positiveInt(process.env.LINKEDIN_ACCEPT_WAIT_DAYS, 30);

// Invitations a LinkedIn account may withdraw per day, whoever asks: a campaign giving up
// on a contact, the stale-invitation clean-up, or someone using the test endpoint. An
// invitation past the wait above is taken back rather than left in the account's sent list
// for good — LinkedIn caps how many can be pending, and a large unanswered backlog counts
// against the account. Kept small: withdrawing is housekeeping, and a burst of it is not
// how a person behaves.
export const DAILY_WITHDRAW_LIMIT = positiveInt(process.env.LINKEDIN_DAILY_WITHDRAW_LIMIT, 10);

// LinkedIn refuses a new invitation to a member for "up to 3 weeks" after one to them was
// withdrawn (its own wording on the withdraw confirmation). A connect step that meets such
// a contact waits this long from the withdrawal before inviting again. Trying sooner is
// worse than pointless: during the block the profile offers no Connect at all, which reads
// as a member who cannot be invited, and the contact would be written off for good.
export const REINVITE_BLOCK_DAYS = 21;
