import Link from "next/link";
import { useState, type ReactNode } from "react";
import {
  Banknote, Briefcase, Check, CircleAlert, CircleCheck, CircleDashed, CircleHelp, CircleX, Ellipsis, ExternalLink, Globe, Layers, MousePointerClick, Newspaper, OctagonAlert, Pause, Pencil, Plus,
  SendHorizontal, Target, Trash2, TrendingDown, TrendingUp, UserPlus, UserRoundCog, UserRoundSearch, WandSparkles, X, type LucideIcon,
} from "lucide-react";
import { Avatar, Button, Card, IconButton, Menu, MenuItem, MenuSeparator, Pill, Skeleton, TONE_SOLID, TONE_TEXT, TONE_TINT, Tooltip } from "@/components/ui";
import { cn } from "@/lib/client/cn";
import { formatCount } from "@/lib/client/format";
import { recordHref } from "@/lib/client/nav";
import { LINKEDIN_LABEL, emailState, type EmailKind } from "@/components/contacts/model";
import {
  bounceDetail, bounceTitle, departmentBars, enrichmentFields, firstOf, growthLabel, intentTone, markOf, markTone, metaLine, signalKind, signalSub, siteUrl, sourceLabel, techTone,
  type CompanyContact, type CompanyDetail, type CompanySignal, type CompanySuggestion, type SignalKind,
} from "./model";

const EMAIL_ICON: Record<EmailKind, LucideIcon> = { verified: CircleCheck, checked: CircleCheck, catchall: CircleAlert, invalid: CircleX, unverified: CircleHelp, unchecked: CircleDashed };
const SIGNAL_ICON: Record<SignalKind, LucideIcon> = { hiring: Briefcase, funding: Banknote, job_change: UserRoundCog, technology: Layers, product_intent: MousePointerClick, custom: Newspaper };

/** A company's initials on its own tint, where a logo would go. */
export function CompanyMark({ name, size }: { name: string; size: 30 | 44 }) {
  return (
    <span aria-hidden="true" className={cn("inline-flex shrink-0 select-none items-center justify-center font-bold", size === 44 ? "size-11 rounded-[10px] text-15" : "size-[30px] rounded-md text-11", TONE_TINT[markTone(name)])}>
      {markOf(name)}
    </span>
  );
}

export interface DetailActions {
  onReviewBounces: () => void;
  onReverify: () => void;
  onEnrich: () => void;
  onAddToCampaign: () => void;
  onToggleTarget: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onAddContact: () => void;
  onFindPeople: () => void;
  onAddPeople: (people: CompanySuggestion[]) => void;
  onDismissPerson: (person: CompanySuggestion) => void;
  onHandleSignals: (ids: string[] | null) => void;
}

