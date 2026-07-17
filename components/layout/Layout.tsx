import { ReactNode } from "react";
import { useRouter } from "next/router";
import Image from "next/image";
import Sidebar from "./Sidebar";
import TourGate from "@/components/onboarding/TourGate";

const hasNoLayout = (path: string) => path === "/login" || path.startsWith("/invite/");

export default function Layout({ children }: { children: ReactNode }) {
  const router = useRouter();

  if (hasNoLayout(router.pathname)) {
    return <>{children}</>;
  }

  return (
    <div className="min-h-screen bg-base-200">
      <TourGate />
      <Sidebar />
      <header className="sticky top-0 z-20 flex h-16 items-center gap-2.5 border-b border-[var(--border-subtle)] bg-base-200/90 px-4 backdrop-blur-sm md:hidden">
        <Image src="/logo_linki.svg" alt="Linki" width={26} height={26} priority />
        <span className="text-[17px] font-semibold tracking-[-0.02em] text-base-content">Linki</span>
      </header>
      <main className="min-h-screen px-4 pb-28 pt-6 md:ml-[264px] md:px-10 md:pb-14 md:pt-9">
        <div className="mx-auto w-full max-w-[1240px]">{children}</div>
      </main>
    </div>
  );
}
