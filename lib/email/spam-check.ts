// A scan of one email's subject and body for the words and habits that spam filters, and
// the people behind them, treat as a reason to bin it.
//
// This is plain text in, findings out, with no server code in it, so the editor can run
// it as someone types and the runner can run the very same rules just before sending.
//
// It is a list of known patterns and not a spam filter's real score: a clean result says
// "nothing here is a known trigger", never "this will reach the inbox". Mailbox
// reputation, authentication and who the contact is weigh far more than any word.
//
// What it leaves alone: merge tags (`{{first_name}}`), which are filled in later, and the
// signature, which belongs to the sender and is not part of what is scanned.

export type SpamSeverity = "high" | "medium" | "low";
export type SpamField = "subject" | "body";

export interface SpamFinding {
  /** A stable name for the rule that matched, for grouping and tests. */
  rule: string;
  severity: SpamSeverity;
  field: SpamField;
  /** The text as written. */
  text: string;
  start: number;
  end: number;
  /** One sentence on why this is a problem. */
  why: string;
  /**
   * What cleaning puts there instead: "" takes it out. Null when it cannot be mended
   * without changing what the sentence says, so cleaning leaves it and someone has to.
   */
  replacement: string | null;
}

export type SpamLevel = "clean" | "review" | "risky";

export interface SpamReport {
  findings: SpamFinding[];
  /** 0 is nothing found, 100 is as bad as it gets. */
  score: number;
  level: SpamLevel;
}

export interface SpamInput { subject?: string | null; body?: string | null }

export interface SpamRemoval { field: SpamField; text: string; replacement: string }

export interface SpamClean {
  subject: string;
  body: string;
  /** What was changed, in order. Empty when nothing was. */
  removed: SpamRemoval[];
  /** What was found and could not be mended. Someone has to rewrite these. */
  left: SpamFinding[];
}

interface Rule {
  id: string;
  /** Must be global and case-insensitive where it should match any case. */
  pattern: RegExp;
  severity: SpamSeverity;
  why: string;
  replace: string | null | ((match: string) => string);
  /** Counts for more in a subject, where it is read first. */
  subjectSeverity?: SpamSeverity;
  only?: SpamField;
}

const phrase = (words: string[]) => new RegExp(`\\b(?:${words.join("|")})\\b`, "gi");

