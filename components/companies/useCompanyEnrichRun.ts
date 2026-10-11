import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/client/api";
import { COMPANY_ENRICH_PATH, batches, enrichOutcome, type EnrichProgress } from "./model";

/**
 * Looking a set of companies up on Apollo, a batch at a time, from the page. Nothing is
 * looked up until `start` is called with the ids the cost preview returned. The run carries
 * on with its dialog hidden, stops after the batch in hand when asked to or when the screen
 * is left, and says what came of it in a toast.
 */
export function useCompanyEnrichRun(onFinished: () => void) {
  const [progress, setProgress] = useState<EnrichProgress | null>(null);
  const stopping = useRef(false);
  useEffect(() => () => { stopping.current = true; }, []);
  const running = progress?.state === "running" || progress?.state === "stopping";

  async function start(eligible: string[], batch: number) {
    stopping.current = false;
    let current: EnrichProgress = { total: eligible.length, done: 0, enriched: 0, notFound: 0, failed: 0, state: "running" };
    setProgress(current);
    for (const chunk of batches(eligible, batch)) {
      if (stopping.current) { current = { ...current, state: "stopped" }; break; }
      try {
        const result = await api<{ enriched: number; not_found: number; no_domain: number; failed: number }>(COMPANY_ENRICH_PATH, { method: "POST", body: { ids: chunk } });
        current = { ...current, done: current.done + chunk.length, enriched: current.enriched + result.enriched, notFound: current.notFound + result.not_found, failed: current.failed + result.failed + result.no_domain };
        setProgress({ ...current, state: stopping.current ? "stopping" : "running" });
      } catch (cause) {
        current = { ...current, state: "failed", error: errorMessage(cause) };
        break;
      }
    }
    if (current.state === "running") current = { ...current, state: stopping.current && current.done < current.total ? "stopped" : "finished" };
    setProgress(current);
    onFinished();
    if (current.state === "failed") toast.error(`Enrichment stopped: ${current.error}`, { description: current.enriched > 0 ? enrichOutcome(current) : undefined });
    else toast.success(enrichOutcome(current));
  }

  const stop = () => {
    stopping.current = true;
    setProgress((current) => (current ? { ...current, state: "stopping" } : current));
  };
  /** Forget a run that is over, so the next one starts from a cost preview. */
  const clear = () => setProgress((current) => (current && (current.state === "running" || current.state === "stopping") ? current : null));

  return { progress, running, start, stop, clear };
}
