import type DatabaseType from "better-sqlite3";
import { workflowTracks } from "@/lib/outreach/enroll";

type DB = DatabaseType.Database;

export interface SignalRuleRefs {
  list_id?: string | null;
  workflow_id?: string | null;
  account_id?: string | null;
  email_account_id?: string | null;
}

/**
 * Why a rule, as it stands, would do nothing or enrol nobody; null when it is fine.
 *
 * A rule fires quietly, long after it was written, so one that cannot work is refused when
 * it is saved and flagged where it is listed (a list, campaign or account it named may have
 * been deleted since). The conditions are the ones applySignalRules acts on.
 */
export function signalRuleProblem(db: DB, rule: SignalRuleRefs): string | null {
  if (!rule.list_id && !rule.workflow_id) return "Pick a list, a campaign, or both. A rule with neither does nothing.";
  if (!rule.workflow_id) return null;
  if (!rule.list_id) return "A rule that enrols contacts in a campaign needs a list as well: the campaign runs on that list.";
  // A campaign with LinkedIn steps is run from a LinkedIn account; one with none sends
  // from a mailbox. The same split a campaign started by hand goes by.
  if (workflowTracks(db, rule.workflow_id).includes("linkedin")) {
    return rule.account_id ? null : "This campaign has LinkedIn steps, so the rule needs a LinkedIn account to run it from.";
  }
  return rule.email_account_id ? null : "This campaign only sends email, so the rule needs a mailbox to send from.";
}
