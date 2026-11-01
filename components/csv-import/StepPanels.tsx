import Link from "next/link";
import { useRouter } from "next/router";
import { useState } from "react";
import { useTranslations, useLocale } from "next-intl";
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
  const t = useTranslations("CsvStepPanels");
  const locale = useLocale();
  const rows = check?.duplicates ?? [];
  return (
    <Card className="flex min-h-0 flex-col">
      <PanelHeader
        className="px-3.5 py-3" title={t("duplicateTitle")}
        subtitle={locale === "pt-BR" ? !check ? t("looking") : !check.duplicate_rows ? t("noneFound") : t("duplicatesCount", {count: check.duplicate_rows, total: check.summary.rows}) : check ? check.duplicate_rows === 0 ? t("noneFound") : t("duplicatesCount", {count: check.duplicate_rows, total: check.summary.rows}) : t("looking")}
        actions={checking ? <Spinner size={14} label={t("checking")} /> : null}
      />
      {!check ? (
        <div className="flex items-center gap-2 border-t border-line px-3.5 py-6 text-12 text-ink-2"><Spinner size={13} label={t("checking")} />{t("compare", {count: view.file.rows})}</div>
      ) : rows.length === 0 ? (
        <EmptyState className="border-t border-line" icon={CircleCheck} title={t("noDuplicates")}>
          {t("noneHint")}
        </EmptyState>
      ) : (
        <>
          <div role="table" aria-label={t("duplicateTable")} className="flex flex-col">
            <div role="row" className="grid h-[31px] grid-cols-[56px_minmax(0,1fr)_132px_minmax(0,1fr)_118px] items-center gap-3 border-y border-line bg-subtle px-3.5 text-10 font-semibold uppercase tracking-label text-ink-3">
              <span role="columnheader">{t("row")}</span><span role="columnheader">{t("inFile")}</span><span role="columnheader">{t("matchedBy")}</span><span role="columnheader">{t("already")}</span><span role="columnheader">{t("whatHappens")}</span>
            </div>
            {rows.map((row) => {
              const action = duplicateAction(row);
              return (
                <div key={row.row} role="row" className="grid min-h-10 grid-cols-[56px_minmax(0,1fr)_132px_minmax(0,1fr)_118px] items-center gap-3 border-b border-line px-3.5 py-1.5">
                  <span role="cell" className="font-mono text-115 text-ink-3">{formatCount(row.row)}</span>
                  <span role="cell" className="truncate text-12 font-medium text-ink" title={row.label}>{row.label}</span>
                  <span role="cell" className="truncate text-115 text-ink-2">{locale === "pt-BR" ? t(row.matched_by === "linkedin" ? "linkedinProfile" : row.matched_by === "email" ? "email" : "nameCompany") : MATCHED_BY[row.matched_by]}</span>
                  <span role="cell" className="min-w-0 truncate text-115">
                    {row.contact ? <Link href={recordHref("contact", row.contact.id)} target="_blank" className="rounded-sm font-medium text-brand-strong hover:underline">{row.contact.name}</Link>
                      : <span className="text-ink-2">{t("otherRow", {count: row.repeats_row ?? 0})}</span>}
                  </span>
                  <span role="cell"><Pill tone={action.tone}>{locale === "pt-BR" ? t(row.action === "skip" ? "actionSkip" : row.action === "create" ? "actionCreate" : row.contact ? "actionUpdate" : "actionMerge") : action.label}</Pill></span>
                </div>
              );
            })}
          </div>
          <p className="flex items-start gap-2 rounded-b-lg bg-subtle px-3.5 py-2.5 text-11 leading-4 text-ink-2">
            <Copy size={13} className="mt-0.5 shrink-0 text-ink-3" aria-hidden="true" />
            <span>{check.duplicate_rows > rows.length ? t("firstOf", {shown: rows.length, total: check.duplicate_rows}) + " " : ""}{locale === "pt-BR" ? t(view.on_duplicate === "skip" ? "dupSkipHint" : view.on_duplicate === "update" ? "dupUpdateHint" : "dupImportHint") : ON_DUPLICATE_HINT[view.on_duplicate]} {t("changeDuplicate")}</span>
          </p>
        </>
      )}
    </Card>
  );
}

