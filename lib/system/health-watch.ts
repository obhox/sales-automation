import type Database from "better-sqlite3";
import { notify } from "@/lib/platform/notifications";
import { readRunnerHealth, STALLED_AFTER_MINUTES } from "@/lib/system/health";

/**
 * Tell each workspace's admins when a background loop has stopped coming round.
 *
 * A stalled loop cannot report itself, so this runs on a loop of its own. It is raised
 * once per loop per day per workspace (the dedupe key), not on every pass. Returns the
 * names of the loops found stalled.
 */
export function watchRunnerHealth(db: Database.Database): string[] {
  const health = readRunnerHealth(db);
  if (health.status !== "degraded") return [];
  const stalled = health.loops.filter(loop => loop.stalled && loop.name !== "health-runner");
  if (stalled.length === 0) return [];
  const day = new Date().toISOString().slice(0, 10);
  const workspaces = db.prepare("SELECT id FROM workspaces").all() as { id: string }[];
  for (const loop of stalled) {
    for (const workspace of workspaces) {
      notify(
        {
          workspaceId: workspace.id,
          kind: "runner.stalled",
          tone: "warn",
          minRole: "admin",
          title: `${loop.label} has stalled`,
          body: `No activity for ${loop.minutes_since} minutes (it normally reports every minute or so; ${STALLED_AFTER_MINUTES} minutes counts as stalled). Sending that depends on it is waiting.`,
          link: "/platform",
          dedupeKey: `runner-stalled:${loop.name}:${day}`,
        },
        db,
      );
    }
  }
  return stalled.map(loop => loop.name);
}
