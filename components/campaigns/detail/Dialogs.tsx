import { useState } from "react";
import Link from "next/link";
import { Check, Copy, Link2, ListPlus, UserPlus, X } from "lucide-react";
import { toast } from "sonner";
import { Alert, Button, Dialog, EmptyState, Field, Input, Pill, SearchInput, Segmented, Select, Skeleton, confirm } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { useApi } from "@/lib/client/data";
import { formatCount, formatDate, plural } from "@/lib/client/format";
import { useDebounced } from "@/lib/client/table-state";
import type { SetupOptions } from "@/lib/campaigns/setup";
import type { SearchResult } from "@/pages/api/search";
import type { CampaignSummary } from "../model";
import { addOutcome, shareLine, type AddResult, type ReportShare } from "./model";

type Mode = "list" | "contacts";

/**
 * Enrol more contacts in a campaign that is already running: a whole list, or people
 * picked by name. They join the run in flight and start at the first step.
 */
export function AddProspectsDialog({
  id, campaign, open, onOpenChange, onAdded,
}: {
  id: string;
  campaign: Pick<CampaignSummary, "name" | "status" | "run"> | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: () => void;
}) {
  const [mode, setMode] = useState<Mode>("list");
  const [listId, setListId] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Array<{ id: string; title: string; subtitle: string | null }>>([]);
  const [saving, setSaving] = useState(false);
  const settled = useDebounced(query.trim());
  const live = Boolean(campaign?.run);
  const options = useApi<{ options: SetupOptions }>(open && live ? "/api/workflows/setup-options" : null);
  const found = useApi<{ results: SearchResult[] }>(open && live && mode === "contacts" && settled.length >= 2 ? "/api/search" : null, { q: settled });
  const contacts = (found.data?.results ?? []).filter((result) => result.kind === "contact" && !picked.some((entry) => entry.id === result.id));
  const lists = options.data?.options.lists ?? [];
  const ready = mode === "list" ? Boolean(listId) : picked.length > 0;

  function close() {
    onOpenChange(false);
    setQuery("");
    setPicked([]);
    setListId(undefined);
  }

  async function add() {
    if (!ready || saving) return;
    setSaving(true);
    try {
      const result = await api<AddResult>(`/api/workflows/${id}/prospects`, { method: "POST", body: mode === "list" ? { action: "add", list_id: listId } : { action: "add", target_ids: picked.map((entry) => entry.id) } });
      const outcome = addOutcome(result);
      if (outcome.tone === "success") toast.success(outcome.message);
      else toast.message(outcome.message);
      onAdded();
      close();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
      title="Add prospects"
      description={campaign ? `Enrol more contacts in ${campaign.name}.` : undefined}
      icon={UserPlus}
      footer={live ? (
        <>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="primary" icon={ListPlus} disabled={!ready} loading={saving} onClick={add}>
            {mode === "contacts" && picked.length > 0 ? `Enrol ${formatCount(picked.length)} ${plural(picked.length, "contact", "contacts")}` : "Enrol"}
          </Button>
        </>
      ) : <Button variant="ghost" onClick={close}>Close</Button>}
    >
      {!live ? (
        <EmptyState icon={UserPlus} title="This campaign is not running" action={<Button asChild variant="primary"><Link href={`/campaigns?setup=${id}`}>Open setup</Link></Button>}>
          Contacts join the run in flight, and there is none. Launch the campaign from its setup: its list is enrolled then.
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-4">
          <Segmented label="What to add" value={mode} onChange={setMode} options={[{ value: "list", label: "A whole list" }, { value: "contacts", label: "Chosen contacts" }]} />
          {mode === "list" ? (
            <Field label="List" hint="Everyone in the list who is not already in this campaign.">
              {(fieldId) => options.isLoading ? <Skeleton className="h-8 w-full" /> : lists.length === 0 ? (
                <p className="text-12 text-ink-2">There are no lists yet. <Link href="/lists" className="font-semibold text-brand-strong hover:underline">Create one</Link> first.</p>
              ) : (
                <Select id={fieldId} value={listId} onChange={setListId} placeholder="Choose a list" options={lists.map((list) => ({ value: list.id, label: list.name, hint: `${formatCount(list.contacts)} ${plural(list.contacts, "contact", "contacts")}` }))} className="w-full" />
              )}
            </Field>
          ) : (
            <div className="flex flex-col gap-2.5">
              <SearchInput value={query} onChange={setQuery} placeholder="Search contacts by name, company or email" aria-label="Search contacts" autoFocus />
              {picked.length > 0 ? (
                <ul aria-label="Contacts to add" className="flex flex-wrap gap-1.5">
                  {picked.map((entry) => (
                    <li key={entry.id} className="inline-flex h-6 items-center gap-1 rounded-full bg-brand-tint pl-2.5 pr-1 text-11 font-medium text-brand-strong">
                      {entry.title}
                      <button type="button" aria-label={`Remove ${entry.title}`} onClick={() => setPicked(picked.filter((other) => other.id !== entry.id))} className="inline-flex size-4 items-center justify-center rounded-full hover:bg-brand/15">
                        <X size={10} aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="min-h-[136px] rounded-md border border-line">
                {settled.length < 2 ? (
                  <p className="px-3 py-4 text-12 text-ink-3">Type two letters or more to find a contact.</p>
                ) : found.isLoading ? (
                  <div className="flex flex-col gap-2 p-3"><Skeleton className="h-6 w-full" /><Skeleton className="h-6 w-2/3" /></div>
                ) : contacts.length === 0 ? (
                  <p className="px-3 py-4 text-12 text-ink-3">{found.error ? errorMessage(found.error) : "No contact matches that, or they are already chosen."}</p>
                ) : (
                  <ul>
                    {contacts.map((result) => (
                      <li key={result.id}>
                        <button type="button" onClick={() => setPicked([...picked, { id: result.id, title: result.title, subtitle: result.subtitle }])} className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-subtle">
                          <span className="flex min-w-0 flex-col">
                            <span className="truncate text-12 font-medium text-ink">{result.title}</span>
                            {result.subtitle ? <span className="truncate text-11 text-ink-3">{result.subtitle}</span> : null}
                          </span>
                          <span className="shrink-0 text-11 font-semibold text-brand-strong">Add</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
          <p className="text-11 leading-4 text-ink-3">
            They start at the first step and are sent from the senders this campaign already uses. Customers and open deals are left out if the campaign leaves them out, and nobody part-way through another campaign is taken from it.
          </p>
        </div>
      )}
    </Dialog>
  );
}

/**
 * Links that show this campaign's results to someone who has no account. A link is shown
 * in full once, when it is made; after that only its last few characters are.
 */
export function ShareDialog({ id, name, open, onOpenChange, canManage }: { id: string; name: string; open: boolean; onOpenChange: (open: boolean) => void; canManage: boolean }) {
  const { data, error, mutate, isLoading } = useApi<{ shares: ReportShare[] }>(open ? `/api/workflows/${id}/share` : null);
  const [fresh, setFresh] = useState<{ id: string; url: string } | null>(null);
  const [working, setWorking] = useState(false);
  const [copied, setCopied] = useState(false);
  const live = (data?.shares ?? []).filter((share) => !share.revoked_at);
  const off = (data?.shares ?? []).filter((share) => share.revoked_at);

  async function create() {
    setWorking(true);
    try {
      const made = await api<{ share: ReportShare; path: string }>(`/api/workflows/${id}/share`, { method: "POST" });
      setFresh({ id: made.share.id, url: `${window.location.origin}${made.path}` });
      setCopied(false);
      await mutate();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setWorking(false);
    }
  }

  async function copy() {
    if (!fresh) return;
    try {
      await navigator.clipboard.writeText(fresh.url);
      setCopied(true);
    } catch {
      toast.error("The link could not be copied. Select it and copy it by hand.");
    }
  }

  async function revoke(share: ReportShare) {
    const ok = await confirm({ title: `Switch off the link ending ${share.hint}?`, body: "Anyone who has it will see that the report is no longer shared. It cannot be switched back on; make a new link instead.", confirmLabel: "Switch off", tone: "danger" });
    if (!ok) return;
    try {
      await api(`/api/workflows/${id}/share`, { method: "DELETE", query: { share_id: share.id } });
      if (fresh?.id === share.id) setFresh(null);
      toast.success("The link is switched off");
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      void mutate();
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next) setFresh(null); onOpenChange(next); }}
      title="Share report"
      description={`A link to ${name}'s figures for someone without an account.`}
      icon={Link2}
      footer={<Button variant="ghost" onClick={() => { setFresh(null); onOpenChange(false); }}>Done</Button>}
    >
      <div className="flex flex-col gap-4">
        <p className="text-12 leading-[18px] text-ink-2">
          Whoever opens the link sees this campaign&rsquo;s rates, daily activity, funnel and A/B results, up to date each time. It shows no contact, no message and nothing else in the workspace.
        </p>
        {fresh ? (
          <Alert tone="good" title="Link ready. Copy it now: it is not shown in full again.">
            <div className="mt-2 flex items-center gap-2">
              <Input readOnly value={fresh.url} aria-label="Report link" onFocus={(event) => event.currentTarget.select()} frameClassName="flex-1" className="font-mono text-11" />
              <Button variant="secondary" icon={copied ? Check : Copy} onClick={copy}>{copied ? "Copied" : "Copy"}</Button>
            </div>
          </Alert>
        ) : null}
        {error ? <Alert tone="bad">{errorMessage(error)}</Alert> : null}
        <div className="flex items-center justify-between gap-3">
          <span className="text-12 font-semibold text-ink">{isLoading ? "Links" : live.length === 0 ? "No live link" : `${live.length} live ${plural(live.length, "link", "links")}`}</span>
          {canManage ? <Button variant="secondary" size="sm" icon={Link2} loading={working} onClick={create}>Create link</Button> : null}
        </div>
        {isLoading ? <Skeleton className="h-10 w-full" /> : (
          <ul className="flex flex-col divide-y divide-line rounded-md border border-line empty:hidden">
            {[...live, ...off].map((share) => (
              <li key={share.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex items-center gap-2 text-12 font-medium text-ink">
                    <span className="font-mono">…{share.hint}</span>
                    {share.revoked_at ? <Pill size="sm">Switched off {formatDate(share.revoked_at)}</Pill> : null}
                  </span>
                  <span className="truncate text-11 text-ink-3">{shareLine(share)} · made {formatDate(share.created_at)}</span>
                </span>
                {!share.revoked_at && canManage ? <Button variant="ghost" size="sm" onClick={() => revoke(share)}>Switch off</Button> : null}
              </li>
            ))}
          </ul>
        )}
        {!canManage ? <p className="text-11 text-ink-3">A manager can make a link or switch one off.</p> : null}
      </div>
    </Dialog>
  );
}
