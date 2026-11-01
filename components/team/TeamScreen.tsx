import { useState } from "react";
import {useLocale, useTranslations} from "next-intl";
import { ScrollText, UserPlus } from "lucide-react";
import { Page } from "@/components/shell";
import { Alert, Button, Card, ErrorState, Skeleton } from "@/components/ui";
import { apiUrl, errorMessage } from "@/lib/client/api";
import { useApi } from "@/lib/client/data";
import { useCan } from "@/lib/client/roles";
import { AuditCard } from "./AuditCard";
import { InviteDialog } from "./InviteDialog";
import { MembersCard } from "./MembersCard";
import { RolesCard, WorkspacesCard } from "./SideCards";
import { AUDIT_PATH, TEAM_PATH, teamSummary, type AuditSource, type TeamOverview } from "./model";

/** Configure → Team & roles: who is in the workspace, what they may do, and what has been changed. */
export function TeamScreen() {
  const t = useTranslations("Team");
  const locale = useLocale();
  const { data, error, isLoading, mutate } = useApi<TeamOverview>(TEAM_PATH);
  const admin = useCan("admin");
  const [inviting, setInviting] = useState(false);
  // What the audit card is showing, so the download gives the same entries.
  const [auditFilter, setAuditFilter] = useState<{ source?: AuditSource; q?: string }>({});
  // Counts up after a change here, so the audit log under it reads again.
  const [auditRound, setAuditRound] = useState(0);
  const refresh = () => {
    void mutate();
    setAuditRound((round) => round + 1);
  };

  const summary = data
    ? locale === "pt-BR" ? t("summary", {
        name: data.workspace.name,
        count: data.members.length,
        pending: data.invitations.filter((invite) => invite.status === "pending").length
          ? t("summaryPending", {count: data.invitations.filter((invite) => invite.status === "pending").length})
          : "",
      }) : teamSummary(data)
    : null;
  return (
    <Page
      title={t("title")}
      meta={data ? <span className="text-11 text-ink-3">{summary}</span> : null}
      actions={
        admin ? (
          <>
            <Button icon={ScrollText} onClick={() => window.location.assign(apiUrl(AUDIT_PATH, { format: "csv", ...auditFilter }))} disabled={!data}>
              {t("downloadAudit")}
            </Button>
            <Button variant="primary" icon={UserPlus} onClick={() => setInviting(true)} disabled={!data}>{t("invite")}</Button>
            <span className="mx-0.5 h-5 w-px bg-line" aria-hidden="true" />
          </>
        ) : undefined
      }
    >
      {error && !data ? (
        <Card><ErrorState message={errorMessage(error)} onRetry={() => void mutate()} /></Card>
      ) : isLoading || !data ? (
        <LoadingLayout />
      ) : (
        <>
          {!admin ? <Alert tone="neutral">{t("readOnly")}</Alert> : null}
          <div className="flex min-h-0 flex-col gap-3.5 xl:flex-row xl:items-start">
            <div className="flex min-w-0 flex-1 flex-col gap-3.5">
              <MembersCard overview={data} onChanged={refresh} />
              {/* The audit route is for admins: nobody else is shown a card that would be refused. */}
              {admin ? <AuditCard key={auditRound} onFilter={setAuditFilter} /> : null}
            </div>
            <div className="flex w-full shrink-0 flex-col gap-3.5 xl:w-[368px]">
              <WorkspacesCard overview={data} onChanged={refresh} />
              <RolesCard overview={data} />
            </div>
          </div>
          {admin ? <InviteDialog open={inviting} actorRole={data.your_role} workspaceName={data.workspace.name} onClose={() => setInviting(false)} onInvited={refresh} /> : null}
        </>
      )}
    </Page>
  );
}

function LoadingLayout() {
  const t = useTranslations("Team");
  return (
    <div className="flex flex-col gap-3.5 xl:flex-row xl:items-start" aria-busy="true" aria-label={t("loading")}>
      <div className="flex min-w-0 flex-1 flex-col gap-3.5">
        <Skeleton className="h-[420px] rounded-lg" />
        <Skeleton className="h-[320px] rounded-lg" />
      </div>
      <div className="flex w-full shrink-0 flex-col gap-3.5 xl:w-[368px]">
        <Skeleton className="h-[190px] rounded-lg" />
        <Skeleton className="h-[420px] rounded-lg" />
      </div>
    </div>
  );
}
