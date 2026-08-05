import { describe, expect, it } from "vitest";
import { DOMAINS } from "../src/domains.js";
import { type ArxivPaper, ArxivPaperSchema } from "../src/schema/report.js";
import {
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
});
