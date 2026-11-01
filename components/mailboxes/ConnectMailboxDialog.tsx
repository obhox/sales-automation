import { useState } from "react";
import { useTranslations } from "next-intl";
import { Mail, Server } from "lucide-react";
import { toast } from "sonner";
import { Alert, Button, Dialog, Field, Input, Segmented, Select } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { NumberField, Section, SwitchRow, TimezoneField, numberProblem } from "@/components/linkedin-accounts/SettingsFields";

type Method = "gmail" | "smtp";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export interface ConnectMailboxDialogProps {
  open: boolean;
  /** Set when opened from a domain's "connect another": the address is expected to be on it. */
  domain: string | null;
  onClose: () => void;
  /** Called with the new mailbox's id once it is connected. */
  onConnected: (id: string, email: string) => void;
}

/** Connect a mailbox: a Gmail or Google Workspace address with an app password, or any other over SMTP and IMAP. */
export function ConnectMailboxDialog({ open, domain, onClose, onConnected }: ConnectMailboxDialogProps) {
  const t = useTranslations("MailboxConnect");
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }} title={t("title")} description={t("description")} icon={Mail} size="md">
      {open ? <ConnectForm domain={domain} onClose={onClose} onConnected={onConnected} /> : null}
    </Dialog>
  );
}

