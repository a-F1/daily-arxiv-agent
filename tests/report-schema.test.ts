import { describe, expect, it } from "vitest";
import {
  PaperSummarySchema,
  ResearchIdeaSchema,
  RefinementSchema,
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
