import { useState } from "react";
import { useTranslations } from "next-intl";
import { Alert, Button, Dialog, Field, Input } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { INTEGRATION_ICON } from "./IntegrationGlyph";
import { CONNECTIONS_PATH, KEYS_PATH, connectionSettings, settingsProblem, type ConnectionRow, type Integration } from "./model";

/**
 * Connect an integration, or change one that is connected. A token or key typed here is
 * sent once and never comes back: when changing a connection the field starts empty, and
 * left empty it keeps what is saved. Mounted only while open.
 */
export function ConnectDialog({ integration, connection, replacingKey, onClose, onSaved }: {
  integration: Integration;
  /** The connection being changed. Null: a new one. */
  connection: ConnectionRow | null;
  /** True when a provider key is already saved and this replaces it. */
  replacingKey?: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const t = useTranslations("IntegrationsConnect");
  const saved = connection ? connectionSettings(connection) : {};
  const [name, setName] = useState(connection?.name ?? integration.name);
  const [secret, setSecret] = useState("");
  // A saved feed address comes back as its host only, so it is not put in the field to be sent back.
  const [values, setValues] = useState<Record<string, string>>(Object.fromEntries(integration.settings.map((setting) => [setting.key, setting.key === "url" ? "" : saved[setting.key] ?? ""])));
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<{ field: string; message: string } | null>(null);
  const editing = Boolean(connection);
  const isKey = integration.kind === "key";

  async function save() {
    if (!isKey && !name.trim()) return setProblem({ field: "name", message: t("nameRequired") });
    const found = settingsProblem(integration, values, secret, editing);
    if (found) return setProblem(found);
    setSaving(true);
    setProblem(null);
    try {
      if (isKey) {
        await api(KEYS_PATH, { method: "POST", body: { key: integration.id, api_key: secret.trim() } });
        onSaved(replacingKey ? t("keyReplaced", {name: integration.name}) : t("connected", {name: integration.name}));
      } else {
        const settings = Object.fromEntries(integration.settings.map((setting) => [setting.key, (values[setting.key] ?? "").trim()]));
        if (connection) {
          // An empty feed address means "keep the one saved": it is left out rather than cleared.
          const changed = Object.fromEntries(Object.entries(settings).filter(([key, value]) => !(key === "url" && !value)));
          await api(CONNECTIONS_PATH, { method: "PATCH", body: { id: connection.id, name: name.trim(), config_merge: changed, ...(secret.trim() ? { secret: secret.trim() } : {}) } });
          onSaved(t("updated", {name: name.trim()}));
        } else {
          const config = Object.fromEntries(Object.entries(settings).filter(([, value]) => value));
          await api(CONNECTIONS_PATH, { method: "POST", body: { provider: integration.id, name: name.trim(), config, ...(secret.trim() ? { secret: secret.trim() } : {}) } });
          onSaved(t("connectedSync", {name: name.trim()}));
        }
      }
      onClose();
    } catch (cause) {
      const message = errorMessage(cause);
      // The server looks an address up before it saves one. What it says about the address belongs beside that field.
      const addressField = integration.settings.find((setting) => setting.key === "url" || setting.key === "instance_url")?.key;
      setProblem({ field: addressField && /address|instance URL/i.test(message) ? addressField : "form", message });
    } finally {
      setSaving(false);
    }
  }

  const error = (field: string) => (problem?.field === field ? problem.message : null);
  return (
    <Dialog
      open
      onOpenChange={(next) => (next || saving ? undefined : onClose())}
      size="sm"
      icon={INTEGRATION_ICON[integration.icon]}
      title={editing ? t("change", {name: connection?.name ?? integration.name}) : replacingKey ? t("replaceTitle", {name: integration.name}) : t("connectTitle", {name: integration.name})}
      description={integration.purpose}
      footer={
        <>
          <span />
          <div className="flex items-center gap-2">
            <Button onClick={onClose} disabled={saving}>{t("cancel")}</Button>
            <Button variant="primary" loading={saving} onClick={() => void save()}>{editing ? t("save") : replacingKey ? t("replace") : t("connect")}</Button>
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
        {!editing ? <p className="text-115 leading-[17px] text-ink-2">{integration.about}</p> : null}
        {!isKey ? (
          <Field label={t("name")} error={error("name")} hint={t("nameHint")}>
            {(id) => <Input id={id} maxLength={80} value={name} invalid={Boolean(error("name"))} onChange={(event) => setName(event.target.value)} />}
          </Field>
        ) : null}
        {integration.secret ? (
          <Field label={integration.secret.label} error={error("secret")} hint={editing ? t("keepSecret") : integration.secret.hint}>
            {(id) => (
              <Input
                id={id} data-autofocus type="password" autoComplete="off" spellCheck={false} className="font-mono text-11"
                placeholder={editing ? t("secretPlaceholder") : integration.secret?.placeholder}
                value={secret} invalid={Boolean(error("secret"))} onChange={(event) => setSecret(event.target.value)}
              />
            )}
          </Field>
        ) : null}
        {integration.settings.map((setting, index) => {
          const keptAddress = editing && setting.key === "url" ? saved.url : null;
          return (
            <Field key={setting.key} label={setting.label} aside={setting.required ? undefined : t("optional")} error={error(setting.key)} hint={keptAddress ? t("savedAddress", {address: keptAddress}) : setting.hint}>
              {(id) => (
                <Input
                  id={id} data-autofocus={!integration.secret && index === 0 ? true : undefined} autoComplete="off" spellCheck={false}
                  placeholder={keptAddress ? t("replaceAddress") : setting.placeholder}
                  value={values[setting.key] ?? ""} invalid={Boolean(error(setting.key))}
                  onChange={(event) => setValues((current) => ({ ...current, [setting.key]: event.target.value }))}
                />
              )}
            </Field>
          );
        })}
        {/* Enter sends a form only if it has a submit button; the visible ones are in the footer. */}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
