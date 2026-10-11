import type { ReactNode } from "react";
import { Page } from "@/components/shell";
import { Pill, type TabItem } from "@/components/ui";
import { formatCount } from "@/lib/client/format";
import { STATUS_LABEL, STATUS_TONE, type CampaignSummary } from "./model";

export type CampaignTab = "overview" | "sequence" | "prospects" | "settings";

/** Where each of a campaign's pages lives. */
export const campaignTabHref = (id: string, tab: CampaignTab) => (tab === "overview" ? `/campaigns/${id}` : `/campaigns/${id}/${tab}`);

/**
 * The frame every page of one campaign shares: the way back to the list, the campaign's
 * name and status, and its four tabs.
 */
export function CampaignFrame({
  id, campaign, tab, meta, actions, aside, padded, className, children,
}: {
  id: string;
  /** Undefined while it loads: the frame shows without a name rather than jumping in later. */
  campaign: Pick<CampaignSummary, "name" | "status" | "enrolled"> | undefined;
  tab: CampaignTab;
  /** Pills after the status ("Unsaved changes"). */
  meta?: ReactNode;
  actions?: ReactNode;
  /** The right of the tab bar. */
  aside?: ReactNode;
  padded?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const items: TabItem<CampaignTab>[] = [
    { value: "overview", label: "Overview", href: campaignTabHref(id, "overview") },
    { value: "sequence", label: "Sequence", href: campaignTabHref(id, "sequence") },
    { value: "prospects", label: "Prospects", href: campaignTabHref(id, "prospects"), count: campaign && campaign.enrolled > 0 ? formatCount(campaign.enrolled) : undefined },
    { value: "settings", label: "Settings", href: campaignTabHref(id, "settings") },
  ];
  return (
    <Page
      title={campaign?.name ?? "Campaign"}
      crumbs={[{ label: "Campaigns", href: "/campaigns" }]}
      meta={
        <>
          {campaign ? <Pill tone={STATUS_TONE[campaign.status]} dot={campaign.status === "active"}>{STATUS_LABEL[campaign.status]}</Pill> : null}
          {meta}
        </>
      }
      actions={actions}
      tabs={{ items, value: tab, label: "Campaign sections" }}
      tabsAside={aside}
      padded={padded}
      className={className}
    >
      {children}
    </Page>
  );
}
