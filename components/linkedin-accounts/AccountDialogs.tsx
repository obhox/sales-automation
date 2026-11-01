import { useState } from "react";
import {useTranslations} from "next-intl";
import { toast } from "sonner";
import { Alert, Button, Dialog, Field, Input, Segmented } from "@/components/ui";
import { ApiError, api, errorMessage } from "@/lib/client/api";
import type { LinkedinAccountView } from "./model";

// ── Test an action ────────────────────────────────────────────────────────────

type TestAction = "session" | "inspect" | "visit";

interface TestOutcome {
  ok: boolean;
  action: string;
  outcome: string;
  detail?: unknown;
}

const DETAIL_LABELS: Record<string, string> = {
  name: "Name", degree: "Degree", relation: "Relation", found_via: "Read from", can_invite: "Can be invited",
  invite_blocked: "Invitation blocked", can_message: "Can be messaged", url: "Profile",
};

/**
 * Run one thing through the real automation, on the live account, and show what LinkedIn
 * answered. Only the actions that send nothing are offered here; real sends stay with the
 * API, where each one needs an explicit confirmation.
 */
export function TestActionDialog({ account, onClose, onChanged }: { account: LinkedinAccountView | null; onClose: () => void; onChanged: () => void }) {
  const t = useTranslations("LinkedinAccountDialogs");
  return (
    <Dialog open={account !== null} onOpenChange={(open) => { if (!open) onClose(); }} title={t("testTitle")} description={account ? t("testDescription", {name: account.name}) : undefined} size="sm">
      {account ? <TestForm key={account.id} account={account} onChanged={onChanged} /> : null}
    </Dialog>
  );
}

function TestForm({ account, onChanged }: { account: LinkedinAccountView; onChanged: () => void }) {
  const t = useTranslations("LinkedinAccountDialogs");
  const [action, setAction] = useState<TestAction>("session");
  const [url, setUrl] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<TestOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const needsUrl = action !== "session";

  async function run() {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api<TestOutcome>(`/api/accounts/${account.id}/test`, { method: "POST", body: needsUrl ? { action, url: url.trim() } : { action } }));
    } catch (cause) {
      // A refusal still carries what LinkedIn showed (signed out, for one).
      const payload = cause instanceof ApiError ? (cause.body as Partial<TestOutcome> | null) : null;
      if (payload && typeof payload.outcome === "string") setResult({ ok: false, action, outcome: payload.outcome, detail: payload.detail });
      else setError(errorMessage(cause));
    } finally {
      setRunning(false);
      onChanged();
    }
  }

  const detail = result?.detail && typeof result.detail === "object" ? Object.entries(result.detail as Record<string, unknown>).filter(([key]) => key in DETAIL_LABELS) : [];

  return (
    <form
      className="flex flex-col gap-3.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!running && (!needsUrl || url.trim())) void run();
      }}
    >
      <Segmented
        label={t("action")} value={action} onChange={(next) => { setAction(next); setResult(null); setError(null); }}
        options={[{ value: "session", label: t("checkSession") }, { value: "inspect", label: t("inspect") }, { value: "visit", label: t("visit") }]}
      />
      <p className="text-11 leading-4 text-ink-2">
        {action === "session"
          ? t("sessionHelp")
          : action === "inspect"
            ? t("inspectHelp")
            : t("visitHelp")}
      </p>
      {needsUrl ? (
        <Field label={t("profileAddress")}>
          {(id) => <Input id={id} value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://www.linkedin.com/in/…" autoComplete="off" spellCheck={false} required />}
        </Field>
      ) : null}

      {result ? (
        <Alert tone={result.ok ? "good" : "bad"} title={t.has(`outcomes.${result.outcome}`) ? t(`outcomes.${result.outcome}`) : result.outcome.replace(/_/g, " ")}>
          {detail.length > 0 ? (
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
              {detail.map(([key, value]) => (
                <div key={key} className="contents">
                  <dt className="text-ink-3">{t.has(`details.${key}`) ? t(`details.${key}`) : DETAIL_LABELS[key]}</dt>
                  <dd className="truncate text-ink">{typeof value === "boolean" ? (value ? t("yes") : t("no")) : value == null ? "—" : String(value)}</dd>
                </div>
              ))}
            </dl>
          ) : typeof result.detail === "string" ? (
            result.detail
          ) : null}
        </Alert>
      ) : null}
      {error ? <Alert tone="bad">{error}</Alert> : null}

      <div className="flex justify-end">
        <Button type="submit" variant="primary" loading={running} disabled={needsUrl && !url.trim()}>
          {running ? t("asking") : t("run")}
        </Button>
      </div>
    </form>
  );
}

// ── Delete ────────────────────────────────────────────────────────────────────

/** Deleting takes the account's campaign run history with it, so the name has to be typed. */
export function DeleteAccountDialog({ account, onClose, onDeleted }: { account: LinkedinAccountView | null; onClose: () => void; onDeleted: () => void }) {
  const t = useTranslations("LinkedinAccountDialogs");
  return (
    <Dialog open={account !== null} onOpenChange={(open) => { if (!open) onClose(); }} title={t("deleteTitle")} size="sm">
      {account ? <DeleteForm key={account.id} account={account} onClose={onClose} onDeleted={onDeleted} /> : null}
    </Dialog>
  );
}

function DeleteForm({ account, onClose, onDeleted }: { account: LinkedinAccountView; onClose: () => void; onDeleted: () => void }) {
  const t = useTranslations("LinkedinAccountDialogs");
  const [typed, setTyped] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = typed.trim() === account.name;

  async function remove() {
    setDeleting(true);
    setError(null);
    try {
      await api(`/api/accounts/${account.id}`, { method: "DELETE" });
      toast.success(t("deleted", {name: account.name}));
      onDeleted();
      onClose();
    } catch (cause) {
      const payload = cause instanceof ApiError ? (cause.body as { message?: string; campaigns?: Array<{ name: string }> } | null) : null;
      const names = (payload?.campaigns ?? []).map((campaign) => campaign.name).join(", ");
      setError(payload?.message ? `${payload.message}${names ? ` (${names})` : ""}` : errorMessage(cause));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-3.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (matches && !deleting) void remove();
      }}
    >
      <p className="text-12 leading-[18px] text-ink-2">
        {t("deleteHelp", {name: account.name})}
      </p>
      <Field label={t("confirmName", {name: account.name})}>
        {(id) => <Input id={id} value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" data-autofocus />}
      </Field>
      {error ? <Alert tone="bad">{error}</Alert> : null}
      <div className="flex justify-end gap-2.5">
        <Button variant="secondary" onClick={onClose}>{t("cancel")}</Button>
        <Button type="submit" variant="danger" loading={deleting} disabled={!matches}>{t("delete")}</Button>
      </div>
    </form>
  );
}
