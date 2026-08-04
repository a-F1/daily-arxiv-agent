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
};

export type DomainResearch = {
  domain: string;
  idea: string[];
  refinements: string[];
  debate: string[];
  references: Reference[];
  rounds: number;
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
  const summaryParts = [
    text(summary.oneLiner),
    `Motivation: ${text(summary.motivation, text(summary.problem))}`,
    `Method: ${text(summary.method, text(summary.approach))}`,
    `Experiment setup: ${text(summary.experimentSetup)}`,
    ...keyResults,
    `Training resources: ${text(summary.trainingResources)}`,
  ].filter((part) => !part.endsWith(": "));
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

function normalize(path: string, value: unknown): Report {
  const report = object(value);
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
        ...prose(debate.turns, ["model", "role", "claim"]),
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
  };
}

export const reports = Object.entries(files)
  .map(([path, value]) => normalize(path, value))
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
