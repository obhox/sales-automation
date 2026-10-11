import Link from "next/link";
import type { CSSProperties } from "react";
import { ArrowRight, ArrowUpRight, Check, Database, LockKeyhole, Package, SendHorizontal, type LucideIcon } from "lucide-react";
import { Button, Card, ChannelBadge, CodeBlock } from "@/components/ui";
import { cn } from "@/lib/client/cn";
import { CLOSING, HERO, LICENSE_URL, REPOSITORY_URL, SECTIONS, SELF_HOSTED, SETUP_URL, shotSize, shotSrc, type Section, type Shot } from "./content";

const FRAME = "mx-auto w-full max-w-[1152px] px-4 sm:px-6";
const EYEBROW = "text-11 font-semibold uppercase tracking-label text-brand-strong";
const TITLE = "text-[clamp(23px,2.7vw,30px)] font-semibold leading-[1.15] tracking-[-0.022em] text-ink";
const BODY = "text-15 leading-[24px] text-ink-2";
/** Buttons on this page are a size up from the app's: they are read from further away. */
const ACTION = "h-10 gap-2 px-4 text-135";
const FACT_ICON: LucideIcon[] = [Package, Database, LockKeyhole];

function Mark({ size = 24 }: { size?: number }) {
  return (
    <span style={{ width: size, height: size }} className="inline-flex shrink-0 items-center justify-center rounded-lg bg-brand text-white" aria-hidden="true">
      <SendHorizontal size={Math.round(size * 0.54)} />
    </span>
  );
}

/**
 * A picture of the demo workspace at the size it was taken, never larger. One too wide
 * for a phone is not shrunk until its text is unreadable: it keeps a width it can be read
 * at and runs off the right-hand side, fading out.
 */
