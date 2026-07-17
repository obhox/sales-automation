import Head from "next/head";
import { useState } from "react";
import { GetServerSideProps } from "next";
import Link from "next/link";
import { getDb } from "@/lib/db";
import { workspaceIdFromHeaders } from "@/lib/workspace";
import { toast } from "sonner";
import { RiAddLine, RiDeleteBinLine, RiBuildingLine, RiGlobalLine, RiSearchLine } from "react-icons/ri";

interface Company {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  location: string | null;
  linkedin_url: string | null;
  website: string | null;
  notes: string | null;
  contact_count: number;
  created_at: string;
}

const BLANK_FORM = { name: "", domain: "", industry: "", location: "", linkedin_url: "", website: "", notes: "" };

export const getServerSideProps: GetServerSideProps = async ({req}) => {
  const db = getDb();
  const workspaceId=workspaceIdFromHeaders(req.headers);
  const companies = db.prepare(`
    SELECT c.*, COUNT(t.id) as contact_count
    FROM companies c
    LEFT JOIN targets t ON t.company_id = c.id
    WHERE c.workspace_id = ?
    GROUP BY c.id
    ORDER BY c.name COLLATE NOCASE
  `).all(workspaceId);
  return { props: { initialCompanies: companies } };
};

export default function CompaniesPage({ initialCompanies }: { initialCompanies: Company[] }) {
  const [companies, setCompanies] = useState<Company[]>(initialCompanies);
  const [showModal, setShowModal] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState(BLANK_FORM);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");

  async function refresh() {
    // full=1 + no paging → full company rows as a single list (page does its own search/filter)
    const res = await fetch("/api/companies?full=1");
    const data = await res.json();
    setCompanies(data.companies ?? data);
  }

  function openCreate() {
    setEditId(null);
    setForm(BLANK_FORM);
    setShowModal(true);
  }

  function openEdit(c: Company) {
    setEditId(c.id);
    setForm({
      name: c.name,
      domain: c.domain ?? "",
      industry: c.industry ?? "",
      location: c.location ?? "",
      linkedin_url: c.linkedin_url ?? "",
      website: c.website ?? "",
      notes: c.notes ?? "",
    });
    setShowModal(true);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const body = {
      name: form.name,
      domain: form.domain || null,
      industry: form.industry || null,
      location: form.location || null,
      linkedin_url: form.linkedin_url || null,
      website: form.website || null,
      notes: form.notes || null,
    };
    const res = editId
      ? await fetch(`/api/companies/${editId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      : await fetch("/api/companies", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    setLoading(false);
    if (!res.ok) { toast.error((await res.json()).error ?? "Failed"); return; }
    toast.success(editId ? "Company updated" : "Company created");
    setShowModal(false);
    refresh();
  }

  async function deleteCompany(id: string) {
    if (!confirm("Delete this company? Contacts will be unlinked but not deleted.")) return;
    await fetch(`/api/companies/${id}`, { method: "DELETE" });
    toast.success("Deleted");
    setCompanies((prev) => prev.filter((c) => c.id !== id));
  }

  const filtered = companies.filter((c) =>
    !search || c.name.toLowerCase().includes(search.toLowerCase()) || (c.domain ?? "").toLowerCase().includes(search.toLowerCase())
  );

  return (
    <>
      <Head>
        <title>Companies — Linki</title>
        <meta name="robots" content="noindex, nofollow" />
      </Head>
      <div className="space-y-6">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <p className="mb-2 text-[13px] font-medium text-base-content/45">Directory</p>
            <h1 className="text-[30px] font-semibold leading-[1.1] tracking-[-.03em] text-base-content">Companies</h1>
            <p className="mt-2 text-[15px] text-base-content/50">Organisations associated with your contacts</p>
          </div>
          <button
            className="inline-flex items-center gap-1.5 h-10 px-4 rounded-[10px] text-sm font-semibold bg-primary text-primary-content hover:bg-[var(--primary-hover)] transition-colors"
            onClick={openCreate}
          >
            <RiAddLine size={16} /> Add Company
          </button>
        </div>

        <div className="relative w-full sm:w-72">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-base-content/35 pointer-events-none">
            <RiSearchLine size={14} />
          </span>
          <input
            className="w-full h-10 pl-9 pr-3 rounded-[10px] bg-base-100 border border-[var(--border)] text-sm text-base-content placeholder:text-base-content/35 focus:outline-none focus:border-[var(--border-focus)] transition-colors"
            placeholder="Search companies…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {filtered.length === 0 ? (
          <div className="rounded-2xl border border-[var(--border-subtle)] bg-base-100 py-16 text-center text-base-content/45 text-sm">
            {search ? "No companies match your search." : "No companies yet."}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-[var(--border-subtle)] bg-base-100 shadow-[var(--shadow-raised)]">
            <table className="table w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border-subtle)] text-base-content/45 text-xs uppercase tracking-wide">
                  <th>Name</th>
                  <th>Domain</th>
                  <th>Industry</th>
                  <th>Location</th>
                  <th>Contacts</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => (
                  <tr key={c.id} className="border-b border-[var(--border-subtle)] last:border-0 hover:bg-base-200 transition-colors">
                    <td>
                      <div className="flex items-center gap-2.5">
                        <span className="w-7 h-7 rounded-lg bg-base-200 text-base-content/70 flex items-center justify-center shrink-0">
                          <RiBuildingLine size={13} />
                        </span>
                        <Link href={`/companies/${c.id}`} className="font-medium text-base-content hover:text-primary transition-colors cursor-pointer">
                          {c.name}
                        </Link>
                      </div>
                    </td>
                    <td className="text-base-content/55 text-xs">
                      {c.domain ? (
                        <span className="inline-flex items-center gap-1">
                          <RiGlobalLine size={11} /> {c.domain}
                        </span>
                      ) : <span className="text-base-content/30">—</span>}
                    </td>
                    <td className="text-base-content/60 text-xs">{c.industry ?? <span className="text-base-content/30">—</span>}</td>
                    <td className="text-base-content/60 text-xs">{c.location ?? <span className="text-base-content/30">—</span>}</td>
                    <td className="text-base-content/60 text-xs tabular-nums">{c.contact_count}</td>
                    <td>
                      <div className="flex justify-end gap-1">
                        <button
                          className="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-medium text-base-content/50 hover:text-base-content hover:bg-base-200 transition-colors"
                          onClick={() => openEdit(c)}
                        >
                          Edit
                        </button>
                        <button
                          className="inline-flex items-center px-2 py-1 rounded-lg text-xs text-error bg-error/10 hover:bg-error/20 transition-colors"
                          onClick={() => deleteCompany(c.id)}
                        >
                          <RiDeleteBinLine size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {showModal && (
          <div className="modal modal-open">
            <div className="modal-box bg-base-100 border border-[var(--border-subtle)] rounded-2xl shadow-[var(--shadow-modal)] max-w-md">
              <h3 className="text-lg font-semibold mb-4">{editId ? "Edit Company" : "Add Company"}</h3>
              <form onSubmit={submit} className="flex flex-col gap-3">
                <div>
                  <label className="block text-xs font-medium text-base-content/50 pb-1.5">Company name <span className="text-error">*</span></label>
                  <input className="w-full h-10 px-3 rounded-[10px] bg-base-100 border border-[var(--border)] text-sm focus:outline-none focus:border-[var(--border-focus)] transition-colors" placeholder="Acme Inc." value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-base-content/50 pb-1.5">Domain</label>
                    <input className="w-full h-10 px-3 rounded-[10px] bg-base-100 border border-[var(--border)] text-sm focus:outline-none focus:border-[var(--border-focus)] transition-colors" placeholder="acme.com" value={form.domain} onChange={(e) => setForm({ ...form, domain: e.target.value })} />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-base-content/50 pb-1.5">Industry</label>
                    <input className="w-full h-10 px-3 rounded-[10px] bg-base-100 border border-[var(--border)] text-sm focus:outline-none focus:border-[var(--border-focus)] transition-colors" placeholder="SaaS" value={form.industry} onChange={(e) => setForm({ ...form, industry: e.target.value })} />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-base-content/50 pb-1.5">Location</label>
                    <input className="w-full h-10 px-3 rounded-[10px] bg-base-100 border border-[var(--border)] text-sm focus:outline-none focus:border-[var(--border-focus)] transition-colors" placeholder="Berlin, Germany" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-base-content/50 pb-1.5">Website</label>
                    <input className="w-full h-10 px-3 rounded-[10px] bg-base-100 border border-[var(--border)] text-sm focus:outline-none focus:border-[var(--border-focus)] transition-colors" placeholder="https://acme.com" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-base-content/50 pb-1.5">LinkedIn URL</label>
                  <input className="w-full h-10 px-3 rounded-[10px] bg-base-100 border border-[var(--border)] text-sm focus:outline-none focus:border-[var(--border-focus)] transition-colors" placeholder="https://linkedin.com/company/acme" value={form.linkedin_url} onChange={(e) => setForm({ ...form, linkedin_url: e.target.value })} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-base-content/50 pb-1.5">Notes</label>
                  <textarea className="w-full px-3 py-2 rounded-[10px] bg-base-100 border border-[var(--border)] text-sm h-20 resize-none focus:outline-none focus:border-[var(--border-focus)] transition-colors" placeholder="Any notes…" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
                </div>
                <div className="modal-action mt-1">
                  <button type="button" className="inline-flex items-center h-9 px-3.5 rounded-[10px] text-sm font-medium text-base-content/60 hover:text-base-content hover:bg-base-200 transition-colors" onClick={() => setShowModal(false)}>Cancel</button>
                  <button type="submit" className="inline-flex items-center gap-1.5 h-9 px-4 rounded-[10px] text-sm font-semibold bg-primary text-primary-content hover:bg-[var(--primary-hover)] transition-colors disabled:opacity-50" disabled={loading}>
                    {loading ? <span className="loading loading-spinner loading-xs" /> : (editId ? "Save Changes" : "Add Company")}
                  </button>
                </div>
              </form>
            </div>
            <div className="modal-backdrop" onClick={() => setShowModal(false)} />
          </div>
        )}
      </div>
    </>
  );
}
