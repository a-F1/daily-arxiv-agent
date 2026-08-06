import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { DOMAINS } from "../src/domains.js";
import { type ArxivPaper, ArxivPaperSchema } from "../src/schema/report.js";
import {
  classifyExcludedTopic,
  preRankPapers,
  scorePaperForDomain,
  selectPapers,
} from "../src/pipeline/select.js";

function paper(
  id: string,
  title: string,
  abstract: string,
  category = "cs.AI",
): ArxivPaper {
  return ArxivPaperSchema.parse({
    arxivId: id,
    baseArxivId: id,
    title,
    abstract,
    authors: [{ name: "Researcher" }],
    categories: [category],
    primaryCategory: category,
    submittedAt: "2026-08-04T12:00:00.000Z",
    updatedAt: "2026-08-04T12:00:00.000Z",
    announcedOn: "2026-08-04",
    releaseDate: "2026-08-04",
    announcementType: "new",
    releaseSourceUrl: "https://rss.arxiv.org/rss/cs.AI",
    absUrl: `https://arxiv.org/abs/${id}`,
    pdfUrl: `https://arxiv.org/pdf/${id}`,
    source: "arxiv-api",
  });
}

describe("deterministic selection", () => {
  it("produces an auditable score breakdown", () => {
    const domain = DOMAINS.find(({ id }) => id === "agent")!;
    const score = scorePaperForDomain(
      paper(
        "2608.00001",
        "Tool-Using Language Model Agent",
        "Planning and memory for tool use.",
      ),
      domain,
      "2026-08-04",
    );

    expect(score.total).toBe(
      Object.values(score.breakdown).reduce((sum, value) => sum + value, 0),
    );
    expect(score.matchedKeywords).toEqual(
      expect.arrayContaining(["agent", "planning", "memory", "tool use"]),
    );
    expect(score.explanation.join(" ")).toContain("title keywords");
  });

  it("is independent of input order and assigns each paper once", () => {
    const papers = [
      paper(
        "2608.00002",
        "Vision Language Action Robot Policy",
        "Embodied robot learning.",
        "cs.RO",
      ),
      paper(
        "2608.00001",
        "Tool-Using Agent",
        "An agent for planning and memory.",
      ),
      paper(
        "2608.00003",
        "Efficient Transformer Architecture",
        "Sparse attention for long context.",
        "cs.LG",
      ),
    ];
    const options = { asOfDate: "2026-08-04" };

    const forward = preRankPapers(papers, DOMAINS, options);
    const reversed = preRankPapers([...papers].reverse(), DOMAINS, options);
    expect(reversed).toEqual(forward);

    const selected = selectPapers(
      [...papers, papers[0]!],
      DOMAINS,
      options,
    );
    expect(new Set(selected.map(({ paper: item }) => item.baseArxivId)).size).toBe(
      selected.length,
    );
  });

  it("caps every domain at three papers", () => {
    const papers = Array.from({ length: 5 }, (_, index) =>
      paper(
        `2608.${String(index + 100).padStart(5, "0")}`,
        `Agent Planning Study ${index}`,
        "Language model agent memory and tool use.",
      ),
    );
    const selected = selectPapers(papers, DOMAINS, {
      asOfDate: "2026-08-04",
    });

    expect(selected.filter(({ score }) => score.domainId === "agent")).toHaveLength(
      3,
    );
  });

  it("keeps the actual count when a domain has fewer than three papers", () => {
    const selected = selectPapers(
      [
        paper(
          "2608.00001",
          "Tool-Using Agent",
          "An agent for planning, memory, and tool use.",
        ),
      ],
      DOMAINS,
      { asOfDate: "2026-08-04" },
    );

    expect(selected).toHaveLength(1);
    expect(selected[0]?.score.domainId).toBe("agent");
  });

  it.each([
    ["Adversarial Attack on Tool-Using Agents", "We compromise agent planning.", "ATTACK_ADVERSARIAL"],
    ["A Defense for Language Model Agents", "We block malicious model attacks.", "DEFENSE_MITIGATION"],
    ["AI Safety Alignment for Autonomous Agents", "We study harmless behavior.", "AI_SAFETY_ALIGNMENT"],
    ["Jailbreaking Long-Horizon Agents", "A new jailbreak benchmark.", "JAILBREAK_PROMPT_INJECTION"],
    ["Indirect Prompt Injection in Web Agents", "Prompts alter tool behavior.", "JAILBREAK_PROMPT_INJECTION"],
    ["Memory Poisoning in Multi-Agent Systems", "Injected memories corrupt decisions.", "POISONING_BACKDOOR"],
    ["Backdoor Triggers for Language Models", "Hidden triggers alter outputs.", "POISONING_BACKDOOR"],
    ["面向智能体的提示注入与越狱研究", "分析恶意提示如何改变工具调用。", "CHINESE_SECURITY_TOPIC"],
    ["Scheduling Cloud Computing Workloads", "We optimize cloud resource scheduling.", "CLOUD_COMPUTING_SYSTEMS"],
    ["Cold Starts in Serverless Platforms", "We optimize FaaS function placement.", "SERVERLESS_FAAS"],
    ["Energy-Aware Datacenter Networks", "We schedule jobs across data centers.", "DATACENTER_INFRASTRUCTURE"],
    ["面向云平台的弹性资源调度", "研究云计算工作负载的资源分配。", "CHINESE_CLOUD_COMPUTING"],
    ["Social Bias in Language Models", "We measure gender and racial bias.", "BIAS_SEXISM_FAIRNESS"],
    ["Fair AI through Debiasing", "Algorithmic fairness reduces discrimination.", "BIAS_SEXISM_FAIRNESS"],
    ["Machine Translation with Retrieval", "A neural translation system for English and French.", "LANGUAGE_TRANSLATION"],
    ["End-to-End Speech Translation", "We translate spoken English into French text.", "LANGUAGE_TRANSLATION"],
    ["Document Translation Evaluation", "We evaluate translation quality for multilingual documents.", "LANGUAGE_TRANSLATION"],
    ["面向大模型的性别歧视去偏", "研究模型偏见、公平性与刻板印象。", "CHINESE_BIAS_FAIRNESS"],
    ["低资源机器翻译系统", "研究中文到英文的神经翻译。", "CHINESE_LANGUAGE_TRANSLATION"],
  ])("hard-excludes %s", (title, abstract, reasonCode) => {
    const decision = classifyExcludedTopic(
      paper("2608.01000", title, abstract),
    );
    expect(decision.excluded).toBe(true);
    expect(decision.reasonCodes).toContain(reasonCode);
  });

  it("regresses the rejected sexism and wordplay-translation papers by topic evidence", async () => {
    const fixtures = JSON.parse(
      await readFile(
        new URL("./fixtures/excluded-user-preferences.json", import.meta.url),
        "utf8",
      ),
    ) as Array<{
      title: string;
      abstract: string;
      categories: string[];
      reasonCode: string;
    }>;
    for (const fixture of fixtures) {
      const decision = classifyExcludedTopic(fixture);
      expect(decision.excluded, fixture.title).toBe(true);
      expect(decision.reasonCodes, fixture.title).toContain(fixture.reasonCode);
    }
  });

  it("hard-excludes security-category papers before scoring", () => {
    const candidate = paper(
      "2608.01001",
      "A New Protocol for Distributed Systems",
      "We present a protocol with formal guarantees.",
      "cs.CR",
    );
    expect(classifyExcludedTopic(candidate).reasonCodes).toContain(
      "SECURITY_CYBERSECURITY",
    );
    expect(
      preRankPapers([candidate], DOMAINS, { asOfDate: "2026-08-04" }),
    ).toEqual([]);
  });

  it("re-enforces bias and translation exclusions inside pre-ranking", () => {
    const excluded = [
      paper(
        "2608.01002",
        "Sexism and Social Bias in Language Models",
        "We evaluate gender stereotypes and algorithmic fairness.",
      ),
      paper(
        "2608.01003",
        "Multi-Agent Speech Translation",
        "A multilingual speech translation system.",
      ),
    ];
    expect(
      preRankPapers(excluded, DOMAINS, { asOfDate: "2026-08-04" }),
    ).toEqual([]);
  });

  it.each([
    [
      "Robust Training of Vision Transformers",
      "We improve statistical robustness to ordinary distribution shift without studying attacks.",
    ],
    [
      "Safe Resource Cleanup for Agent Runtimes",
      "A type-safe API closes file handles and prevents memory leaks.",
    ],
    [
      "Robot Control Within a Safe Operating Range",
      "The controller respects actuator limits during routine manipulation.",
    ],
    [
      "Reliable Object Detection Under Weather Shift",
      "The detector remains robust under rain and illumination changes.",
    ],
    [
      "Point Cloud Segmentation with Sparse Transformers",
      "We improve 3D point cloud understanding on autonomous-driving datasets.",
    ],
    [
      "Training Language Models from Archived Corpora",
      "We use a cloud storage bucket only to retrieve the public training files.",
    ],
    [
      "Tool Calling with a Hosted API",
      "Experiments invoke a cloud API as a tool; the paper studies agent planning.",
    ],
    [
      "Inductive Bias for Data-Efficient Transformers",
      "We study architectural inductive bias for sequence modeling without social attributes or fairness claims.",
    ],
    [
      "Bias Correction for Statistical Estimators",
      "We derive finite-sample estimation bias and variance guarantees.",
    ],
    [
      "Bias Terms in Attention Layers",
      "We analyze an additive bias term in a language model attention operator.",
    ],
    [
      "Translation Equivariance in Convolutional Networks",
      "The architecture is equivariant to mathematical translation of image coordinates.",
    ],
    [
      "Protein Translation Dynamics",
      "We model ribosomal translation from mRNA into amino-acid sequences.",
    ],
  ])("does not falsely exclude %s", (title, abstract) => {
    expect(
      classifyExcludedTopic(paper("2608.02000", title, abstract)).excluded,
    ).toBe(false);
  });

  it("never backfills excluded papers when a domain is below quota", () => {
    const eligible = paper(
      "2608.03000",
      "Tool-Using Agent Planning",
      "An agent for planning, memory, and tool use.",
    );
    const excluded = [
      paper(
        "2608.03001",
        "AI Safety for Tool-Using Agents",
        "Alignment for autonomous agents.",
      ),
      paper(
        "2608.03002",
        "Prompt Injection in Tool-Using Agents",
        "An attack on agent planning.",
      ),
      paper(
        "2608.03003",
        "Defense for Tool-Using Agents",
        "A guardrail against malicious attacks.",
      ),
      paper(
        "2608.03004",
        "Sexism Detection with Language Model Agents",
        "We study social bias and gender stereotypes.",
      ),
      paper(
        "2608.03005",
        "Multi-Agent Machine Translation",
        "Agents evaluate English-to-French translation quality.",
      ),
    ];

    const selected = selectPapers([eligible, ...excluded], DOMAINS, {
      asOfDate: "2026-08-04",
      maxPerDomain: 3,
    });
    expect(selected.map(({ paper: item }) => item.baseArxivId)).toEqual([
      eligible.baseArxivId,
    ]);
  });
});