function ConnectForm({ domain, onClose, onConnected }: Omit<ConnectMailboxDialogProps, "open">) {
  const t = useTranslations("MailboxConnect");
  const [method, setMethod] = useState<Method>("gmail");
  const [email, setEmail] = useState("");
  const [fromName, setFromName] = useState("");
  const [limit, setLimit] = useState("50");
  const [timezone, setTimezone] = useState(browserZone);
  // Gmail
  const [appPassword, setAppPassword] = useState("");
  // SMTP and IMAP
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("587");
  const [security, setSecurity] = useState<"starttls" | "ssl">("starttls");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState("993");
  const [separateImap, setSeparateImap] = useState(false);
  const [imapUsername, setImapUsername] = useState("");
  const [imapPassword, setImapPassword] = useState("");
  const [selfSigned, setSelfSigned] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const address = email.trim().toLowerCase();
  const offDomain = Boolean(domain) && EMAIL.test(address) && !address.endsWith(`@${domain}`);
  const limitBad = numberProblem(limit, 1, 500, false) !== null;
  const password16 = appPassword.replace(/\s/g, "");
  const ready = EMAIL.test(address) && !limitBad && Boolean(timezone) && (
    method === "gmail"
      ? /^[A-Za-z0-9]{16}$/.test(password16)
      : Boolean(smtpHost.trim() && Number(smtpPort) > 0 && password && (!imapHost.trim() || Number(imapPort) > 0))
  );

  async function connect() {
    setSaving(true);
    setError(null);
    try {
      const created = method === "gmail"
        ? await api<{ id: string }>("/api/email-accounts/gmail-app-password", { method: "POST", body: { email: address, app_password: password16, from_name: fromName.trim(), daily_email_limit: Number(limit), timezone } })
        : await api<{ id: string }>("/api/email-accounts", {
            method: "POST",
            body: {
              verify: true, name: fromName.trim() || address, from_email: address, from_name: fromName.trim() || null,
              smtp_host: smtpHost.trim(), smtp_port: Number(smtpPort), smtp_secure: security === "ssl" ? 1 : 0,
              username: username.trim() || address, password,
              imap_host: imapHost.trim() || null, imap_port: Number(imapPort) || 993,
              ...(separateImap && imapHost.trim() ? { imap_username: imapUsername.trim() || null, imap_password: imapPassword || null } : {}),
              daily_email_limit: Number(limit), timezone, allow_self_signed: selfSigned,
            },
          });
      toast.success(t("connected", {email: address}), { description: t("connectedHint") });
      onConnected(created.id, address);
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="flex flex-col gap-5" onSubmit={(event) => { event.preventDefault(); if (ready && !saving) void connect(); }}>
      <Segmented
        label={t("authMethod")} value={method} onChange={setMethod} className="self-start"
        options={[{ value: "gmail", label: t("gmailMethod"), icon: Mail }, { value: "smtp", label: t("smtpMethod"), icon: Server }]}
      />

      <Section
        title={t("mailbox")}
        hint={method === "gmail"
          ? t("gmailHint")
          : t("smtpHint")}
      >
        <div className="grid grid-cols-2 gap-2.5">
          <Field label={t("email")} error={offDomain ? t("otherDomain", {domain: domain ?? ""}) : undefined}>
            {(id) => <Input id={id} type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder={domain ? `name@${domain}` : "name@yourdomain.com"} autoComplete="off" spellCheck={false} autoFocus required />}
          </Field>
          <Field label={t("senderName")} hint={t("senderNameHint")}>
            {(id) => <Input id={id} value={fromName} onChange={(event) => setFromName(event.target.value)} placeholder="Ada Lovelace" maxLength={120} />}
          </Field>
        </div>
        {method === "gmail" ? (
          <Field label={t("appPassword")} hint={t("appPasswordHint")}>
            {(id) => <Input id={id} type="password" value={appPassword} onChange={(event) => setAppPassword(event.target.value)} placeholder="xxxx xxxx xxxx xxxx" autoComplete="new-password" spellCheck={false} required />}
          </Field>
        ) : null}
      </Section>

      {method === "smtp" ? (
        <>
          <Section title={t("smtpSending")}>
            <div className="grid grid-cols-[1fr_92px_132px] gap-2.5">
              <Field label={t("server")}>
                {(id) => <Input id={id} value={smtpHost} onChange={(event) => setSmtpHost(event.target.value)} placeholder="smtp.yourprovider.com" autoComplete="off" spellCheck={false} required />}
              </Field>
              <Field label={t("port")}>
                {(id) => <Input id={id} inputMode="numeric" value={smtpPort} onChange={(event) => setSmtpPort(event.target.value.replace(/[^0-9]/g, "").slice(0, 5))} required />}
              </Field>
              <Field label={t("security")}>
                {(id) => (
                  <Select
                    id={id} className="w-full" value={security}
                    onChange={(value) => { setSecurity(value); if (value === "ssl" && smtpPort === "587") setSmtpPort("465"); if (value === "starttls" && smtpPort === "465") setSmtpPort("587"); }}
                    options={[{ value: "starttls", label: "STARTTLS" }, { value: "ssl", label: "SSL / TLS" }]}
                  />
                )}
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <Field label={t("username")} hint={t("usernameHint")}>
                {(id) => <Input id={id} value={username} onChange={(event) => setUsername(event.target.value)} placeholder={address || "name@yourdomain.com"} autoComplete="off" spellCheck={false} />}
              </Field>
              <Field label={t("password")}>
                {(id) => <Input id={id} type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" required />}
              </Field>
            </div>
          </Section>

          <Section title={t("imapReading")} hint={t("imapHint")}>
            <div className="grid grid-cols-[1fr_92px] gap-2.5">
              <Field label={t("server")}>
                {(id) => <Input id={id} value={imapHost} onChange={(event) => setImapHost(event.target.value)} placeholder="imap.yourprovider.com" autoComplete="off" spellCheck={false} />}
              </Field>
              <Field label={t("port")}>
                {(id) => <Input id={id} inputMode="numeric" value={imapPort} onChange={(event) => setImapPort(event.target.value.replace(/[^0-9]/g, "").slice(0, 5))} disabled={!imapHost.trim()} />}
              </Field>
            </div>
            {imapHost.trim() ? (
              <>
                <SwitchRow label={t("separateImap")} hint={t("separateHint")} checked={separateImap} onChange={setSeparateImap} />
                {separateImap ? (
                  <div className="grid grid-cols-2 gap-2.5">
                    <Field label={t("imapUser")}>
                      {(id) => <Input id={id} value={imapUsername} onChange={(event) => setImapUsername(event.target.value)} autoComplete="off" spellCheck={false} />}
                    </Field>
                    <Field label={t("imapPassword")}>
                      {(id) => <Input id={id} type="password" value={imapPassword} onChange={(event) => setImapPassword(event.target.value)} autoComplete="new-password" />}
                    </Field>
                  </div>
                ) : null}
              </>
            ) : null}
            <SwitchRow label={t("selfSigned")} hint={t("selfSignedHint")} checked={selfSigned} onChange={setSelfSigned} />
          </Section>
        </>
      ) : null}

      <Section title={t("sending")} hint={t("sendingHint")}>
        <div className="grid grid-cols-2 gap-2.5">
          <NumberField label={t("dailyLimit")} value={limit} onChange={setLimit} min={1} max={500} unit={t("dayUnit")} />
          <TimezoneField value={timezone} onChange={setTimezone} />
        </div>
      </Section>

      {error ? <Alert tone="bad" title={t("connectionFailed")}>{error}</Alert> : null}

      <div className="sticky -bottom-5 -mx-5 -mb-5 flex h-16 items-center justify-end gap-2.5 border-t border-line bg-subtle px-5">
        <Button variant="secondary" onClick={onClose}>{t("cancel")}</Button>
        <Button type="submit" variant="primary" loading={saving} disabled={!ready}>{saving ? t("signingIn") : t("connect")}</Button>
      </div>
    </form>
  );
}
