---
name: linki-design
description: Use this skill to generate well-branded interfaces and assets for Linki (sales automation software), either for production or throwaway prototypes/mocks/etc. Contains essential design guidelines, colors, type, fonts, assets, and UI kit components for prototyping.
user-invocable: true
---

Read the `readme.md` file within this skill, and explore the other available files.

If creating visual artifacts (slides, mocks, throwaway prototypes, etc), copy assets out and create static HTML files for the user to view. If working on production code, you can copy assets and read the rules here to become an expert in designing with this brand.

If the user invokes this skill without any other guidance, ask them what they want to build or design, ask some questions, and act as an expert designer who outputs HTML artifacts _or_ production code, depending on the need.

## Quick map
- `readme.md` — the full design guide: philosophy, content voice, visual foundations, iconography, accessibility, tokens, review checklist, and a file index. **Start here.**
- `styles.css` — the only stylesheet to link; it `@import`s everything in `tokens/`.
- `tokens/` — CSS custom properties (colors, typography, spacing, radius/elevation/motion, base reset). Consume the *semantic aliases* (`--primary`, `--text`, `--surface`), not raw ramps.
- `components/` — 24 reusable React primitives, grouped (buttons, forms, display, feedback, navigation, overlays). Each has a `.d.ts`, a `.prompt.md` usage note, and a `@dsCard` specimen.
- `ui_kits/linki-app/` — clickable recreation of the Linki product (dashboard, sequences, contacts) composed from the primitives.
- `cards/` — foundation specimen cards (Colors, Type, Spacing, Brand).

## Loading the components (HTML artifacts)
Link `styles.css`, load React + Babel + Lucide + the compiled bundle, then read components off the namespace:

```html
<link rel="stylesheet" href="styles.css">
<script src="https://unpkg.com/react@18.3.1/umd/react.production.min.js"></script>
<script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js"></script>
<script src="https://unpkg.com/@babel/standalone@7.29.0/babel.min.js"></script>
<script src="https://unpkg.com/lucide@0.462.0/dist/umd/lucide.min.js"></script>
<script src="_ds_bundle.js"></script>
<script type="text/babel">
  const { Button, Card, Icon, Input } = window.LinkiDesignSystem_8f2af2;
  // …render
</script>
```

Icons come from Lucide via the `Icon` component: `<Icon name="git-branch" size={16} />`.

## Non-negotiables
- Sentence case everywhere. Address the user as "you," the product as "Linki." Verb-first buttons. No emoji in product UI.
- One primary (cobalt) action per view. Two background tones max. Flat backgrounds — no gradients/photos inside the product.
- Tokens only: no hard-coded colors, radii, or spacing. AA contrast, always-visible focus ring, 44px touch targets.

## Known gaps (flag to the user)
- **No real logo/brand color/fonts were provided.** Geist/Geist Mono (Google Fonts) and a Cobalt palette are considered defaults. Lucide is the icon set. Swap any of these when the real brand assets arrive.
