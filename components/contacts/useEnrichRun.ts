import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/client/api";
import { ENRICH_PATH, batches, enrichOutcome, type EnrichProgress } from "./model";

/**
 * Looking a set of contacts up on Apollo, a batch at a time, from the page. The run
 * belongs to the screen that started it: it carries on with its dialog hidden, stops
 * after the batch in hand when asked to or when the screen is left, and says what came
 * of it in a toast. Nothing is looked up until `start` is called with the ids the cost
 * preview returned.
 */
export function useEnrichRun(onFinished: () => void) {
  const [progress, setProgress] = useState<EnrichProgress | null>(null);
  const stopping = useRef(false);
  useEffect(() => () => { stopping.current = true; }, []);
  const running = progress?.state === "running" || progress?.state === "stopping";

  async function start(eligible: string[], batch: number) {
    stopping.current = false;
    let current: EnrichProgress = { total: eligible.length, done: 0, enriched: 0, emails: 0, notFound: 0, failed: 0, state: "running" };
    setProgress(current);
    for (const chunk of batches(eligible, batch)) {
      if (stopping.current) { current = { ...current, state: "stopped" }; break; }
      try {
        const result = await api<{ enriched: number; notFound: number; skipped: number; emails_found: number }>(ENRICH_PATH, { method: "POST", body: { target_ids: chunk } });
        current = {
          ...current, done: current.done + chunk.length, enriched: current.enriched + result.enriched, emails: current.emails + result.emails_found,
          notFound: current.notFound + result.notFound, failed: current.failed + result.skipped,
        };
        setProgress({ ...current, state: stopping.current ? "stopping" : "running" });
      } catch (cause) {
        current = { ...current, state: "failed", error: errorMessage(cause) };
        break;
      }
    }
    if (current.state === "running") current = { ...current, state: stopping.current && current.done < current.total ? "stopped" : "finished" };
    setProgress(current);
    onFinished();
    if (current.state === "failed") toast.error(`Enrichment stopped: ${current.error}`);
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
