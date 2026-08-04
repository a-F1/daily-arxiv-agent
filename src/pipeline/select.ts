import type { Domain, DomainId } from "../schema/report.js";
import {
  PaperScoreSchema,
  type ArxivPaper,
  type PaperScore,
  type ScoredPaper,
} from "../schema/report.js";

export const SELECTION_ALGORITHM_VERSION = "pre-rank-v1";

export interface SelectionOptions {
  /** ISO date used as the deterministic recency anchor. */
  asOfDate: string;
  minimumScore?: number;
  maxPerDomain?: number;
}

function normalized(value: string): string {
  return ` ${value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()} `;
}

function contains(haystack: string, needle: string): boolean {
  const normalizedNeedle = normalized(needle).trim();
  return normalizedNeedle.length > 0 && haystack.includes(` ${normalizedNeedle} `);
}

function evidenceScore(text: string, patterns: readonly RegExp[], cap: number): number {
  return Math.min(
    cap,
    patterns.reduce((score, pattern) => score + (pattern.test(text) ? 1 : 0), 0),
  );
}

function daysBetween(leftDate: string, rightDate: string): number {
  const left = Date.parse(`${leftDate}T00:00:00Z`);
  const right = Date.parse(`${rightDate}T00:00:00Z`);
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    throw new Error(`Invalid selection date: ${leftDate} or ${rightDate}`);
  }
  return Math.floor((left - right) / 86_400_000);
}

export function scorePaperForDomain(
  paper: ArxivPaper,
  domain: Domain,
  asOfDate: string,
): PaperScore {
  const title = normalized(paper.title);
  const abstract = normalized(paper.abstract);
  const matchedTitle = domain.keywords.filter((keyword) =>
    contains(title, keyword),
  );
  const matchedAbstract = domain.keywords.filter((keyword) =>
    contains(abstract, keyword),
  );
  const matchedKeywords = [
    ...new Set([...matchedTitle, ...matchedAbstract]),
  ].sort();
  const matchedCategories = paper.categories
    .filter((category) => domain.categories.includes(category))
    .sort();
  const matchedNegative = domain.negativeKeywords.filter(
    (keyword) => contains(title, keyword) || contains(abstract, keyword),
  );
  const primaryCategoryMatch = domain.categories.includes(paper.primaryCategory);
  const category =
    (primaryCategoryMatch ? 4 : 0) +
    matchedCategories.filter((categoryName) => categoryName !== paper.primaryCategory)
      .length *
      1.5;
  const titleKeyword = matchedTitle.length * 3;
  const abstractKeyword = matchedAbstract.length;
  const phrase =
    matchedKeywords.filter((keyword) => normalized(keyword).trim().includes(" "))
      .length * 1.5;
  const negative = matchedNegative.length * -6;
  const rawAbstract = paper.abstract.toLocaleLowerCase("en-US");
  const novelty = evidenceScore(
    rawAbstract,
    [/\bnovel\b/, /\bwe (?:propose|introduce|present)\b/, /\bfirst\b/],
    2,
  );
  const experimentalRigor = evidenceScore(
    rawAbstract,
    [/\bbenchmark\b/, /\bbaseline\b/, /\bablation\b/, /\bdataset\b/, /\bevaluat/],
    3,
  );
  const resultEvidence = evidenceScore(
    rawAbstract,
    [/\d+(?:\.\d+)?%/, /\boutperform/, /\bimprov/, /\bsuccess rate\b/],
    2,
  );
  const resourceDisclosure = evidenceScore(
    rawAbstract,
    [/\b(?:gpu|h100|a100|tpu)s?\b/, /\btraining (?:time|cost|compute)\b/],
    1,
  );
  const ageDays = Math.max(0, daysBetween(asOfDate, paper.announcedOn));
  const recency = ageDays === 0 ? 2 : ageDays <= 2 ? 1 : ageDays <= 7 ? 0.5 : 0;
  const breakdown = {
    category,
    titleKeyword,
    abstractKeyword,
    phrase,
    novelty,
    experimentalRigor,
    resultEvidence,
    resourceDisclosure,
    negative,
    recency,
  };
  const total = Object.values(breakdown).reduce((sum, value) => sum + value, 0);
  const explanation = [
    ...(primaryCategoryMatch
      ? [`primary category ${paper.primaryCategory} (+4)`]
      : []),
    ...(matchedCategories.length > 0 && !primaryCategoryMatch
      ? [`secondary categories ${matchedCategories.join(", ")} (+${category})`]
      : []),
    ...(matchedTitle.length > 0
      ? [`title keywords ${matchedTitle.sort().join(", ")} (+${titleKeyword})`]
      : []),
    ...(matchedAbstract.length > 0
      ? [
          `abstract keywords ${matchedAbstract.sort().join(", ")} (+${abstractKeyword})`,
        ]
      : []),
    ...(phrase > 0 ? [`multi-word phrase bonus (+${phrase})`] : []),
    ...(novelty > 0 ? [`novelty evidence (+${novelty})`] : []),
    ...(experimentalRigor > 0
      ? [`experimental rigor evidence (+${experimentalRigor})`]
      : []),
    ...(resultEvidence > 0 ? [`quantitative result evidence (+${resultEvidence})`] : []),
    ...(resourceDisclosure > 0
      ? [`training-resource disclosure (+${resourceDisclosure})`]
      : []),
    ...(matchedNegative.length > 0
      ? [`negative keywords ${matchedNegative.sort().join(", ")} (${negative})`]
      : []),
    `recency ${ageDays} day(s) (+${recency})`,
  ];

  return PaperScoreSchema.parse({
    domainId: domain.id,
    total,
    breakdown,
    matchedKeywords,
    matchedCategories,
    explanation,
    algorithmVersion: SELECTION_ALGORITHM_VERSION,
  });
}

