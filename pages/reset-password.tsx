import { useRouter } from "next/router";
import { useState } from "react";
import {useTranslations} from "next-intl";
import {localizeAuthError} from "@/lib/client/localize-auth-error";
import { Lock, Mail } from "lucide-react";
import { AuthFrame, TextLink } from "@/components/auth/AuthFrame";
import { passwordProblem } from "@/components/auth/model";
import { Alert, Button, Field, Input } from "@/components/ui";

// One page for both halves of a reset: without a token it asks where to send the link,
// with the token from that link it asks for the new password.
export default function ResetPasswordPage() {
  const t = useTranslations("ResetPassword");
  const te = useTranslations("AuthErrors");
  const router = useRouter();
  const token = typeof router.query.token === "string" ? router.query.token : "";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);

  async function post(url: string, body: Record<string, string>) {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) setError(localizeAuthError((await res.json().catch(() => ({}))).error, te));
      return res.ok;
    } catch {
      setError(te("network"));
      return false;
    } finally {
      setLoading(false);
    }
  }

  async function requestLink(event: React.FormEvent) {
    event.preventDefault();
    if (await post("/api/auth/forgot-password", { email })) setSent(true);
  }

  async function setNewPassword(event: React.FormEvent) {
    event.preventDefault();
    const problem = passwordProblem(password, confirm);
    if (problem) { setError(localizeAuthError(problem, te)); return; }
    if (await post("/api/auth/reset-password", { token, password })) await router.replace("/login?notice=password-reset");
  }

  return (
    <AuthFrame
      title={t("title")}
      heading={token ? t("chooseNew") : sent ? t("checkEmail") : t("title")}
      lead={token ? t("setLead") : sent ? undefined : t("requestLead")}
      footer={<TextLink href="/login">{t("backToLogin")}</TextLink>}
    >
      {sent ? (
        <p role="status" className="text-125 leading-[19px] text-ink-2">
          {t("sent", {email})}
        </p>
      ) : token ? (
        <form onSubmit={setNewPassword} className="flex flex-col gap-4">
          <Field label={t("newPassword")} aside={t("minPassword")}>
            {(id) => <Input id={id} type="password" icon={Lock} required minLength={8} autoFocus autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} frameClassName="h-9" />}
          </Field>
          <Field label={t("repeatPassword")}>
            {(id) => <Input id={id} type="password" icon={Lock} required autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} frameClassName="h-9" />}
          </Field>
          {error ? <Alert tone="bad">{error}</Alert> : null}
          <Button type="submit" variant="primary" loading={loading} className="h-9 w-full">{t("setNewPassword")}</Button>
        </form>
      ) : (
        <form onSubmit={requestLink} className="flex flex-col gap-4">
          <Field label={t("workEmail")}>
            {(id) => <Input id={id} type="email" icon={Mail} required autoFocus autoComplete="email" placeholder="you@company.com" value={email} onChange={(event) => setEmail(event.target.value)} frameClassName="h-9" />}
          </Field>
          {error ? <Alert tone="bad">{error}</Alert> : null}
          <Button type="submit" variant="primary" loading={loading} className="h-9 w-full">{t("sendResetLink")}</Button>
        </form>
      )}
    </AuthFrame>
  );
}
