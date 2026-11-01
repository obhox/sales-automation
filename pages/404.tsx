import Head from "next/head";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { Compass } from "lucide-react";
import { Button, EmptyState } from "@/components/ui";

/** An address nothing lives at. Inside the app for someone signed in, by itself for someone who is not. */
export default function NotFoundPage() {
  const t = useTranslations("Errors");
  return (
    <>
      <Head><title>{t("notFoundTab")} — Linki</title></Head>
      <main className="flex min-h-[60vh] flex-1 items-center justify-center bg-page p-5">
        <EmptyState icon={Compass} title={t("notFoundTitle")} action={<Button asChild variant="primary"><Link href="/">{t("backToDashboard")}</Link></Button>}>
          {t("notFoundBody")}
        </EmptyState>
      </main>
    </>
  );
}
