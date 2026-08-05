import { XMLParser } from "fast-xml-parser";
import {
  ArxivPaperSchema,
  type ArxivPaper,
  type Author,
} from "../schema/report.js";

const ARXIV_API_URL = "https://export.arxiv.org/api/query";
const ARXIV_RSS_URL = "https://rss.arxiv.org/rss";
const DEFAULT_MAX_PDF_BYTES = 40 * 1024 * 1024;

type FetchLike = typeof globalThis.fetch;
type UnknownRecord = Record<string, unknown>;

export interface ParseArxivOptions {
  /** ISO calendar date assigned when the upstream format has no announcement date. */
  announcedOn?: string;
  sourceUrl?: string;
}

export interface ArxivReleaseBatch {
  announcementDate: string;
  papers: ArxivPaper[];
}

export interface ArxivClientOptions {
  userAgent: string;
  fetch?: FetchLike;
  minRequestIntervalMs?: number;
  timeoutMs?: number;
}

export interface PdfOptions {
  fetch?: FetchLike;
  maxBytes?: number;
  timeoutMs?: number;
  userAgent?: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
});

function arrayify<T>(value: T | T[] | undefined | null): T[] {
  return value == null ? [] : Array.isArray(value) ? value : [value];
}

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object"
    ? (value as UnknownRecord)
    : {};
}

function text(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") {
    return String(value).replace(/\s+/g, " ").trim();
  }
  if (value === null || typeof value !== "object") return "";
  const object = record(value);
  const nested = object["#text"] ?? object["__cdata"];
  return nested === undefined ? "" : text(nested);
}

function optionalText(value: unknown): string | undefined {
  const valueText = text(value);
  return valueText || undefined;
}

function isoDateTime(value: unknown, fallback?: string): string {
  const raw = text(value) || fallback;
  if (!raw) throw new Error("Missing required timestamp in arXiv response");
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.valueOf())) {
    throw new Error(`Invalid timestamp in arXiv response: ${raw}`);
  }
  return parsed.toISOString();
}

function calendarDate(value: unknown, fallback?: string): string {
  const raw = text(value) || fallback;
  if (!raw) throw new Error("Missing announcement date in arXiv response");
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.valueOf())) {
    throw new Error(`Invalid announcement date: ${raw}`);
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(parsed);
}

function decodeHtml(value: string): string {
  const entities: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    quot: '"',
  };
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
      const lower = entity.toLowerCase();
      if (lower.startsWith("#x")) {
        return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
      }
      if (lower.startsWith("#")) {
        return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
      }
      return entities[lower] ?? match;
    })
    .replace(/\s+/g, " ")
    .trim();
}

export function parseArxivId(input: string): {
  arxivId: string;
  baseArxivId: string;
  version?: number;
} {
  const match = input
    .trim()
    .replace(/^arXiv:/i, "")
    .replace(/^https?:\/\/(?:export\.)?arxiv\.org\/(?:abs|pdf)\//i, "")
    .replace(/\.pdf(?:\?.*)?$/i, "")
    .match(
      /((?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7}|\d{4}\.\d{4,5}))(?:v(\d+))?/i,
    );
  if (!match?.[1]) throw new Error(`Invalid arXiv identifier: ${input}`);
  const version = match[2] ? Number.parseInt(match[2], 10) : undefined;
  return {
    arxivId: `${match[1]}${version ? `v${version}` : ""}`,
    baseArxivId: match[1],
    ...(version ? { version } : {}),
  };
}

