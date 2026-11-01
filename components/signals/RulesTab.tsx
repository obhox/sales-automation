import { useState } from "react";
import { useTranslations } from "next-intl";
import { Ellipsis, Pencil, Plus, Trash2, Workflow } from "lucide-react";
import { toast } from "sonner";
import { Alert, Button, Card, Dialog, EmptyState, ErrorState, Field, IconButton, Input, Menu, MenuItem, MenuSeparator, Pill, Select, Skeleton, Switch, confirm } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { useApi } from "@/lib/client/data";
import { RULES_PATH, SIGNAL_TYPES, SIGNAL_TYPE_LABELS, blankRule, ruleFormOf, rulePayload, ruleProblem, ruleState, type Rule, type RuleForm, type SignalType } from "./model";

interface Named { id: string; name: string; from_email?: string; archived?: number | boolean; is_archived?: number | boolean }

/** What to do with a contact when a signal about them arrives: add them to a list, enrol them in a campaign, or both. */
export function RulesTab({ manager }: { manager: boolean }) {
  const t = useTranslations("SignalsRules");
  const kindName = (type: string) => {
    const keys: Record<string, "job" | "funding" | "hiring" | "tech" | "intent" | "custom"> = {
      job_change: "job", funding: "funding", hiring: "hiring", technology: "tech", product_intent: "intent", custom: "custom",
    };
    return keys[type] ? t(keys[type]) : SIGNAL_TYPE_LABELS[type as SignalType] ?? type;
  };
  const { data, error, isLoading, mutate } = useApi<Rule[]>(RULES_PATH);
  const [dialog, setDialog] = useState<{ rule: Rule | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function run(rule: Rule, work: () => Promise<void>) {
    if (busy) return;
    setBusy(rule.id);
    try {
      await work();
      void mutate();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  const setEnabled = (rule: Rule, enabled: boolean) =>
    run(rule, async () => {
      await api(RULES_PATH, { method: "PATCH", body: { id: rule.id, enabled } });
      toast.success(t(enabled ? "turnedOn" : "turnedOff", {name: rule.name}));
    });

  async function remove(rule: Rule) {
    const ok = await confirm({ title: t("deleteTitle", {name: rule.name}), body: t("deleteHelp"), confirmLabel: t("delete"), tone: "danger" });
    if (!ok) return;
    await run(rule, async () => {
      await api(RULES_PATH, { method: "DELETE", query: { id: rule.id } });
      toast.success(t("deleted", {name: rule.name}));
    });
  }

  return (
    <>
      {!manager && data ? <Alert tone="neutral">{t("readOnly")}</Alert> : null}
      <Card className="flex flex-col overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-3.5 py-[11px]">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 className="text-15 font-semibold tracking-[-0.15px] text-ink">{t("rules")}</h2>
            <p className="text-11 text-ink-3">{t("subtitle")}</p>
          </div>
          {manager ? <Button size="sm" className="h-7 px-3" icon={Plus} onClick={() => setDialog({ rule: null })}>{t("newRule")}</Button> : null}
        </div>
        {error && !data ? (
          <ErrorState className="border-t border-line" message={errorMessage(error)} onRetry={() => void mutate()} />
        ) : isLoading && !data ? (
          <div aria-busy="true" aria-label={t("loading")}>{Array.from({ length: 3 }, (_, index) => <div key={index} className="flex items-center gap-3 border-t border-line px-3.5 py-3.5"><Skeleton className="h-3 w-[30%]" /><Skeleton className="h-3 w-[40%]" /></div>)}</div>
        ) : !data || data.length === 0 ? (
          <EmptyState icon={Workflow} title={t("empty")} className="border-t border-line" action={manager ? <Button variant="primary" icon={Plus} onClick={() => setDialog({ rule: null })}>{t("newRule")}</Button> : undefined}>
            {manager ? t("emptyHelp") : t("emptyAdmin")}
          </EmptyState>
        ) : (
          <ul className="flex flex-col">
            {data.map((rule) => {
              const state = ruleState(rule);
              return (
                <li key={rule.id} aria-busy={busy === rule.id || undefined} className={cn("flex items-center gap-3 border-t border-line px-3.5 py-3", busy === rule.id && "opacity-60")}>
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-125 font-semibold text-ink">{rule.name}</span>
                      <Pill size="sm" tone={state.tone}>{t(!rule.enabled ? "off" : rule.problem ? "blocked" : "on")}</Pill>
                    </div>
                    <p className="text-115 leading-[16px] text-ink-2"><span className="text-ink-3">{t("when")}</span>{" "}
                      {rule.min_score > 0 ? t("whenScore", {kind: kindName(rule.signal_type).toLocaleLowerCase(), score: rule.min_score}) : t("whenAny", {kind: kindName(rule.signal_type).toLocaleLowerCase()})}{" → "}
                      {(() => {
                        const first = rule.list_id ? t("thenAdd", {name: rule.list_name ?? t("deletedList")}) : "";
                        const second = rule.workflow_id ? t("thenEnrol", {name: rule.workflow_name ?? t("deletedCampaign"),
                          from: [rule.account_name, rule.email_account_name].filter(Boolean).length
                            ? t("thenFrom", {name: [rule.account_name, rule.email_account_name].filter(Boolean).join(" e ")}) : ""}) : "";
                        const text = first && second ? t("thenCombine", {first, second}) : first || second || t("thenNothing");
                        return rule.workflow_id ? text + t(rule.auto_start ? "thenAuto" : "thenWait") : text;
                      })()}
                    </p>
                    {rule.problem ? <p className="text-105 leading-[15px] text-bad">{rule.problem}</p> : null}
                  </div>
                  {manager ? (
                    <>
                      <Switch checked={Boolean(rule.enabled)} onChange={(enabled) => void setEnabled(rule, enabled)} label={t("state", {name: rule.name, state: t(rule.enabled ? "on" : "off")})} />
                      <Menu trigger={<IconButton icon={Ellipsis} label={t("actions", {name: rule.name})} size={28} />}>
                        <MenuItem icon={Pencil} onSelect={() => setDialog({ rule })}>{t("editRule")}</MenuItem>
                        <MenuSeparator />
                        <MenuItem icon={Trash2} tone="danger" onSelect={() => void remove(rule)}>{t("delete")}</MenuItem>
                      </Menu>
                    </>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <p className="text-105 leading-[15px] text-ink-3">
        {t("bottom")}
      </p>
      {dialog ? <RuleDialog key={dialog.rule?.id ?? "new"} rule={dialog.rule} onClose={() => setDialog(null)} onSaved={(message) => { toast.success(message); void mutate(); }} /> : null}
    </>
  );
}

const NONE = "__none";

/** Write a rule, or change one. Mounted only while open. */
function RuleDialog({ rule, onClose, onSaved }: { rule: Rule | null; onClose: () => void; onSaved: (message: string) => void }) {
  const t = useTranslations("SignalsRules");
  const kindName = (type: string) => {
    const keys: Record<string, "job" | "funding" | "hiring" | "tech" | "intent" | "custom"> = {
      job_change: "job", funding: "funding", hiring: "hiring", technology: "tech", product_intent: "intent", custom: "custom",
    };
    return keys[type] ? t(keys[type]) : SIGNAL_TYPE_LABELS[type as SignalType] ?? type;
  };
  const [form, setForm] = useState<RuleForm>(rule ? ruleFormOf(rule) : blankRule());
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<{ field: string; message: string } | null>(null);
  const lists = useApi<Named[]>("/api/lists").data;
  const campaigns = useApi<Named[]>("/api/workflows").data;
  const accounts = useApi<Named[]>("/api/accounts").data;
  const mailboxes = useApi<Named[]>("/api/email-accounts").data;
  const set = (patch: Partial<RuleForm>) => setForm((current) => ({ ...current, ...patch }));
  const choices = (items: Named[] | undefined, none: string, label: (item: Named) => string = (item) => item.name) => [{ value: NONE, label: none }, ...(items ?? []).map((item) => ({ value: item.id, label: label(item) }))];
  const pick = (value: string) => (value === NONE ? "" : value);

  async function save() {
    const found = ruleProblem(form);
    if (found) return setProblem({...found, message: t(found.field === "name" ? "nameRequired" :
      found.field === "min_score" ? "scoreInvalid" : found.message.startsWith("Pick a list") ? "missingAction" : "missingList")});
    setSaving(true);
    setProblem(null);
    try {
      if (rule) await api(RULES_PATH, { method: "PATCH", body: { id: rule.id, ...rulePayload(form) } });
      else await api(RULES_PATH, { method: "POST", body: rulePayload(form) });
      onSaved(t(rule ? "saved" : "turnedOn", {name: form.name.trim()}));
      onClose();
    } catch (cause) {
      const message = errorMessage(cause);
      // The server knows which senders the campaign needs; what it says belongs beside that choice.
      setProblem({ field: /LinkedIn account/.test(message) ? "account_id" : /mailbox/i.test(message) ? "email_account_id" : /list/i.test(message) ? "list_id" : "form", message });
    } finally {
      setSaving(false);
    }
  }

  const error = (field: string) => (problem?.field === field ? problem.message : null);
  return (
    <Dialog
      open
      onOpenChange={(next) => (next || saving ? undefined : onClose())}
      icon={Workflow}
      title={t(rule ? "editRule" : "newRule")}
      description={t("dialogHint")}
      footer={
        <>
          <span className="text-105 text-ink-3">{rule && !rule.enabled ? t("keepOff") : ""}</span>
          <div className="flex items-center gap-2">
            <Button onClick={onClose} disabled={saving}>{t("cancel")}</Button>
            <Button variant="primary" loading={saving} onClick={() => void save()}>{t(rule ? "save" : "create")}</Button>
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
        <Field label={t("name")} error={error("name")}>
          {(id) => <Input id={id} data-autofocus maxLength={120} placeholder={t("placeholder")} value={form.name} invalid={Boolean(error("name"))} onChange={(event) => set({ name: event.target.value })} />}
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_140px]">
          <Field label={t("kind")}>
            {(id) => <Select<SignalType> id={id} className="w-full" value={form.signal_type} onChange={(signal_type) => set({ signal_type })} options={SIGNAL_TYPES.map((type) => ({ value: type, label: kindName(type) }))} />}
          </Field>
          <Field label={t("minScore")} error={error("min_score")}>
            {(id) => <Input id={id} inputMode="numeric" value={form.min_score} invalid={Boolean(error("min_score"))} onFocus={(event) => event.target.select()} onChange={(event) => set({ min_score: event.target.value.replace(/[^\d.]/g, "") })} />}
          </Field>
        </div>
        <Field label={t("addList")} error={error("list_id")}>
          {(id) => <Select id={id} className="w-full" value={form.list_id || NONE} onChange={(value) => set({ list_id: pick(value) })} options={choices(lists, t("noList"))} />}
        </Field>
        <Field label={t("enrol")} aside={t("optional")} hint={t("campaignHint")}>
          {(id) => <Select id={id} className="w-full" value={form.workflow_id || NONE} onChange={(value) => set({ workflow_id: pick(value) })} options={choices(campaigns, t("noCampaign"))} />}
        </Field>
        {form.workflow_id ? (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label={t("linkedinAccount")} error={error("account_id")}>
                {(id) => <Select id={id} className="w-full" value={form.account_id || NONE} onChange={(value) => set({ account_id: pick(value) })} options={choices(accounts, t("none"))} />}
              </Field>
              <Field label={t("mailbox")} error={error("email_account_id")}>
                {(id) => <Select id={id} className="w-full" value={form.email_account_id || NONE} onChange={(value) => set({ email_account_id: pick(value) })} options={choices(mailboxes, t("none"), (item) => (item.from_email ? `${item.name} · ${item.from_email}` : item.name))} />}
              </Field>
            </div>
            <p className="-mt-2 text-105 leading-[15px] text-ink-3">{t("sendersHint")}</p>
            <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-line px-3 py-2.5">
              <Switch checked={form.auto_start} onChange={(auto_start) => set({ auto_start })} label={t("autoStart")} className="mt-0.5" />
              <span className="flex flex-col gap-0.5">
                <span className="text-12 font-medium text-ink">{t("autoStart")}</span>
                <span className="text-105 leading-[15px] text-ink-3">{t("autoHint")}</span>
              </span>
            </label>
          </>
        ) : null}
        {/* Enter sends a form only if it has a submit button; the visible ones are in the footer. */}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
