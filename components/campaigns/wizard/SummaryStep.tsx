import type { ReactNode } from "react";
import { CircleAlert, CircleCheck, Eye, ListChecks, ListFilter, Mail, MessageSquare, Send, Sparkles, TriangleAlert, UserPlus, Users, type LucideIcon } from "lucide-react";
import { Button, LinkedinIcon, Meter, Popover, Skeleton, TextAction } from "@/components/ui";
import { TRIGGER_LABEL } from "@/lib/campaigns/context";
import { cn } from "@/lib/client/cn";
import { useApi } from "@/lib/client/data";
import { formatCount, formatPercent, plural, rate } from "@/lib/client/format";
import { clearChecks, nameList, tokens, usd, type Draft, type Prelaunch, type SequenceFacts, type SetupOptions, type SetupStep } from "./model";

const STEP_ICON: Record<string, LucideIcon> = { visit: Eye, connect: UserPlus, message: MessageSquare, sales_inmail: Send, email: Mail };
/** Which step of the wizard puts each check right. */
const FIX: Record<string, SetupStep> = { sequence: "linkedin", audience: "list", linkedin: "senders", mailboxes: "senders", ai: "context", overlap: "summary" };

interface OverlapAnswer { overlapping_contacts?: Array<{ id: string; name: string; company: string | null; campaign: string }> }

