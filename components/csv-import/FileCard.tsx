import { useRef, useState } from "react";
import { Check, Eye, FileSpreadsheet, RefreshCw, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button, Card, Dialog, ErrorState, LoadingState, Pill, confirm } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import { useApi } from "@/lib/client/data";
import { formatCount } from "@/lib/client/format";
import { readFile } from "./UploadStep";
import { columnLetter, delimiterLabel, encodingLabel, fileFacts, importPath, type ImportView } from "./model";

/** The file being imported: what it is, a look at its rows, and swapping it for another. */
export function FileCard({ view, onReplace }: { view: ImportView; onReplace: (file: { csv: string; filename: string; encoding: string }) => Promise<boolean> }) {
  const input = useRef<HTMLInputElement>(null);
  const [previewing, setPreviewing] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const encoding = encodingLabel(view.file.encoding);

  async function replace(file: File | null) {
    if (!file || replacing) return;
    const ok = await confirm({ title: `Replace ${view.file.name} with ${file.name}?`, body: "The new file's columns are mapped afresh. Where the import goes and how duplicates are treated stay as they are.", confirmLabel: "Replace file" });
    if (input.current) input.current.value = "";
    if (!ok) return;
    setReplacing(true);
    try {
      const read = await readFile(file);
      if ("error" in read) return void toast.error(read.error);
      if (await onReplace(read)) toast.success(`Now importing ${read.filename}`);
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setReplacing(false);
    }
  }

  return (
    <Card className="flex shrink-0 flex-wrap items-center gap-3 p-3.5">
      <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-tint text-brand-strong"><FileSpreadsheet size={16} aria-hidden="true" /></span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h2 className="truncate text-13 font-semibold text-ink">{view.file.name}</h2>
          {encoding ? <Pill size="sm">{encoding}</Pill> : null}
          <Pill size="sm">{delimiterLabel(view.file.delimiter)}</Pill>
          {view.file.has_header ? <Pill size="sm" tone="good" icon={Check}>Header row detected</Pill> : <Pill size="sm" tone="warn" icon={TriangleAlert}>No header row: columns are numbered</Pill>}
        </div>
        <p className="truncate text-11 text-ink-3">{fileFacts(view)}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button icon={Eye} onClick={() => setPreviewing(true)}>Preview rows</Button>
        <input ref={input} type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values" className="sr-only" tabIndex={-1} aria-label="Replacement CSV file" onChange={(event) => void replace(event.target.files?.[0] ?? null)} />
        <Button icon={RefreshCw} loading={replacing} onClick={() => input.current?.click()}>Replace file</Button>
      </div>
      <PreviewDialog open={previewing} view={view} onClose={() => setPreviewing(false)} />
    </Card>
  );
}

function PreviewDialog({ open, view, onClose }: { open: boolean; view: ImportView; onClose: () => void }) {
  const { data, error, isLoading, mutate } = useApi<{ columns: string[]; rows: string[][]; total: number }>(open ? importPath(view.id) : null, { view: "rows", limit: 50 });
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }} title="Preview rows" description={data ? `The first ${formatCount(data.rows.length)} of ${formatCount(data.total)} rows of ${view.file.name}, as they are in the file` : view.file.name} size="xl" padded={false}>
      {error && !data ? <ErrorState className="flex-1" message={errorMessage(error)} onRetry={() => void mutate()} /> : isLoading || !data ? <LoadingState className="flex-1" label="Reading the file" /> : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-max min-w-full border-separate border-spacing-0 text-left">
            <thead>
              <tr>
                <th scope="col" className="sticky left-0 top-0 z-20 border-b border-line bg-subtle px-3 py-2 text-10 font-semibold uppercase tracking-label text-ink-3">Row</th>
                {data.columns.map((column, index) => (
                  <th key={index} scope="col" className="sticky top-0 z-10 max-w-[260px] border-b border-line bg-subtle px-3 py-2">
                    <span className="block truncate font-mono text-115 font-medium text-ink">{column}</span>
                    <span className="block text-10 font-normal text-ink-3">column {columnLetter(index)}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row, at) => (
                <tr key={at}>
                  <th scope="row" className="sticky left-0 z-10 border-b border-line bg-surface px-3 py-1.5 font-mono text-105 font-normal text-ink-3">{at + (view.file.has_header ? 2 : 1)}</th>
                  {data.columns.map((_, index) => (
                    <td key={index} className="max-w-[260px] truncate border-b border-line px-3 py-1.5 text-115 text-ink-2" title={row[index] ?? ""}>{row[index] || <span className="text-ink-3">—</span>}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Dialog>
  );
}
