/**
 * True when this process must not run any background work: no campaign steps, no mail,
 * no mailbox reading, no webhooks. Set LINKI_RUNNER=off for a copy of the app that only
 * shows data (a database of demo data, or a production copy opened to rehearse an
 * upgrade), where acting on what is in the database would be wrong.
 *
 * Kept in a file of its own so that code which only needs to know the answer does not
 * have to import the runner, and with it the browser automation.
 */
export function runnerDisabled(): boolean {
  return process.env.LINKI_RUNNER === "off";
}