/** Step 6: everything the launch would do, what stands in its way, and the choice about contacts in another campaign. */
export function SummaryStep({
  id, draft, options, facts, prelaunch, defaultModel, onEdit, onOverlap,
}: {
  id: string;
  draft: Draft;
  options: SetupOptions | undefined;
  facts: SequenceFacts | null;
  prelaunch: Prelaunch | undefined;
  defaultModel: string | null;
  onEdit: (step: SetupStep) => void;
  onOverlap: (choice: "skip" | "take_over") => void;
}) {
  if (!prelaunch || !facts) {
    return (
      <div className="flex flex-1 flex-col gap-3" aria-busy="true">
        <Skeleton className="h-9 w-full" />
        <div className="grid flex-1 grid-cols-3 gap-3.5"><Skeleton className="h-full" /><Skeleton className="h-full" /><Skeleton className="h-full" /></div>
        <div className="grid flex-1 grid-cols-3 gap-3.5"><Skeleton className="h-full" /><Skeleton className="h-full" /><Skeleton className="h-full" /></div>
      </div>
    );
  }
  const { audience, checks, capacity, cost } = prelaunch;
  const blocking = checks.filter((check) => check.state === "block");
  const warnings = checks.filter((check) => check.state === "warn" && check.key !== "overlap");
  const accounts = (options?.linkedin_accounts ?? []).filter((account) => draft.setup.account_ids.includes(account.id));
  const mailboxes = (options?.mailboxes ?? []).filter((mailbox) => draft.setup.email_account_ids.includes(mailbox.id));
  const excluded = [draft.setup.exclude.customers ? "Customers" : "", draft.setup.exclude.open_deals ? "open deals" : ""].filter(Boolean).join(", ");
  const model = draft.ai.model || defaultModel;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-[13px] overflow-y-auto pr-0.5">
      {blocking.length > 0 ? (
        <div role="alert" className="flex gap-[11px] rounded-[9px] bg-bad-tint p-3">
          <CircleAlert size={17} className="mt-px shrink-0 text-bad" aria-hidden="true" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <p className="text-125 font-semibold text-bad">{blocking.length === 1 ? "One thing stops this campaign launching" : `${blocking.length} things stop this campaign launching`}</p>
            {blocking.map((check) => (
              <div key={check.key} className="flex items-start justify-between gap-3">
                <p className="text-11 leading-[17px] text-bad"><span className="font-semibold">{check.label}:</span> {check.detail}</p>
                <TextAction className="shrink-0" onClick={() => onEdit(FIX[check.key])}>Fix</TextAction>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {audience && audience.overlapping > 0 ? (
        <div className="flex gap-[11px] rounded-[9px] bg-warn-tint p-3">
          <TriangleAlert size={17} className="mt-px shrink-0 text-warn" aria-hidden="true" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <p className="text-125 font-semibold text-warn">{formatCount(audience.overlapping)} {plural(audience.overlapping, "contact is", "contacts are")} already enrolled in another campaign</p>
              <OverlapReview id={id} count={audience.overlapping} />
            </div>
            <p className="text-11 leading-[17px] text-warn">
              Overlap comes from {nameList(audience.overlaps.map((overlap) => `“${overlap.name}” (${formatCount(overlap.contacts)})`), 3)}. Reaching the same person from two campaigns at once reads as spam, and on LinkedIn it raises the risk of a restriction.
            </p>
            <div role="radiogroup" aria-label="What to do with contacts in another campaign" className="flex flex-col gap-1.5">
              <Choice chosen={draft.setup.overlap === "skip"} onChoose={() => onOverlap("skip")} label={`Skip the overlapping contacts — enrol ${formatCount(audience.enrol - (draft.setup.overlap === "take_over" ? audience.overlapping : 0))}`} recommended />
              <Choice chosen={draft.setup.overlap === "take_over"} onChoose={() => onOverlap("take_over")} label="Enrol anyway and pause their steps in the other campaign" />
            </div>
          </div>
        </div>
      ) : null}

      {warnings.map((check) => (
        <div key={check.key} className="flex items-start gap-2 rounded-lg bg-subtle px-3 py-2">
          <TriangleAlert size={14} className="mt-px shrink-0 text-warn" aria-hidden="true" />
          <p className="min-w-0 flex-1 text-11 leading-[17px] text-ink-2"><span className="font-semibold text-ink">{check.label}:</span> {check.detail}</p>
        </div>
      ))}

      <div className="grid shrink-0 grid-cols-3 gap-3.5">
        <Card icon={ListChecks} title="Audience" action={<TextAction className="text-105" onClick={() => onEdit("list")}>Edit</TextAction>}>
          <Fact k="List" v={prelaunch.list?.name ?? "Not chosen"} />
          <Fact k="Contacts" v={audience ? formatCount(audience.enrol) : "—"} />
          <Fact k="Verified email" v={audience && audience.enrol > 0 ? `${formatCount(audience.verified_email)} · ${formatPercent(rate(audience.verified_email, audience.enrol), 0)}` : "—"} />
          <Fact k="Excluded" v={excluded ? `${excluded}${audience && audience.excluded > 0 ? ` (${formatCount(audience.excluded)})` : ""}` : "Nobody"} />
        </Card>
        <Card icon={Sparkles} title="AI context" action={<TextAction className="text-105" onClick={() => onEdit("context")}>Edit</TextAction>}>
          <Fact k="Angle" v={draft.ai.angle || "Not set"} />
          <Fact k="Tone" v={draft.ai.tone || "Not set"} />
          <Fact k="Triggers" v={draft.ai.triggers.length ? draft.ai.triggers.map((type) => TRIGGER_LABEL[type]).join(", ") : "None"} />
          <Fact k="Model" v={model ?? "Not set"} />
        </Card>
        <Card icon={Users} title="Sender accounts" action={<TextAction className="text-105" onClick={() => onEdit("senders")}>Edit</TextAction>}>
          <Fact k="LinkedIn" v={accounts.length ? `${accounts.length} · ${formatCount(capacity.invites_per_day)} invites/day` : facts.linkedin.length ? "None chosen" : "Not needed"} />
          <Fact k="Mailboxes" v={mailboxes.length ? `${mailboxes.length} · ${formatCount(capacity.emails_per_day)} sends/day` : facts.email.length ? "None chosen" : "Not needed"} />
          <Fact k="Rotation" v={accounts.length > 1 ? (draft.setup.rotation === "capacity" ? "By capacity" : "Round robin") : "One account"} />
          <Fact k="Warm-up" v={capacity.warming_up > 0 ? `${capacity.warming_up} still warming up` : "All ready"} />
        </Card>
      </div>

      <div className="grid shrink-0 grid-cols-3 gap-3.5">
        <Card icon={LinkedinIcon} title="LinkedIn steps" action={<TextAction className="text-105" onClick={() => onEdit("linkedin")}>{facts.linkedin.length} {plural(facts.linkedin.length, "step", "steps")}</TextAction>}>
          {facts.linkedin.length === 0 ? <p className="text-11 text-ink-3">None. This campaign runs on email alone.</p> : facts.linkedin.slice(0, 6).map((step, index) => <StepLine key={index} step={step} tint="bg-li-tint text-li" />)}
          {facts.linkedin.length > 6 ? <p className="text-105 text-ink-3">and {facts.linkedin.length - 6} more</p> : null}
        </Card>
        <Card icon={Mail} title="Email steps" action={<TextAction className="text-105" onClick={() => onEdit("email")}>{facts.email.length} {plural(facts.email.length, "step", "steps")}</TextAction>}>
          {facts.email.length === 0 ? <p className="text-11 text-ink-3">None. This campaign runs on LinkedIn alone.</p> : facts.email.slice(0, 6).map((step, index) => <StepLine key={index} step={step} tint="bg-mail-tint text-mail" />)}
          {facts.email.length > 6 ? <p className="text-105 text-ink-3">and {facts.email.length - 6} more</p> : null}
        </Card>
        <div className="flex flex-col gap-[7px] rounded-[9px] bg-brand-tint p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-[7px] text-12 font-semibold text-brand-strong"><Sparkles size={13} aria-hidden="true" />AI cost estimate</span>
            <span className="text-105 font-medium text-brand-strong/80">{cost.sample > 0 ? `From ${formatCount(cost.sample)} past ${plural(cost.sample, "message", "messages")}` : ""}</span>
          </div>
          {cost.ai_steps === 0 ? (
            <p className="text-11 leading-4 text-brand-strong/80">No step is written by AI, so launching this campaign costs nothing in AI.</p>
          ) : (
            <>
              <div className="flex items-baseline gap-[7px]">
                <span className="text-22 font-semibold tracking-[-0.7px] text-brand-strong">{cost.total_usd === null ? "Not known yet" : usd(cost.total_usd)}</span>
                <span className="text-11 text-brand-strong/80">for {formatCount(cost.generations)} {plural(cost.generations, "message", "messages")}</span>
              </div>
              {cost.total_usd === null ? <p className="text-105 leading-[14px] text-brand-strong/80">This workspace has not written with AI before, so there is nothing to estimate from. The first sends will show the real cost.</p> : (
                <>
                  <Fact k="Per message" v={usd(cost.per_generation_usd, 3)} tone="brand" />
                  <Fact k="Est. tokens" v={`${tokens(cost.input_tokens)} in / ${tokens(cost.output_tokens)} out`} tone="brand" />
                </>
              )}
            </>
          )}
          {cost.budget_usd !== null ? (
            <>
              <Fact k="Monthly AI budget" v={`${usd(cost.spent_this_month_usd)} / ${usd(cost.budget_usd)}`} tone="brand" />
              <Meter value={cost.spent_this_month_usd} max={cost.budget_usd} height={5} className="bg-surface" label="This month's AI spend against the budget" />
            </>
          ) : <Fact k="AI spend this month" v={usd(cost.spent_this_month_usd)} tone="brand" />}
        </div>
      </div>

    </div>
  );
}

/** The pill beside the step's heading. */
export function Readiness({ prelaunch }: { prelaunch: Prelaunch | undefined }) {
  if (!prelaunch) return null;
  const clear = clearChecks(prelaunch.checks);
  return (
    <span className={cn("inline-flex h-6 shrink-0 items-center gap-[5px] rounded-full px-2.5 text-11 font-semibold", prelaunch.ready ? "bg-good-tint text-good" : "bg-bad-tint text-bad")}>
      {prelaunch.ready ? <CircleCheck size={12} aria-hidden="true" /> : <CircleAlert size={12} aria-hidden="true" />}
      {clear} of {prelaunch.checks.length} checks clear
    </span>
  );
}

function Card({ icon: Glyph, title, action, children }: { icon: LucideIcon | typeof LinkedinIcon; title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-[9px] rounded-[9px] bg-subtle p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-[7px]">
          <span className="inline-flex size-[22px] items-center justify-center rounded-md bg-control text-ink-2"><Glyph size={12} aria-hidden="true" /></span>
          <span className="text-12 font-semibold text-ink">{title}</span>
        </span>
        {action}
      </div>
      <div className="h-px bg-line" aria-hidden="true" />
      <div className="flex flex-col gap-[7px]">{children}</div>
    </section>
  );
}

function Fact({ k, v, tone }: { k: string; v: string; tone?: "brand" }) {
  return (
    <div className="flex items-baseline justify-between gap-2.5">
      <span className={cn("shrink-0 text-11", tone === "brand" ? "text-brand-strong/80" : "text-ink-3")}>{k}</span>
      <span className={cn("min-w-0 truncate text-right text-11 font-semibold", tone === "brand" ? "text-brand-strong" : "text-ink")} title={v}>{v}</span>
    </div>
  );
}

function StepLine({ step, tint }: { step: SequenceFacts["linkedin"][number]; tint: string }) {
  const Glyph = STEP_ICON[step.type] ?? Mail;
  return (
    <div className="flex items-center gap-[7px]">
      <span className={cn("inline-flex size-[18px] shrink-0 items-center justify-center rounded-[5px]", tint)}><Glyph size={10} aria-hidden="true" /></span>
      <span className="min-w-0 flex-1 truncate text-11 font-medium text-ink">{step.label}</span>
      <span className="shrink-0 text-10 font-semibold text-ink-3">D{step.day}</span>
    </div>
  );
}

function Choice({ chosen, onChoose, label, recommended }: { chosen: boolean; onChoose: () => void; label: string; recommended?: boolean }) {
  return (
    <button type="button" role="radio" aria-checked={chosen} onClick={onChoose} className={cn("flex min-h-7 items-center gap-2 rounded-md px-[9px] py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-warn", chosen ? "bg-surface" : "bg-subtle hover:bg-surface")}>
      <span className={cn("inline-flex size-3.5 shrink-0 items-center justify-center rounded-full border bg-surface", chosen ? "border-brand" : "border-line-strong")}>{chosen ? <span className="size-2 rounded-full bg-brand" /> : null}</span>
      <span className={cn("text-115", chosen ? "font-semibold text-ink" : "font-medium text-ink-2")}>{label}</span>
      {recommended ? <span className="inline-flex h-[17px] items-center rounded-[4px] bg-good-tint px-1.5 text-10 font-semibold text-good">Recommended</span> : null}
    </button>
  );
}

/** The contacts who are in another campaign, by name, so the choice above is not made blind. */
function OverlapReview({ id, count }: { id: string; count: number }) {
  return (
    <Popover
      align="end" className="max-h-[320px] w-[360px] overflow-y-auto p-2"
      trigger={<Button size="sm" icon={ListFilter} className="shrink-0 border-transparent text-warn">Review the {formatCount(count)}</Button>}
    >
      <OverlapList id={id} />
    </Popover>
  );
}

function OverlapList({ id }: { id: string }) {
  const { data, error } = useApi<OverlapAnswer>(`/api/workflows/${id}/prelaunch`, { overlaps: "1" });
  if (error) return <p className="p-2 text-11 text-bad">The list could not be loaded.</p>;
  if (!data) return <p className="p-2 text-11 text-ink-3">Loading…</p>;
  const contacts = data.overlapping_contacts ?? [];
  if (contacts.length === 0) return <p className="p-2 text-11 text-ink-3">Nobody is in another campaign any more.</p>;
  return (
    <ul className="flex flex-col">
      {contacts.map((contact) => (
        <li key={contact.id} className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5">
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-115 font-medium text-ink">{contact.name}</span>
            {contact.company ? <span className="truncate text-105 text-ink-3">{contact.company}</span> : null}
          </span>
          <span className="max-w-[150px] shrink-0 truncate text-105 text-ink-2" title={contact.campaign}>{contact.campaign}</span>
        </li>
      ))}
    </ul>
  );
}