function categoryTerms(value: unknown): string[] {
  return arrayify(value)
    .map((category) => {
      const object = record(category);
      return text(object["@_term"] ?? object["@_label"] ?? category);
    })
    .filter(Boolean);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function rssAuthors(item: UnknownRecord): Author[] {
  const creators = arrayify(item["creator"])
    .flatMap((creator) => text(creator).split(/\s*,\s*|\s+and\s+/))
    .filter(Boolean);
  const fallback = text(item["author"]);
  const names = creators.length > 0 ? creators : fallback ? [fallback] : ["Unknown"];
  return names.map((name) => ({ name }));
}

/** Parse an official arXiv RSS document without performing network I/O. */
export function parseArxivRssBatch(
  xml: string,
  options: ParseArxivOptions = {},
): ArxivReleaseBatch {
  const document = record(parser.parse(xml));
  const channel = record(record(document["rss"])["channel"]);
  const feedDate = options.announcedOn ?? calendarDate(channel["pubDate"]);

  const papers = arrayify(channel["item"]).map((rawItem) => {
    const item = record(rawItem);
    const link = text(item["link"]);
    const id = parseArxivId(text(item["identifier"]) || link);
    const categories = unique([
      ...categoryTerms(item["category"]),
      ...text(item["subject"]).split(/\s*,\s*|\s+/).filter(Boolean),
    ]);
    const primaryCategory = categories[0] ?? "unknown";
    const releaseDate = calendarDate(item["pubDate"], feedDate);
    const description = decodeHtml(text(item["description"]));
    const announcementType =
      optionalText(item["announce_type"]) ??
      description.match(/Announce Type:\s*([a-z-]+)/i)?.[1]?.toLowerCase() ??
      "unknown";
    const abstract =
      description.replace(/^arXiv:\S+\s+Announce Type:\s*\S+\s*/i, "") ||
      "Abstract unavailable in RSS feed";
    const releaseSourceUrl =
      options.sourceUrl ??
      optionalText(record(channel["atom:link"])["@_href"]) ??
      optionalText(channel["link"]) ??
      `${ARXIV_RSS_URL}/${primaryCategory}`;

    return ArxivPaperSchema.parse({
      ...id,
      title: decodeHtml(text(item["title"])),
      abstract,
      authors: rssAuthors(item),
      categories,
      primaryCategory,
      announcedOn: releaseDate,
      releaseDate,
      announcementType,
      releaseSourceUrl,
      absUrl: `https://arxiv.org/abs/${id.arxivId}`,
      pdfUrl: `https://arxiv.org/pdf/${id.arxivId}`,
      source: "arxiv-rss",
    });
  });
  return { announcementDate: feedDate, papers };
}

/** Parse papers from one official daily RSS announcement batch. */
export function parseArxivRss(
  xml: string,
  options: ParseArxivOptions = {},
): ArxivPaper[] {
  return parseArxivRssBatch(xml, options).papers;
}

const RELEASE_ANNOUNCEMENT_TYPES = new Set(["new", "cross"]);

/** Keep only first-release announcements from the requested Eastern-time batch. */
export function filterArxivReleaseBatch(
  papers: readonly ArxivPaper[],
  reportDate: string,
): ArxivPaper[] {
  return papers.filter(
    (paper) =>
      paper.releaseDate === reportDate &&
      RELEASE_ANNOUNCEMENT_TYPES.has(paper.announcementType),
  );
}

function atomAuthors(value: unknown): Author[] {
  return arrayify(value).map((rawAuthor) => {
    const author = record(rawAuthor);
    const affiliation = optionalText(author["affiliation"]);
    return {
      name: text(author["name"] ?? rawAuthor),
      ...(affiliation ? { affiliation } : {}),
    };
  });
}

function atomLink(entry: UnknownRecord, relation: string): string | undefined {
  const links = arrayify(entry["link"]).map(record);
  const match = links.find(
    (link) =>
      text(link["@_rel"]) === relation ||
      (relation === "alternate" && !link["@_rel"]),
  );
  return optionalText(match?.["@_href"]);
}

/** Parse an official arXiv Atom API document without performing network I/O. */
export function parseArxivApi(
  xml: string,
  options: ParseArxivOptions = {},
): ArxivPaper[] {
  const document = record(parser.parse(xml));
  const feed = record(document["feed"]);
  return arrayify(feed["entry"]).map((rawEntry) => {
    const entry = record(rawEntry);
    const id = parseArxivId(text(entry["id"]));
    const categories = unique(categoryTerms(entry["category"]));
    const primaryCategory =
      text(record(entry["primary_category"])["@_term"]) ||
      categories[0] ||
      "unknown";
    const submittedAt = isoDateTime(entry["published"]);
    const updatedAt = isoDateTime(entry["updated"], submittedAt);
    const announcedOn = calendarDate(
      options.announcedOn ?? submittedAt.slice(0, 10),
    );
    const alternate = atomLink(entry, "alternate");
    const pdf = atomLink(entry, "related");

    return ArxivPaperSchema.parse({
      ...id,
      title: text(entry["title"]),
      abstract: text(entry["summary"]),
      authors: atomAuthors(entry["author"]),
      categories,
      primaryCategory,
      submittedAt,
      updatedAt,
      announcedOn,
      releaseDate: announcedOn,
      announcementType: "unknown",
      releaseSourceUrl: alternate ?? `https://arxiv.org/abs/${id.arxivId}`,
      absUrl: alternate ?? `https://arxiv.org/abs/${id.arxivId}`,
      pdfUrl: pdf ?? `https://arxiv.org/pdf/${id.arxivId}`,
      doi: optionalText(entry["doi"]),
      journalReference: optionalText(entry["journal_ref"]),
      comments: optionalText(entry["comment"]),
      source: "arxiv-api",
    });
  });
}

/** Keep one record per base id, preferring higher versions then richer API data. */
export function dedupeArxivPapers(papers: readonly ArxivPaper[]): ArxivPaper[] {
  const byId = new Map<string, ArxivPaper>();
  for (const paper of papers) {
    const current = byId.get(paper.baseArxivId);
    const shouldReplace =
      !current ||
      (paper.version ?? 1) > (current.version ?? 1) ||
      ((paper.version ?? 1) === (current.version ?? 1) &&
        paper.source === "arxiv-api" &&
        current.source !== "arxiv-api") ||
      ((paper.version ?? 1) === (current.version ?? 1) &&
        (paper.updatedAt ?? "") > (current.updatedAt ?? ""));
    if (shouldReplace) byId.set(paper.baseArxivId, paper);
  }
  return [...byId.values()].sort(
    (left, right) =>
      right.announcedOn.localeCompare(left.announcedOn) ||
      left.baseArxivId.localeCompare(right.baseArxivId),
  );
}

async function checkedFetch(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetchImpl(url, { ...init, signal });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 500);
    throw new Error(
      `arXiv request failed (${response.status} ${response.statusText}): ${body}`,
    );
  }
  return response;
}

