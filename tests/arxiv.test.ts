import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  dedupeArxivPapers,
  downloadPdf,
  parseArxivApi,
  parseArxivRss,
} from "../src/sources/arxiv.js";

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
      source: "arxiv-api",
    });
    expect(papers[0]?.authors[0]).toEqual({
      name: "Ada Lovelace",
      affiliation: "Example Lab",
    });
  });

  it("normalizes RSS and derives the New York announcement date", async () => {
    const papers = parseArxivRss(await fixture("arxiv-rss.xml"));

    expect(papers[0]).toMatchObject({
      arxivId: "2608.04321v1",
      announcedOn: "2026-08-04",
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
