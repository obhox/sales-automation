import Head from "next/head";
import { useEffect, useState, useCallback } from "react";
import { toast } from "sonner";
import { RiMailLine, RiRefreshLine, RiShieldCheckLine, RiAlertLine, RiFireLine } from "react-icons/ri";

interface WarmupRow {
  email_account_id: string;
  name: string;
  from_email: string;
  enabled: number;
  daily_target: number;
  reply_rate: number;
  sent_today: number;
  delivered_total?: number;
  rescued_total?: number;
  rescued_today?: number;
}

interface DayData { day: string; sent: number; limit: number; }
interface AccountRow {
  id: string; name: string; from_email: string;
  daily_email_limit: number; ramp_up_enabled: number; ramp_start_date: string | null;
  effective_limit_today: number; sent_today: number;
  days: DayData[];
}
interface LogEntry { created_at: string; message: string; email_account_id: string; }
interface GuardEntry { created_at: string; message: string; email_account_id: string | null; }

interface Data {
  accounts: AccountRow[];
  days: string[];
  recentLogs: LogEntry[];
  guardTrips: GuardEntry[];
}

const TZ = "Europe/Berlin";

function formatDay(d: string) {
  return new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { month: "short", day: "numeric", timeZone: TZ });
}

function formatTime(ts: string) {
  return new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: TZ });
}

function formatDateTime(ts: string) {
  const d = new Date(ts);
  return d.toLocaleDateString("en-GB", { month: "short", day: "numeric", timeZone: TZ }) + " " +
    d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
}

