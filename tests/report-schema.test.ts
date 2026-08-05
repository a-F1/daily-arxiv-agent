import { describe, expect, it } from "vitest";
import {
  ChineseDebateTurnSchema,
  ChinesePaperSummarySchema,
  ChineseRefinementSchema,
  ChineseResearchIdeaSchema,
  PaperSummarySchema,
  ResearchIdeaSchema,
  RefinementSchema,
  isSimplifiedChineseNarrative,
} from "../src/schema/report.js";

describe("research output schemas", () => {
  it("requires the requested five-part paper summary", () => {
    const summary = PaperSummarySchema.parse({
      oneLiner: "A concise contribution.",
      motivation: "Why the problem matters.",
      method: "How the method works.",
      experimentSetup: "Datasets, baselines, and metrics.",
      results: ["Improves success rate from 40% to 55%."],
      trainingResources: "4 H100 GPUs for 3 days.",
      limitations: ["Only evaluated in simulation."],
      significance: "Makes the comparison reproducible.",
    });
    expect(summary.results).toHaveLength(1);
  });

  it("captures impact, novelty, and the 8-H100 feasibility decision", () => {
    const idea = ResearchIdeaSchema.parse({
      title: "Budgeted action-token adaptation",
      hypothesis: "A small adapter can improve long-horizon control.",
      motivation: "Full VLA retraining is too expensive.",
      method: ["Freeze the backbone", "Train an action adapter"],
      evaluation: ["Compare against full fine-tuning"],
      expectedContribution: "A compute-efficient adaptation recipe.",
      impactAssessment: "Useful to small robotics labs.",
      noveltyAssessment: "Differs from prior adapters by action-token routing.",
      resourceAssessment: "Fits one 8×H100 node for under seven days.",
      trainingResources: "8 H100 GPUs for 5 days.",
      scores: { impact: 4, novelty: 4, feasibility: 5 },
      feasible: true,
      risks: ["May not transfer to unseen embodiments."],
    });
    expect(idea.feasible).toBe(true);
  });

  it("does not allow an unscored refinement verdict", () => {
    expect(() =>
      RefinementSchema.parse({
        round: 1,
        originalIdeaTitle: "Idea",
        critiquesAddressed: ["Novelty"],
        revisedHypothesis: "Revised",
        revisedMethod: ["Method"],
        decision: "accept",
        rationale: "Looks good",
      }),
    ).toThrow();
  });
});

describe("simplified Chinese narrative schemas", () => {
  it("distinguishes Chinese report output from English paper source text", () => {
    expect(isSimplifiedChineseNarrative("该方法在三个基准上显著提升准确率。")).toBe(true);
    expect(isSimplifiedChineseNarrative("The method improves accuracy on three benchmarks.")).toBe(false);
    expect(isSimplifiedChineseNarrative("該方法使用繁體中文描述研究結果。")).toBe(false);
  });

  it("requires Chinese for summary and idea narrative fields", () => {
    const summary = {
      oneLiner: "该论文提出一种可复现的新方法。",
      motivation: "现有系统的推理成本过高。",
      method: "该方法使用分层缓存减少重复计算。",
      experimentSetup: "实验覆盖三个数据集和四个基线。",
      results: ["准确率提高五个百分点。"],
      trainingResources: "论文未披露训练资源。",
      limitations: ["尚未验证更大规模的数据集。"],
      significance: "该结果为低成本部署提供依据。",
    };
    expect(ChinesePaperSummarySchema.safeParse(summary).success).toBe(true);
    expect(
      ChinesePaperSummarySchema.safeParse({
        ...summary,
        motivation: "Existing systems are too expensive to run.",
      }).success,
    ).toBe(false);

    const idea = {
      title: "面向长程任务的预算化记忆路由",
      hypothesis: "预算化路由能够减少无效检索并保持任务成功率。",
      motivation: "现有记忆系统会重复读取低价值内容。",
      method: ["冻结主干模型并训练轻量路由器。"],
      evaluation: ["比较任务成功率、延迟和显存占用。"],
      expectedContribution: "形成可复现的低成本记忆路由方案。",
      impactAssessment: "该方案可帮助资源有限的研究团队。",
      noveltyAssessment: "创新点是按任务阶段动态分配检索预算。",
      resourceAssessment: "核心实验可在两张 H100 上完成。",
      trainingResources: "预计使用两张 H100 训练三天。",
      scores: { impact: 4, novelty: 4, feasibility: 5 },
      feasible: true,
      risks: ["路由器可能无法迁移到未见任务。"],
    };
    expect(ChineseResearchIdeaSchema.safeParse(idea).success).toBe(true);
    expect(
      ChineseResearchIdeaSchema.safeParse({
        ...idea,
        risks: ["The router may not transfer to unseen tasks."],
      }).success,
    ).toBe(false);
  });

  it("requires Chinese refinement and debate arguments", () => {
    expect(ChineseRefinementSchema.safeParse({
      round: 1,
      originalIdeaTitle: "预算化记忆路由方案",
      critiquesAddressed: ["补充了强基线和失败判据。"],
      revisedHypothesis: "动态预算应在相同成本下提高成功率。",
      revisedMethod: ["加入固定预算和随机路由对照组。"],
      decision: "revise",
      rationale: "仍需验证跨数据集迁移能力。",
      impactScore: 4,
      noveltyScore: 4,
      feasibilityScore: 5,
    }).success).toBe(true);
    expect(ChineseDebateTurnSchema.safeParse({
      round: 1,
      model: "claude-opus",
      role: "skeptic",
      claim: "当前实验尚未排除参数量带来的混杂因素。",
      evidence: ["需要增加参数量匹配的对照模型。"],
    }).success).toBe(true);
    expect(ChineseDebateTurnSchema.safeParse({
      round: 1,
      model: "gpt",
      role: "advocate",
      claim: "This entire argument remains in English.",
      evidence: [],
    }).success).toBe(false);
  });
});
