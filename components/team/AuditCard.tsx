import { useState } from "react";
import { ScrollText, Terminal } from "lucide-react";
import { Avatar, Card, EmptyState, ErrorState, Pagination, SearchInput, Segmented, Skeleton, Pill } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import { useApi } from "@/lib/client/data";
import { formatDateTime } from "@/lib/client/format";
import { useDebounced } from "@/lib/client/table-state";
import { AUDIT_PATH, SOURCE_LABEL, auditActor, auditSentence, auditTime, type AuditPage, type AuditSource } from "./model";

const PAGE_SIZE = 8;
type Filter = "all" | AuditSource;

/** Every change made in the workspace: who, what, how and from where. For admins. */
export function AuditCard({ onFilter }: { onFilter?: (query: { source?: AuditSource; q?: string }) => void }) {
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

  return (
    <Card className="flex flex-col gap-[11px] p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-15 font-semibold tracking-[-0.15px] text-ink">Audit log</h2>
          <p className="text-11 text-ink-3">Every change made in this workspace, kept for {data?.keep_months ?? 12} months</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <SearchInput value={text} onChange={(value) => narrow({ text: value })} placeholder="Search the log" frameClassName="h-[26px] w-[170px] border-transparent bg-subtle text-11" />
          <Segmented
            size="sm" label="Where the change came from" value={source} onChange={(value) => narrow({ source: value })}
            options={[
              { value: "all", label: "All", count: counts?.all },
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
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading the audit log">
          {Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className="h-9" />)}
        </div>
      ) : data.entries.length === 0 ? (
        <EmptyState icon={ScrollText} title={filtering ? "Nothing matches" : "Nothing has been recorded yet"}>
          {filtering
            ? "No entry matches the search and the source chosen. Entries from before sources were recorded show under All only."
            : "Changes made in the app, through the API and by MCP clients are listed here as they happen."}
        </EmptyState>
      ) : (
        <ol className={isLoading ? "flex flex-col opacity-60" : "flex flex-col"} aria-label="Audit entries, newest first">
          {data.entries.map((entry) => {
            const actor = auditActor(entry);
            const sentence = auditSentence(entry);
            const when = auditTime(entry.created_at);
            return (
              <li key={entry.id} className="flex items-center gap-[11px] border-t border-line py-2 first:border-t-0">
                <time dateTime={entry.created_at} title={formatDateTime(entry.created_at)} className="flex w-[52px] shrink-0 flex-col text-105 text-ink-3">
                  {when.day ? <span>{when.day}</span> : null}
                  <span className="font-mono">{when.time}</span>
                </time>
                {actor.person ? (
                  <Avatar name={actor.name} size={22} tint="bg-brand-tint" />
                ) : (
                  <span className="inline-flex size-[22px] shrink-0 items-center justify-center rounded-full bg-control text-ink-2" aria-hidden="true"><Terminal size={11} /></span>
                )}
                <p className="min-w-0 flex-1 text-11 leading-[15px] text-ink-2">
                  <span className="text-115 font-semibold text-ink">{actor.name}</span>{" "}
                  {sentence.phrase}
                  {sentence.target ? <>{" "}<span className="text-115 font-medium text-ink">{sentence.target}</span></> : null}
                </p>
                {entry.source ? <Pill size="md" className="text-10">{SOURCE_LABEL[entry.source]}</Pill> : null}
                <span className="flex w-[150px] shrink-0 flex-col items-end gap-0.5 text-right text-10 text-ink-3">
                  {entry.via ? <span className="max-w-full truncate" title={entry.via}>{entry.source === "api" ? "key" : "client"} · {entry.via}</span> : null}
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
            {((data.page - 1) * data.page_size + 1).toLocaleString("en-US")}–{Math.min(data.page * data.page_size, data.total).toLocaleString("en-US")} of {data.total.toLocaleString("en-US")}
          </span>
          <Pagination page={data.page} pageSize={data.page_size} total={data.total} onPageChange={setPage} />
        </div>
      ) : null}
    </Card>
  );
}
