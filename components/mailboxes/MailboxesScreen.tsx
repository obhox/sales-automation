import { useCallback, useState } from "react";
import { useRouter } from "next/router";
import { CircleAlert, Flame, Gauge, Mail, MailX, Plus, Send } from "lucide-react";
import { toast } from "sonner";
import { Page } from "@/components/shell";
import { Button, Card, EmptyState, ErrorState, KpiCard, Pill, Skeleton, confirm } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { useApi } from "@/lib/client/data";
import { formatCount, formatPercent } from "@/lib/client/format";
import { useCan } from "@/lib/client/roles";
import { ConnectMailboxDialog } from "./ConnectMailboxDialog";
import { DomainGroup, type MailboxAction } from "./DomainGroup";
import { EditMailboxDrawer } from "./EditMailboxDrawer";
import { MailboxDetail } from "./MailboxDetail";
import { SignatureDialog } from "./SignatureDialog";
import { WarmupSettingsDialog } from "./WarmupSettingsDialog";
import { OVERVIEW_PATH, allMailboxes, pauseConsequence, resumeConsequence, totals, type MailboxView, type MailboxesOverview } from "./model";

const NOTE_TONE = { good: "text-good", warn: "text-warn", bad: "text-bad", muted: "text-ink-2" } as const;

