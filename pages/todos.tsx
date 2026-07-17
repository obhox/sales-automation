import Head from "next/head";
import Link from "next/link";
import { useMemo, useState } from "react";
import type { GetServerSideProps } from "next";
import { RiCheckboxCircleLine, RiCheckboxBlankCircleLine, RiDeleteBinLine } from "react-icons/ri";
import { getDb } from "@/lib/db";
import { workspaceIdFromHeaders } from "@/lib/workspace";

interface TodoWithContact {
  id: string;
  target_id: string;
  title: string;
  description: string | null;
  due_date: string | null;
  status: "open" | "done";
  created_at: string;
  full_name: string | null;
  company: string | null;
}

export const getServerSideProps: GetServerSideProps<{ todos: TodoWithContact[] }> = async ({req}) => {
  const db = getDb();
  const workspaceId=workspaceIdFromHeaders(req.headers);
  const todos = db.prepare(`
    SELECT td.*, t.full_name, t.company
    FROM todos td
    JOIN targets t ON t.id = td.target_id
    WHERE td.workspace_id = ?
    ORDER BY td.status ASC, td.due_date IS NULL, td.due_date, td.created_at DESC
  `).all(workspaceId) as TodoWithContact[];
  return { props: { todos } };
};

export default function TodosPage({ todos: initialTodos }: { todos: TodoWithContact[] }) {
  const [todos, setTodos] = useState(initialTodos);
  const [filter, setFilter] = useState<"open" | "done" | "all">("open");
  const visible = useMemo(() => filter === "all" ? todos : todos.filter((todo) => todo.status === filter), [filter, todos]);

  async function toggle(todo: TodoWithContact) {
    const status = todo.status === "open" ? "done" : "open";
    const response = await fetch(`/api/todos/${todo.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (response.ok) setTodos((current) => current.map((item) => item.id === todo.id ? { ...item, status } : item));
  }

  async function remove(id: string) {
    const response = await fetch(`/api/todos/${id}`, { method: "DELETE" });
    if (response.ok) setTodos((current) => current.filter((todo) => todo.id !== id));
  }

  return (
    <>
      <Head><title>Todos — Linki</title></Head>
      <div className="max-w-3xl space-y-6">
        {/* Page header */}
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <p className="mb-2 text-[13px] font-medium text-base-content/45">Workspace</p>
            <h1 className="text-[30px] font-semibold leading-[1.1] tracking-[-.03em] text-base-content">Todos</h1>
            <p className="mt-2 text-[15px] text-base-content/50">Follow-ups and tasks across every contact.</p>
          </div>
          <div className="flex items-center gap-0.5 rounded-[10px] bg-base-200 p-1">
            {(["open", "done", "all"] as const).map((value) => (
              <button
                key={value}
                onClick={() => setFilter(value)}
                className={`rounded-[7px] px-3 py-1.5 text-xs font-medium capitalize transition-all ${
                  filter === value
                    ? "border border-[var(--border-subtle)] bg-base-100 text-base-content shadow-[var(--shadow-raised)]"
                    : "text-base-content/40 hover:text-base-content/70"
                }`}
              >
                {value}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          {visible.length === 0 ? (
            <div className="rounded-2xl border border-[var(--border-subtle)] bg-base-100 px-6 py-16 text-center text-sm text-base-content/35 shadow-[var(--shadow-raised)]">
              No {filter === "all" ? "" : filter} todos.
            </div>
          ) : visible.map((todo) => (
            <div key={todo.id} className="flex items-start gap-3 rounded-2xl border border-[var(--border-subtle)] bg-base-100 px-5 py-4 shadow-[var(--shadow-raised)] transition-colors hover:border-[var(--border)]">
              <button onClick={() => toggle(todo)} className={todo.status === "done" ? "mt-0.5 text-success" : "mt-0.5 text-base-content/30 hover:text-success transition-colors"}>
                {todo.status === "done" ? <RiCheckboxCircleLine size={18} /> : <RiCheckboxBlankCircleLine size={18} />}
              </button>
              <div className="min-w-0 flex-1">
                <div className={`text-sm font-medium ${todo.status === "done" ? "text-base-content/35 line-through" : "text-base-content"}`}>{todo.title}</div>
                {todo.description && <p className="mt-1 whitespace-pre-wrap text-xs text-base-content/45">{todo.description}</p>}
                <div className="mt-2 flex gap-2 text-xs text-base-content/40">
                  <Link href={`/contacts/${todo.target_id}`} className="transition-colors hover:text-base-content">{todo.full_name || "Contact"}{todo.company ? ` · ${todo.company}` : ""}</Link>
                  {todo.due_date && <span>Due {new Date(`${todo.due_date}T00:00:00`).toLocaleDateString()}</span>}
                </div>
              </div>
              <button onClick={() => remove(todo.id)} className="p-1 text-base-content/20 transition-colors hover:text-error"><RiDeleteBinLine size={15} /></button>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