export class ArxivClient {
  readonly #fetch: FetchLike;
  readonly #userAgent: string;
  readonly #minInterval: number;
  readonly #timeout: number;
  #lastRequestAt = 0;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: ArxivClientOptions) {
    if (!options.userAgent.trim()) {
      throw new Error("A descriptive userAgent is required by arXiv etiquette");
    }
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#userAgent = options.userAgent;
    this.#minInterval = options.minRequestIntervalMs ?? 3_000;
    this.#timeout = options.timeoutMs ?? 30_000;
  }

  async #throttle(): Promise<void> {
    const previous = this.#queue;
    let release!: () => void;
    this.#queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const wait = Math.max(
      0,
      this.#minInterval - (Date.now() - this.#lastRequestAt),
    );
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.#lastRequestAt = Date.now();
    release();
  }

  async fetchApi(
    searchQuery: string,
    options: { start?: number; maxResults?: number; announcedOn?: string } = {},
  ): Promise<ArxivPaper[]> {
    await this.#throttle();
    const url = new URL(ARXIV_API_URL);
    url.searchParams.set("search_query", searchQuery);
    url.searchParams.set("start", String(options.start ?? 0));
    url.searchParams.set(
      "max_results",
      String(Math.min(Math.max(options.maxResults ?? 100, 1), 2_000)),
    );
    url.searchParams.set("sortBy", "submittedDate");
    url.searchParams.set("sortOrder", "descending");
    const response = await checkedFetch(
      this.#fetch,
      url.toString(),
      { headers: { "User-Agent": this.#userAgent, Accept: "application/atom+xml" } },
      this.#timeout,
    );
    return parseArxivApi(await response.text(), {
      ...(options.announcedOn ? { announcedOn: options.announcedOn } : {}),
    });
  }

  async fetchRss(
    categories: readonly string[],
    options: ParseArxivOptions = {},
  ): Promise<ArxivPaper[]> {
    return (await this.fetchRssBatch(categories, options)).papers;
  }

  async fetchRssBatch(
    categories: readonly string[],
    options: ParseArxivOptions = {},
  ): Promise<ArxivReleaseBatch> {
    if (categories.length === 0) {
      throw new Error("At least one arXiv RSS category is required.");
    }
    await this.#throttle();
    const safeCategories = unique([...categories]).map((category) => {
      if (!/^[a-z-]+(?:\.[A-Z]{2})?$/i.test(category)) {
        throw new Error(`Invalid arXiv category: ${category}`);
      }
      return encodeURIComponent(category);
    });
    const sourceUrl = `${ARXIV_RSS_URL}/${safeCategories.join("+")}`;
    const response = await checkedFetch(
      this.#fetch,
      sourceUrl,
      { headers: { "User-Agent": this.#userAgent, Accept: "application/rss+xml" } },
      this.#timeout,
    );
    return parseArxivRssBatch(await response.text(), {
      ...options,
      sourceUrl,
    });
  }
}

export async function downloadPdf(
  url: string,
  options: PdfOptions = {},
): Promise<Uint8Array> {
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "https:") {
    throw new Error("PDF downloads require HTTPS");
  }
  const response = await checkedFetch(
    options.fetch ?? globalThis.fetch,
    parsedUrl.toString(),
    {
      headers: {
        Accept: "application/pdf",
        "User-Agent": options.userAgent ?? "daily-arxiv-agent/1.0",
      },
    },
    options.timeoutMs ?? 60_000,
  );
  const declaredLength = Number(response.headers.get("content-length"));
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_PDF_BYTES;
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`PDF exceeds ${maxBytes} byte limit`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw new Error(`PDF exceeds ${maxBytes} byte limit`);
  }
  if (
    bytes.byteLength < 5 ||
    String.fromCharCode(...bytes.slice(0, 5)) !== "%PDF-"
  ) {
    throw new Error("Downloaded response is not a PDF");
  }
  return bytes;
}

export async function extractPdfText(
  data: Uint8Array,
  options: { maxPages?: number } = {},
): Promise<string> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = getDocument({
    data,
    useWorkerFetch: false,
    verbosity: 0,
  });
  const document = await loadingTask.promise;
  try {
    const pages: string[] = [];
    const pageCount = Math.min(document.numPages, options.maxPages ?? Infinity);
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      pages.push(pageText);
    }
    return pages.filter(Boolean).join("\n\n");
  } finally {
    await loadingTask.destroy();
  }
}

