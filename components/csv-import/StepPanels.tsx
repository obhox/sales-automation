import Link from "next/link";
import { useRouter } from "next/router";
import { useState } from "react";
import { ArrowRight, CircleCheck, Copy, ListChecks, Play, Sparkles, Upload } from "lucide-react";
import { toast } from "sonner";
import { Alert, Button, Card, EmptyState, Pill, Spinner } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { formatCount } from "@/lib/client/format";
import { recordHref } from "@/lib/client/nav";
import {
  MATCHED_BY, ON_DUPLICATE_HINT, TYPE_LABEL, duplicateAction, newFields, newImportHref, resultFigures, reviewLines,
  type AfterImport, type ImportCheck, type ImportView, type StoredResult,
} from "./model";
import { PanelHeader } from "./PanelHeader";

/** Step three: the rows that are contacts already, each with what it matched and what happens to it. */
export function DuplicatesStep({ view, check, checking }: { view: ImportView; check: ImportCheck | null; checking: boolean }) {
  const rows = check?.duplicates ?? [];
  return (
    <Card className="flex min-h-0 flex-col">
      <PanelHeader
        className="px-3.5 py-3" title="Duplicates in this file"
        subtitle={check ? (check.duplicate_rows === 0 ? "No row of this file is a contact you already have" : `${formatCount(check.duplicate_rows)} of ${formatCount(check.summary.rows)} rows are contacts you already have, or repeat a row above them`) : "Looking for contacts you already have"}
        actions={checking ? <Spinner size={14} label="Checking" /> : null}
      />
      {!check ? (
        <div className="flex items-center gap-2 border-t border-line px-3.5 py-6 text-12 text-ink-2"><Spinner size={13} label="Checking" />Comparing {formatCount(view.file.rows)} rows with your contacts</div>
      ) : rows.length === 0 ? (
        <EmptyState className="border-t border-line" icon={CircleCheck} title="No duplicates">
          Every row is someone new, by the details chosen on the right. Tick Full name + company to also catch people whose email address or profile has changed.
        </EmptyState>
      ) : (
        <>
          <div role="table" aria-label="Duplicate rows" className="flex flex-col">
            <div role="row" className="grid h-[31px] grid-cols-[56px_minmax(0,1fr)_132px_minmax(0,1fr)_118px] items-center gap-3 border-y border-line bg-subtle px-3.5 text-10 font-semibold uppercase tracking-label text-ink-3">
              <span role="columnheader">Row</span><span role="columnheader">In the file</span><span role="columnheader">Matched by</span><span role="columnheader">Is already</span><span role="columnheader">What happens</span>
            </div>
            {rows.map((row) => {
              const action = duplicateAction(row);
              return (
                <div key={row.row} role="row" className="grid min-h-10 grid-cols-[56px_minmax(0,1fr)_132px_minmax(0,1fr)_118px] items-center gap-3 border-b border-line px-3.5 py-1.5">
                  <span role="cell" className="font-mono text-115 text-ink-3">{formatCount(row.row)}</span>
                  <span role="cell" className="truncate text-12 font-medium text-ink" title={row.label}>{row.label}</span>
                  <span role="cell" className="truncate text-115 text-ink-2">{MATCHED_BY[row.matched_by]}</span>
                  <span role="cell" className="min-w-0 truncate text-115">
                    {row.contact ? <Link href={recordHref("contact", row.contact.id)} target="_blank" className="rounded-sm font-medium text-brand-strong hover:underline">{row.contact.name}</Link>
                      : <span className="text-ink-2">Row {formatCount(row.repeats_row ?? 0)} of this file</span>}
                  </span>
                  <span role="cell"><Pill tone={action.tone}>{action.label}</Pill></span>
                </div>
              );
            })}
          </div>
          <p className="flex items-start gap-2 rounded-b-lg bg-subtle px-3.5 py-2.5 text-11 leading-4 text-ink-2">
            <Copy size={13} className="mt-0.5 shrink-0 text-ink-3" aria-hidden="true" />
            <span>{check.duplicate_rows > rows.length ? `The first ${formatCount(rows.length)} of ${formatCount(check.duplicate_rows)}. ` : ""}{ON_DUPLICATE_HINT[view.on_duplicate]} Change what is matched on, or what happens, on the right.</span>
          </p>
        </>
      )}
    </Card>
  );
}