/** Everything about one company, to the right of the list. */
export function CompanyDetailPane({ detail, canEdit, busy, signalsHref, actions }: { detail: CompanyDetail; canEdit: boolean; busy: string | null; signalsHref: string; actions: DetailActions }) {
  const { company } = detail;
  return (
    <>
      {detail.bounce ? (
        <div role="alert" className="flex shrink-0 items-center gap-2.5 rounded-[10px] bg-bad-tint p-3">
          <OctagonAlert size={16} className="shrink-0 text-bad" aria-hidden="true" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <p className="text-12 font-semibold leading-4 text-ink">{bounceTitle(company.domain)}</p>
            <p className="text-11 leading-[15px] text-ink-2">{bounceDetail(detail.bounce)}</p>
          </div>
          <div className="flex shrink-0 items-center gap-[7px]">
            <Button className="h-7 px-2.5 text-115 font-semibold" onClick={actions.onReviewBounces}>Review bounces</Button>
            {canEdit ? <Button variant="primary" className="h-7 bg-bad px-2.5 text-115 hover:bg-bad/90" loading={busy === "reverify"} onClick={actions.onReverify}>Re-verify emails</Button> : null}
          </div>
        </div>
      ) : null}

      <Header detail={detail} canEdit={canEdit} actions={actions} />

      <div className="flex shrink-0 flex-col gap-3.5 min-[1280px]:flex-row min-[1280px]:items-start">
        <EnrichmentCard company={company} />
        <HeadcountCard company={company} />
      </div>
      <div className="flex shrink-0 flex-col gap-3.5 min-[1280px]:flex-row min-[1280px]:items-start">
        <ChipCard title="Tech stack" aside={company.technologies.length > 0 ? `${formatCount(company.technologies.length)} detected` : null} items={company.technologies} shown={9} kind="tech" className="min-w-0 flex-1" empty="No technologies on record. A look-up on Apollo brings them." />
        <ChipCard title="Keywords" aside={null} items={company.keywords} shown={7} kind="keyword" className="min-[1280px]:w-[288px] min-[1280px]:shrink-0" empty="No keywords on record." />
      </div>
      <div className="flex flex-col gap-3.5 min-[1280px]:flex-row min-[1280px]:items-start">
        <ContactsCard detail={detail} canEdit={canEdit} busy={busy} actions={actions} />
        <SignalsCard detail={detail} canEdit={canEdit} busy={busy} signalsHref={signalsHref} actions={actions} />
      </div>
    </>
  );
}

function Header({ detail, canEdit, actions }: { detail: CompanyDetail; canEdit: boolean; actions: DetailActions }) {
  const { company } = detail;
  const site = siteUrl(company);
  return (
    // The name and the actions share the first row; the pills, the domain and the counts have
    // the full width of the second, so nothing is cut short beside four buttons.
    <Card className="grid shrink-0 grid-cols-[44px_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 p-[13px] shadow-none sm:grid-cols-[44px_minmax(0,1fr)_auto]">
      <span className="row-span-2 self-start"><CompanyMark name={company.name} size={44} /></span>
      <h2 className="min-w-0 truncate text-[17px] font-semibold tracking-[-0.25px] text-ink" title={company.name}>{company.name}</h2>
      <div className="col-span-2 flex flex-wrap items-center gap-[7px] sm:col-span-1 sm:col-start-3 sm:row-start-1 sm:justify-end">
        {site ? <Button asChild><a href={site} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} className="text-ink-2" aria-hidden="true" />Visit site</a></Button> : null}
        {canEdit ? <Button icon={WandSparkles} onClick={actions.onEnrich}>Re-enrich</Button> : null}
        {canEdit ? <Button variant="primary" icon={SendHorizontal} disabled={detail.contacts.total === 0} onClick={actions.onAddToCampaign}>Add to campaign</Button> : null}
        {canEdit || company.linkedin_url ? (
          <Menu width={216} trigger={<IconButton icon={Ellipsis} label={`More actions for ${company.name}`} variant="outline" />}>
            {company.linkedin_url ? <MenuItem icon={ExternalLink} onSelect={() => window.open(company.linkedin_url!, "_blank", "noopener,noreferrer")}>Open on LinkedIn</MenuItem> : null}
            {canEdit ? (
              <>
                <MenuItem icon={Target} onSelect={actions.onToggleTarget}>{company.is_target ? "Remove the target mark" : "Mark as target account"}</MenuItem>
                <MenuItem icon={Pencil} onSelect={actions.onEdit}>Edit company</MenuItem>
                <MenuSeparator />
                <MenuItem icon={Trash2} tone="danger" onSelect={actions.onDelete}>Delete company</MenuItem>
              </>
            ) : null}
          </Menu>
        ) : null}
      </div>
      <div className="col-start-2 flex min-w-0 flex-wrap items-center gap-x-[7px] gap-y-1 text-115 sm:col-span-2">
        {company.is_target ? <Pill tone="brand" icon={Target}>Target account</Pill> : null}
        {company.bouncing ? <Pill tone="bad" icon={Pause}>Email paused</Pill> : null}
        {company.domain ? (
          <>
            <Globe size={12} className="shrink-0 text-ink-3" aria-hidden="true" />
            {site ? <a href={site} target="_blank" rel="noopener noreferrer" className="font-medium text-brand-strong hover:underline">{company.domain}</a> : <span className="font-medium text-ink-2">{company.domain}</span>}
            <span className="text-ink-3" aria-hidden="true">·</span>
          </>
        ) : null}
        <span className="text-ink-3">{metaLine(detail)}</span>
      </div>
    </Card>
  );
}

