import { useEffect, useState } from "react";
import {useTranslations} from "next-intl";
import { AtSign, Ban, Download, Globe, Phone, Plus, Upload } from "lucide-react";
import { toast } from "sonner";
import { Alert, Button, Card, CardHeader, Drawer, EmptyState, ErrorState, Field, Input, LinkedinIcon, LoadingState, Pill, SearchInput, Segmented, Select, Textarea, Tooltip, confirm, type Icon } from "@/components/ui";
import { api, apiUrl, errorMessage } from "@/lib/client/api";
import { useApi } from "@/lib/client/data";
import { formatCount } from "@/lib/client/format";
import { KINDS, suppressionMeta, type DoNotContact, type SuppressionKind, type SuppressionRow } from "./model";

export interface DoNotContactRoles {
  /** May add, import and remove entries a teammate added. */
  member: boolean;
  /** May take the list out as a file. */
  manager: boolean;
  /** May remove an entry that came from an unsubscribe, a complaint or a bounce. */
  admin: boolean;
}

const KIND_ICON: Record<SuppressionKind, Icon> = { email: AtSign, domain: Globe, linkedin: LinkedinIcon, phone: Phone };

/** Who is never to be contacted: how many of each kind, how many sends that stopped, and the way into the list. */
export function DoNotContactCard({ dnc, can, onChanged }: { dnc: DoNotContact; can: DoNotContactRoles; onChanged: () => void }) {
  const t = useTranslations("DeliverabilityDnc");
  const [open, setOpen] = useState(false);
  return (
    <Card className="flex flex-1 flex-col gap-3 p-3.5">
      <CardHeader title={t("title")} subtitle={t("subtitle")} actions={<Button size="sm" className="h-7 px-3" onClick={() => setOpen(true)}>{t("manage")}</Button>} />
      <dl className="flex flex-col border-t border-line">
        {KINDS.map((kind) => {
          const Glyph = KIND_ICON[kind];
          return (
            <div key={kind} className="flex h-6 items-center gap-2.5 border-b border-line last:border-b-0">
              <Glyph size={13} className="shrink-0 text-ink-3" aria-hidden="true" />
              <dt className="min-w-0 flex-1 text-12 text-ink-2">{t(`kind.${kind}`)}</dt>
              <dd className="font-mono text-115 font-medium text-ink">{formatCount(dnc.counts[kind])}</dd>
            </div>
          );
        })}
      </dl>
      <p className="flex items-center gap-[9px] rounded-lg bg-subtle p-2.5 text-11 text-ink-2">
        <Ban size={13} className="shrink-0 text-ink-3" aria-hidden="true" />
        {t("blocked", {count: formatCount(dnc.blocked_30d)})}
      </p>
      <DoNotContactManager open={open} dnc={dnc} can={can} onClose={() => setOpen(false)} onChanged={onChanged} />
    </Card>
  );
}

const PAGE = 25;
type KindFilter = "all" | SuppressionKind;
type Panel = "list" | "add" | "import";