function compareCandidates(left: ScoredPaper, right: ScoredPaper): number {
  return (
    right.score.total - left.score.total ||
    right.paper.announcedOn.localeCompare(left.paper.announcedOn) ||
    right.paper.updatedAt.localeCompare(left.paper.updatedAt) ||
    left.paper.baseArxivId.localeCompare(right.paper.baseArxivId) ||
    left.score.domainId.localeCompare(right.score.domainId)
  );
}

/**
 * Assign each paper to its strongest domain, preserving a full score explanation.
 * Domain-order ties are resolved by stable domain id rather than input order.
 */
export function preRankPapers(
  papers: readonly ArxivPaper[],
  domains: readonly Domain[],
  options: SelectionOptions,
): ScoredPaper[] {
  if (domains.length === 0) return [];
  const uniquePapers = new Map<string, ArxivPaper>();
  for (const paper of papers) {
    const current = uniquePapers.get(paper.baseArxivId);
    if (
      !current ||
      (paper.version ?? 1) > (current.version ?? 1) ||
      ((paper.version ?? 1) === (current.version ?? 1) &&
        paper.updatedAt > current.updatedAt)
    ) {
      uniquePapers.set(paper.baseArxivId, paper);
    }
  }

  const candidates = [...uniquePapers.values()].map((paper): ScoredPaper => {
    const scores = domains
      .map((domain) => scorePaperForDomain(paper, domain, options.asOfDate))
      .sort(
        (left, right) =>
          right.total - left.total ||
          left.domainId.localeCompare(right.domainId),
      );
    return { paper, score: scores[0]! };
  });
  return candidates.sort(compareCandidates).map((candidate, index) => ({
    ...candidate,
    rank: index + 1,
  }));
}

/**
 * Select globally unique papers with a configurable per-domain quota.
 * Output order is global pre-rank order and is independent of source ordering.
 */
export function selectPapers(
  papers: readonly ArxivPaper[],
  domains: readonly Domain[],
  options: SelectionOptions,
): ScoredPaper[] {
  const ranked = preRankPapers(papers, domains, options);
  const domainLimits = new Map<DomainId, number>(
    domains.map((domain) => [
      domain.id,
      Math.min(options.maxPerDomain ?? 3, domain.maxPapers, 3),
    ]),
  );
  const counts = new Map<DomainId, number>();
  const selected = ranked.filter((candidate) => {
    if (candidate.score.total < (options.minimumScore ?? 1)) return false;
    const domainId = candidate.score.domainId;
    const count = counts.get(domainId) ?? 0;
    if (count >= (domainLimits.get(domainId) ?? 0)) return false;
    counts.set(domainId, count + 1);
    return true;
  });
  return selected.map((candidate, index) => ({
    ...candidate,
    rank: index + 1,
  }));
}