export default function EmailHealth() {
  const [data, setData] = useState<Data | null>(null);
  const [warmup, setWarmup] = useState<WarmupRow[]>([]);
  const [savingWarmup, setSavingWarmup] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      fetch("/api/email-health").then(r => r.json()),
      fetch("/api/platform/deliverability").then(r => r.ok ? r.json() : { warmup: [] }).catch(() => ({ warmup: [] })),
    ])
      .then(([health, deliver]) => {
        setData(health);
        setWarmup(deliver?.warmup ?? []);
        setLastRefresh(new Date());
      })
      .finally(() => setLoading(false));
  }, []);

  async function saveWarmup(row: WarmupRow, patch: Partial<WarmupRow>) {
    setSavingWarmup(row.email_account_id);
    const next = { ...row, ...patch };
    setWarmup(w => w.map(x => x.email_account_id === row.email_account_id ? next : x));
    try {
      const res = await fetch("/api/platform/deliverability", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "configure_warmup",
          email_account_id: row.email_account_id,
          enabled: next.enabled === 1,
          daily_target: next.daily_target,
          reply_rate: next.reply_rate,
        }),
      });
      if (!res.ok) throw new Error("Failed to update warmup");
      toast.success("Warmup updated");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update warmup");
      load();
    } finally {
      setSavingWarmup(null);
    }
  }

  useEffect(() => { load(); }, [load]);

  // Auto-refresh every 60s
  useEffect(() => {
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  const today = new Date().toISOString().slice(0, 10);

  const totalToday = data?.accounts.reduce((s, a) => s + a.sent_today, 0) ?? 0;
  const totalLimit = data?.accounts.reduce((s, a) => s + a.effective_limit_today, 0) ?? 0;
  const overLimit = data?.accounts.filter(a => a.sent_today > a.effective_limit_today) ?? [];

  return (
    <>
      <Head><title>Email Health — Linki</title></Head>
      <div className="space-y-6">

        {/* Page header */}
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <p className="mb-2 text-[13px] font-medium text-base-content/45">Deliverability</p>
            <h1 className="text-[30px] font-semibold leading-[1.1] tracking-[-.03em] text-base-content">Email health</h1>
            <p className="mt-2 text-[15px] text-base-content/50">Warmup, ramp-up, and daily send volume across every connected inbox.</p>
          </div>
          <div className="flex items-center gap-3">
            {lastRefresh && (
              <span className="text-xs text-base-content/40">
                Updated {formatTime(lastRefresh.toISOString())}
              </span>
            )}
            <button
              onClick={load}
              disabled={loading}
              className="inline-flex items-center gap-1.5 rounded-[10px] border border-[var(--border)] bg-base-100 px-3 py-1.5 text-sm font-medium text-base-content/70 transition-colors hover:bg-base-200 disabled:opacity-50"
            >
              <RiRefreshLine size={13} className={loading ? "animate-spin" : ""} />
              Refresh
            </button>
          </div>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div className="rounded-2xl border border-[var(--border-subtle)] bg-base-100 p-5 shadow-[var(--shadow-raised)]">
            <div className="mb-1 text-[13px] text-base-content/45">Sent today</div>
            <div className="text-[28px] font-semibold leading-none tracking-[-.03em] text-base-content tabular-nums">{totalToday}</div>
          </div>
          <div className="rounded-2xl border border-[var(--border-subtle)] bg-base-100 p-5 shadow-[var(--shadow-raised)]">
            <div className="mb-1 text-[13px] text-base-content/45">Total limit today</div>
            <div className="text-[28px] font-semibold leading-none tracking-[-.03em] text-base-content tabular-nums">{totalLimit}</div>
          </div>
          <div className="rounded-2xl border border-[var(--border-subtle)] bg-base-100 p-5 shadow-[var(--shadow-raised)]">
            <div className="mb-1 text-[13px] text-base-content/45">Accounts active</div>
            <div className="text-[28px] font-semibold leading-none tracking-[-.03em] text-base-content tabular-nums">
              {data?.accounts.filter(a => a.sent_today > 0).length ?? 0}
            </div>
          </div>
          {overLimit.length > 0 ? (
            <div className="rounded-2xl border border-error/20 bg-error/10 p-5 shadow-[var(--shadow-raised)]">
              <div className="mb-1 flex items-center gap-1.5 text-[13px] text-error">
                <RiAlertLine size={12} /> Over limit today
              </div>
              <div className="text-[28px] font-semibold leading-none tracking-[-.03em] text-error tabular-nums">{overLimit.length}</div>
            </div>
          ) : (
            <div className="rounded-2xl border border-success/20 bg-success/10 p-5 shadow-[var(--shadow-raised)]">
              <div className="mb-1 flex items-center gap-1.5 text-[13px] text-success">
                <RiShieldCheckLine size={12} /> All within limits
              </div>
              <div className="text-[28px] font-semibold leading-none tracking-[-.03em] text-success">✓</div>
            </div>
          )}
        </div>

        {/* Mailbox warmup — across every connected inbox */}
        <div className="overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-base-100 shadow-[var(--shadow-raised)]">
          <div className="flex items-center justify-between gap-3 border-b border-[var(--border-subtle)] px-5 py-3.5">
            <div className="flex items-center gap-2">
              <RiFireLine size={14} className="text-base-content/40" />
              <span className="text-sm font-semibold text-base-content">Mailbox warmup</span>
            </div>
            <span className="text-xs text-base-content/40">
              {warmup.filter(w => w.enabled).length}/{warmup.length} inboxes warming
            </span>
          </div>
          <p className="px-5 pt-3 text-[13px] text-base-content/50">
            Your connected inboxes warm each other up by exchanging real messages and engaging with them (opening, rescuing from spam, replying). Enable it on every inbox — warmup needs at least two active inboxes to exchange mail.
          </p>
          {warmup.length === 0 ? (
            <div className="px-5 py-8 text-center text-xs text-base-content/35">No email accounts connected yet.</div>
          ) : (
            <div className="divide-y divide-[var(--border-subtle)] p-2">
              {warmup.map(w => (
                <div key={w.email_account_id} className="flex flex-wrap items-center gap-4 px-3 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-base-content truncate">{w.name}</div>
                    <div className="mt-0.5 text-xs text-base-content/40 truncate">{w.from_email}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-semibold tabular-nums text-base-content">{w.sent_today}</div>
                    <div className="text-[10px] text-base-content/40">sent today</div>
                  </div>
                  <div className="text-right" title="Warmup emails that landed in a peer's spam folder and were automatically moved back to the inbox">
                    <div className={`text-sm font-semibold tabular-nums ${(w.rescued_total ?? 0) > 0 ? "text-warning" : "text-base-content/30"}`}>
                      {w.rescued_total ?? 0}
                      {(w.rescued_today ?? 0) > 0 && <span className="ml-1 text-[10px] font-normal text-warning/70">+{w.rescued_today} today</span>}
                    </div>
                    <div className="text-[10px] text-base-content/40">rescued from spam</div>
                  </div>
                  <label className="flex flex-col items-start gap-1">
                    <span className="text-[10px] text-base-content/40">Daily target</span>
                    <input
                      type="number"
                      min={1}
                      max={50}
                      value={w.daily_target}
                      onChange={e => setWarmup(list => list.map(x => x.email_account_id === w.email_account_id ? { ...x, daily_target: Math.max(1, Math.min(50, Number(e.target.value) || 1)) } : x))}
                      onBlur={() => saveWarmup(w, { daily_target: w.daily_target })}
                      className="w-16 rounded-[10px] border border-[var(--border)] bg-base-100 px-2 py-1 text-sm tabular-nums focus:outline-none focus:shadow-[var(--focus-ring)]"
                    />
                  </label>
                  <button
                    type="button"
                    disabled={savingWarmup === w.email_account_id}
                    onClick={() => saveWarmup(w, { enabled: w.enabled ? 0 : 1 })}
                    aria-pressed={w.enabled === 1}
                    title={w.enabled ? "Warming — click to pause" : "Paused — click to warm"}
                    className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-[var(--border-subtle)] transition-colors disabled:opacity-50 ${w.enabled ? "bg-primary" : "bg-base-300"}`}
                  >
                    <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${w.enabled ? "translate-x-6" : "translate-x-1"}`} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Per-account table */}
        <div className="overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-base-100 shadow-[var(--shadow-raised)]">
          <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-5 py-3.5">
            <RiMailLine size={14} className="text-base-content/40" />
            <span className="text-sm font-semibold text-base-content">Accounts — last 7 days</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border-subtle)]">
                  <th className="whitespace-nowrap px-5 py-2.5 text-left text-xs font-medium text-base-content/45">Account</th>
                  <th className="whitespace-nowrap px-4 py-2.5 text-right text-xs font-medium text-base-content/45">
                    Today<br/>
                    <span className="font-normal text-base-content/30">{formatDay(today)}</span>
                  </th>
                  {data?.days.slice(0, -1).reverse().map(d => (
                    <th key={d} className="whitespace-nowrap px-4 py-2.5 text-right text-xs font-medium text-base-content/30">
                      {formatDay(d)}
                    </th>
                  ))}
                  <th className="whitespace-nowrap px-5 py-2.5 text-right text-xs font-medium text-base-content/45">Limit today</th>
                </tr>
              </thead>
              <tbody>
                {data?.accounts.map(a => {
                  const over = a.sent_today > a.effective_limit_today;
                  return (
                    <tr key={a.id} className="border-b border-[var(--border-subtle)] transition-colors hover:bg-base-200">
                      <td className="px-5 py-3">
                        <div className="text-xs font-medium text-base-content">{a.name}</div>
                        <div className="mt-0.5 text-xs text-base-content/40">{a.from_email}</div>
                        {a.ramp_start_date && (
                          <div className="mt-0.5 text-[10px] text-base-content/35">
                            Ramp from {a.ramp_start_date}
                          </div>
                        )}
                      </td>
                      {/* Today */}
                      <td className="px-4 py-3 text-right">
                        <span className={`text-sm font-semibold tabular-nums ${over ? "text-error" : a.sent_today > 0 ? "text-base-content" : "text-base-content/30"}`}>
                          {a.sent_today}
                        </span>
                        {over && <span className="ml-1 text-xs text-error/70">↑</span>}
                        {/* Mini bar */}
                        <div className="ml-auto mt-1 h-1 w-16 rounded-full bg-base-200">
                          <div
                            className={`h-1 rounded-full ${over ? "bg-error" : "bg-primary"}`}
                            style={{ width: `${Math.min(100, (a.sent_today / Math.max(a.effective_limit_today, 1)) * 100)}%` }}
                          />
                        </div>
                      </td>
                      {/* Past 6 days — newest first */}
                      {a.days.slice(0, -1).reverse().map(d => (
                        <td key={d.day} className="px-4 py-3 text-right">
                          <span className={`text-xs tabular-nums ${d.sent > d.limit ? "text-error" : d.sent > 0 ? "text-base-content/60" : "text-base-content/20"}`}>
                            {d.sent > 0 ? d.sent : "—"}
                          </span>
                        </td>
                      ))}
                      <td className="px-5 py-3 text-right text-xs tabular-nums text-base-content/50">
                        {a.effective_limit_today}
                        {a.ramp_up_enabled && a.ramp_start_date && a.effective_limit_today < a.daily_email_limit && (
                          <span className="ml-1 text-base-content/30">(ramp)</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t border-[var(--border-subtle)] bg-base-200">
                  <td className="px-5 py-2.5 text-xs font-medium text-base-content/60">Total</td>
                  <td className="px-4 py-2.5 text-right text-sm font-semibold tabular-nums text-base-content">{totalToday}</td>
                  {data?.days.slice(0, -1).reverse().map(d => {
                    const sum = data.accounts.reduce((s, a) => s + (a.days.find(x => x.day === d)?.sent ?? 0), 0);
                    return (
                      <td key={d} className="px-4 py-2.5 text-right text-xs tabular-nums text-base-content/50">
                        {sum > 0 ? sum : "—"}
                      </td>
                    );
                  })}
                  <td className="px-5 py-2.5 text-right text-xs font-medium tabular-nums text-base-content/50">{totalLimit}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {/* Recent send log */}
          <div className="overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-base-100 shadow-[var(--shadow-raised)]">
            <div className="border-b border-[var(--border-subtle)] px-5 py-3.5">
              <span className="text-sm font-semibold text-base-content">Recent sends</span>
              <span className="ml-2 text-xs text-base-content/40">last 50</span>
            </div>
            <div className="max-h-96 divide-y divide-[var(--border-subtle)] overflow-y-auto">
              {data?.recentLogs.map((l, i) => {
                const acc = data.accounts.find(a => a.id === l.email_account_id);
                return (
                  <div key={i} className="flex items-start justify-between gap-4 px-5 py-2.5">
                    <div>
                      <div className="text-xs text-base-content/80">{l.message.replace("Email sent to ", "")}</div>
                      <div className="mt-0.5 text-[10px] text-base-content/35">{acc?.name ?? l.email_account_id.slice(0, 8)}</div>
                    </div>
                    <div className="shrink-0 whitespace-nowrap text-[10px] text-base-content/35">{formatDateTime(l.created_at)}</div>
                  </div>
                );
              })}
              {data?.recentLogs.length === 0 && (
                <div className="px-5 py-8 text-center text-xs text-base-content/35">No sends recorded</div>
              )}
            </div>
          </div>

          {/* Guard trips */}
          <div className="overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-base-100 shadow-[var(--shadow-raised)]">
            <div className="border-b border-[var(--border-subtle)] px-5 py-3.5">
              <span className="text-sm font-semibold text-base-content">Limit guard trips</span>
              <span className="ml-2 text-xs text-base-content/40">today</span>
            </div>
            <div className="max-h-96 divide-y divide-[var(--border-subtle)] overflow-y-auto">
              {data?.guardTrips.map((g, i) => {
                const acc = g.email_account_id ? data.accounts.find(a => a.id === g.email_account_id) : null;
                return (
                  <div key={i} className="flex items-start justify-between gap-4 px-5 py-2.5">
                    <div>
                      <div className="text-xs text-warning">{g.message.replace("Daily limit reached — ", "→ ")}</div>
                      {acc && <div className="mt-0.5 text-[10px] text-base-content/35">{acc.name}</div>}
                    </div>
                    <div className="shrink-0 whitespace-nowrap text-[10px] text-base-content/35">{formatDateTime(g.created_at)}</div>
                  </div>
                );
              })}
              {data?.guardTrips.length === 0 && (
                <div className="px-5 py-8 text-center text-xs text-success/60">No guard trips today</div>
              )}
            </div>
          </div>
        </div>

      </div>
    </>
  );
}
