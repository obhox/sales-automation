import { useState } from "react";
import { BrainCircuit, KeyRound, Lock } from "lucide-react";
import { toast } from "sonner";
import { Alert, Button, Card, Dialog, Field, Input, Pill, TextAction } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { formatDate, formatRelative } from "@/lib/client/format";
import { ModelSelect } from "./ModelSelect";
import { Captioned } from "./parts";
import { lastUsed, priceLine, type AiOverview, type Draft, type ModelInfo } from "./model";

/** The provider the workspace writes through: its key, and the two models every step falls back on. */
export function ProviderCard({
  overview,
  draft,
  onDraft,
  models,
  modelsError,
  canEdit,
  onKeyChanged,
}: {
  overview: AiOverview;
  draft: Draft;
  onDraft: (patch: Partial<Draft>) => void;
  models: ModelInfo[];
  /** Why the model list is not there, when it is not. */
  modelsError: string | null;
  canEdit: boolean;
  onKeyChanged: () => void;
}) {
  const [keyOpen, setKeyOpen] = useState(false);
  const { provider, usage } = overview;
  const find = (id: string | null) => models.find((model) => model.id === id);
  const unavailable = provider.connected ? modelsError ?? "The model list is loading." : "Add an OpenRouter key to see the models it can use.";
  const fallbackCount = usage.fallback_requests;

  return (
    <Card className="flex flex-col gap-3.5 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-[11px]">
          <span className="inline-flex size-[34px] shrink-0 items-center justify-center rounded-[9px] bg-brand-tint text-brand" aria-hidden="true">
            <BrainCircuit size={18} />
          </span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 className="text-15 font-semibold tracking-[-0.15px] text-ink">OpenRouter</h2>
            <p className="truncate text-11 text-ink-3">Your own key · every model on the network is available</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-[9px]">
          {provider.connected ? <Pill tone="good" dot>Connected</Pill> : <Pill tone="neutral" dot>No key yet</Pill>}
          {canEdit && provider.connected ? <TextAction onClick={() => setKeyOpen(true)}>Rotate key</TextAction> : null}
        </div>
      </div>

      {!provider.connected ? (
        <Alert tone="info" title="Nothing is written by AI until a key is added" actions={canEdit ? <Button size="xs" variant="primary" icon={KeyRound} onClick={() => setKeyOpen(true)}>Add an OpenRouter key</Button> : undefined}>
          Steps set to be written by AI are skipped, and replies are sorted by fixed rules only. {canEdit ? "A key from openrouter.ai/keys is all it takes." : "An admin adds the key."}
        </Alert>
      ) : null}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_230px_230px]">
        <Captioned
          label="API key"
          hint={provider.connected
            ? `Encrypted at rest · ${lastUsed(usage.last_used_at, (date) => formatRelative(date))}${provider.key_updated_at ? ` · set ${formatDate(provider.key_updated_at)}` : ""}`
            : "Stored encrypted. It is never shown again after it is saved."}
        >
          {(id) => (
            <Input
              id={id} readOnly value={provider.key_hint ?? ""} placeholder="Not set" frameClassName="h-[34px]" className="font-mono text-11 font-medium"
              trailing={<Lock size={14} className="shrink-0 text-ink-3" aria-hidden="true" />}
            />
          )}
        </Captioned>

        <Captioned label="Default model" hint={priceLine(find(draft.default_model)) ?? "Writes any step with no model of its own, and sorts replies"}>
          {(id) => (
            <ModelSelect id={id} value={draft.default_model} onChange={(model) => onDraft({ default_model: model })} models={models} unavailable={unavailable} disabled={!canEdit} none={draft.default_model ? "No default model" : undefined} />
          )}
        </Captioned>

        <Captioned
          label="Fallback model"
          hint={
            draft.fallback_model
              ? `${priceLine(find(draft.fallback_model)) ?? "Used when a model is rate-limited or unavailable"}${fallbackCount > 0 ? ` · answered ${fallbackCount.toLocaleString("en-US")} ${fallbackCount === 1 ? "time" : "times"} this month` : ""}`
              : "Used when a model is rate-limited or unavailable"
          }
        >
          {(id) => <ModelSelect id={id} value={draft.fallback_model} onChange={(model) => onDraft({ fallback_model: model })} models={models} unavailable={unavailable} disabled={!canEdit} none="No fallback" />}
        </Captioned>
      </div>

      {provider.connected && modelsError ? <p className="text-105 text-bad" role="alert">The model list could not be loaded: {modelsError}</p> : null}

      <KeyDialog open={keyOpen} replacing={provider.connected} onClose={() => setKeyOpen(false)} onSaved={onKeyChanged} />
    </Card>
  );
}

/** Add the provider key, or put a new one in place of the old. The key is sent once and never read back. */
function KeyDialog({ open, replacing, onClose, onSaved }: { open: boolean; replacing: boolean; onClose: () => void; onSaved: () => void }) {
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    setKey("");
    setError(null);
    onClose();
  };

  async function save() {
    const clean = key.trim();
    if (!clean) return setError("Paste the key first.");
    if (/\s/.test(clean)) return setError("A key has no spaces in it. Paste it again.");
    setSaving(true);
    setError(null);
    try {
      await api("/api/integrations", { method: "POST", body: { key: "openrouter", api_key: clean } });
      toast.success(replacing ? "The OpenRouter key was replaced" : "The OpenRouter key was added");
      onSaved();
      close();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? undefined : close())}
      size="sm"
      icon={KeyRound}
      title={replacing ? "Rotate the OpenRouter key" : "Add an OpenRouter key"}
      description="Create one at openrouter.ai/keys"
      footer={
        <>
          <span className="text-105 text-ink-3">Stored encrypted. Not shown again.</span>
          <div className="flex items-center gap-2">
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" loading={saving} onClick={() => void save()}>{replacing ? "Replace key" : "Save key"}</Button>
          </div>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Field label="API key" error={error} hint={replacing ? "The new key is used from the next request. The old one stops being used here; revoke it at OpenRouter as well." : "Requests are billed to this key's OpenRouter account."}>
          {(id) => <Input id={id} data-autofocus type="password" autoComplete="off" spellCheck={false} placeholder="sk-or-v1-…" value={key} onChange={(event) => setKey(event.target.value)} invalid={Boolean(error)} className="font-mono" />}
        </Field>
      </form>
    </Dialog>
  );
}