const RULES: Rule[] = [
  // "URGENT:" at the front of a subject can come off without changing what the email says.
  { id: "subject-alarm", pattern: /^\s*(?:urgent|important|attention|action required|final notice|last chance)\s*[:!\-–—]+\s*/gi, severity: "high", only: "subject", why: "An alarm word at the front of a subject is a classic phishing and bulk-mail opener.", replace: "" },

  // Pressure and urgency.
  { id: "pressure", pattern: phrase(["act (?:now|today|immediately|fast)", "buy now", "order now", "apply now", "call now", "subscribe now", "sign up (?:now|today)", "hurry"]), severity: "high", why: "A pressure phrase: it is what bulk mail sounds like.", replace: "" },
  { id: "click-here", pattern: phrase(["click (?:here|below|this link)", "click to (?:claim|win|get)"]), severity: "high", why: "\"Click here\" is one of the oldest spam tells. Say what the link is for.", replace: null },
  { id: "urgency", pattern: phrase(["urgent(?:ly)?", "immediately", "asap", "time[- ]sensitive", "last chance", "final notice", "don'?t (?:miss out|delay|wait)", "expires? (?:soon|today|tonight)", "limited[- ]time(?: offer)?", "once in a lifetime", "while supplies last", "what are you waiting for"]), severity: "medium", subjectSeverity: "high", why: "An urgency word. Real one-to-one mail rarely needs one.", replace: null },

  // Money and promises.
  { id: "free-claim", pattern: phrase(["100% free", "totally free", "absolutely free", "completely free", "free of charge"]), severity: "high", why: "\"Free\" made louder is a classic trigger.", replace: "free" },
  { id: "free-offer", pattern: phrase(["free (?:trial|quote|consultation|access|gift|demo|sample|bonus|money|offer|membership)", "get (?:it )?free"]), severity: "medium", why: "An offer of something free is a common spam trigger.", replace: null },
  { id: "money", pattern: phrase(["make money(?: fast| online)?", "get rich", "easy money", "fast cash", "free money", "cash bonus", "extra income", "financial freedom", "earn (?:an )?extra", "double your (?:income|sales|revenue|money|traffic)", "increase your (?:sales|traffic|revenue)", "work from home", "be your own boss"]), severity: "high", why: "A get-rich or earn-more promise.", replace: null },
  { id: "dollars", pattern: /\${2,}|\b(?:earn|make|win|save) \$\s?\d[\d,.]*/gi, severity: "high", why: "A money amount pushed at the reader.", replace: null },
  { id: "price-bait", pattern: phrase(["lowest price", "best price", "cheap(?:est)?", "bargain", "incredible deal", "special promotion", "exclusive deal", "pre-?approved", "no credit check", "unsecured (?:loan|credit)"]), severity: "medium", why: "Price-bait wording.", replace: null },

  // Guarantees and reassurance.
  { id: "guarantee", pattern: phrase(["100% (?:guaranteed|satisfaction|satisfied|secure|safe)", "satisfaction guaranteed", "money[- ]back guarantee", "guaranteed", "risk[- ]free"]), severity: "high", why: "A guarantee: spam filters weigh these heavily.", replace: null },
  { id: "no-catch", pattern: phrase(["no obligation", "no strings attached", "no catch", "no hidden (?:fees|costs|charges)", "no (?:questions asked|purchase necessary)", "this (?:isn'?t|is not) spam", "not spam"]), severity: "medium", why: "Reassurance nobody asked for reads as a sales script.", replace: null },

  // Hype, prizes and false familiarity.
  { id: "hype", pattern: phrase(["miracle", "amazing", "incredible", "unbelievable", "revolutionary", "breakthrough", "too good to be true", "mind[- ]blowing", "life[- ]changing", "once[- ]in[- ]a[- ]lifetime"]), severity: "low", why: "Hype wording; say what it does instead.", replace: null },
  { id: "prize", pattern: phrase(["you(?:'ve| have| are)? (?:been selected|won|a winner)", "congratulations", "winner", "prize", "jackpot", "lottery", "casino", "claim your"]), severity: "high", why: "Prize and winner language.", replace: null },
  { id: "false-familiarity", pattern: phrase(["dear (?:friend|sir|madam|customer|valued)", "valued customer", "as seen on", "hello friend"]), severity: "medium", why: "A greeting that shows it was written for nobody.", replace: null },

  // Things that should never be in outreach.
  { id: "restricted", pattern: phrase(["viagra", "cialis", "weight[- ]loss", "lose weight", "diet pills?", "enlargement", "xxx", "porn", "nigerian", "wire transfer"]), severity: "high", why: "A word from the categories mail filters block outright.", replace: null },
  { id: "shortener", pattern: /\b(?:bit\.ly|tinyurl\.com|goo\.gl|ow\.ly|is\.gd|buff\.ly|rebrand\.ly|cutt\.ly|t\.co)\/\S*/gi, severity: "high", why: "A link shortener hides where the link goes, which is what filters look for. Link to your own domain.", replace: null },
];

/** All-caps words of four letters or more are shouting, unless they are what it is called. */
const CAPS_OK = new Set(["SAAS", "PAAS", "IAAS", "HIPAA", "GDPR", "CCPA", "HTTP", "HTTPS", "HTML", "JSON", "EBITDA", "NASDAQ", "NYSE", "FINRA", "FAANG", "OKRS", "AWS", "DOCS"]);

const SEVERITY_WEIGHT: Record<SpamSeverity, number> = { high: 20, medium: 10, low: 4 };

/** Merge tags are filled in later and say nothing yet, so they are blanked (keeping every offset the same). */
function masked(text: string): string {
  return text
    .replace(/\{\{[^{}]*\}\}/g, (match) => " ".repeat(match.length))
    // A {choice|of|words} is read as every one of its choices.
    .replace(/[{}|]/g, " ")
    .replace(/\[unsubscribe link\]/gi, (match) => " ".repeat(match.length));
}

