import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/client/api";
import { RESEARCH_PATH, batches, researchOutcome, type ResearchProgress } from "./model";

/**
 * Researching a set of contacts into a hook line each, a batch at a time, from the page.
 * The same shape as useEnrichRun deliberately: the run belongs to the screen that started
 * it, carries on with its dialog hidden, stops after the batch in hand when asked to or
 * when the screen is left, and says what came of it in a toast. Nothing is read or spent
 * until `start` is called with the ids the cost preview returned.
 */
export function useResearchRun(onFinished: () => void) {
  const [progress, setProgress] = useState<ResearchProgress | null>(null);
  const stopping = useRef(false);
  useEffect(() => () => { stopping.current = true; }, []);
  const running = progress?.state === "running" || progress?.state === "stopping";

  async function start(eligible: string[], batch: number) {
    stopping.current = false;
    let current: ResearchProgress = { total: eligible.length, done: 0, written: 0, noHook: 0, skipped: 0, state: "running" };
    setProgress(current);
    for (const chunk of batches(eligible, batch)) {
      if (stopping.current) { current = { ...current, state: "stopped" }; break; }
      try {
        const result = await api<{ written: number; no_hook: number; unreadable: number; no_website: number }>(RESEARCH_PATH, { method: "POST", body: { target_ids: chunk } });
        current = {
          ...current, done: current.done + chunk.length,
          written: current.written + result.written, noHook: current.noHook + result.no_hook,
          skipped: current.skipped + result.unreadable + result.no_website,
        };
        setProgress({ ...current, state: stopping.current ? "stopping" : "running" });
      } catch (cause) {
        // The route stops the whole run on a provider refusal or an exhausted AI budget, so
        // the first failure ends this loop too rather than spending on the next batch.
        current = { ...current, state: "failed", error: errorMessage(cause) };
        break;
      }
    }
    if (current.state === "running") current = { ...current, state: stopping.current && current.done < current.total ? "stopped" : "finished" };
    setProgress(current);
    onFinished();
    if (current.state === "failed") toast.error(`Research stopped: ${current.error}`, { description: current.written > 0 ? researchOutcome(current) : undefined });
    else toast.success(researchOutcome(current));
  }

  const stop = () => {
    stopping.current = true;
    setProgress((current) => (current ? { ...current, state: "stopping" } : current));
  };
  /** Forget a run that is over, so the next one starts from a cost preview. */
  const clear = () => setProgress((current) => (current && (current.state === "running" || current.state === "stopping") ? current : null));

  return { progress, running, start, stop, clear };
}
