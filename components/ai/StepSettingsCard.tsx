import { useState } from "react";
import { useTranslations } from "next-intl";
import { Ellipsis, PenLine, Pencil, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button, Card, ChannelBadge, Dialog, EmptyState, ErrorState, Field, IconButton, Input, Menu, MenuItem, MenuSeparator, Pill, Select, Skeleton, Switch, Textarea } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { useApi } from "@/lib/client/data";
import { ModelSelect } from "./ModelSelect";
import { CardHead } from "./parts";
import { LANGUAGES, MAX_STEP_PROMPT, MAX_STEP_WORDS, STEPS_PATH, modelName, stepChannel, type AiCampaign, type AiStep, type ModelInfo } from "./model";

interface StepsPayload {
  workflow_id: string;
  steps: AiStep[];
}

const GRID = "grid grid-cols-[minmax(150px,180px)_150px_minmax(140px,1fr)_60px_92px_28px] items-center gap-3 px-3.5";

/**
 * One campaign's steps and how each is written. A step set to be written by AI can name
 * its own model, instruction, length and language; anything it leaves out comes from the
 * workspace settings above. Changes here are saved as they are made.
 */
export function StepSettingsCard({
  campaigns,
  models,
  defaultModel,
  modelsUnavailable,
  canEdit,
  onChanged,
}: {
  campaigns: AiCampaign[];
  models: ModelInfo[];
  defaultModel: string | null;
  modelsUnavailable: string;
  canEdit: boolean;
  /** A step was switched to or from AI writing: the campaign list's counts have moved. */
  onChanged: () => void;
}) {
  const t = useTranslations("AiSteps");
  const displayStep = (item: AiStep) => item.step_type === "email"
    ? t("emailStep", {number: item.number, part: t(item.number === 1 ? "opener" : "followup")})
    : item.step_type === "message" ? t("linkedinStep", {number: item.number})
      : item.number === 1 ? "InMail" : t("inmailStep", {number: item.number});
  const [chosen, setChosen] = useState<string | null>(null);
  const campaign = campaigns.find((candidate) => candidate.id === chosen) ?? campaigns[0] ?? null;
  const { data, error, isLoading, mutate } = useApi<StepsPayload>(campaign ? STEPS_PATH : null, { workflow_id: campaign?.id });
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // While another campaign's steps are on their way, the previous campaign's are not shown under its name.
  const steps = data && campaign && data.workflow_id === campaign.id ? data.steps : null;
  const editingStep = steps?.find((step) => step.id === editing) ?? null;

  async function save(step: AiStep, patch: Partial<Pick<AiStep, "ai_enabled" | "ai_model" | "ai_prompt" | "ai_max_words" | "ai_language">>, message: string) {
    if (!campaign) return false;
    setBusy(step.id);
    try {
      await api(STEPS_PATH, { method: "PUT", body: { workflow_id: campaign.id, step_id: step.id, ...patch } });
      toast.success(message, { description: t("applies") });
      await mutate();
      if ("ai_enabled" in patch) onChanged();
      return true;
    } catch (cause) {
      toast.error(errorMessage(cause));
      return false;
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="flex flex-col overflow-hidden">
      <div className="px-3.5 py-[9px]">
        <CardHead
          title={t("title")}
          subtitle={campaign ? t("subtitle", {count: campaign.ai_steps, total: campaign.writable_steps}) : t("noCampaignSubtitle")}
          aside={
            campaigns.length > 0 ? (
              <Select
                size="sm" label={t("campaign")} className="max-w-[260px]" value={campaign?.id}
                onChange={(id) => { setChosen(id); setEditing(null); }}
                options={campaigns.map((option) => ({ value: option.id, label: option.name, hint: t("campaignOption", {count: option.ai_steps, total: option.writable_steps, archive: option.archived ? t("archive") : ""}) }))}
              />
            ) : undefined
          }
        />
      </div>

      {campaigns.length === 0 ? (
        <EmptyState icon={Sparkles} title={t("emptyTitle")} className="border-t border-line">
          {t("emptyHint")}
        </EmptyState>
      ) : error && !steps ? (
        <ErrorState className="border-t border-line" message={errorMessage(error)} onRetry={() => void mutate()} />
      ) : (
        <div className="overflow-x-auto">
          <div role="table" aria-label={t("table", {name: campaign?.name ?? t("theCampaign")})} aria-busy={isLoading || undefined} className="min-w-[720px]">
            <div role="row" className={`${GRID} h-[31px] bg-subtle text-10 font-semibold uppercase tracking-label text-ink-3`}>
              <span role="columnheader">{t("step")}</span>
              <span role="columnheader">{t("model")}</span>
              <span role="columnheader">{t("instruction")}</span>
              <span role="columnheader">{t("words")}</span>
              <span role="columnheader">{t("language")}</span>
              <span role="columnheader"><span className="sr-only">{t("actions")}</span></span>
            </div>
            {!steps
              ? Array.from({ length: 4 }, (_, index) => (
                  <div key={index} className="flex h-[49px] items-center border-t border-line px-3.5">
                    <Skeleton className="h-3.5 w-full" />
                  </div>
                ))
              : steps.map((step) => (
                  <div key={step.id} role="row" className={`${GRID} min-h-[49px] border-t border-line py-1.5`}>
                    <div role="cell" className="flex min-w-0 items-center gap-[9px]">
                      <ChannelBadge channel={stepChannel(step)} />
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <span className="truncate text-12 font-medium text-ink">{displayStep(step)}</span>
                        <span className="text-105 text-ink-3">{t("day", {day: step.day})}</span>
                      </div>
                    </div>
                    {step.ai_enabled ? (
                      <>
                        <div role="cell" className="min-w-0">
                          {canEdit ? (
                            <ModelSelect
                              size="sm" tone="sunken" label={t("modelFor", {name: displayStep(step)})} value={step.ai_model} models={models} unavailable={modelsUnavailable} disabled={busy === step.id}
                              none={defaultModel ? t("default", {name: modelName(defaultModel, models)}) : t("workspaceDefault")}
                              onChange={(model) => void save(step, { ai_model: model }, model ? t("modelChanged", {name: displayStep(step), model: modelName(model, models)}) : t("useDefaultMessage", {name: displayStep(step)}))}
                            />
                          ) : (
                            <span className="block truncate text-11 font-semibold text-ink">{step.ai_model ? modelName(step.ai_model, models) : defaultModel ? t("default", {name: modelName(defaultModel, models)}) : t("workspaceDefault")}</span>
                          )}
                        </div>
                        <p role="cell" className="line-clamp-2 min-w-0 text-11 leading-[15px] text-ink-2">{step.ai_prompt ?? <span className="text-ink-3">{t("noInstruction")}</span>}</p>
                        <span role="cell" className="text-115 font-medium text-ink">{step.ai_max_words ?? <span className="font-normal text-ink-3">{t("any")}</span>}</span>
                        <span role="cell"><Pill size="md">{{ "English": t("langEnglish"),  "German": t("langGerman"),  "French": t("langFrench"),  "Spanish": t("langSpanish"),  "Dutch": t("langDutch"),  "Italian": t("langItalian"),  "Portuguese": t("langPortuguese"),  "Swedish": t("langSwedish"),  "Danish": t("langDanish"),  "Norwegian": t("langNorwegian"),  "Finnish": t("langFinnish"),  "Polish": t("langPolish")}[step.ai_language ?? "English"] ?? step.ai_language ?? t("english")}</Pill></span>
                      </>
                    ) : (
                      <p role="cell" className="col-span-4 flex items-center gap-1.5 text-11 text-ink-3">
                        <PenLine size={12} aria-hidden="true" />
                        {t("handwritten")}
                      </p>
                    )}
                    <div role="cell" className="flex justify-end">
                      {canEdit ? (
                        <Menu trigger={<IconButton icon={Ellipsis} label={t("actionsFor", {name: displayStep(step)})} size={28} disabled={busy === step.id} />}>
                          {step.ai_enabled ? (
                            <>
                              <MenuItem icon={Pencil} onSelect={() => setEditing(step.id)}>{t("editInstruction")}</MenuItem>
                              {step.ai_model ? <MenuItem icon={Sparkles} onSelect={() => void save(step, { ai_model: null }, t("useDefaultMessage", {name: displayStep(step)}))}>{t("useDefault")}</MenuItem> : null}
                              <MenuSeparator />
                              <MenuItem icon={PenLine} onSelect={() => void save(step, { ai_enabled: false }, t("handwrite", {name: displayStep(step)}))}>{t("stopAi")}</MenuItem>
                            </>
                          ) : (
                            <MenuItem icon={Sparkles} onSelect={() => setEditing(step.id)}>{t("writeAi")}</MenuItem>
                          )}
                        </Menu>
                      ) : null}
                    </div>
                  </div>
                ))}
            {steps && steps.length === 0 ? <p className="border-t border-line px-3.5 py-6 text-center text-115 text-ink-2">{t("emptySteps")}</p> : null}
          </div>
        </div>
      )}

      {editingStep ? (
        <StepDialog
          key={editingStep.id}
          step={editingStep}
          models={models}
          defaultModel={defaultModel}
          modelsUnavailable={modelsUnavailable}
          onClose={() => setEditing(null)}
          onSave={async (patch) => {
            const ok = await save(editingStep, patch, editingStep.ai_enabled ? t("updated", {name: displayStep(editingStep)}) : t("enabled", {name: displayStep(editingStep)}));
            if (ok) setEditing(null);
          }}
        />
      ) : null}
    </Card>
  );
}

function StepDialog({
  step, models, defaultModel, modelsUnavailable, onClose, onSave,
}: {
  step: AiStep; models: ModelInfo[]; defaultModel: string | null; modelsUnavailable: string; onClose: () => void;
  onSave: (patch: { ai_enabled: boolean; ai_model: string | null; ai_prompt: string | null; ai_max_words: number | null; ai_language: string | null }) => Promise<void>;
}) {
  const t = useTranslations("AiSteps");
  const displayStep = (item: AiStep) => item.step_type === "email"
    ? t("emailStep", {number: item.number, part: t(item.number === 1 ? "opener" : "followup")})
    : item.step_type === "message" ? t("linkedinStep", {number: item.number})
      : item.number === 1 ? "InMail" : t("inmailStep", {number: item.number});
  // Opened on a step written by hand, it is to switch AI on.
  const [enabled, setEnabled] = useState(true);
  const [model, setModel] = useState(step.ai_model);
  const [prompt, setPrompt] = useState(step.ai_prompt ?? "");
  const [words, setWords] = useState(step.ai_max_words === null ? "" : String(step.ai_max_words));
  const [language, setLanguage] = useState(step.ai_language ?? "English");
  const [saving, setSaving] = useState(false);
  const wordCount = words === "" ? null : Number(words);
  const wordsProblem = wordCount !== null && (!Number.isInteger(wordCount) || wordCount < 1 || wordCount > MAX_STEP_WORDS) ? t("wordsError", {max: MAX_STEP_WORDS}) : null;
  const promptProblem = prompt.length > MAX_STEP_PROMPT ? t("charsError", {max: MAX_STEP_PROMPT}) : null;
  const languages = LANGUAGES.includes(language) || !language ? LANGUAGES : [language, ...LANGUAGES];

  async function save() {
    if (wordsProblem || promptProblem) return;
    setSaving(true);
    await onSave({ ai_enabled: enabled, ai_model: model, ai_prompt: prompt.trim() || null, ai_max_words: wordCount, ai_language: language || null });
    setSaving(false);
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      icon={Sparkles}
      title={displayStep(step)}
      description={t("stepDescription", {day: step.day, channel: stepChannel(step) === "email" ? t("email") : "LinkedIn"})}
      footer={
        <>
          <span className="text-105 text-ink-3">{t("savedInCampaign")}</span>
          <div className="flex items-center gap-2">
            <Button onClick={onClose}>{t("cancel")}</Button>
            <Button variant="primary" loading={saving} onClick={() => void save()}>{t("save")}</Button>
          </div>
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        <div className="flex items-start justify-between gap-3 rounded-lg bg-subtle p-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-12 font-medium text-ink">{t("writeAi")}</span>
            <span className="text-11 leading-4 text-ink-2">{enabled ? t("enabledHint") : t("disabledHint")}</span>
          </div>
          <Switch checked={enabled} onChange={setEnabled} label={t("writeAi")} className="mt-0.5" />
        </div>
        {enabled ? (
          <>
            <Field label={t("model")} hint={t("modelHint")}>
              {(id) => <ModelSelect id={id} value={model} onChange={setModel} models={models} unavailable={modelsUnavailable} none={defaultModel ? t("workspaceDefaultModel", {model: modelName(defaultModel, models)}) : t("workspaceDefault")} />}
            </Field>
            <Field label={t("instructionStep")} error={promptProblem} aside={`${prompt.length.toLocaleString("en-US")} / ${MAX_STEP_PROMPT.toLocaleString("en-US")}`} hint={t("instructionHint")}>
              {(id) => <Textarea id={id} data-autofocus rows={3} value={prompt} invalid={Boolean(promptProblem)} onChange={(event) => setPrompt(event.target.value)} placeholder={t("instructionPlaceholder")} />}
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t("maxLength")} error={wordsProblem} hint={t("unlimited")}>
                {(id) => <Input id={id} inputMode="numeric" value={words} invalid={Boolean(wordsProblem)} placeholder={t("noLimit")} onChange={(event) => setWords(event.target.value.replace(/[^0-9]/g, "").slice(0, 4))} trailing={<span className="shrink-0 text-105 text-ink-3">{t("wordUnit")}</span>} />}
              </Field>
              <Field label={t("language")}>
                {(id) => <Select id={id} className="w-full" value={language} onChange={setLanguage} options={languages.map((name) => ({ value: name, label: { "English": t("langEnglish"),  "German": t("langGerman"),  "French": t("langFrench"),  "Spanish": t("langSpanish"),  "Dutch": t("langDutch"),  "Italian": t("langItalian"),  "Portuguese": t("langPortuguese"),  "Swedish": t("langSwedish"),  "Danish": t("langDanish"),  "Norwegian": t("langNorwegian"),  "Finnish": t("langFinnish"),  "Polish": t("langPolish")}[name] ?? name }))} />}
              </Field>
            </div>
          </>
        ) : null}
      </div>
    </Dialog>
  );
}
