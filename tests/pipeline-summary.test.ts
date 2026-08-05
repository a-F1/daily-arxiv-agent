import { describe, expect, it } from "vitest";
import type { AgentClient } from "../src/agents/client.js";
import { DOMAINS } from "../src/domains.js";
import {
  runDailyPipeline,
  type CheckpointStore,
} from "../src/pipeline/run.js";
import type { ScoredPaper } from "../src/schema/report.js";

describe("summary-only daily pipeline", () => {
  it("makes exactly one summary call per nine papers and emits no ideas", async () => {
    let calls = 0;
    const client = {
      promptJson: async () => {
        calls += 1;
        return {
          oneLiner: "该论文给出一项可复现的实证研究。",
          motivation: ["现有方法的效率和效果仍有改进空间。"],
          method: ["作者提出结构化方法并与强基线比较。"],
          experimentSetup: ["实验覆盖公开数据集和多个对照方法。"],
          results: ["主要指标优于所报告的基线结果。"],
          trainingResources: ["论文未披露完整训练资源。"],
          limitations: ["仍需在更大规模任务上验证。"],
          significance: "该结果为后续系统设计提供了实证依据。",
        };
      },
    } as unknown as AgentClient;
    let saved: unknown;
    const checkpointStore: CheckpointStore = {
      load: async () => undefined,
      save: async (_date, checkpoint) => {
        saved = checkpoint;
      },
    };
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

    const report = await runDailyPipeline({
      date: "2026-08-05",
      domains: DOMAINS,
      papers,
      apiKey: "test",
      resolvedSummaryModel: { id: "summary-test" },
      client,
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
});
