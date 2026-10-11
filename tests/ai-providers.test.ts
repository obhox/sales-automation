// Which service a model id names, and whose key answers it. The id convention is the whole
// of this design, so it is pinned here: a stored id that changed meaning would silently
// send a workspace's traffic — and its bill — somewhere it did not choose.
import { describe, expect, it } from "vitest";

process.env.NEXTAUTH_SECRET ||= "test-secret-for-ai-provider-tests";

import { getDb } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { AiUnavailable, aiConnected, aiKey, anyAiConnected, providerModel, providerOf, resolveModel } from "@/lib/ai/providers";

describe("providerOf", () => {
  it("keeps every id already stored on OpenRouter, where it was", () => {
    // Existing workspaces have these saved. Any of them changing meaning would move a
    // workspace's traffic to a provider it never chose.
    for (const id of ["google/gemini-2.5-pro", "anthropic/claude-sonnet-5-5", "openai/gpt-5", "meta-llama/llama-4"]) {
      expect(providerOf(id), id).toBe("openrouter");
    }
  });

  it("reads the gemini/ prefix as the Gemini API directly", () => {
    expect(providerOf("gemini/gemini-2.5-pro")).toBe("gemini");
    expect(providerOf("GEMINI/gemini-2.5-flash")).toBe("gemini");
    expect(providerOf("  gemini/gemini-2.5-flash  ")).toBe("gemini");
  });

  it("tells google/ from gemini/, which is the whole point of the prefix", () => {
    // Both are Gemini models. One is billed by OpenRouter, the other by Google.
    expect(providerOf("google/gemini-2.5-pro")).toBe("openrouter");
    expect(providerOf("gemini/gemini-2.5-pro")).toBe("gemini");
  });

  it("sends anything unprefixed to OpenRouter rather than guessing", () => {
    expect(providerOf("gemini-2.5-pro")).toBe("openrouter");
  });
});

describe("providerModel", () => {
  it("hands OpenRouter the id whole, because the prefix is part of the name it knows", () => {
    expect(providerModel("google/gemini-2.5-pro")).toBe("google/gemini-2.5-pro");
  });

  it("strips this app's routing prefix before calling a service directly", () => {
    expect(providerModel("gemini/gemini-2.5-pro")).toBe("gemini-2.5-pro");
    expect(providerModel("gemini/gemini-2.5-flash-lite")).toBe("gemini-2.5-flash-lite");
  });
});

describe("resolveModel", () => {
  const ws = "ws-aiprov-0001";
  const db = getDb();
  db.prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, "AI Prov", "ai-prov-ws");
  db.prepare("INSERT INTO integrations (workspace_id, key, api_key) VALUES (?, 'openrouter', ?)").run(ws, encryptSecret("sk-or-stored"));

  it("finds the key for the service the model belongs to", () => {
    expect(resolveModel(db, ws, "google/gemini-2.5-pro")).toEqual({
      provider: "openrouter", apiKey: "sk-or-stored", model: "google/gemini-2.5-pro", id: "google/gemini-2.5-pro",
    });
  });

  it("says to add the Gemini key, not the OpenRouter one, for a direct model", () => {
    // The old code had one message for one provider. Naming the wrong one sends someone to
    // check a key that was never the problem.
    try {
      resolveModel(db, ws, "gemini/gemini-2.5-pro");
      throw new Error("should have refused");
    } catch (error) {
      expect(error).toBeInstanceOf(AiUnavailable);
      expect((error as AiUnavailable).provider).toBe("gemini");
      expect((error as AiUnavailable).message).toContain("Gemini");
    }
  });

  it("resolves a direct model once its own key is stored, without touching the other", () => {
    db.prepare("INSERT INTO integrations (workspace_id, key, api_key) VALUES (?, 'gemini', ?)").run(ws, encryptSecret("AIza-stored"));
    expect(resolveModel(db, ws, "gemini/gemini-2.5-flash")).toMatchObject({ provider: "gemini", apiKey: "AIza-stored", model: "gemini-2.5-flash" });
    expect(resolveModel(db, ws, "google/gemini-2.5-pro")).toMatchObject({ provider: "openrouter", apiKey: "sk-or-stored" });
  });

  it("asks for a model to be chosen when none is", () => {
    expect(() => resolveModel(db, ws, "   ")).toThrow(AiUnavailable);
    expect(() => resolveModel(db, ws, "")).toThrow(/Choose a default model/);
  });
});

describe("what a workspace has connected", () => {
  it("reports each provider, and whether any is usable at all", () => {
    const db = getDb();
    const ws = "ws-aiprov-0002";
    db.prepare("INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)").run(ws, "AI Prov 2", "ai-prov-ws-2");
    expect(aiConnected(db, ws)).toEqual({ openrouter: false, gemini: false });
    expect(anyAiConnected(db, ws)).toBe(false);

    db.prepare("INSERT INTO integrations (workspace_id, key, api_key) VALUES (?, 'gemini', ?)").run(ws, encryptSecret("AIza-only"));
    expect(aiConnected(db, ws)).toEqual({ openrouter: false, gemini: true });
    // Gemini alone is enough to use AI: the old check was for OpenRouter specifically.
    expect(anyAiConnected(db, ws)).toBe(true);
    expect(aiKey(db, ws, "gemini")).toBe("AIza-only");
    expect(aiKey(db, ws, "openrouter")).toBeNull();
  });
});