function CardTitle({ title, aside }: { title: string; aside?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h3 className="text-13 font-semibold tracking-snug text-ink">{title}</h3>
      {aside}
    </div>
  );
}

function EnrichmentCard({ company }: { company: CompanyDetail["company"] }) {
  const columns = enrichmentFields(company);
  return (
    <Card className="flex min-w-0 flex-1 flex-col gap-[11px] p-3.5 shadow-none">
      <CardTitle title="Enrichment" aside={<span className={cn("text-11 font-semibold", company.enrichment_source ? "text-brand-strong" : "text-ink-3")}>{sourceLabel(company)}</span>} />
      {company.description ? <p className="text-11 leading-4 text-ink-2">{company.description}</p> : null}
      <div className="grid grid-cols-1 gap-x-3.5 gap-y-[7px] sm:grid-cols-2">
        {columns.map((column, index) => (
          <dl key={index} className="flex flex-col gap-[7px]">
            {column.map((field) => (
              <div key={field.key} className="flex h-[17px] items-center justify-between gap-3">
                <dt className="shrink-0 text-11 text-ink-3">{field.key}</dt>
                <dd className={cn("min-w-0 truncate text-right text-11 font-medium", field.value === "—" ? "text-ink-3" : "text-ink-2")} title={field.value === "—" ? undefined : field.value}>{field.value}</dd>
              </div>
            ))}
          </dl>
        ))}
      </div>
      {company.notes ? <p className="whitespace-pre-wrap border-t border-line pt-2.5 text-11 leading-4 text-ink-2"><span className="font-semibold text-ink-3">Notes · </span>{company.notes}</p> : null}
    </Card>
  );
}

function HeadcountCard({ company }: { company: CompanyDetail["company"] }) {
  const growth = growthLabel(company.headcount_growth);
  const bars = departmentBars(company.departments);
  return (
    <Card className="flex flex-col gap-[11px] p-3.5 shadow-none min-[1280px]:w-[288px] min-[1280px]:shrink-0">
      <CardTitle title="Headcount" aside={growth ? <Pill size="sm" tone={growth.tone} icon={growth.tone === "warn" ? TrendingDown : growth.tone === "good" ? TrendingUp : undefined} className="h-[19px] text-10">{growth.label}</Pill> : null} />
      {bars.length === 0 ? (
        <p className="text-11 leading-4 text-ink-3">{company.employee_count ? `${formatCount(company.employee_count)} people in all. ` : ""}No figures by department yet. A look-up on Apollo brings them.</p>
      ) : (
        bars.map((bar) => (
          <div key={bar.label} className="flex items-center gap-2">
            <span className="w-[88px] shrink-0 truncate text-11 text-ink-2" title={bar.label}>{bar.label}</span>
            <span className="h-[7px] min-w-0 flex-1 overflow-hidden rounded-full bg-control" aria-hidden="true">
              <span style={{ width: `${Math.max(3, bar.share * 100)}%` }} className={cn("block h-full rounded-full", bar.highlight ? "bg-brand" : "bg-ink-3")} />
            </span>
            <span className="w-[34px] shrink-0 text-right text-11 font-semibold tabular-nums text-ink">{formatCount(bar.count)}</span>
          </div>
        ))
      )}
    </Card>
  );
}

