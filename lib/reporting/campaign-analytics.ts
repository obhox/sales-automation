import type DatabaseType from "better-sqlite3";
import { AUTO_REPLY_KINDS, HUMAN_REPLY_KINDS, sqlList } from "@/lib/reply-kinds";
import { daysOf, type ReportRange } from "@/lib/reporting/range";
import { campaignBreakdown } from "@/lib/reporting/breakdown";
import { likelyWinner } from "@/lib/reporting/stats";

/**
 * Everything the campaign analytics panel shows: funnel, audience, engagement, the daily
 * series, AI cost, and per-version results. The panel's route and the CSV export both read
 * it from here, so the file a person downloads has the numbers they were looking at.
 *
 * With no period named, the funnel and rates are for all time and the daily series covers
 * the range's default window. With one named, it means two things, and the panel says so:
 * the daily series and the per-version sends are what happened in the period, and the
 * funnel, audience and engagement are about the contacts first contacted in it, whenever
 * their opens and replies came. Following a cohort is what keeps a rate honest: counting
 * this week's replies against this week's sends credits the week with answers to mail
 * sent a month ago.
 */
export function campaignAnalytics(db: DatabaseType.Database, workflowId: string, range: ReportRange) {
    const bind = { wf: workflowId, from: range.from, to: range.to };
    const RUNS = `SELECT id FROM runs WHERE workflow_id = @wf AND status IN ('running','paused','completed')`;
    // The cohort: contacts whose first send in this campaign fell in the period.
    const COHORT = range.explicit ? `cohort AS (
        SELECT target_id FROM step_sends WHERE workflow_id = @wf AND target_id IS NOT NULL
        GROUP BY target_id HAVING MIN(datetime(sent_at)) >= @from AND MIN(datetime(sent_at)) < @to
      )` : null;
    const withs = (...ctes: Array<string | null>) => { const named = ctes.filter(Boolean); return named.length ? `WITH ${named.join(", ")}` : ""; };
    const inCohort = (column: string) => (COHORT ? `AND ${column} IN (SELECT target_id FROM cohort)` : "");
    const inPeriod = (column: string) => `AND datetime(${column}) >= @from AND datetime(${column}) < @to`;
    const days = daysOf(range);

    // ── Audience: enrolled vs. addressable ──────────────────────────────────────
    // The funnel's `total` counts everyone enrolled, but that overstates runway when most
    // contacts have no deliverable email. `eligible` = enrolled AND has a non-bounced email.
    // `verified` = the strict subset with a verified email. `email_real_replies` excludes
    // auto-responders (out-of-office and the like) so the reply signal is honest.
    const audience = db.prepare(`
      ${withs(COHORT, `enrolled AS (
        SELECT DISTINCT rp.target_id
        FROM run_profiles rp JOIN runs r ON r.id = rp.run_id
        WHERE r.workflow_id = @wf AND r.status IN ('running','paused','completed') ${inCohort("rp.target_id")}
      )`)}
      SELECT
        (SELECT COUNT(*) FROM enrolled) AS enrolled,
        (SELECT COUNT(*) FROM enrolled e JOIN targets t ON t.id = e.target_id
          WHERE t.email IS NOT NULL AND t.email != ''
            AND (t.email_status IS NULL OR t.email_status NOT IN ('invalid','unavailable'))) AS eligible,
        (SELECT COUNT(*) FROM enrolled e JOIN targets t ON t.id = e.target_id
          WHERE t.email_status = 'verified') AS verified,
        (SELECT COUNT(DISTINCT t.id) FROM enrolled e JOIN targets t ON t.id = e.target_id
          WHERE t.reply_kind IN (${sqlList(HUMAN_REPLY_KINDS)})) AS email_real_replies,
        (SELECT COUNT(DISTINCT t.id) FROM enrolled e JOIN targets t ON t.id = e.target_id
          WHERE t.reply_kind IN (${sqlList(AUTO_REPLY_KINDS)})) AS email_auto_replies
    `).get(bind) as {
      enrolled: number; eligible: number; verified: number;
      email_real_replies: number; email_auto_replies: number;
    };

    // Eligible contacts we've actually emailed at least once (Email sent log).
    const contactedRow = db.prepare(`
      ${withs(COHORT)}
      SELECT COUNT(DISTINCT l.target_id) AS contacted
      FROM logs l JOIN targets t ON t.id = l.target_id
      WHERE l.run_id IN (${RUNS}) AND l.message LIKE 'Email sent%'
        AND t.email IS NOT NULL AND t.email != ''
        AND (t.email_status IS NULL OR t.email_status NOT IN ('invalid','unavailable'))
        ${inCohort("l.target_id")}
    `).get(bind) as { contacted: number };

    const audienceOut = {
      enrolled: audience.enrolled,
      eligible: audience.eligible,        // has a deliverable email — the real addressable count
      verified: audience.verified,        // strict subset with a verified email
      contacted: contactedRow.contacted,  // eligible contacts emailed at least once
      replied: audience.email_real_replies,       // genuine human replies (auto-responders excluded)
      auto_replied: audience.email_auto_replies,  // out-of-office and other automatic answers (informational)
      remaining: Math.max(audience.eligible - contactedRow.contacted, 0), // eligible not yet emailed
    };

    // ── Funnel ────────────────────────────────────────────────────────────────
    const funnel = db.prepare(`
      ${withs(COHORT)}
      SELECT
        (SELECT COUNT(DISTINCT rp.target_id)
          FROM run_profiles rp JOIN runs r ON r.id = rp.run_id
          WHERE r.workflow_id = @wf AND r.status IN ('running','paused','completed') ${inCohort("rp.target_id")}) AS total,

        (SELECT COUNT(DISTINCT target_id) FROM logs
          WHERE run_id IN (${RUNS}) AND message LIKE 'Connection request sent%' ${inCohort("target_id")}) AS connections_sent,

        (SELECT COUNT(DISTINCT l.target_id) FROM logs l
          JOIN targets t ON t.id = l.target_id
          WHERE l.run_id IN (${RUNS})
            AND l.message LIKE 'Connection request sent%'
            AND t.connected_at IS NOT NULL ${inCohort("l.target_id")}) AS connected,

        (SELECT COUNT(DISTINCT target_id) FROM logs
          WHERE run_id IN (${RUNS}) AND message LIKE 'Message sent%' ${inCohort("target_id")}) AS messages_sent,

        (SELECT COUNT(DISTINCT target_id) FROM logs
          WHERE run_id IN (${RUNS}) AND message LIKE 'InMail sent%' ${inCohort("target_id")}) AS inmails_sent,

        (SELECT COUNT(DISTINCT l.target_id) FROM logs l
          JOIN targets t ON t.id = l.target_id
          WHERE l.run_id IN (${RUNS})
            AND (l.message LIKE 'Message sent%' OR l.message LIKE 'InMail sent%')
            AND t.last_replied_at IS NOT NULL ${inCohort("l.target_id")}) AS li_replies,

        (SELECT COUNT(DISTINCT target_id) FROM logs
          WHERE run_id IN (${RUNS}) AND message LIKE 'Email sent%' ${inCohort("target_id")}) AS emails_sent,

        (SELECT COUNT(DISTINCT l.target_id) FROM logs l
          JOIN targets t ON t.id = l.target_id
          WHERE l.run_id IN (${RUNS})
            AND l.message LIKE 'Email sent%'
            AND t.email_replied_at IS NOT NULL ${inCohort("l.target_id")}) AS email_replies,

        (SELECT COUNT(DISTINCT rp.target_id)
          FROM run_profiles rp JOIN runs r ON r.id = rp.run_id JOIN targets t ON t.id = rp.target_id
          WHERE r.workflow_id = @wf AND r.status IN ('running','paused','completed')
            AND t.unsubscribed_at IS NOT NULL ${inCohort("rp.target_id")}) AS unsubscribed,

        (SELECT COUNT(DISTINCT rp.target_id)
          FROM run_profiles rp JOIN runs r ON r.id = rp.run_id
          WHERE r.workflow_id = @wf AND r.status IN ('running','paused','completed') ${inCohort("rp.target_id")}
            AND NOT EXISTS (
              SELECT 1 FROM run_profile_tracks rt
              WHERE rt.run_profile_id = rp.id AND rt.state NOT IN ('completed', 'failed', 'skipped')
            )
            AND EXISTS (
              SELECT 1 FROM run_profile_tracks rt
              WHERE rt.run_profile_id = rp.id AND rt.state = 'completed'
            )) AS completed
    `).get(bind
    ) as {
      total: number; connections_sent: number; connected: number;
      messages_sent: number; inmails_sent: number; li_replies: number;
      emails_sent: number; email_replies: number; unsubscribed: number; completed: number;
    };

    // ── Opens and clicks ──────────────────────────────────────────────────────
    // These live in sender_events, keyed to the sent_message, and the funnel never asked
    // for them — which is why the campaign read as zero opens while the pixel was firing
    // and the event stream was full of email.opened. Nothing aggregates them on a schedule;
    // like every other number here they are read live at request time.
    //
    // Two counts per metric. `opened` is contacts whose open survived bot filtering;
    // `opened_raw` is every pixel hit including security-gateway prefetches. Reporting only
    // the raw number is what makes an open rate look like 95% on a campaign nobody read.
    //
    // The denominators are the sends that actually carried a pixel or wrapped links, not
    // every send: a step with tracking switched off cannot produce opens, and dividing by
    // it would render an honest zero as a bad open rate.
    const engagement = db.prepare(`
      ${withs(COHORT)}
      SELECT
        COUNT(DISTINCT CASE WHEN ej.track_opens = 1 THEN sm.id END) AS tracked_open_sends,
        COUNT(DISTINCT CASE WHEN ej.track_clicks = 1 THEN sm.id END) AS tracked_click_sends,
        COUNT(DISTINCT CASE WHEN se.event_type = 'opened' AND se.is_bot = 0 THEN sm.target_id END) AS opened,
        COUNT(DISTINCT CASE WHEN se.event_type = 'opened' THEN sm.target_id END) AS opened_raw,
        COUNT(DISTINCT CASE WHEN se.event_type = 'clicked' AND se.is_bot = 0 THEN sm.target_id END) AS clicked,
        COUNT(DISTINCT CASE WHEN se.event_type = 'clicked' THEN sm.target_id END) AS clicked_raw,
        COUNT(CASE WHEN se.event_type = 'opened' AND se.is_bot = 1 THEN 1 END) AS bot_open_hits,
        COUNT(CASE WHEN se.event_type = 'opened' AND se.is_bot = 0 THEN 1 END) AS human_open_hits
      FROM sent_messages sm
      JOIN email_jobs ej ON ej.id = sm.job_id
      LEFT JOIN sender_events se ON se.sent_message_id = sm.id AND se.event_type IN ('opened','clicked')
      WHERE sm.run_id IN (${RUNS}) ${inCohort("sm.target_id")}
    `).get(bind) as {
      tracked_open_sends: number; tracked_click_sends: number;
      opened: number; opened_raw: number; clicked: number; clicked_raw: number;
      bot_open_hits: number; human_open_hits: number;
    };

    const funnelOut = {
      ...funnel,
      emails_opened: engagement.opened,
      emails_clicked: engagement.clicked,
    };

    const engagementOut = {
      tracked_sends: engagement.tracked_open_sends,       // sends that actually carried a pixel
      tracked_click_sends: engagement.tracked_click_sends,
      opened: engagement.opened,                          // contacts with a human-looking open
      opened_raw: engagement.opened_raw,                  // contacts with any pixel hit at all
      clicked: engagement.clicked,
      clicked_raw: engagement.clicked_raw,
      bot_open_hits: engagement.bot_open_hits,            // hits attributed to scanners/prefetch
      human_open_hits: engagement.human_open_hits,
    };

    // ── Daily activity ────────────────────────────────────────────────────────
    const activity = db.prepare(`
      SELECT
        date(l.created_at) AS day,
        COUNT(CASE WHEN l.message LIKE 'Visited%' THEN 1 END) AS visits,
        COUNT(CASE WHEN l.message LIKE 'Connection request sent%' THEN 1 END) AS connections,
        COUNT(CASE WHEN l.message LIKE 'Message sent%' THEN 1 END) AS messages,
        COUNT(CASE WHEN l.message LIKE 'InMail sent%' THEN 1 END) AS inmails,
        COUNT(CASE WHEN l.message LIKE 'Email sent%' THEN 1 END) AS emails
      FROM logs l
      WHERE l.run_id IN (${RUNS})
        ${inPeriod("l.created_at")}
      GROUP BY date(l.created_at)
      ORDER BY day ASC
    `).all(bind) as { day: string; visits: number; connections: number; messages: number; inmails: number; emails: number }[];

    // Opens and clicks are dated by when the hit arrived, not when the message was sent, so
    // they come from sender_events rather than the logs table the rest of the series uses.
    const engagementDaily = db.prepare(`
      SELECT
        date(se.occurred_at) AS day,
        COUNT(CASE WHEN se.event_type = 'opened' AND se.is_bot = 0 THEN 1 END) AS opens,
        COUNT(CASE WHEN se.event_type = 'opened' AND se.is_bot = 1 THEN 1 END) AS bot_opens,
        COUNT(CASE WHEN se.event_type = 'clicked' AND se.is_bot = 0 THEN 1 END) AS clicks
      FROM sender_events se
      JOIN sent_messages sm ON sm.id = se.sent_message_id
      WHERE sm.run_id IN (${RUNS})
        AND se.event_type IN ('opened','clicked')
        -- Normalised, not compared raw: the tracking endpoints write occurred_at as a full
        -- ISO string with a T and a Z while SQLite's own datetime() writes a space-separated
        -- one, and comparing those two shapes as text sorts on the separator.
        ${inPeriod("se.occurred_at")}
      GROUP BY date(se.occurred_at)
    `).all(bind) as { day: string; opens: number; bot_opens: number; clicks: number }[];

    type ActivityRow = (typeof activity)[number] & { opens: number; bot_opens: number; clicks: number };
    const filled: ActivityRow[] = [];
    for (const key of days) {
      const found = activity.find(r => r.day === key);
      const eng = engagementDaily.find(r => r.day === key);
      filled.push({
        ...(found ?? { day: key, visits: 0, connections: 0, messages: 0, inmails: 0, emails: 0 }),
        opens: eng?.opens ?? 0,
        bot_opens: eng?.bot_opens ?? 0,
        clicks: eng?.clicks ?? 0,
      });
    }

    // ── AI cost — daily time-series scoped to this workflow's runs ────────────
    const aiDaily = db.prepare(`
      SELECT
        date(a.created_at) AS day,
        SUM(a.cost_usd) AS cost_usd,
        SUM(a.input_tokens) AS input_tokens,
        SUM(a.output_tokens) AS output_tokens
      FROM agent_sessions a
      WHERE a.run_id IN (${RUNS})
        ${inPeriod("a.created_at")}
      GROUP BY date(a.created_at)
      ORDER BY day ASC
    `).all(bind) as { day: string; cost_usd: number; input_tokens: number; output_tokens: number }[];

    const aiDailyFilled: typeof aiDaily = [];
    for (const key of days) {
      const found = aiDaily.find(r => r.day === key);
      aiDailyFilled.push(found ?? { day: key, cost_usd: 0, input_tokens: 0, output_tokens: 0 });
    }

    // ── AI cost — breakdown per step (step_type + step_order from workflow_steps) ─
    const aiByStep = db.prepare(`
      SELECT
        ws.step_order,
        ws.step_type,
        COUNT(a.id) AS call_count,
        SUM(a.input_tokens) AS input_tokens,
        SUM(a.output_tokens) AS output_tokens,
        SUM(a.cost_usd) AS cost_usd,
        GROUP_CONCAT(DISTINCT a.model) AS models
      FROM agent_sessions a
      JOIN workflow_steps ws ON ws.id = a.step_id
      WHERE a.run_id IN (${RUNS})
        ${range.explicit ? inPeriod("a.created_at") : ""}
      GROUP BY a.step_id
      ORDER BY ws.step_order
    `).all(bind) as {
      step_order: number; step_type: string; call_count: number;
      input_tokens: number; output_tokens: number; cost_usd: number; models: string;
    }[];

    // ── Email A/B test results — per-variant sent/opens/clicks for steps that have variants ──
    //
    // AI-enabled steps are excluded even when variants are stored against them. The runner
    // takes the AI branch and writes every send with a null variant_id, so there is no split
    // to measure — the panel collapsed to a single row labelled with an arbitrary subject and
    // presented per-contact AI personalisation as if it were a controlled A/B test.
    const emailStepsWithVariants = db.prepare(`
      SELECT ws.id AS step_id, ws.step_order, ws.email_subject, ws.email_control_disabled
      FROM workflow_steps ws
      WHERE ws.workflow_id = ? AND ws.track = 'email'
        AND COALESCE(ws.ai_enabled, 0) = 0
        AND EXISTS (SELECT 1 FROM workflow_step_email_variants v WHERE v.step_id = ws.id)
      ORDER BY ws.step_order
    `).all(workflowId) as { step_id: string; step_order: number; email_subject: string | null; email_control_disabled: number }[];

    // Counted per version id. `opens` and `clicks` are hits, as they always were here;
    // the sends that were opened at all, and the replies, come from the breakdown below.
    const variantStmt = db.prepare(`
      SELECT
        ej.variant_id,
        MIN(ej.subject) AS sent_subject,
        COUNT(DISTINCT sm.id) AS sent,
        COUNT(DISTINCT CASE WHEN se.event_type = 'opened' AND se.is_bot = 0 THEN se.id END) AS opens,
        COUNT(DISTINCT CASE WHEN se.event_type = 'opened' THEN se.id END) AS opens_raw,
        COUNT(DISTINCT CASE WHEN se.event_type = 'clicked' AND se.is_bot = 0 THEN se.id END) AS clicks
      FROM email_jobs ej
      JOIN sent_messages sm ON sm.job_id = ej.id
      LEFT JOIN sender_events se ON se.sent_message_id = sm.id AND se.event_type IN ('opened','clicked')
      WHERE ej.step_id = @step
        ${range.explicit ? inPeriod("sm.accepted_at") : ""}
      GROUP BY ej.variant_id
    `);
    const definedVariants = db.prepare("SELECT id, subject, disabled_at FROM workflow_step_email_variants WHERE step_id = ? ORDER BY position");
    const credited = new Map(emailStepsWithVariants.length ? campaignBreakdown(db, workflowId, "variant", range).rows.map((row) => [row.key, row]) : []);

    const emailVariants = emailStepsWithVariants.map((step) => {
      type Sent = { variant_id: string | null; sent_subject: string; sent: number; opens: number; opens_raw: number; clicks: number };
      const sentBy = new Map((variantStmt.all({ ...bind, step: step.step_id }) as Sent[]).map((row) => [row.variant_id, row]));
      const version = (id: string | null, label: string, subject: string | null, paused: boolean, removed = false) => {
        const sent = sentBy.get(id);
        const outcome = credited.get(`${step.step_id}|${id ?? "control"}`);
        return {
          variant_id: id,
          label,
          subject: subject ?? sent?.sent_subject ?? "",
          sent: sent?.sent ?? 0,
          opens: sent?.opens ?? 0,          // scanner prefetches excluded
          opens_raw: sent?.opens_raw ?? 0,  // every pixel hit, for comparison
          clicks: sent?.clicks ?? 0,
          opened_sends: outcome?.opened ?? 0,  // emails opened at least once, which is what a rate is made of
          replies: outcome?.replied ?? 0,
          paused,
          removed,
        };
      };
      const defined = definedVariants.all(step.step_id) as Array<{ id: string; subject: string; disabled_at: string | null }>;
      const versions = [
        // The step's own wording is version A; the variants follow in their order.
        version(null, "A", step.email_subject, Boolean(step.email_control_disabled)),
        ...defined.map((variant, index) => version(variant.id, String.fromCharCode(66 + index), variant.subject, Boolean(variant.disabled_at))),
      ];
      // A version edited out of the step still has its sends; it is shown, apart from the test.
      for (const id of sentBy.keys()) {
        if (id !== null && !defined.some((variant) => variant.id === id)) versions.push(version(id, "Removed", null, true, true));
      }
      const running = versions.filter((entry) => !entry.paused);
      const winner = likelyWinner(running.map((entry) => ({ id: entry.variant_id, sent: entry.sent, replies: entry.replies, opened: entry.opened_sends })));
      return {
        step_id: step.step_id,
        step_order: step.step_order,
        control_paused: Boolean(step.email_control_disabled),
        // Null while the versions still running are too close, or too few sends in, to call.
        likely_winner: winner && { variant_id: winner.id, metric: winner.metric, confidence: winner.confidence },
        variants: versions,
      };
    });

    return {
      range: { from: range.fromDay, to: range.toDay, explicit: range.explicit },
      funnel: funnelOut, audience: audienceOut, engagement: engagementOut, activity: filled, aiDaily: aiDailyFilled, aiByStep, emailVariants,
    };
}

export type CampaignAnalytics = ReturnType<typeof campaignAnalytics>;
