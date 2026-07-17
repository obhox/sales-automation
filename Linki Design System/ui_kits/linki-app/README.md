# Linki App — UI kit

High-fidelity, clickable recreation of the **Linki** sales-automation product, composed
from the design-system primitives (no primitive is re-implemented here). Open
`index.html` to click through the shell.

## What's here
- `index.html` — mounts the app shell and wires navigation between screens.
- `Shell.jsx` — persistent chrome: sidebar (workspace switcher, nav, user), topbar
  (breadcrumbs, search, actions). Owns the active-screen state.
- `Dashboard.jsx` — pipeline metrics, sending progress, live activity, sequence table.
- `Sequences.jsx` — sequence list with per-step stats, filters, tabs, row menus.
- `Contacts.jsx` — CRM data table: contacts with owner, stage, enrichment, selection.
- `data.js` — fake seed data shared across screens.

## Fidelity notes
This is a visual/interaction recreation, not production code: data is static, some
actions are cosmetic. Every component family in the system appears at least once
across the screens. Layout constants (248px sidebar, 56px topbar) come from tokens.

## Namespace
Components load from `window.LinkiDesignSystem_8f2af2` via the compiled `_ds_bundle.js`.
Lucide (CDN) supplies icons through the system's `Icon` component.
