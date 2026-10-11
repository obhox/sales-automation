import { useState } from "react";
import { CircleCheck, CircleHelp, CircleX, RefreshCw, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button, Card, Input, Pill, ScoreRing, TextAction, Tooltip } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { recordRows, scoreSummary, type DomainDnsDetail } from "./model";

/** A sending domain's four DNS records: its score, what would raise it, and each record as receiving servers see it. */
export function DnsCard({ domain, dns, canEdit, onChanged }: { domain: string; dns: DomainDnsDetail; canEdit: boolean; onChanged: () => void }) {
  const [checking, setChecking] = useState(false);
  const [editing, setEditing] = useState(false);
  const [selector, setSelector] = useState(dns.dkim_selector_set ?? "");
  const summary = scoreSummary(domain, dns);
  const rows = recordRows(dns);
  const more = dns.score?.fixes.slice(1) ?? [];
  const [showMore, setShowMore] = useState(false);

  async function check(body: Record<string, unknown>, done: string) {
    setChecking(true);
    try {
      const result = await api<{ changes: unknown[] }>("/api/deliverability/dns", { method: "POST", body: { domain, ...body } });
      toast.success(done, result.changes.length ? { description: `${result.changes.length} ${result.changes.length === 1 ? "record has" : "records have"} changed since the last check. See the log.` } : undefined);
      setEditing(false);
      onChanged();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setChecking(false);
    }
  }

  return (
    <Card className="flex flex-col gap-[13px] p-3.5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-15 font-semibold tracking-[-0.15px] text-ink">Domain authentication</h2>
        {canEdit ? (
          <button type="button" disabled={checking} onClick={() => void check({}, `DNS records for ${domain} checked`)} className="inline-flex h-6 items-center gap-[5px] rounded-md px-[7px] text-11 font-semibold text-brand-strong hover:bg-brand-tint disabled:opacity-50">
            <RefreshCw size={12} className={cn(checking && "animate-spin")} aria-hidden="true" />
            {dns.checked_at ? "Re-check" : "Check now"}
          </button>
        ) : null}
      </div>

      <div className="flex items-center gap-3.5">
        <ScoreRing score={dns.score?.score ?? null} />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <p className="text-13 font-medium text-ink">{summary.headline}</p>
          <p className="text-11 leading-4 text-ink-2">{summary.body}</p>
          {more.length > 0 ? (
            <TextAction className="self-start" aria-expanded={showMore} onClick={() => setShowMore(!showMore)}>
              {showMore ? "Hide" : "Show"} the other {more.length === 1 ? "fix" : `${more.length} fixes`}
            </TextAction>
          ) : null}
        </div>
      </div>

      {showMore && more.length > 0 ? (
        <ul className="flex list-disc flex-col gap-1 rounded-lg bg-subtle py-2.5 pl-7 pr-2.5 text-105 leading-[15px] text-ink-2">
          {more.map((fix) => <li key={fix.key}>{fix.advice}</li>)}
        </ul>
      ) : null}

      {rows.length > 0 ? (
        <ul className="flex flex-col border-t border-line">
          {rows.map((row) => (
            <li key={row.key} className="flex min-h-11 items-center gap-2.5 border-b border-line py-1.5 last:border-b-0">
              <RecordIcon tone={row.badge.tone} />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-center gap-2 text-12 font-medium text-ink">
                  {row.name}
                  {row.key === "dkim" && canEdit && !editing ? <TextAction className="text-105 font-medium" onClick={() => setEditing(true)}>{dns.dkim_selector_set ? "Change selector" : "Enter selector"}</TextAction> : null}
                </span>
                <span className="truncate font-mono text-10 text-ink-3" title={row.value}>{row.value}</span>
              </div>
              {row.note ? (
                <Tooltip label={row.note}>
                  <span tabIndex={0} role="img" aria-label={`${row.name}: ${row.badge.label}. ${row.note}`} className="inline-flex rounded-full"><Pill tone={row.badge.tone}>{row.badge.label}</Pill></span>
                </Tooltip>
              ) : (
                <Pill tone={row.badge.tone}>{row.badge.label}</Pill>
              )}
            </li>
          ))}
        </ul>
      ) : null}

      {editing ? (
        <form className="flex items-end gap-2" onSubmit={(event) => { event.preventDefault(); if (!checking) void check({ selector: selector.trim() }, selector.trim() ? `Selector saved and ${domain} checked` : `Selector cleared and ${domain} checked`); }}>
          <label className="flex min-w-0 flex-1 flex-col gap-1.5 text-105 font-semibold text-ink-2">
            DKIM selector{dns.dkim_selector && !dns.dkim_selector_set ? ` (found under "${dns.dkim_selector}" by trying the usual ones)` : ""}
            <Input value={selector} onChange={(event) => setSelector(event.target.value)} placeholder="google" autoFocus autoComplete="off" spellCheck={false} />
          </label>
          <Button type="submit" variant="primary" loading={checking}>Save and check</Button>
          <Button onClick={() => { setEditing(false); setSelector(dns.dkim_selector_set ?? ""); }}>Cancel</Button>
        </form>
      ) : null}
    </Card>
  );
}

function RecordIcon({ tone }: { tone: string }) {
  const Glyph = tone === "good" ? CircleCheck : tone === "warn" ? TriangleAlert : tone === "bad" ? CircleX : CircleHelp;
  return <Glyph size={14} className={cn("shrink-0", tone === "good" ? "text-good" : tone === "warn" ? "text-warn" : tone === "bad" ? "text-bad" : "text-ink-3")} aria-hidden="true" />;
}
