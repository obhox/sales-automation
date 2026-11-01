import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ScrollText, Terminal } from "lucide-react";
import { Avatar, Card, EmptyState, ErrorState, Pagination, SearchInput, Segmented, Skeleton, Pill } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import { useApi } from "@/lib/client/data";
import { parseTime } from "@/lib/client/format";
import { formatDateTimeByLocale } from "@/lib/client/localize-relative";
import { useDebounced } from "@/lib/client/table-state";
import { AUDIT_PATH, SOURCE_LABEL, auditActor, auditSentence, auditTime, type AuditEntry, type AuditPage, type AuditSource } from "./model";

const PAGE_SIZE = 8;
type Filter = "all" | AuditSource;

/** Every change made in the workspace: who, what, how and from where. For admins. */
export function AuditCard({ onFilter }: { onFilter?: (query: { source?: AuditSource; q?: string }) => void }) {
  const t = useTranslations("TeamAudit");
  const locale = useLocale();
  const [source, setSource] = useState<Filter>("all");
  const [text, setText] = useState("");
  const [page, setPage] = useState(1);
  const q = useDebounced(text.trim(), 250);
  const { data, error, isLoading, mutate } = useApi<AuditPage>(AUDIT_PATH, { view: "list", limit: PAGE_SIZE, page, source: source === "all" ? undefined : source, q: q || undefined });

  function narrow(next: { source?: Filter; text?: string }) {
    const nextSource = next.source ?? source;
    const nextText = next.text ?? text;
    if (next.source !== undefined) setSource(next.source);
    if (next.text !== undefined) setText(next.text);
    setPage(1);
    onFilter?.({ source: nextSource === "all" ? undefined : nextSource, q: nextText.trim() || undefined });
  }

  const counts = data?.counts;
  const filtering = source !== "all" || q !== "";
  const formatAudit = (entry: AuditEntry) => {
    const original = auditSentence(entry);
    if (locale !== "pt-BR") return original;
    const role = String(entry.metadata?.role ?? "");
    const roles: Record<string, string> = {
      owner: t("roleOwner"), admin: t("roleAdmin"), manager: t("roleManager"),
      member: t("roleMember"), viewer: t("roleViewer"),
    };
    const phrases: Record<string, string> = {
      "workspace.member_role_changed": t("changedRole", {name: entry.entity_label ?? t("aMember")}),
      "workspace.member_upserted": t("changedRole", {name: entry.entity_label ?? t("aMember")}),
      "workspace.member_suspended": t("memberSuspended"),
      "workspace.member_restored": t("memberRestored"),
      "workspace.member_removed": t("memberRemoved"),
      "workspace.invitation_created": t("invited", {role: role ? roles[role] ?? role : ""}),
      "workspace.invitation_resent": t("inviteResent"),
      "workspace.invitation_link_renewed": t("inviteRenewed"),
      "workspace.invitation_revoked": t("inviteRevoked"),
      "workspace.invitation_accepted": t("inviteAccepted"),
      "workspace.updated": t("workspaceRenamed"),
      "workspace.created": t("workspaceCreated"),
      "workspace.settings_updated": t("workspaceUpdated"),
      "ai_config.updated": t("aiUpdated"),
      "workflow.step_ai_updated": t("stepUpdated"),
      "run.status_changed": t("runChanged"),
      "run.started": t("runStarted"),
      "run.created": t("runPrepared"),
      "run.deleted": t("runDeleted"),
      "contact.bulk_deleted": t("contactDeleted"),
      "audit_log.downloaded": t("auditDownloaded"),
      "mcp.tool_used": t("usedTool"),
      "integration.configured": t("integrationConfigured"),
      "integration.deleted": t("integrationRemoved"),
      "linkedin_preset.updated": t("linkedinPresetUpdated"),
      "linkedin_preset.applied": t("linkedinPresetApplied"),
    };
    if (!phrases[entry.action]) return original;
    let target = original.target;
    if ((entry.action === "workspace.member_role_changed" || entry.action === "workspace.member_upserted") && role) {
      target = roles[role] ?? role;
    } else if (entry.action === "workspace.invitation_accepted" && role) {
      target = t("asRole", {role: roles[role] ?? role});
    } else if (entry.action === "contact.bulk_deleted") {
      target = t("contactsCount", {count: Number(entry.metadata?.deleted ?? 0)});
    } else if (entry.action === "audit_log.downloaded" && typeof entry.metadata?.entries === "number") {
      target = t("entriesCount", {count: entry.metadata.entries});
    }
    return {phrase: phrases[entry.action], target};
  };
  const auditDate = (value: string) => {
    const date = parseTime(value);
    if (!date || locale !== "pt-BR") return auditTime(value);
    const short = date.toLocaleDateString("pt-BR", {day: "numeric", month: "short"});
    const current = new Date();
    const sameDay = date.toDateString() === current.toDateString();
    return {day: sameDay ? null : short, time: date.toLocaleTimeString("pt-BR", {hour: "2-digit", minute: "2-digit"})};
  };

  return (
    <Card className="flex flex-col gap-[11px] p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-15 font-semibold tracking-[-0.15px] text-ink">{t("auditTitle")}</h2>
          <p className="text-11 text-ink-3">{t("retention", {count: data?.keep_months ?? 12})}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <SearchInput value={text} onChange={(value) => narrow({ text: value })} placeholder={t("search")} frameClassName="h-[26px] w-[170px] border-transparent bg-subtle text-11" />
          <Segmented
            size="sm" label={t("source")} value={source} onChange={(value) => narrow({ source: value })}
            options={[
              { value: "all", label: t("all"), count: counts?.all },
              { value: "web", label: SOURCE_LABEL.web, count: counts?.web },
              { value: "api", label: SOURCE_LABEL.api, count: counts?.api },
              { value: "mcp", label: SOURCE_LABEL.mcp, count: counts?.mcp },
            ]}
          />
        </div>
      </div>

      {error && !data ? (
        <ErrorState message={errorMessage(error)} onRetry={() => void mutate()} />
      ) : !data ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label={t("loading")}>
          {Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className="h-9" />)}
        </div>
      ) : data.entries.length === 0 ? (
        <EmptyState icon={ScrollText} title={filtering ? t("noMatches") : t("empty")}>
          {filtering
            ? t("noMatchHint")
            : t("emptyHint")}
        </EmptyState>
      ) : (
        <ol className={isLoading ? "flex flex-col opacity-60" : "flex flex-col"} aria-label={t("entriesLabel")}>
          {data.entries.map((entry) => {
            const actor = auditActor(entry);
            const sentence = formatAudit(entry);
            const when = auditDate(entry.created_at);
            return (
              <li key={entry.id} className="flex items-center gap-[11px] border-t border-line py-2 first:border-t-0">
                <time dateTime={entry.created_at} title={formatDateTimeByLocale(entry.created_at, locale)} className="flex w-[52px] shrink-0 flex-col text-105 text-ink-3">
                  {when.day ? <span>{when.day}</span> : null}
                  <span className="font-mono">{when.time}</span>
                </time>
                {actor.person ? (
                  <Avatar name={actor.name} size={22} tint="bg-brand-tint" />
                ) : (
                  <span className="inline-flex size-[22px] shrink-0 items-center justify-center rounded-full bg-control text-ink-2" aria-hidden="true"><Terminal size={11} /></span>
                )}
                <p className="min-w-0 flex-1 text-11 leading-[15px] text-ink-2">
                  <span className="text-115 font-semibold text-ink">{actor.person ? actor.name : locale === "pt-BR" && entry.source === "api" ? t("apiKey") : locale === "pt-BR" && entry.source === "mcp" ? t("mcpClient") : actor.name}</span>{" "}
                  {sentence.phrase}
                  {sentence.target ? <>{" "}<span className="text-115 font-medium text-ink">{sentence.target}</span></> : null}
                </p>
                {entry.source ? <Pill size="md" className="text-10">{SOURCE_LABEL[entry.source]}</Pill> : null}
                <span className="flex w-[150px] shrink-0 flex-col items-end gap-0.5 text-right text-10 text-ink-3">
                  {entry.via ? <span className="max-w-full truncate" title={entry.via}>{entry.source === "api" ? t("key") : t("client")} · {entry.via}</span> : null}
                  {entry.ip_address ? <span className="font-mono">{entry.ip_address}</span> : !entry.via ? <span>—</span> : null}
                </span>
              </li>
            );
          })}
        </ol>
      )}

      {data && data.total > PAGE_SIZE ? (
        <div className="flex items-center justify-between gap-3 border-t border-line pt-2.5 text-11 text-ink-3">
          <span>
            {((data.page - 1) * data.page_size + 1).toLocaleString(locale === "pt-BR" ? "pt-BR" : "en-US")}–{Math.min(data.page * data.page_size, data.total).toLocaleString(locale === "pt-BR" ? "pt-BR" : "en-US")} {t("of")} {data.total.toLocaleString(locale === "pt-BR" ? "pt-BR" : "en-US")}
          </span>
          <Pagination page={data.page} pageSize={data.page_size} total={data.total} onPageChange={setPage} />
        </div>
      ) : null}
    </Card>
  );
}