function ChipCard({ title, aside, items, shown, kind, empty, className }: { title: string; aside: string | null; items: string[]; shown: number; kind: "tech" | "keyword"; empty: string; className?: string }) {
  const [all, setAll] = useState(false);
  const cut = firstOf(items, shown);
  const visible = all ? items : cut.shown;
  return (
    <Card className={cn("flex flex-col gap-2.5 p-3.5 shadow-none", className)}>
      <CardTitle title={title} aside={aside ? <span className="text-11 font-semibold text-brand-strong">{aside}</span> : null} />
      {items.length === 0 ? <p className="text-11 leading-4 text-ink-3">{empty}</p> : (
        <ul className="flex flex-wrap items-center gap-1.5">
          {visible.map((item) => (
            <li key={item} className={kind === "tech" ? "inline-flex h-[25px] items-center gap-1.5 rounded-md border border-line bg-subtle px-2 text-11 font-medium text-ink-2" : "inline-flex h-[23px] items-center rounded-md bg-brand-tint px-2 text-105 font-medium text-brand-strong"}>
              {kind === "tech" ? <span className={cn("size-[7px] shrink-0 rounded-full", TONE_SOLID[techTone(item)])} aria-hidden="true" /> : null}
              {item}
            </li>
          ))}
          {cut.more > 0 ? (
            <li>
              <button type="button" onClick={() => setAll((value) => !value)} aria-expanded={all} className={cn("px-1 font-semibold hover:underline", kind === "tech" ? "text-11 text-brand-strong" : "text-105 text-ink-3")}>
                {all ? "Show fewer" : kind === "tech" ? `+${cut.more} more` : `+${cut.more}`}
              </button>
            </li>
          ) : null}
        </ul>
      )}
    </Card>
  );
}

function ContactRow({ contact }: { contact: CompanyContact }) {
  const state = contact.email ? emailState(contact.email_status) : null;
  const Glyph = state ? EMAIL_ICON[state.kind] : null;
  const linkedin = LINKEDIN_LABEL[contact.linkedin_status];
  const tone = intentTone(contact.intent_score);
  return (
    <li className="border-b border-line last:border-b-0">
      <Link href={recordHref("contact", contact.id)} className="flex h-[49.5px] items-center gap-[9px] px-3.5 hover:bg-subtle focus-visible:bg-subtle">
        <Avatar name={contact.full_name} size={26} />
        <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="truncate text-12 font-semibold tracking-[-0.1px] text-ink">{contact.full_name ?? "Unnamed contact"}</span>
            {contact.title ? <span className="truncate text-105 text-ink-3">{contact.title}</span> : null}
          </span>
          <span className="flex min-w-0 items-center gap-[7px] text-105">
            {state && Glyph ? (
              <>
                <Tooltip label={state.title}><span className={cn("inline-flex shrink-0", state.tone === "neutral" ? "text-ink-3" : TONE_TEXT[state.tone])}><Glyph size={11} aria-label={state.title} /></span></Tooltip>
                <span className={cn("truncate", state.kind === "invalid" ? "text-ink-3 line-through" : "text-ink-3")}>{contact.email}</span>
                <span className="h-[9px] w-px shrink-0 bg-line-strong" aria-hidden="true" />
              </>
            ) : null}
            <span className={cn("size-1.5 shrink-0 rounded-full", TONE_SOLID[linkedin.tone])} aria-hidden="true" />
            <span className="shrink-0 text-ink-2">{linkedin.label}</span>
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5" title={`Intent ${contact.intent_score}`}>
          <span className={cn("text-115 font-semibold tabular-nums", tone === "neutral" ? "text-ink-2" : TONE_TEXT[tone])}>{contact.intent_score}</span>
          <span className="h-1 w-[30px] overflow-hidden rounded-full bg-control" aria-hidden="true">
            <span style={{ width: `${Math.max(4, Math.min(100, contact.intent_score))}%` }} className={cn("block h-full rounded-full", TONE_SOLID[tone])} />
          </span>
        </span>
      </Link>
    </li>
  );
}

