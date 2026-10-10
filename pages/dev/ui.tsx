import { useState } from "react";
import type { GetServerSideProps } from "next";
import Head from "next/head";
import {
  Archive, Bell, CircleQuestionMark, Copy, Download, Eye, ListChecks, Mail, MessageSquare, Pause, Play, Plus, SendHorizontal, Share2, Upload, UserPlus, UserRound, Workflow,
} from "lucide-react";
import {
  AddFilterButton, Alert, Avatar, BarChart, BulkBar, Button, Card, CardHeader, CellStack, ChannelBadge, Checkbox, CodeBlock, DataTable, Delta, Dialog, Drawer,
  EmptyState, ErrorState, Eyebrow, Field, FilterChip, Funnel, IconButton, Input, Kbd, KpiCard, Legend, LinkedinIcon, LoadingState, Menu, MenuItem, MenuSeparator,
  Meter, NumberStepper, Pagination, Pill, Popover, ScoreRing, SearchInput, Segmented, Select, Skeleton, Spinner, StepRail, Steps, Switch, Tabs, TextAction, Textarea,
  Timeline, Tooltip, confirm, type Column, type Sort,
} from "@/components/ui";
import { toast } from "sonner";
import { Page } from "@/components/shell";

// A working specimen of the design system, for building and checking primitives
// against the design. It is not part of the product: production returns 404.
export const getServerSideProps: GetServerSideProps = async () => (process.env.NODE_ENV === "production" ? { notFound: true } : { props: {} });

interface CampaignRow {
  id: string;
  name: string;
  list: string;
  status: "Active" | "Paused" | "Draft" | "Completed";
  channels: ("linkedin" | "email")[];
  enrolled: number;
  done: number;
  reply: number | null;
  owner: string;
  activity: string;
}

const CAMPAIGNS: CampaignRow[] = [
  { id: "1", name: "Q4 Enterprise — VP Sales (US)", list: "Enterprise VP Sales · 1,240", status: "Active", channels: ["linkedin", "email"], enrolled: 1240, done: 892, reply: 11.4, owner: "Jordan Mertens", activity: "4 min ago" },
  { id: "2", name: "Series B FinTech — Ops Leaders", list: "FinTech Ops · 860", status: "Active", channels: ["linkedin", "email"], enrolled: 860, done: 531, reply: 9.1, owner: "Priya Raghavan", activity: "12 min ago" },
  { id: "3", name: "Shopify Plus Merchants — H2", list: "Ecom Tier 1 · 2,310", status: "Paused", channels: ["email"], enrolled: 2310, done: 1744, reply: 6.8, owner: "Marcus Oyelaran", activity: "2 h ago" },
  { id: "4", name: "Healthcare RCM — Directors", list: "RCM Directors · 480", status: "Draft", channels: ["linkedin", "email"], enrolled: 0, done: 0, reply: null, owner: "Elena Vogt", activity: "1 d ago" },
  { id: "5", name: "Webinar No-Shows — Reactivation", list: "Webinar Q3 · 1,480", status: "Completed", channels: ["email"], enrolled: 1480, done: 1480, reply: 5.2, owner: "Jordan Mertens", activity: "3 d ago" },
];

const STATUS_TONE = { Active: "good", Paused: "warn", Draft: "neutral", Completed: "brand" } as const;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <Eyebrow>{title}</Eyebrow>
      {children}
    </section>
  );
}

