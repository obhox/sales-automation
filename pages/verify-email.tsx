import Head from "next/head";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/router";
import { useEffect, useState } from "react";

// Landing page for the link in the signup email: spends the token, then sends the person on
// to sign in. The token is spent by a POST from here, not by loading the page, so a mail
// scanner that merely fetches the link does not use it up.
export default function VerifyEmailPage() {
  const router = useRouter();
  const [error, setError] = useState("");

  useEffect(() => {
    if (!router.isReady) return;
    const token = typeof router.query.token === "string" ? router.query.token : "";
    fetch("/api/auth/verify-email", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) })
      .then(async (res) => {
        if (res.ok) router.replace("/login?notice=email-verified");
        else setError((await res.json().catch(() => ({}))).error ?? "This confirmation link did not work.");
      })
      .catch(() => setError("Could not reach the server. Try the link again."));
  }, [router]);

  return (
    <>
      <Head>
        <title>Confirm your email — Linki</title>
        <meta name="robots" content="noindex, nofollow" />
      </Head>
      <div className="flex min-h-screen items-center justify-center bg-base-200 px-5 py-10">
        <div className="w-full max-w-[410px] rounded-[14px] border border-base-300 bg-base-100 p-6 shadow-[var(--shadow-raised)] sm:p-8">
          <Image src="/linki-wordmark.svg" alt="Linki" width={104} height={30} priority className="mb-8" />
          <h1 className="text-[28px] font-semibold tracking-[-.01em] text-base-content">Confirm your email</h1>
          {error ? (
            <>
              <div role="alert" className="mt-5 rounded-lg border border-error/20 bg-error/[0.07] px-3.5 py-3 text-xs text-error">{error}</div>
              <p className="mt-4 text-sm leading-6 text-base-content/65">
                If you have already confirmed, just sign in. Otherwise sign in with your password and choose &ldquo;Send it again&rdquo; to get a new link.
              </p>
            </>
          ) : (
            <p role="status" className="mt-3 flex items-center gap-2 text-sm text-base-content/65">
              <span className="loading loading-spinner loading-xs" /> Confirming your address…
            </p>
          )}
          <p className="mt-7 text-center text-xs text-base-content/55">
            <Link href="/login" className="underline-offset-2 hover:text-base-content hover:underline">Go to sign in</Link>
          </p>
        </div>
      </div>
    </>
  );
}
