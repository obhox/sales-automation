// Keeping a campaign's emails to one person in a single conversation, and working out which
// of them a reply answers. Mail clients thread on the In-Reply-To and References headers
// (and most also want the subject to match), so a follow-up names the emails before it.

/** What a follow-up needs to land in the thread of the emails already sent, oldest first. */
export function threadOnto(earlier: Array<{ message_id: string; subject: string }>): { subject: string; replyToMessageId: string; references: string[] } | null {
  const sent = earlier.filter((email) => email.message_id);
  if (sent.length === 0) return null;
  return {
    subject: `Re: ${stripReplyPrefix(sent[0].subject)}`,
    replyToMessageId: sent[sent.length - 1].message_id,
    references: sent.map((email) => email.message_id),
  };
}

export function stripReplyPrefix(subject: string): string {
  return subject.replace(/^\s*((re|fwd?|aw|sv|antw)\s*:\s*)+/i, "").trim();
}

/**
 * The ids of our own emails that a reply's In-Reply-To / References name, nearest first.
 * Every email this app sends has the Message-ID <jobId@sender-domain>, so the job id can be
 * read straight out of the header. Ids that are not ours simply never match a job.
 */
export function jobIdsNamedBy(inReplyTo: string | undefined | null, references: string | string[] | undefined | null): string[] {
  const refs = Array.isArray(references) ? references : references ? [references] : [];
  // In-Reply-To is the direct parent; References runs oldest to newest.
  const ordered = [inReplyTo ?? "", ...refs.flatMap((value) => value.split(/\s+/)).reverse()];
  const ids: string[] = [];
  for (const value of ordered) {
    for (const match of value.matchAll(/<([0-9a-f-]{20,})@[^>\s]+>/gi)) {
      const id = match[1].toLowerCase();
      if (!ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}
