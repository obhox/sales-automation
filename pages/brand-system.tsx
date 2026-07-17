import Head from "next/head";
import Image from "next/image";
import { useState } from "react";
import { FiArrowRight, FiCheck, FiSearch } from "react-icons/fi";

const principles = [
  ["Calm", "Nothing shouts. Whitespace, hairlines, and a warm paper canvas keep the interface at rest so the work is what stands out."],
  ["Editorial", "Big, confident headlines and a comfortable reading rhythm. Screens feel composed and typeset, not crammed."],
  ["Near-monochrome", "Warm ink on warm paper carries the whole hierarchy. Colour is the exception, not the baseline."],
  ["Ink as accent", "Ink is the only accent in chrome — primary actions, active state, and focus. Never blue."],
  ["Colour from data and status only", "Saturated colour appears solely in status (success, warning, danger) and data-viz marks. Chrome stays neutral."],
  ["Flat and roomy", "No gradients, no glass, no heavy shadows. Structure comes from borders and generous spacing on a soft radius scale."],
];

const surfaceTokens = [
  ["--bg-app", "var(--bg-app)", "Page canvas · warm paper"],
  ["--surface", "var(--surface)", "Cards, panels, menus"],
  ["--surface-sunken", "var(--surface-sunken)", "Recessed wells, striped rows"],
  ["--border-subtle", "var(--border-subtle)", "Hairline dividers"],
  ["--border", "var(--border)", "Control outlines"],
  ["--border-strong", "var(--border-strong)", "Emphasised edges"],
];

const inkTokens = [
  ["--text-strong", "var(--text-strong)", "Headings · ink 900"],
  ["--text", "var(--text)", "Body · ink 600"],
  ["--text-muted", "var(--text-muted)", "Secondary · ink 450"],
  ["--text-subtle", "var(--text-subtle)", "Captions, placeholders"],
  ["--primary", "var(--primary)", "Ink · the only chrome accent"],
];

const statusTokens = [
  ["--success-solid", "var(--success-solid)", "Completed and healthy state"],
  ["--warning-solid", "var(--warning-solid)", "Attention and pending state"],
  ["--danger-solid", "var(--danger-solid)", "Destructive and failed state"],
];

const vizTokens = [
  ["--viz-1", "var(--viz-1)", "Dusty blue"],
  ["--viz-2", "var(--viz-2)", "Muted green"],
  ["--viz-3", "var(--viz-3)", "Clay"],
  ["--viz-4", "var(--viz-4)", "Muted plum"],
  ["--viz-5", "var(--viz-5)", "Ochre"],
  ["--viz-6", "var(--viz-6)", "Neutral"],
];

const typeScale = [
  ["Page title", "var(--text-5xl)", "48px", "Semibold"],
  ["Display", "var(--text-4xl)", "38px", "Semibold"],
  ["H1", "var(--text-3xl)", "30px", "Semibold"],
  ["Section title", "var(--text-2xl)", "24px", "Semibold"],
  ["Subheading", "var(--text-xl)", "20px", "Semibold"],
  ["Emphasized body", "var(--text-lg)", "17px", "Medium"],
  ["Base body / controls", "var(--text-md)", "15px", "Regular"],
  ["Dense UI", "var(--text-sm)", "13px", "Regular"],
  ["Caption", "var(--text-xs)", "12px", "Regular"],
];

const radii = [
  ["--radius-sm", "7px", "Badges, tags"],
  ["--radius-md", "10px", "Inputs, buttons, menus"],
  ["--radius-lg", "16px", "Cards, popovers"],
  ["--radius-xl", "20px", "Modals, large surfaces"],
];

const shadows = [
  ["--shadow-raised", "var(--shadow-raised)", "Cards and panels"],
  ["--shadow-floating", "var(--shadow-floating)", "Menus and dropdowns"],
  ["--shadow-popover", "var(--shadow-popover)", "Popovers"],
  ["--shadow-modal", "var(--shadow-modal)", "Modals and dialogs"],
];

