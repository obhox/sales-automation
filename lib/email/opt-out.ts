// What counts as a person saying "stop", in words nobody could mean otherwise. Suppressing
// an address is workspace-wide and awkward to undo, so this is deliberately narrow.

const IN_BODY = /\bunsubscribe\b|\bremove me\b|stop (emailing|contacting|messaging)|do not (email|contact|message)|opt[ -]?out|take me off|no longer (wish|want)/i;

// A subject is mostly our own words coming back ("Re: <what we wrote>"), so it only counts
// when the reply's subject, with the Re:/Fwd: prefixes off, is the request and nothing else:
// what "reply with Unsubscribe in the subject" produces. "Re: Stop guessing your pipeline"
// is our own subject line and must not match.
const WHOLE_SUBJECT = /^(please\s+)?(unsubscribe|remove me|opt[ -]?out|stop)(\s+me)?(\s+please)?[\s.!]*$/i;
const REPLY_PREFIX = /^\s*((re|fwd?|aw|sv|antw)\s*:\s*)+/i;

export function subjectIsOptOut(subject: string | null | undefined): boolean {
  return WHOLE_SUBJECT.test(String(subject ?? "").replace(REPLY_PREFIX, "").trim());
}

export function isExplicitOptOut(subject: string | null | undefined, body: string | null | undefined): boolean {
  return IN_BODY.test(String(body ?? "")) || subjectIsOptOut(subject);
}