/** Step four: what the import will do, before it does it. */
export function ReviewStep({ view, check, checking, running, onRun }: { view: ImportView; check: ImportCheck | null; checking: boolean; running: boolean; onRun: () => void }) {
  const made = newFields(view);
  return (
    <Card className="flex flex-col">
      <PanelHeader className="px-3.5 py-3" title="Review" subtitle="Nothing has been imported yet. This is what running it will do." actions={checking ? <Spinner size={14} label="Checking" /> : null} />
      {!check ? (
        <div className="flex items-center gap-2 border-t border-line px-3.5 py-6 text-12 text-ink-2"><Spinner size={13} label="Checking" />Going through {formatCount(view.file.rows)} rows</div>
      ) : (
        <>
          <dl className="grid grid-cols-2 border-t border-line lg:grid-cols-4">
            {reviewLines(view, check.summary).map((line) => (
              <div key={line.key} className="flex flex-col gap-0.5 border-b border-line px-3.5 py-3 lg:border-b-0 lg:border-r lg:last:border-r-0">
                <dd className="text-22 font-semibold tracking-[-0.4px] text-ink">{line.value}</dd>
                <dt className="text-115 text-ink-2">{line.label}</dt>
                {line.note ? <span className="text-105 leading-[14px] text-ink-3">{line.note}</span> : null}
              </div>
            ))}
          </dl>
          <div className="flex flex-col gap-3 border-t border-line p-3.5">
            {made.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-12 font-semibold text-ink">{made.length === 1 ? "One new custom field is made" : `${made.length} new custom fields are made`}</span>
                <ul className="flex flex-wrap gap-1.5">
                  {made.map((column) => column.mapping.kind === "custom" ? (
                    <li key={column.index}><Pill tone="brand" icon={Sparkles}><span className="font-mono">{column.mapping.key}</span><span className="font-normal">· {TYPE_LABEL[column.mapping.fieldType]}</span></Pill></li>
                  ) : null)}
                </ul>
                <span className="text-11 text-ink-3">Campaign wording can use each by its key, like {"{{"}{made[0].mapping.kind === "custom" ? made[0].mapping.key : "key"}{"}}"}.</span>
              </div>
            ) : null}
            {check.problem ? <Alert tone="warn" title={check.problem} /> : null}
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="primary" icon={Upload} loading={running} disabled={Boolean(check.problem) || checking} onClick={onRun}>
                Import {formatCount(check.summary.ready)} {check.summary.ready === 1 ? "row" : "rows"}
              </Button>
              <span className="text-11 text-ink-3">It is done in one go: either every row here goes in, or none does.</span>
            </div>
          </div>
        </>
      )}
    </Card>
  );
}

