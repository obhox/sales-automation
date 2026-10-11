import { signIn } from "next-auth/react";
import { useRouter } from "next/router";
import { useState } from "react";
import { Lock, Mail } from "lucide-react";
import { AuthFrame, TextLink } from "@/components/auth/AuthFrame";
import { NOTICES, safeCallback } from "@/components/auth/model";
import { Alert, Button, Field, Input, Segmented } from "@/components/ui";

type Mode = "signin" | "signup";

/** Sign in, or create an account with a workspace of its own. */
export default function LoginPage() {
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
  const notice = typeof router.query.notice === "string" ? NOTICES[router.query.notice] ?? "" : "";

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
      if (res.ok) setInfo(`A new confirmation link is on its way to ${unverified}.`);
      else setError((await res.json().catch(() => ({}))).error ?? "The email could not be sent.");
    } catch {
      setError("The server could not be reached. Try again.");
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
        if (!res.ok) { setError(data.error ?? "The account could not be created."); return; }
        // Nothing to sign in to until the address is confirmed.
        if (data.verification_required) { setPassword(""); setMode("signin"); setUnverified(email); return; }
      }
      const res = await signIn("credentials", { email, password, redirect: false });
      if (res?.ok) { await router.replace(callbackUrl); return; }
      if (res?.error === "EMAIL_NOT_VERIFIED") setUnverified(email);
      else if (mode === "signup") { setError("The account was created, but signing in failed. Sign in with the password you chose."); setMode("signin"); }
      else setError("That email and password do not match an account.");
    } catch {
      setError("The server could not be reached. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthFrame
      aside
      title={mode === "signin" ? "Sign in" : "Create an account"}
      heading={mode === "signin" ? "Sign in to Linki" : "Create your account"}
      lead={mode === "signin" ? "Pick up where your team left off." : "You get a workspace of your own, and can invite others to it."}
      footer={mode === "signin" ? <>Invited to a workspace? Open the link in the invitation email.</> : <>Already have an account? <button type="button" onClick={() => switchMode("signin")} className="font-semibold text-brand-strong hover:underline">Sign in</button></>}
    >
      <Segmented label="Sign in or create an account" value={mode} onChange={switchMode} options={[{ value: "signin", label: "Sign in" }, { value: "signup", label: "Create account" }]} className="grid w-full grid-cols-2 [&>button]:justify-center" />
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate={false}>
        <Field label="Work email">
          {(id) => <Input id={id} type="email" icon={Mail} required autoFocus autoComplete="email" placeholder="you@company.com" value={email} onChange={(event) => setEmail(event.target.value)} frameClassName="h-9" />}
        </Field>
        <Field label="Password" aside={mode === "signin" ? <TextLink href="/reset-password">Forgot it?</TextLink> : "At least 8 characters"}>
          {(id) => <Input id={id} type="password" icon={Lock} required minLength={mode === "signup" ? 8 : undefined} autoComplete={mode === "signup" ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} frameClassName="h-9" />}
        </Field>

        {notice && !error && !unverified && !info ? <Alert tone="info">{notice}</Alert> : null}
        {unverified ? (
          <Alert tone="warn" title="Confirm your email to sign in" actions={<Button size="sm" onClick={() => void resendVerification()}>Send it again</Button>}>
            A confirmation link was sent to <span className="font-medium text-ink">{unverified}</span>.{info ? <> {info}</> : null}
          </Alert>
        ) : null}
        {error ? <Alert tone="bad">{error}</Alert> : null}

        <Button type="submit" variant="primary" loading={loading} className="h-9 w-full">{mode === "signin" ? "Sign in" : "Create account"}</Button>
      </form>
    </AuthFrame>
  );
}
