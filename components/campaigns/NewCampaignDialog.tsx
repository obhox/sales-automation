import { useState } from "react";
import { useRouter } from "next/router";
import { SendHorizontal } from "lucide-react";
import { Button, Dialog, Field, Input, Textarea } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { campaignHref } from "./model";

/** A name is all a campaign needs to exist; its steps and its audience are added on its own page. */
export function NewCampaignDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }} title="New campaign" description="Name it now. Its steps and its list come next." icon={SendHorizontal} size="sm">
      {/* Mounted only while open, so each new campaign starts from empty fields. */}
      {open ? <NewCampaignForm onClose={onClose} /> : null}
    </Dialog>
  );
}

function NewCampaignForm({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setSaving(true);
    setError(null);
    try {
      const created = await api<{ id: string }>("/api/workflows", { method: "POST", body: { name: name.trim(), description: description.trim() || undefined } });
      await router.push(`${campaignHref(created.id)}?setup=1`);
    } catch (cause) {
      setError(errorMessage(cause));
      setSaving(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-3.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim() && !saving) void create();
      }}
    >
      <Field label="Name" error={error ?? undefined}>
        {(id) => <Input id={id} value={name} onChange={(event) => setName(event.target.value)} placeholder="Q4 Enterprise, VP Sales" maxLength={160} autoComplete="off" data-autofocus />}
      </Field>
      <Field label="What it is for" hint="Optional. Shown to your team, never to contacts.">
        {(id) => <Textarea id={id} value={description} onChange={(event) => setDescription(event.target.value)} rows={2} maxLength={500} />}
      </Field>
      <div className="flex justify-end gap-2.5 pt-1">
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" loading={saving} disabled={!name.trim()}>Create campaign</Button>
      </div>
    </form>
  );
}