export default function DesignSystemSpecimen() {
  const [status, setStatus] = useState<"all" | "active" | "paused" | "draft" | "completed">("all");
  const [range, setRange] = useState<"7" | "30" | "90">("7");
  const [tab, setTab] = useState<"overview" | "sequence" | "prospects" | "settings">("sequence");
  const [channel, setChannel] = useState<"all" | "linkedin" | "email">("all");
  const [search, setSearch] = useState("");
  const [checked, setChecked] = useState(true);
  const [rotate, setRotate] = useState(true);
  const [days, setDays] = useState(2);
  const [selected, setSelected] = useState<Set<string>>(new Set(["1"]));
  const [sort, setSort] = useState<Sort>({ key: "activity", direction: "desc" });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [dialog, setDialog] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [body, setBody] = useState("Hi {{first_name}} — {{company}} just posted 4 new AE roles.");

  const columns: Column<CampaignRow>[] = [
    { key: "name", header: "Campaign", sortKey: "name", cell: row => <CellStack title={row.name} sub={row.list} /> },
    { key: "status", header: "Status", width: 108, cell: row => <Pill tone={STATUS_TONE[row.status]} dot={row.status !== "Draft"}>{row.status}</Pill> },
    { key: "channels", header: "Channels", width: 88, cell: row => <span className="flex gap-[5px]">{row.channels.map(c => <ChannelBadge key={c} channel={c} />)}</span> },
    { key: "enrolled", header: "Enrolled / done", width: 124, sortKey: "enrolled", cell: row => <span className="flex items-baseline gap-1"><b className="font-semibold">{row.enrolled.toLocaleString()}</b><span className="text-11 text-ink-3">/ {row.done.toLocaleString()}</span></span> },
    { key: "reply", header: "Reply rate", width: 96, sortKey: "reply", cell: row => row.reply === null ? <span className="text-ink-3">—</span> : <span className="flex w-14 flex-col gap-[5px]"><b className="font-semibold">{row.reply}%</b><Meter value={row.reply} max={20} height={3} tone="good" /></span> },
    { key: "owner", header: "Owner", width: 148, cell: row => <span className="flex items-center gap-[7px]"><Avatar name={row.owner} /><span className="truncate text-115 font-medium text-ink-2">{row.owner}</span></span> },
    { key: "activity", header: "Last activity", width: 104, sortKey: "activity", cell: row => <span className="text-115 text-ink-2">{row.activity}</span> },
    {
      key: "menu", header: "", width: 44, align: "right",
      cell: () => (
        <Menu trigger={<IconButton icon={Workflow} label="Row actions" size={22} />} width={190}>
          <MenuItem icon={Play}>Resume campaign</MenuItem>
          <MenuItem icon={Workflow}>Edit sequence</MenuItem>
          <MenuItem icon={Copy}>Duplicate</MenuItem>
          <MenuItem icon={Download}>Export prospects</MenuItem>
          <MenuSeparator />
          <MenuItem icon={Pause}>Pause</MenuItem>
          <MenuItem icon={Archive} tone="danger">Archive</MenuItem>
        </Menu>
      ),
    },
  ];

  return (
    <>
      <Head>
        <title>Design system — Linki</title>
      </Head>
      <Page title="Design system" meta={<Pill>Development only</Pill>} actions={<Button variant="primary" icon={Plus}>Primary action</Button>} className="gap-8">

        <Section title="Buttons">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" icon={Plus}>New campaign</Button>
            <Button icon={Download}>Export</Button>
            <Button variant="ghost" icon={Upload}>Import prospects</Button>
            <Button variant="tint" icon={SendHorizontal}>Rewrite</Button>
            <Button variant="danger" icon={Archive}>Archive</Button>
            <Button variant="primary" loading>Saving</Button>
            <Button disabled>Disabled</Button>
            <Button size="sm" icon={Pause}>Pause</Button>
            <Button size="xs">Review</Button>
            <IconButton icon={Bell} label="Notifications" variant="surface" dot />
            <IconButton icon={CircleQuestionMark} label="Help" variant="surface" />
            <Tooltip label="Opens the full send log"><Button variant="ghost">Hover me</Button></Tooltip>
          </div>
        </Section>

        <Section title="Filters and inputs">
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput value={search} onChange={setSearch} placeholder="Search campaigns" frameClassName="w-[240px]" />
            <SearchInput value="" onChange={() => undefined} placeholder="Search anything" shortcut="⌘K" frameClassName="w-[220px]" />
            <Segmented label="Status" value={status} onChange={setStatus} options={[{ value: "all", label: "All", count: 14 }, { value: "active", label: "Active", count: 6 }, { value: "paused", label: "Paused", count: 3 }, { value: "draft", label: "Draft", count: 2 }, { value: "completed", label: "Completed", count: 3 }]} />
            <Segmented label="Range" size="sm" value={range} onChange={setRange} options={[{ value: "7", label: "7d" }, { value: "30", label: "30d" }, { value: "90", label: "90d" }]} />
            <Select label="Channel" icon={Share2} value={channel} onChange={setChannel} options={[{ value: "all", label: "All channels" }, { value: "linkedin", label: "LinkedIn", icon: LinkedinIcon }, { value: "email", label: "Email", icon: Mail }]} />
            <Select label="Owner" icon={UserRound} value={undefined} placeholder="All owners" onChange={() => undefined} options={[{ value: "jm", label: "Jordan Mertens", hint: "Owner" }, { value: "pr", label: "Priya Raghavan", hint: "Manager" }]} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <FilterChip name="Email" value="Verified" />
            <FilterChip name="LinkedIn" value="Connected" />
            <FilterChip name="Owner" value="Anyone" active={false} />
            <Popover trigger={<AddFilterButton />}>
              <p className="w-[200px] text-115 text-ink-2">A popover holds richer content than a menu.</p>
            </Popover>
            <Kbd>⌘K</Kbd>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <Field label="LinkedIn email" hint="The address the member signs in with.">
              {id => <Input id={id} icon={Mail} defaultValue="daniel.okafor@acme.io" />}
            </Field>
            <Field label="Subject" error="A subject is required.">
              {id => <Input id={id} invalid placeholder="{{company}} + 4 new AE reqs" />}
            </Field>
            <Field label="Notes" aside="Saved 1m ago">
              {id => <Input id={id} tone="sunken" defaultValue="Re-engage after RFP closes" />}
            </Field>
            <Field label="Message body" aside={`${body.length} chars`} className="col-span-2">
              {id => <Textarea id={id} tone="sunken" rows={3} value={body} onChange={event => setBody(event.target.value)} />}
            </Field>
            <div className="flex flex-col gap-3">
              <label className="flex items-center gap-[9px] text-11 text-ink">
                <Checkbox checked={checked} onChange={setChecked} />
                Append to the first email of a sequence only
              </label>
              <div className="flex items-center justify-between text-115 text-ink-2">
                Rotate templates per prospect
                <Switch checked={rotate} onChange={setRotate} label="Rotate templates per prospect" />
              </div>
              <div className="flex items-center gap-2 text-115 text-ink-2">
                <NumberStepper label="Days to wait" value={days} onChange={setDays} max={30} />
                days after the connection request
              </div>
            </div>
          </div>
        </Section>

        <Section title="Status">
          <div className="flex flex-wrap items-center gap-2">
            <Pill>14 total</Pill>
            <Pill tone="good" dot>6 running</Pill>
            <Pill tone="warn" dot>Paused</Pill>
            <Pill tone="bad">Disconnected</Pill>
            <Pill tone="brand">In campaign · Step 3</Pill>
            <Pill tone="li" icon={LinkedinIcon}>LinkedIn · 1st degree</Pill>
            <Pill tone="mail" icon={Mail}>Email verified</Pill>
            <Pill tone="good" size="sm">Positive</Pill>
            <Delta value="+8.2%" direction="up" />
            <Delta value="-3" direction="down" />
            <Delta value="−0.8 pts" direction="down" good="down" />
            <ChannelBadge channel="linkedin" />
            <ChannelBadge channel="email" />
            <Avatar name="Jordan Mertens" size={26} />
            <Avatar name="Priya Raghavan" />
            <Avatar name="Northwind Logistics" size={32} square />
            <Spinner />
          </div>
          <Alert tone="warn" banner title="Weekly invitation limit reached on Priya Raman" actions={<><Button>Adjust limits</Button><Button icon={Play}>Resume campaign</Button></>} onDismiss={() => undefined}>
            “Hiring signal — Eng leaders” was paused 42 min ago · 198 of 200 invites used this week
          </Alert>
          <div className="grid grid-cols-3 gap-3">
            <Alert tone="bad" title="Mailbox auto-paused" actions={<Button size="xs">Review</Button>}>ops@acme.io · bounce rate 4.8% exceeded 4.0%</Alert>
            <Alert tone="info" title="Classified positive · 94% confidence">Open to a look at LinkedIn sourcing but mid-RFP.</Alert>
            <Alert tone="good" title="Delivered to the Primary tab">SPF, DKIM and DMARC passed</Alert>
          </div>
        </Section>

        <Section title="Numbers">
          <div className="flex gap-3.5">
            <KpiCard label="Emails sent" value="12,480" delta={<Delta value="+8.2%" direction="up" />} spark={[10, 14, 10, 16, 14, 19, 17, 23]} sparkTone="mail" />
            <KpiCard label="LinkedIn actions" value="3,912" delta={<Delta value="+4.1%" direction="up" />} spark={[8, 9, 12, 10, 14, 13, 15, 18]} sparkTone="li" />
            <KpiCard label="Reply rate" value="11.4%" delta={<Delta value="+1.3pt" direction="up" />} spark={[6, 7, 6, 8, 9, 8, 10, 11]} sparkTone="brand" />
            <KpiCard label="Connected seats" value="4" note="3 healthy · 1 needs re-auth" icon={LinkedinIcon} />
          </div>
          <div className="grid grid-cols-[1fr_340px] gap-3.5">
            <Card className="flex flex-col gap-4 p-4">
              <CardHeader title="Daily activity" subtitle="Sends and LinkedIn actions · last 14 days" actions={<Legend series={[{ key: "email", label: "Email", tone: "mail" }, { key: "linkedin", label: "LinkedIn", tone: "li" }, { key: "replies", label: "Replies", tone: "brand" }]} />} />
              <BarChart
                series={[{ key: "email", label: "Email", tone: "mail" }, { key: "linkedin", label: "LinkedIn", tone: "li" }, { key: "replies", label: "Replies", tone: "brand" }]}
                points={[62, 70, 55, 82, 76, 40, 18, 90, 96, 84, 102, 110, 60, 24].map((email, index) => ({ label: String(((25 + index) % 31) + 1).padStart(2, "0"), values: { email: email * 8, linkedin: Math.round(email * 4.6), replies: Math.round(email * 0.8) } }))}
              />
            </Card>
            <Card className="flex flex-col gap-3.5 p-4">
              <CardHeader title="Conversion funnel" subtitle="All active campaigns · both channels" />
              <Funnel stages={[{ key: "a", label: "Contacts enrolled", count: 18420 }, { key: "b", label: "Delivered / visited", count: 16803 }, { key: "c", label: "Opened or accepted", count: 9114 }, { key: "d", label: "Replied", count: 2102 }, { key: "e", label: "Positive", count: 318 }, { key: "f", label: "Meeting booked", count: 47 }]} />
            </Card>
          </div>
          <div className="flex items-center gap-6">
            <ScoreRing score={86} />
            <ScoreRing score={64} />
            <ScoreRing score={null} />
            <div className="flex w-[180px] flex-col gap-1.5">
              <div className="flex items-center justify-between"><Eyebrow>Connections</Eyebrow><span className="text-115 font-semibold text-warn">58 / 60</span></div>
              <Meter value={58} max={60} tone="warn" label="Connections today" />
              <span className="text-10 text-ink-3">2 left today · resets 00:00</span>
            </div>
          </div>
        </Section>

        <Section title="Table">
          <BulkBar count={selected.size} noun={["campaign", "campaigns"]} onClear={() => setSelected(new Set())}>
            <Button size="sm" icon={Pause}>Pause</Button>
            <Button size="sm" icon={Play}>Resume</Button>
            <Button size="sm" icon={Copy}>Duplicate</Button>
            <Button size="sm" variant="danger" icon={Archive}>Archive</Button>
          </BulkBar>
          <DataTable
            label="Campaigns"
            columns={columns}
            rows={CAMPAIGNS}
            rowKey={row => row.id}
            selected={selected}
            onSelectedChange={setSelected}
            sort={sort}
            onSortChange={setSort}
            footer={<><span>Showing {CAMPAIGNS.length} of 148 campaigns</span><Pagination page={page} pageSize={pageSize} total={148} onPageChange={setPage} pageSizes={[25, 50, 100]} onPageSizeChange={setPageSize} /></>}
          />
          <div className="grid grid-cols-3 gap-3.5">
            <DataTable label="Loading" columns={columns.slice(0, 2)} rows={undefined} rowKey={row => row.id} density="compact" />
            <DataTable label="Empty" columns={columns.slice(0, 2)} rows={[]} rowKey={row => row.id} empty={<EmptyState icon={SendHorizontal} title="No campaigns yet" action={<Button variant="primary" icon={Plus}>New campaign</Button>}>Create one to start reaching the people on a list.</EmptyState>} />
            <DataTable label="Failed" columns={columns.slice(0, 2)} rows={[]} rowKey={row => row.id} error="The server did not answer." onRetry={() => toast.success("Tried again")} />
          </div>
        </Section>

        <Section title="Navigation and flow">
          <Card className="flex h-[42px] items-center justify-between px-5">
            <Tabs label="Campaign sections" value={tab} onChange={setTab} items={[{ value: "overview", label: "Overview" }, { value: "sequence", label: "Sequence" }, { value: "prospects", label: "Prospects", count: "1,240" }, { value: "settings", label: "Settings" }]} />
            <span className="text-11 text-ink-3">Last published 2 d ago</span>
          </Card>
          <Steps current={1} items={[{ key: "upload", label: "Upload file", sub: "acme_q4_prospects.csv" }, { key: "map", label: "Map columns", sub: "12 of 14 columns mapped" }, { key: "dupes", label: "Duplicates", sub: "118 matches to resolve" }, { key: "review", label: "Review & import", sub: "2,418 leads ready" }]} />
          <div className="grid grid-cols-[248px_1fr_1fr] gap-3.5">
            <Card className="overflow-hidden">
              <StepRail heading="Setup steps" current={2} onSelect={() => undefined} items={[{ key: "list", label: "List picker", sub: "Enterprise VP Sales · 1,240" }, { key: "ai", label: "AI context", sub: "Value prop, tone, 3 trigger sources" }, { key: "li", label: "LinkedIn steps", sub: "4 steps · visit, invite, 2 messages" }, { key: "em", label: "Email steps", sub: "Not started" }]} className="w-full border-r-0" />
            </Card>
            <Card className="p-4">
              <Timeline
                events={[
                  { key: "1", icon: LinkedinIcon, tone: "li", title: "Replied on LinkedIn", badge: <Pill tone="good" size="sm">Positive</Pill>, time: "Today · 2:04 PM", detail: "“Makes sense — we're mid-RFP but I'd take a look at the LinkedIn side of this.”" },
                  { key: "2", icon: Mail, tone: "mail", title: "Email opened 4× · 2 link clicks", time: "Today · 11:38 AM" },
                  { key: "3", icon: UserPlus, tone: "li", title: "Connection accepted", time: "Oct 4 · 4:21 PM", detail: "Now a 1st-degree connection of j.mertens." },
                  { key: "4", icon: ListChecks, title: "Added to list · Enterprise Logistics — EU", time: "Sep 28 · 6:02 PM" },
                ]}
              />
            </Card>
            <div className="flex flex-col gap-3.5">
              <CodeBlock caption="claude_desktop_config.json" code={`{\n  "mcpServers": {\n    "linki": { "url": "https://linki.example.com/api/mcp" }\n  }\n}`} />
              <Card className="flex flex-col gap-2 p-3.5">
                <Skeleton className="h-3 w-2/3" />
                <Skeleton className="h-3 w-full" />
                <LoadingState label="Loading conversation" className="py-3" />
                <ErrorState message="The conversation could not be read." className="py-3" />
              </Card>
            </div>
          </div>
        </Section>

        <Section title="Overlays">
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => setDialog(true)} icon={Eye}>Open dialog</Button>
            <Button onClick={() => setDrawer(true)} icon={MessageSquare}>Open drawer</Button>
            <Button onClick={async () => toast(await confirm({ title: "Archive 3 campaigns?", body: "They stop sending and move to the archive. You can restore them later.", confirmLabel: "Archive", tone: "danger" }) ? "Confirmed" : "Cancelled")}>Ask to confirm</Button>
            <Button onClick={() => toast.success("Sequence saved", { description: "348 contacts in flight keep their place." })}>Success toast</Button>
            <Button onClick={() => toast.error("Could not reach the mailbox")}>Error toast</Button>
            <TextAction>View all</TextAction>
          </div>
          <Dialog open={dialog} onOpenChange={setDialog} title="New campaign" description="Step 6 of 6 · Review and launch" icon={SendHorizontal} size="lg" footer={<><Button>Back to sender accounts</Button><span className="flex items-center gap-2.5"><Button>Save as draft</Button><Button variant="primary">Launch campaign</Button></span></>}>
            <p className="text-12 leading-[17px] text-ink-2">Focus stays inside the dialog. Escape and a click on the scrim close it.</p>
          </Dialog>
          <Drawer open={drawer} onOpenChange={setDrawer} title="Delivery log" description="Reply router · last 50 deliveries" footer={<Button onClick={() => setDrawer(false)}>Close</Button>}>
            <p className="text-12 leading-[17px] text-ink-2">A drawer keeps the page visible behind it.</p>
          </Drawer>
        </Section>
      </Page>
    </>
  );
}
