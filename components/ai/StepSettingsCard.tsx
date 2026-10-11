import { useState } from "react";
import { Ellipsis, PenLine, Pencil, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button, Card, ChannelBadge, Dialog, EmptyState, ErrorState, Field, IconButton, Input, Menu, MenuItem, MenuSeparator, Pill, Select, Skeleton, Switch, Textarea } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { useApi } from "@/lib/client/data";
import { plural } from "@/lib/client/format";
import { ModelSelect } from "./ModelSelect";
import { CardHead } from "./parts";
import { LANGUAGES, MAX_STEP_PROMPT, MAX_STEP_WORDS, STEPS_PATH, modelName, stepChannel, stepName, type AiCampaign, type AiStep, type ModelInfo } from "./model";

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
      toast.success(message, { description: "It applies to messages written from now on." });
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
          title="Per-step model settings"
          subtitle={campaign ? `${campaign.ai_steps} of ${campaign.writable_steps} ${plural(campaign.writable_steps, "step", "steps")} written by AI · what a step leaves out comes from the workspace settings above` : "Each step of a campaign can have its own model, instruction, length and language"}
          aside={
            campaigns.length > 0 ? (
              <Select
                size="sm" label="Campaign" className="max-w-[260px]" value={campaign?.id}
                onChange={(id) => { setChosen(id); setEditing(null); }}
                options={campaigns.map((option) => ({ value: option.id, label: option.name, hint: `${option.ai_steps} of ${option.writable_steps} written by AI${option.archived ? " · archived" : ""}` }))}
              />
            ) : undefined
          }
        />
      </div>

      {campaigns.length === 0 ? (
        <EmptyState icon={Sparkles} title="No campaign has a step AI could write" className="border-t border-line">
          Email, LinkedIn message and InMail steps can be written by AI. Once a campaign has one, its settings appear here.
        </EmptyState>
      ) : error && !steps ? (
        <ErrorState className="border-t border-line" message={errorMessage(error)} onRetry={() => void mutate()} />
      ) : (
        <div className="overflow-x-auto">
          <div role="table" aria-label={`AI settings for the steps of ${campaign?.name ?? "the campaign"}`} aria-busy={isLoading || undefined} className="min-w-[720px]">
            <div role="row" className={`${GRID} h-[31px] bg-subtle text-10 font-semibold uppercase tracking-label text-ink-3`}>
              <span role="columnheader">Step</span>
              <span role="columnheader">Model</span>
              <span role="columnheader">Instruction</span>
              <span role="columnheader">Words</span>
              <span role="columnheader">Language</span>
              <span role="columnheader"><span className="sr-only">Actions</span></span>
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
                        <span className="truncate text-12 font-medium text-ink">{stepName(step)}</span>
                        <span className="text-105 text-ink-3">Day {step.day}</span>
                      </div>
                    </div>
                    {step.ai_enabled ? (
                      <>
                        <div role="cell" className="min-w-0">
                          {canEdit ? (
                            <ModelSelect
                              size="sm" tone="sunken" label={`Model for ${stepName(step)}`} value={step.ai_model} models={models} unavailable={modelsUnavailable} disabled={busy === step.id}
                              none={defaultModel ? `Default · ${modelName(defaultModel, models)}` : "Workspace default"}
                              onChange={(model) => void save(step, { ai_model: model }, model ? `${stepName(step)} is now written by ${modelName(model, models)}` : `${stepName(step)} now uses the workspace default model`)}
                            />
                          ) : (
                            <span className="block truncate text-11 font-semibold text-ink">{step.ai_model ? modelName(step.ai_model, models) : defaultModel ? `Default · ${modelName(defaultModel, models)}` : "Workspace default"}</span>
                          )}
                        </div>
                        <p role="cell" className="line-clamp-2 min-w-0 text-11 leading-[15px] text-ink-2">{step.ai_prompt ?? <span className="text-ink-3">No instruction of its own</span>}</p>
                        <span role="cell" className="text-115 font-medium text-ink">{step.ai_max_words ?? <span className="font-normal text-ink-3">Any</span>}</span>
                        <span role="cell"><Pill size="md">{step.ai_language ?? "English"}</Pill></span>
                      </>
                    ) : (
                      <p role="cell" className="col-span-4 flex items-center gap-1.5 text-11 text-ink-3">
                        <PenLine size={12} aria-hidden="true" />
                        Sends the wording written in the campaign
                      </p>
                    )}
                    <div role="cell" className="flex justify-end">
                      {canEdit ? (
                        <Menu trigger={<IconButton icon={Ellipsis} label={`Actions for ${stepName(step)}`} size={28} disabled={busy === step.id} />}>
                          {step.ai_enabled ? (
                            <>
                              <MenuItem icon={Pencil} onSelect={() => setEditing(step.id)}>Edit instruction, length and language</MenuItem>
                              {step.ai_model ? <MenuItem icon={Sparkles} onSelect={() => void save(step, { ai_model: null }, `${stepName(step)} now uses the workspace default model`)}>Use the workspace default model</MenuItem> : null}
                              <MenuSeparator />
                              <MenuItem icon={PenLine} onSelect={() => void save(step, { ai_enabled: false }, `${stepName(step)} now sends the wording written in the campaign`)}>Stop writing this step with AI</MenuItem>
                            </>
                          ) : (
                            <MenuItem icon={Sparkles} onSelect={() => setEditing(step.id)}>Write this step with AI</MenuItem>
                          )}
                        </Menu>
                      ) : null}
                    </div>
                  </div>
                ))}
            {steps && steps.length === 0 ? <p className="border-t border-line px-3.5 py-6 text-center text-115 text-ink-2">This campaign has no step AI could write.</p> : null}
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
            const ok = await save(editingStep, patch, editingStep.ai_enabled ? `${stepName(editingStep)} was updated` : `${stepName(editingStep)} is now written by AI`);
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
  // Opened on a step written by hand, it is to switch AI on.
  const [enabled, setEnabled] = useState(true);
  const [model, setModel] = useState(step.ai_model);
  const [prompt, setPrompt] = useState(step.ai_prompt ?? "");
  const [words, setWords] = useState(step.ai_max_words === null ? "" : String(step.ai_max_words));
  const [language, setLanguage] = useState(step.ai_language ?? "English");
  const [saving, setSaving] = useState(false);
  const wordCount = words === "" ? null : Number(words);
  const wordsProblem = wordCount !== null && (!Number.isInteger(wordCount) || wordCount < 1 || wordCount > MAX_STEP_WORDS) ? `From 1 to ${MAX_STEP_WORDS.toLocaleString("en-US")}` : null;
  const promptProblem = prompt.length > MAX_STEP_PROMPT ? `At most ${MAX_STEP_PROMPT.toLocaleString("en-US")} characters` : null;
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
      title={stepName(step)}
      description={`Day ${step.day} · ${stepChannel(step) === "email" ? "email" : "LinkedIn"}`}
      footer={
        <>
          <span className="text-105 text-ink-3">Saved straight to the campaign. Messages already sent do not change.</span>
          <div className="flex items-center gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={saving} onClick={() => void save()}>Save step</Button>
          </div>
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        <div className="flex items-start justify-between gap-3 rounded-lg bg-subtle p-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-12 font-medium text-ink">Write this step with AI</span>
            <span className="text-11 leading-4 text-ink-2">{enabled ? "Each contact gets a message written for them from their details, the workspace style and the instruction below." : "Every contact gets the wording written in the campaign, with its merge tags filled in."}</span>
          </div>
          <Switch checked={enabled} onChange={setEnabled} label="Write this step with AI" className="mt-0.5" />
        </div>
        {enabled ? (
          <>
            <Field label="Model" hint="Leave on the default to follow the workspace setting when it changes.">
              {(id) => <ModelSelect id={id} value={model} onChange={setModel} models={models} unavailable={modelsUnavailable} none={defaultModel ? `Workspace default · ${modelName(defaultModel, models)}` : "Workspace default"} />}
            </Field>
            <Field label="Instruction for this step" error={promptProblem} aside={`${prompt.length.toLocaleString("en-US")} / ${MAX_STEP_PROMPT.toLocaleString("en-US")}`} hint="What this message is for, in a sentence or two. The workspace writing style still applies.">
              {(id) => <Textarea id={id} data-autofocus rows={3} value={prompt} invalid={Boolean(promptProblem)} onChange={(event) => setPrompt(event.target.value)} placeholder="Lead with the funding signal, one line of proof" />}
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Longest it may be" error={wordsProblem} hint="Leave empty for no limit">
                {(id) => <Input id={id} inputMode="numeric" value={words} invalid={Boolean(wordsProblem)} placeholder="No limit" onChange={(event) => setWords(event.target.value.replace(/[^0-9]/g, "").slice(0, 4))} trailing={<span className="shrink-0 text-105 text-ink-3">words</span>} />}
              </Field>
              <Field label="Language">
                {(id) => <Select id={id} className="w-full" value={language} onChange={setLanguage} options={languages.map((name) => ({ value: name, label: name }))} />}
              </Field>
            </div>
          </>
        ) : null}
      </div>
    </Dialog>
  );
}
