Button — the primary action control; six variants set the action hierarchy on any screen.

```jsx
<Button variant="primary" leftIcon={<Icon name="plus" />}>New sequence</Button>
<Button variant="secondary">Cancel</Button>
<Button variant="ghost" size="sm">Skip</Button>
<Button variant="destructive" loading>Deleting…</Button>
```

Variants: `primary` (one per view — the main CTA), `secondary` (neutral, most common), `outline` (brand-tinted secondary), `ghost` (low-emphasis / toolbars), `destructive` (irreversible), `link` (inline text action). Sizes `sm | md | lg`; `loading` shows a spinner and disables; pass icon nodes via `leftIcon`/`rightIcon`.
