// What targets.reply_kind can hold. The classifier (lib/community-replies.ts) writes the
// first five; the rest are from an earlier classifier and still sit on older contacts, so
// anything that counts replies has to know both.

/** A person answered, whatever they said. */
export const HUMAN_REPLY_KINDS = ["positive", "negative", "unsubscribe", "human_review", "human_reply", "not_interested"] as const;

/** A mailbox answered by itself: out-of-office and the like. */
export const AUTO_REPLY_KINDS = ["out_of_office", "ooo_followup", "substitute", "call_task"] as const;

/** A quoted, comma-separated list for an SQL IN (...). The values are fixed above, never user input. */
export function sqlList(kinds: readonly string[]): string {
  return kinds.map((kind) => `'${kind}'`).join(",");
}
