import type { Domain, DomainId } from "../schema/report.js";
import {
  PaperScoreSchema,
  ExcludedTopicReasonCodeSchema,
  type ArxivPaper,
  type ExcludedTopicReasonCode,
  type PaperScore,
  type ScoredPaper,
} from "../schema/report.js";

export const SELECTION_ALGORITHM_VERSION =
  "pre-rank-v4-bias-translation-exclusions";

export const EXCLUDED_TOPIC_REASON_CODES =
  ExcludedTopicReasonCodeSchema.options;

export interface ExcludedTopicDecision {
  excluded: boolean;
  reasonCodes: ExcludedTopicReasonCode[];
  matchedEvidence: string[];
}

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

function matchEvidence(
  value: string,
  patterns: readonly RegExp[],
): string[] {
  return patterns.flatMap((pattern) => {
    const match = value.match(pattern);
    return match?.[0] ? [match[0]] : [];
  });
}

/**
 * Hard topic gate applied before domain scoring.
 *
 * Generic "safe" and "robustness" are deliberately not standalone triggers:
 * they require AI/security context so type safety, resource cleanup, operating
 * ranges, and ordinary statistical robustness remain eligible.
 */
export function classifyExcludedTopic(
  paper: Pick<ArxivPaper, "title" | "abstract" | "categories">,
): ExcludedTopicDecision {
  const title = paper.title.normalize("NFKC").toLocaleLowerCase("en-US");
  const abstract = paper.abstract.normalize("NFKC").toLocaleLowerCase("en-US");
  const combined = `${title}\n${abstract}`;
  const reasons = new Set<ExcludedTopicReasonCode>();
  const evidence = new Set<string>();
  const add = (
    code: ExcludedTopicReasonCode,
    matches: readonly string[],
  ): void => {
    if (matches.length === 0) return;
    reasons.add(code);
    matches.forEach((value) => evidence.add(value));
  };

  add(
    "AI_SAFETY_ALIGNMENT",
    matchEvidence(combined, [
      /\b(?:ai|artificial intelligence|model|llm|language model|agents?|agentic|robot) safety\b/gi,
      /\b(?:safety alignment|safe alignment|alignment safety)\b/gi,
      /\b(?:safe|harmless) (?:ai|llm|language model|agent system|agentic system)\b/gi,
    ]),
  );
  add(
    "AI_SAFETY_ALIGNMENT",
    matchEvidence(title, [
      /\bsafe (?:reinforcement learning|policy learning|control|exploration)\b/gi,
    ]),
  );

  if (paper.categories.some((category) => category.toLowerCase() === "cs.cr")) {
    add("SECURITY_CYBERSECURITY", ["category:cs.CR"]);
  }
  add(
    "SECURITY_CYBERSECURITY",
    matchEvidence(combined, [
      /\bcyber[ -]?security\b/gi,
      /\bsecurity (?:of|for|in) (?:ai|llms?|language models?|agents?|models?|systems?|networks?|software)\b/gi,
    ]),
  );
  add(
    "SECURITY_CYBERSECURITY",
    matchEvidence(title, [
      /\bsecurity\b/gi,
      /\bsecure (?:ai|llm|agent|model|system|inference|training)\b/gi,
    ]),
  );
  if (
    /\bsecurity\b/i.test(abstract) &&
    /\b(?:threat|malicious|vulnerabilit(?:y|ies)|privacy|attack|defen[cs]e|exploit)\b/i.test(
      abstract,
    )
  ) {
    add("SECURITY_CYBERSECURITY", ["security-context"]);
  }

  add(
    "ATTACK_ADVERSARIAL",
    matchEvidence(combined, [
      /\badversarial attacks?\b/gi,
      /\battacks? (?:against|on)\b/gi,
      /\battacks? (?:against|on) (?:ai|llm|language model|agent|model|system|network)\b/gi,
      /\b(?:ai|llm|language model|agent|model|system|network) attacks?\b/gi,
      /\battack surface\b/gi,
    ]),
  );
  add("ATTACK_ADVERSARIAL", matchEvidence(title, [/\battacks?\b/gi]));

  add(
    "JAILBREAK_PROMPT_INJECTION",
    matchEvidence(combined, [
      /\bjailbreak(?:ing|s)?\b/gi,
      /\bprompt injection\b/gi,
      /\bindirect prompt injection\b/gi,
    ]),
  );
  add(
    "POISONING_BACKDOOR",
    matchEvidence(combined, [
      /\b(?:data|model|memory|training|knowledge|retrieval) poison(?:ing|ed)?\b/gi,
      /\bbackdoors?\b/gi,
      /\btrojan attacks?\b/gi,
    ]),
  );

  const securityContext =
    /\b(?:security|cyber|threat|malicious|vulnerabilit(?:y|ies)|attack|adversarial examples?|jailbreak|prompt injection|poison|backdoor|red team)\b/i;
  if (securityContext.test(combined)) {
    add(
      "DEFENSE_MITIGATION",
      matchEvidence(combined, [
        /\bdefen[cs]e\b/gi,
        /\bdefen[cs]e against\b/gi,
        /\battack detection\b/gi,
        /\bthreat detection\b/gi,
        /\b(?:attack|threat|security) mitigation\b/gi,
        /\bguardrails?\b/gi,
        /\b(?:adversarial|attack|security) robustness\b/gi,
      ]),
    );
  }
  add(
    "DEFENSE_MITIGATION",
    matchEvidence(title, [/\bdefen[cs]e\b/gi, /\bguardrails?\b/gi]),
  );
  add(
    "RED_TEAM_EXPLOIT",
    matchEvidence(combined, [
      /\bred[ -]?team(?:ing)?\b/gi,
      /\b(?:security|software|system|model) exploits?\b/gi,
      /\bexploit(?:ation)? of (?:a )?vulnerabilit/gi,
    ]),
  );

  add(
    "CHINESE_SECURITY_TOPIC",
    matchEvidence(combined, [
      /人工智能安全|模型安全|大模型安全|智能体安全|机器人安全|安全对齐|对齐安全/gu,
      /网络安全|信息安全|提示注入|越狱|投毒|后门|红队|攻防|对抗攻击/gu,
    ]),
  );
  add(
    "CHINESE_SECURITY_TOPIC",
    matchEvidence(title, [/攻击|防御/gu]),
  );
  if (
    /安全|威胁|恶意|漏洞|攻击|越狱|投毒|后门/u.test(combined)
  ) {
    add(
      "CHINESE_SECURITY_TOPIC",
      matchEvidence(combined, [/攻击检测|威胁检测|攻击缓解|安全缓解|安全护栏|安全鲁棒性|防御/gu]),
    );
    if (
      /攻击/u.test(combined) &&
      /恶意|威胁|漏洞|对抗|模型|系统|网络|智能体|提示|防御/u.test(combined)
    ) {
      add("CHINESE_SECURITY_TOPIC", ["攻击语境"]);
    }
  }

  add(
    "CLOUD_COMPUTING_SYSTEMS",
    matchEvidence(combined, [
      /\bcloud computing\b/gi,
      /\bcloud systems?\b/gi,
      /\bcloud infrastructure\b/gi,
      /\bcloud platforms?\b/gi,
      /\bcloud resource schedul(?:ing|er)\b/gi,
      /\bcloud workloads?\b/gi,
    ]),
  );
  add(
    "CLOUD_COMPUTING_SYSTEMS",
    matchEvidence(title, [/\bcloud services?\b/gi]),
  );
  if (
    /\bcloud services?\b/i.test(abstract) &&
    /\b(?:architecture|platform|infrastructure|deployment|provisioning|orchestration|scheduling|workload|resource allocation|distributed systems?)\b/i.test(
      abstract,
    )
  ) {
    add("CLOUD_COMPUTING_SYSTEMS", ["cloud-service-system-context"]);
  }
  add(
    "SERVERLESS_FAAS",
    matchEvidence(combined, [
      /\bserverless(?: computing| platforms?| systems?| functions?| workloads?)?\b/gi,
      /\bfunction[- ]as[- ]a[- ]service\b/gi,
      /\bfaas\b/gi,
    ]),
  );
  add(
    "DATACENTER_INFRASTRUCTURE",
    matchEvidence(combined, [
      /\bdata[ -]?centers?\b/gi,
      /\bdatacenter(?:s| infrastructure| networks?| workloads?)?\b/gi,
    ]),
  );
  add(
    "CHINESE_CLOUD_COMPUTING",
    matchEvidence(combined, [
      /云计算|云端计算|云平台|无服务器|云资源调度|云工作负载|数据中心/gu,
    ]),
  );
  if (
    /云服务/u.test(title) ||
    (/云服务/u.test(abstract) &&
      /架构|平台|基础设施|部署|编排|调度|工作负载|资源分配|分布式系统/u.test(
        abstract,
      ))
  ) {
    add("CHINESE_CLOUD_COMPUTING", ["云服务系统语境"]);
  }

  add(
    "BIAS_SEXISM_FAIRNESS",
    matchEvidence(combined, [
      /\b(?:algorithmic|social|societal|gender|racial|race|demographic|cultural) bias(?:es|ed)?\b/gi,
      /\b(?:ai|artificial intelligence|models?|llms?|language models?) (?:bias(?:es|ed)?|fairness)\b/gi,
      /\bbias(?:es)? in (?:ai|artificial intelligence|models?|llms?|language models?)\b/gi,
      /\bsexism\b/gi,
      /\bsexist\b/gi,
      /\b(?:gender|racial|race|demographic) discrimination\b/gi,
      /\b(?:social|gender|racial|cultural) stereotypes?\b/gi,
      /\bde[- ]?bias(?:ing|ed)?\b/gi,
      /\balgorithmic fairness\b/gi,
      /\bfair ai\b/gi,
    ]),
  );
  const nonSocialBiasContext =
    /\b(?:(?:inductive|statistical|estimation|estimator|selection|sampling|measurement|finite[- ]sample|omitted[- ]variable) bias|bias terms?)\b/i;
  const socialOrModelBiasContext =
    /\b(?:social|societal|gender|racial|race|demographic|protected groups?|people|human|annotators?|cultural|sexism|stereotypes?|fairness|discrimination|language models?|llms?|artificial intelligence|ai models?)\b/i;
  if (
    /\bbias(?:es|ed)?\b/i.test(title) &&
    !nonSocialBiasContext.test(title) &&
    socialOrModelBiasContext.test(combined)
  ) {
    add("BIAS_SEXISM_FAIRNESS", ["bias-social-or-model-context"]);
  }
  if (
    /\bfairness\b/i.test(title) &&
    /\b(?:ai|algorithm|model|llm|language model|gender|racial|demographic|social)\b/i.test(
      combined,
    )
  ) {
    add("BIAS_SEXISM_FAIRNESS", ["fairness-social-or-model-context"]);
  }
  add(
    "CHINESE_BIAS_FAIRNESS",
    matchEvidence(combined, [
      /社会偏见|模型偏见|算法偏见|性别偏见|种族偏见|人口偏见|性别歧视|刻板印象|算法公平性|人工智能公平性|模型公平性|去偏(?:见)?/gu,
    ]),
  );
  if (
    /偏见|偏差|公平性|歧视/u.test(title) &&
    /社会|模型|算法|人工智能|大模型|语言模型|性别|种族|人口|文化|群体/u.test(
      combined,
    ) &&
    !/统计偏差|估计偏差|选择偏差|抽样偏差|归纳偏差/u.test(title)
  ) {
    add("CHINESE_BIAS_FAIRNESS", ["偏见公平性社会或模型语境"]);
  }

  add(
    "LANGUAGE_TRANSLATION",
    matchEvidence(combined, [
      /\b(?:machine|neural|multilingual|speech|document(?:-level)?) translation\b/gi,
      /\btranslation (?:quality|evaluation|systems?|models?)\b/gi,
      /\bprofessional translators?\b/gi,
      /\bmt systems?\b/gi,
    ]),
  );
  const nonLanguageTranslationContext =
    /\b(?:translation invariance|translation equivariance|translation[- ]invariant|translation[- ]equivariant|image translation|protein translation|ribosomal translation)\b/i;
  const languageTranslationContext =
    /\b(?:languages?|multilingual|bilingual|cross[- ]lingual|source text|target language|lexical|linguistic|english|chinese|french|spanish|german|bleu|bertscore|wordplay|translator)\b/i;
  if (
    /\btranslat(?:e|es|ed|ing|ion|ions)\b/i.test(title) &&
    languageTranslationContext.test(combined) &&
    !nonLanguageTranslationContext.test(title)
  ) {
    add("LANGUAGE_TRANSLATION", ["translation-language-context"]);
  }
  add(
    "CHINESE_LANGUAGE_TRANSLATION",
    matchEvidence(combined, [
      /机器翻译|神经翻译|多语言翻译|语音翻译|文档翻译|翻译系统|翻译质量|翻译评估/gu,
    ]),
  );

  return {
    excluded: reasons.size > 0,
    reasonCodes: [...reasons].sort(),
    matchedEvidence: [...evidence].sort(),
  };
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
    (right.paper.updatedAt ?? "").localeCompare(left.paper.updatedAt ?? "") ||
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
    if (classifyExcludedTopic(paper).excluded) continue;
    const current = uniquePapers.get(paper.baseArxivId);
    if (
      !current ||
      (paper.version ?? 1) > (current.version ?? 1) ||
      ((paper.version ?? 1) === (current.version ?? 1) &&
        (paper.updatedAt ?? "") > (current.updatedAt ?? ""))
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
