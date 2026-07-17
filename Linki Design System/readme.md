# Linki Design System

The single source of truth for **Linki** — sales automation software that helps
revenue teams build, run, and optimize outbound sequences without babysitting them.
This system is designed for a modern, AI-native B2B SaaS product: calm, dense,
professional, and built to scale to hundreds of screens.

> **Provenance.** No external codebase, Figma file, brand kit, or font files were
> provided. This system was authored from a written brief describing Linki as
> "sales automation software," in the spirit of Notion, Linear, Stripe, Vercel,
> Figma, Ramp, and Arc. Every value below is a deliberate, documented decision —
> **treat it as a proposal to react to, not a recovered fact.** If Linki has a real
> logo, brand color, or typeface, drop them in and the tokens will cascade.

---

## Design philosophy

Function before decoration. Every visual element earns its place; when in doubt,
we remove it. The interface should feel **calm at rest and fast in the hand** —
high information density that never tips into clutter, built for power users
running dozens of sequences a day while staying legible to a first-time trial user.

Five principles guide every decision:

1. **Clarity over cleverness.** The obvious layout beats the novel one. Hierarchy
   is carried by type weight, spacing, and a single brand color — not by boxes,
   gradients, or shadows.
2. **Density with air.** Sales tools are dashboards, tables, and pipelines. We
   optimize for scanning many rows, not for hero whitespace. A 4px base grid buys
   fine control; an 8px rhythm keeps it from feeling cramped.
3. **One accent, used sparingly.** Cobalt marks the single most important action
   or state on a view. If everything is blue, nothing is.
4. **Consistency is a feature.** The same control is the same size, the same
   radius, the same focus ring everywhere. Muscle memory is the point.
5. **Accessible by construction.** AA contrast, visible focus, 44px touch targets,
   and reduced-motion support are baked into the tokens — not bolted on per screen.

We explicitly avoid: skeuomorphism, decorative gradients, heavy or stacked
shadows, glassmorphism, oversized marketing spacing inside the product, and
playful/rounded "friendly SaaS" tropes.

---

## The product

Linki is a sales-automation platform. The core surfaces a design will most often
touch:

- **Dashboard** — pipeline health, reply/open/meeting metrics, live activity.
- **Sequences** — multi-step outbound campaigns (email, calls, LinkedIn, waits)
  with per-step analytics; the heart of the product.
- **Contacts / CRM** — the people and companies being worked, with enrichment,
  stage, and owner.
- **Inbox** — unified replies across channels, triaged with AI intent labels.
- **Analytics, Settings, Onboarding, Auth** — supporting surfaces.

Users span founders, PMs, engineers, designers, marketing, ops, and enterprise
admins — so the system supports both a guided beginner path and keyboard-driven
power use (command palette, shortcuts, dense tables).

---

## CONTENT FUNDAMENTALS

How Linki writes. Copy is part of the design; keep it consistent.

- **Voice:** confident, plain, and quietly expert. We sound like a sharp colleague,
  not a mascot and not a legal department. Short declarative sentences.
- **Person:** address the user as **"you"**; refer to the product as **"Linki"** or
  "we" for actions the system takes ("We'll retry failed sends automatically").
- **Casing:** **Sentence case everywhere** — buttons, menus, headings, table
  headers, dialog titles. Never Title Case UI. (`New sequence`, not `New Sequence`.)
- **Tense & mood:** present tense, active voice, imperative for actions
  (`Add step`, `Enroll contacts`, `Verify domain`).
- **Length:** buttons are 1–3 words and lead with a verb. Empty states are one
  sentence of what-this-is plus one primary action. Error messages say what
  happened and what to do next, never just "Something went wrong."
- **Numbers & metrics:** always concrete and formatted (`24.6%`, `1,204 contacts`,
  `+3.1%`). Tabular numerals so columns align. Deltas are signed.
- **Emoji:** not used in product UI. (Reactions/notes authored by users are their
  own; the *system* never speaks in emoji.)
- **No exclamation marks** in system copy except genuine celebration in a success
  toast, and even then sparingly.

Representative copy:

- Button: `New sequence` · `Enroll 142 contacts` · `Verify domain` · `Skip step`
- Empty state: *"No sequences yet. Build your first outbound flow in a few minutes."*
- Toast (success): *"Sequence launched — 142 contacts enrolled."*
- Alert (warning): *"Domain not verified. Add a TXT record to send from this domain."*
- Confirm (destructive): *"Delete sequence? This removes all 142 enrolled contacts.
  This can't be undone."*
- Metric label: `Reply rate` · `Meetings booked` · `Emails sent`

---

## VISUAL FOUNDATIONS

The look: **engineered, cool, and low-noise.** Think Linear's restraint + Stripe's
data legibility. See the Design System tab for live specimens; the reasoning is here.

