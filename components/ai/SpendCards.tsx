import { useState } from "react";
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
  const change = spendChange(usage.month);
  const view = budgetView(usage.budget);
  const typed = parseBudget(draft.budget);
  const budgetChanged = typed === undefined || typed !== savedBudget;
  // The field stays open while what it holds is not yet saved.
  const [editingBudget, setEditingBudget] = useState(false);
  const showField = canEdit && (editingBudget || budgetChanged);
  const top = Math.max(...usage.daily.map((day) => day.cost_usd), 0.0001);

  return (
    <Card className="flex flex-col gap-3.5 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <Eyebrow>AI spend · {monthName(usage.month.key)}</Eyebrow>
          <span className="text-[27px] font-semibold leading-none tracking-figure text-ink">{formatUsd(usage.month.spent_usd)}</span>
        </div>
        {/* Spending less than last month is the good direction. */}
        {change ? <Delta value={change.label} direction={change.direction} good="down" /> : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex h-14 items-end gap-1" role="img" aria-label={`Spend on each of the last ${usage.daily.length} days, from ${formatUsd(Math.min(...usage.daily.map((day) => day.cost_usd)))} to ${formatUsd(top)} a day`}>
          {usage.daily.map((day, index) => (
            <span
              key={day.day}
              title={`${shortDay(day.day)}: ${formatUsd(day.cost_usd)} · ${day.requests.toLocaleString("en-US")} requests`}
              style={{ height: `${Math.max(4, Math.round((day.cost_usd / top) * 100))}%` }}
              // Today is still filling up, so it is told apart from the days that are done.
              className={cn("min-w-0 flex-1 rounded-xs", index === usage.daily.length - 1 ? "bg-brand" : "bg-control")}
            />
          ))}
        </div>
        <div className="flex items-center justify-between text-10 text-ink-3">
          <span>{shortDay(usage.daily[0].day)}</span>
          <span>{change ? `${change.label} against the same days of last month` : `${usage.month.requests.toLocaleString("en-US")} requests this month`}</span>
          <span>{shortDay(usage.daily[usage.daily.length - 1].day)}</span>
        </div>
      </div>

      <div className="flex flex-col gap-[7px] border-t border-line pt-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-12 font-medium text-ink">Monthly budget</span>
          <span className="flex items-baseline gap-[3px]">
            {usage.budget.budget_usd === null ? (
              <span className="text-11 text-ink-3">None set</span>
            ) : (
              <>
                <span className="text-115 font-medium text-ink">{formatUsd(usage.budget.spent_usd)}</span>
                <span className="text-11 text-ink-3">/ {formatUsd(usage.budget.budget_usd)}</span>
              </>
            )}
            {canEdit && !showField ? <TextAction className="ml-2" onClick={() => setEditingBudget(true)}>{usage.budget.budget_usd === null ? "Set one" : "Change"}</TextAction> : null}
          </span>
        </div>
        {view ? <Meter value={view.share} max={1} tone={view.tone} height={5} label="Share of the monthly budget spent" /> : null}
        <p className={cn("text-105", view?.tone === "bad" ? "text-bad" : view?.tone === "warn" ? "text-warn" : "text-ink-3")}>
          {view ? view.note : "With no budget, AI writing is never paused. Set one and steps written by AI wait once the month's spend reaches it."}
        </p>
        {showField ? (
          <Field
            label="Budget for a calendar month, in US dollars"
            error={typed === undefined ? "An amount above zero, such as 100 or 49.50" : undefined}
            hint={`Leave empty for no budget. Counted in UTC; sorting replies is not paused but counts towards it.${budgetChanged ? " Takes effect when you save changes." : ""}`}
          >
            {(id) => (
              <Input
                id={id} inputMode="decimal" autoFocus={editingBudget} value={draft.budget} invalid={typed === undefined} placeholder="No budget"
                // Opened to change the amount: typing replaces what is there.
                onFocus={(event) => event.target.select()}
                onChange={(event) => onDraft({ budget: event.target.value.replace(/[^0-9.,$]/g, "").slice(0, 10) })}
                trailing={<span className="shrink-0 text-105 text-ink-3">per month</span>}
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
  const [by, setBy] = useState<"step" | "model">("step");
  const rows = by === "step"
    ? usage.by_purpose.map((row) => ({ key: row.purpose, name: PURPOSE_LABEL[row.purpose] ?? row.purpose, cost: row.cost_usd, note: requestsNote(row.purpose, row.requests), fill: TONE_SOLID[PURPOSE_TONE[row.purpose] ?? "neutral"] }))
    : usage.by_model.map((row) => ({ key: row.model, name: modelName(row.model, models), cost: row.cost_usd, note: requestsNote(null, row.requests), fill: TONE_SOLID.brand }));
  const top = Math.max(...rows.map((row) => row.cost), 0.0001);

  return (
    <Card className="flex flex-col gap-[13px] p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-15 font-semibold tracking-[-0.15px] text-ink">Spend by {by}</h2>
        <Segmented size="sm" label="Break spend down by" value={by} onChange={setBy} options={[{ value: "step", label: "Step" }, { value: "model", label: "Model" }]} />
      </div>
      {rows.length === 0 ? (
        <p className="py-3 text-115 leading-[17px] text-ink-2">Nothing has been spent in {monthName(usage.month.key)} yet. Each request is listed here as soon as it is made.</p>
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
      <p className="border-t border-line pt-2.5 text-105 leading-[15px] text-ink-3">{monthName(usage.month.key)} so far, as OpenRouter reported the cost of each request.</p>
    </Card>
  );
}
