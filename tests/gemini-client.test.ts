// The Gemini client, and what a call cost. Gemini is never reached: fetch is replaced for
// the whole file and a call nobody scripted fails the test.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GeminiDeclined, answerText, askGemini, geminiModels } from "@/lib/ai/gemini";
import { GEMINI_RATES, LONG_PROMPT_TOKENS, geminiCost, rateFor } from "@/lib/ai/gemini-prices";

type Reply = { status?: number; body?: unknown; throws?: true };
const net = { calls: [] as { url: string; key: string | null; body: Record<string, unknown> | null }[], replies: [] as Reply[] };

vi.stubGlobal("fetch", async (input: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
  const url = String(input);
  if (!url.startsWith("https://generativelanguage.googleapis.com")) throw new Error(`A test reached the network: ${url}`);
  net.calls.push({ url, key: init?.headers?.["x-goog-api-key"] ?? null, body: init?.body ? JSON.parse(init.body) : null });
  const reply = net.replies.shift();
  if (!reply) throw new Error(`Gemini was asked something no test scripted: ${url}`);
  if (reply.throws) throw new Error("socket hang up");
  const status = reply.status ?? 200;
  return { ok: status >= 200 && status < 300, status, json: async () => reply.body ?? {} };
});

const ok = (text: string, usage: Record<string, unknown> = {}) => ({
  body: {
    candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 200, ...usage },
    modelVersion: "gemini-3.8-flash",
  },
});

beforeEach(() => { net.calls = []; net.replies = []; });

describe("the price table", () => {
  it("knows the price changes on a date, not just what it is today", () => {
    // The Flash tier doubles on 2027-01-01, already announced. A table of single numbers
    // would be right today and silently wrong in the new year.
    expect(rateFor("gemini-3.8-flash", new Date("2026-12-31T23:00:00Z"))).toMatchObject({ input: 0.75, output: 3.75 });
    expect(rateFor("gemini-3.8-flash", new Date("2027-01-01T00:00:00Z"))).toMatchObject({ input: 1.5, output: 7.5 });
  });

  it("does not price a model it has never heard of", () => {
    // An honest gap under-counts a budget; an invented number makes it wrong, which nobody
    // goes looking for.
    expect(rateFor("gemini-9-something")).toBeNull();
    expect(geminiCost("gemini-9-something", { prompt_tokens: 1000, output_tokens: 500 })).toBeNull();
  });

  it("lists every rate oldest first, so the latest one that has started wins", () => {
    for (const [model, periods] of Object.entries(GEMINI_RATES)) {
      const froms = periods.map((p) => p.from);
      expect([...froms].sort(), model).toEqual(froms);
    }
  });
});

describe("what a call cost", () => {
  it("bills thinking tokens as output, added to the visible answer's", () => {
    // They are additive to candidatesTokenCount, not inside it, and every Gemini 3 model
    // thinks by default — so ignoring them under-bills every single call.
    const without = geminiCost("gemini-3.8-flash", { prompt_tokens: 1_000_000, output_tokens: 1_000_000 }, new Date("2026-10-11"));
    const with_ = geminiCost("gemini-3.8-flash", { prompt_tokens: 1_000_000, output_tokens: 1_000_000, thinking_tokens: 1_000_000 }, new Date("2026-10-11"));
    expect(without).toBeCloseTo(0.75 + 3.75, 6);
    expect(with_).toBeCloseTo(0.75 + 3.75 + 3.75, 6);
  });

  it("steps the Pro rate on the size of the PROMPT, including its output rate", () => {
    const at = new Date("2026-10-11");
    // Under the threshold. Note a 1M-token PROMPT would already be over it — the step is on
    // the prompt's size, not the answer's, which is the part that catches people out.
    const short = geminiCost("gemini-3.1-pro-preview", { prompt_tokens: 100_000, output_tokens: 1_000_000 }, at);
    // A prompt over the threshold raises the output rate too, which is the surprising part.
    const long = geminiCost("gemini-3.1-pro-preview", { prompt_tokens: LONG_PROMPT_TOKENS + 1, output_tokens: 1_000_000 }, at);
    expect(short).toBeCloseTo(100_000 / 1e6 * 2.0 + 12.0, 6);
    expect(long).toBeCloseTo((LONG_PROMPT_TOKENS + 1) / 1e6 * 4.0 + 18.0, 5);
  });

  it("halves the bill on the Flex and Batch tiers, keyed on what the response says", () => {
    const base = { prompt_tokens: 1_000_000, output_tokens: 1_000_000 };
    const at = new Date("2026-10-11");
    expect(geminiCost("gemini-3.8-flash", { ...base, service_tier: "flex" }, at)).toBeCloseTo((0.75 + 3.75) / 2, 6);
    expect(geminiCost("gemini-3.8-flash", { ...base, service_tier: "batch" }, at)).toBeCloseTo((0.75 + 3.75) / 2, 6);
    expect(geminiCost("gemini-3.8-flash", { ...base, service_tier: "standard" }, at)).toBeCloseTo(0.75 + 3.75, 6);
    // An unrecognised tier is charged as Standard rather than as free.
    expect(geminiCost("gemini-3.8-flash", { ...base, service_tier: "something-new" }, at)).toBeCloseTo(0.75 + 3.75, 6);
  });

  it("charges cached input at a tenth, and does not charge it twice", () => {
    const at = new Date("2026-10-11");
    const cost = geminiCost("gemini-3.8-flash", { prompt_tokens: 1_000_000, cached_tokens: 500_000, output_tokens: 0 }, at);
    expect(cost).toBeCloseTo(0.5 * 0.75 + 0.5 * 0.075, 6);
  });
});

