// What needs someone's attention right now, read from how things stand: a mailbox that
// paused itself, a LinkedIn account that is signed out or close to its weekly limit,
// background work that has stopped, an AI budget that has run out, a sending domain whose
// DNS fails, prospects stuck on a failed step. Unlike a notification, an alert is not a
// record of something that happened: it is there while the problem is, and gone when it is not.
import type DatabaseType from "better-sqlite3";
import { budgetState } from "@/lib/ai/usage";
import { latestDomainChecks, listMailboxes } from "@/lib/email/mailbox-list";
import { linkedinAccountsOverview } from "@/lib/linkedin/account-list";
import { roleAtLeast, type WorkspaceRole } from "@/lib/roles";
import { readRunnerHealth } from "@/lib/system/health";

type DB = DatabaseType.Database;

export interface Alert {
  /** Stable while the problem lasts, so a list can be keyed by it. */
  id: string;
  kind:
    | "mailbox.auto_paused" | "mailbox.disconnected" | "mailbox.untested" | "domain.dns"
    | "linkedin.signin" | "linkedin.weekly_hold" | "linkedin.weekly_near" | "linkedin.paused"
    | "runner.stalled" | "ai.budget" | "campaign.failed";
  tone: "bad" | "warn";
  title: string;
  detail: string;
  /** Where to go to deal with it, and the word on the button. */
  action: { label: string; href: string };
}

const percent = (ratio: number) => `${(ratio * 100).toFixed(1)}%`;
const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

/**
 * Everything that needs attention in a workspace, worst first. A viewer sees the same list
 * as anyone: these are facts about the workspace, and the screens they point at decide
 * what each role can do there. Which background loop has stalled is for admins only.
 */
