import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  compressPaperText,
  dedupeArxivPapers,
  downloadPdf,
  filterArxivReleaseBatch,
  parseArxivApi,
  parseArxivRss,
} from "../src/sources/arxiv.js";

describe("paper text compression", () => {
  it("keeps important sections under a deterministic character cap", () => {
    const text = [
      `Abstract\n${"overview ".repeat(800)}`,
      `Related Work\n${"citation ".repeat(800)}`,
      `Method\n${"architecture ".repeat(800)}`,
      `Experiments\n${"result ".repeat(800)}`,
      `Limitations\n${"constraint ".repeat(800)}`,
    ].join("\n\n");
    const compressed = compressPaperText(text, 5_000);
    expect(compressed.length).toBeLessThanOrEqual(5_000);
    expect(compressed).toContain("Abstract");
    expect(compressed).toContain("Method");
    expect(compressPaperText(text, 5_000)).toBe(compressed);
  });
});

const fixture = (name: string) =>
  readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("arXiv parsers", () => {
  it("normalizes official Atom API entries", async () => {
    const papers = parseArxivApi(await fixture("arxiv-api.xml"), {
      announcedOn: "2026-08-04",
    });

    expect(papers).toHaveLength(1);
    expect(papers[0]).toMatchObject({
      arxivId: "2608.01234v2",
      baseArxivId: "2608.01234",
      version: 2,
      primaryCategory: "cs.AI",
      categories: ["cs.AI", "cs.CL"],
      announcedOn: "2026-08-04",
      releaseDate: "2026-08-04",
      announcementType: "unknown",
      source: "arxiv-api",
    });
    expect(papers[0]?.authors[0]).toEqual({
      name: "Ada Lovelace",
      affiliation: "Example Lab",
    });
  });

  it("normalizes RSS and derives the New York announcement date", async () => {
    const papers = parseArxivRss(await fixture("arxiv-rss.xml"));

    expect(papers).toHaveLength(2);
    expect(papers[0]).toMatchObject({
      arxivId: "2608.04321v1",
      announcedOn: "2026-08-04",
      releaseDate: "2026-08-04",
      announcementType: "new",
      categories: ["cs.RO", "cs.AI"],
      source: "arxiv-rss",
    });
    expect(papers[0]?.abstract).toContain(
      "robot policy that maps visual and language",
    );
    expect(papers[0]?.authors.map(({ name }) => name)).toEqual([
      "Grace Hopper",
      "Katherine Johnson",
    ]);
  });

  it("strictly keeps same-day new releases and excludes updates", async () => {
    const papers = parseArxivRss(await fixture("arxiv-rss.xml"));
    const released = filterArxivReleaseBatch(papers, "2026-08-04");

    expect(released.map((paper) => paper.baseArxivId)).toEqual(["2608.04321"]);
    expect(released.every((paper) => paper.releaseDate === "2026-08-04")).toBe(true);
    expect(released.every((paper) => paper.announcementType === "new")).toBe(true);
    expect(filterArxivReleaseBatch(papers, "2026-08-05")).toEqual([]);
  });

  it("returns an honest empty batch on weekends or no-release days", () => {
    expect(filterArxivReleaseBatch([], "2026-08-08")).toEqual([]);
  });

  it("deduplicates by base id and prefers the latest version", async () => {
    const [apiPaper] = parseArxivApi(await fixture("arxiv-api.xml"), {
      announcedOn: "2026-08-04",
    });
    expect(apiPaper).toBeDefined();
    const older = {
      ...apiPaper!,
      arxivId: "2608.01234v1",
      version: 1,
      source: "arxiv-rss" as const,
    };

    expect(dedupeArxivPapers([older, apiPaper!])).toEqual([apiPaper]);
  });

  it("rejects a non-PDF response", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response("not a pdf", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });

    await expect(
      downloadPdf("https://arxiv.org/pdf/2608.01234", { fetch: fakeFetch }),
    ).rejects.toThrow("not a PDF");
  });
});
