// The words a conversation's state is written in. No imports, so the inbox screen and the
// server read the same lists.
//
// Before conversations existed this state sat on a reply, in other words: a status of
// open / pending / resolved / closed and a sentiment of positive / neutral / negative.
// Those are still accepted wherever a status or a sentiment is taken (the MCP tools, the
// export, a saved view made earlier) and read as the nearest of the new ones.

export const CONVERSATION_STATUSES = ["open", "snoozed", "closed"] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export const TEMPERATURES = ["hot", "warm", "cold"] as const;
export type Temperature = (typeof TEMPERATURES)[number];

export const VERDICTS = ["positive", "human_review", "out_of_office", "negative", "unsubscribe"] as const;
export type Verdict = (typeof VERDICTS)[number];

const OLD_STATUS: Record<string, ConversationStatus> = { pending: "snoozed", resolved: "closed" };
const OLD_SENTIMENT: Record<string, Temperature> = { positive: "hot", neutral: "warm", negative: "cold" };

/** A status in either vocabulary, as a conversation status. Null when it is neither. */
export function statusFrom(value: unknown): ConversationStatus | null {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if ((CONVERSATION_STATUSES as readonly string[]).includes(text)) return text as ConversationStatus;
  return OLD_STATUS[text] ?? null;
}

/** A temperature, or a sentiment in the old words, as a temperature. Null when it is neither. */
export function temperatureFrom(value: unknown): Temperature | null {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if ((TEMPERATURES as readonly string[]).includes(text)) return text as Temperature;
  return OLD_SENTIMENT[text] ?? null;
}

export function verdictFrom(value: unknown): Verdict | null {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (VERDICTS as readonly string[]).includes(text) ? (text as Verdict) : null;
}

/** How warm a conversation is taken to be from the verdict on its latest reply. */
export function temperatureForVerdict(verdict: string | null | undefined): Temperature | null {
  if (verdict === "positive") return "hot";
  if (verdict === "negative" || verdict === "unsubscribe") return "cold";
  if (verdict === "out_of_office" || verdict === "human_review") return "warm";
  return null;
}

/** How long a team has to answer once a contact has written, when nobody has said otherwise. */
export const ANSWER_DUE_HOURS = 4;
/** A lock is somebody typing. After this long without renewing it, it no longer holds. */
export const LOCK_MINUTES = 15;
