import { useState } from "react";
import { useTranslations } from "next-intl";
import { Signature } from "lucide-react";
import { toast } from "sonner";
import { Alert, Button, Checkbox, Dialog, Field, Textarea } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import type { MailboxView } from "./model";

const MAX = 4000;

export interface SignatureDialogProps {
  /** The mailbox whose signature is being edited; null closes the dialog. */
  mailbox: MailboxView | null;
  onClose: () => void;
  onSaved: () => void;
}

export function SignatureDialog({ mailbox, onClose, onSaved }: SignatureDialogProps) {
  const t = useTranslations("MailboxSignature");
  return (
    <Dialog open={mailbox !== null} onOpenChange={(open) => { if (!open) onClose(); }} title={t("title")} description={mailbox?.from_email} icon={Signature} size="sm">
      {mailbox ? <SignatureForm key={mailbox.id} mailbox={mailbox} onClose={onClose} onSaved={onSaved} /> : null}
    </Dialog>
  );
}

function SignatureForm({ mailbox, onClose, onSaved }: { mailbox: MailboxView; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations("MailboxSignature");
  const [text, setText] = useState(mailbox.signature ?? "");
  const [firstOnly, setFirstOnly] = useState(mailbox.signature_first_only);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = text !== (mailbox.signature ?? "") || firstOnly !== mailbox.signature_first_only;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api(`/api/email-accounts/${mailbox.id}`, { method: "PUT", body: { signature: text.trim() ? text.replace(/\s+$/, "") : null, signature_first_only: firstOnly } });
      toast.success(t("saved", {email: mailbox.from_email}));
      onSaved();
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); if (dirty && !saving && text.length <= MAX) void save(); }}>
      <Field label={t("field")} aside={`${text.length} / ${MAX}`} hint={t("hint")} error={text.length > MAX ? t("tooLong") : undefined}>
        {(id) => <Textarea id={id} rows={7} value={text} onChange={(event) => setText(event.target.value)} placeholder={t("sample")} autoFocus />}
      </Field>
      <label className="flex items-start gap-[9px] text-12 text-ink">
        <Checkbox checked={firstOnly} onChange={setFirstOnly} className="mt-px" label={t("firstOnly")} />
        <span className="flex flex-col gap-0.5">
          {t("firstOnly")}
          <span className="text-11 leading-4 text-ink-2">{t("followups")}</span>
        </span>
      </label>
      {error ? <Alert tone="bad">{error}</Alert> : null}
      <div className="sticky -bottom-5 -mx-5 -mb-5 flex h-16 items-center justify-end gap-2.5 border-t border-line bg-subtle px-5">
        <Button variant="secondary" onClick={onClose}>{t("cancel")}</Button>
        <Button type="submit" variant="primary" loading={saving} disabled={!dirty || text.length > MAX}>{t("save")}</Button>
      </div>
    </form>
  );
}