export function currentAlerts(db: DB, workspaceId: string, role: WorkspaceRole, now: Date = new Date()): Alert[] {
  const alerts: Alert[] = [];

  // ── Mailboxes ──
  const mailboxes = listMailboxes(db, workspaceId, now);
  for (const mailbox of mailboxes) {
    if (mailbox.status === "auto_paused") {
      const over = mailbox.health.bounce_rate !== null && mailbox.health.bounce_rate > mailbox.guard.bounce_threshold
        ? `bounce rate ${percent(mailbox.health.bounce_rate)} exceeded ${percent(mailbox.guard.bounce_threshold)}`
        : mailbox.health.complaint_rate !== null && mailbox.health.complaint_rate > mailbox.guard.complaint_threshold
          ? `complaint rate ${percent(mailbox.health.complaint_rate)} exceeded ${percent(mailbox.guard.complaint_threshold)}`
          : (mailbox.held?.reason ?? "its sending health fell below the guard").replace(/^Auto-paused: /, "");
      alerts.push({ id: `mailbox.auto_paused:${mailbox.id}`, kind: "mailbox.auto_paused", tone: "bad", title: "Mailbox auto-paused", detail: `${mailbox.from_email} · ${over}`, action: { label: "Review", href: `/mailboxes?mailbox=${mailbox.id}` } });
    } else if (mailbox.status === "disconnected") {
      alerts.push({ id: `mailbox.disconnected:${mailbox.id}`, kind: "mailbox.disconnected", tone: "bad", title: "Mailbox cannot sign in", detail: `${mailbox.from_email} · nothing is sent from it until it is reconnected`, action: { label: "Reconnect", href: `/mailboxes?mailbox=${mailbox.id}` } });
    } else if (mailbox.status === "untested" && mailbox.active_campaigns > 0) {
      alerts.push({ id: `mailbox.untested:${mailbox.id}`, kind: "mailbox.untested", tone: "warn", title: "Mailbox not verified", detail: `${mailbox.from_email} · ${mailbox.active_campaigns} ${plural(mailbox.active_campaigns, "campaign is", "campaigns are")} waiting on it`, action: { label: "Verify", href: `/mailboxes?mailbox=${mailbox.id}` } });
    }
  }

  // ── Sending domains ──
  const sendingDomains = new Set(mailboxes.filter((mailbox) => mailbox.status !== "disconnected").map((mailbox) => mailbox.domain));
  for (const [domain, dns] of latestDomainChecks(db, workspaceId)) {
    if (!sendingDomains.has(domain) || !dns.checked_at) continue;
    const failing = (["spf", "dkim", "dmarc"] as const).filter((record) => dns[record] === "fail");
    if (failing.length === 0) continue;
    alerts.push({
      id: `domain.dns:${domain}`, kind: "domain.dns", tone: "bad", title: `${failing.map((record) => record.toUpperCase()).join(" and ")} failing on ${domain}`,
      detail: "Mail from this domain is more likely to be marked as spam or refused until the DNS is fixed", action: { label: "See records", href: `/deliverability?domain=${encodeURIComponent(domain)}` },
    });
  }

  // ── LinkedIn accounts ──
  for (const account of linkedinAccountsOverview(db, workspaceId, now).accounts) {
    const href = "/linkedin-accounts";
    if (account.status === "needs_signin" || account.status === "disconnected") {
      alerts.push({ id: `linkedin.signin:${account.id}`, kind: "linkedin.signin", tone: "bad", title: "LinkedIn account signed out", detail: `${account.name} · its campaigns wait until it is signed in again`, action: { label: "Sign in", href } });
    } else if (account.status === "weekly_hold") {
      alerts.push({ id: `linkedin.weekly_hold:${account.id}`, kind: "linkedin.weekly_hold", tone: "warn", title: "LinkedIn weekly invite limit reached", detail: `${account.name} · invitations wait until the week rolls on; messages and visits carry on`, action: { label: "Review", href } });
    } else if (account.weekly.near && account.weekly.limit) {
      alerts.push({ id: `linkedin.weekly_near:${account.id}`, kind: "linkedin.weekly_near", tone: "warn", title: "LinkedIn weekly invite limit near", detail: `${account.name} · ${account.weekly.used} of ${account.weekly.limit} invites used this week`, action: { label: "Adjust", href } });
    } else if (account.status === "paused" && account.paused?.reason && !/^paused by/i.test(account.paused.reason)) {
      // Paused by Linki itself (a proxy that cannot be reached, a challenge), not by a person choosing to.
      alerts.push({ id: `linkedin.paused:${account.id}`, kind: "linkedin.paused", tone: "warn", title: "LinkedIn account on hold", detail: `${account.name} · ${account.paused.reason}`, action: { label: "Review", href } });
    }
  }

  // ── Background work ──
  const health = readRunnerHealth(db);
  if (health.status === "degraded") {
    const admin = roleAtLeast(role, "admin");
    const stalled = health.loops.filter((loop) => loop.stalled);
    const longest = Math.max(0, ...stalled.map((loop) => loop.minutes_since));
    alerts.push({
      id: "runner.stalled", kind: "runner.stalled", tone: "bad", title: `Background work stalled for ${longest} ${plural(longest, "minute", "minutes")}`,
      detail: admin ? `${stalled.map((loop) => loop.label).join(", ")} · nothing it does is happening until it is running again` : "Sending and reading replies are delayed. A workspace admin can see which part.",
      action: { label: admin ? "See health" : "Details", href: admin ? "/developers" : "/" },
    });
  }

  // ── AI budget ──
  const budget = budgetState(workspaceId, now);
  if (budget.reached && budget.budget_usd !== null) {
    alerts.push({
      id: `ai.budget:${budget.month}`, kind: "ai.budget", tone: "warn", title: "AI budget reached",
      detail: `$${budget.spent_usd.toFixed(2)} of $${budget.budget_usd.toFixed(2)} spent this month · AI-written steps wait until ${budget.resets_on} or a higher budget`, action: { label: "Adjust", href: "/ai" },
    });
  }

  // ── Campaigns ──
  const stuck = db.prepare(
    `SELECT w.id, w.name, COUNT(DISTINCT rp.id) AS failed FROM run_profile_tracks rt
     JOIN run_profiles rp ON rp.id = rt.run_profile_id JOIN runs r ON r.id = rp.run_id JOIN workflows w ON w.id = r.workflow_id
     WHERE r.workspace_id = ? AND r.status IN ('running', 'paused') AND rt.state = 'failed' AND COALESCE(w.is_archived, 0) = 0
     GROUP BY w.id HAVING failed > 0 ORDER BY failed DESC LIMIT 5`,
  ).all(workspaceId) as Array<{ id: string; name: string; failed: number }>;
  for (const campaign of stuck) {
    alerts.push({
      id: `campaign.failed:${campaign.id}`, kind: "campaign.failed", tone: "warn", title: `${campaign.failed} ${plural(campaign.failed, "prospect", "prospects")} stuck on a failed step`,
      detail: `${campaign.name} · retry them, or unenrol the ones that cannot go on`, action: { label: "Review", href: `/campaigns/${campaign.id}/prospects?status=failed` },
    });
  }

  const order = { bad: 0, warn: 1 } as const;
  return alerts.sort((a, b) => order[a.tone] - order[b.tone]);
}
