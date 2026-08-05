export type Reference = {
  title: string;
  url?: string;
  authors?: string[];
};

export type Paper = {
  id: string;
  title: string;
  titleZh?: string;
  authors: string[];
  domain: string;
  url?: string;
  pdfUrl?: string;
  releaseDate?: string;
  announcementType?: string;
  releaseSourceUrl?: string;
  oneLiner: string;
  motivation: string[];
  method: string[];
  experimentSetup: string[];
  results: string[];
  trainingResources: string[];
  summary: string;
  summaryZh?: string;
  whyItMatters?: string;
  ideas: string[];
  refinements: string[];
  debate: string[];
  references: Reference[];
};

export type Report = {
  date: string;
  generatedAt?: string;
  model?: string;
  query?: string;
  papers: Paper[];
  domainResearch: DomainResearch[];
  releaseStatus: "complete" | "partial" | "no-release";
  selectionPolicy?: string;
  exclusionSummary?: string;
  warnings: string[];
};

export type DomainResearch = {
  domain: string;
  idea: string[];
  refinements: string[];
  debate: string[];
  references: Reference[];
  rounds: number;
  title: string;
  hypothesis: string;
  method: string[];
  evaluation: string[];
  resources: string[];
  contribution: string;
};

const files = import.meta.glob<Record<string, unknown>>("/data/reports/*.json", {
  eager: true,
  import: "default",
});

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function texts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item : text((item as Record<string, unknown>)?.text)))
    .filter(Boolean);
}

function bullets(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  return texts(value);
}

function authorNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) =>
      typeof item === "string"
        ? item
        : text(object(item).name, text(object(item).displayName)),
    )
    .filter(Boolean);
}

function prose(value: unknown, keys: string[]): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === "string") return entry;
      const item = object(entry);
      return keys.map((key) => text(item[key])).filter(Boolean).join(" — ");
    })
    .filter(Boolean);
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function references(value: unknown): Reference[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return { title: item };
      const ref = object(item);
      return {
        title: text(ref.title, text(ref.name)),
        url: text(ref.url, text(ref.link)) || undefined,
        authors: texts(ref.authors),
      };
    })
    .filter((ref) => ref.title);
}

function paper(value: unknown, index: number, domainNames: Map<string, string>): Paper {
  const item = object(value);
  const source = Object.keys(object(item.paper)).length ? object(item.paper) : item;
  const analysis = object(item.analysis);
  const summary = object(item.summary);
  const score = object(item.score);
  const debate = object(item.debate);
  const id = text(source.id, text(source.arxivId, text(source.arxiv_id, `paper-${index + 1}`)));
  const title = text(source.title, "Untitled paper");
  const domainId = text(score.domainId);
  const keyResults = texts(summary.results).length
    ? texts(summary.results)
    : texts(summary.keyResults);
  const motivation = bullets(summary.motivation).length
    ? bullets(summary.motivation)
    : bullets(summary.problem);
  const method = bullets(summary.method).length
    ? bullets(summary.method)
    : bullets(summary.approach);
  const experimentSetup = bullets(summary.experimentSetup);
  const trainingResources = bullets(summary.trainingResources);
  const oneLiner = text(summary.oneLiner);
  const summaryParts = [
    oneLiner,
    ...motivation,
    ...method,
    ...experimentSetup,
    ...keyResults,
    ...trainingResources,
  ].filter(Boolean);
  const ideaList = prose(item.ideas, ["title", "hypothesis", "expectedContribution"]);
  const refinementList = prose(item.refinements, [
    "originalIdeaTitle",
    "revisedHypothesis",
    "rationale",
  ]);
  const debateList = [
    ...prose(debate.turns, ["role", "claim"]),
    text(debate.consensus) ? `共识 — ${text(debate.consensus)}` : "",
    ...texts(debate.unresolvedQuestions).map((question) => `未决问题 — ${question}`),
  ].filter(Boolean);
  return {
    id,
    title,
    titleZh: text(source.titleZh, text(source.title_zh, text(source.chineseTitle))) || undefined,
    authors: authorNames(source.authors),
    domain:
      domainNames.get(domainId) ??
      text(source.domain, text(source.category, text(source.primaryCategory, texts(source.categories)[0] ?? "其他"))),
    url: text(source.url, text(source.absUrl, text(source.arxiv_url))) || undefined,
    pdfUrl: text(source.pdfUrl, text(source.pdf_url)) || undefined,
    releaseDate: text(source.releaseDate, text(source.announcedOn)) || undefined,
    announcementType: text(source.announcementType) || undefined,
    releaseSourceUrl: text(source.releaseSourceUrl) || undefined,
    oneLiner: oneLiner || text(source.summary, text(source.abstract)),
    motivation,
    method,
    experimentSetup,
    results: keyResults,
    trainingResources,
    summary: summaryParts.join(" ") || text(source.summary, text(source.abstract)),
    summaryZh:
      text(source.summaryZh, text(source.summary_zh, text(analysis.summary))) || undefined,
    whyItMatters:
      text(item.whyItMatters, text(item.why_it_matters, text(summary.significance, text(analysis.whyItMatters)))) ||
      undefined,
    ideas: ideaList.length ? ideaList : texts(analysis.ideas),
    refinements: refinementList.length ? refinementList : texts(analysis.refinements),
    debate: debateList.length ? debateList : texts(analysis.debate),
    references: references(item.references).length
      ? references(item.references)
      : references(analysis.references),
  };
}

