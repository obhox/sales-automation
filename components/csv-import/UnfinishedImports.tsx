import Link from "next/link";
import { FileSpreadsheet, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui";
import { useApi } from "@/lib/client/data";
import { IMPORTS_PATH, importHref, listingLine, newImportHref, type ImportListing } from "./model";

/**
 * On the Lists screen: the CSV imports that were started and not run, each with a way
 * back into it. Nothing is drawn when there are none, or for someone who cannot import.
 */
export function UnfinishedImports({ enabled }: { enabled: boolean }) {
  const { data } = useApi<{ imports: ImportListing[] }>(enabled ? IMPORTS_PATH : null);
  const drafts = (data?.imports ?? []).filter((item) => item.status === "draft");
  if (drafts.length === 0) return null;
  const [first, ...rest] = drafts;
  return (
    <section aria-label="Imports not finished" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line bg-surface px-3.5 py-2.5 shadow-card">
      <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-brand-tint text-brand-strong"><FileSpreadsheet size={14} aria-hidden="true" /></span>
      <div className="flex min-w-0 flex-1 flex-col gap-px">
        <span className="truncate text-125 font-semibold text-ink">{drafts.length === 1 ? `The import of ${first.filename} was started and not run` : `${drafts.length} imports were started and not run`}</span>
        <span className="truncate text-11 text-ink-3">{drafts.length === 1 ? listingLine(first) : `${first.filename} · ${listingLine(first)}`}</span>
      </div>
      {rest.length > 0 ? <Button asChild size="sm" variant="ghost"><Link href={newImportHref()}>See all {drafts.length}</Link></Button> : null}
      <Button asChild size="sm"><Link href={importHref(first.id)}><RotateCcw size={12} className="text-ink-2" aria-hidden="true" />Continue</Link></Button>
    </section>
  );
}