export default function BrandSystemPage() {
  const [segment, setSegment] = useState("Contacts");

  return (
    <>
      <Head>
        <title>Design system — Linki</title>
        <meta name="robots" content="noindex, nofollow" />
      </Head>

      <div className="pb-16">
        <header className="rounded-[20px] border border-[var(--border-subtle)] bg-base-100 p-6 shadow-[var(--shadow-raised)] sm:p-8 lg:p-10">
          <div className="flex flex-col justify-between gap-10 lg:flex-row lg:items-end">
            <div className="max-w-3xl">
              <div className="mb-8 flex items-center gap-3">
                <Image src="/linki-wordmark.svg" alt="Linki" width={112} height={32} priority />
                <span className="rounded-[7px] border border-[var(--border)] bg-base-200 px-2 py-1 font-mono text-[10px] font-medium text-base-content/60">
                  Calm Paper 1.0
                </span>
              </div>
              <p className="mb-3 text-xs font-semibold text-primary">Product foundation</p>
              <h1 className="max-w-2xl text-[clamp(2.5rem,5vw,3.5rem)] font-semibold leading-[1.05] tracking-[-.03em]">
                Calm paper, warm ink.
              </h1>
              <p className="mt-5 max-w-2xl text-[15px] leading-7 text-base-content/55">
                Linki is a flat, editorial, near-monochrome system. Ink is the only accent in the chrome; saturated colour is reserved for status and data. This page is the living reference — every swatch and component below reads straight from the tokens.
              </p>
            </div>
            <div className="grid shrink-0 grid-cols-2 overflow-hidden rounded-[10px] border border-[var(--border-subtle)] text-xs sm:w-[320px]">
              {["Light mode only", "Warm paper canvas", "Ink as accent", "Flat and roomy"].map((item) => (
                <div key={item} className="flex items-center gap-2 border-b border-r border-[var(--border-subtle)] bg-base-200 px-4 py-3 text-base-content/70 last:border-b-0">
                  <FiCheck className="text-base-content/40" aria-hidden="true" />
                  {item}
                </div>
              ))}
            </div>
          </div>
        </header>

        <Section number="01" title="Design principles" description="Six ideas keep hundreds of screens calm and coherent.">
          <div className="grid overflow-hidden rounded-[10px] border border-[var(--border-subtle)] bg-base-200 md:grid-cols-2 xl:grid-cols-3">
            {principles.map(([title, copy], index) => (
              <article key={title} className="min-h-48 border-b border-r border-[var(--border-subtle)] bg-base-100 p-5">
                <span className="font-mono text-[11px] text-base-content/45">0{index + 1}</span>
                <h3 className="mt-8 text-lg">{title}</h3>
                <p className="mt-3 text-xs leading-5 text-base-content/55">{copy}</p>
              </article>
            ))}
          </div>
        </Section>

        <Section number="02" title="Colour system" description="Surfaces and ink carry the interface. Status and data-viz tokens are the only saturated colour, and never appear in chrome.">
          <SwatchGroup label="Surfaces and borders" swatches={surfaceTokens} />
          <SwatchGroup label="Ink and text" swatches={inkTokens} />
          <SwatchGroup label="Status — saturated colour, from state only" swatches={statusTokens} />
          <SwatchGroup label="Data-viz — categorical marks only" swatches={vizTokens} />
        </Section>

        <Section number="03" title="Typography and rhythm" description="Inter carries the whole UI; JetBrains Mono is reserved for code, IDs, and machine-readable data. Big confident headings, comfortable body, tabular numerals by default.">
          <div className="grid gap-4 lg:grid-cols-[1fr_1.25fr]">
            <article className="rounded-[10px] border border-[var(--border-subtle)] bg-base-100 p-6 shadow-[var(--shadow-raised)]">
              <p className="text-xs font-semibold text-primary">Inter</p>
              <p className="mt-8 text-6xl font-semibold tracking-[-.03em]">Aa</p>
              <p className="mt-5 text-2xl font-semibold tracking-[-.02em]">Move every conversation forward.</p>
              <p className="mt-5 font-mono text-xs leading-6 text-base-content/55">ABCDEFGHIJKLMNOPQRSTUVWXYZ<br />abcdefghijklmnopqrstuvwxyz · 0123456789</p>
              <div className="mt-6 flex flex-wrap gap-2 border-t border-[var(--border-subtle)] pt-5">
                {[["Regular", 400], ["Medium", 500], ["Semibold", 600], ["Bold", 700]].map(([name, weight]) => (
                  <span key={name} className="rounded-[7px] border border-[var(--border-subtle)] bg-base-200 px-2.5 py-1 text-xs" style={{ fontWeight: weight as number }}>{name}</span>
                ))}
              </div>
            </article>
            <article className="overflow-hidden rounded-[10px] border border-[var(--border-subtle)] bg-base-100 shadow-[var(--shadow-raised)]">
              {typeScale.map(([name, token, size, weight]) => (
                <div key={name} className="grid grid-cols-[1fr_auto] items-center gap-4 border-b border-[var(--border-subtle)] px-5 py-3.5 last:border-0">
                  <span className="truncate" style={{ fontSize: token, fontWeight: weight === "Semibold" ? 600 : weight === "Medium" ? 500 : 400, letterSpacing: "-.01em" }}>{name}</span>
                  <span className="flex shrink-0 items-center gap-3">
                    <code className="text-xs text-base-content/45">{size}</code>
                    <span className="w-16 text-right text-xs text-base-content/50">{weight}</span>
                  </span>
                </div>
              ))}
            </article>
          </div>
        </Section>

        <Section number="04" title="Radii and elevation" description="A soft radius scale and whisper-soft, warm-tinted shadows. Structure comes from hairline borders — shadows only lift floating things a touch.">
          <div className="grid gap-4 lg:grid-cols-2">
            <article className="rounded-[10px] border border-[var(--border-subtle)] bg-base-100 p-6 shadow-[var(--shadow-raised)]">
              <h3 className="mb-6 text-sm">Radius scale</h3>
              <div className="flex flex-wrap items-end gap-5">
                {radii.map(([token, px, role]) => (
                  <div key={token} className="flex flex-col items-center gap-2 text-center">
                    <div className="h-16 w-16 border border-[var(--border)] bg-base-200" style={{ borderRadius: px }} />
                    <code className="text-[10px] text-base-content/45">{px}</code>
                    <span className="max-w-20 text-[10px] leading-3 text-base-content/50">{role}</span>
                  </div>
                ))}
              </div>
            </article>
            <article className="rounded-[10px] border border-[var(--border-subtle)] bg-base-100 p-6 shadow-[var(--shadow-raised)]">
              <h3 className="mb-6 text-sm">Elevation</h3>
              <div className="grid grid-cols-2 gap-5">
                {shadows.map(([token, value, role]) => (
                  <div key={token} className="flex flex-col items-center gap-2 text-center">
                    <div className="h-16 w-full rounded-[10px] border border-[var(--border-subtle)] bg-base-100" style={{ boxShadow: value }} />
                    <code className="text-[10px] text-base-content/45">{token}</code>
                    <span className="text-[10px] text-base-content/50">{role}</span>
                  </div>
                ))}
              </div>
            </article>
          </div>
        </Section>

        <Section number="05" title="Core components" description="Components share one radius scale, focus treatment, and motion curve. Every control below is driven by the token layer.">
          <div className="grid gap-4 lg:grid-cols-2">
            <Showcase title="Buttons">
              <div className="flex flex-wrap gap-2">
                <button className="btn btn-primary">Create sequence <FiArrowRight /></button>
                <button className="btn border border-[var(--border)] bg-base-100 hover:bg-base-200">Secondary</button>
                <button className="btn btn-ghost">Ghost</button>
                <button className="btn btn-error">Delete</button>
                <button className="btn btn-primary" disabled>Disabled</button>
              </div>
            </Showcase>
            <Showcase title="Inputs">
              <label className="block max-w-sm">
                <span className="mb-2 block text-xs font-medium text-base-content/75">Search people</span>
                <span className="relative block">
                  <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-base-content/45" aria-hidden="true" />
                  <input className="input w-full pl-10" placeholder="Name, role, or company" />
                </span>
                <span className="mt-1.5 block text-[11px] text-base-content/50">Use company filters to narrow results.</span>
              </label>
            </Showcase>
            <Showcase title="Badges and status pills">
              <div className="flex flex-wrap gap-2">
                <span className="badge border border-[var(--success-border)] bg-[var(--success-bg)] text-[var(--success-text)]">
                  <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-[var(--success-solid)]" /> Active
                </span>
                <span className="badge border border-[var(--warning-border)] bg-[var(--warning-bg)] text-[var(--warning-text)]">Pending</span>
                <span className="badge border border-[var(--danger-border)] bg-[var(--danger-bg)] text-[var(--danger-text)]">Failed</span>
                <span className="badge border border-[var(--border)] bg-base-200 text-base-content/60">Draft</span>
              </div>
            </Showcase>
            <Showcase title="Segmented control">
              <div className="inline-flex rounded-[10px] border border-[var(--border-subtle)] bg-base-200 p-1">
                {["Contacts", "Companies", "Lists"].map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => setSegment(item)}
                    aria-pressed={segment === item}
                    className={`rounded-[7px] px-3.5 py-1.5 text-xs font-medium transition-colors ${segment === item ? "bg-base-100 text-base-content shadow-[var(--shadow-raised)]" : "text-base-content/55 hover:text-base-content/80"}`}
                  >
                    {item}
                  </button>
                ))}
              </div>
            </Showcase>
            <Showcase title="Card">
              <div className="rounded-[16px] border border-[var(--border-subtle)] bg-base-100 p-5 shadow-[var(--shadow-raised)]">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h4 className="text-sm font-semibold">Q3 outbound</h4>
                    <p className="mt-1 text-xs text-base-content/55">142 contacts · 3 steps</p>
                  </div>
                  <span className="badge border border-[var(--success-border)] bg-[var(--success-bg)] text-[var(--success-text)]">Live</span>
                </div>
                <div className="mt-4 border-t border-[var(--border-subtle)] pt-4 text-xs text-base-content/55">
                  Last activity 12 minutes ago.
                </div>
              </div>
            </Showcase>
            <Showcase title="Table">
              <div className="overflow-hidden rounded-[10px] border border-[var(--border-subtle)]">
                <table className="table table-sm m-0">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Stage</th>
                      <th className="text-right">Opens</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[["Dana Ito", "Replied", "12"], ["Marco Vale", "Sent", "8"], ["Priya Rao", "Queued", "0"]].map((row) => (
                      <tr key={row[0]}>
                        <td className="font-medium text-base-content">{row[0]}</td>
                        <td className="text-base-content/60">{row[1]}</td>
                        <td className="text-right tabular-nums text-base-content/60">{row[2]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Showcase>
          </div>
        </Section>

        <footer className="mt-20 flex flex-col justify-between gap-3 border-t border-[var(--border-subtle)] pt-6 text-[11px] text-base-content/45 sm:flex-row">
          <span>Linki design system · Calm Paper · single source of truth</span>
          <code>Linki Design System/tokens/</code>
        </footer>
      </div>
    </>
  );
}

function Section({ number, title, description, children }: { number: string; title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="mt-16">
      <div className="mb-6 grid gap-3 lg:grid-cols-2">
        <div>
          <p className="font-mono text-[11px] font-medium text-primary">{number}</p>
          <h2 className="mt-2 text-[28px] tracking-[-.02em]">{title}</h2>
        </div>
        <p className="max-w-xl text-sm leading-6 text-base-content/55 lg:pt-6">{description}</p>
      </div>
      {children}
    </section>
  );
}

function Showcase({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <article className="rounded-[10px] border border-[var(--border-subtle)] bg-base-100 p-5 shadow-[var(--shadow-raised)] sm:p-6">
      <h3 className="mb-6 text-sm">{title}</h3>
      {children}
    </article>
  );
}

function SwatchGroup({ label, swatches }: { label: string; swatches: string[][] }) {
  return (
    <div className="mb-6 last:mb-0">
      <p className="mb-3 text-xs font-medium text-base-content/60">{label}</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {swatches.map(([name, value, role]) => (
          <article key={name} className="overflow-hidden rounded-[10px] border border-[var(--border-subtle)] bg-base-100 shadow-[var(--shadow-raised)]">
            <div className="h-20 border-b border-[var(--border-subtle)]" style={{ background: value }} />
            <div className="p-4">
              <div className="flex items-center justify-between gap-3">
                <code className="text-xs text-base-content">{name}</code>
              </div>
              <p className="mt-1.5 text-xs text-base-content/55">{role}</p>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
