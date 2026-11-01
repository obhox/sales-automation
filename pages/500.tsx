import Head from "next/head";
import { useTranslations } from "next-intl";
import { TriangleAlert } from "lucide-react";
import { Button, EmptyState } from "@/components/ui";

/** Something broke while the page was being made. Nothing the person did is lost by trying again. */
export default function ServerErrorPage() {
  const t = useTranslations("Errors");
  return (
    <>
      <Head><title>{t("serverErrorTab")} — Linki</title></Head>
      <main className="flex min-h-[60vh] flex-1 items-center justify-center bg-page p-5">
        <EmptyState icon={TriangleAlert} title={t("serverErrorTitle")} action={<Button variant="primary" onClick={() => window.location.reload()}>{t("tryAgain")}</Button>}>
          {t("serverErrorBody")}
        </EmptyState>
      </main>
    </>
  );
}
