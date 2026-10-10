import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// ── The two design systems ───────────────────────────────────────────────────
// Until the rebuild is finished the build carries both the new system and the
// old one (daisyUI + "Calm Paper" tokens, fenced under `.legacy`). daisyUI's
// component classes are global, so a new component that used a class called
// `card` or `table` would silently pick up the old styling. New UI code must
// therefore never use a daisyUI class name or an old token.
//
// The files below still belong to the old system. A phase that rebuilds one
// removes it from this list; when the list is empty the rule covers everything
// and daisyUI can be uninstalled.
const LEGACY_UI_FILES = [
  "components/layout/**",
  "components/onboarding/**",
  "components/ui/FilterBar.tsx",
  "components/ui/ModelPicker.tsx",
  "components/ui/RecordPicker.tsx",
  "components/ui/ExportLink.tsx",
  "pages/index.tsx",
  "pages/inbox.tsx",
  "pages/todos.tsx",
  "pages/pipeline.tsx",
  "pages/platform.tsx",
  "pages/settings.tsx",
  "pages/admin.tsx",
  "pages/email-health.tsx",
  "pages/brand-system.tsx",
  "pages/login.tsx",
  "pages/reset-password.tsx",
  "pages/verify-email.tsx",
  "pages/lists/**",
  "pages/contacts/**",
  "pages/companies/**",
  "pages/workflows/**",
  "pages/invite/**",
  "pages/oauth/**",
];

const DAISY_CLASSES = [
  "alert", "avatar", "badge", "breadcrumbs", "btn", "calendar", "card", "carousel", "chat", "checkbox", "collapse", "countdown",
  "diff", "divider", "dock", "drawer", "dropdown", "fab", "fieldset", "filter", "footer", "glass", "hero", "indicator", "input",
  "join", "kbd", "label", "link", "list", "loading", "mask", "menu", "modal", "navbar", "progress", "radio", "range", "rating",
  "select", "skeleton", "stack", "stat", "status", "steps", "swap", "tab", "table", "tabs", "textarea", "timeline", "toast",
  "toggle", "tooltip", "validator",
];
// A bare daisyUI class name. Only checked where a string is certainly a class
// list (a className attribute or a cn() call), because "filter" and "list" are
// also ordinary words.
const BARE_DAISY = new RegExp(`(^|\\s)(${DAISY_CLASSES.join("|")})(\\s|$)`);
// Unmistakable old-system strings, checked in every string of a UI file: a
// daisyUI modifier (btn-primary, modal-box), a daisyUI colour utility
// (bg-base-200, text-primary) or an old CSS token.
const OLD_TOKENS = new RegExp(
  [
    "(^|\\s)(btn|badge|modal|alert|loading|tabs|input|select|textarea|checkbox|toggle|card|menu|dropdown|tooltip)-(primary|secondary|ghost|error|success|warning|info|outline|open|box|action|backdrop|content|spinner|bordered|boxed|sm|xs|lg)\\b",
    "\\b(bg|text|border|ring|fill|stroke|from|to|via|divide|outline|decoration|accent|caret|shadow)-(base-(100|200|300|content)|(primary|secondary|accent|neutral|info|success|warning|error)(-content)?)\\b",
    "var\\(--(border|surface|text|primary|bg-app|bg-subtle|paper|ink-\\d|viz|shadow-(flat|raised|floating|popover|modal|nav)|radius-pill|focus-ring|space-|control-|linki-)",
  ].join("|"),
);

const isClassList = node => {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === "JSXAttribute") return /[cC]lassName$/.test(String(parent.name.name));
    if (parent.type === "CallExpression" && parent.callee.type === "Identifier" && parent.callee.name === "cn") return true;
  }
  return false;
};

const noOldDesignSystem = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      old: '"{{found}}" belongs to the old design system (daisyUI / Calm Paper). New UI uses the tokens in styles/globals.css and the primitives in components/ui.',
    },
  },
  create(context) {
    const check = (node, text) => {
      const match = OLD_TOKENS.exec(text) ?? (isClassList(node) ? BARE_DAISY.exec(text) : null);
      if (match) context.report({ node, messageId: "old", data: { found: match[0].trim() } });
    };
    return {
      Literal(node) {
        if (typeof node.value === "string") check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value.raw);
      },
    };
  },
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["components/**/*.{ts,tsx}", "pages/**/*.tsx"],
    ignores: [...LEGACY_UI_FILES, "pages/api/**"],
    plugins: { linki: { rules: { "no-old-design-system": noOldDesignSystem } } },
    rules: { "linki/no-old-design-system": "error" },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Reference material and the old design-system bundle are not source.
    "design/**",
    "Linki Design System/**",
  ]),
]);

export default eslintConfig;
