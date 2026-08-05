import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  normalizeOpenAlexWork,
  parseOpenAlexResponse,
  sanitizeOpenAlexSearch,
} from "../src/sources/openalex.js";

describe("OpenAlex normalization", () => {
  it("removes unsupported search operators and caps query length", () => {
    const query = sanitizeOpenAlexSearch(
      `mobile score | sparse routing ${"long ".repeat(200)}`,
    );
    expect(query).not.toContain("|");
    expect(query.length).toBeLessThanOrEqual(500);
  });

  it("returns stable report references", async () => {
    const input = await readFile(
      new URL("./fixtures/openalex.json", import.meta.url),
      "utf8",
    );
    const references = parseOpenAlexResponse(input);

    expect(references).toHaveLength(2);
    expect(references[0]).toMatchObject({
      id: "10.5555/example",
      doi: "10.5555/example",
      arxivId: "2401.01234",
      authors: ["Test Author"],
      venue: "Transactions on Agents",
      citationCount: 42,
      openAlexId: "https://openalex.org/W123",
    });
    expect(references[1]?.year).toBeNull();
  });

  it("rejects records without an OpenAlex id", () => {
    expect(() => normalizeOpenAlexWork({ title: "No id" })).toThrow(
      "missing an id",
    );
  });
});
