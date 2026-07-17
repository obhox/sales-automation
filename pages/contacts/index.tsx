import Head from "next/head";
import { useState, useEffect, useCallback, useRef } from "react";
import { GetServerSideProps } from "next";
import { useRouter } from "next/router";
import { getDb } from "@/lib/db";
import { workspaceIdFromHeaders } from "@/lib/workspace";
import { toast } from "sonner";
import {
  RiExternalLinkLine, RiArrowLeftSLine, RiArrowRightSLine,
  RiUserFollowLine, RiUserAddLine, RiUserLine,
  RiMessage2Line, RiReplyLine, RiMailCheckLine, RiAtLine, RiMailLine,
  RiSearchLine, RiAddLine, RiListCheck2, RiDeleteBinLine,
} from "react-icons/ri";
import FilterBar, { ActiveFilter, filtersToParams } from "@/components/ui/FilterBar";

const PAGE_SIZE = 50;

interface Contact {
  id: string;
  linkedin_url: string | null;
  full_name: string | null;
  title: string | null;
  company: string | null;
  location: string | null;
  email: string | null;
  email_status: string | null;
  phone: string | null;
  degree: number | null;
  connection_requested_at: string | null;
  connected_at: string | null;
  message_sent_at: string | null;
  last_replied_at: string | null;
  apollo_enriched_at: string | null;
  seniority: string | null;
  created_at: string;
}

interface ListOption {
  id: string;
  name: string;
  target_count: number;
}

export const getServerSideProps: GetServerSideProps = async ({req}) => {
  const db = getDb();
  const workspaceId=workspaceIdFromHeaders(req.headers);
  const lists = db
    .prepare(
      `SELECT l.id, l.name, COUNT(lt.target_id) as target_count
       FROM lists l
       LEFT JOIN list_targets lt ON lt.list_id = l.id
       WHERE l.workspace_id = ?
       GROUP BY l.id
       ORDER BY l.name ASC`
    )
    .all(workspaceId) as ListOption[];
  const total = (
    db
      .prepare("SELECT COUNT(*) as c FROM targets t WHERE t.workspace_id=? AND EXISTS (SELECT 1 FROM list_targets lt WHERE lt.target_id = t.id)")
      .get(workspaceId) as { c: number }
  ).c;
  return { props: { lists, total } };
};

function ConnectionIcon({ t }: { t: Contact }) {
  if (t.degree === 1) {
    return <span title="Connected" className="text-success"><RiUserFollowLine size={14} /></span>;
  }
  if (t.connection_requested_at) {
    return <span title="Request sent" className="text-warning"><RiUserAddLine size={14} /></span>;
  }
  return (
    <span title={t.degree === 2 ? "2nd degree" : t.degree === 3 ? "3rd degree" : "Not connected"} className="text-base-content/20">
      <RiUserLine size={14} />
    </span>
  );
}

