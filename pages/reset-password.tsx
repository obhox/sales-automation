import { useRouter } from "next/router";
import { useState } from "react";
import { Lock, Mail } from "lucide-react";
import { AuthFrame, TextLink } from "@/components/auth/AuthFrame";
import { passwordProblem } from "@/components/auth/model";
import { Alert, Button, Field, Input } from "@/components/ui";

// One page for both halves of a reset: without a token it asks where to send the link,
// with the token from that link it asks for the new password.
export default function ResetPasswordPage() {
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
      if (!res.ok) setError((await res.json().catch(() => ({}))).error ?? "That did not work. Try again.");
      return res.ok;
    } catch {
      setError("The server could not be reached. Try again.");
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
    if (problem) { setError(problem); return; }
    if (await post("/api/auth/reset-password", { token, password })) await router.replace("/login?notice=password-reset");
  }

  return (
    <AuthFrame
      title="Reset your password"
      heading={token ? "Choose a new password" : sent ? "Check your email" : "Reset your password"}
      lead={token ? "Setting a new password signs this account out everywhere it is signed in." : sent ? undefined : "Enter the email you sign in with, and a link to choose a new password is sent to it."}
      footer={<TextLink href="/login">Back to sign in</TextLink>}
    >
      {sent ? (
        <p role="status" className="text-125 leading-[19px] text-ink-2">
          If <span className="font-medium text-ink">{email}</span> has a Linki account, a reset link is on its way. It works once and expires in an hour.
        </p>
      ) : token ? (
        <form onSubmit={setNewPassword} className="flex flex-col gap-4">
          <Field label="New password" aside="At least 8 characters">
            {(id) => <Input id={id} type="password" icon={Lock} required minLength={8} autoFocus autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} frameClassName="h-9" />}
          </Field>
          <Field label="Repeat it">
            {(id) => <Input id={id} type="password" icon={Lock} required autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} frameClassName="h-9" />}
          </Field>
          {error ? <Alert tone="bad">{error}</Alert> : null}
          <Button type="submit" variant="primary" loading={loading} className="h-9 w-full">Set new password</Button>
        </form>
      ) : (
        <form onSubmit={requestLink} className="flex flex-col gap-4">
          <Field label="Work email">
            {(id) => <Input id={id} type="email" icon={Mail} required autoFocus autoComplete="email" placeholder="you@company.com" value={email} onChange={(event) => setEmail(event.target.value)} frameClassName="h-9" />}
          </Field>
          {error ? <Alert tone="bad">{error}</Alert> : null}
          <Button type="submit" variant="primary" loading={loading} className="h-9 w-full">Send reset link</Button>
        </form>
      )}
    </AuthFrame>
  );
}
