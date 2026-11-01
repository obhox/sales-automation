import { useEffect, useRef, useState } from "react";
import {useTranslations} from "next-intl";
import { Inbox, Plus, Send, X } from "lucide-react";
import { toast } from "sonner";
import { Alert, Button, Dialog, Eyebrow, IconButton, Input, Pill, Select, Spinner, Tooltip } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import type { MailboxView } from "@/components/mailboxes/model";
import { MANUAL_PLACEMENTS, canSendTest, placementBadge, runIsLooking, runLine, type PlacementResult, type PlacementRun, type PlacementTest, type Seed } from "./model";

export interface PlacementDialogProps {
  open: boolean;
  /** The mailbox to send from, when the dialog was opened from one. */
  from?: string | null;
  domain: string;
  mailboxes: MailboxView[];
  seeds: Seed[];
  runs: PlacementRun[];
  canEdit: boolean;
  onClose: () => void;
  onChanged: () => void;
}

/** Send one email from a mailbox to every seed address, and see which folder each copy landed in. */
export function PlacementDialog({ open, from, domain, mailboxes, seeds, runs, canEdit, onClose, onChanged }: PlacementDialogProps) {
  const t = useTranslations("DeliverabilityPlacement");
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }} title={t("title")} description={t("subtitle", {domain})} icon={Inbox} size="lg">
      {open ? <PlacementBody from={from} domain={domain} mailboxes={mailboxes} seeds={seeds} runs={runs} canEdit={canEdit} onChanged={onChanged} /> : null}
    </Dialog>
  );
}

/** How often, and for how long, a run that was just sent is looked for. */
const LOOK_EVERY_MS = 6_000;
const LOOK_FOR_MS = 120_000;

function PlacementBody({ from: asked, domain, mailboxes, seeds, runs, canEdit, onChanged }: Omit<PlacementDialogProps, "open" | "onClose">) {
  const t = useTranslations("DeliverabilityPlacement");
  const senders = mailboxes.filter(canSendTest);
  const [from, setFrom] = useState<string | undefined>(senders.find((mailbox) => mailbox.id === asked)?.id ?? senders[0]?.id);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lookingSince = useRef<number | null>(null);
  const latest = runs[0];
  const looking = canEdit && latest !== undefined && runIsLooking(latest);

  // A run that has copies in mailboxes Linki can read is looked for until they turn up.
  useEffect(() => {
    if (!looking || !latest) return;
    lookingSince.current ??= Date.now();
    const timer = window.setTimeout(async () => {
      if (Date.now() - (lookingSince.current ?? 0) > LOOK_FOR_MS) return;
      try {
        await api("/api/deliverability/placement", { method: "PUT", body: { run_id: latest.id } });
      } catch {
        // The next look, or the background check, will say.
      }
      onChanged();
    }, LOOK_EVERY_MS);
    return () => window.clearTimeout(timer);
  }, [looking, latest, onChanged]);

  async function send() {
    if (!from) return;
    setSending(true);
    setError(null);
    try {
      const { run } = await api<{ run: PlacementRun }>("/api/deliverability/placement", { method: "POST", body: { email_account_id: from } });
      const failed = run.tests.filter((test) => test.status === "failed").length;
      lookingSince.current = Date.now();
      toast.success(t("sent", {count: run.tests.length - failed}), failed ? {description: t("failed", {count: failed})} : undefined);
      onChanged();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSending(false);
    }
  }

  const readable = seeds.filter((seed) => seed.readable).length;

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-2.5">
        <div className="flex flex-col gap-1">
          <Eyebrow>{t("seeds")}</Eyebrow>
          <p className="text-11 leading-4 text-ink-2">
            {t("seedsHelp")}
            {seeds.length > 0 ? ` ${t("readable", {readable, total: seeds.length})}` : ""}
          </p>
        </div>
        <SeedList seeds={seeds} canEdit={canEdit} onChanged={onChanged} />
      </section>

      {canEdit ? (
        <section className="flex flex-col gap-2.5">
          <Eyebrow>{t("send")}</Eyebrow>
          {senders.length === 0 ? (
            <Alert tone="neutral">{t("noSender", {domain})}</Alert>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Select className="min-w-[240px] flex-1" label={t("sendFrom")} value={from} onChange={setFrom} options={senders.map((mailbox) => ({ value: mailbox.id, label: mailbox.from_email }))} />
              <Button variant="primary" icon={Send} loading={sending} disabled={!from || seeds.length === 0} onClick={() => void send()}>
                {t("sendTo", {count: seeds.length})}
              </Button>
            </div>
          )}
          {error ? <Alert tone="bad">{error}</Alert> : null}
        </section>
      ) : null}

      <section className="flex flex-col gap-2.5">
        <Eyebrow>{t("results")}</Eyebrow>
        {runs.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line-strong p-3 text-11 leading-4 text-ink-3">{t("noResults", {domain})}</p>
        ) : runs.map((run, index) => <RunResult key={run.id} run={run} latest={index === 0} looking={index === 0 && looking} canEdit={canEdit} onChanged={onChanged} />)}
      </section>
    </div>
  );
}