const IMPORTANT_SECTION =
  /\b(abstract|introduction|background|method|methodology|approach|architecture|implementation|experiment|evaluation|result|analysis|limitation|discussion|conclusion)\b/i;

/**
 * Deterministically retain the beginning, experimentally relevant sections,
 * and ending of a paper without sending the full PDF to a model.
 */
export function compressPaperText(
  text: string,
  maxChars = 40_000,
): string {
  if (maxChars < 4_000) throw new Error("maxChars must be at least 4000.");
  const normalized = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (normalized.length <= maxChars) return normalized;

  const blocks = normalized
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
  const selected: string[] = [];
  const seen = new Set<string>();
  const add = (block: string): void => {
    const key = block.slice(0, 200);
    if (!seen.has(key)) {
      seen.add(key);
      selected.push(block);
    }
  };

  for (const block of blocks.slice(0, 2)) add(block);
  for (const block of blocks) {
    if (selected.length >= 10) break;
    if (IMPORTANT_SECTION.test(block.slice(0, 500))) add(block);
  }
  for (const block of blocks.slice(-2)) add(block);

  const separatorChars = Math.max(0, selected.length - 1) * 2;
  const perBlock = Math.max(
    500,
    Math.floor((maxChars - separatorChars) / Math.max(1, selected.length)),
  );
  return selected
    .map((block) => block.slice(0, perBlock))
    .join("\n\n")
    .slice(0, maxChars);
}
