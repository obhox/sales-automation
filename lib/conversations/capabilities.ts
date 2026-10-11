// Which of the inbox's paid capabilities this build has. The screen shows a plain "not
// available" where one is missing; nothing here calls a model.
import { premium } from "@/lib/premium";

/**
 * Where the composer's "Rewrite" sends a draft, or null when this build has no rewriting.
 *
 * TO CHANGE WHEN THE SEQUENCE BUILDER'S BRANCH IS MERGED: that branch adds
 * POST /api/ai/rewrite. Set this to "/api/ai/rewrite" and check the request and response
 * in components/inbox/api.ts (rewriteDraft) against that route. Nothing else is needed:
 * the button, its states and the "not available" note are already built around this value.
 */
export const REWRITE_ROUTE: string | null = null;

export interface InboxCapabilities {
  /** Replies are read and given a verdict, which is also what the summary card shows. */
  classify: boolean;
  rewrite: boolean;
  rewrite_route: string | null;
}

export function inboxCapabilities(): InboxCapabilities {
  return { classify: Boolean(premium.replies), rewrite: REWRITE_ROUTE !== null, rewrite_route: REWRITE_ROUTE };
}