function scan(text: string, field: SpamField): SpamFinding[] {
  const found: SpamFinding[] = [];
  const hay = masked(text);
  const add = (rule: string, severity: SpamSeverity, start: number, end: number, why: string, replacement: string | null) =>
    found.push({ rule, severity, field, text: text.slice(start, end), start, end, why, replacement });

  for (const rule of RULES) {
    if (rule.only && rule.only !== field) continue;
    const severity = field === "subject" && rule.subjectSeverity ? rule.subjectSeverity : rule.severity;
    for (const match of hay.matchAll(rule.pattern)) {
      const start = match.index ?? 0;
      const replacement = typeof rule.replace === "function" ? rule.replace(match[0]) : rule.replace;
      add(rule.id, severity, start, start + match[0].length, rule.why, replacement);
    }
  }

  // SHOUTING.
  for (const match of hay.matchAll(/\b[A-Z]{4,}\b/g)) {
    if (CAPS_OK.has(match[0])) continue;
    const start = match.index ?? 0;
    add("shouting", field === "subject" ? "medium" : "low", start, start + match[0].length, "A word in capitals reads as shouting.", match[0][0] + match[0].slice(1).toLowerCase());
  }

  // !!! and ???
  for (const match of hay.matchAll(/([!?])\1+/g)) {
    const start = match.index ?? 0;
    add("repeated-punctuation", "medium", start, start + match[0].length, "Repeated punctuation is a spam habit.", match[1]);
  }

  // Exclamation marks: none in a subject, and no more than two in a body.
  let bangs = 0;
  for (const match of hay.matchAll(/!(?!!)/g)) {
    const start = match.index ?? 0;
    // The ones inside a "!!" run were reported above.
    if (hay[start - 1] === "!") continue;
    bangs += 1;
    if (field === "subject") add("exclamation", "medium", start, start + 1, "An exclamation mark in a subject line reads as an advert.", "");
    else if (bangs > 2) add("exclamation", "low", start, start + 1, "More than two exclamation marks in one email.", ".");
  }

  // A lot of links.
  const links = [...hay.matchAll(/\bhttps?:\/\/\S+|\bwww\.\S+/gi)];
  if (field === "body" && links.length > 3) {
    const at = links[3].index ?? 0;
    add("many-links", "low", at, at + links[3][0].length, `${links.length} links in one email. One is plenty for a first message.`, null);
  }

  return found;
}

/** Drop a finding that overlaps another, keeping the stronger one; of equals, the longer, then the one cleaning can mend. */
function withoutOverlaps(findings: SpamFinding[]): SpamFinding[] {
  const rank = { high: 3, medium: 2, low: 1 };
  const stronger = (a: SpamFinding, b: SpamFinding) =>
    rank[a.severity] - rank[b.severity] || (a.end - a.start) - (b.end - b.start) || Number(a.replacement !== null) - Number(b.replacement !== null);
  const kept: SpamFinding[] = [];
  for (const finding of [...findings].sort((a, b) => a.field.localeCompare(b.field) || a.start - b.start)) {
    const clash = kept.findIndex((other) => other.field === finding.field && finding.start < other.end && other.start < finding.end);
    if (clash === -1) kept.push(finding);
    else if (stronger(finding, kept[clash]) > 0) kept[clash] = finding;
  }
  return kept.sort((a, b) => a.field.localeCompare(b.field) || a.start - b.start);
}

export function scoreOf(findings: readonly SpamFinding[]): { score: number; level: SpamLevel } {
  // Each one counts, less and less: ten small ones are not as bad as ten large ones.
  const sorted = [...findings].sort((a, b) => SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity]);
  const score = Math.min(100, Math.round(sorted.reduce((sum, finding, index) => sum + SEVERITY_WEIGHT[finding.severity] * Math.pow(0.85, index), 0)));
  const level: SpamLevel = score >= 40 ? "risky" : score >= 10 ? "review" : "clean";
  return { score, level };
}

/** Scan one email. A subject or body left out is simply not scanned. */
export function checkSpam(input: SpamInput): SpamReport {
  const findings = withoutOverlaps([
    ...scan(input.subject ?? "", "subject"),
    ...scan(input.body ?? "", "body"),
  ]);
  return { findings, ...scoreOf(findings) };
}

