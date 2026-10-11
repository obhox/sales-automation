import { useState } from "react";
import { Ellipsis, Pencil, Plus, Trash2, Workflow } from "lucide-react";
import { toast } from "sonner";
import { Alert, Button, Card, Dialog, EmptyState, ErrorState, Field, IconButton, Input, Menu, MenuItem, MenuSeparator, Pill, Select, Skeleton, Switch, confirm } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { useApi } from "@/lib/client/data";
import { RULES_PATH, SIGNAL_TYPES, SIGNAL_TYPE_LABELS, blankRule, ruleFormOf, rulePayload, ruleProblem, ruleState, ruleThen, ruleWhen, type Rule, type RuleForm, type SignalType } from "./model";

interface Named { id: string; name: string; from_email?: string; archived?: number | boolean; is_archived?: number | boolean }

/** What to do with a contact when a signal about them arrives: add them to a list, enrol them in a campaign, or both. */
export function RulesTab({ manager }: { manager: boolean }) {
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
      toast.success(enabled ? `${rule.name} is on` : `${rule.name} is off`);
    });

  async function remove(rule: Rule) {
    const ok = await confirm({ title: `Delete the rule “${rule.name}”?`, body: "Signals stop setting it off. Contacts it has already added to a list or enrolled stay where they are.", confirmLabel: "Delete rule", tone: "danger" });
    if (!ok) return;
    await run(rule, async () => {
      await api(RULES_PATH, { method: "DELETE", query: { id: rule.id } });
      toast.success(`${rule.name} was deleted`);
    });
  }

  return (
    <>
      {!manager && data ? <Alert tone="neutral">You can see the rules. A manager writes them and turns them on and off.</Alert> : null}
      <Card className="flex flex-col overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-3.5 py-[11px]">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 className="text-15 font-semibold tracking-[-0.15px] text-ink">Rules</h2>
            <p className="text-11 text-ink-3">When a signal about a contact arrives, a rule can add them to a list, enrol them in a campaign, or both</p>
          </div>
          {manager ? <Button size="sm" className="h-7 px-3" icon={Plus} onClick={() => setDialog({ rule: null })}>New rule</Button> : null}
        </div>
        {error && !data ? (
          <ErrorState className="border-t border-line" message={errorMessage(error)} onRetry={() => void mutate()} />
        ) : isLoading && !data ? (
          <div aria-busy="true" aria-label="Loading rules">{Array.from({ length: 3 }, (_, index) => <div key={index} className="flex items-center gap-3 border-t border-line px-3.5 py-3.5"><Skeleton className="h-3 w-[30%]" /><Skeleton className="h-3 w-[40%]" /></div>)}</div>
        ) : !data || data.length === 0 ? (
          <EmptyState icon={Workflow} title="No rules yet" className="border-t border-line" action={manager ? <Button variant="primary" icon={Plus} onClick={() => setDialog({ rule: null })}>New rule</Button> : undefined}>
            {manager ? "A rule turns a signal into an action without anyone watching: “when a contact gets a funding signal, add them to this list and enrol them in that campaign”." : "A manager can write rules that act on signals as they arrive."}
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
                      <Pill size="sm" tone={state.tone}>{state.label}</Pill>
                    </div>
                    <p className="text-115 leading-[16px] text-ink-2"><span className="text-ink-3">When</span> {ruleWhen(rule).charAt(0).toLowerCase() + ruleWhen(rule).slice(1)} <span className="text-ink-3">→</span> {ruleThen(rule)}</p>
                    {rule.problem ? <p className="text-105 leading-[15px] text-bad">{rule.problem}</p> : null}
                  </div>
                  {manager ? (
                    <>
                      <Switch checked={Boolean(rule.enabled)} onChange={(enabled) => void setEnabled(rule, enabled)} label={`${rule.name} is ${rule.enabled ? "on" : "off"}`} />
                      <Menu trigger={<IconButton icon={Ellipsis} label={`Actions for ${rule.name}`} size={28} />}>
                        <MenuItem icon={Pencil} onSelect={() => setDialog({ rule })}>Edit rule</MenuItem>
                        <MenuSeparator />
                        <MenuItem icon={Trash2} tone="danger" onSelect={() => void remove(rule)}>Delete rule</MenuItem>
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
        Rules act on signals about a contact. A signal about a company alone (those Detection finds) is listed in the feed and sets off no rule.
      </p>
      {dialog ? <RuleDialog key={dialog.rule?.id ?? "new"} rule={dialog.rule} onClose={() => setDialog(null)} onSaved={(message) => { toast.success(message); void mutate(); }} /> : null}
    </>
  );
}

const NONE = "__none";

/** Write a rule, or change one. Mounted only while open. */
function RuleDialog({ rule, onClose, onSaved }: { rule: Rule | null; onClose: () => void; onSaved: (message: string) => void }) {
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
    if (found) return setProblem(found);
    setSaving(true);
    setProblem(null);
    try {
      if (rule) await api(RULES_PATH, { method: "PATCH", body: { id: rule.id, ...rulePayload(form) } });
      else await api(RULES_PATH, { method: "POST", body: rulePayload(form) });
      onSaved(rule ? `${form.name.trim()} saved` : `${form.name.trim()} is on`);
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
      title={rule ? "Edit rule" : "New rule"}
      description="What happens to a contact when a signal about them arrives"
      footer={
        <>
          <span className="text-105 text-ink-3">{rule && !rule.enabled ? "This rule is off. Saving does not turn it on." : ""}</span>
          <div className="flex items-center gap-2">
            <Button onClick={onClose} disabled={saving}>Cancel</Button>
            <Button variant="primary" loading={saving} onClick={() => void save()}>{rule ? "Save" : "Create rule"}</Button>
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
        <Field label="Name" error={error("name")}>
          {(id) => <Input id={id} data-autofocus maxLength={120} placeholder="Funding → Enterprise list" value={form.name} invalid={Boolean(error("name"))} onChange={(event) => set({ name: event.target.value })} />}
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_140px]">
          <Field label="When a signal of this kind arrives">
            {(id) => <Select<SignalType> id={id} className="w-full" value={form.signal_type} onChange={(signal_type) => set({ signal_type })} options={SIGNAL_TYPES.map((type) => ({ value: type, label: SIGNAL_TYPE_LABELS[type] }))} />}
          </Field>
          <Field label="Scoring at least" error={error("min_score")}>
            {(id) => <Input id={id} inputMode="numeric" value={form.min_score} invalid={Boolean(error("min_score"))} onFocus={(event) => event.target.select()} onChange={(event) => set({ min_score: event.target.value.replace(/[^\d.]/g, "") })} />}
          </Field>
        </div>
        <Field label="Add the contact to a list" error={error("list_id")}>
          {(id) => <Select id={id} className="w-full" value={form.list_id || NONE} onChange={(value) => set({ list_id: pick(value) })} options={choices(lists, "No list")} />}
        </Field>
        <Field label="Enrol them in a campaign" aside="Optional" hint="The campaign runs on the list above. A contact already in it is not enrolled twice.">
          {(id) => <Select id={id} className="w-full" value={form.workflow_id || NONE} onChange={(value) => set({ workflow_id: pick(value) })} options={choices(campaigns, "No campaign")} />}
        </Field>
        {form.workflow_id ? (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="From this LinkedIn account" error={error("account_id")}>
                {(id) => <Select id={id} className="w-full" value={form.account_id || NONE} onChange={(value) => set({ account_id: pick(value) })} options={choices(accounts, "None")} />}
              </Field>
              <Field label="And this mailbox" error={error("email_account_id")}>
                {(id) => <Select id={id} className="w-full" value={form.email_account_id || NONE} onChange={(value) => set({ email_account_id: pick(value) })} options={choices(mailboxes, "None", (item) => (item.from_email ? `${item.name} · ${item.from_email}` : item.name))} />}
              </Field>
            </div>
            <p className="-mt-2 text-105 leading-[15px] text-ink-3">A campaign with LinkedIn steps runs from the LinkedIn account, and its emails, if it has any, go from the mailbox. A campaign that only sends email needs just the mailbox.</p>
            <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-line px-3 py-2.5">
              <Switch checked={form.auto_start} onChange={(auto_start) => set({ auto_start })} label="Start the campaign by itself" className="mt-0.5" />
              <span className="flex flex-col gap-0.5">
                <span className="text-12 font-medium text-ink">Start the campaign by itself</span>
                <span className="text-105 leading-[15px] text-ink-3">Off: the first contact a signal enrols waits in a run that someone starts. On: the run starts at once, and messages go out with nobody looking.</span>
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
