import { useState } from "react";
import { Check, Copy, UserPlus } from "lucide-react";
import { Alert, Button, Dialog, Field, Input, Select, Switch } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { ROLE_LABEL, ROLE_SUMMARY, grantableRoles, type WorkspaceRole } from "./model";

interface Created {
  email: string;
  invite_url: string;
  email_sent: boolean;
  delivery_warning: string | null;
}

/** Invite someone by email. The link is shown once, here, whether or not the email went. */
export function InviteDialog({ open, actorRole, workspaceName, onClose, onInvited }: { open: boolean; actorRole: WorkspaceRole; workspaceName: string; onClose: () => void; onInvited: () => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<WorkspaceRole>("member");
  const [sendEmail, setSendEmail] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [copied, setCopied] = useState(false);

  function close() {
    setEmail("");
    setRole("member");
    setSendEmail(true);
    setError(null);
    setCreated(null);
    setCopied(false);
    onClose();
  }

  async function invite() {
    const address = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return setError("Enter the person's email address.");
    setSaving(true);
    setError(null);
    try {
      setCreated(await api<Created>("/api/platform/invitations", { method: "POST", body: { email: address, role, send_email: sendEmail } }));
      onInvited();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  async function copy() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.invite_url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next || saving ? undefined : close())}
      size="sm"
      icon={UserPlus}
      title={created ? "Invitation ready" : "Invite a teammate"}
      description={created ? created.email : `To ${workspaceName}`}
      footer={
        created ? (
          <>
            <span className="text-105 text-ink-3">The link works once, for seven days.</span>
            <Button variant="primary" onClick={close}>Done</Button>
          </>
        ) : (
          <>
            <span />
            <div className="flex items-center gap-2">
              <Button onClick={close} disabled={saving}>Cancel</Button>
              <Button variant="primary" loading={saving} onClick={() => void invite()}>{sendEmail ? "Send invitation" : "Create invitation"}</Button>
            </div>
          </>
        )
      }
    >
      {created ? (
        <div className="flex flex-col gap-3">
          {created.email_sent ? (
            <Alert tone="good" title={`An email is on its way to ${created.email}`}>You can also pass the link on yourself.</Alert>
          ) : created.delivery_warning ? (
            <Alert tone="warn" title="The email could not be sent">{created.delivery_warning} Send them the link below yourself.</Alert>
          ) : (
            <Alert tone="info" title="No email was sent">Send them the link below yourself.</Alert>
          )}
          <Field label="Invitation link" hint="This is the only time the link is shown. Copy it now if you need it; a new one can be made later, which stops this one working.">
            {(id) => (
              <Input
                id={id} readOnly value={created.invite_url} className="font-mono text-11" onFocus={(event) => event.target.select()}
                trailing={
                  <button type="button" onClick={() => void copy()} className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-105 font-semibold text-brand-strong hover:bg-brand-tint">
                    {copied ? <Check size={11} aria-hidden="true" /> : <Copy size={11} aria-hidden="true" />}
                    {copied ? "Copied" : "Copy"}
                  </button>
                }
              />
            )}
          </Field>
        </div>
      ) : (
        <form
          className="flex flex-col gap-3.5"
          onSubmit={(event) => {
            event.preventDefault();
            void invite();
          }}
        >
          <Field label="Email address" error={error}>
            {(id) => <Input id={id} data-autofocus type="email" autoComplete="off" placeholder="teammate@company.com" value={email} invalid={Boolean(error)} onChange={(event) => setEmail(event.target.value)} />}
          </Field>
          <Field label="Role" hint={ROLE_SUMMARY[role]}>
            {(id) => <Select id={id} className="w-full" value={role} onChange={setRole} options={grantableRoles(actorRole).map((value) => ({ value, label: ROLE_LABEL[value] }))} />}
          </Field>
          <div className="flex items-start justify-between gap-3 rounded-lg bg-subtle p-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-12 font-medium text-ink">Email the invitation</span>
              <span className="text-11 leading-4 text-ink-2">{sendEmail ? "Sent from one of this workspace's mailboxes. You get the link as well." : "Nothing is sent. You get a link to pass on yourself."}</span>
            </div>
            <Switch checked={sendEmail} onChange={setSendEmail} label="Email the invitation" className="mt-0.5" />
          </div>
        </form>
      )}
    </Dialog>
  );
}
