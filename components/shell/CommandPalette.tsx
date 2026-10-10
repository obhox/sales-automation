import { useMemo, useState } from "react";
import { useRouter } from "next/router";
import { Command } from "cmdk";
import { Dialog as RadixDialog, VisuallyHidden } from "radix-ui";
import { Building2, CornerDownLeft, FileText, ListChecks, Plus, Search, SendHorizontal, UserRound, type LucideIcon } from "lucide-react";
import { Spinner } from "@/components/ui";
import { useApi } from "@/lib/client/data";
import { NAV, NEW_CAMPAIGN_HREF, RECORD_KIND_LABEL, navHref, recordHref, type RecordKind } from "@/lib/client/nav";
import { useCan } from "@/lib/client/roles";
import { useDebounced } from "@/lib/client/table-state";
import type { SearchResult } from "@/pages/api/search";
import { useShell } from "./useShell";

const KIND_ICON: Record<RecordKind, LucideIcon> = { contact: UserRound, company: Building2, campaign: SendHorizontal, list: ListChecks, template: FileText };
const KINDS: RecordKind[] = ["contact", "company", "campaign", "list", "template"];

const ITEM =
  "flex h-9 cursor-pointer select-none items-center gap-2.5 rounded-md px-2.5 text-125 text-ink outline-none data-[selected=true]:bg-brand-tint data-[selected=true]:text-brand-strong";
const HEADING = "[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-10 [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-label [&_[cmdk-group-heading]]:text-ink-3";

/** ⌘K: jump to any screen, or find a contact, company, campaign, list or template by name. */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const { data: shell } = useShell();
  const canWrite = useCan("member");
  const [text, setText] = useState("");
  const query = useDebounced(text.trim(), 180);
  const searching = query.length >= 2;
  const { data, isLoading } = useApi<{ query: string; results: SearchResult[] }>(open && searching ? "/api/search" : null, { q: query }, { keepPreviousData: false });

  const go = (href: string) => {
    onOpenChange(false);
    void router.push(href);
  };

  const destinations = useMemo(
    () => NAV.flatMap(section => section.items.filter(item => !item.requires || shell?.capabilities?.[item.requires] !== false).map(item => ({ ...item, section: section.label }))),
    [shell?.capabilities],
  );
  const needle = text.trim().toLowerCase();
  const matchingDestinations = needle ? destinations.filter(item => item.label.toLowerCase().includes(needle)) : destinations;
  const results = searching && data?.query === query ? data.results : [];
  const showNewCampaign = canWrite && (!needle || "new campaign".includes(needle));
  const nothing = searching && !isLoading && data?.query === query && results.length === 0 && matchingDestinations.length === 0 && !showNewCampaign;

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-scrim data-[state=open]:animate-fade-in" />
        <RadixDialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-[14vh] z-50 w-[600px] max-w-[calc(100vw-32px)] -translate-x-1/2 overflow-hidden rounded-lg border border-line-strong bg-surface shadow-card outline-none data-[state=open]:animate-fade-in"
        >
          <VisuallyHidden.Root asChild>
            <RadixDialog.Title>Search and jump</RadixDialog.Title>
          </VisuallyHidden.Root>
          {/* Filtering is done here (destinations) and on the server (records), not by cmdk. */}
          <Command shouldFilter={false} label="Search and jump" loop>
            <div className="flex h-12 items-center gap-2.5 border-b border-line px-3.5">
              <Search size={15} className="shrink-0 text-ink-3" aria-hidden="true" />
              <Command.Input
                value={text}
                onValueChange={setText}
                placeholder="Search contacts, companies, campaigns, lists…"
                className="h-full min-w-0 flex-1 bg-transparent text-13 text-ink outline-none placeholder:text-ink-3"
              />
              {searching && isLoading ? <Spinner size={14} label="Searching" className="text-ink-3" /> : null}
            </div>
            <Command.List className="max-h-[420px] overflow-y-auto p-1.5">
              {nothing ? <p className="px-3 py-8 text-center text-12 text-ink-2">Nothing matches “{query}”.</p> : null}

              {KINDS.map(kind => {
                const rows = results.filter(result => result.kind === kind);
                if (rows.length === 0) return null;
                const Glyph = KIND_ICON[kind];
                return (
                  <Command.Group key={kind} heading={RECORD_KIND_LABEL[kind]} className={HEADING}>
                    {rows.map(row => (
                      <Command.Item key={`${kind}:${row.id}`} value={`${kind}:${row.id}`} onSelect={() => go(recordHref(kind, row.id))} className={ITEM}>
                        <Glyph size={14} className="shrink-0 text-ink-3" aria-hidden="true" />
                        <span className="truncate font-medium">{row.title}</span>
                        {row.subtitle ? <span className="truncate text-115 text-ink-3">{row.subtitle}</span> : null}
                      </Command.Item>
                    ))}
                  </Command.Group>
                );
              })}

              {showNewCampaign ? (
                <Command.Group heading="Actions" className={HEADING}>
                  <Command.Item value="action:new-campaign" onSelect={() => go(NEW_CAMPAIGN_HREF)} className={ITEM}>
                    <Plus size={14} className="shrink-0 text-ink-3" aria-hidden="true" />
                    <span className="font-medium">New campaign</span>
                  </Command.Item>
                </Command.Group>
              ) : null}

              {matchingDestinations.length > 0 ? (
                <Command.Group heading="Go to" className={HEADING}>
                  {matchingDestinations.map(item => {
                    const Glyph = item.icon;
                    return (
                      <Command.Item key={item.key} value={`go:${item.key}`} onSelect={() => go(navHref(item))} className={ITEM}>
                        <Glyph size={14} className="shrink-0 text-ink-3" aria-hidden="true" />
                        <span className="font-medium">{item.label}</span>
                        <span className="text-115 text-ink-3">{item.section}</span>
                      </Command.Item>
                    );
                  })}
                </Command.Group>
              ) : null}
            </Command.List>
            <div className="flex items-center justify-between border-t border-line bg-subtle px-3.5 py-2 text-105 text-ink-3">
              <span>{needle.length === 1 ? "Type one more letter to search records" : "↑ ↓ to move"}</span>
              <span className="flex items-center gap-1">
                <CornerDownLeft size={11} aria-hidden="true" /> to open · esc to close
              </span>
            </div>
          </Command>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
