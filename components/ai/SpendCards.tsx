import { useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import { Card, Delta, Eyebrow, Field, Input, Meter, Segmented, TextAction, TONE_SOLID } from "@/components/ui";
import { cn } from "@/lib/client/cn";
import {
  PURPOSE_LABEL, PURPOSE_TONE, budgetView, formatUsd, modelName, monthName, parseBudget, requestsNote, shortDay, spendChange,
  type Draft, type ModelInfo, type UsageOverview,
} from "./model";

/** This month's AI spend, the last fourteen days, and the monthly budget. */
export function SpendCard({
  usage,
  draft,
  onDraft,
  savedBudget,
  canEdit,
}: {
  usage: UsageOverview;
  draft: Draft;
  onDraft: (patch: Partial<Draft>) => void;
  savedBudget: number | null;
  canEdit: boolean;
}) {
  const t = useTranslations("AiSpend");
  const locale = useLocale();
  const month = (key: string) => locale === "pt-BR"
    ? new Intl.DateTimeFormat("pt-BR", {month: "long", timeZone: "UTC"}).format(new Date(key.slice(0,7) + "-01T12:00:00Z"))
    : monthName(key);
  const shortDate = (day: string) => locale === "pt-BR"
    ? new Intl.DateTimeFormat("pt-BR", {day: "2-digit", month: "short", timeZone: "UTC"}).format(new Date(day + "T12:00:00Z"))
    : shortDay(day);
  const change = spendChange(usage.month);
  const view = budgetView(usage.budget);
  const typed = parseBudget(draft.budget);
  const budgetChanged = typed === undefined || typed !== savedBudget;
  // The field stays open while what it holds is not yet saved.
  const [editingBudget, setEditingBudget] = useState(false);
  const showField = canEdit && (editingBudget || budgetChanged);
  const top = Math.max(...usage.daily.map((day) => day.cost_usd), 0.0001);
  const budgetNote = view ? locale !== "pt-BR" ? view.note
    : usage.budget.reached ? t("budgetReached", {date: shortDate(usage.budget.resets_on)})
    : view.share >= .8 ? t("budgetWarning", {percent: Math.round(view.share * 100), date: shortDate(usage.budget.resets_on)})
    : t("budgetNormal", {date: shortDate(usage.budget.resets_on)}) : t("noBudget");

  return (
    <Card className="flex flex-col gap-3.5 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <Eyebrow>{t("title", {month: month(usage.month.key)})}</Eyebrow>
          <span className="text-[27px] font-semibold leading-none tracking-figure text-ink">{formatUsd(usage.month.spent_usd)}</span>
        </div>
        {/* Spending less than last month is the good direction. */}
        {change ? <Delta value={change.label} direction={change.direction} good="down" /> : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex h-14 items-end gap-1" role="img" aria-label={t("chart", {days: usage.daily.length, min: formatUsd(Math.min(...usage.daily.map((day) => day.cost_usd))), max: formatUsd(top)})}>
          {usage.daily.map((day, index) => (
            <span
              key={day.day}
              title={t("daily", {day: shortDate(day.day), cost: formatUsd(day.cost_usd), count: day.requests})}
              style={{ height: `${Math.max(4, Math.round((day.cost_usd / top) * 100))}%` }}
              // Today is still filling up, so it is told apart from the days that are done.
              className={cn("min-w-0 flex-1 rounded-xs", index === usage.daily.length - 1 ? "bg-brand" : "bg-control")}
            />
          ))}
        </div>
        <div className="flex items-center justify-between text-10 text-ink-3">
          <span>{shortDate(usage.daily[0].day)}</span>
          <span>{change ? t("comparison", {change: change.label}) : t("requestsMonth", {count: usage.month.requests})}</span>
          <span>{shortDate(usage.daily[usage.daily.length - 1].day)}</span>
        </div>
      </div>

      <div className="flex flex-col gap-[7px] border-t border-line pt-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-12 font-medium text-ink">{t("monthlyBudget")}</span>
          <span className="flex items-baseline gap-[3px]">
            {usage.budget.budget_usd === null ? (
              <span className="text-11 text-ink-3">{t("none")}</span>
            ) : (
              <>
                <span className="text-115 font-medium text-ink">{formatUsd(usage.budget.spent_usd)}</span>
                <span className="text-11 text-ink-3">/ {formatUsd(usage.budget.budget_usd)}</span>
              </>
            )}
            {canEdit && !showField ? <TextAction className="ml-2" onClick={() => setEditingBudget(true)}>{usage.budget.budget_usd === null ? t("setOne") : t("change")}</TextAction> : null}
          </span>
        </div>
        {view ? <Meter value={view.share} max={1} tone={view.tone} height={5} label={t("share")} /> : null}
        <p className={cn("text-105", view?.tone === "bad" ? "text-bad" : view?.tone === "warn" ? "text-warn" : "text-ink-3")}>
          {budgetNote}
        </p>
        {showField ? (
          <Field
            label={t("budgetField")}
            error={typed === undefined ? t("budgetInvalid") : undefined}
            hint={t("budgetHint") + (budgetChanged ? t("effective") : "")}
          >
            {(id) => (
              <Input
                id={id} inputMode="decimal" autoFocus={editingBudget} value={draft.budget} invalid={typed === undefined} placeholder={t("noBudgetPlaceholder")}
                // Opened to change the amount: typing replaces what is there.
                onFocus={(event) => event.target.select()}
                onChange={(event) => onDraft({ budget: event.target.value.replace(/[^0-9.,$]/g, "").slice(0, 10) })}
                trailing={<span className="shrink-0 text-105 text-ink-3">{t("perMonth")}</span>}
              />
            )}
          </Field>
        ) : null}
      </div>
    </Card>
  );
}

/** Where this month's spend went: by what was being written, or by which model wrote it. */
export function BreakdownCard({ usage, models }: { usage: UsageOverview; models: ModelInfo[] }) {
  const t = useTranslations("AiSpend");
  const locale = useLocale();
  const [by, setBy] = useState<"step" | "model">("step");
  const month = (key: string) => locale === "pt-BR"
    ? new Intl.DateTimeFormat("pt-BR", {month: "long", timeZone: "UTC"}).format(new Date(key.slice(0,7) + "-01T12:00:00Z"))
    : monthName(key);
  const purposeNames: Record<string, string> = {
    email_opener: t("emailOpener"), email_followup: t("emailFollowup"), linkedin_message: t("liMessages"),
    inmail: t("inmail"), classification: t("classification"), rewrite: t("rewrite"),
    research: t("research"), test: t("tests"), other: t("other"),
  };
  const rows = by === "step"
    ? usage.by_purpose.map((row) => ({ key: row.purpose, name: purposeNames[row.purpose] ?? PURPOSE_LABEL[row.purpose] ?? row.purpose, cost: row.cost_usd, note: locale === "pt-BR" ? t(row.purpose === "classification" ? "replies" : "generations", {count: row.requests}) : requestsNote(row.purpose, row.requests), fill: TONE_SOLID[PURPOSE_TONE[row.purpose] ?? "neutral"] }))
    : usage.by_model.map((row) => ({ key: row.model, name: modelName(row.model, models), cost: row.cost_usd, note: locale === "pt-BR" ? t("requests", {count: row.requests}) : requestsNote(null, row.requests), fill: TONE_SOLID.brand }));
  const top = Math.max(...rows.map((row) => row.cost), 0.0001);

  return (
    <Card className="flex flex-col gap-[13px] p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-15 font-semibold tracking-[-0.15px] text-ink">{t("breakdown", {kind: t(by === "step" ? "step" : "model")})}</h2>
        <Segmented size="sm" label={t("breakLabel")} value={by} onChange={setBy} options={[{ value: "step", label: t("step") }, { value: "model", label: t("model") }]} />
      </div>
      {rows.length === 0 ? (
        <p className="py-3 text-115 leading-[17px] text-ink-2">{t("breakEmpty", {month: month(usage.month.key)})}</p>
      ) : (
        <ul className="flex flex-col gap-[13px]">
          {rows.map((row) => (
            <li key={row.key} className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-12 font-medium text-ink" title={row.key}>{row.name}</span>
                <span className="shrink-0 text-115 font-medium text-ink">{formatUsd(row.cost)}</span>
              </div>
              <div className="h-[5px] w-full overflow-hidden rounded-full bg-control" aria-hidden="true">
                <div style={{ width: `${Math.max(2, (row.cost / top) * 100)}%` }} className={cn("h-full rounded-full", row.fill)} />
              </div>
              <span className="text-105 text-ink-3">{row.note}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="border-t border-line pt-2.5 text-105 leading-[15px] text-ink-3">{t("soFar", {month: month(usage.month.key)})}</p>
    </Card>
  );
}
