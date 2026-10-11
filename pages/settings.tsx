import Head from "next/head";
import { useState, useEffect } from "react";
import { useRouter } from "next/router";
import { GetServerSideProps } from "next";
import { getServerWorkspace, loginRedirect } from "@/lib/server-workspace";
import { toast } from "sonner";
import {
  RiCompassLine, RiDownloadLine, RiSettings3Line,
} from "react-icons/ri";
import { ALL_TOUR_PAGES, TOUR_PAGE_LABELS, replayPageTour, type TourPage } from "@/lib/tour";

// ─── Types ────────────────────────────────────────────────────────────────────

type Tab = "general";

// ─── Server-side data ─────────────────────────────────────────────────────────

export const getServerSideProps: GetServerSideProps = async ({ query, req, res }) => {
  const workspace = await getServerWorkspace(req, res);
  if (!workspace) return loginRedirect(req);
  // LinkedIn accounts have their own page now; old links to the tab that held them follow it there.
  if (query.tab === "linkedin") return { redirect: { destination: "/linkedin-accounts", permanent: false } };
  // So do AI settings.
  if (query.tab === "ai") return { redirect: { destination: "/ai", permanent: false } };
  // So do mailboxes.
  if (query.tab === "email") return { redirect: { destination: "/mailboxes", permanent: false } };
  // And provider keys, with the CRM and calendar connections that used to be on another page.
  if (query.tab === "integrations") return { redirect: { destination: "/integrations", permanent: false } };
  // And templates, which are a library of their own.
  if (query.tab === "templates") return { redirect: { destination: "/templates", permanent: false } };
  // What is left here is the General tab.
  return { props: { initialTab: "general" as Tab } };
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TABS: { key: Tab; label: string; icon: React.ElementType }[] = [
  { key: "general", label: "General", icon: RiSettings3Line },
];

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function SettingsPage({ initialTab }: { initialTab: Tab }) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>(initialTab);

  const visibleTabs = TABS;

  function switchTab(t: Tab) {
    setTab(t);
    router.replace(`/settings?tab=${t}`, undefined, { shallow: true });
  }

  return (
    <>
      <Head>
        <title>Settings — Linki</title>
        <meta name="robots" content="noindex, nofollow" />
      </Head>

      <div className="max-w-3xl">
        {/* Page header */}
        <div className="mb-6">
          <p className="mb-2 text-[13px] font-medium text-base-content/45">Workspace</p>
          <h1 className="text-[30px] font-semibold leading-[1.1] tracking-[-.03em] text-base-content">Settings</h1>
          <p className="mt-2 text-[15px] text-base-content/50">Accounts, integrations, and preferences.</p>
        </div>

        {/* Tabs */}
        <div className="mb-6 flex items-center gap-1 overflow-x-auto border-b border-[var(--border-subtle)]">
          {visibleTabs.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              data-tour={`settings-tab-${key}`}
              onClick={() => switchTab(key)}
              className={`relative -mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors ${
                tab === key
                  ? "border-primary text-base-content"
                  : "border-transparent text-base-content/40 hover:text-base-content/70"
              }`}
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        {tab === "general" && <GeneralTab />}
      </div>
    </>
  );
}

// ─── General Tab ──────────────────────────────────────────────────────────────

function GeneralTab() {
  const router = useRouter();
  const [importCap, setImportCap] = useState<number | "">("");
  const [capSaving, setCapSaving] = useState(false);

  useEffect(() => {
    fetch("/api/settings/import-cap").then((r) => r.json()).then((d) => setImportCap(d.cap ?? 1500)).catch(() => {});
  }, []);

  async function saveImportCap(e: React.FormEvent) {
    e.preventDefault();
    setCapSaving(true);
    const res = await fetch("/api/settings/import-cap", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cap: Number(importCap) }),
    });
    setCapSaving(false);
    if (!res.ok) { toast.error((await res.json()).error ?? "Failed"); return; }
    toast.success("Daily import limit saved");
  }

  return (
    <div className="max-w-sm flex flex-col gap-4">
      {/* Daily import limit */}
      <div className="bg-base-100 border border-[var(--border-subtle)] rounded-2xl shadow-[var(--shadow-raised)] p-4">
        <div className="flex items-center gap-2 mb-1">
          <RiDownloadLine size={13} className="text-base-content/40" />
          <p className="text-xs font-medium text-base-content/40 uppercase tracking-wide">Daily import limit</p>
        </div>
        <p className="text-xs text-base-content/50 mb-3">
          Max contacts imported from Sales Navigator per day (across all lists). Larger lists are split into batches over consecutive days to stay under LinkedIn&apos;s radar.
        </p>
        <form onSubmit={saveImportCap} className="flex items-end gap-2">
          <div className="flex-1">
            <input type="number" min={1} className="input input-bordered input-sm w-full" placeholder="1500" value={importCap} onChange={(e) => setImportCap(e.target.value === "" ? "" : Number(e.target.value))} required />
          </div>
          <button type="submit" disabled={capSaving} className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium bg-primary text-primary-content hover:bg-primary/90 transition-colors disabled:opacity-50">
            {capSaving ? <span className="loading loading-spinner loading-xs" /> : "Save"}
          </button>
        </form>
      </div>

      {/* How to connect an AI client over MCP is on /developers. */}

      {/* Product tour */}
      <div className="bg-base-100 border border-[var(--border-subtle)] rounded-2xl shadow-[var(--shadow-raised)] p-4">
        <div className="flex items-center gap-2 mb-2">
          <RiCompassLine size={13} className="text-base-content/40" />
          <p className="text-xs font-medium text-base-content/40 uppercase tracking-wide">Product tour</p>
        </div>
        <p className="text-xs text-base-content/50 mb-3">
          Replay the guided walkthrough for any page.
        </p>
        <select
          className="w-full px-3 py-1.5 rounded-[10px] text-sm bg-base-100 border border-[var(--border)] text-base-content focus:outline-none focus:border-[var(--border-focus)] cursor-pointer"
          defaultValue=""
          onChange={(e) => {
            const page = e.target.value as TourPage;
            if (!page) return;
            e.target.value = "";
            if (page === "settings") {
              replayPageTour(page);
            } else {
              router.push(page === "dashboard" ? "/" : `/${page}`).then(() => setTimeout(() => replayPageTour(page), 400));
            }
          }}
        >
          <option value="">Select a page to replay…</option>
          {ALL_TOUR_PAGES.map((p) => (
            <option key={p} value={p}>{TOUR_PAGE_LABELS[p]}</option>
          ))}
        </select>
      </div>

    </div>
  );
}
