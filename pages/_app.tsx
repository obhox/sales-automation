import "@/styles/globals.css";
import type { AppProps } from "next/app";
import { SessionProvider, useSession } from "next-auth/react";
import { useRouter } from "next/router";
import { useEffect } from "react";
import Layout from "@/components/layout/Layout";
import { ConfirmHost, Toaster } from "@/components/ui";
import { Spinner } from "@/components/ui/Spinner";
import { DataProvider } from "@/lib/client/data";
import { isRebuiltPath } from "@/lib/client/rebuilt";

const isPublicPath = (path: string) => ["/login", "/reset-password", "/verify-email"].includes(path) || path.startsWith("/invite/");

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
  const rebuilt = isRebuiltPath(router.pathname);

  return (
    <SessionProvider session={session}>
      <AuthGuard>
        {rebuilt ? (
          <DataProvider>
            <Component {...pageProps} />
          </DataProvider>
        ) : (
          // Old pages keep the old styles: everything in styles/legacy.css is scoped to this wrapper.
          <div className="legacy" data-theme="linki">
            <Layout>
              <Component {...pageProps} />
            </Layout>
          </div>
        )}
        <Toaster />
        <ConfirmHost />
      </AuthGuard>
    </SessionProvider>
  );
}
