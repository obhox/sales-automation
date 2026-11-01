import { signIn } from "next-auth/react";
import { useRouter } from "next/router";
import { useState } from "react";
import {useTranslations} from "next-intl";
import {localizeAuthError} from "@/lib/client/localize-auth-error";
import { Lock, Mail } from "lucide-react";
import { AuthFrame, TextLink } from "@/components/auth/AuthFrame";
import { safeCallback } from "@/components/auth/model";
import { Alert, Button, Field, Input, Segmented } from "@/components/ui";

type Mode = "signin" | "signup";

/** Sign in, or create an account with a workspace of its own. */
export default function LoginPage() {
  const t = useTranslations("Login");
  const te = useTranslations("AuthErrors");
  const router = useRouter();
  const callbackUrl = safeCallback(router.query.callbackUrl);
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  // The address a confirmation email is waiting on, once sign-in or sign-up says there is one.
  const [unverified, setUnverified] = useState("");
  const [info, setInfo] = useState("");
  const noticeMap: Record<string, string> = {
    "password-reset": t("notices.passwordReset"),
    "password-changed": t("notices.passwordChanged"),
    "email-verified": t("notices.emailVerified"),
    "session-ended": t("notices.sessionEnded"),
  };
  const notice = typeof router.query.notice === "string" ? noticeMap[router.query.notice] ?? "" : "";

  function switchMode(next: Mode) {
    setMode(next);
    setError("");
    setUnverified("");
    setInfo("");
  }

  async function resendVerification() {
    setError("");
    try {
      const res = await fetch("/api/auth/resend-verification", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: unverified }) });
      if (res.ok) setInfo(t("confirmationResent", {email: unverified}));
      else setError(localizeAuthError((await res.json().catch(() => ({}))).error, te, "emailFailed"));
    } catch {
      setError(te("network"));
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (loading) return;
    setLoading(true);
    setError("");
    setInfo("");
    setUnverified("");
    try {
      if (mode === "signup") {
        const res = await fetch("/api/auth/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { setError(localizeAuthError(data.error, te, "signupFailed")); return; }
        // Nothing to sign in to until the address is confirmed.
        if (data.verification_required) { setPassword(""); setMode("signin"); setUnverified(email); return; }
      }
      const res = await signIn("credentials", { email, password, redirect: false });
      if (res?.ok) { await router.replace(callbackUrl); return; }
      if (res?.error === "EMAIL_NOT_VERIFIED") setUnverified(email);
      else if (mode === "signup") { setError(t("signupSignInFailed")); setMode("signin"); }
      else setError(t("invalidCredentials"));
    } catch {
      setError(te("network"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthFrame
      aside
      title={mode === "signin" ? t("signIn") : t("createAnAccount")}
      heading={mode === "signin" ? t("signInHeading") : t("createHeading")}
      lead={mode === "signin" ? t("signInLead") : t("createLead")}
      footer={mode === "signin" ? <>{t("invited")}</> : <>{t("alreadyHaveAccount")} <button type="button" onClick={() => switchMode("signin")} className="font-semibold text-brand-strong hover:underline">{t("signIn")}</button></>}
    >
      <Segmented label={t("formMode")} value={mode} onChange={switchMode} options={[{ value: "signin", label: t("signIn") }, { value: "signup", label: t("createAccount") }]} className="grid w-full grid-cols-2 [&>button]:justify-center" />
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate={false}>
        <Field label={t("workEmail")}>
          {(id) => <Input id={id} type="email" icon={Mail} required autoFocus autoComplete="email" placeholder="you@company.com" value={email} onChange={(event) => setEmail(event.target.value)} frameClassName="h-9" />}
        </Field>
        <Field label={t("password")} aside={mode === "signin" ? <TextLink href="/reset-password">{t("forgot")}</TextLink> : t("minPassword")}>
          {(id) => <Input id={id} type="password" icon={Lock} required minLength={mode === "signup" ? 8 : undefined} autoComplete={mode === "signup" ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} frameClassName="h-9" />}
        </Field>

        {notice && !error && !unverified && !info ? <Alert tone="info">{notice}</Alert> : null}
        {unverified ? (
          <Alert tone="warn" title={t("confirmEmail")} actions={<Button size="sm" onClick={() => void resendVerification()}>{t("sendAgain")}</Button>}>
            {t("confirmationSent", {email: unverified})}{info ? <> {info}</> : null}
          </Alert>
        ) : null}
        {error ? <Alert tone="bad">{error}</Alert> : null}

        <Button type="submit" variant="primary" loading={loading} className="h-9 w-full">{mode === "signin" ? t("signIn") : t("createAccount")}</Button>
      </form>
    </AuthFrame>
  );
}
