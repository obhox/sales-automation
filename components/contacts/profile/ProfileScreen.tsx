import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/router";
import { useTranslations } from "next-intl";
import { CalendarDays, CheckCheck, ChevronDown, ChevronUp, Ellipsis, ExternalLink, Link2, ListPlus, Mail, NotebookPen, Plus, RefreshCw, SendHorizontal, Tag, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Page, useShell } from "@/components/shell";
import { Button, Card, EmptyState, ErrorState, IconButton, LinkedinIcon, Menu, MenuItem, MenuSeparator, OptionPicker, Pill, Skeleton, confirm, initialsOf } from "@/components/ui";
import { ApiError, api, errorMessage } from "@/lib/client/api";
import { useApi } from "@/lib/client/data";
import { recordHref } from "@/lib/client/nav";
import { useCan } from "@/lib/client/roles";
import { AddToCampaignDialog, AddToListDialog, TagDialog } from "../ContactDialogs";
import { CustomFieldsDialog, ManageTagsDialog } from "../ManageDialogs";
import { useListContext } from "../browser";
import { CONTACTS_PATH, intentTone, tagTone, type ContactFacets } from "../model";
import { CampaignHistoryCard, CareerCard, CompanyCard, CustomFieldsCard, DetailsCard, ListsCard, TasksCard } from "./ProfileCards";
import { ActivityDialog, BookingLinkDialog, EditDetailsDialog, EmailDialog, LinkedinMessageDialog, TaskDialog, type ActivityDraft } from "./ProfileDialogs";
import { TimelineCard } from "./TimelineCard";
import {
  ACTIVITY_PATH, TASKS_PATH, TIMELINE_PAGE, campaignBadge, emailBadge, linkedinBadge, localTimeLine, profilePath, replyBadge,
  type ContactProfile, type Neighbours, type Timeline, type TimelineChannel, type TimelineItem,
} from "./model";

type Task = ContactProfile["tasks"][number];

/** Audience → Contacts → one contact. The id comes from the address; each contact gets a fresh screen. */
export function ContactProfileScreen() {
  const t = useTranslations("ContactProfile");
  const router = useRouter();
  const id = typeof router.query.id === "string" ? router.query.id : null;
  if (!id) return <Page title={t("contact")} crumbs={[{ label: t("contacts"), href: "/contacts" }]}><LoadingLayout /></Page>;
  return <Profile key={id} id={id} />;
}

