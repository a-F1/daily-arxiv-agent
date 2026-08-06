import type { RunResult } from "@cursor/sdk";
import { describe, expect, it } from "vitest";
import {
  RunBudget,
  structuredCorrectionPrompt,
} from "../src/agents/client.js";
import {
  readSummaryModelConfig,
  resolveSummaryModel,
} from "../src/agents/models.js";
import { summaryPrompt } from "../src/agents/prompts.js";

const models = [
  {
    id: "composer-account-id",
    displayName: "Composer 2.5",
    aliases: ["composer-2.5"],
  },
];

describe("summary model resolution", () => {
  it("uses the fast summary default", () => {
    expect(readSummaryModelConfig({})).toBe("composer-2.5");
  });

  it("resolves an exact account alias to its canonical ID", () => {
    expect(
      resolveSummaryModel({
        apiKey: "test",
        configured: "composer-2.5",
        listModels: async () => models,
      }),
    ).resolves.toEqual({ id: "composer-account-id" });
  });

  it("fails instead of selecting a nearby model", () => {
    expect(
      resolveSummaryModel({
        apiKey: "test",
        configured: "missing-model",
        listModels: async () => models,
      }),
    ).rejects.toThrow(/not available/);
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
    expect(budget.snapshot()).toMatchObject({ runs: 0, totalTokens: 0 });
    expect(budget.status()).toMatchObject({
      failedStartedRuns: 1,
      consumedRuns: 1,
    });
  });

  it("allows eighteen completed summary attempts and blocks the nineteenth", () => {
    const budget = new RunBudget({ maxRuns: 18, maxTokens: 1_000 });
    for (let index = 0; index < 18; index += 1) {
      const reservation = budget.reserve(1);
      budget.complete(reservation, {
        id: `run-${index}`,
        status: "finished",
        result: "{}",
      });
    }
    expect(budget.snapshot().runs).toBe(18);
    expect(() => budget.reserve(1)).toThrow(/18 runs/);
  });

  it("counts concurrent reservations atomically without persisting them", () => {
    const budget = new RunBudget({ maxRuns: 3, maxTokens: 100 });
    budget.reserve(10);
    budget.reserve(10);
    budget.reserve(10);
    expect(budget.snapshot().runs).toBe(0);
    expect(budget.status()).toMatchObject({
      reservedRuns: 3,
      consumedRuns: 3,
    });
    expect(() => budget.reserve(10)).toThrow(/3 runs/);
  });
});

describe("simplified Chinese output instructions", () => {
  it("requires five Chinese bullet-array sections", () => {
    const prompt = summaryPrompt({ title: "Original English title" });
    expect(prompt).toContain("所有叙述性字符串必须使用简体中文");
    expect(prompt).toContain("原始论文标题、作者名、模型名");
    expect(prompt).toContain('"motivation":string[]');
    expect(prompt).toContain('"trainingResources":string[]');
  });

  it("builds one corrective retry that repeats the Chinese requirement", () => {
    const correction = structuredCorrectionPrompt("原始任务", "language error");
    expect(correction).toContain("原始任务");
    expect(correction).toContain("简体中文校验");
    expect(correction).toContain("字段名和枚举值保持不变");
  });
});