/** Contacts shown before "Show all": enough to see who matters, with the suggestions still in view. */
const CONTACTS_SHOWN = 6;

function ContactsCard({ detail, canEdit, busy, actions }: { detail: CompanyDetail; canEdit: boolean; busy: string | null; actions: DetailActions }) {
  const { contacts, suggestions, company } = detail;
  const [all, setAll] = useState(false);
  const visible = all ? contacts.items : contacts.items.slice(0, CONTACTS_SHOWN);
  return (
    <Card className="flex min-w-0 flex-1 flex-col overflow-hidden shadow-none">
      <div className="flex h-[41.5px] shrink-0 items-center justify-between gap-3 border-b border-line px-3.5">
        <div className="flex items-center gap-[7px]">
          <h3 className="text-13 font-semibold tracking-snug text-ink">Linked contacts</h3>
          <Pill size="sm" className="h-[18px] text-10">{formatCount(contacts.total)}</Pill>
        </div>
        {canEdit ? <Button size="sm" icon={UserPlus} className="text-11" onClick={actions.onAddContact}>Add contact</Button> : null}
      </div>
      {contacts.items.length === 0 ? (
        <p className="px-3.5 py-5 text-115 leading-[17px] text-ink-3">Nobody at {company.name} is a contact yet.</p>
      ) : (
        <ul className="flex flex-col">{visible.map((contact) => <ContactRow key={contact.id} contact={contact} />)}</ul>
      )}
      {contacts.items.length > CONTACTS_SHOWN ? (
        <button type="button" onClick={() => setAll((value) => !value)} aria-expanded={all} className="border-t border-line px-3.5 py-2 text-left text-11 font-semibold text-brand-strong hover:bg-subtle">
          {all ? "Show fewer" : `Show all ${formatCount(contacts.items.length)}${contacts.total > contacts.items.length ? ` of ${formatCount(contacts.total)}` : ""}`}
        </button>
      ) : null}
      {all && contacts.total > contacts.items.length ? (
        <p className="border-t border-line px-3.5 py-2 text-11 text-ink-3">
          These are the {formatCount(contacts.items.length)} with the highest intent. <Link href={`/contacts?q=${encodeURIComponent(company.name)}`} className="font-semibold text-brand-strong hover:underline">Open them all in Contacts</Link>
        </p>
      ) : null}

      <div className="flex flex-col gap-2 border-t border-line bg-subtle px-3.5 py-2.5">
        <div className="flex items-center justify-between gap-3">
          <h4 className="text-10 font-semibold uppercase tracking-[0.5px] text-ink-3">Suggested from enrichment</h4>
          {canEdit && suggestions.length > 1 ? <button type="button" onClick={() => actions.onAddPeople(suggestions)} className="text-11 font-semibold text-brand-strong hover:underline">Add all</button> : null}
        </div>
        {suggestions.length === 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="min-w-0 flex-1 text-11 leading-4 text-ink-3">
              {detail.suggestions_searched_at ? "Nobody is waiting here. Everyone Apollo named last time was added or put aside." : "Apollo can name senior people at this company who are not contacts yet."}
            </p>
            {canEdit ? <Button size="xs" icon={UserRoundSearch} onClick={actions.onFindPeople}>{detail.suggestions_searched_at ? "Ask Apollo again" : "Find people on Apollo"}</Button> : null}
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {suggestions.map((person) => (
              <li key={person.id} className="flex items-center gap-[9px]">
                <Avatar name={person.name} size={22} tint="bg-control" className="text-ink-2" />
                <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                  <span className="truncate text-115 font-semibold text-ink">{person.name}</span>
                  {person.title ? <span className="truncate text-105 text-ink-3">{person.title}</span> : null}
                </span>
                {canEdit ? (
                  <>
                    <Button size="xs" icon={Plus} className="font-semibold" onClick={() => actions.onAddPeople([person])}>Add</Button>
                    <IconButton icon={X} size={24} label={`Put ${person.name} aside`} disabled={busy === `dismiss:${person.id}`} onClick={() => actions.onDismissPerson(person)} />
                  </>
                ) : null}
              </li>
            ))}
            {canEdit ? <li><button type="button" onClick={actions.onFindPeople} className="text-11 font-semibold text-ink-3 hover:text-ink-2 hover:underline">Ask Apollo for more</button></li> : null}
          </ul>
        )}
      </div>
    </Card>
  );
}

