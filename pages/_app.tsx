import "@/styles/globals.css";
import type { AppProps } from "next/app";
import { SessionProvider, useSession } from "next-auth/react";
import { useRouter } from "next/router";
import { useEffect } from "react";
import { AppShell, LegacyPageFrame } from "@/components/shell";
import { ConfirmHost, Toaster } from "@/components/ui";
import { Spinner } from "@/components/ui/Spinner";
import { DataProvider } from "@/lib/client/data";
import { isRebuiltPath } from "@/lib/client/rebuilt";

// Pages a signed-out visitor may see. They have no sidebar. (proxy.ts keeps the same
// list for the server-side check; this one decides the layout and covers a session that
// ends while the app is open.)
const isPublicPath = (path: string) => ["/login", "/reset-password", "/verify-email"].includes(path) || path.startsWith("/invite/") || path.startsWith("/r/");
// Pages that need a session but stand by themselves: a consent screen is a decision, not a place in the app.
const isBarePath = (path: string) => path.startsWith("/oauth/");
// Not found and server error: inside the app for someone signed in, by themselves for someone who is not.
const isErrorPath = (path: string) => path === "/404" || path === "/500";

function Frame({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession();
  const router = useRouter();
  const path = router.pathname;
  const open = isPublicPath(path) || isErrorPath(path);

  useEffect(() => {
    if (status === "loading") return;
    if (!session && !open) router.replace("/login");
  }, [session, status, router, open]);

  if (status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-page">
        <Spinner label="Loading Linki" />
      </div>
    );
  }
  if (!session && !open) return null;

  if (isPublicPath(path) || isBarePath(path) || (isErrorPath(path) && !session)) {
    // A signed-out page already rebuilt stands outside the old styles, which apply only inside the wrapper.
    return isRebuiltPath(path) ? <>{children}</> : <div className="legacy" data-theme="linki">{children}</div>;
  }
  return (
    <DataProvider>
      <AppShell>{isRebuiltPath(path) ? children : <LegacyPageFrame>{children}</LegacyPageFrame>}</AppShell>
    </DataProvider>
  );
}

export default function App({ Component, pageProps: { session, ...pageProps } }: AppProps) {
  return (
    <SessionProvider session={session}>
      <Frame>
        <Component {...pageProps} />
      </Frame>
      <Toaster />
      <ConfirmHost />
    </SessionProvider>
  );
}