describe("answerText", () => {
  it("leaves the model's own reasoning out of the answer", () => {
    // A thought summary arrives as a text part beside the answer. Joining every part feeds
    // the reasoning into JSON.parse along with the JSON.
    expect(answerText([{ text: "Let me think about this", thought: true }, { text: '{"hook":"x"}' }])).toBe('{"hook":"x"}');
  });
});

describe("askGemini", () => {
  it("asks for JSON by mime type, in the place the current API wants it", async () => {
    net.replies.push(ok('{"ok":true}'));
    await askGemini("AIza-test", "gemini-3.8-flash", { system: "S", user: "U", temperature: 0.4 });

    expect(net.calls[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
    expect(net.calls[0].key).toBe("AIza-test");
    const body = net.calls[0].body as Record<string, Record<string, unknown>>;
    expect(body.generationConfig.responseFormat).toEqual({ text: { mimeType: "application/json" } });
    expect(body.system_instruction).toEqual({ parts: [{ text: "S" }] });
    expect(body.generationConfig.temperature).toBe(0.4);
  });

  it("turns thinking down without turning it off, which this model rejects", async () => {
    net.replies.push(ok('{"ok":true}'));
    await askGemini("AIza-test", "gemini-3.8-flash", { system: "S", user: "U" });
    const config = (net.calls[0].body as { generationConfig: { thinkingConfig: { thinkingLevel: string } } }).generationConfig;
    expect(config.thinkingConfig.thinkingLevel).toBe("low");
    expect(config.thinkingConfig.thinkingLevel).not.toBe("minimal");
  });

  it("reports tokens as they are billed, so the tokens and the cost agree", async () => {
    net.replies.push(ok('{"ok":true}', { promptTokenCount: 1000, candidatesTokenCount: 200, thoughtsTokenCount: 800 }));
    const answer = await askGemini("AIza-test", "gemini-3.8-flash", { system: "S", user: "U" }, new Date("2026-10-11"));
    expect(answer.input_tokens).toBe(1000);
    expect(answer.output_tokens).toBe(1000); // 200 written + 800 thought, which is what is charged
    expect(answer.cost_usd).toBeCloseTo(1000 / 1e6 * 0.75 + 1000 / 1e6 * 3.75, 6);
  });

  it("prices the model that answered, not the one that was asked for", async () => {
    // An alias resolves to a model that may be on a different rate.
    net.replies.push({ body: { ...ok('{"ok":true}').body, modelVersion: "gemini-3.5-flash-lite" } });
    const answer = await askGemini("AIza-test", "gemini-flash-newest", { system: "S", user: "U" }, new Date("2026-10-11"));
    expect(answer.cost_usd).toBeCloseTo(1000 / 1e6 * 0.3 + 200 / 1e6 * 2.5, 6);
  });

  it("knows a blocked prompt from a failure, though both answer 200", async () => {
    net.replies.push({ body: { promptFeedback: { blockReason: "SAFETY" } } });
    await expect(askGemini("AIza-test", "gemini-3.8-flash", { system: "S", user: "U" }))
      .rejects.toMatchObject({ name: "GeminiDeclined", reason: "SAFETY" });
  });

  it("knows a refusal mid-answer, where the parts are simply absent", async () => {
    net.replies.push({ body: { candidates: [{ finishReason: "PROHIBITED_CONTENT", finishMessage: "no" }] } });
    await expect(askGemini("AIza-test", "gemini-3.8-flash", { system: "S", user: "U" })).rejects.toBeInstanceOf(GeminiDeclined);
  });

  it("says so when the room ran out before an answer was written", async () => {
    net.replies.push({ body: { candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [] } }] } });
    await expect(askGemini("AIza-test", "gemini-3.8-flash", { system: "S", user: "U" }))
      .rejects.toMatchObject({ reason: "MAX_TOKENS" });
  });

  it("reads an invalid key out of a 400, which is not what a 400 usually means", async () => {
    // Gemini answers 400 for a bad key as well as for a malformed body. Conflating them
    // makes a missing key look like a bug in this code.
    net.replies.push({ status: 400, body: { error: { code: 400, message: "API key not valid", status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] } } });
    await expect(askGemini("AIza-bad", "gemini-3.8-flash", { system: "S", user: "U" }))
      .rejects.toMatchObject({ message: expect.stringContaining("API key was not accepted") });
  });

  it("does not mistake a malformed request for a bad key", async () => {
    net.replies.push({ status: 400, body: { error: { code: 400, message: "Invalid JSON payload", status: "INVALID_ARGUMENT" } } });
    await expect(askGemini("AIza-test", "gemini-3.8-flash", { system: "S", user: "U" }))
      .rejects.toMatchObject({ message: expect.stringContaining("Invalid JSON payload") });
  });

  it("reports no answer at all as status 0", async () => {
    net.replies.push({ throws: true });
    await expect(askGemini("AIza-test", "gemini-3.8-flash", { system: "S", user: "U" })).rejects.toMatchObject({ status: 0 });
  });
});

describe("geminiModels", () => {
  it("prefixes them as this app routes them, and leaves the hot-swapped aliases out", async () => {
    net.replies.push({ body: { models: [
      { name: "models/gemini-3.8-flash", displayName: "Gemini 3.8 Flash", inputTokenLimit: 1048576, supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-flash-latest", displayName: "Latest", supportedGenerationMethods: ["generateContent"] },
      { name: "models/text-embedding-004", displayName: "Embeddings", supportedGenerationMethods: ["embedContent"] },
    ] } });
    const models = await geminiModels("AIza-test");
    // A `-latest` alias is hot-swapped with two weeks' notice; for a feature that prices
    // what it spends, the model changing under its own name would change the bill.
    expect(models).toEqual([{ id: "gemini/gemini-3.8-flash", name: "Gemini 3.8 Flash", context: 1048576 }]);
  });
});
