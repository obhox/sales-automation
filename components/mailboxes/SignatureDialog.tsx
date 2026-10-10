import { useState } from "react";
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
  return (
    <Dialog open={mailbox !== null} onOpenChange={(open) => { if (!open) onClose(); }} title="Signature" description={mailbox?.from_email} icon={Signature} size="sm">
      {mailbox ? <SignatureForm key={mailbox.id} mailbox={mailbox} onClose={onClose} onSaved={onSaved} /> : null}
    </Dialog>
  );
}

function SignatureForm({ mailbox, onClose, onSaved }: { mailbox: MailboxView; onClose: () => void; onSaved: () => void }) {
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
      toast.success(`Signature saved for ${mailbox.from_email}`);
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
      <Field label="Signature" aside={`${text.length} / ${MAX}`} hint="Plain text, one line under another. It goes under a campaign email after a line with two dashes. A step with its own signature uses that instead." error={text.length > MAX ? "Too long." : undefined}>
        {(id) => <Textarea id={id} rows={7} value={text} onChange={(event) => setText(event.target.value)} placeholder={"Ada Lovelace\nAccount Executive · Analytical Engines\n+44 20 7946 0000"} autoFocus />}
      </Field>
      <label className="flex items-start gap-[9px] text-12 text-ink">
        <Checkbox checked={firstOnly} onChange={setFirstOnly} className="mt-px" label="Append to the first email of a sequence only" />
        <span className="flex flex-col gap-0.5">
          Append to the first email of a sequence only
          <span className="text-11 leading-4 text-ink-2">Follow-ups to the same contact go without it. A follow-up sent in the same conversation already has the first email, signature and all, below it.</span>
        </span>
      </label>
      {error ? <Alert tone="bad">{error}</Alert> : null}
      <div className="sticky -bottom-5 -mx-5 -mb-5 flex h-16 items-center justify-end gap-2.5 border-t border-line bg-subtle px-5">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" loading={saving} disabled={!dirty || text.length > MAX}>Save signature</Button>
      </div>
    </form>
  );
}
