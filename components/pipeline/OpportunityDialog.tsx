import { useState } from "react";
import {useTranslations} from "next-intl";
import { Handshake, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button, Dialog, Field, Input, Select, confirm } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import { createOpportunity, deleteOpportunity, updateOpportunity, type OpportunityBody } from "./api";
import { RecordSearch, type Picked } from "./RecordSearch";
import { amountFrom, memberName, sourceLabel, type Member, type Opportunity, type Stage } from "./model";

export type OpportunityDraft = { mode: "new"; stageId: string | null } | { mode: "edit"; opportunity: Opportunity };

const NOBODY = "none";

/** Add an opportunity, or change one: its name, worth, stage, owner, where it came from, and who it is with. */
export function OpportunityDialog({ draft, stages, members, sources, currency, me, onClose, onSaved }: {
  draft: OpportunityDraft; stages: Stage[]; members: Member[]; sources: string[]; currency: string; me: string | null; onClose: () => void; onSaved: () => void;
}) {
  const t = useTranslations("PipelineOpportunity");
  const existing = draft.mode === "edit" ? draft.opportunity : null;
  const [name, setName] = useState(existing?.name ?? "");
  const [amount, setAmount] = useState(existing?.amount === null || existing?.amount === undefined ? "" : String(existing.amount));
  const [code, setCode] = useState(existing?.currency ?? currency);
  const [stageId, setStageId] = useState<string | undefined>(existing ? existing.stage_id ?? undefined : draft.mode === "new" ? draft.stageId ?? stages[0]?.id : undefined);
  const [closeDate, setCloseDate] = useState(existing?.expected_close_date ?? "");
  const [owner, setOwner] = useState(existing ? existing.owner_id ?? NOBODY : me && members.some((member) => member.id === me) ? me : NOBODY);
  const [source, setSource] = useState(existing?.source ?? "manual");
  const [contact, setContact] = useState<Picked | null>(existing?.target_id ? { id: existing.target_id, label: existing.contact_name ?? "Contact" } : null);
  const [company, setCompany] = useState<Picked | null>(existing?.company_id ? { id: existing.company_id, label: existing.company_name ?? "Company" } : null);
  const [error, setError] = useState<{ field: "name" | "amount" | "currency"; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // A source an integration wrote is kept as a choice, so opening and saving does not change it.
  const sourceOptions = [...new Set([...sources, source])].map((value) => ({ value, label: sourceLabel(value) }));

  async function save() {
    const worth = amountFrom(amount);
    if (!name.trim()) return setError({ field: "name", message: t("nameError") });
    if (worth === undefined) return setError({ field: "amount", message: t("amountError") });
    if (!/^[A-Za-z]{3}$/.test(code.trim())) return setError({ field: "currency", message: t("currencyError") });
    setError(null);
    const body: OpportunityBody = {
      name: name.trim(), amount: worth, currency: code.trim().toUpperCase(), stage_id: stageId ?? null, expected_close_date: closeDate || null,
      owner_id: owner === NOBODY ? null : owner, source, target_id: contact?.id ?? null, company_id: company?.id ?? null,
    };
    setBusy(true);
    try {
      if (existing) await updateOpportunity(existing.id, body);
      else await createOpportunity(body);
      toast.success(existing ? t("saved") : t("added"));
      onSaved();
      onClose();
    } catch (cause) { toast.error(errorMessage(cause)); } finally { setBusy(false); }
  }

  async function remove() {
    if (!existing) return;
    if (!(await confirm({ title: t("deleteTitle", {name: existing.name}), body: t("deleteHelp"), confirmLabel: t("delete"), tone: "danger" }))) return;
    setBusy(true);
    try {
      await deleteOpportunity(existing.id);
      toast.success(t("deleted"));
      onSaved();
      onClose();
    } catch (cause) { toast.error(errorMessage(cause)); } finally { setBusy(false); }
  }

  return (
    <Dialog
      open onOpenChange={(next) => { if (!next) onClose(); }} title={existing ? t("edit") : t("new")} icon={Handshake}
      footer={
        <>
          {existing ? <Button variant="ghost" icon={Trash2} disabled={busy} onClick={() => void remove()}>{t("delete")}</Button> : <span />}
          <span className="flex items-center gap-2">
            <Button onClick={onClose}>{t("cancel")}</Button>
            <Button variant="primary" loading={busy} onClick={() => void save()}>{existing ? t("save") : t("add")}</Button>
          </span>
        </>
      }
    >
      <form className="flex flex-col gap-3.5" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <Field label={t("name")} error={error?.field === "name" ? error.message : undefined}>
          {(id) => <Input id={id} data-autofocus value={name} onChange={(event) => { setName(event.target.value); setError(null); }} placeholder="Northwind Logistics" invalid={error?.field === "name"} maxLength={200} />}
        </Field>
        <div className="grid grid-cols-[1fr_96px_1fr] gap-3">
          <Field label={t("amount")} error={error?.field === "amount" ? error.message : undefined}>
            {(id) => <Input id={id} inputMode="decimal" value={amount} onChange={(event) => { setAmount(event.target.value); setError(null); }} placeholder="18,000" invalid={error?.field === "amount"} />}
          </Field>
          <Field label={t("currency")} error={error?.field === "currency" ? error.message : undefined}>
            {(id) => <Input id={id} value={code} onChange={(event) => { setCode(event.target.value); setError(null); }} maxLength={3} className="uppercase" invalid={error?.field === "currency"} />}
          </Field>
          <Field label={t("expectedClose")}>
            {(id) => <Input id={id} type="date" value={closeDate} onChange={(event) => setCloseDate(event.target.value)} />}
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label={t("stage")}>
            {(id) => <Select id={id} className="w-full" value={stageId} onChange={setStageId} placeholder={t("noStage")} options={stages.map((stage) => ({ value: stage.id, label: stage.name, hint: `${stage.probability}%` }))} />}
          </Field>
          <Field label={t("owner")}>
            {(id) => <Select id={id} className="w-full" value={owner} onChange={setOwner} options={[...members.map((member) => ({ value: member.id, label: memberName(member) })), { value: NOBODY, label: t("noOwner") }]} />}
          </Field>
          <Field label={t("source")}>
            {(id) => <Select id={id} className="w-full" value={source} onChange={setSource} options={sourceOptions} />}
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("contact")} hint={t("contactHint")}>{(id) => <RecordSearch id={id} kind="contact" value={contact} onChange={setContact} />}</Field>
          <Field label={t("company")}>{(id) => <RecordSearch id={id} kind="company" value={company} onChange={setCompany} />}</Field>
        </div>
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Dialog>
  );
}
