import type { RunResult } from "@cursor/sdk";
import { describe, expect, it } from "vitest";
import { RunBudget } from "../src/agents/client.js";
import {
  readModelConfig,
  resolveConfiguredModel,
} from "../src/agents/models.js";
import { debateTurnPrompt } from "../src/agents/prompts.js";

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
  it("uses the fast default for summary and idea stages", () => {
    expect(
      readModelConfig({
        CURSOR_CLAUDE_MODEL: "claude-flagship",
        CURSOR_OPENAI_MODEL: "openai-flagship",
      }),
    ).toMatchObject({
      summary: "composer-2.5",
      idea: "composer-2.5",
    });
  });

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

  it("atomically reserves concurrent model runs", () => {
    const budget = new RunBudget({ maxRuns: 1, maxTokens: 100 });
    const reservation = budget.reserve(20);
    expect(() => budget.reserve(20)).toThrow(/Run budget exhausted/);
    budget.release(reservation, false);
    expect(budget.snapshot().runs).toBe(0);
  });

  it("conservatively charges timed-out started runs", () => {
    const budget = new RunBudget({ maxRuns: 2, maxTokens: 100 });
    const reservation = budget.reserve(20);
    budget.release(reservation, true);
    expect(budget.snapshot()).toMatchObject({ runs: 1, totalTokens: 20 });
  });
});

describe("debate context compaction", () => {
  it("only includes recent turns", () => {
    const prompt = debateTurnPrompt({
      role: "skeptic",
      model: "test-model",
      idea: { title: "Idea" },
      round: 5,
      history: Array.from({ length: 8 }, (_, index) => ({
        claim: `claim-${index}`,
      })),
    });
    expect(prompt).not.toContain("claim-0");
    expect(prompt).toContain("claim-7");
  });
});
