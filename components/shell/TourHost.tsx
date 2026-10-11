import { useCallback, useEffect, useMemo, useRef } from "react";
import { useRouter } from "next/router";
import { driver, type Driver } from "driver.js";
import "driver.js/dist/driver.css";
import { api } from "@/lib/client/api";
import { useApi } from "@/lib/client/data";
import { TOURS, TOUR_MIN_WIDTH, seenKey, tourToShow, type TourId } from "@/lib/client/tours";

/** Whether a step's target is on the page and has a size: a step that points at nothing is left out. */
function present(selector: string | null): boolean {
  if (selector === null) return true;
  const element = document.querySelector(selector);
  if (!element) return false;
  const box = element.getBoundingClientRect();
  return box.width > 0 && box.height > 0;
}

/**
 * Runs the guided tours. Each is shown once by itself, the first time a member reaches
 * its page; `start` runs one again on request. Returns `start`, for the Help menu.
 */
export function useTours(): (id: TourId) => void {
  const router = useRouter();
  const { data, mutate } = useApi<{ seen: string[] }>("/api/tour");
  const running = useRef<Driver | null>(null);
  const seen = useMemo(() => (data ? new Set(data.seen) : null), [data]);

  const start = useCallback((id: TourId) => {
    running.current?.destroy();
    const steps = TOURS[id].steps.filter((step) => present(step.target));
    if (steps.length === 0) return;
    const tour = driver({
      showProgress: steps.length > 1,
      progressText: "{{current}} of {{total}}",
      overlayColor: "#0D0E12",
      overlayOpacity: 0.55,
      stagePadding: 5,
      stageRadius: 8,
      popoverOffset: 10,
      allowClose: true,
      popoverClass: "linki-tour",
      nextBtnText: "Next",
      prevBtnText: "Back",
      doneBtnText: "Done",
      steps: steps.map((step) => ({ element: step.target ?? undefined, popover: { title: step.title, description: step.body, side: step.side, align: "start" as const } })),
      onDestroyed: () => { running.current = null; },
    });
    running.current = tour;
    tour.drive();
    // Seen from the moment it is shown, however it is left: finished, closed half-way, or
    // dismissed before its first step has settled (when the library reports nothing at all).
    void api("/api/tour", { method: "POST", body: { page: seenKey(id) } }).catch(() => undefined);
    void mutate((current) => ({ seen: [...new Set([...(current?.seen ?? []), seenKey(id)])] }), { revalidate: false });
  }, [mutate]);

  // The tour of a page starts by itself once, a moment after the page has drawn.
  useEffect(() => {
    if (!seen || running.current) return;
    const id = tourToShow(router.pathname, seen);
    if (!id) return;
    // Not on a narrow screen, where the sidebar is a drawer; and not for a browser being driven by a script.
    if (window.innerWidth < TOUR_MIN_WIDTH || navigator.webdriver) return;
    const timer = window.setTimeout(() => {
      // Something is already asking for attention (the campaign wizard, a confirmation): the tour can wait for the next visit.
      if (running.current || document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      start(id);
    }, 900);
    return () => window.clearTimeout(timer);
  }, [router.pathname, seen, start]);

  // A tour does not follow anyone to another page.
  useEffect(() => {
    const stop = () => running.current?.destroy();
    router.events.on("routeChangeStart", stop);
    return () => router.events.off("routeChangeStart", stop);
  }, [router.events]);

  return start;
}
