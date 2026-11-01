import { useRouter } from "next/router";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { AuthFrame, TextLink } from "@/components/auth/AuthFrame";
import { Alert, Spinner } from "@/components/ui";

// Where the link in the sign-up email lands: spends the token, then sends the person on to
// sign in. The token is spent by a POST from here, not by loading the page, so a mail
// scanner that merely fetches the link does not use it up.
export default function VerifyEmailPage() {
  const t = useTranslations("EmailVerify");
  const router = useRouter();
  const [error, setError] = useState("");

  useEffect(() => {
    if (!router.isReady) return;
    const token = typeof router.query.token === "string" ? router.query.token : "";
    fetch("/api/auth/verify-email", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) })
      .then(async (res) => {
        if (res.ok) await router.replace("/login?notice=email-verified");
        else setError((await res.json().catch(() => ({}))).error ?? t("error"));
      })
      .catch(() => setError(t("offline")));
  }, [router, t]);

  return (
    <AuthFrame title={t("confirm")} heading={t("confirm")} footer={<TextLink href="/login">{t("signin")}</TextLink>}>
      {error ? (
        <>
          <Alert tone="bad">{error}</Alert>
          <p className="text-125 leading-[19px] text-ink-2">{t("hint")}</p>
        </>
      ) : (
        <p className="flex items-center gap-2 text-125 text-ink-2"><Spinner size={14} label={t("confirming")} /> {t("wait")}</p>
      )}
    </AuthFrame>
  );
}
