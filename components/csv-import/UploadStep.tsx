import Link from "next/link";
import { useRef, useState } from "react";
import { Download, FileUp, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Alert, Button, Card, IconButton, Spinner, confirm } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { useApi } from "@/lib/client/data";
import { IMPORTS_PATH, TEMPLATE_PATH, decodeFile, importHref, importPath, listingLine, type ImportListing, type ImportView } from "./model";
import { PanelHeader } from "./PanelHeader";

/** The most a file may be, the same as the server takes. */
const MAX_BYTES = 25 * 1024 * 1024;

/** Read a file the person chose into text, whatever it was saved as. */
export async function readFile(file: File): Promise<{ csv: string; filename: string; encoding: string } | { error: string }> {
  if (file.size > MAX_BYTES) return { error: "That file is over 25 MB. Split it into smaller files and import them one after another." };
  try {
    const { text, encoding } = decodeFile(await file.arrayBuffer());
    return text.trim() ? { csv: text, filename: file.name, encoding } : { error: "That file is empty." };
  } catch {
    return { error: "The file could not be read. Save it as CSV (comma separated) and try again." };
  }
}

/** Step one: choose the file. An import starts the moment a file is read, and is kept from then on. */
export function UploadStep({ listId, onStarted }: { listId: string | null; onStarted: (view: ImportView) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unfinished = useApi<{ imports: ImportListing[] }>(IMPORTS_PATH);
  const drafts = (unfinished.data?.imports ?? []).filter((item) => item.status === "draft");

  async function choose(file: File | null) {
    if (!file || busy) return;
    setError(null);
    setBusy(true);
    try {
      const read = await readFile(file);
      if ("error" in read) return setError(read.error);
      const made = await api<{ import: ImportView }>(IMPORTS_PATH, { method: "POST", body: { ...read, list_id: listId ?? undefined } });
      onStarted(made.import);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  async function discard(item: ImportListing) {
    const ok = await confirm({ title: `Discard the import of ${item.filename}?`, body: "The file and what was set up for it are thrown away. Nothing has been imported from it.", confirmLabel: "Discard", tone: "danger" });
    if (!ok) return;
    try {
      await api(importPath(item.id), { method: "DELETE" });
      void unfinished.mutate();
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  }

  return (
    <div className="flex flex-col gap-3.5">
      <Card className="flex flex-col gap-3.5 p-3.5">
        <input ref={input} type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values" className="sr-only" tabIndex={-1} aria-label="CSV file" onChange={(event) => void choose(event.target.files?.[0] ?? null)} />
        <button
          type="button" disabled={busy} onClick={() => input.current?.click()}
          onDragOver={(event) => { event.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
          onDrop={(event) => { event.preventDefault(); setOver(false); void choose(event.dataTransfer.files?.[0] ?? null); }}
          className={cn(
            "flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-14 text-center outline-none transition-colors focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand-tint",
            over ? "border-brand bg-brand-tint" : "border-line-strong bg-subtle hover:border-brand hover:bg-brand-tint",
          )}
        >
          {busy ? <Spinner size={20} label="Reading the file" /> : <FileUp size={20} className="text-ink-3" aria-hidden="true" />}
          <span className="text-13 font-semibold text-ink">{busy ? "Reading the file" : "Choose a CSV file"}</span>
          <span className="max-w-[460px] text-115 leading-[17px] text-ink-2">
            Or drop one here. Each row needs a LinkedIn profile or an email address; every other column is up to you. Nothing is imported until you have checked it over on the last step.
          </span>
        </button>
        {error ? <Alert tone="bad" title={error} /> : null}
        <a href={TEMPLATE_PATH} className="inline-flex items-center gap-1.5 self-start rounded-sm text-11 font-semibold text-brand-strong hover:underline">
          <Download size={12} aria-hidden="true" />
          Download a template with the columns Linki recognises
        </a>
      </Card>

      {drafts.length > 0 ? (
        <Card className="flex flex-col">
          <PanelHeader className="px-3.5 py-3" title="Pick up where you left off" subtitle="Imports that were started and not run. They are kept for 30 days." />
          <ul className="flex flex-col border-t border-line">
            {drafts.map((item) => (
              <li key={item.id} className="flex min-h-[52px] items-center gap-3 border-b border-line px-3.5 py-2 last:border-b-0">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-125 font-semibold text-ink">{item.filename}</span>
                  <span className="truncate text-11 text-ink-3">{listingLine(item)}</span>
                </div>
                <Button asChild size="sm"><Link href={importHref(item.id)}><RotateCcw size={12} className="text-ink-2" aria-hidden="true" />Continue</Link></Button>
                <IconButton icon={Trash2} label={`Discard the import of ${item.filename}`} size={28} onClick={() => void discard(item)} />
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