/** What a removal leaves behind: a marker that is turned into a capital if the sentence now begins there. */
const GAP = "\u0001";

function tidy(text: string): string {
  // Where something was taken out, a sentence that now begins there starts with a capital.
  let out = text.replace(new RegExp(`(^|[.!?]\\s+|\\n)${GAP}\\s*([a-z])`, "g"), (_whole, lead: string, letter: string) => lead + letter.toUpperCase());
  out = out.replace(new RegExp(`${GAP}\\s*`, "g"), "");
  out = out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([,.;:!?])/g, "$1")
    .replace(/([,;:])\s*([.!?])/g, "$2")
    .replace(/^[ \t]*[,;:.]\s*/gm, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n");
  return out.trim() === "" ? "" : out.replace(/^[ \t]+/, "");
}

function apply(text: string, findings: SpamFinding[]): string {
  let out = text;
  // From the end, so earlier offsets stay true.
  for (const finding of [...findings].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, finding.start) + (finding.replacement === "" ? GAP : finding.replacement) + out.slice(finding.end);
  }
  return out;
}

/**
 * Take out what can be taken out and soften what can be softened: pressure phrases go,
 * capitals are lowered, runs of "!!!" are cut to one, a subject loses its "!". What cannot
 * be mended without changing the meaning (a guarantee, a price) stays, and comes back in
 * `left`.
 */
export function cleanSpam(input: SpamInput): SpamClean {
  const subject = input.subject ?? "";
  const body = input.body ?? "";
  const { findings } = checkSpam({ subject, body });
  const mend = findings.filter((finding) => finding.replacement !== null);
  const cleaned = {
    subject: tidy(apply(subject, mend.filter((finding) => finding.field === "subject"))),
    body: tidy(apply(body, mend.filter((finding) => finding.field === "body"))),
  };
  // Cleaning must never leave a message with nothing in it: with no words left, send what was written.
  const emptied = (before: string, after: string) => before.trim() !== "" && after.trim() === "";
  const result = { subject: emptied(subject, cleaned.subject) ? subject : cleaned.subject, body: emptied(body, cleaned.body) ? body : cleaned.body };
  const kept = (field: SpamField, before: string, after: string) => (before === after ? [] : mend.filter((finding) => finding.field === field));
  return {
    ...result,
    removed: [...kept("subject", subject, result.subject), ...kept("body", body, result.body)]
      .map((finding) => ({ field: finding.field, text: finding.text, replacement: finding.replacement ?? "" })),
    left: findings.filter((finding) => finding.replacement === null),
  };
}

export const SPAM_LEVEL_LABEL: Record<SpamLevel, string> = { clean: "Nothing flagged", review: "Worth a look", risky: "Likely to be filtered" };

/** "act now", "FREE" and 2 more — a short sentence for a log line or a toast. */
export function describeFindings(findings: readonly SpamFinding[], shown = 3): string {
  if (findings.length === 0) return "nothing flagged";
  const words = [...new Set(findings.map((finding) => `"${finding.text.trim()}"`))];
  return words.length <= shown ? words.join(", ") : `${words.slice(0, shown).join(", ")} and ${words.length - shown} more`;
}

// ── The mode a campaign holds its emails to ──────────────────────────────────────
// Here, with no server code, so the settings screen can show the same words the runner acts on.

export const SPAM_MODES = ["off", "flag", "remove"] as const;
export type SpamMode = (typeof SPAM_MODES)[number];
export const FALLBACK_SPAM_MODE: SpamMode = "flag";

export const isSpamMode = (value: unknown): value is SpamMode => typeof value === "string" && (SPAM_MODES as readonly string[]).includes(value);

export const SPAM_MODE_LABEL: Record<SpamMode, string> = { off: "Off", flag: "Flag", remove: "Remove" };
export const SPAM_MODE_HINT: Record<SpamMode, string> = {
  off: "Emails are not checked.",
  flag: "Spam words are flagged in the editor, the preview and the log. Emails are sent as written.",
  remove: "Flagged phrases are taken out just before an email is sent, and what was removed is logged. What cannot be mended is flagged.",
};