/** Channels → Mailboxes: every mailbox under the domain it sends from, and the one being looked at. */
export function MailboxesScreen() {
  const router = useRouter();
  const { data, error, isLoading, mutate } = useApi<MailboxesOverview>(OVERVIEW_PATH);
  // Connecting, pausing, editing and removing a mailbox are all an admin's.
  const canEdit = useCan("admin");
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [signing, setSigning] = useState<string | null>(null);
  const [connect, setConnect] = useState<{ domain: string | null } | null>(null);
  // "Add mailbox" on the Deliverability screen arrives as ?connect=<domain>: open the dialog once, for an admin.
  const [arrived, setArrived] = useState(false);
  const askedDomain = typeof router.query.connect === "string" ? router.query.connect : null;
  if (!arrived && router.isReady && askedDomain !== null && canEdit) {
    setArrived(true);
    setConnect({ domain: askedDomain || null });
  }
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [checkingDns, setCheckingDns] = useState<string | null>(null);

  const domains = data?.domains ?? [];
  const mailboxes = allMailboxes(domains);
  const byId = (id: string | null) => mailboxes.find((mailbox) => mailbox.id === id) ?? null;
  // What is being looked at: the one clicked, else the one the link named, else the first.
  const fromLink = typeof router.query.mailbox === "string" ? router.query.mailbox : null;
  const selected = byId(chosen) ?? byId(fromLink) ?? mailboxes[0] ?? null;
  const figures = totals(domains);
  const refresh = useCallback(() => { void mutate(); }, [mutate]);

  async function run(mailbox: MailboxView, work: () => Promise<string | void>) {
    setBusy(mailbox.id);
    try {
      const message = await work();
      if (message) toast.success(message);
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setBusy(null);
      refresh();
    }
  }

  async function checkDns(domain: string, quiet = false) {
    setCheckingDns(domain);
    try {
      await api("/api/platform/deliverability", { method: "POST", body: { action: "check_domain", domain } });
      if (!quiet) toast.success(`DNS records for ${domain} checked`);
    } catch (cause) {
      if (!quiet) toast.error(errorMessage(cause));
    } finally {
      setCheckingDns(null);
      refresh();
    }
  }

  async function onAction(action: MailboxAction, mailbox: MailboxView) {
    switch (action) {
      case "edit":
        return setEditing(mailbox.id);
      case "signature":
        return setSigning(mailbox.id);
      case "pause": {
        const ok = await confirm({ title: `Pause ${mailbox.from_email}?`, body: pauseConsequence(mailbox), confirmLabel: "Pause sending" });
        if (!ok) return;
        return run(mailbox, async () => {
          await api(`/api/email-accounts/${mailbox.id}`, { method: "PATCH", body: { paused: true } });
          return `${mailbox.from_email} is paused`;
        });
      }
      case "resume": {
        const warning = resumeConsequence(mailbox);
        if (warning) {
          const ok = await confirm({ title: `Resume ${mailbox.from_email}?`, body: warning, confirmLabel: "Resume anyway", tone: "danger" });
          if (!ok) return;
        }
        return run(mailbox, async () => {
          await api(`/api/email-accounts/${mailbox.id}`, { method: "PATCH", body: { paused: false } });
          return `${mailbox.from_email} is sending again`;
        });
      }
      case "test":
        return run(mailbox, async () => {
          const result = await api<{ ok: boolean }>(`/api/email-accounts/${mailbox.id}/test`, { method: "POST" });
          return result.ok ? `${mailbox.from_email} signs in to its mail server` : undefined;
        });
      case "delete": {
        const campaigns = mailbox.active_campaigns;
        const ok = await confirm({
          title: `Remove ${mailbox.from_email}?`,
          body: `The mailbox, its warm-up history and its record of sent emails are deleted. ${campaigns ? `${campaigns} live ${campaigns === 1 ? "campaign has" : "campaigns have"} contacts with it: they are left with no mailbox and their email steps stop. ` : ""}Replies already in the inbox are kept. This cannot be undone. To stop it for a while, pause it instead.`,
          confirmLabel: "Remove mailbox", tone: "danger",
        });
        if (!ok) return;
        return run(mailbox, async () => {
          await api(`/api/email-accounts/${mailbox.id}`, { method: "DELETE" });
          if (chosen === mailbox.id) setChosen(null);
          return `${mailbox.from_email} was removed`;
        });
      }
    }
  }

  return (
    <Page
      title="Mailboxes"
      meta={figures.problem ? <Pill tone="bad" icon={CircleAlert}>{figures.problem}</Pill> : null}
      actions={
        <>
          <Button icon={Flame} onClick={() => setSettingsOpen(true)} disabled={!data}>Warm-up settings</Button>
          {canEdit ? <Button variant="primary" icon={Plus} onClick={() => setConnect({ domain: null })} disabled={!data}>Connect mailbox</Button> : null}
          <span className="mx-0.5 h-5 w-px bg-line" aria-hidden="true" />
        </>
      }
    >
      {error && !data ? (
        <ErrorState message={errorMessage(error)} onRetry={refresh} />
      ) : isLoading || !data ? (
        <LoadingLayout />
      ) : (
        <>
          <div className="grid shrink-0 grid-cols-2 gap-3.5 lg:grid-cols-4">
            <KpiCard label="Mailboxes" icon={Mail} value={formatCount(figures.mailboxes)} note={<span className={NOTE_TONE[figures.mailboxesTone]}>{figures.mailboxesNote}</span>} />
            <KpiCard label="Daily capacity" icon={Send} value={formatCount(figures.capacity)} note={<span className="text-ink-2">{figures.capacityNote}</span>} />
            <KpiCard label="Avg reputation" icon={Gauge} value={figures.reputation === null ? "—" : String(figures.reputation)} note={<span className={NOTE_TONE[figures.reputationTone]}>{figures.reputationNote}</span>} />
            <KpiCard label="Bounce rate" icon={MailX} value={figures.bounceRate === null ? "—" : formatPercent(figures.bounceRate, 2)} note={<span className={NOTE_TONE[figures.bounceTone]}>{figures.bounceNote}</span>} />
          </div>

          {mailboxes.length === 0 ? (
            <Card>
              <EmptyState
                icon={Mail} title="No mailboxes yet"
                action={canEdit ? <Button variant="primary" icon={Plus} onClick={() => setConnect({ domain: null })}>Connect mailbox</Button> : undefined}
              >
                Connect the mailbox your campaigns should email from: a Gmail or Google Workspace address with an app password, or any other over SMTP and IMAP.
                It starts on a low daily limit that rises each day.{canEdit ? "" : " An admin connects mailboxes."}
              </EmptyState>
            </Card>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col gap-3.5 xl:flex-row xl:items-start">
              <div className="flex min-w-0 flex-1 flex-col gap-3.5">
                {domains.map((domain) => (
                  <DomainGroup
                    key={domain.domain} domain={domain} selected={selected?.id ?? null} canEdit={canEdit} busy={busy} checkingDns={checkingDns === domain.domain}
                    onSelect={(mailbox) => setChosen(mailbox.id)} onAction={onAction} onConnect={(name) => setConnect({ domain: name })} onCheckDns={(name) => void checkDns(name)}
                  />
                ))}
              </div>
              {selected ? (
                <div className="flex w-full shrink-0 flex-col xl:sticky xl:top-0 xl:max-h-[calc(100vh-56px-40px)] xl:w-[356px]">
                  <MailboxDetail key={selected.id} mailbox={selected} canEdit={canEdit} busy={busy === selected.id} onAction={onAction} onChanged={refresh} />
                </div>
              ) : null}
            </div>
          )}

          <EditMailboxDrawer mailbox={byId(editing)} onClose={() => setEditing(null)} onSaved={refresh} />
          <SignatureDialog mailbox={byId(signing)} onClose={() => setSigning(null)} onSaved={refresh} />
          <WarmupSettingsDialog open={settingsOpen} settings={data.settings} mailboxes={mailboxes} canEdit={canEdit} onClose={() => setSettingsOpen(false)} onSaved={refresh} />
          <ConnectMailboxDialog
            open={connect !== null} domain={connect?.domain ?? null} onClose={() => setConnect(null)}
            onConnected={(id, email) => {
              setChosen(id);
              refresh();
              // A domain nothing is known about yet is looked up straight away, so its badges are not grey until tomorrow.
              const domain = email.split("@")[1];
              const known = domains.find((item) => item.domain === domain);
              if (domain && !known?.dns.checked_at) void checkDns(domain, true);
            }}
          />
        </>
      )}
    </Page>
  );
}

function LoadingLayout() {
  return (
    <div className="flex flex-col gap-3.5" aria-busy="true" aria-label="Loading mailboxes">
      <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-[102px] rounded-lg" />)}
      </div>
      <div className="flex flex-col gap-3.5 xl:flex-row xl:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-3.5">
          {Array.from({ length: 2 }, (_, index) => <Skeleton key={index} className="h-[250px] rounded-lg" />)}
        </div>
        <Skeleton className="h-[520px] w-full rounded-lg xl:w-[356px]" />
      </div>
    </div>
  );
}
