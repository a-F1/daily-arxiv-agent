import { ReferenceSchema, type Reference } from "../schema/report.js";

const OPENALEX_WORKS_URL = "https://api.openalex.org/works";
type FetchLike = typeof globalThis.fetch;
type UnknownRecord = Record<string, unknown>;

export interface OpenAlexClientOptions {
  email?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export interface PriorArtQuery {
  title: string;
  abstract?: string;
  beforeYear?: number;
  maxResults?: number;
}

export function sanitizeOpenAlexSearch(value: string): string {
  return value
    .replace(/[|]/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object"
    ? (value as UnknownRecord)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeDoi(value: unknown): string | undefined {
  return stringValue(value)
    ?.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .toLowerCase();
}

function arxivIdFromLocation(work: UnknownRecord): string | undefined {
  const locations = [
    record(work["primary_location"]),
    ...(Array.isArray(work["locations"]) ? work["locations"].map(record) : []),
  ];
  for (const location of locations) {
    const candidates = [
      stringValue(location["landing_page_url"]),
      stringValue(location["pdf_url"]),
    ];
    for (const candidate of candidates) {
      const match = candidate?.match(
        /arxiv\.org\/(?:abs|pdf)\/((?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?)/i,
      );
      if (match?.[1]) return match[1].replace(/\.pdf$/i, "");
    }
  }
  return undefined;
}

/** Normalize a raw OpenAlex work into the report's stable reference shape. */
export function normalizeOpenAlexWork(value: unknown): Reference {
  const work = record(value);
  const openAlexId =
    stringValue(work["id"]) ??
    stringValue(work["ids"] && record(work["ids"])["openalex"]);
  if (!openAlexId) throw new Error("OpenAlex work is missing an id");

  const authorships = Array.isArray(work["authorships"])
    ? work["authorships"]
    : [];
  const authors = authorships
    .map((authorship) =>
      stringValue(record(record(authorship)["author"])["display_name"]),
    )
    .filter((author): author is string => Boolean(author));
  const location = record(work["primary_location"]);
  const source = record(location["source"]);
  const doi = normalizeDoi(
    work["doi"] ?? (work["ids"] && record(work["ids"])["doi"]),
  );
  const url =
    (doi ? `https://doi.org/${doi}` : undefined) ??
    stringValue(location["landing_page_url"]) ??
    openAlexId;

  return ReferenceSchema.parse({
    id: doi ?? openAlexId,
    title: stringValue(work["title"] ?? work["display_name"]) ?? "Untitled work",
    authors,
    year: numberValue(work["publication_year"]) ?? null,
    ...(doi ? { doi } : {}),
    ...(arxivIdFromLocation(work)
      ? { arxivId: arxivIdFromLocation(work) }
      : {}),
    ...(stringValue(source["display_name"])
      ? { venue: stringValue(source["display_name"]) }
      : {}),
    ...(url ? { url } : {}),
    ...(numberValue(work["cited_by_count"]) !== undefined
      ? { citationCount: numberValue(work["cited_by_count"]) }
      : {}),
    openAlexId,
  });
}

/** Parse a JSON string or object returned by the OpenAlex works endpoint. */
export function parseOpenAlexResponse(input: string | unknown): Reference[] {
  const payload = record(
    typeof input === "string" ? (JSON.parse(input) as unknown) : input,
  );
  const results = Array.isArray(payload["results"]) ? payload["results"] : [];
  const references: Reference[] = [];
  for (const result of results) {
    try {
      references.push(normalizeOpenAlexWork(result));
    } catch {
      // A malformed individual record should not discard otherwise useful results.
    }
  }
  const deduped = new Map<string, Reference>();
  for (const reference of references) {
    const key = reference.doi ?? reference.openAlexId ?? reference.id;
    const existing = deduped.get(key);
    if (
      !existing ||
      (reference.citationCount ?? 0) > (existing.citationCount ?? 0)
    ) {
      deduped.set(key, reference);
    }
  }
  return [...deduped.values()];
}

export class OpenAlexClient {
  readonly #email: string | undefined;
  readonly #fetch: FetchLike;
  readonly #timeout: number;

  constructor(options: OpenAlexClientOptions = {}) {
    this.#email = options.email;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeout = options.timeoutMs ?? 30_000;
  }

  async searchPriorArt(query: PriorArtQuery): Promise<Reference[]> {
    if (!query.title.trim()) throw new Error("Prior-art query needs a title");
    const searchText = sanitizeOpenAlexSearch(
      [query.title, query.abstract?.slice(0, 500)]
        .filter(Boolean)
        .join(" "),
    );
    const url = new URL(OPENALEX_WORKS_URL);
    url.searchParams.set("search", searchText);
    url.searchParams.set(
      "per-page",
      String(Math.min(Math.max(query.maxResults ?? 10, 1), 100)),
    );
    url.searchParams.set("sort", "relevance_score:desc");
    url.searchParams.set(
      "select",
      [
        "id",
        "doi",
        "title",
        "display_name",
        "publication_year",
        "authorships",
        "primary_location",
        "locations",
        "cited_by_count",
        "ids",
      ].join(","),
    );
    if (query.beforeYear !== undefined) {
      if (!Number.isInteger(query.beforeYear)) {
        throw new Error("beforeYear must be an integer");
      }
      url.searchParams.set(
        "filter",
        `from_publication_date:1600-01-01,to_publication_date:${query.beforeYear}-12-31`,
      );
    }
    if (this.#email) url.searchParams.set("mailto", this.#email);

    const response = await this.#fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": this.#email
          ? `daily-arxiv-agent/1.0 (mailto:${this.#email})`
          : "daily-arxiv-agent/1.0",
      },
      signal: AbortSignal.timeout(this.#timeout),
    });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 500);
      throw new Error(
        `OpenAlex request failed (${response.status} ${response.statusText}): ${body}`,
      );
    }
    return parseOpenAlexResponse(await response.json());
  }
}