function Profile({ id }: { id: string }) {
  const t = useTranslations("ContactProfile");
  const router = useRouter();
  const can = { member: useCan("member"), manager: useCan("manager"), admin: useCan("admin") };
  const { data: shell } = useShell();
  const crm = shell?.capabilities?.crm !== false;
  const context = useListContext();
  const backHref = context?.href ?? "/contacts";

  const profileRequest = useApi<ContactProfile>(profilePath(id), { view: "profile" });
  const profile = profileRequest.data;
  const facetsRequest = useApi<ContactFacets>(CONTACTS_PATH, { view: "facets" });
  const facets = facetsRequest.data;
  const [channel, setChannel] = useState<TimelineChannel>("all");
  const [limit, setLimit] = useState(TIMELINE_PAGE);
  const timelineRequest = useApi<Timeline>(profilePath(id), { view: "timeline", channel, limit });
  const neighboursRequest = useApi<{ neighbours: Neighbours | null }>(context ? CONTACTS_PATH : null, { view: "neighbours", id, ...(context?.query ?? {}) });
  const neighbours = neighboursRequest.data?.neighbours ?? null;

  const refresh = () => Promise.all([profileRequest.mutate(), timelineRequest.mutate()]);
  const refreshAll = () => { void refresh(); void facetsRequest.mutate(); };

  const [editing, setEditing] = useState(false);
  const [listing, setListing] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [tagging, setTagging] = useState(false);
  const [managingTags, setManagingTags] = useState(false);
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const [activity, setActivity] = useState<ActivityDraft | null>(null);
  const [task, setTask] = useState<{ task: Task | null } | null>(null);
  const [messaging, setMessaging] = useState(false);
  const [emailing, setEmailing] = useState(false);
  const [bookingOpen, setBookingOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const crumbs = [{ label: t("contacts"), href: backHref }];
  if (profileRequest.error && !profile) {
    const missing = profileRequest.error instanceof ApiError && profileRequest.error.status === 404;
    return (
      <Page title={t("contact")} crumbs={crumbs}>
        {missing
          ? <Card><EmptyState title={t("missing")} action={<Button asChild><Link href={backHref}>{t("backToContacts")}</Link></Button>}>{t("missingBody")}</EmptyState></Card>
          : <Card><ErrorState message={errorMessage(profileRequest.error)} onRetry={() => void profileRequest.mutate()} /></Card>}
      </Page>
    );
  }
  if (!profile) return <Page title={t("contact")} crumbs={crumbs}><LoadingLayout /></Page>;

  const { contact } = profile;
  const name = contact.full_name?.trim() || t("unnamed");

  /** Run one request, say what happened, and read the profile again. */
  async function run(key: string, work: () => Promise<string | void>) {
    setBusy(key);
    try {
      const message = await work();
      if (message) toast.success(message);
      refreshAll();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  const setOwner = (ownerId: string) => run("owner", async () => {
    await api(profilePath(id), { method: "PATCH", body: { owner_id: ownerId === "none" ? null : ownerId } });
    return ownerId === "none" ? t("noOwnerConfirmation", {name}) : t("ownerConfirmation", {name, owner: facets?.members.find((member) => member.id === ownerId)?.name ?? t("unknownOwner")});
  });

  async function markReplied(channelName: "linkedin" | "email") {
    const where = channelName === "linkedin" ? t("replyLinkedinWhere") : t("replyEmailWhere");
    const ok = await confirm({
      title: t("replyTitle", {name, where}),
      body: t("replyBody"),
      confirmLabel: t("markReplied"),
    });
    if (!ok) return;
    await run("replied", async () => {
      await api(`${profilePath(id)}/mark-replied`, { method: "POST", body: { channel: channelName } });
      return t("replyConfirmed", {name, where});
    });
  }

  async function refreshFromLinkedin() {
    const ok = await confirm({
      title: t("refreshTitle", {name}),
      body: t("refreshBody"),
      confirmLabel: t("refreshProfile"),
    });
    if (!ok) return;
    await run("scrape", async () => {
      const result = await api<{ profile: { positions: unknown[]; recent_posts: unknown[] } }>(`${profilePath(id)}/profile-scrape`, { method: "POST", body: {} });
      return t("profileRead", {roles: result.profile.positions.length, posts: result.profile.recent_posts.length});
    });
  }

  async function remove() {
    const ok = await confirm({
      title: t("deleteContactTitle", {name}),
      body: t("deleteContactBody"),
      confirmLabel: t("deleteContact"), tone: "danger",
    });
    if (!ok) return;
    try {
      await api(profilePath(id), { method: "DELETE" });
      toast.success(t("deletedToast", {name}));
      void router.push(backHref);
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  }

  const removeFromList = (list: { id: string; name: string }) => run("list", async () => {
    await api(`/api/lists/${list.id}/remove-members`, { method: "POST", body: { contact_ids: [id], dry_run: false } });
    return t("removedFromList", {name: list.name});
  });

  const toggleTask = (item: Task) => run("task", async () => {
    await api(`${TASKS_PATH}/${item.id}`, { method: "PATCH", body: { status: item.status === "open" ? "done" : "open" } });
  });

  async function deleteActivity(item: TimelineItem) {
    const ok = await confirm({ title: t("deleteEntry"), body: t("deleteEntryBody"), confirmLabel: t("delete"), tone: "danger" });
    if (!ok || !item.activity_id) return;
    await run("activity", async () => {
      await api(ACTIVITY_PATH, { method: "DELETE", query: { id: item.activity_id! } });
      return t("entryDeleted");
    });
  }

  function bookMeeting() {
    if (profile?.booking_url) return void window.open(profile.booking_url, "_blank", "noopener,noreferrer");
    if (can.admin) return setBookingOpen(true);
    toast.message(t("missingBooking"), { description: t("missingBookingHelp") });
  }

  const step = (target: string | null) => { if (target) void router.push(`/contacts/${target}`); };
  const reply = replyBadge(contact.reply);
  const inCampaign = campaignBadge(profile.campaigns);
  const email = emailBadge(contact);
  const linkedin = linkedinBadge(contact);
  const localTime = localTimeLine(contact.time_zone);
  const ownerOptions = [{ value: "none", label: t("noOwner") }, ...(facets?.members ?? []).map((member, index) => ({ value: member.id, label: member.name, separated: index === 0 }))];
  const ownerPill = <Pill size="sm" className="h-[19px]">{contact.owner ? t("ownerPill", {name: contact.owner.name}) : t("noOwner")}</Pill>;

  return (
    <Page
      title={name}
      crumbs={crumbs}
      actions={
        <>
          {neighbours ? (
            <>
              <div className="inline-flex h-8 items-stretch overflow-hidden rounded-md border border-line-strong bg-surface" role="group" aria-label={t("moveList")}>
                <button type="button" aria-label={t("previous")} disabled={!neighbours.previous} onClick={() => step(neighbours.previous)} className="inline-flex w-[30px] items-center justify-center border-r border-line-strong text-ink-2 hover:bg-subtle disabled:opacity-40 disabled:hover:bg-surface">
                  <ChevronUp size={14} aria-hidden="true" />
                </button>
                <button type="button" aria-label={t("next")} disabled={!neighbours.next} onClick={() => step(neighbours.next)} className="inline-flex w-[30px] items-center justify-center text-ink-2 hover:bg-subtle disabled:opacity-40 disabled:hover:bg-surface">
                  <ChevronDown size={14} aria-hidden="true" />
                </button>
              </div>
              <span className="text-11 tabular-nums text-ink-3">{t("progressOf", {position: neighbours.position, total: neighbours.total})}</span>
              <span className="mx-0.5 h-5 w-px bg-line" aria-hidden="true" />
            </>
          ) : null}
          {can.member ? <Button icon={ListPlus} onClick={() => setListing(true)}>{t("addToList")}</Button> : null}
          {can.member && crm ? <Button icon={NotebookPen} onClick={() => setActivity({ id: null, type: "note", body: "" })}>{t("logActivity")}</Button> : null}
          {can.manager ? <Button variant="primary" icon={SendHorizontal} onClick={() => setEnrolling(true)}>{t("addToCampaign")}</Button> : null}
          <Menu width={232} trigger={<IconButton icon={Ellipsis} label={t("moreActions")} variant="outline" />}>
            {contact.linkedin_url ? <MenuItem icon={ExternalLink} onSelect={() => window.open(contact.linkedin_url!, "_blank", "noopener,noreferrer")}>{t("openLinkedin")}</MenuItem> : null}
            {can.member ? (
              <>
                <MenuItem icon={Tag} onSelect={() => setTagging(true)}>{t("tag")}</MenuItem>
                <MenuSeparator />
                <MenuItem icon={CheckCheck} disabled={busy === "replied"} onSelect={() => void markReplied("linkedin")}>{t("markLinkedin")}</MenuItem>
                <MenuItem icon={CheckCheck} disabled={busy === "replied"} onSelect={() => void markReplied("email")}>{t("markEmail")}</MenuItem>
                <MenuItem icon={RefreshCw} disabled={!contact.sales_nav_url || busy === "scrape"} onSelect={() => void refreshFromLinkedin()}>
                  {contact.sales_nav_url ? t("refreshLinkedin") : t("noSalesNav")}
                </MenuItem>
              </>
            ) : null}
            {can.admin ? <MenuItem icon={Link2} onSelect={() => setBookingOpen(true)}>{t("bookingLink")}</MenuItem> : null}
            {can.member ? (
              <>
                <MenuSeparator />
                <MenuItem icon={Trash2} tone="danger" onSelect={() => void remove()}>{t("deleteContactMenu")}</MenuItem>
              </>
            ) : null}
          </Menu>
          <span className="mx-0.5 h-5 w-px bg-line" aria-hidden="true" />
        </>
      }
    >
      {/* Who this is, where they stand, and the three ways to reach them */}
      <Card className="flex flex-wrap items-center justify-between gap-3.5 p-3.5">
        <div className="flex min-w-0 items-center gap-[13px]">
          <span className="inline-flex size-[52px] shrink-0 select-none items-center justify-center rounded-full bg-li-tint text-18 font-semibold text-li" aria-hidden="true">{initialsOf(contact.full_name)}</span>
          <div className="flex min-w-0 flex-col gap-[5px]">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[19px] font-semibold tracking-[-0.3px] text-ink">{name}</span>
              {reply ? <Pill tone={reply.tone}>{reply.label}</Pill> : null}
              {inCampaign ? <Pill tone={inCampaign.tone}>{inCampaign.label}</Pill> : null}
              <Pill tone={intentTone(contact.intent_score)}>{t("intentLabel", {score: contact.intent_score})}</Pill>
              {contact.unsubscribed_at ? <Pill tone="bad">{t("unsubscribed")}</Pill> : null}
            </div>
            <div className="flex flex-wrap items-center gap-x-[7px] gap-y-0.5 text-12">
              {contact.title ? <span className="font-medium text-ink-2">{contact.title}</span> : null}
              {contact.title && contact.company ? <span className="text-ink-3" aria-hidden="true">·</span> : null}
              {contact.company ? (
                profile.company ? <Link href={recordHref("company", profile.company.id)} className="font-medium text-brand-strong hover:underline">{contact.company}</Link> : <span className="font-medium text-ink-2">{contact.company}</span>
              ) : null}
              {contact.location || localTime ? <span className="text-ink-3" aria-hidden="true">·</span> : null}
              <span className="text-115 text-ink-3">{[contact.location, localTime].filter(Boolean).join(" · ")}</span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Pill size="sm" tone={email.tone} icon={Mail} className="h-[19px]">{email.label}</Pill>
              <Pill size="sm" tone={linkedin.tone} icon={LinkedinIcon} className="h-[19px]">{linkedin.label}</Pill>
              {can.member ? (
                <OptionPicker
                  label={t("ownerLabel")} value={contact.owner?.id ?? "none"} onChange={(next) => void setOwner(next)} options={ownerOptions} searchPlaceholder={t("findMember")}
                  trigger={<button type="button" className="rounded-full hover:opacity-80" aria-label={contact.owner ? t("ownerAria", {name: contact.owner.name}) : t("ownerAriaNone")}>{ownerPill}</button>}
                />
              ) : ownerPill}
              {contact.tags.map((tag) => <Pill key={tag.id} size="sm" tone={tagTone(tag.color)} className="h-[19px]">{tag.name}</Pill>)}
              {can.member ? (
                <button type="button" onClick={() => setTagging(true)} className="inline-flex h-[19px] items-center gap-1 rounded-full border border-dashed border-line-strong px-2 text-10 font-semibold text-ink-3 hover:border-ink-3 hover:text-ink">
                  <Plus size={10} aria-hidden="true" />
                  Tag
                </button>
              ) : null}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-[7px]">
          {can.member ? <Button icon={Mail} disabled={!contact.email} onClick={() => setEmailing(true)}>{t("email")}</Button> : null}
          {can.member ? <Button icon={LinkedinIcon} disabled={!contact.linkedin_url} onClick={() => setMessaging(true)}>{t("linkedinMessage")}</Button> : null}
          <Button icon={CalendarDays} onClick={bookMeeting}>{t("bookMeeting")}</Button>
        </div>
      </Card>

      <div className="flex flex-col gap-3.5 xl:grid xl:grid-cols-[300px_minmax(0,1fr)_330px] xl:items-start">
        <div className="flex flex-col gap-3.5">
          <DetailsCard contact={contact} canEdit={can.member} onEdit={() => setEditing(true)} onSaved={() => profileRequest.mutate()} />
          <CompanyCard profile={profile} />
          <CareerCard contact={contact} />
        </div>
        <TimelineCard
          timeline={timelineRequest.data} error={timelineRequest.error ? errorMessage(timelineRequest.error) : null} channel={channel} canEdit={can.member}
          onChannel={(next) => { setChannel(next); setLimit(TIMELINE_PAGE); }} onMore={() => setLimit((current) => current + TIMELINE_PAGE)} onRetry={() => void timelineRequest.mutate()}
          onEditActivity={(item) => setActivity({ id: item.activity_id, type: item.label ?? "note", body: item.detail ?? "" })} onDeleteActivity={(item) => void deleteActivity(item)}
        />
        <div className="flex flex-col gap-3.5">
          <CampaignHistoryCard campaigns={profile.campaigns} />
          <ListsCard lists={profile.lists} canEdit={can.member} onAdd={() => setListing(true)} onRemove={(list) => void removeFromList(list)} />
          <CustomFieldsCard profile={profile} canEdit={can.member} onManage={() => setFieldsOpen(true)} onSaved={() => profileRequest.mutate()} />
          {crm ? <TasksCard tasks={profile.tasks} canEdit={can.member} onAdd={() => setTask({ task: null })} onOpen={(item) => setTask({ task: item })} onToggle={(item) => void toggleTask(item)} /> : null}
        </div>
      </div>

      <EditDetailsDialog contact={contact} open={editing} onClose={() => setEditing(false)} onSaved={() => void refresh()} />
      <AddToListDialog ids={listing ? [id] : null} lists={(facets?.lists ?? []).filter((list) => !profile.lists.some((member) => member.id === list.id))} onClose={() => setListing(false)} onDone={refreshAll} />
      <AddToCampaignDialog ids={enrolling ? [id] : null} campaigns={facets?.campaigns ?? []} canEnrol={can.manager} onClose={() => setEnrolling(false)} onDone={refreshAll} />
      <TagDialog ids={tagging ? [id] : null} tags={facets?.tags ?? []} onClose={() => setTagging(false)} onDone={refreshAll} onManage={() => { setTagging(false); setManagingTags(true); }} />
      <ManageTagsDialog open={managingTags} tags={facets?.tags ?? []} canManage={can.manager} onClose={() => setManagingTags(false)} onChanged={refreshAll} />
      <CustomFieldsDialog open={fieldsOpen} canManage={can.manager} onClose={() => setFieldsOpen(false)} onChanged={() => void profileRequest.mutate()} />
      <ActivityDialog contactId={id} draft={activity} onClose={() => setActivity(null)} onSaved={() => void refresh()} />
      <TaskDialog contactId={id} task={task?.task ?? null} open={task !== null} onClose={() => setTask(null)} onSaved={() => void refresh()} />
      <LinkedinMessageDialog contact={contact} open={messaging} onClose={() => setMessaging(false)} onSent={() => void refresh()} />
      <EmailDialog contact={contact} open={emailing} onClose={() => setEmailing(false)} onSent={() => void refresh()} />
      <BookingLinkDialog open={bookingOpen} url={profile.booking_url} onClose={() => setBookingOpen(false)} onSaved={() => void profileRequest.mutate()} />
    </Page>
  );
}

function LoadingLayout() {
  const t = useTranslations("ContactProfile");
  return (
    <div className="flex flex-col gap-3.5" aria-busy="true" aria-label={t("loadingContact")}>
      <Skeleton className="h-[96px] rounded-lg" />
      <div className="flex flex-col gap-3.5 xl:grid xl:grid-cols-[300px_minmax(0,1fr)_330px]">
        <div className="flex flex-col gap-3.5"><Skeleton className="h-[300px] rounded-lg" /><Skeleton className="h-[180px] rounded-lg" /></div>
        <Skeleton className="h-[520px] rounded-lg" />
        <div className="flex flex-col gap-3.5"><Skeleton className="h-[240px] rounded-lg" /><Skeleton className="h-[120px] rounded-lg" /><Skeleton className="h-[120px] rounded-lg" /></div>
      </div>
    </div>
  );
}
