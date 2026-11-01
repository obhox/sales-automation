import { useState } from "react";
import { useTranslations } from "next-intl";
import { FlaskConical, Mail, MessageSquare, UserRound, X } from "lucide-react";
import { Alert, Button, Dialog, Field, Input, SearchInput, Segmented, Spinner } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { useApi } from "@/lib/client/data";
import { useDebounced } from "@/lib/client/table-state";
import type { SearchResult } from "@/pages/api/search";
import type { AiTestContact } from "@/pages/api/ai/test";
import { draftForTest, formatRequestCost, modelName, type AiTestResult, type Draft, type ModelInfo } from "./model";

type Channel = "email" | "message";

/**
 * Write one sample for a real contact with the settings on the page, saved or not, and
 * show it. Nothing is sent to the contact. The request is a real one and is paid for.
 */
export function TestDialog({
  open,
  onClose,
  draft,
  dirty,
  models,
  onTested,
}: {
  open: boolean;
  onClose: () => void;
  draft: Draft;
  dirty: boolean;
  models: ModelInfo[];
  /** A request was made: this month's spend has moved. */
  onTested: () => void;
}) {
  const t = useTranslations("AiTest");
  const [contact, setContact] = useState<AiTestContact | null>(null);
  const [text, setText] = useState("");
  const [channel, setChannel] = useState<Channel>("email");
  const [instruction, setInstruction] = useState("");
  const [writing, setWriting] = useState(false);
  const [result, setResult] = useState<(AiTestResult & { channel: Channel; for: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);

  const query = useDebounced(text.trim(), 180);
  const searching = query.length >= 2;
  const suggested = useApi<{ contacts: AiTestContact[] }>(open && !contact ? "/api/ai/test" : null);
  const found = useApi<{ query: string; results: SearchResult[] }>(open && !contact && searching ? "/api/search" : null, { q: query }, { keepPreviousData: false });
  const choices: AiTestContact[] = searching
    ? (found.data?.query === query ? found.data.results : []).filter((row) => row.kind === "contact").map((row) => ({ id: row.id, name: row.title, detail: row.subtitle }))
    : suggested.data?.contacts ?? [];
  const loadingChoices = searching ? found.isLoading || found.data?.query !== query : suggested.isLoading;

  async function write() {
    if (!contact) return;
    setWriting(true);
    setError(null);
    try {
      const written = await api<AiTestResult>("/api/ai/test", {
        method: "POST",
        body: { target_id: contact.id, step_type: channel, instruction: instruction.trim() || undefined, model: draft.default_model ?? undefined, config: draftForTest(draft) },
      });
      setResult({ ...written, channel, for: contact.name });
      onTested();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setWriting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? undefined : onClose())}
      size="lg"
      icon={FlaskConical}
      title={t("title")}
      description={t("desc")}
      footer={
        <>
          <span className="text-105 text-ink-3">{t("costHint")}</span>
          <div className="flex items-center gap-2">
            <Button onClick={onClose}>{t("close")}</Button>
            <Button variant="primary" icon={FlaskConical} loading={writing} disabled={!contact || !draft.default_model} onClick={() => void write()}>{result ? t("writeAgain") : t("write")}</Button>
          </div>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-5 md:grid-cols-[280px_minmax(0,1fr)]">
        <div className="flex flex-col gap-3.5">
          <div className="flex flex-col gap-1.5">
            <span className="text-105 font-semibold text-ink-2">{t("contact")}</span>
            {contact ? (
              <div className="flex items-center justify-between gap-2 rounded-md border border-line-strong bg-surface px-2.5 py-2">
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate text-12 font-medium text-ink">{contact.name}</span>
                  {contact.detail ? <span className="truncate text-105 text-ink-3">{contact.detail}</span> : null}
                </span>
                <button type="button" onClick={() => { setContact(null); setText(""); }} aria-label={t("anotherContact")} className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-control hover:text-ink">
                  <X size={13} aria-hidden="true" />
                </button>
              </div>
            ) : (
              <>
                <SearchInput data-autofocus value={text} onChange={setText} placeholder={t("search")} aria-label={t("searchLabel")} />
                <ul aria-label={t("contacts")} className="flex max-h-[218px] flex-col gap-px overflow-y-auto rounded-md border border-line p-1">
                  {loadingChoices ? (
                    <li className="flex items-center gap-2 px-2 py-3 text-115 text-ink-3"><Spinner size={12} label={t("looking")} /> {t("lookingWait")}</li>
                  ) : choices.length === 0 ? (
                    <li className="px-2 py-3 text-115 leading-4 text-ink-2">{searching ? t("noMatches", {query}) : t("empty")}</li>
                  ) : (
                    choices.map((choice) => (
                      <li key={choice.id}>
                        <button type="button" onClick={() => setContact(choice)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-brand-tint focus-visible:bg-brand-tint">
                          <UserRound size={13} className="shrink-0 text-ink-3" aria-hidden="true" />
                          <span className="flex min-w-0 flex-col">
                            <span className="truncate text-115 font-medium text-ink">{choice.name}</span>
                            {choice.detail ? <span className="truncate text-105 text-ink-3">{choice.detail}</span> : null}
                          </span>
                        </button>
                      </li>
                    ))
                  )}
                </ul>
                {!searching && choices.length > 0 ? <p className="text-105 text-ink-3">{t("recent")}</p> : null}
              </>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-105 font-semibold text-ink-2">{t("writeLabel")}</span>
            <Segmented label={t("whatWrite")} value={channel} onChange={setChannel} className="self-start" options={[{ value: "email", label: t("email"), icon: Mail }, { value: "message", label: t("linkedin"), icon: MessageSquare }]} />
          </div>

          <Field label={t("instruction")} hint={t("instructionHint")}>
            {(id) => <Input id={id} value={instruction} maxLength={1000} placeholder={t("placeholder")} onChange={(event) => setInstruction(event.target.value)} />}
          </Field>
        </div>

        <div className="flex min-h-[300px] min-w-0 flex-col gap-2.5">
          {!draft.default_model ? <Alert tone="warn" title={t("defaultRequired")}>{t("defaultRequiredHint")}</Alert> : null}
          {error ? <Alert tone="bad" title={t("failed")}>{error}</Alert> : null}
          {result ? (
            <>
              <div className="flex flex-1 flex-col gap-2.5 rounded-lg bg-subtle p-3.5" aria-live="polite">
                <span className="text-105 text-ink-3">{t("resultFor", {channel: t(result.channel === "email" ? "emailLabel" : "linkedinLabel"), name: result.for})}</span>
                {result.subject ? <p className="text-125 font-semibold text-ink">{result.subject}</p> : null}
                <p className="whitespace-pre-wrap text-125 leading-[19px] text-ink">{result.body}</p>
              </div>
              <p className="text-105 leading-[15px] text-ink-3">
                {t("writtenBy")} <span className="font-medium text-ink-2">{modelName(result.model, models)}</span>
                {result.used_fallback ? t("fallbackHint") : ""}
                {" · "}{t("tokens", {input: result.input_tokens, output: result.output_tokens, cost: formatRequestCost(result.cost_usd)})}
              </p>
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-line-strong px-6 text-center">
              {writing ? (
                <span className="flex items-center gap-2 text-115 text-ink-2"><Spinner size={13} label={t("writing")} /> {t("writingWait")}</span>
              ) : (
                <>
                  <p className="text-12 font-medium text-ink">{contact ? t("ready", {name: contact.name}) : t("choose")}</p>
                  <p className="max-w-[320px] text-11 leading-4 text-ink-3">
                    {t("uses")}{dirty ? t("including") : ""}.
                  </p>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
