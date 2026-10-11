import Head from "next/head";
import { TriangleAlert } from "lucide-react";
import { Button, EmptyState } from "@/components/ui";

/** Something broke while the page was being made. Nothing the person did is lost by trying again. */
export default function ServerErrorPage() {
  return (
    <>
      <Head><title>Something went wrong — Linki</title></Head>
      <main className="flex min-h-[60vh] flex-1 items-center justify-center bg-page p-5">
        <EmptyState icon={TriangleAlert} title="This page could not be shown" action={<Button variant="primary" onClick={() => window.location.reload()}>Try again</Button>}>
          Something went wrong on the server. Campaigns that are running are not affected. If it keeps happening, whoever runs this instance can find the cause in the server log.
        </EmptyState>
      </main>
    </>
  );
}
