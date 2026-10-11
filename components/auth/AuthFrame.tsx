import Head from "next/head";
import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/client/cn";
import { HIGHLIGHTS } from "./model";

/** The Linki mark and name, as the sidebar shows them. */
export function Brand({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <Image src="/linki-mark.svg" alt="" width={28} height={28} priority className="rounded-lg" />
      <span className="text-15 font-semibold tracking-[-0.15px] text-ink">Linki</span>
    </span>
  );
}

/**
 * The frame of every page a signed-out person sees: the mark, one white card with a
 * heading, and a quiet line underneath. `aside` puts what Linki does beside the card on a
 * wide screen, for the sign-in page.
 */
export function AuthFrame({
  title, heading, lead, children, footer, aside,
}: {
  /** The browser tab's title, before " — Linki". */
  title: string;
  heading: ReactNode;
  lead?: ReactNode;
  children: ReactNode;
  /** A line under the card: the way back to sign in, a note about what joining shares. */
  footer?: ReactNode;
  aside?: boolean;
}) {
  const card = (
    <div className="flex w-full max-w-[400px] flex-col gap-6">
      <Link href="/login" aria-label="Linki: sign in" className={cn("self-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-brand-tint", aside && "lg:hidden")}>
        <Brand />
      </Link>
      <div className="flex flex-col gap-5 rounded-lg border border-line bg-surface p-6 shadow-card sm:p-7">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-[22px] font-semibold leading-7 tracking-[-0.3px] text-ink">{heading}</h1>
          {lead ? <p className="text-125 leading-[19px] text-ink-2">{lead}</p> : null}
        </div>
        {children}
      </div>
      {footer ? <p className="text-center text-115 leading-[17px] text-ink-3">{footer}</p> : null}
    </div>
  );
  return (
    <>
      <Head>
        <title>{`${title} — Linki`}</title>
        <meta name="robots" content="noindex, nofollow" />
      </Head>
      {aside ? (
        <div className="grid min-h-screen bg-page lg:grid-cols-[minmax(0,1fr)_minmax(460px,0.9fr)]">
          <section className="hidden flex-col justify-between border-r border-line bg-surface p-10 lg:flex xl:p-14">
            <Brand />
            <div className="flex max-w-[460px] flex-col gap-7">
              <div className="flex flex-col gap-3">
                <h2 className="text-[34px] font-semibold leading-[40px] tracking-[-0.8px] text-ink">Outreach on LinkedIn and email, run from one place.</h2>
                <p className="text-[14px] leading-[22px] text-ink-2">Build a sequence, choose who it goes to and who it is sent from, and follow every reply in one inbox.</p>
              </div>
              <ul className="flex flex-col gap-4">
                {HIGHLIGHTS.map((item) => (
                  <li key={item.title} className="flex gap-3">
                    <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-brand-tint text-brand-strong"><Check size={12} aria-hidden="true" /></span>
                    <span className="flex flex-col gap-0.5">
                      <span className="text-125 font-semibold text-ink">{item.title}</span>
                      <span className="text-12 leading-[18px] text-ink-2">{item.detail}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <p className="text-11 text-ink-3">Keep outreach human, relevant and respectful.</p>
          </section>
          <main className="flex items-center justify-center px-5 py-10 sm:px-10">{card}</main>
        </div>
      ) : (
        <main className="flex min-h-screen items-center justify-center bg-page px-5 py-10">{card}</main>
      )}
    </>
  );
}

/** A link in the brand colour, for the lines under a form. */
export function TextLink({ href, children }: { href: string; children: ReactNode }) {
  return <Link href={href} className="rounded-sm font-semibold text-brand-strong outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand-tint">{children}</Link>;
}
