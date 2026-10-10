// What the campaigns list knows about a campaign and how it words it. No React here.
import type { CampaignList, CampaignSort, CampaignStatus, CampaignSummary } from "@/lib/campaigns/summary";
import type { Tone } from "@/components/ui/Pill";
import { formatCount, plural } from "@/lib/client/format";

export type { CampaignList, CampaignSort, CampaignStatus, CampaignSummary };

export const LIST_PATH = "/api/workflows";

/** Where a campaign opens until its overview is rebuilt. */
export const campaignHref = (id: string) => `/campaigns/${id}`;
/** The campaign's sequence builder. */
export const sequenceHref = (id: string) => `/campaigns/${id}/sequence`;

export const STATUS_LABEL: Record<CampaignStatus, string> = { active: "Active", paused: "Paused", draft: "Draft", completed: "Completed", archived: "Archived" };
export const STATUS_TONE: Record<CampaignStatus, Tone> = { active: "good", paused: "warn", draft: "neutral", completed: "brand", archived: "neutral" };

export type StatusTab = "all" | CampaignStatus;

/** The tabs across the top, in order. Archived is offered only when there is something in it, or it is the one open. */
export function statusTabs(counts: CampaignList["counts"] | undefined, current: StatusTab): Array<{ value: StatusTab; label: string; count: number | undefined }> {
  const tabs: StatusTab[] = ["all", "active", "paused", "draft", "completed"];
  if ((counts?.archived ?? 0) > 0 || current === "archived") tabs.push("archived");
  return tabs.map((value) => ({ value, label: value === "all" ? "All" : STATUS_LABEL[value], count: counts?.[value] }));
}

export const SORT_OPTIONS: Array<{ value: CampaignSort; label: string }> = [
  { value: "last_activity", label: "Last activity" },
  { value: "name", label: "Name" },
  { value: "created", label: "Date created" },
  { value: "enrolled", label: "Enrolled" },
  { value: "reply_rate", label: "Reply rate" },
  { value: "acceptance", label: "Acceptance" },
];
/** A name reads best A to Z; everything else, biggest or newest first. */
export const defaultDirection = (sort: CampaignSort): "asc" | "desc" => (sort === "name" ? "asc" : "desc");

/** "Enterprise VP Sales · 1,240", or what stands in for it when the campaign has no list yet. */
export function audienceLine(campaign: CampaignSummary): string {
  if (campaign.list) return `${campaign.list.name} · ${formatCount(campaign.list.contacts)}`;
  if (campaign.steps === 0) return "No steps yet";
  return `${campaign.steps} ${plural(campaign.steps, "step", "steps")} · no list yet`;
}

/** The columns a person can hide. The campaign's name and its menu always show. */
export const OPTIONAL_COLUMNS = [
  { key: "status", label: "Status" },
  { key: "channels", label: "Channels" },
  { key: "enrolled", label: "Enrolled / done" },
  { key: "reply_rate", label: "Reply rate" },
  { key: "acceptance", label: "Acceptance" },
  { key: "owner", label: "Owner" },
  { key: "last_activity", label: "Last activity" },
] as const;
export type OptionalColumn = (typeof OPTIONAL_COLUMNS)[number]["key"];

/** Read a stored list of hidden columns, dropping anything that is not a column any more. */
export function hiddenColumnsFrom(stored: unknown): OptionalColumn[] {
  if (!Array.isArray(stored)) return [];
  return OPTIONAL_COLUMNS.map((column) => column.key).filter((key) => stored.includes(key));
}

export type BulkAction = "pause" | "resume" | "duplicate" | "archive" | "unarchive";

export interface BulkResult {
  results: Array<{ id: string; ok: boolean; error?: string; new_id?: string }>;
  done: number;
}

const DONE_WORDS: Record<BulkAction, string> = { pause: "paused", resume: "resumed", duplicate: "duplicated", archive: "archived", unarchive: "brought back" };

/** What to tell the person after an action on several campaigns: how many it took, and why any were left out. */
export function bulkOutcome(action: BulkAction, result: BulkResult, names: Map<string, string>): { ok: string | null; problems: string[] } {
  const ok = result.done > 0 ? `${result.done} ${plural(result.done, "campaign", "campaigns")} ${DONE_WORDS[action]}` : null;
  const problems = result.results.filter((entry) => !entry.ok).map((entry) => `${names.get(entry.id) ?? "A campaign"}: ${entry.error ?? "could not be changed"}`);
  return { ok, problems };
}
