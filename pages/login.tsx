import Head from "next/head";
import Image from "next/image";
import { signIn } from "next-auth/react";
import { useRouter } from "next/router";
import { useState } from "react";
import { RiArrowRightLine, RiCheckLine, RiLockPasswordLine, RiMailLine } from "react-icons/ri";

type Mode = "signin" | "signup";

export default function LoginPage() {
  const router = useRouter();
  const callbackUrl = typeof router.query.callbackUrl === "string" && router.query.callbackUrl.startsWith("/")
    ? router.query.callbackUrl
    : "/";
  const [mode, setMode] = useState<Mode>("signin");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  function switchMode(next: Mode) {
    setMode(next);
    setError("");
  }

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    const res = await signIn("credentials", { email, password, redirect: false });
    setLoading(false);

    if (res?.ok) {
      router.replace(callbackUrl);
    } else {
      setError("Incorrect email or password.");
    }
  }

  async function handleSignUp(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    const res = await fetch("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    const data = await res.json();
    if (!res.ok) {
      setLoading(false);
      setError(data.error ?? "Something went wrong.");
      return;
    }

    // Auto sign in after signup
    const signInRes = await signIn("credentials", { email, password, redirect: false });
    setLoading(false);

    if (signInRes?.ok) {
      router.replace(callbackUrl);
    } else {
      setError("Account created but sign-in failed. Try signing in manually.");
      switchMode("signin");
    }
  }

  return (
    <>
    <Head>
      <title>{mode === "signin" ? "Welcome back" : "Create your workspace"} — Linki</title>
      <meta name="robots" content="noindex, nofollow" />
    </Head>
    <div className="grid min-h-screen bg-base-200 lg:grid-cols-[minmax(0,1.08fr)_minmax(440px,.92fr)]">
      <section className="hidden border-r border-base-300 bg-base-100 lg:flex lg:flex-col lg:justify-between lg:p-10 xl:p-14">
        <div className="flex items-center gap-3">
          <Image src="/linki-wordmark.svg" alt="Linki" width={110} height={32} priority />
          <span className="rounded-[5px] border border-primary/20 bg-primary/[0.07] px-2 py-1 font-mono text-[10px] font-medium text-primary">Open source</span>
        </div>

        <div className="max-w-xl">
          <p className="mb-4 text-xs font-semibold text-primary">Sales automation that stays in your control</p>
          <h1 className="max-w-lg text-[clamp(2.5rem,4vw,3.5rem)] font-semibold leading-[1.05] tracking-[-.02em] text-base-content">
            Turn signals into conversations.
          </h1>
          <p className="mt-5 max-w-md text-[15px] leading-7 text-base-content/65">
            Research, reach, and convert the right people in one calm workspace—without giving up control of your data.
          </p>
          <div className="mt-9 grid max-w-lg grid-cols-2 gap-x-7 gap-y-4">
            {["Multichannel sequences", "Private by design", "AI-assisted writing", "No per-seat pricing"].map((item) => (
              <div key={item} className="flex items-center gap-2.5 text-xs font-medium text-base-content/70">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-primary"><RiCheckLine size={12} /></span>
                {item}
              </div>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between text-[11px] text-base-content/45">
          <span>Built for teams who value control.</span>
          <span className="font-mono">Linki</span>
        </div>
      </section>

      <section className="flex min-h-screen items-center justify-center px-5 py-10 sm:px-10">
        <div className="w-full max-w-[410px] rounded-[14px] border border-base-300 bg-base-100 p-6 shadow-[var(--shadow-raised)] sm:p-8">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <Image src="/linki-wordmark.svg" alt="Linki" width={104} height={30} priority />
          </div>

          <div className="mb-8">
            <p className="mb-2 text-xs font-semibold text-primary">
              {mode === "signin" ? "Welcome back" : "Start building pipeline"}
            </p>
            <h2 className="text-[28px] font-semibold tracking-[-.01em] text-base-content">
              {mode === "signin" ? "Sign in to your workspace" : "Create your Linki account"}
            </h2>
            <p className="mt-2 text-sm text-base-content/60">
              {mode === "signin" ? "Continue where your team left off." : "Self-hosted outreach, owned by you."}
            </p>
          </div>

          <div className="mb-6 grid grid-cols-2 border-b border-base-300" role="tablist" aria-label="Authentication mode">
            {(["signin", "signup"] as Mode[]).map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={mode === item}
                onClick={() => switchMode(item)}
                className={`relative pb-3 text-xs font-semibold transition-colors ${mode === item ? "text-base-content" : "text-base-content/45 hover:text-base-content/70"}`}
              >
                {item === "signin" ? "Sign in" : "Create account"}
                {mode === item && <span className="absolute inset-x-0 bottom-[-1px] h-px bg-primary" />}
              </button>
            ))}
          </div>

          <form onSubmit={mode === "signin" ? handleSignIn : handleSignUp} className="flex flex-col gap-5">
            <div className="flex flex-col gap-2">
              <label htmlFor="email" className="text-xs font-medium text-base-content/75">Work email</label>
              <div className="relative">
                <RiMailLine size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-base-content/45" />
                <input id="email" type="email" className="input h-11 w-full pl-10 text-sm" placeholder="you@company.com" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" autoFocus required />
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <label htmlFor="password" className="text-xs font-medium text-base-content/75">Password</label>
              <div className="relative">
                <RiLockPasswordLine size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-base-content/45" />
                <input id="password" type="password" className="input h-11 w-full pl-10 text-sm" placeholder={mode === "signup" ? "At least 8 characters" : "Enter your password"} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === "signin" ? "current-password" : "new-password"} minLength={mode === "signup" ? 8 : undefined} required />
              </div>
            </div>

            {error && <div role="alert" className="rounded-lg border border-error/20 bg-error/[0.07] px-3.5 py-3 text-xs text-error">{error}</div>}

            <button type="submit" disabled={loading} className="btn btn-primary mt-1 h-11 w-full justify-between px-4">
              <span>{loading ? "Working…" : mode === "signin" ? "Enter workspace" : "Create workspace"}</span>
              {loading ? <span className="loading loading-spinner loading-xs" /> : <RiArrowRightLine size={17} />}
            </button>
          </form>

          <p className="mt-7 text-center text-[11px] leading-5 text-base-content/45">
            By continuing, you agree to keep outreach human, relevant, and respectful.
          </p>
        </div>
      </section>
    </div>
    </>
  );
}
