// The AI & models screen's own sums and wording: money, the model list, what counts as an
// unsaved change, and how the budget and the spend read.
import { describe, expect, it } from "vitest";
import {
  budgetView, changes, dayOfMonth, draftForTest, draftFrom, draftProblem, formatPrice, formatRequestCost, formatUsd, groupModels, lastUsed, modelName,
  monthName, parseBudget, priceLine, requestsNote, shortDay, spendChange, stepName, type AiConfigView, type ModelInfo,
} from "@/components/ai/model";

const model = (id: string, name: string, input: number | null = 1, output: number | null = 5): ModelInfo => ({ id, name, provider: id.split("/")[0], input_price: input, output_price: output, context_length: 200000 });
const MODELS = [
  model("zeta/zed", "Zeta: Zed"), model("openai/gpt-x", "OpenAI: GPT X", 2.5, 10), model("anthropic/claude-haiku-5.5", "Anthropic: Claude Haiku 5.5"),
  model("anthropic/claude-opus-5.5", "Anthropic: Claude Opus 5.5", 5, 25), model("acme/free", "Free One", 0, 0), model("openrouter/auto", "Auto Router", null, null),
];

const SAVED: AiConfigView = {
  default_model: "anthropic/claude-opus-5.5", fallback_model: null, tone: "direct", system_prompt: "Be brief.", user_prompt: "",
  email_examples: [{ title: "Opener", body: "Hello." }], linkedin_examples: [], monthly_budget_usd: 100, updated_at: "2026-10-01 09:00:00",
};

describe("money", () => {
  it("is written to the cent, with a floor for amounts too small to show", () => {
    expect(formatUsd(38.416)).toBe("$38.42");
    expect(formatUsd(1234.5)).toBe("$1,234.50");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.004)).toBe("<$0.01");
    expect(formatUsd(null)).toBe("—");
  });

  it("keeps the fractions of a cent for a single request", () => {
    expect(formatRequestCost(0.0031)).toBe("$0.0031");
    expect(formatRequestCost(0.25)).toBe("$0.25");
    expect(formatRequestCost(0)).toBe("$0.00");
    expect(formatRequestCost(null)).toBe("not reported");
  });

  it("writes a model's price per million tokens", () => {
    expect(formatPrice(5)).toBe("$5.00");
    expect(formatPrice(0.075)).toBe("$0.075");
    expect(formatPrice(0)).toBe("free");
    expect(formatPrice(null)).toBe("varies");
    expect(priceLine(MODELS[3])).toBe("$5.00 / $25.00 per 1M tokens");
    expect(priceLine(MODELS[4])).toBe("Free");
    expect(priceLine(MODELS[5])).toBeNull();
    expect(priceLine(undefined)).toBeNull();
  });
});

describe("the model list", () => {
  it("names a model without repeating its provider, and falls back to the id", () => {
    expect(modelName("anthropic/claude-opus-5.5", MODELS)).toBe("Claude Opus 5.5");
    expect(modelName("acme/free", MODELS)).toBe("Free One");
    expect(modelName("gone/model", MODELS)).toBe("gone/model");
    expect(modelName(null, MODELS)).toBe("");
  });

  it("is grouped by provider, the usual ones first", () => {
    expect(groupModels(MODELS, "").map((group) => group.name)).toEqual(["Anthropic", "OpenAI", "Acme", "OpenRouter", "Zeta"]);
  });

  it("is searched by every word typed, in the name or the id", () => {
    expect(groupModels(MODELS, "claude haiku").flatMap((group) => group.models.map((m) => m.id))).toEqual(["anthropic/claude-haiku-5.5"]);
    expect(groupModels(MODELS, "OPENAI/").flatMap((group) => group.models.map((m) => m.id))).toEqual(["openai/gpt-x"]);
    expect(groupModels(MODELS, "haiku gpt")).toEqual([]);
  });
});

