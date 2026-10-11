import { useState } from "react";
import { KeyRound, Pencil } from "lucide-react";
import { Alert, Button, Checkbox, CodeBlock, Dialog, Field, Input, Select } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { SecretOnce } from "./parts";
import { EXPIRY_CHOICES, KEYS_PATH, MAX_RATE_LIMIT, SCOPES, expiryFor, readRateLimit, type ApiKeyRow, type ExpiryChoice } from "./model";

interface Created {
  id: string;
  key: string;
  prefix: string;
  scopes: string[];
  rate_limit_per_minute: number | null;
}

function LimitField({ value, onChange, error }: { value: string; onChange: (value: string) => void; error: string | null }) {
  return (
    <Field label="Rate limit" aside="Optional" error={error} hint={`The most requests this key may make in a minute, up to ${MAX_RATE_LIMIT.toLocaleString("en-US")}. Past it, requests get a 429 until the minute moves on. Empty means no limit.`}>
      {(id) => (
        <Input
          id={id} inputMode="numeric" placeholder="No limit" value={value} invalid={Boolean(error)} className="w-[180px]"
          onChange={(event) => onChange(event.target.value.replace(/[^\d]/g, ""))}
          trailing={<span className="shrink-0 pr-1 text-105 text-ink-3">a minute</span>}
        />
      )}
    </Field>
  );
}

/** Make a key. It is shown here once, in full; after that only its first characters are kept. */
export function CreateKeyDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [expiry, setExpiry] = useState<ExpiryChoice>("90");
  const [limit, setLimit] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<{ field: "name" | "scopes" | "limit" | "form"; message: string } | null>(null);
  const [created, setCreated] = useState<Created | null>(null);

  function close() {
    setName("");
    setScopes([]);
    setExpiry("90");
    setLimit("");
    setProblem(null);
    setCreated(null);
    onClose();
  }

  async function create() {
    if (!name.trim()) return setProblem({ field: "name", message: "Give the key a name that says what uses it." });
    if (scopes.length === 0) return setProblem({ field: "scopes", message: "Choose at least one thing the key may do." });
    const rate = readRateLimit(limit);
    if (rate.error) return setProblem({ field: "limit", message: rate.error });
    setSaving(true);
    setProblem(null);
    try {
      setCreated(await api<Created>(KEYS_PATH, { method: "POST", body: { name: name.trim(), scopes, expires_at: expiryFor(expiry), rate_limit_per_minute: rate.value } }));
      onCreated();
    } catch (cause) {
      setProblem({ field: "form", message: errorMessage(cause) });
    } finally {
      setSaving(false);
    }
  }

  const toggle = (scope: string, on: boolean) => setScopes((current) => (on ? [...current.filter((item) => item !== scope), scope] : current.filter((item) => item !== scope)));

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next || saving ? undefined : close())}
      icon={KeyRound}
      title={created ? "Your new API key" : "Create an API key"}
      description={created ? name.trim() : "For your own code or an integration"}
      footer={
        created ? (
          <>
            <span className="text-105 text-ink-3">Only its first characters are kept from here on.</span>
            <Button variant="primary" onClick={close}>I have copied it</Button>
          </>
        ) : (
          <>
            <span className="text-105 text-ink-3">{scopes.length === 0 ? "No scopes chosen" : `${scopes.length} of ${SCOPES.length} scopes`}</span>
            <div className="flex items-center gap-2">
              <Button onClick={close} disabled={saving}>Cancel</Button>
              <Button variant="primary" loading={saving} onClick={() => void create()}>Create key</Button>
            </div>
          </>
        )
      }
    >
      {created ? (
        <div className="flex flex-col gap-3.5">
          <Alert tone="warn" title="Copy the key now">This is the only time it is shown. If it is lost, revoke it and create another.</Alert>
          <Field label="API key">{() => <SecretOnce value={created.key} label="API key" />}</Field>
          <Field label="Try it" hint="Send the key as a Bearer token on every request to /api/v1.">
            {() => <CodeBlock code={`curl ${window.location.origin}/api/v1/contacts \\\n  -H "Authorization: Bearer ${created.key}"`} caption="Lists contacts, if the key may read them" />}
          </Field>
        </div>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          {problem?.field === "form" ? <Alert tone="bad">{problem.message}</Alert> : null}
          <Field label="Name" error={problem?.field === "name" ? problem.message : null}>
            {(id) => <Input id={id} data-autofocus maxLength={80} placeholder="Production backend" value={name} invalid={problem?.field === "name"} onChange={(event) => setName(event.target.value)} />}
          </Field>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-105 font-semibold text-ink-2">What it may do</legend>
            <div className="grid grid-cols-1 gap-x-4 gap-y-px sm:grid-cols-2">
              {SCOPES.map((item) => {
                const id = `scope-${item.scope}`;
                return (
                  <label key={item.scope} htmlFor={id} className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1.5 hover:bg-subtle">
                    <Checkbox id={id} className="mt-px" checked={scopes.includes(item.scope)} onChange={(on) => toggle(item.scope, on)} />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-115 font-medium text-ink">{item.label} <span className="font-mono text-10 font-normal text-ink-3">{item.scope}</span></span>
                      <span className="text-105 leading-[14px] text-ink-3">{item.detail}</span>
                    </span>
                  </label>
                );
              })}
            </div>
            {problem?.field === "scopes" ? <p className="text-105 text-bad" role="alert">{problem.message}</p> : null}
          </fieldset>
          <div className="flex flex-wrap items-start gap-x-6 gap-y-4">
            <Field label="Expires" hint="A key that expires limits the harm if it leaks.">
              {(id) => <Select id={id} className="w-[180px]" value={expiry} onChange={setExpiry} options={EXPIRY_CHOICES.map((choice) => ({ value: choice.value, label: choice.label }))} />}
            </Field>
            <LimitField value={limit} onChange={setLimit} error={problem?.field === "limit" ? problem.message : null} />
          </div>
          {/* Enter sends a form only if it has a submit button; the visible ones are in the footer. */}
          <button type="submit" hidden />
        </form>
      )}
    </Dialog>
  );
}