/** Step four: what the import will do, before it does it. */
export function ReviewStep({ view, check, checking, running, onRun }: { view: ImportView; check: ImportCheck | null; checking: boolean; running: boolean; onRun: () => void }) {
  const t = useTranslations("CsvStepPanels");
  const locale = useLocale();
  const made = newFields(view);
  const customTypes = {text: t("typeText"), number: t("typeNumber"), boolean: t("typeBoolean"), date: t("typeDate")};
  const list = view.list_mode === "new" ? t("newList", {name: view.new_list_name || t("notNamed")})
    : view.options.lists.find((option) => option.id === view.list_id)?.name ?? t("notChosen");
  const sum = check?.summary;
  const localizedLines = sum ? [
    {key: "create", value: formatCount(sum.create), label: t("reviewCreate", {count: sum.create}), note: null},
    {key: "update", value: formatCount(sum.update), label: t("reviewUpdate", {count: sum.update}),
      note: sum.merged ? t("reviewMerge", {count: sum.merged}) : null},
    {key: "joins", value: formatCount(sum.joins), label: t("reviewJoin", {name: list}),
      note: sum.already_in_list ? t("reviewAlready", {count: sum.already_in_list}) : null},
    {key: "left", value: formatCount(sum.skipped + sum.errors), label: t("reviewLeft", {count: sum.skipped + sum.errors}),
      note: [sum.skipped ? t("reviewSkipped", {count: sum.skipped}) : "", sum.errors ? t("reviewErrors", {count: sum.errors}) : ""].filter(Boolean).join(", ") || null},
  ] : [];
  return (
    <Card className="flex flex-col">
      <PanelHeader className="px-3.5 py-3" title={t("reviewTitle")} subtitle={t("reviewSubtitle")} actions={checking ? <Spinner size={14} label={t("checking")} /> : null} />
      {!check ? (
        <div className="flex items-center gap-2 border-t border-line px-3.5 py-6 text-12 text-ink-2"><Spinner size={13} label={t("checking")} />{t("checkingRows", {count: view.file.rows})}</div>
      ) : (
        <>
          <dl className="grid grid-cols-2 border-t border-line lg:grid-cols-4">
            {(locale === "pt-BR" ? localizedLines : reviewLines(view, check.summary)).map((line) => (
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
                <span className="text-12 font-semibold text-ink">{t("newField", {count: made.length})}</span>
                <ul className="flex flex-wrap gap-1.5">
                  {made.map((column) => column.mapping.kind === "custom" ? (
                    <li key={column.index}><Pill tone="brand" icon={Sparkles}><span className="font-mono">{column.mapping.key}</span><span className="font-normal">· {locale === "pt-BR" ? customTypes[column.mapping.fieldType] : TYPE_LABEL[column.mapping.fieldType]}</span></Pill></li>
                  ) : null)}
                </ul>
                <span className="text-11 text-ink-3">{t("newFieldHint", {key: "{{" + (made[0].mapping.kind === "custom" ? made[0].mapping.key : "key") + "}}"})}</span>
              </div>
            ) : null}
            {check.problem ? <Alert tone="warn" title={check.problem} /> : null}
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="primary" icon={Upload} loading={running} disabled={Boolean(check.problem) || checking} onClick={onRun}>
                {t("importRows", {count: check.summary.ready})}
              </Button>
              <span className="text-11 text-ink-3">{t("atomic")}</span>
            </div>
          </div>
        </>
      )}
    </Card>
  );
}

/** What the import did, and where to go next. */
export function ResultPanel({ view, result, canCampaign }: { view: ImportView; result: StoredResult; canCampaign: boolean }) {
  const t = useTranslations("CsvStepPanels");
  const locale = useLocale();
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
  const figures = resultFigures(result).map((figure) => ({
    ...figure, label: locale === "pt-BR" ?
      figure.key === "created" ? t("newContacts", {count: result.created}) :
      figure.key === "updated" ? t("updated") :
      figure.key === "joined" ? t("joined", {name: result.list.name}) : t("left") : figure.label,
  }));
  return (
    <Card className="flex flex-col">
      <div className="flex items-start gap-3 p-3.5">
        <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-good-tint text-good"><CircleCheck size={17} aria-hidden="true" /></span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="text-15 font-semibold tracking-[-0.15px] text-ink">{nothing ? t("nothingNew", {name: view.file.name}) : t("imported", {name: view.file.name})}</h2>
          <p className="text-12 text-ink-2">
            {t("into")} <Link href={recordHref("list", result.list.id)} className="rounded-sm font-semibold text-brand-strong hover:underline">{result.list.name}</Link>
            {result.new_list ? t("newListAside") : ""}. {t("rowsRead", {count: result.rows})}
            {result.custom_fields_created ? t("fieldsMade", {count: result.custom_fields_created}) : ""}. {t("rememberMapping")}
          </p>
        </div>
      </div>
      <dl className="grid grid-cols-2 border-y border-line lg:grid-cols-4">
        {figures.map((figure) => (
          <div key={figure.key} className="flex flex-col gap-0.5 border-b border-line px-3.5 py-3 lg:border-b-0 lg:border-r lg:last:border-r-0">
            <dd className="text-22 font-semibold tracking-[-0.4px] text-ink">{figure.value}</dd>
            <dt className="truncate text-115 text-ink-2">{figure.label}</dt>
          </div>
        ))}
      </dl>
      {result.merged > 0 || result.already_in_list > 0 ? (
        <p className="border-b border-line px-3.5 py-2.5 text-11 text-ink-2">
          {[result.merged ? t("merged", {count: result.merged}) : null,
            result.already_in_list ? t("alreadyInList", {count: result.already_in_list}) : null].filter(Boolean).join(" · ")}.
        </p>
      ) : null}
      {result.error_rows.length > 0 ? (
        <div className="flex flex-col gap-1.5 border-b border-line p-3.5">
          <span className="text-12 font-semibold text-ink">{t("errors", {count: result.errors})}</span>
          <ul className="max-h-[180px] overflow-y-auto rounded-md border border-line bg-subtle p-2.5 font-mono text-105 leading-[16px] text-ink-2">
            {result.error_rows.map((row) => <li key={row.row}>{t("rowReason", {number: row.row, reason: row.reason})}</li>)}
          </ul>
          {result.errors > result.error_rows.length ? <span className="text-11 text-ink-3">{t("firstError", {count: result.error_rows.length})}</span> : null}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 p-3.5">
        {canCampaign && wanted.mode !== "none" ? (
          <Button variant="primary" icon={Play} loading={starting} onClick={() => void setUpCampaign()}>{campaign ? t("setupExisting", {name: campaign.name}) : t("setupNew")}</Button>
        ) : null}
        <Button asChild variant={canCampaign && wanted.mode !== "none" ? "secondary" : "primary"}>
          <Link href={recordHref("list", result.list.id)}><ListChecks size={14} aria-hidden="true" />{t("openList", {name: result.list.name})}</Link>
        </Button>
        {canCampaign && wanted.mode === "none" ? <Button icon={Play} loading={starting} onClick={() => void setUpCampaign()}>{t("setupNew")}</Button> : null}
        <Button asChild variant="ghost"><Link href={newImportHref()}>{t("another")}<ArrowRight size={14} aria-hidden="true" /></Link></Button>
      </div>
    </Card>
  );
}