export function normalizeReport(path: string, value: unknown): Report {
  const report = object(value);
  const selectionPolicy = object(report.selectionPolicy);
  const fromFilename = path.split("/").pop()?.replace(/\.json$/, "") ?? "";
  const domainNames = new Map(
    (Array.isArray(report.domains) ? report.domains : []).map((value) => {
      const domain = object(value);
      return [text(domain.id), text(domain.name)] as const;
    }),
  );
  const rawPapers = Array.isArray(report.papers)
    ? report.papers
    : Array.isArray(report.items)
      ? report.items
      : Array.isArray(report.results)
        ? report.results
        : [];
  const domainResearch = (Array.isArray(report.domainResearch)
    ? report.domainResearch
    : []
  ).map((value): DomainResearch => {
    const item = object(value);
    const idea = object(item.idea);
    const debate = object(item.debate);
    const domainId = text(item.domainId);
    return {
      domain: domainNames.get(domainId) ?? domainId,
      title: text(idea.title),
      hypothesis: text(idea.hypothesis),
      method: texts(idea.method),
      evaluation: texts(idea.evaluation),
      resources: texts(idea.resources).length
        ? texts(idea.resources)
        : [text(idea.resourceAssessment), text(idea.trainingResources)].filter(Boolean),
      contribution: text(idea.expectedContribution),
      idea: [
        text(idea.title),
        text(idea.hypothesis),
        text(idea.expectedContribution),
        text(idea.impactAssessment),
        text(idea.noveltyAssessment),
        text(idea.resourceAssessment),
        text(idea.trainingResources),
      ].filter(Boolean),
      refinements: prose(item.refinements, [
        "originalIdeaTitle",
        "revisedHypothesis",
        "rationale",
      ]),
      debate: [
        ...prose(debate.turns, ["model", "claim"]),
        text(debate.consensus) ? `共识 — ${text(debate.consensus)}` : "",
        ...texts(debate.unresolvedQuestions).map((question) => `未决问题 — ${question}`),
      ].filter(Boolean),
      references: references(item.references),
      rounds: Number(item.debateRounds ?? 0),
    };
  });

  return {
    date: text(report.date, text(report.reportDate, fromFilename)),
    generatedAt: text(report.generatedAt, text(report.generated_at)) || undefined,
    model:
      text(
        report.model,
        (Array.isArray(report.provenance) ? report.provenance : [])
          .map((record) => text(object(record).model))
          .find(Boolean),
      ) || undefined,
    query: text(report.query, text(object(report.provenance).query)) || undefined,
    papers: rawPapers.map((value, index) => paper(value, index, domainNames)),
    domainResearch,
    releaseStatus:
      report.releaseStatus === "no-release" || report.releaseStatus === "partial"
        ? report.releaseStatus
        : "complete",
    selectionPolicy: Object.keys(selectionPolicy).length
      ? `使用 America/New_York 时区下的官方 arXiv RSS item.pubDate；只纳入 new/cross 公告，排除 replace/replace-cross；${selectionPolicy.hardExcludedTopicsEnabled === true ? "在评分与配额前分别硬排除安全攻防主题和云计算 / serverless / 数据中心主题；绝不使用被排除或旧日期论文回填。" : "绝不使用旧日期论文回填。"}`
      : undefined,
    exclusionSummary: Object.keys(object(report.exclusionSummary)).length
      ? `硬排除 ${Number(object(report.exclusionSummary).totalExcluded ?? 0)} 篇（安全攻防 ${Number(object(object(report.exclusionSummary).byPolicy).safetySecurity ?? 0)} 篇，云计算 ${Number(object(object(report.exclusionSummary).byPolicy).cloudComputing ?? 0)} 篇）；reason code：${Object.entries(object(object(report.exclusionSummary).byReason))
          .map(([reason, count]) => `${reason}=${Number(count)}`)
          .join("、") || "无"}`
      : undefined,
    warnings: texts(report.warnings),
  };
}

export const reports = Object.entries(files)
  .map(([path, value]) => normalizeReport(path, value))
  .filter((report) => /^\d{4}-\d{2}-\d{2}$/.test(report.date))
  .sort((a, b) => b.date.localeCompare(a.date));

export const domains = [...new Set(reports.flatMap((report) => report.papers.map((item) => item.domain)))]
  .filter(Boolean)
  .sort((a, b) => a.localeCompare(b, "zh-CN"));

export function reportHref(date: string): string {
  return `${import.meta.env.BASE_URL}reports/${date}/`;
}

export function formatDate(date: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`));
}
