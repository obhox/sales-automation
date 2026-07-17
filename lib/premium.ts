// Capability boundary used by the runner. This fork ships clean-room community
// implementations directly and exposes only capabilities that have working code.

// Minimal structural shapes for optional capabilities consumed by the runner. They are
// intentionally loose at the boundary; only add a field when the community app reads it.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { communityAi } from "@/lib/community-ai";
import { communityReplies } from "@/lib/community-replies";

export interface AiSurface {
  // Returns at least { default_model } — ee's AgentConfig is a superset.
  getAgentConfig(workspaceId?: string): { default_model: string | null };
  // Bundle is passed straight back into the writers; open-core never inspects its innards.
  getContactWithCompany(targetId: string): { contact: any; company: any } | null;
  // Writers take a large param object (ee owns its full type); open-core builds it inline.
  writeEmail(params: any): Promise<{ subject: string; body: string }>;
  writeLinkedInMessage(params: any): Promise<{ body: string }>;
  writeSalesInMail(params: any): Promise<{ subject: string; body: string }>;
}

export interface RepliesSurface {
  // AI classify + auto-followup for one stored reply (email or LinkedIn).
  classifyAndDispatch(replyId: string): Promise<void>;
  // LinkedIn inbox sync (reply detection), driven by the runner loop.
  shouldSyncInbox(accountId: string): boolean;
  syncAccountInbox(accountId: string): Promise<number>;
}

export interface InMailSurface {
  // Sends a Sales Nav InMail via a live browser page (playwright Page type is open-core).
  sendInMail(page: any, salesNavUrl: string, subject: string, body: string): Promise<void>;
}

export interface PremiumSurface {
  ai?: AiSurface;
  replies?: RepliesSurface;
  inmail?: InMailSurface;
  [key: string]: unknown;
}

export const premium: PremiumSurface = { ai: communityAi as AiSurface, replies: communityReplies as RepliesSurface };

export const hasPremium = false;

export const capabilities = {
  ai: !!premium.ai,
  crm: true,
  replies: !!premium.replies,
  inmail: !!premium.inmail,
  mcp: true,
};
