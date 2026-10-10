import Head from "next/head";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/router";
import { useState } from "react";
import { RiArrowRightLine, RiLockPasswordLine, RiMailLine } from "react-icons/ri";

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
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    setLoading(false);
    if (!res.ok) setError((await res.json().catch(() => ({}))).error ?? "Something went wrong.");
    return res.ok;
  }

  async function requestLink(e: React.FormEvent) {
    e.preventDefault();
    if (await post("/api/auth/forgot-password", { email })) setSent(true);
  }

  async function setNewPassword(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) { setError("The two passwords don't match."); return; }
    if (await post("/api/auth/reset-password", { token, password })) router.replace("/login?notice=password-reset");
  }

  return (
    <>
      <Head>
        <title>Reset your password — Linki</title>
        <meta name="robots" content="noindex, nofollow" />
      </Head>
      <div className="flex min-h-screen items-center justify-center bg-base-200 px-5 py-10">
        <div className="w-full max-w-[410px] rounded-[14px] border border-base-300 bg-base-100 p-6 shadow-[var(--shadow-raised)] sm:p-8">
          <Image src="/linki-wordmark.svg" alt="Linki" width={104} height={30} priority className="mb-8" />
          <h1 className="text-[28px] font-semibold tracking-[-.01em] text-base-content">{token ? "Choose a new password" : "Reset your password"}</h1>

          {sent ? (
            <p role="status" className="mt-3 text-sm leading-6 text-base-content/65">
              If <span className="font-medium text-base-content">{email}</span> has a Linki account, a reset link is on its way. It works once and expires in an hour.
            </p>
          ) : token ? (
            <form onSubmit={setNewPassword} className="mt-6 flex flex-col gap-5">
              <div className="flex flex-col gap-2">
                <label htmlFor="password" className="text-xs font-medium text-base-content/75">New password</label>
                <div className="relative">
                  <RiLockPasswordLine size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-base-content/45" />
                  <input id="password" type="password" className="input h-11 w-full pl-10 text-sm" placeholder="At least 8 characters" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" minLength={8} required autoFocus />
                </div>
              </div>
              <div className="flex flex-col gap-2">
                <label htmlFor="confirm" className="text-xs font-medium text-base-content/75">Repeat it</label>
                <div className="relative">
                  <RiLockPasswordLine size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-base-content/45" />
                  <input id="confirm" type="password" className="input h-11 w-full pl-10 text-sm" placeholder="Repeat the new password" value={confirm} onChange={(event) => setConfirm(event.target.value)} autoComplete="new-password" minLength={8} required />
                </div>
              </div>
              <p className="-mt-2 text-[11px] text-base-content/45">Setting a new password signs this account out on every device.</p>
              {error && <div role="alert" className="rounded-lg border border-error/20 bg-error/[0.07] px-3.5 py-3 text-xs text-error">{error}</div>}
              <button type="submit" disabled={loading} className="btn btn-primary h-11 w-full justify-between px-4">
                <span>{loading ? "Working…" : "Set new password"}</span>
                {loading ? <span className="loading loading-spinner loading-xs" /> : <RiArrowRightLine size={17} />}
              </button>
            </form>
          ) : (
            <form onSubmit={requestLink} className="mt-6 flex flex-col gap-5">
              <p className="-mt-3 text-sm text-base-content/60">Enter the email you sign in with and we&apos;ll send you a link to choose a new password.</p>
              <div className="flex flex-col gap-2">
                <label htmlFor="email" className="text-xs font-medium text-base-content/75">Work email</label>
                <div className="relative">
                  <RiMailLine size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-base-content/45" />
                  <input id="email" type="email" className="input h-11 w-full pl-10 text-sm" placeholder="you@company.com" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required autoFocus />
                </div>
              </div>
              {error && <div role="alert" className="rounded-lg border border-error/20 bg-error/[0.07] px-3.5 py-3 text-xs text-error">{error}</div>}
              <button type="submit" disabled={loading} className="btn btn-primary h-11 w-full justify-between px-4">
                <span>{loading ? "Working…" : "Send reset link"}</span>
                {loading ? <span className="loading loading-spinner loading-xs" /> : <RiArrowRightLine size={17} />}
              </button>
            </form>
          )}

          <p className="mt-7 text-center text-xs text-base-content/55">
            <Link href="/login" className="underline-offset-2 hover:text-base-content hover:underline">Back to sign in</Link>
          </p>
        </div>
      </div>
    </>
  );
}
