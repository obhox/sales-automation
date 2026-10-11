import Head from "next/head";
import Link from "next/link";
import { Compass } from "lucide-react";
import { Button, EmptyState } from "@/components/ui";

/** An address nothing lives at. Inside the app for someone signed in, by itself for someone who is not. */
export default function NotFoundPage() {
  return (
    <>
      <Head><title>Page not found — Linki</title></Head>
      <main className="flex min-h-[60vh] flex-1 items-center justify-center bg-page p-5">
        <EmptyState icon={Compass} title="There is nothing at this address" action={<Button asChild variant="primary"><Link href="/">Go to the dashboard</Link></Button>}>
          The page may have moved, or the link may have been cut short. Search with ⌘K, or start again from the dashboard.
        </EmptyState>
      </main>
    </>
  );
}
