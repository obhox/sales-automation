import { useState } from "react";
import { useTranslations } from "next-intl";
import { Check, Copy, UserPlus } from "lucide-react";
import { Alert, Button, Dialog, Field, Input, Select, Switch } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { grantableRoles, type WorkspaceRole } from "./model";

interface Created {
  email: string;
  invite_url: string;
  email_sent: boolean;
  delivery_warning: string | null;
}

/** Invite someone by email. The link is shown once, here, whether or not the email went. */
export function InviteDialog({ open, actorRole, workspaceName, onClose, onInvited }: { open: boolean; actorRole: WorkspaceRole; workspaceName: string; onClose: () => void; onInvited: () => void }) {
  const t = useTranslations("TeamInvite");
  const roleSummary: Record<WorkspaceRole, string> = {
    owner: t("summaryOwner"), admin: t("summaryAdmin"), manager: t("summaryManager"),
    member: t("summaryMember"), viewer: t("summaryViewer"),
  };
  const roleLabels: Record<WorkspaceRole, string> = {
    owner: t("labelOwner"), admin: t("labelAdmin"), manager: t("labelManager"),
    member: t("labelMember"), viewer: t("labelViewer"),
  };
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
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return setError(t("invalidEmail"));
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
      title={created ? t("ready") : t("invite")}
      description={created ? created.email : t("workspace", {name: workspaceName})}
      footer={
        created ? (
          <>
            <span className="text-105 text-ink-3">{t("once")}</span>
            <Button variant="primary" onClick={close}>{t("done")}</Button>
          </>
        ) : (
          <>
            <span />
            <div className="flex items-center gap-2">
              <Button onClick={close} disabled={saving}>{t("cancel")}</Button>
              <Button variant="primary" loading={saving} onClick={() => void invite()}>{sendEmail ? t("send") : t("create")}</Button>
            </div>
          </>
        )
      }
    >
      {created ? (
        <div className="flex flex-col gap-3">
          {created.email_sent ? (
            <Alert tone="good" title={t("emailSent", {email: created.email})}>{t("manualHint")}</Alert>
          ) : created.delivery_warning ? (
            <Alert tone="warn" title={t("sendFailure")}>{created.delivery_warning} {t("sendByHand")}</Alert>
          ) : (
            <Alert tone="info" title={t("noEmail")}>{t("sendByHand")}</Alert>
          )}
          <Field label={t("inviteLink")} hint={t("inviteLinkHint")}>
            {(id) => (
              <Input
                id={id} readOnly value={created.invite_url} className="font-mono text-11" onFocus={(event) => event.target.select()}
                trailing={
                  <button type="button" onClick={() => void copy()} className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-105 font-semibold text-brand-strong hover:bg-brand-tint">
                    {copied ? <Check size={11} aria-hidden="true" /> : <Copy size={11} aria-hidden="true" />}
                    {copied ? t("copied") : t("copy")}
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
          <Field label={t("emailLabel")} error={error}>
            {(id) => <Input id={id} data-autofocus type="email" autoComplete="off" placeholder="teammate@company.com" value={email} invalid={Boolean(error)} onChange={(event) => setEmail(event.target.value)} />}
          </Field>
          <Field label={t("role")} hint={roleSummary[role]}>
            {(id) => <Select id={id} className="w-full" value={role} onChange={setRole} options={grantableRoles(actorRole).map((value) => ({ value, label: roleLabels[value] }))} />}
          </Field>
          <div className="flex items-start justify-between gap-3 rounded-lg bg-subtle p-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-12 font-medium text-ink">{t("emailSwitch")}</span>
              <span className="text-11 leading-4 text-ink-2">{sendEmail ? t("sendingHint") : t("linkOnly")}</span>
            </div>
            <Switch checked={sendEmail} onChange={setSendEmail} label={t("emailSwitch")} className="mt-0.5" />
          </div>
        </form>
      )}
    </Dialog>
  );
}
