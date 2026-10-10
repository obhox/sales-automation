// Which LinkedIn account answers for a contact.
//
// A contact's connection state (degree, invitation sent, invitation withdrawn) is stored
// once, on the contact. In a workspace with several LinkedIn accounts that state is only
// true for one of them, so anything that reads an account's own lists on LinkedIn (its
// connections, its sent invitations) may only speak for that account's contacts.

/** SQL for the LinkedIn account that works a contact in a run: its own, or the run's (rp = run_profiles, r = runs). */
export const RUN_PROFILE_ACCOUNT = "COALESCE(rp.account_id, r.account_id)";

/**
 * SQL condition on `t` (targets), taking the account id twice: this account answers for
 * the contact. It does if it is the one that has written to them. If nobody has yet, it
 * does if it has them in a campaign.
 */
export const ACCOUNT_ANSWERS_FOR_CONTACT = `(t.linkedin_account_id = ? OR (t.linkedin_account_id IS NULL AND EXISTS (
    SELECT 1 FROM run_profiles rp JOIN runs r ON r.id = rp.run_id WHERE rp.target_id = t.id AND ${RUN_PROFILE_ACCOUNT} = ?)))`;
