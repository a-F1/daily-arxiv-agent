import type { RunResult } from "@cursor/sdk";
import { describe, expect, it } from "vitest";
import { RunBudget } from "../src/agents/client.js";
import { resolveConfiguredModel } from "../src/agents/models.js";

const models = [
  {
    id: "claude-opus-account-id",
    displayName: "Claude Opus",
    aliases: ["claude-flagship"],
  },
  {
    id: "gpt-account-id",
    displayName: "OpenAI GPT",
    aliases: ["openai-flagship"],
  },
];

describe("flagship model resolution", () => {
  it("resolves an exact account alias to its canonical ID", () => {
    expect(
      resolveConfiguredModel("claude", "claude-flagship", models),
    ).toEqual({ id: "claude-opus-account-id" });
  });

  it("fails instead of selecting a nearby model", () => {
    expect(() =>
      resolveConfiguredModel("openai", "missing-openai-model", models),
    ).toThrow(/not available/);
  });

  it("rejects a configured model from the wrong provider", () => {
    expect(() =>
      resolveConfiguredModel("openai", "claude-flagship", models),
    ).toThrow(/not a model from provider openai/);
  });
});

describe("run budget", () => {
  it("tracks runs, tokens, and estimated cost", () => {
    const budget = new RunBudget({
      maxRuns: 2,
      maxTokens: 100,
      maxEstimatedCostCents: 10,
      estimateCostCents: () => 3,
    });
    budget.record({
      id: "run-1",
      status: "finished",
      result: "{}",
      usage: {
        inputTokens: 30,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 40,
      },
    } satisfies RunResult);

    expect(budget.snapshot()).toEqual({
      runs: 1,
      totalTokens: 40,
      estimatedCostCents: 3,
    });
  });

  it("stops before starting a run beyond the run limit", () => {
    const budget = new RunBudget(
      { maxRuns: 1, maxTokens: 100 },
      { runs: 1 },
    );
    expect(() => budget.assertCanRun()).toThrow(/Run budget exhausted/);
  });
});