function DoNotContactManager({ open, dnc, can, onClose, onChanged }: { open: boolean; dnc: DoNotContact; can: DoNotContactRoles; onClose: () => void; onChanged: () => void }) {
  const t = useTranslations("DeliverabilityDnc");
  const [kind, setKind] = useState<KindFilter>("all");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [panel, setPanel] = useState<Panel>("list");
  const filters = { q: query || undefined, kind: kind === "all" ? undefined : kind };
  const { data, error, isLoading, mutate } = useApi<{ rows: SuppressionRow[]; total: number }>(open ? "/api/platform/suppressions" : null, { view: "page", ...filters, limit: PAGE, offset });
  const total = data?.total ?? 0;

  // The list is asked for once the typing stops, not on every key.
  useEffect(() => {
    const timer = window.setTimeout(() => { setQuery(search.trim()); setOffset(0); }, 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  const changed = () => { void mutate(); onChanged(); };

  async function remove(row: SuppressionRow) {
    const ok = await confirm({
      title: t("removeTitle", {value: row.value}),
      body: row.protected
        ? t("protectedWarning")
        : t("removeWarning"),
      confirmLabel: t("removeConfirm"), tone: "danger",
    });
    if (!ok) return;
    try {
      await api("/api/platform/suppressions", { method: "DELETE", query: { id: row.id } });
      toast.success(t("removed", {value: row.value}));
      changed();
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  }

  return (
    <Drawer
      open={open} onOpenChange={(next) => { if (!next) onClose(); }} title={t("title")} width={540}
      description={t("description", {count: formatCount(dnc.total)})}
      footer={panel === "list" ? (
        <div className="flex w-full items-center justify-between gap-3">
          <span className="text-11 text-ink-3">{total === 0 ? t("noEntries") : t("range", {start: formatCount(offset + 1), end: formatCount(Math.min(offset + PAGE, total)), total: formatCount(total)})}</span>
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>{t("previous")}</Button>
            <Button size="sm" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>{t("next")}</Button>
          </div>
        </div>
      ) : undefined}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          {can.member ? (
            <>
              <Button size="sm" icon={Plus} variant={panel === "add" ? "tint" : "secondary"} onClick={() => setPanel(panel === "add" ? "list" : "add")}>{t("addEntry")}</Button>
              <Button size="sm" icon={Upload} variant={panel === "import" ? "tint" : "secondary"} onClick={() => setPanel(panel === "import" ? "list" : "import")}>{t("importList")}</Button>
            </>
          ) : null}
          {can.manager && dnc.total > 0 ? (
            <Button size="sm" asChild className="gap-[5px]">
              <a href={apiUrl("/api/export/suppressions", filters)} download><Download size={12} className="text-ink-2" aria-hidden="true" />{t("export", {scope: query || kind !== "all" ? t("these") : t("all")})}</a>
            </Button>
          ) : null}
        </div>

        {panel === "add" ? <AddEntry onDone={() => { setPanel("list"); changed(); }} /> : null}
        {panel === "import" ? <ImportEntries onDone={changed} /> : null}

        <div className="flex flex-col gap-2.5">
          <Segmented
            label={t("kindFilter")} size="sm" value={kind} onChange={(value) => { setKind(value); setOffset(0); }} className="self-start"
            options={[{ value: "all", label: t("all"), count: formatCount(dnc.total) }, ...KINDS.map((item) => ({ value: item, label: t(`singular.${item}`), count: formatCount(dnc.counts[item]) }))]}
          />
          <SearchInput value={search} onChange={setSearch} placeholder={t("search")} />
        </div>

        {error && !data ? (
          <ErrorState message={errorMessage(error)} onRetry={() => void mutate()} />
        ) : isLoading && !data ? (
          <LoadingState label={t("loading")} />
        ) : data && data.rows.length > 0 ? (
          <ul className="flex flex-col rounded-lg border border-line">
            {data.rows.map((row) => {
              const locked = row.protected && !can.admin;
              return (
                <li key={row.id} className="flex min-h-11 items-center gap-2.5 border-b border-line px-3 py-1.5 last:border-b-0">
                  <div className="flex min-w-0 flex-1 flex-col gap-px">
                    <span className="truncate text-12 font-medium text-ink" title={row.value}>{row.value}</span>
                    <span className="truncate text-105 text-ink-3">{t(`singular.${row.kind}`)} · {suppressionMeta(row)}</span>
                  </div>
                  {row.protected ? <Pill size="sm">{t("protection")}</Pill> : null}
                  {can.member ? (
                    locked ? (
                      <Tooltip label={t("protectedHint")}>
                        <span tabIndex={0}><Button size="xs" variant="ghost" disabled aria-label={t("removeAria", {value: row.value})}>{t("remove")}</Button></span>
                      </Tooltip>
                    ) : (
                      <Button size="xs" variant="ghost" className="text-bad hover:bg-bad-tint hover:text-bad" aria-label={t("removeAria", {value: row.value})} onClick={() => void remove(row)}>{t("remove")}</Button>
                    )
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState icon={Ban} title={query || kind !== "all" ? t("nothingMatches") : t("nobody")}>
            {query || kind !== "all" ? t("noMatchHelp") : t("emptyHelp")}
          </EmptyState>
        )}
      </div>
    </Drawer>
  );
}

function AddEntry({ onDone }: { onDone: () => void }) {
  const t = useTranslations("DeliverabilityDnc");
  const [kind, setKind] = useState<SuppressionKind>("email");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const placeholder = { email: "name@company.com", domain: "company.com", linkedin: "https://www.linkedin.com/in/someone/", phone: "+44 20 7946 0000" }[kind];

  async function add() {
    setSaving(true);
    setError(null);
    try {
      await api("/api/platform/suppressions", { method: "POST", body: { kind, value: value.trim(), ...(reason.trim() ? { reason: reason.trim() } : {}) } });
      toast.success(t("added", {value: value.trim()}));
      onDone();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="flex flex-col gap-2.5 rounded-lg border border-line bg-subtle p-3" onSubmit={(event) => { event.preventDefault(); if (value.trim() && !saving) void add(); }}>
      <div className="grid grid-cols-[150px_1fr] gap-2.5">
        <Field label={t("kindLabel")}>
          {(id) => <Select id={id} className="w-full" value={kind} onChange={setKind} options={KINDS.map((item) => ({ value: item, label: t(`singular.${item}`) }))} />}
        </Field>
        <Field label={t(`singular.${kind}`)} hint={kind === "domain" ? t("domainHint") : undefined}>
          {(id) => <Input id={id} value={value} onChange={(event) => setValue(event.target.value)} placeholder={placeholder} autoComplete="off" spellCheck={false} autoFocus required />}
        </Field>
      </div>
      <Field label={t("reason")} hint={t("reasonHint")}>
        {(id) => <Input id={id} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={80} />}
      </Field>
      {error ? <Alert tone="bad">{error}</Alert> : null}
      <Button type="submit" variant="primary" className="self-start" loading={saving} disabled={!value.trim()}>{t("add")}</Button>
    </form>
  );
}

function ImportEntries({ onDone }: { onDone: () => void }) {
  const t = useTranslations("DeliverabilityDnc");
  const [entries, setEntries] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ added: number; already_listed: number; invalid: string[] } | null>(null);

  async function run() {
    setSaving(true);
    setError(null);
    try {
      setOutcome(await api("/api/platform/suppressions/import", { method: "POST", body: { entries } }));
      setEntries("");
      onDone();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="flex flex-col gap-2.5 rounded-lg border border-line bg-subtle p-3" onSubmit={(event) => { event.preventDefault(); if (entries.trim() && !saving) void run(); }}>
      <Field label={t("entries")} hint={t("entriesHint")}>
        {(id) => <Textarea id={id} rows={6} value={entries} onChange={(event) => setEntries(event.target.value)} placeholder={"name@company.com\ncompany.com\nhttps://www.linkedin.com/in/someone/"} autoFocus spellCheck={false} />}
      </Field>
      {error ? <Alert tone="bad">{error}</Alert> : null}
      {outcome ? (
        <Alert tone={outcome.invalid.length ? "warn" : "good"} title={t("importDone", {added: formatCount(outcome.added), existing: formatCount(outcome.already_listed)})}>
          {outcome.invalid.length ? t("invalid", {count: outcome.invalid.length, sample: outcome.invalid.slice(0, 4).join(", ") + (outcome.invalid.length > 4 ? "…" : "")}) : null}
        </Alert>
      ) : null}
      <Button type="submit" variant="primary" className="self-start" loading={saving} disabled={!entries.trim()}>{t("import")}</Button>
    </form>
  );
}
