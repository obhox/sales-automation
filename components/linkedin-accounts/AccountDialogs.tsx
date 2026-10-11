import { useState } from "react";
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

const OUTCOME_WORDS: Record<string, string> = {
  signed_in: "Signed in to LinkedIn",
  signed_out: "Signed out of LinkedIn",
  connected: "Already a connection",
  pending: "An invitation is pending",
  connectable: "Can be invited",
  unavailable: "LinkedIn offers no way to invite this member",
  visited: "Profile visited",
  paused: "The account is paused",
};

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
  return (
    <Dialog open={account !== null} onOpenChange={(open) => { if (!open) onClose(); }} title="Test an action" description={account ? `On ${account.name}, through the same code a campaign uses` : undefined} size="sm">
      {account ? <TestForm key={account.id} account={account} onChanged={onChanged} /> : null}
    </Dialog>
  );
}

function TestForm({ account, onChanged }: { account: LinkedinAccountView; onChanged: () => void }) {
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
        label="Action" value={action} onChange={(next) => { setAction(next); setResult(null); setError(null); }}
        options={[{ value: "session", label: "Check session" }, { value: "inspect", label: "Read a profile" }, { value: "visit", label: "Visit a profile" }]}
      />
      <p className="text-11 leading-4 text-ink-2">
        {action === "session"
          ? "Opens LinkedIn's feed with the stored session. If LinkedIn asks for a sign-in instead, the account is marked as needing one."
          : action === "inspect"
            ? "Opens the profile and reports what the automation reads there: connection degree, and whether the member can be invited or messaged. Nothing is sent."
            : "Opens the profile and scrolls it as a campaign's visit step does. The member may see that this account viewed them."}
      </p>
      {needsUrl ? (
        <Field label="Profile address">
          {(id) => <Input id={id} value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://www.linkedin.com/in/…" autoComplete="off" spellCheck={false} required />}
        </Field>
      ) : null}

      {result ? (
        <Alert tone={result.ok ? "good" : "bad"} title={OUTCOME_WORDS[result.outcome] ?? result.outcome.replace(/_/g, " ")}>
          {detail.length > 0 ? (
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
              {detail.map(([key, value]) => (
                <div key={key} className="contents">
                  <dt className="text-ink-3">{DETAIL_LABELS[key]}</dt>
                  <dd className="truncate text-ink">{typeof value === "boolean" ? (value ? "Yes" : "No") : value == null ? "—" : String(value)}</dd>
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
          {running ? "Asking LinkedIn" : "Run"}
        </Button>
      </div>
    </form>
  );
}

// ── Delete ────────────────────────────────────────────────────────────────────

/** Deleting takes the account's campaign run history with it, so the name has to be typed. */
export function DeleteAccountDialog({ account, onClose, onDeleted }: { account: LinkedinAccountView | null; onClose: () => void; onDeleted: () => void }) {
  return (
    <Dialog open={account !== null} onOpenChange={(open) => { if (!open) onClose(); }} title="Delete this LinkedIn account" size="sm">
      {account ? <DeleteForm key={account.id} account={account} onClose={onClose} onDeleted={onDeleted} /> : null}
    </Dialog>
  );
}

function DeleteForm({ account, onClose, onDeleted }: { account: LinkedinAccountView; onClose: () => void; onDeleted: () => void }) {
  const [typed, setTyped] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = typed.trim() === account.name;

  async function remove() {
    setDeleting(true);
    setError(null);
    try {
      await api(`/api/accounts/${account.id}`, { method: "DELETE" });
      toast.success(`${account.name} was deleted`);
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
        This removes <span className="font-semibold text-ink">{account.name}</span>, its stored session and the run history of every campaign it sent for. It cannot be undone. To stop using the account and keep its history, disconnect or pause it instead.
      </p>
      <Field label={`Type ${account.name} to confirm`}>
        {(id) => <Input id={id} value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" data-autofocus />}
      </Field>
      {error ? <Alert tone="bad">{error}</Alert> : null}
      <div className="flex justify-end gap-2.5">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="danger" loading={deleting} disabled={!matches}>Delete account</Button>
      </div>
    </form>
  );
}
