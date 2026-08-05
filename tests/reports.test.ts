import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { normalizeReport } from "../src/lib/reports.js";

const idea = (domainId: string) => ({
  domainId,
  idea: {
    title: `${domainId} final idea`,
    hypothesis: "A testable hypothesis.",
    method: ["A bounded method."],
    evaluation: ["A pre-registered evaluation."],
    expectedContribution: "A useful result.",
    resourceAssessment: "One GPU-day.",
    trainingResources: "One GPU.",
  },
  refinements: [{ originalIdeaTitle: "draft", revisedHypothesis: "revised", rationale: "safer" }],
  debate: {
    turns: [{ model: "flagship", role: "advocate", claim: "feasible" }],
    consensus: "approved",
  },
  references: [{ title: "Reference", url: "https://arxiv.org/abs/2608.00001" }],
  debateRounds: 3,
});

describe("report idea visibility", () => {
  it("normalizes one complete final idea for each domain", () => {
    const report = normalizeReport("2026-08-04.json", {
      reportDate: "2026-08-04",
      domains: [
        { id: "agent", name: "AI Agents" },
        { id: "embodied-vla", name: "Embodied VLA" },
        { id: "architecture-design", name: "Architecture Design" },
      ],
      papers: [],
      domainResearch: [
        idea("agent"),
        idea("embodied-vla"),
        idea("architecture-design"),
      ],
    });

    expect(report.domainResearch).toHaveLength(3);
    expect(report.domainResearch.every((entry) =>
      entry.title && entry.hypothesis && entry.method.length &&
      entry.evaluation.length && entry.resources.length &&
      entry.refinements.length && entry.debate.length && entry.references.length,
    )).toBe(true);
  });

  it("keeps historical ideas on report pages but not the homepage", async () => {
    const [home, report] = await Promise.all([
      readFile(new URL("../src/pages/index.astro", import.meta.url), "utf8"),
      readFile(new URL("../src/pages/reports/[date].astro", import.meta.url), "utf8"),
    ]);

    expect(home).not.toContain("IdeaCard");
    expect(home).not.toContain("domainResearch.map");
    expect(report).toContain('id="research-ideas"');
    expect(report).toContain("IdeaCard");
  });

  it("normalizes and exposes the hard-exclusion audit without paper details", () => {
    const report = normalizeReport("2026-08-05.json", {
      reportDate: "2026-08-05",
      selectionPolicy: {
        hardExcludedTopicsEnabled: true,
      },
      exclusionSummary: {
        totalExcluded: 4,
        byReason: {
          ATTACK_ADVERSARIAL: 2,
          AI_SAFETY_ALIGNMENT: 2,
        },
      },
      papers: [],
      domainResearch: [],
    });

    expect(report.selectionPolicy).toContain("评分与配额前");
    expect(report.exclusionSummary).toContain("硬排除 4 篇");
    expect(report.exclusionSummary).toContain("ATTACK_ADVERSARIAL=2");
  });

  it("normalizes legacy string summaries into five bullet sections", () => {
    const report = normalizeReport("2026-08-04.json", {
      reportDate: "2026-08-04",
      papers: [
        {
          paper: { title: "Legacy paper", authors: ["Author"] },
          summary: {
            oneLiner: "Legacy summary",
            motivation: "Legacy motivation",
            method: "Legacy method",
            experimentSetup: "Legacy setup",
            results: ["Legacy result"],
            trainingResources: "Legacy resources",
          },
        },
      ],
    });
    expect(report.papers[0]).toMatchObject({
      motivation: ["Legacy motivation"],
      method: ["Legacy method"],
      experimentSetup: ["Legacy setup"],
      results: ["Legacy result"],
      trainingResources: ["Legacy resources"],
    });
  });

  it("renders the same five paper sections through the shared card", async () => {
    const card = await readFile(
      new URL("../src/components/PaperCard.astro", import.meta.url),
      "utf8",
    );
    for (const heading of [
      "研究动机",
      "核心方法",
      "实验设置",
      "主要结果",
      "训练 / 计算资源",
    ]) {
      expect(card).toContain(heading);
    }
  });
});
