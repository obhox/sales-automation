import { useRouter } from "next/router";
import { useEffect, useState } from "react";
import { AuthFrame, TextLink } from "@/components/auth/AuthFrame";
import { Alert, Spinner } from "@/components/ui";

// Where the link in the sign-up email lands: spends the token, then sends the person on to
// sign in. The token is spent by a POST from here, not by loading the page, so a mail
// scanner that merely fetches the link does not use it up.
export default function VerifyEmailPage() {
  const router = useRouter();
  const [error, setError] = useState("");

  useEffect(() => {
    if (!router.isReady) return;
    const token = typeof router.query.token === "string" ? router.query.token : "";
    fetch("/api/auth/verify-email", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) })
      .then(async (res) => {
        if (res.ok) await router.replace("/login?notice=email-verified");
        else setError((await res.json().catch(() => ({}))).error ?? "This confirmation link did not work.");
      })
      .catch(() => setError("The server could not be reached. Open the link again."));
  }, [router]);

  return (
    <AuthFrame title="Confirm your email" heading="Confirm your email" footer={<TextLink href="/login">Go to sign in</TextLink>}>
      {error ? (
        <>
          <Alert tone="bad">{error}</Alert>
          <p className="text-125 leading-[19px] text-ink-2">If you have already confirmed, just sign in. Otherwise sign in with your password and choose &ldquo;Send it again&rdquo; for a new link.</p>
        </>
      ) : (
        <p className="flex items-center gap-2 text-125 text-ink-2"><Spinner size={14} label="Confirming" /> Confirming your address…</p>
      )}
    </AuthFrame>
  );
}
