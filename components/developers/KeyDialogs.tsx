import { useState } from "react";
import { useTranslations } from "next-intl";
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
  const t = useTranslations("DeveloperKeysDialog");
  return (
    <Field label={t("rateLimit")} aside={t("optional")} error={error} hint={t("rateHint", {count: MAX_RATE_LIMIT})}>
      {(id) => (
        <Input
          id={id} inputMode="numeric" placeholder={t("noLimit")} value={value} invalid={Boolean(error)} className="w-[180px]"
          onChange={(event) => onChange(event.target.value.replace(/[^\d]/g, ""))}
          trailing={<span className="shrink-0 pr-1 text-105 text-ink-3">{t("perMinute")}</span>}
        />
      )}
    </Field>
  );
}

/** Make a key. It is shown here once, in full; after that only its first characters are kept. */
export function CreateKeyDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const t = useTranslations("DeveloperKeysDialog");
  const scopeNames: Record<string, {label: string; detail: string}> = {
    "contacts:read": {label: t("scope_contacts_read"), detail: t("detail_contacts_read")},
    "contacts:write": {label: t("scope_contacts_write"), detail: t("detail_contacts_write")},
    "campaigns:read": {label: t("scope_campaigns_read"), detail: t("detail_campaigns_read")},
    "campaigns:write": {label: t("scope_campaigns_write"), detail: t("detail_campaigns_write")},
    "events:read": {label: t("scope_events_read"), detail: t("detail_events_read")},
    "events:write": {label: t("scope_events_write"), detail: t("detail_events_write")},
    "signals:write": {label: t("scope_signals_write"), detail: t("detail_signals_write")},
    "crm:read": {label: t("scope_crm_read"), detail: t("detail_crm_read")},
    "crm:write": {label: t("scope_crm_write"), detail: t("detail_crm_write")},
    "email:read": {label: t("scope_email_read"), detail: t("detail_email_read")},
    "email:send": {label: t("scope_email_send"), detail: t("detail_email_send")},
    "mcp:read": {label: t("scope_mcp_read"), detail: t("detail_mcp_read")},
    "mcp:write": {label: t("scope_mcp_write"), detail: t("detail_mcp_write")},
    "mcp:execute": {label: t("scope_mcp_execute"), detail: t("detail_mcp_execute")},
  };
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
    if (!name.trim()) return setProblem({ field: "name", message: t("nameRequired") });
    if (scopes.length === 0) return setProblem({ field: "scopes", message: t("scopesRequired") });
    const rate = readRateLimit(limit);
    if (rate.error) return setProblem({ field: "limit", message: t("limitError", {limit: MAX_RATE_LIMIT}) });
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
      title={created ? t("newTitle") : t("createTitle")}
      description={created ? name.trim() : t("createDescription")}
      footer={
        created ? (
          <>
            <span className="text-105 text-ink-3">{t("onlyPrefix")}</span>
            <Button variant="primary" onClick={close}>{t("copiedKey")}</Button>
          </>
        ) : (
          <>
            <span className="text-105 text-ink-3">{scopes.length === 0 ? t("noneChosen") : t("scopesCount", {count: scopes.length, total: SCOPES.length})}</span>
            <div className="flex items-center gap-2">
              <Button onClick={close} disabled={saving}>{t("cancel")}</Button>
              <Button variant="primary" loading={saving} onClick={() => void create()}>{t("create")}</Button>
            </div>
          </>
        )
      }
    >
      {created ? (
        <div className="flex flex-col gap-3.5">
          <Alert tone="warn" title={t("copyWarning")}>{t("copyWarningHint")}</Alert>
          <Field label={t("apiKey")}>{() => <SecretOnce value={created.key} label={t("apiKey")} />}</Field>
          <Field label={t("try")} hint={t("tryHint")}>
            {() => <CodeBlock code={`curl ${window.location.origin}/api/v1/contacts \\\n  -H "Authorization: Bearer ${created.key}"`} caption={t("tryCaption")} />}
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
          <Field label={t("name")} error={problem?.field === "name" ? problem.message : null}>
            {(id) => <Input id={id} data-autofocus maxLength={80} placeholder="Production backend" value={name} invalid={problem?.field === "name"} onChange={(event) => setName(event.target.value)} />}
          </Field>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-105 font-semibold text-ink-2">{t("whatCan")}</legend>
            <div className="grid grid-cols-1 gap-x-4 gap-y-px sm:grid-cols-2">
              {SCOPES.map((item) => {
                const id = `scope-${item.scope}`;
                return (
                  <label key={item.scope} htmlFor={id} className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1.5 hover:bg-subtle">
                    <Checkbox id={id} className="mt-px" checked={scopes.includes(item.scope)} onChange={(on) => toggle(item.scope, on)} />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-115 font-medium text-ink">{(scopeNames[item.scope] ?? item).label} <span className="font-mono text-10 font-normal text-ink-3">{item.scope}</span></span>
                      <span className="text-105 leading-[14px] text-ink-3">{(scopeNames[item.scope] ?? item).detail}</span>
                    </span>
                  </label>
                );
              })}
            </div>
            {problem?.field === "scopes" ? <p className="text-105 text-bad" role="alert">{problem.message}</p> : null}
          </fieldset>
          <div className="flex flex-wrap items-start gap-x-6 gap-y-4">
            <Field label={t("expires")} hint={t("expiresHint")}>
              {(id) => <Select id={id} className="w-[180px]" value={expiry} onChange={setExpiry} options={EXPIRY_CHOICES.map((choice) => ({ value: choice.value, label: t(choice.value === "never" ? "never" : choice.value === "30" ? "30Days" : choice.value === "90" ? "90Days" : "1Year") }))} />}
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
  const t = useTranslations("DeveloperKeysDialog");
  const [name, setName] = useState(apiKey.name);
  const [limit, setLimit] = useState(apiKey.rate_limit_per_minute ? String(apiKey.rate_limit_per_minute) : "");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<{ field: "name" | "limit" | "form"; message: string } | null>(null);

  async function save() {
    if (!name.trim()) return setProblem({ field: "name", message: t("editNameRequired") });
    const rate = readRateLimit(limit);
    if (rate.error) return setProblem({ field: "limit", message: t("limitError", {limit: MAX_RATE_LIMIT}) });
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
      title={t("editTitle")}
      description={t("editDescription")}
      footer={
        <>
          <span />
          <div className="flex items-center gap-2">
            <Button onClick={onClose} disabled={saving}>{t("cancel")}</Button>
            <Button variant="primary" loading={saving} onClick={() => void save()}>{t("save")}</Button>
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
        <Field label={t("name")} error={problem?.field === "name" ? problem.message : null}>
          {(id) => <Input id={id} data-autofocus maxLength={80} value={name} invalid={problem?.field === "name"} onChange={(event) => setName(event.target.value)} />}
        </Field>
        <LimitField value={limit} onChange={setLimit} error={problem?.field === "limit" ? problem.message : null} />
        {/* Enter sends a form only if it has a submit button; the visible ones are in the footer. */}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