function Picture({ shot, eager, className }: { shot: Shot; eager?: boolean; className?: string }) {
  const { width, height } = shotSize(shot.name);
  const wide = width > 640;
  return (
    <figure style={{ maxWidth: width }} className={cn("w-full min-w-0", wide && "max-sm:overflow-hidden max-sm:mask-r-from-80%", shot.cut && "mask-b-from-90%", className)}>
      {/* A plain image, not next/image: these are fixed files, and the server that would
          resize them is the one process that also sends and reads for every workspace. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={shotSrc(shot.name)} alt={shot.alt} width={width} height={height}
        loading={eager ? "eager" : "lazy"} decoding="async"
        className={cn("block h-auto w-full", wide && "max-sm:w-[540px] max-sm:max-w-none")}
      />
    </figure>
  );
}

function Points({ points, className }: { points: string[]; className?: string }) {
  return (
    <ul className={cn("flex flex-col gap-3", className)}>
      {points.map((point) => (
        <li key={point} className="flex items-start gap-2.5 text-135 leading-[21px] text-ink-2">
          <span className="mt-[3px] inline-flex size-[15px] shrink-0 items-center justify-center rounded-full bg-brand-tint text-brand-strong"><Check size={10} strokeWidth={3} aria-hidden="true" /></span>
          {point}
        </li>
      ))}
    </ul>
  );
}

function Heading({ section }: { section: Pick<Section, "eyebrow" | "channel" | "title" | "body"> }) {
  return (
    <div className="flex flex-col gap-3.5">
      <p className={cn(EYEBROW, "flex items-center gap-2")}>
        {section.channel ? <ChannelBadge channel={section.channel} /> : null}
        {section.eyebrow}
      </p>
      <h2 className={TITLE}>{section.title}</h2>
      <p className={BODY}>{section.body}</p>
    </div>
  );
}

/** One picture beside the words, on alternate sides down the page. */
function Beside({ section, flip, origin }: { section: Section; flip: boolean; origin: string }) {
  return (
    <div className="grid grid-cols-1 items-center gap-9 lg:grid-cols-12 lg:gap-14">
      <div className={cn("flex flex-col gap-6 lg:col-span-5", flip && "lg:order-last")}>
        <Heading section={section} />
        <Points points={section.points} />
        <Commands section={section} origin={origin} />
      </div>
      <div className={cn("flex min-w-0 lg:col-span-7", flip ? "lg:justify-start" : "lg:justify-end")}>
        <Picture shot={section.shots[0]} />
      </div>
    </div>
  );
}

/** Words above, then two pictures laid side by side in proportion to their real widths, as the app lays out its own cards. */
function Above({ section, origin }: { section: Section; origin: string }) {
  const [first, second] = section.shots;
  const columns = { "--columns": `${shotSize(first.name).width}fr ${shotSize(second.name).width}fr` } as CSSProperties;
  return (
    <div className="flex flex-col gap-10">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 lg:gap-14">
        <div className="lg:col-span-5"><Heading section={section} /></div>
        <div className="flex flex-col gap-6 lg:col-span-7 lg:pt-[30px]">
          <Points points={section.points} className="sm:grid sm:grid-cols-2 sm:gap-x-8 sm:gap-y-4" />
          <Commands section={section} origin={origin} />
        </div>
      </div>
      <div style={columns} className="grid grid-cols-1 items-start gap-3.5 lg:[grid-template-columns:var(--columns)]">
        <Picture shot={first} />
        <Picture shot={second} />
      </div>
    </div>
  );
}

/** How many sections above this one put their picture beside the words: they take sides in turn. */
function besideBefore(index: number): number {
  return SECTIONS.slice(0, index).filter((section) => section.shots.length === 1).length;
}

function Commands({ section, origin }: { section: Section; origin: string }) {
  if (!section.code) return null;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {section.code.map((command) => <CodeBlock key={command.caption} code={command.text.replace("{origin}", origin)} caption={command.caption} />)}
    </div>
  );
}

/**
 * The page a visitor who is not signed in can read to learn what Linki is. `origin` is
 * this instance's own address, used in the commands it shows; `signedIn` turns the way in
 * from "Sign in" into "Open Linki".
 */
export function WelcomePage({ origin, signedIn }: { origin: string; signedIn: boolean }) {
  const enter = signedIn ? { href: "/", label: "Open Linki" } : { href: "/login", label: "Sign in" };
  const nav = SECTIONS.filter((section) => section.nav);

  return (
    <div className="min-h-screen bg-page text-ink">
      <header className="sticky top-0 z-20 border-b border-line bg-surface">
        <div className={cn(FRAME, "flex h-14 items-center justify-between gap-4")}>
          <Link href="/welcome" className="flex items-center gap-2 rounded-md">
            <Mark />
            <span className="text-15 font-semibold tracking-title text-ink">Linki</span>
          </Link>
          <nav aria-label="On this page" className="hidden items-center gap-0.5 md:flex">
            {nav.map((section) => (
              <a key={section.id} href={`#${section.id}`} className="rounded-md px-2.5 py-1.5 text-125 font-medium text-ink-2 transition-colors hover:bg-control hover:text-ink">{section.nav}</a>
            ))}
          </nav>
          <div className="flex items-center gap-1.5">
            <Button asChild variant="ghost">
              <a href={REPOSITORY_URL} rel="noopener">GitHub<ArrowUpRight size={13} aria-hidden="true" /></a>
            </Button>
            <Button asChild variant="primary">
              <Link href={enter.href}>{enter.label}</Link>
            </Button>
          </div>
        </div>
      </header>

      <main>
        <section className={cn(FRAME, "pb-14 pt-12 md:pb-20 md:pt-[72px]")}>
          <div className="flex max-w-[700px] flex-col gap-5">
            <p className={EYEBROW}>{HERO.eyebrow}</p>
            <h1 className="text-[clamp(34px,5.4vw,54px)] font-semibold leading-[1.04] tracking-[-0.032em] text-ink">{HERO.title}</h1>
            <p className="max-w-[600px] text-[17px] leading-[27px] text-ink-2">{HERO.lede}</p>
            <div className="flex flex-wrap items-center gap-2.5 pt-1.5">
              <Button asChild variant="primary" className={ACTION}>
                <Link href={enter.href}>{enter.label}<ArrowRight size={15} aria-hidden="true" /></Link>
              </Button>
              <Button asChild variant="secondary" className={ACTION}>
                <a href={REPOSITORY_URL} rel="noopener">View on GitHub<ArrowUpRight size={15} className="text-ink-2" aria-hidden="true" /></a>
              </Button>
            </div>
          </div>
          {/* On a phone the whole screen would be a thumbnail, so it shows the two tracks at a size that can be read. */}
          <figure className="mt-10 overflow-hidden rounded-xl border border-line-strong bg-surface shadow-card md:mt-14">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={shotSrc(HERO.shot.name)} alt={HERO.shot.alt} {...shotSize(HERO.shot.name)} decoding="async" fetchPriority="high"
              className="block h-auto w-full max-sm:-ml-[131px] max-sm:w-[760px] max-sm:max-w-none"
            />
          </figure>
        </section>

        {SECTIONS.map((section, index) => (
          <section key={section.id} id={section.id} className="scroll-mt-14 border-t border-line">
            <div className={cn(FRAME, "py-14 md:py-[88px]")}>
              {section.shots.length > 1 ? <Above section={section} origin={origin} /> : <Beside section={section} flip={besideBefore(index) % 2 === 1} origin={origin} />}
            </div>
          </section>
        ))}

        <section id={SELF_HOSTED.id} className="scroll-mt-14 border-t border-line">
          <div className={cn(FRAME, "flex flex-col gap-9 py-14 md:py-[88px]")}>
            <div className="max-w-[560px]"><Heading section={SELF_HOSTED} /></div>
            <div className="grid gap-3.5 md:grid-cols-3">
              {SELF_HOSTED.facts.map((fact, index) => {
                const Glyph = FACT_ICON[index % FACT_ICON.length];
                return (
                  <Card key={fact.title} className="flex flex-col gap-3 p-5">
                    <span className="inline-flex size-8 items-center justify-center rounded-md bg-brand-tint text-brand-strong"><Glyph size={16} aria-hidden="true" /></span>
                    <h3 className="text-15 font-semibold tracking-[-0.15px] text-ink">{fact.title}</h3>
                    <p className="text-135 leading-[21px] text-ink-2">{fact.detail}</p>
                  </Card>
                );
              })}
            </div>
            <div>
              <Button asChild variant="secondary" className={ACTION}>
                <a href={SETUP_URL} rel="noopener">How to run it<ArrowUpRight size={15} className="text-ink-2" aria-hidden="true" /></a>
              </Button>
            </div>
          </div>
        </section>

        <section className="border-t border-line">
          <div className={cn(FRAME, "py-14 md:py-20")}>
            <Card className="flex flex-col items-start gap-5 rounded-xl p-7 md:flex-row md:items-center md:justify-between md:gap-10 md:p-10">
              <div className="flex max-w-[560px] flex-col gap-2.5">
                <h2 className={TITLE}>{CLOSING.title}</h2>
                <p className={BODY}>{signedIn ? CLOSING.signedIn : CLOSING.body}</p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2.5">
                <Button asChild variant="primary" className={ACTION}>
                  <Link href={enter.href}>{enter.label}<ArrowRight size={15} aria-hidden="true" /></Link>
                </Button>
                <Button asChild variant="secondary" className={ACTION}>
                  <a href={REPOSITORY_URL} rel="noopener">View on GitHub<ArrowUpRight size={15} className="text-ink-2" aria-hidden="true" /></a>
                </Button>
              </div>
            </Card>
          </div>
        </section>
      </main>

      <footer className="border-t border-line bg-surface">
        <div className={cn(FRAME, "flex flex-col gap-4 py-7 sm:flex-row sm:items-center sm:justify-between")}>
          <div className="flex items-center gap-2.5">
            <Mark size={20} />
            <p className="text-125 text-ink-2">
              <span className="font-semibold text-ink">Linki</span> is source-available under the{" "}
              <a href={LICENSE_URL} rel="noopener" className="font-medium text-brand-strong hover:underline">Linki Sustainable Use License</a>.
            </p>
          </div>
          <nav aria-label="Footer" className="flex items-center gap-5 text-125 font-medium text-ink-2">
            <Link href={enter.href} className="hover:text-ink">{enter.label}</Link>
            <a href={REPOSITORY_URL} rel="noopener" className="hover:text-ink">GitHub</a>
            <a href={SETUP_URL} rel="noopener" className="hover:text-ink">Setup</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
