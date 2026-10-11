import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// ── Class names from the design system that was removed ──────────────────────
// The app once ran on daisyUI and a set of "Calm Paper" tokens. Both are gone, so
// a class such as `btn btn-primary` or a variable such as `var(--border)` now
// styles nothing: the element is drawn bare and nothing says why. This rule
// catches those names where they are still typed from habit or copied from old
// code. The UI uses the tokens in styles/globals.css and the primitives in
// components/ui.
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
      old: '"{{found}}" belongs to the design system that was removed (daisyUI / Calm Paper) and styles nothing now. Use the tokens in styles/globals.css and the primitives in components/ui.',
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
    ignores: ["pages/api/**"],
    plugins: { linki: { rules: { "no-old-design-system": noOldDesignSystem } } },
    rules: { "linki/no-old-design-system": "error" },
  },
  // The build scripts are CommonJS on purpose: the Docker build runs them with plain node.
  { files: ["scripts/**/*.js"], rules: { "@typescript-eslint/no-require-imports": "off" } },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Reference material is not source.
    "design/**",
  ]),
]);

export default eslintConfig;
