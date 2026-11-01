import { useMemo, useState } from "react";
import Link from "next/link";
import {useTranslations} from "next-intl";
import { useRouter } from "next/router";
import { Copy, Ellipsis, Eye, FileText, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Page } from "@/components/shell";
import { Alert, Button, CellStack, ChannelBadge, DataTable, EmptyState, IconButton, Menu, MenuItem, MenuSeparator, SearchInput, Segmented, Select, Tooltip, confirm, type Column } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { useApi } from "@/lib/client/data";
import { formatRelative } from "@/lib/client/format";
import { useCan } from "@/lib/client/roles";
import { TemplateDialog } from "./TemplateDialog";
import {
  CHANNEL_LABEL, FEW_SENDS, SORTS, TEMPLATES_PATH, categoryOptions, channelCounts, copyName, deleteWarning, figureCells, formOf, librarySummary, matches, previewLine, sortTemplates, templatePath, usedIn,
  type ChannelFilter, type LibraryTemplate, type SortKey, type TemplateForm, type TemplateLibrary,
} from "./model";

/** Outreach → Templates: the wording steps can send, by channel and category, with how each has done. */
export function TemplatesScreen() {
  const t = useTranslations("Templates");
  const sortLabels: Record<SortKey, string> = {newest:t("sort.newest"), name:t("sort.name"), most_sent:t("sort.mostSent"), best_reply:t("sort.bestReply")};
  const { data, error, isLoading, mutate } = useApi<TemplateLibrary>(TEMPLATES_PATH, { view: "library" });
  const member = useCan("member");
  const [channel, setChannel] = useState<ChannelFilter>("all");
  const [category, setCategory] = useState("all");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortKey>("newest");
  const [dialog, setDialog] = useState<{ template: LibraryTemplate | null; startFrom?: Partial<TemplateForm> } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // A link from search names a template (?template=id): it opens once, and closing it clears the address.
  const router = useRouter();
  const linkedId = typeof router.query.template === "string" ? router.query.template : null;
  const [closedLink, setClosedLink] = useState<string | null>(null);
  const linked = linkedId && linkedId !== closedLink ? data?.templates.find((template) => template.id === linkedId) ?? null : null;
  const open = dialog ?? (linked ? { template: linked } : null);
  const close = () => {
    setDialog(null);
    if (linkedId) {
      setClosedLink(linkedId);
      void router.replace("/templates", undefined, { shallow: true });
    }
  };

  const counts = channelCounts(data?.templates ?? []);
  const categories = data ? categoryOptions(data) : [];
  // A category that has just lost its last template is no longer a choice.
  const chosenCategory = categories.some((option) => option.value === category) ? category : "all";
  const rows = useMemo(() => (data ? sortTemplates(data.templates.filter((template) => matches(template, { channel, category: chosenCategory, q })), sort) : undefined), [data, channel, chosenCategory, q, sort]);
  const filtering = channel !== "all" || chosenCategory !== "all" || q.trim() !== "";

  async function remove(template: LibraryTemplate) {
    const ok = await confirm({ title: t("deleteTitle", {name: template.name}), body: deleteWarning(template), confirmLabel: t("deleteTemplate"), tone: "danger" });
    if (!ok || busy) return;
    setBusy(template.id);
    try {
      await api(templatePath(template.id), { method: "DELETE" });
      toast.success(t("deleted", {name: template.name}));
      void mutate();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  const duplicate = (template: LibraryTemplate) =>
    setDialog({ template: null, startFrom: { ...formOf(template), name: copyName(template.name, (data?.templates ?? []).map((item) => item.name)) } });

  const columns: Column<LibraryTemplate>[] = [
    {
      key: "name", header: t("template"),
      cell: (template) => (
        <div className="flex min-w-0 items-center gap-2.5">
          <ChannelBadge channel={template.channel} />
          <CellStack title={template.name} sub={previewLine(template)} />
        </div>
      ),
    },
    {
      key: "category", header: t("category"), width: 150,
      cell: (template) => template.category
        ? <span className="inline-flex h-5 max-w-full items-center rounded-full bg-control px-2 text-105 font-medium text-ink-2"><span className="truncate">{template.category}</span></span>
        : <span className="text-115 text-ink-3">—</span>,
    },
    {
      key: "used", header: t("usedIn"), width: 170,
      cell: (template) => <span className={cn("truncate text-115", template.figures?.steps ? "text-ink" : "text-ink-3")}>{usedIn(template.figures)}</span>,
    },
    {
      key: "sent", header: t("sent"), width: 110,
      cell: (template) => {
        const cells = figureCells(template.figures);
        return <CellStack title={cells.sent} sub={template.figures?.last_sent_at ? `last ${formatRelative(template.figures.last_sent_at)}` : undefined} />;
      },
    },
    {
      key: "replies", header: t("replies"), width: 120,
      cell: (template) => {
        const cells = figureCells(template.figures);
        return cells.thin && cells.replies !== "0"
          ? <Tooltip label={`From fewer than ${FEW_SENDS} sends, so the rate says little yet`}><span tabIndex={0} className="rounded-sm text-115 font-medium text-ink-2">{cells.replies}</span></Tooltip>
          : <span className={cn("text-115 font-medium", cells.replies === "—" ? "text-ink-3" : "text-ink")}>{cells.replies}</span>;
      },
    },
    {
      key: "positive", header: t("positive"), width: 80,
      cell: (template) => {
        const cells = figureCells(template.figures);
        return <span className={cn("text-115 font-medium", cells.positive === "—" ? "text-ink-3" : "text-good")}>{cells.positive}</span>;
      },
    },
    {
      key: "actions", header: <span className="sr-only">{t("actions")}</span>, width: 48, align: "right",
      cell: (template) => (
        // Stops the row's own click, which would open the template as well.
        <div onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
          <Menu trigger={<IconButton icon={Ellipsis} label={`Actions for ${template.name}`} size={28} />}>
            {member ? (
              <>
                <MenuItem icon={Pencil} onSelect={() => setDialog({ template })}>{t("edit")}</MenuItem>
                <MenuItem icon={Copy} onSelect={() => duplicate(template)}>{t("duplicate")}</MenuItem>
                <MenuSeparator />
                <MenuItem icon={Trash2} tone="danger" onSelect={() => void remove(template)}>{t("delete")}</MenuItem>
              </>
            ) : (
              <MenuItem icon={Eye} onSelect={() => setDialog({ template })}>{t("read")}</MenuItem>
            )}
          </Menu>
        </div>
      ),
    },
  ];

  return (
    <Page
      title={t("title")}
      meta={data ? <span className="text-11 text-ink-3">{librarySummary(data)}</span> : null}
      actions={
        member ? (
          <>
            <Button variant="primary" icon={Plus} onClick={() => setDialog({ template: null, startFrom: channel === "all" ? undefined : { channel } })} disabled={!data}>{t("newTemplate")}</Button>
            <span className="mx-0.5 h-5 w-px bg-line" aria-hidden="true" />
          </>
        ) : undefined
      }
    >
      {!member && data ? <Alert tone="neutral">{t("readOnly")}</Alert> : null}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Segmented<ChannelFilter>
            label={t("channel")} value={channel} onChange={setChannel}
            options={[{ value: "all", label: t("all"), count: counts.all }, { value: "linkedin", label: CHANNEL_LABEL.linkedin, count: counts.linkedin }, { value: "email", label: CHANNEL_LABEL.email, count: counts.email }]}
          />
          {categories.length > 1 ? <Select label={t("category")} value={chosenCategory} onChange={setCategory} options={categories} /> : null}
        </div>
        <div className="flex items-center gap-2">
          <SearchInput value={q} onChange={setQ} placeholder={t("search")} frameClassName="w-[220px]" />
          <Select<SortKey> label={t("sortBy")} value={sort} onChange={setSort} options={SORTS.map((option) => ({ value: option.value, label: sortLabels[option.value] }))} />
        </div>
      </div>
      <DataTable
        label={t("title")} columns={columns} rows={rows} rowKey={(template) => template.id} minWidth={900}
        loading={isLoading && !data} error={error && !data ? errorMessage(error) : undefined} onRetry={() => void mutate()}
        onRowClick={(template) => setDialog({ template })}
        empty={
          filtering ? (
            <EmptyState icon={FileText} title={t("noMatch")}>{t("noMatchBody")}</EmptyState>
          ) : (
            <EmptyState
              icon={FileText} title={t("noTemplates")}
              action={member ? <Button variant="primary" icon={Plus} onClick={() => setDialog({ template: null })}>{t("newTemplate")}</Button> : undefined}
            >
              {member ? t("noTemplatesWriter") : t("noTemplatesReader")}
            </EmptyState>
          )
        }
        footer={
          rows && rows.length > 0 ? (
            <p className="text-105 text-ink-3">
              {t("footerPrefix")} <Link href="/campaigns" className="font-semibold text-brand-strong hover:underline">{t("overview")}</Link>{t("footerSuffix")}
            </p>
          ) : undefined
        }
      />
      {open ? (
        <TemplateDialog
          key={open.template?.id ?? "new"}
          template={open.template} startFrom={open.startFrom} categories={data?.categories ?? []} readOnly={!member}
          onClose={close}
          onSaved={(message) => {
            toast.success(message);
            void mutate();
          }}
        />
      ) : null}
    </Page>
  );
}
