import { describe, expect, it } from "vitest";
import type { RunResult } from "@cursor/sdk";
import {
  type AgentClient,
  type RunBudget,
} from "../src/agents/client.js";
import { DOMAINS } from "../src/domains.js";
import {
  runDailyPipeline,
  type CheckpointStore,
} from "../src/pipeline/run.js";
import type { ScoredPaper } from "../src/schema/report.js";

const summary = {
  oneLiner: "该论文给出一项可复现的实证研究。",
  motivation: ["现有方法的效率和效果仍有改进空间。"],
  method: ["作者提出结构化方法并与强基线比较。"],
  experimentSetup: ["实验覆盖公开数据集和多个对照方法。"],
  results: ["主要指标优于所报告的基线结果。"],
  trainingResources: ["论文未披露完整训练资源。"],
  limitations: ["仍需在更大规模任务上验证。"],
  significance: "该结果为后续系统设计提供了实证依据。",
};

function result(id: number): RunResult {
  return {
    id: `run-${id}`,
    status: "finished",
    result: "{}",
    usage: {
      inputTokens: 10,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 20,
    },
  };
}

function clientFactory(
  attemptsPerPaper: number,
  onAttempt: () => void,
): (budget: RunBudget, onUsage: () => Promise<void>) => AgentClient {
  return (budget, onUsage) =>
    ({
      promptJson: async () => {
        for (let attempt = 0; attempt < attemptsPerPaper; attempt += 1) {
          onAttempt();
          const reservation = budget.reserve(1);
          budget.complete(reservation, result(budget.status().consumedRuns));
          await onUsage();
        }
        return summary;
      },
    }) as unknown as AgentClient;
}

const papers: ScoredPaper[] = DOMAINS.flatMap((domain, domainIndex) =>
  Array.from({ length: 3 }, (_, paperIndex) => {
    const sequence = domainIndex * 3 + paperIndex + 1;
    const id = `2608.${String(sequence).padStart(5, "0")}`;
    return {
      paper: {
        arxivId: id,
        baseArxivId: id,
        title: `${domain.name} Paper ${paperIndex + 1}`,
        abstract: "A paper selected for deterministic pipeline testing.",
        authors: [{ name: "Test Author" }],
        categories: ["cs.AI"],
        primaryCategory: "cs.AI",
        announcedOn: "2026-08-05",
        releaseDate: "2026-08-05",
        announcementType: "new" as const,
        source: "arxiv-rss" as const,
        releaseSourceUrl: "https://export.arxiv.org/rss/cs.AI",
        absUrl: `https://arxiv.org/abs/${id}`,
        pdfUrl: `https://arxiv.org/pdf/${id}`,
      },
      score: {
        domainId: domain.id,
        total: 10,
        breakdown: {
          category: 1,
          titleKeyword: 1,
          abstractKeyword: 1,
          phrase: 1,
          novelty: 1,
          experimentalRigor: 1,
          resultEvidence: 1,
          resourceDisclosure: 1,
          negative: 0,
          recency: 1,
        },
        matchedKeywords: ["test"],
        matchedCategories: ["cs.AI"],
        explanation: ["测试固定入选。"],
        algorithmVersion: "test",
      },
    };
  }),
);

describe("summary-only daily pipeline", () => {
  it("makes exactly one summary call per nine papers and emits no ideas", async () => {
    let calls = 0;
    let saved: unknown;
    const checkpointStore: CheckpointStore = {
      load: async () => undefined,
      save: async (_date, checkpoint) => {
        saved = checkpoint;
      },
    };
    const report = await runDailyPipeline({
      date: "2026-08-05",
      domains: DOMAINS,
      papers,
      apiKey: "test",
      resolvedSummaryModel: { id: "summary-test" },
      clientFactory: clientFactory(1, () => {
        calls += 1;
      }),
      checkpointStore,
      now: () => new Date("2026-08-05T12:00:00.000Z"),
    });

    expect(calls).toBe(9);
    expect(report.papers).toHaveLength(9);
    expect(report.domainResearch).toEqual([]);
    expect(report.papers.every((paper) => paper.ideas.length === 0)).toBe(true);
    expect(report.papers.every((paper) => paper.refinements.length === 0)).toBe(true);
    expect(saved).toBeDefined();
  });

  it("allows all nine papers one Chinese correction attempt", async () => {
    let calls = 0;
    const report = await runDailyPipeline({
      date: "2026-08-06",
      domains: DOMAINS,
      papers,
      apiKey: "test",
      resolvedSummaryModel: { id: "summary-test" },
      clientFactory: clientFactory(2, () => {
        calls += 1;
      }),
      checkpointStore: {
        load: async () => undefined,
        save: async () => undefined,
      },
      now: () => new Date("2026-08-06T12:00:00.000Z"),
    });
    expect(calls).toBe(18);
    expect(report.papers).toHaveLength(9);
    expect(report.provenance[0]?.notes.join(" ")).toContain("18 次调用");
  });

  it("restores completed paper IDs without inheriting suspended reservations", async () => {
    let checkpoint: Parameters<CheckpointStore["save"]>[1] | undefined;
    const store: CheckpointStore = {
      load: async () => checkpoint,
      save: async (_date, value) => {
        checkpoint = structuredClone(value);
      },
    };
    let firstCalls = 0;
    await expect(
      runDailyPipeline({
        date: "2026-08-07",
        domains: [DOMAINS[0]!],
        papers: papers.slice(0, 3),
        apiKey: "test",
        resolvedSummaryModel: { id: "summary-test" },
        checkpointStore: store,
        clientFactory: (budget, onUsage) =>
          ({
            promptJson: async () => {
              firstCalls += 1;
              if (firstCalls === 1) {
                const reservation = budget.reserve(1);
                budget.complete(reservation, result(1));
                await onUsage();
                return summary;
              }
              budget.reserve(1);
              await onUsage();
              throw new Error("simulated cancellation");
            },
          }) as unknown as AgentClient,
      }),
    ).rejects.toThrow("simulated cancellation");
    expect(checkpoint?.budget.runs).toBe(1);
    expect(Object.keys(checkpoint?.domains.agent?.summaries ?? {})).toHaveLength(1);

    let resumedCalls = 0;
    const report = await runDailyPipeline({
      date: "2026-08-07",
      domains: [DOMAINS[0]!],
      papers: papers.slice(0, 3),
      apiKey: "test",
      resolvedSummaryModel: { id: "summary-test" },
      checkpointStore: store,
      clientFactory: clientFactory(1, () => {
        resumedCalls += 1;
      }),
    });
    expect(resumedCalls).toBe(2);
    expect(report.papers).toHaveLength(3);
    expect(checkpoint?.budget.runs).toBe(3);
  });
});