function SignalRow({ signal, canEdit, busy, onHandle }: { signal: CompanySignal; canEdit: boolean; busy: boolean; onHandle: () => void }) {
  const Glyph = SIGNAL_ICON[signalKind(signal.type)];
  return (
    <li className="group flex items-start gap-[9px]">
      <span className={cn("inline-flex size-6 shrink-0 items-center justify-center rounded-md", signal.handled ? "bg-subtle text-ink-3" : "bg-brand-tint text-brand-strong")}><Glyph size={13} aria-hidden="true" /></span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-115 font-medium leading-[15px] text-ink">{signal.title}{signal.handled ? null : <span className="sr-only"> (new)</span>}</span>
        <span className="text-105 leading-[14px] text-ink-3">{signalSub(signal)}</span>
      </span>
      {canEdit && !signal.handled ? <IconButton icon={Check} size={22} label={`Mark "${signal.title}" as handled`} disabled={busy} onClick={onHandle} /> : null}
    </li>
  );
}

function SignalsCard({ detail, canEdit, busy, signalsHref, actions }: { detail: CompanyDetail; canEdit: boolean; busy: string | null; signalsHref: string; actions: DetailActions }) {
  const { signals } = detail;
  return (
    <Card className="flex flex-col gap-2.5 p-3.5 shadow-none min-[1280px]:w-[288px] min-[1280px]:shrink-0">
      <CardTitle
        title="Account signals"
        aside={
          <span className="flex items-center gap-2.5">
            {signals.new > 0 ? <Pill size="sm" tone="brand">{formatCount(signals.new)} new</Pill> : null}
            <Link href={signalsHref} className="text-11 font-semibold text-brand-strong hover:underline">All</Link>
          </span>
        }
      />
      {signals.items.length === 0 ? <p className="text-11 leading-4 text-ink-3">No signal is recorded for this account yet.</p> : (
        <ul className="flex flex-col gap-2.5">
          {signals.items.map((signal) => <SignalRow key={signal.id} signal={signal} canEdit={canEdit} busy={busy === "signals"} onHandle={() => actions.onHandleSignals([signal.id])} />)}
        </ul>
      )}
      {signals.total > signals.items.length ? <p className="text-105 text-ink-3">The latest {signals.items.length} of {formatCount(signals.total)}.</p> : null}
      {canEdit && signals.new > 0 ? <Button size="xs" icon={Check} className="self-start" loading={busy === "signals"} onClick={() => actions.onHandleSignals(null)}>Mark all as handled</Button> : null}
    </Card>
  );
}

export function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-3.5" aria-busy="true" aria-label="Loading the company">
      <Skeleton className="h-[70px] rounded-lg" />
      <div className="flex gap-3.5"><Skeleton className="h-[170px] flex-1 rounded-lg" /><Skeleton className="h-[170px] w-[288px] rounded-lg" /></div>
      <div className="flex gap-3.5"><Skeleton className="h-[110px] flex-1 rounded-lg" /><Skeleton className="h-[110px] w-[288px] rounded-lg" /></div>
      <div className="flex gap-3.5"><Skeleton className="h-[280px] flex-1 rounded-lg" /><Skeleton className="h-[280px] w-[288px] rounded-lg" /></div>
    </div>
  );
}