/**
 * Change a key's name or its rate limit. What it may do cannot be changed: make a new key
 * for that. Mounted only while a key is being changed, so it starts from that key's values.
 */
export function EditKeyDialog({ apiKey, onClose, onSaved }: { apiKey: ApiKeyRow; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(apiKey.name);
  const [limit, setLimit] = useState(apiKey.rate_limit_per_minute ? String(apiKey.rate_limit_per_minute) : "");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<{ field: "name" | "limit" | "form"; message: string } | null>(null);

  async function save() {
    if (!name.trim()) return setProblem({ field: "name", message: "A key needs a name." });
    const rate = readRateLimit(limit);
    if (rate.error) return setProblem({ field: "limit", message: rate.error });
    setSaving(true);
    setProblem(null);
    try {
      await api(KEYS_PATH, { method: "PATCH", body: { id: apiKey.id, name: name.trim(), rate_limit_per_minute: rate.value } });
      onSaved();
      onClose();
    } catch (cause) {
      setProblem({ field: "form", message: errorMessage(cause) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => (next || saving ? undefined : onClose())}
      size="sm"
      icon={Pencil}
      title="Change this key"
      description="Its scopes and expiry stay as they are"
      footer={
        <>
          <span />
          <div className="flex items-center gap-2">
            <Button onClick={onClose} disabled={saving}>Cancel</Button>
            <Button variant="primary" loading={saving} onClick={() => void save()}>Save</Button>
          </div>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {problem?.field === "form" ? <Alert tone="bad">{problem.message}</Alert> : null}
        <Field label="Name" error={problem?.field === "name" ? problem.message : null}>
          {(id) => <Input id={id} data-autofocus maxLength={80} value={name} invalid={problem?.field === "name"} onChange={(event) => setName(event.target.value)} />}
        </Field>
        <LimitField value={limit} onChange={setLimit} error={problem?.field === "limit" ? problem.message : null} />
        {/* Enter sends a form only if it has a submit button; the visible ones are in the footer. */}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
