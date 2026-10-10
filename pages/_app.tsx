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

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (status === "loading") return;
    if (!session && !isPublicPath(router.pathname)) {
      router.replace("/login");
    }
  }, [session, status, router]);

  if (status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-page">
        <Spinner label="Loading Linki" />
      </div>
    );
  }

  if (!session && !isPublicPath(router.pathname)) return null;

  return <>{children}</>;
}

export default function App({ Component, pageProps: { session, ...pageProps } }: AppProps) {
  const router = useRouter();
  const page = <Component {...pageProps} />;

  return (
    <SessionProvider session={session}>
      <AuthGuard>
        {isPublicPath(router.pathname) ? (
          // Sign-in and its neighbours still use the old styles, which apply only inside this wrapper.
          <div className="legacy" data-theme="linki">
            {page}
          </div>
        ) : (
          <DataProvider>
            <AppShell>{isRebuiltPath(router.pathname) ? page : <LegacyPageFrame>{page}</LegacyPageFrame>}</AppShell>
          </DataProvider>
        )}
        <Toaster />
        <ConfirmHost />
      </AuthGuard>
    </SessionProvider>
  );
}