**Color.** One saturated brand blue — **Cobalt** (`#2450E6`, `--cobalt-600`) — used
only for the primary action, active nav, focus, and selection. A **Signal Teal**
accent (`#0A877A`) reads as growth/"connected" and colors positive data. Neutrals
are **cool slate** (a faint blue undertone) so greys never look muddy beside cobalt.
Semantic colors (green/amber/red) are reserved strictly for status. Two background
tones max per screen: `--bg-app` canvas and `--surface` cards. Full ramps + semantic
aliases live in `tokens/colors.css`; **consume the aliases (`--primary`, `--text`,
`--surface`), not raw ramps.**

**Type.** A single family, **Geist** (Vercel's neutral grotesque), across the whole
UI; **Geist Mono** for code, IDs, and numeric data. One family = fewer decisions and
tighter consistency. Scale is a ~1.2 modular ratio snapped to whole pixels; base body
is **14px**. Headings are semibold (600) with slightly negative letter-spacing for
optical tightness; body is regular (400) at 1.5 line-height. **Tabular numerals are
on by default** so metrics and tables align. Weights used: 400 body, 500 UI labels,
600 headings.

**Spacing.** 4px base, 8px rhythm. 16px is default component padding, 24px is card
padding and group gap, 48px is section gap. Controls sit on a fixed vertical grid:
28 / 34 / 40px heights (sm/md/lg). Layout constants: 248px sidebar, 56px topbar,
1200px content max.

**Backgrounds.** Flat. No photographic hero imagery inside the product, no repeating
textures, no gradient washes. The canvas is a near-white cool grey (`--bg-app`);
cards are pure white. Marketing surfaces may use a single very subtle cobalt tint
panel, never a rainbow gradient.

**Corner radii.** Restrained and consistent: controls/inputs/buttons/menus **8px**,
badges/tags/inner elements **5px**, cards/popovers **10px**, modals **14px**,
marketing panels **20px**, pills/avatars full. Nothing is fully pill-shaped except
avatars, status dots, and true pill chips.

**Cards.** White surface, **1px hairline border** (`--border-subtle`), 10px radius,
and a *soft, single-layer* raised shadow — not a heavy drop shadow. Interactive cards
lift 1px and deepen the shadow on hover. No colored left-border accent cards.

**Elevation.** Soft, low-contrast, layered, and tinted with slate (not pure black) so
shadows read as depth rather than grey smudge. Six levels: flat → raised (cards) →
floating (hover/dropdown) → popover → modal, plus a 1px nav shadow. Dark mode swaps to
darker shadows + a 1px light hairline for separation.

**Borders.** Hairlines do most of the structural work. 1px is standard; 1.5px for
emphasized dividers. Borders go *subtractive* in light mode (darker than surface) and
*additive* in dark mode (a faint light hairline).

**Motion.** Fast, subtle, purposeful. Durations: 120ms hovers, 180ms most
transitions, 260ms overlays. Standard easing `cubic-bezier(.2,0,0,1)`. Hovers change
background/border color; presses **scale to .98** (never a bounce). Overlays fade +
rise 4px. No parallax, no decorative looping animation. Everything collapses to 0ms
under `prefers-reduced-motion`.

**States.** Hover = a step-darker surface or brand tint (not opacity). Press = .98
scale + one step darker. Focus = a 3px cobalt halo (`--focus-ring`) that is always
visible on keyboard focus. Disabled = 50% opacity + `not-allowed`.

**Transparency & blur.** Used almost never. The modal scrim is a ~44% slate wash. No
frosted-glass panels. `color-mix` produces tinted subtle backgrounds instead of
alpha-stacked layers.

**Dark mode** is a true theme, not an inversion: surfaces climb from near-black
(`#0B0E14` app → `#151A23` surface), the brand lightens one step for AA on dark,
borders become additive light hairlines, and shadows darken. Toggle with
`data-theme="dark"` on any ancestor.

---

## ICONOGRAPHY

- **Icon set: [Lucide](https://lucide.dev).** Chosen for its large, consistent,
  MIT-licensed set that matches the engineered aesthetic. It is loaded from CDN
  (`lucide` UMD) in cards and kits; the `Icon` component renders any Lucide glyph by
  name (`<Icon name="zap" />`).
- **Style:** outlined (stroke) icons only — **2px stroke** at 24×24, round caps and
  joins. No filled/duotone icons in the product chrome. Filled variants are reserved
  for tiny status dots and the occasional selected-state glyph.
- **Sizes:** 14px (inline with sm text / dense toolbars), 16px (default, aligns with
  body), 18–20px (nav, section headers). Never below 14px.
- **Color:** icons inherit `currentColor` — muted (`--text-muted`) by default, brand
  or semantic only to signal meaning.
- **No emoji** as iconography, no Unicode symbol glyphs standing in for icons, no PNG
  icons. If Lucide lacks a glyph, compose from Lucide primitives or request an SVG —
  do not hand-draw a one-off.
- **Substitution flag:** Lucide is a *chosen default*, not a provided asset. If Linki
  has its own icon set, swap the CDN link and the `Icon` component's lookup.

### Logo / brand mark

**No logo was provided.** Wherever a mark belongs, Linki is rendered as a **wordmark**
in Geist Semibold, sentence-cased "Linki," typically paired with a small cobalt
square glyph (a simple rounded square, not a reconstructed logo). See the Brand cards.
Replace with the real logo when available; do not treat the placeholder wordmark as
official.

---

## Accessibility (WCAG 2.2 AA)

- Text meets **4.5:1** (body) / **3:1** (large & UI) contrast; semantic text tokens
  are tuned against their backgrounds in both themes.
- **Focus is always visible** — a 3px cobalt halo via `:focus-visible`, never removed.
- **Touch targets ≥ 44px** on mobile; control heights (28/34/40) get generous hit
  padding on touch.
- Controls are keyboard-operable; Menu/Dialog manage focus, Esc, and dismissal.
- **Reduced motion** zeroes all durations.
- Color never carries meaning alone — status pairs a color with a label/icon/dot.

---

## Design tokens & implementation

All tokens are CSS custom properties, organized under `tokens/` and imported by the
root `styles.css` (the only file consumers link):

- `tokens/fonts.css` — `@font-face` / webfont import (Geist, Geist Mono).
- `tokens/colors.css` — ramps + semantic aliases + full dark theme.
- `tokens/typography.css` — families, weights, scale, line-height, tracking, numerics.
- `tokens/spacing.css` — 4/8 spacing, control heights, layout constants.
- `tokens/foundations.css` — radius, elevation, borders, motion, z-index, opacity,
  breakpoints.
- `tokens/base.css` — reset + type-ladder helper classes + keyframes.

For **Tailwind**, map `theme.extend` to `var(--…)`. For **CSS variables**, link
`styles.css`. For **Figma variables**, mirror the ramp + alias two-tier structure
(primitive collection → semantic collection with light/dark modes). Components are
authored as self-contained React (`components/<group>/`), consuming only the CSS vars.

**Developer handoff:** React + Next.js + Tailwind + Radix/shadcn. Keep the two-tier
token model (primitive ramps → semantic aliases); build against aliases so theming is
a token swap. Component architecture mirrors this folder layout: primitives in
`components/`, composed screens in `ui_kits/`.

---

## Design review checklist

Before shipping any screen:

- [ ] **Visual consistency** — tokens only; no hard-coded colors, radii, or spacing.
- [ ] **Hierarchy** — one primary action; weight/space carry emphasis, not boxes.
- [ ] **Accessibility** — AA contrast, visible focus, labels on inputs, 44px targets.
- [ ] **Responsive** — behaves from 360px mobile to ultra-wide; nav adapts.
- [ ] **States** — hover, focus, active, disabled, loading all defined.
- [ ] **Empty / loading / error** — each real state designed, not just the happy path.
- [ ] **Copy** — sentence case, "you"/"Linki," verb-first buttons, concrete numbers.
- [ ] **Motion** — subtle, fast, and disabled under reduced-motion.
- [ ] **Dark mode** — verified, not just inverted.
- [ ] **Edge cases** — long strings, big numbers, zero/overflow, RTL-safe layout.

---

## Index / manifest

Root:
- `styles.css` — global entry point (import-only). **Consumers link this.**
- `readme.md` — this guide.
- `SKILL.md` — portable skill wrapper (for Claude Code / Agent Skills).
- `thumbnail.html` — project tile.

`tokens/` — `fonts.css`, `colors.css`, `typography.css`, `spacing.css`,
`foundations.css`, `base.css`.

`components/` — 24 reusable primitives, grouped:
- `buttons/` — **Button**, **IconButton**
- `forms/` — **Input**, **Textarea**, **Select**, **Checkbox**, **Radio**, **Switch**
- `display/` — **Icon**, **Badge**, **Tag**, **Avatar**, **Card**, **Metric**
- `feedback/` — **Alert**, **Toast**, **Spinner**, **Skeleton**, **ProgressBar**
- `navigation/` — **Tabs**, **Breadcrumbs**, **Menu**
- `overlays/` — **Dialog**, **Tooltip**

Each directory has a `<group>.prompt.md` usage note and a `@dsCard` specimen HTML.

`ui_kits/linki-app/` — high-fidelity, clickable recreation of the Linki product
(dashboard, sequences, contacts) composed from the primitives. See its `README.md`.

**Foundation specimen cards** (`cards/`) populate the Design System tab under the
groups **Colors**, **Type**, **Spacing**, and **Brand**.

### Intentional additions

Because no source defined the inventory, a standard SaaS primitive set was authored.
Two additions worth noting:
- **Icon** — a thin wrapper over Lucide so consumers reference glyphs by name and
  stroke/size stay consistent.
- **Metric** — a KPI/stat block; dashboards are core to a sales tool and this
  standardizes the label/value/delta pattern.
