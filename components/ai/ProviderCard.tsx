import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { BrainCircuit, KeyRound, Lock } from "lucide-react";
import { toast } from "sonner";
import { Alert, Button, Card, Dialog, Field, Input, Pill, TextAction } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { formatDate, formatRelative } from "@/lib/client/format";
import { formatRelativeByLocale } from "@/lib/client/localize-relative";
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
  const t = useTranslations("AiProvider");
  const locale = useLocale();
  const [keyOpen, setKeyOpen] = useState(false);
  const { provider, usage } = overview;
  const find = (id: string | null) => models.find((model) => model.id === id);
  const unavailable = provider.connected ? modelsError ?? t("loadingModels") : t("missingModelsKey");
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
            <p className="truncate text-11 text-ink-3">{t("subtitle")}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-[9px]">
          {provider.connected ? <Pill tone="good" dot>{t("connected")}</Pill> : <Pill tone="neutral" dot>{t("noKey")}</Pill>}
          {canEdit && provider.connected ? <TextAction onClick={() => setKeyOpen(true)}>{t("rotate")}</TextAction> : null}
        </div>
      </div>

      {!provider.connected ? (
        <Alert tone="info" title={t("noWriter")} actions={canEdit ? <Button size="xs" variant="primary" icon={KeyRound} onClick={() => setKeyOpen(true)}>{t("addKey")}</Button> : undefined}>
          {t("skipSteps")} {canEdit ? t("keyFrom") : t("adminAdds")}
        </Alert>
      ) : null}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_230px_230px]">
        <Captioned
          label={t("apiKey")}
          hint={provider.connected
            ? t("encryptedSummary", {when: locale === "pt-BR" ? usage.last_used_at ? t("lastUsed", {relative: formatRelativeByLocale(usage.last_used_at, locale)}) : t("neverUsed") : lastUsed(usage.last_used_at, (date) => formatRelative(date))}) + (provider.key_updated_at ? t("setAt", {date: formatDate(provider.key_updated_at)}) : "")
            : t("encrypted")}
        >
          {(id) => (
            <Input
              id={id} readOnly value={provider.key_hint ?? ""} placeholder={t("notSet")} frameClassName="h-[34px]" className="font-mono text-11 font-medium"
              trailing={<Lock size={14} className="shrink-0 text-ink-3" aria-hidden="true" />}
            />
          )}
        </Captioned>

        <Captioned label={t("defaultModel")} hint={priceLine(find(draft.default_model)) ?? t("defaultHint")}>
          {(id) => (
            <ModelSelect id={id} value={draft.default_model} onChange={(model) => onDraft({ default_model: model })} models={models} unavailable={unavailable} disabled={!canEdit} none={draft.default_model ? t("noDefault") : undefined} />
          )}
        </Captioned>

        <Captioned
          label={t("fallback")}
          hint={
            draft.fallback_model
              ? `${priceLine(find(draft.fallback_model)) ?? t("fallbackHint")}${fallbackCount > 0 ? t("fallbackUsage", {count: fallbackCount}) : ""}`
              : t("fallbackHint")
          }
        >
          {(id) => <ModelSelect id={id} value={draft.fallback_model} onChange={(model) => onDraft({ fallback_model: model })} models={models} unavailable={unavailable} disabled={!canEdit} none={t("noFallback")} />}
        </Captioned>
      </div>

      {provider.connected && modelsError ? <p className="text-105 text-bad" role="alert">{t("loadError", {error: modelsError})}</p> : null}

      <KeyDialog open={keyOpen} replacing={provider.connected} onClose={() => setKeyOpen(false)} onSaved={onKeyChanged} />
    </Card>
  );
}

/** Add the provider key, or put a new one in place of the old. The key is sent once and never read back. */
function KeyDialog({ open, replacing, onClose, onSaved }: { open: boolean; replacing: boolean; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations("AiProvider");
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
    if (!clean) return setError(t("missingKey"));
    if (/\s/.test(clean)) return setError(t("spaces"));
    setSaving(true);
    setError(null);
    try {
      await api("/api/integrations", { method: "POST", body: { key: "openrouter", api_key: clean } });
      toast.success(replacing ? t("replaced") : t("added"));
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
      title={replacing ? t("rotateTitle") : t("addKey")}
      description={t("createAt")}
      footer={
        <>
          <span className="text-105 text-ink-3">{t("stored")}</span>
          <div className="flex items-center gap-2">
            <Button onClick={close}>{t("cancel")}</Button>
            <Button variant="primary" loading={saving} onClick={() => void save()}>{replacing ? t("replace") : t("saveKey")}</Button>
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
        <Field label={t("apiKey")} error={error} hint={replacing ? t("rotateHint") : t("billing")}>
          {(id) => <Input id={id} data-autofocus type="password" autoComplete="off" spellCheck={false} placeholder="sk-or-v1-…" value={key} onChange={(event) => setKey(event.target.value)} invalid={Boolean(error)} className="font-mono" />}
        </Field>
      </form>
    </Dialog>
  );
}