describe("the form", () => {
  it("has nothing to save when it holds what is saved", () => {
    expect(changes(draftFrom(SAVED), SAVED)).toEqual({});
    expect(draftFrom(SAVED).budget).toBe("100");
    expect(draftFrom({ ...SAVED, monthly_budget_usd: null }).budget).toBe("");
  });

  it("sends only what differs", () => {
    const draft = { ...draftFrom(SAVED), tone: null, fallback_model: "anthropic/claude-haiku-5.5", budget: "49.50", email_examples: [{ title: "Opener", body: "Hello there." }] };
    expect(changes(draft, SAVED)).toEqual({ tone: null, fallback_model: "anthropic/claude-haiku-5.5", monthly_budget_usd: 49.5, email_examples: [{ title: "Opener", body: "Hello there." }] });
    expect(changes({ ...draftFrom(SAVED), budget: "" }, SAVED)).toEqual({ monthly_budget_usd: null });
    expect(changes({ ...draftFrom(SAVED), budget: "$100.00" }, SAVED)).toEqual({});
  });

  it("reads a budget as typed", () => {
    expect(parseBudget("")).toBeNull();
    expect(parseBudget("  ")).toBeNull();
    expect(parseBudget("100")).toBe(100);
    expect(parseBudget("$1,250.5")).toBe(1250.5);
    for (const bad of ["0", "abc", "-5", "1.234", "10 dollars"]) expect(parseBudget(bad), bad).toBeUndefined();
  });

  it("says what stops it from being saved", () => {
    expect(draftProblem(draftFrom(SAVED), SAVED)).toBeNull();
    expect(draftProblem({ ...draftFrom(SAVED), budget: "lots" }, SAVED)).toMatch(/amount above zero/);
    expect(draftProblem({ ...draftFrom(SAVED), system_prompt: "x".repeat(2001) }, SAVED)).toMatch(/at most 2,000 characters/);
    // A longer prompt that was already saved is not a reason to refuse the rest.
    const long = { ...SAVED, system_prompt: "x".repeat(3000) };
    expect(draftProblem({ ...draftFrom(long), tone: "warm" }, long)).toBeNull();
  });

  it("gives a test the settings on screen, without the budget", () => {
    expect(draftForTest({ ...draftFrom(SAVED), tone: "warm", user_prompt: "" })).toEqual({
      fallback_model: null, tone: "warm", system_prompt: "Be brief.", user_prompt: null, email_examples: [{ title: "Opener", body: "Hello." }], linkedin_examples: [],
    });
  });
});

describe("steps", () => {
  it("are named by what they are and where they come", () => {
    expect(stepName({ step_type: "email", number: 1 })).toBe("Email 1 · opener");
    expect(stepName({ step_type: "email", number: 3 })).toBe("Email 3 · follow-up");
    expect(stepName({ step_type: "message", number: 2 })).toBe("LinkedIn message 2");
    expect(stepName({ step_type: "sales_inmail", number: 1 })).toBe("InMail");
    expect(stepName({ step_type: "sales_inmail", number: 2 })).toBe("InMail 2");
  });
});

describe("the spend", () => {
  it("is compared with the same days of last month", () => {
    const month = { key: "2026-10", spent_usd: 88, requests: 10, previous_usd: 100 as number | null };
    expect(spendChange(month)).toEqual({ label: "−12%", direction: "down" });
    expect(spendChange({ ...month, spent_usd: 130 })).toEqual({ label: "+30%", direction: "up" });
    expect(spendChange({ ...month, spent_usd: 100.2 })).toEqual({ label: "0%", direction: "flat" });
    expect(spendChange({ ...month, previous_usd: null })).toBeNull();
  });

  it("counts replies for classification and generations for writing", () => {
    expect(requestsNote("classification", 1)).toBe("1 reply");
    expect(requestsNote("classification", 2208)).toBe("2,208 replies");
    expect(requestsNote("email_opener", 1)).toBe("1 generation");
    expect(requestsNote("email_opener", 4120)).toBe("4,120 generations");
    expect(requestsNote(null, 3)).toBe("3 requests");
  });

  it("names months and days", () => {
    expect(monthName("2026-10")).toBe("October");
    expect(dayOfMonth("2026-11-01")).toBe("1 November");
    expect(shortDay("2026-10-09")).toBe("09 Oct");
  });

  it("says when the key was last used", () => {
    expect(lastUsed(null, () => "x")).toBe("not used yet");
    expect(lastUsed("2026-10-10 10:00:00", () => "4 min ago")).toBe("last used 4 min ago");
  });
});

describe("the budget", () => {
  const state = (spent: number, budget: number | null) => ({ budget_usd: budget, spent_usd: spent, reached: budget !== null && spent >= budget, month: "2026-10", resets_on: "2026-11-01" });

  it("has nothing to show when none is set", () => {
    expect(budgetView(state(50, null))).toBeNull();
  });

  it("reads calmly while there is room, warns from four fifths, and says when it is used up", () => {
    expect(budgetView(state(25, 100))).toEqual({ tone: "brand", share: 0.25, note: "Steps written by AI wait once it is reached. Starts again 1 November." });
    expect(budgetView(state(85, 100))).toMatchObject({ tone: "warn", share: 0.85, note: expect.stringContaining("85% used") });
    expect(budgetView(state(120, 100))).toEqual({ tone: "bad", share: 1, note: "Used up. Steps written by AI wait until it is raised or 1 November." });
  });
});