export default function ContactsPage({ lists, total: initialTotal }: { lists: ListOption[]; total: number }) {
  const router = useRouter();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [total, setTotal] = useState(initialTotal);
  const [page, setPage] = useState(0);
  const [listId, setListId] = useState("");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [filters, setFilters] = useState<ActiveFilter[]>([]);
  const [loading, setLoading] = useState(true);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [showNewContact, setShowNewContact] = useState(false);
  const [newContactForm, setNewContactForm] = useState({ full_name: "", linkedin_url: "", title: "", company: "", location: "", email: "", phone: "", list_id: "" });
  const [newContactLoading, setNewContactLoading] = useState(false);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showAddToList, setShowAddToList] = useState(false);
  const [addToListId, setAddToListId] = useState("");
  const [addToListLoading, setAddToListLoading] = useState(false);

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedSearch(search), 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [search]);

  const fetch_ = useCallback(async (p: number, lid: string, q: string, activeFilters: ActiveFilter[]) => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(p), limit: String(PAGE_SIZE) });
    if (lid) params.set("list_id", lid);
    if (q) params.set("search", q);
    const filterParams = filtersToParams(activeFilters);
    filterParams.forEach((v, k) => params.set(k, v));
    const res = await fetch(`/api/targets?${params}`);
    if (res.ok) {
      const data = await res.json();
      setContacts(data.contacts);
      setTotal(data.total);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetch_(page, listId, debouncedSearch, filters);
    setSelected(new Set());
  }, [page, listId, debouncedSearch, filters, fetch_]);

  function changeList(lid: string) { setListId(lid); setPage(0); }
  function changeSearch(q: string) { setSearch(q); setPage(0); }
  function changeFilters(f: ActiveFilter[]) { setFilters(f); setPage(0); }

  const allPageSelected = contacts.length > 0 && contacts.every((c) => selected.has(c.id));

  function toggleAll() {
    if (allPageSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(contacts.map((c) => c.id)));
    }
  }

  function toggleOne(id: string) {
    setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  async function addSelectedToList() {
    if (!addToListId || selected.size === 0) return;
    setAddToListLoading(true);
    const res = await fetch(`/api/lists/${addToListId}/add-members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contact_ids: [...selected] }),
    });
    setAddToListLoading(false);
    const data = await res.json();
    if (!res.ok) { toast.error(data.error ?? "Failed to add to list"); return; }
    const listName = lists.find((l) => l.id === addToListId)?.name ?? "list";
    toast.success(
      data.already_members > 0
        ? `Added ${data.added} to ${listName} (${data.already_members} already there)`
        : `Added ${data.added} to ${listName}`
    );
    setShowAddToList(false);
    setAddToListId("");
    setSelected(new Set());
  }

  async function deleteSelected() {
    if (selected.size === 0) return;
    setDeleteLoading(true);
    const res = await fetch("/api/targets", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_ids: [...selected] }),
    });
    setDeleteLoading(false);
    const data = await res.json();
    if (!res.ok) { toast.error(data.error ?? "Failed to delete contacts"); return; }
    toast.success(`Deleted ${data.deleted} contact${data.deleted !== 1 ? "s" : ""}`);
    setShowDeleteConfirm(false);
    setSelected(new Set());
    fetch_(page, listId, debouncedSearch, filters);
  }

  async function createContact(e: React.FormEvent) {
    e.preventDefault();
    setNewContactLoading(true);
    const res = await fetch("/api/targets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newContactForm),
    });
    setNewContactLoading(false);
    if (!res.ok) {
      const data = await res.json();
      toast.error(data.error ?? "Failed to create contact");
      return;
    }
    toast.success("Contact created");
    setShowNewContact(false);
    setNewContactForm({ full_name: "", linkedin_url: "", title: "", company: "", location: "", email: "", phone: "", list_id: "" });
    fetch_(0, listId, debouncedSearch, filters);
    setPage(0);
  }

  const hasActiveFilters = filters.length > 0 || listId || search;

  return (
    <>
      <Head>
        <title>Contacts — Linki</title>
        <meta name="robots" content="noindex, nofollow" />
      </Head>
      <div>
        {/* Header */}
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end mb-6">
          <div>
            <p className="mb-2 text-[13px] font-medium text-base-content/45">Directory</p>
            <h1 className="text-[30px] font-semibold leading-[1.1] tracking-[-.03em] text-base-content">Contacts</h1>
            <p className="mt-2 text-[15px] text-base-content/50">
              {total.toLocaleString()} contact{total !== 1 ? "s" : ""}
              {hasActiveFilters ? " matching filters" : " total"}
            </p>
          </div>
          <button
            className="inline-flex items-center gap-1.5 h-10 px-4 rounded-[10px] text-sm font-semibold bg-primary text-primary-content hover:bg-[var(--primary-hover)] transition-colors"
            onClick={() => setShowNewContact(true)}
          >
            <RiAddLine size={16} /> New Contact
          </button>
        </div>

        {/* Filter row */}
        <div className="flex items-center gap-3 mb-5 flex-wrap" data-tour="contacts-filters">
          {/* Search */}
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-base-content/35 pointer-events-none">
              <RiSearchLine size={14} />
            </span>
            <input
              type="text"
              className="w-56 h-9 bg-base-100 border border-[var(--border)] rounded-[10px] pl-9 pr-3 text-sm text-base-content placeholder:text-base-content/35 focus:outline-none focus:border-[var(--border-focus)] transition-colors"
              placeholder="Search name, company…"
              value={search}
              onChange={(e) => changeSearch(e.target.value)}
            />
          </div>

          {/* List selector */}
          <select
            className="bg-base-100 border border-[var(--border)] rounded-[10px] px-3 text-sm text-base-content focus:outline-none focus:border-[var(--border-focus)] h-9 transition-colors cursor-pointer"
            value={listId}
            onChange={(e) => changeList(e.target.value)}
          >
            <option value="">All lists</option>
            {lists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name} ({l.target_count})
              </option>
            ))}
          </select>

          {/* Divider */}
          <div className="w-px h-5 bg-[var(--border)]" />

          {/* FilterBar */}
          <FilterBar filters={filters} onChange={changeFilters} />
        </div>

        {selected.size > 0 && (
          <div className="flex items-center gap-3 mb-3 px-3 py-2 rounded-[10px] bg-base-200 border border-[var(--border)]">
            <span className="text-xs font-medium text-base-content/70 flex-1">{selected.size} selected</span>
            <button
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border border-[var(--border)] bg-base-100 text-base-content/70 hover:bg-base-200 hover:text-base-content transition-colors"
              onClick={() => setShowAddToList(true)}
            >
              <RiListCheck2 size={13} /> Add to list
            </button>
            <button
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium text-error bg-error/10 hover:bg-error/20 transition-colors"
              onClick={() => setShowDeleteConfirm(true)}
            >
              <RiDeleteBinLine size={13} /> Delete
            </button>
            <button
              className="text-xs text-base-content/45 hover:text-base-content transition-colors"
              onClick={() => setSelected(new Set())}
            >
              Clear
            </button>
          </div>
        )}

        {/* Table */}
        {loading && contacts.length === 0 ? (
          <div className="flex items-center justify-center py-20 text-base-content/40 text-sm gap-2">
            <span className="loading loading-spinner loading-sm" /> Loading...
          </div>
        ) : contacts.length === 0 ? (
          <div className="rounded-2xl border border-[var(--border-subtle)] bg-base-100 py-20 text-center text-base-content/45 text-sm">
            {hasActiveFilters ? "No contacts match these filters." : listId ? "No contacts in this list." : "No contacts yet. Import from a list."}
          </div>
        ) : (
          <>
            <div className="overflow-x-auto rounded-2xl border border-[var(--border-subtle)] bg-base-100 shadow-[var(--shadow-raised)]">
              <table className="table w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--border-subtle)] text-base-content/45 text-xs uppercase tracking-wide">
                    <th className="w-8" data-tour="contacts-select">
                      <input type="checkbox" className="w-3.5 h-3.5 rounded border border-[var(--border-strong)] bg-base-100 accent-primary cursor-pointer" checked={allPageSelected} onChange={toggleAll} />
                    </th>
                    <th>Name</th>
                    <th>Title</th>
                    <th>Company</th>
                    <th>Location</th>
                    <th>Email</th>
                    <th className="w-24">Status</th>
                    <th className="w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {contacts.map((c) => (
                    <tr
                      key={c.id}
                      className={`border-b border-[var(--border-subtle)] last:border-0 cursor-pointer transition-colors ${selected.has(c.id) ? "bg-base-200" : "hover:bg-base-200"}`}
                      onClick={() => router.push(`/contacts/${c.id}`)}
                    >
                      <td onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          className="w-3.5 h-3.5 rounded border border-[var(--border-strong)] bg-base-100 accent-primary cursor-pointer"
                          checked={selected.has(c.id)}
                          onChange={() => toggleOne(c.id)}
                        />
                      </td>
                      <td>
                        <div className="flex items-center gap-2.5">
                          <div className="w-7 h-7 rounded-full bg-base-200 flex items-center justify-center text-xs font-semibold text-base-content/70 shrink-0">
                            {(c.full_name ?? "?").charAt(0).toUpperCase()}
                          </div>
                          <span className="font-medium text-base-content truncate max-w-36">{c.full_name ?? "—"}</span>
                        </div>
                      </td>
                      <td className="text-base-content/60 max-w-44 truncate">{c.title ?? "—"}</td>
                      <td className="text-base-content/60 truncate max-w-36">{c.company ?? "—"}</td>
                      <td className="text-base-content/45 text-xs truncate max-w-32">{c.location ?? "—"}</td>
                      <td className="text-base-content/60 text-xs font-mono truncate max-w-40">{c.email ?? <span className="text-base-content/30">—</span>}</td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center gap-1.5">
                          <ConnectionIcon t={c} />
                          {c.message_sent_at && (
                            <span title="LinkedIn message sent" className="text-[var(--viz-1)]"><RiMessage2Line size={13} /></span>
                          )}
                          {c.last_replied_at && (
                            <span title="Replied" className="text-success"><RiReplyLine size={13} /></span>
                          )}
                          {c.email && c.email_status === "verified" && (
                            <span title="Verified email" className="text-success"><RiMailCheckLine size={13} /></span>
                          )}
                          {c.email && c.email_status !== "verified" && (
                            <span title={`Email (${c.email_status ?? "unverified"})`} className="text-warning"><RiAtLine size={13} /></span>
                          )}
                          {c.apollo_enriched_at && !c.email && (
                            <span title="Apollo enriched — no email" className="text-base-content/20"><RiMailLine size={13} /></span>
                          )}
                        </div>
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        {c.linkedin_url && (
                          <a
                            href={c.linkedin_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center p-1 rounded text-base-content/35 hover:text-base-content transition-colors"
                          >
                            <RiExternalLinkLine size={13} />
                          </a>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-4 text-sm text-base-content/55">
                <span className="tabular-nums">
                  {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total.toLocaleString()}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    className="inline-flex items-center justify-center w-7 h-7 rounded-lg border border-[var(--border)] bg-base-100 text-base-content/60 hover:text-base-content hover:bg-base-200 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                    onClick={() => setPage((p) => p - 1)}
                    disabled={page === 0 || loading}
                  >
                    <RiArrowLeftSLine size={15} />
                  </button>
                  <span className="px-2 tabular-nums">{page + 1} / {totalPages}</span>
                  <button
                    className="inline-flex items-center justify-center w-7 h-7 rounded-lg border border-[var(--border)] bg-base-100 text-base-content/60 hover:text-base-content hover:bg-base-200 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                    onClick={() => setPage((p) => p + 1)}
                    disabled={page >= totalPages - 1 || loading}
                  >
                    <RiArrowRightSLine size={15} />
                  </button>
                </div>
              </div>
            )}

            {loading && contacts.length > 0 && (
              <div className="flex items-center gap-1.5 mt-3 text-xs text-base-content/40">
                <span className="loading loading-spinner loading-xs" /> Loading...
              </div>
            )}
          </>
        )}
      </div>
      {showNewContact && (
        <div className="modal modal-open">
          <div className="modal-box bg-base-100 border border-[var(--border-subtle)] rounded-2xl shadow-[var(--shadow-modal)] max-w-md">
            <h3 className="text-lg font-semibold mb-4">New Contact</h3>
            <form onSubmit={createContact} className="flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className="block text-xs font-medium text-base-content/50 pb-1.5">Full name *</label>
                  <input
                    className="w-full h-10 px-3 rounded-[10px] bg-base-100 border border-[var(--border)] text-sm focus:outline-none focus:border-[var(--border-focus)] transition-colors"
                    placeholder="Jane Smith"
                    value={newContactForm.full_name}
                    onChange={(e) => setNewContactForm({ ...newContactForm, full_name: e.target.value })}
                    required
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-xs font-medium text-base-content/50 pb-1.5">LinkedIn URL *</label>
                  <input
                    className="w-full h-10 px-3 rounded-[10px] bg-base-100 border border-[var(--border)] text-xs font-mono focus:outline-none focus:border-[var(--border-focus)] transition-colors"
                    placeholder="https://linkedin.com/in/..."
                    value={newContactForm.linkedin_url}
                    onChange={(e) => setNewContactForm({ ...newContactForm, linkedin_url: e.target.value })}
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-base-content/50 pb-1.5">Title</label>
                  <input
                    className="w-full h-10 px-3 rounded-[10px] bg-base-100 border border-[var(--border)] text-sm focus:outline-none focus:border-[var(--border-focus)] transition-colors"
                    placeholder="CEO"
                    value={newContactForm.title}
                    onChange={(e) => setNewContactForm({ ...newContactForm, title: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-base-content/50 pb-1.5">Company</label>
                  <input
                    className="w-full h-10 px-3 rounded-[10px] bg-base-100 border border-[var(--border)] text-sm focus:outline-none focus:border-[var(--border-focus)] transition-colors"
                    placeholder="Acme Inc."
                    value={newContactForm.company}
                    onChange={(e) => setNewContactForm({ ...newContactForm, company: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-base-content/50 pb-1.5">Location</label>
                  <input
                    className="w-full h-10 px-3 rounded-[10px] bg-base-100 border border-[var(--border)] text-sm focus:outline-none focus:border-[var(--border-focus)] transition-colors"
                    placeholder="Berlin, Germany"
                    value={newContactForm.location}
                    onChange={(e) => setNewContactForm({ ...newContactForm, location: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-base-content/50 pb-1.5">Email</label>
                  <input
                    type="email"
                    className="w-full h-10 px-3 rounded-[10px] bg-base-100 border border-[var(--border)] text-sm focus:outline-none focus:border-[var(--border-focus)] transition-colors"
                    placeholder="jane@acme.com"
                    value={newContactForm.email}
                    onChange={(e) => setNewContactForm({ ...newContactForm, email: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-base-content/50 pb-1.5">Phone</label>
                  <input
                    type="tel"
                    className="w-full h-10 px-3 rounded-[10px] bg-base-100 border border-[var(--border)] text-sm focus:outline-none focus:border-[var(--border-focus)] transition-colors"
                    placeholder="+49 30 1234567"
                    value={newContactForm.phone}
                    onChange={(e) => setNewContactForm({ ...newContactForm, phone: e.target.value })}
                  />
                </div>
                {lists.length > 0 && (
                  <div className="col-span-2">
                    <label className="block text-xs font-medium text-base-content/50 pb-1.5">Add to list (optional)</label>
                    <select
                      className="w-full h-10 px-3 rounded-[10px] text-sm bg-base-100 border border-[var(--border)] text-base-content focus:outline-none focus:border-[var(--border-focus)] cursor-pointer transition-colors"
                      value={newContactForm.list_id}
                      onChange={(e) => setNewContactForm({ ...newContactForm, list_id: e.target.value })}
                    >
                      <option value="">No list</option>
                      {lists.map((l) => (
                        <option key={l.id} value={l.id}>{l.name}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
              <div className="modal-action mt-2">
                <button type="button" className="inline-flex items-center h-9 px-3.5 rounded-[10px] text-sm font-medium text-base-content/60 hover:text-base-content hover:bg-base-200 transition-colors" onClick={() => setShowNewContact(false)}>
                  Cancel
                </button>
                <button
                  type="submit"
                  className="inline-flex items-center gap-1.5 h-9 px-4 rounded-[10px] text-sm font-semibold bg-primary text-primary-content hover:bg-[var(--primary-hover)] transition-colors disabled:opacity-50"
                  disabled={newContactLoading}
                >
                  {newContactLoading ? <span className="loading loading-spinner loading-xs" /> : "Create"}
                </button>
              </div>
            </form>
          </div>
          <div className="modal-backdrop" onClick={() => setShowNewContact(false)} />
        </div>
      )}
      {showAddToList && (
        <div className="modal modal-open">
          <div className="modal-box bg-base-100 border border-[var(--border-subtle)] rounded-2xl shadow-[var(--shadow-modal)] max-w-sm">
            <h3 className="text-lg font-semibold mb-1">Add to list</h3>
            <p className="text-xs text-base-content/55 mb-4">
              {selected.size} contact{selected.size !== 1 ? "s" : ""} will be added. Contacts already in the list are skipped.
            </p>
            <select
              className="w-full h-10 px-3 rounded-[10px] text-sm bg-base-100 border border-[var(--border)] text-base-content focus:outline-none focus:border-[var(--border-focus)] cursor-pointer transition-colors"
              value={addToListId}
              onChange={(e) => setAddToListId(e.target.value)}
            >
              <option value="">Select a list…</option>
              {lists.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
            <div className="modal-action mt-4">
              <button type="button" className="inline-flex items-center h-9 px-3.5 rounded-[10px] text-sm font-medium text-base-content/60 hover:text-base-content hover:bg-base-200 transition-colors" onClick={() => { setShowAddToList(false); setAddToListId(""); }}>
                Cancel
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 h-9 px-4 rounded-[10px] text-sm font-semibold bg-primary text-primary-content hover:bg-[var(--primary-hover)] transition-colors disabled:opacity-50"
                disabled={!addToListId || addToListLoading}
                onClick={addSelectedToList}
              >
                {addToListLoading ? <span className="loading loading-spinner loading-xs" /> : "Add"}
              </button>
            </div>
          </div>
          <div className="modal-backdrop" onClick={() => { setShowAddToList(false); setAddToListId(""); }} />
        </div>
      )}
      {showDeleteConfirm && (
        <div className="modal modal-open">
          <div className="modal-box bg-base-100 border border-[var(--border-subtle)] rounded-2xl shadow-[var(--shadow-modal)] max-w-sm">
            <h3 className="text-lg font-semibold mb-1">Delete {selected.size} contact{selected.size !== 1 ? "s" : ""}?</h3>
            <p className="text-xs text-base-content/55 mb-4 leading-relaxed">
              This permanently deletes {selected.size === 1 ? "this contact" : "these contacts"} and their run history — not just from this list, but from Linki entirely. This can&apos;t be undone.
            </p>
            <div className="modal-action mt-2">
              <button type="button" className="inline-flex items-center h-9 px-3.5 rounded-[10px] text-sm font-medium text-base-content/60 hover:text-base-content hover:bg-base-200 transition-colors" onClick={() => setShowDeleteConfirm(false)} disabled={deleteLoading}>
                Cancel
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 h-9 px-4 rounded-[10px] text-sm font-semibold bg-error text-white hover:bg-error/90 transition-colors disabled:opacity-50"
                disabled={deleteLoading}
                onClick={deleteSelected}
              >
                {deleteLoading ? <span className="loading loading-spinner loading-xs" /> : "Delete permanently"}
              </button>
            </div>
          </div>
          <div className="modal-backdrop" onClick={() => !deleteLoading && setShowDeleteConfirm(false)} />
        </div>
      )}
    </>
  );
}