function SeedList({ seeds, canEdit, onChanged }: { seeds: Seed[]; canEdit: boolean; onChanged: () => void }) {
  const t = useTranslations("DeliverabilityPlacement");
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    setSaving(true);
    setError(null);
    try {
      await api("/api/deliverability/seeds", { method: "POST", body: { email: email.trim() } });
      setEmail("");
      onChanged();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  async function remove(seed: Seed) {
    try {
      await api("/api/deliverability/seeds", { method: "DELETE", query: { id: seed.id } });
      onChanged();
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  }

  return (
    <>
      {seeds.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {seeds.map((seed) => (
            <li key={seed.id} className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line bg-subtle pl-2.5 pr-1 text-115 text-ink">
              <span className="max-w-[220px] truncate">{seed.email}</span>
              <Tooltip label={seed.readable ? t("automatic") : t("manual")}>
                <span tabIndex={0} className="inline-flex rounded-full"><Pill size="sm" tone={seed.readable ? "mail" : "neutral"}>{seed.readable ? t("byLinki") : t("byHand")}</Pill></span>
              </Tooltip>
              {canEdit ? <IconButton icon={X} label={t("removeSeed", {email: seed.email})} size={22} onClick={() => void remove(seed)} /> : <span className="w-1" />}
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-lg border border-dashed border-line-strong p-3 text-11 leading-4 text-ink-3">
          {t("noSeeds")}{canEdit ? ` ${t("addSeedsHelp")}` : ""}
        </p>
      )}
      {canEdit ? (
        <form className="flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); if (email.trim() && !saving) void add(); }}>
          <Input frameClassName="min-w-0 flex-1" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="seed@yourdomain.com" aria-label={t("seedAria")} autoComplete="off" spellCheck={false} />
          <Button type="submit" icon={Plus} loading={saving} disabled={!email.trim()}>{t("addSeed")}</Button>
        </form>
      ) : null}
      {error ? <Alert tone="bad">{error}</Alert> : null}
    </>
  );
}

function RunResult({ run, latest, looking, canEdit, onChanged }: { run: PlacementRun; latest: boolean; looking: boolean; canEdit: boolean; onChanged: () => void }) {
  const t = useTranslations("DeliverabilityPlacement");
  const [busy, setBusy] = useState(false);

  async function lookNow() {
    setBusy(true);
    try {
      await api("/api/deliverability/placement", { method: "PUT", body: { run_id: run.id } });
      onChanged();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function enter(test: PlacementTest, placement: PlacementResult) {
    try {
      await api("/api/deliverability/placement", { method: "PATCH", body: { test_id: test.id, placement } });
      onChanged();
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  }

  const waiting = run.tests.some((test) => test.status === "sent" && test.readable);

  return (
    <div className="flex flex-col rounded-lg border border-line">
      <div className="flex min-h-9 items-center justify-between gap-3 border-b border-line bg-subtle px-3 py-1.5">
        <span className="min-w-0 truncate text-11 text-ink-2">{latest ? t("latest") + " " : t("test") + " "}{runLine(run)}</span>
        {looking ? (
          <span className="inline-flex shrink-0 items-center gap-1.5 text-105 text-ink-3"><Spinner size={11} label={t("looking")} />{t("lookingMessage")}</span>
        ) : canEdit && waiting ? (
          <Button size="xs" loading={busy} onClick={() => void lookNow()}>{t("lookAgain")}</Button>
        ) : null}
      </div>
      <ul className="flex flex-col">
        {run.tests.map((test) => {
          const badge = placementBadge(test);
          const byHand = canEdit && !test.readable && test.status !== "failed";
          return (
            <li key={test.id} className="flex min-h-10 items-center gap-2.5 border-b border-line px-3 py-1.5 last:border-b-0">
              <div className="flex min-w-0 flex-1 flex-col gap-px">
                <span className="truncate text-12 font-medium text-ink">{test.seed_email}</span>
                {test.error ? <span className="truncate text-105 text-bad" title={test.error}>{test.error}</span> : test.auth ? (
                  <span className="truncate text-105 text-ink-3">SPF {test.auth.spf ?? "—"} · DKIM {test.auth.dkim ?? "—"} · DMARC {test.auth.dmarc ?? "—"}</span>
                ) : null}
              </div>
              {byHand ? (
                <Select
                  size="sm" className="w-[150px]" label={t("where", {email: test.seed_email})} placeholder={t("wherePlaceholder")}
                  value={test.placement && MANUAL_PLACEMENTS.includes(test.placement) ? test.placement : undefined} onChange={(value) => void enter(test, value)}
                  options={MANUAL_PLACEMENTS.map((placement) => ({ value: placement, label: t(`placements.${placement}`) }))}
                />
              ) : (
                <Pill tone={badge.tone}>{badge.label}</Pill>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