/** What the import did, and where to go next. */
export function ResultPanel({ view, result, canCampaign }: { view: ImportView; result: StoredResult; canCampaign: boolean }) {
  const router = useRouter();
  const [starting, setStarting] = useState(false);
  const wanted: AfterImport = view.after;
  const campaign = wanted.mode === "existing" ? view.options.campaigns.find((candidate) => candidate.id === wanted.campaign_id) ?? null : null;

  /** Open the campaign setup with this list chosen: on the draft that was picked, or on a new campaign. */
  async function setUpCampaign() {
    if (starting) return;
    setStarting(true);
    try {
      const id = campaign?.id ?? (await api<{ id: string }>("/api/workflows", { method: "POST", body: { name: result.list.name } })).id;
      await api(`/api/workflows/${id}/setup`, { method: "PUT", body: { setup: { list_id: result.list.id } } });
      await router.push(`/campaigns?setup=${encodeURIComponent(id)}`);
    } catch (cause) {
      // The setup can always be opened empty; the list is then chosen there.
      toast.error(errorMessage(cause));
      await router.push("/campaigns?new=1");
    }
  }

  const nothing = result.created + result.updated === 0;
  return (
    <Card className="flex flex-col">
      <div className="flex items-start gap-3 p-3.5">
        <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-good-tint text-good"><CircleCheck size={17} aria-hidden="true" /></span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="text-15 font-semibold tracking-[-0.15px] text-ink">{nothing ? `Nothing new in ${view.file.name}` : `${view.file.name} is imported`}</h2>
          <p className="text-12 text-ink-2">
            Into <Link href={recordHref("list", result.list.id)} className="rounded-sm font-semibold text-brand-strong hover:underline">{result.list.name}</Link>
            {result.new_list ? ", a new list" : ""}. {formatCount(result.rows)} {result.rows === 1 ? "row" : "rows"} read
            {result.custom_fields_created ? `, ${result.custom_fields_created} new custom ${result.custom_fields_created === 1 ? "field" : "fields"} made` : ""}. The mapping is remembered for the next file with the same columns.
          </p>
        </div>
      </div>
      <dl className="grid grid-cols-2 border-y border-line lg:grid-cols-4">
        {resultFigures(result).map((figure) => (
          <div key={figure.key} className="flex flex-col gap-0.5 border-b border-line px-3.5 py-3 lg:border-b-0 lg:border-r lg:last:border-r-0">
            <dd className="text-22 font-semibold tracking-[-0.4px] text-ink">{figure.value}</dd>
            <dt className="truncate text-115 text-ink-2">{figure.label}</dt>
          </div>
        ))}
      </dl>
      {result.merged > 0 || result.already_in_list > 0 ? (
        <p className="border-b border-line px-3.5 py-2.5 text-11 text-ink-2">
          {[result.merged ? `${formatCount(result.merged)} ${result.merged === 1 ? "row added" : "rows added"} to a contact another row of the file made or changed` : null,
            result.already_in_list ? `${formatCount(result.already_in_list)} ${result.already_in_list === 1 ? "contact was" : "contacts were"} in the list already` : null].filter(Boolean).join(" · ")}.
        </p>
      ) : null}
      {result.error_rows.length > 0 ? (
        <div className="flex flex-col gap-1.5 border-b border-line p-3.5">
          <span className="text-12 font-semibold text-ink">{formatCount(result.errors)} {result.errors === 1 ? "row was" : "rows were"} left out because nothing said who {result.errors === 1 ? "it was" : "they were"}</span>
          <ul className="max-h-[180px] overflow-y-auto rounded-md border border-line bg-subtle p-2.5 font-mono text-105 leading-[16px] text-ink-2">
            {result.error_rows.map((row) => <li key={row.row}>Row {row.row}: {row.reason}</li>)}
          </ul>
          {result.errors > result.error_rows.length ? <span className="text-11 text-ink-3">The first {formatCount(result.error_rows.length)} are shown.</span> : null}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 p-3.5">
        {canCampaign && wanted.mode !== "none" ? (
          <Button variant="primary" icon={Play} loading={starting} onClick={() => void setUpCampaign()}>{campaign ? `Set up ${campaign.name} with this list` : "Set up a campaign with this list"}</Button>
        ) : null}
        <Button asChild variant={canCampaign && wanted.mode !== "none" ? "secondary" : "primary"}>
          <Link href={recordHref("list", result.list.id)}><ListChecks size={14} aria-hidden="true" />Open {result.list.name}</Link>
        </Button>
        {canCampaign && wanted.mode === "none" ? <Button icon={Play} loading={starting} onClick={() => void setUpCampaign()}>Set up a campaign with this list</Button> : null}
        <Button asChild variant="ghost"><Link href={newImportHref()}>Import another file<ArrowRight size={14} aria-hidden="true" /></Link></Button>
      </div>
    </Card>
  );
}
