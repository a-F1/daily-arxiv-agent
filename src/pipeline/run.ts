import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pLimit from "p-limit";
import { AgentClient, RunBudget, type UsageSnapshot } from "../agents/client.js";
import { PROMPT_VERSION, reviseRejectedIdeaPrompt } from "../agents/prompts.js";
import {
  resolveFlagshipModels,
  type FlagshipModelConfig,
  type ResolvedModels,
} from "../agents/models.js";
import { DOMAINS } from "../domains.js";
import {
  DailyReportSchema,
  type DailyReport,
  type Domain,
  type DomainId,
  type DomainResearch,
  type ExclusionSummary,
  type ExcludedTopicReasonCode,
  type ArxivPaper,
  type PaperSummary,
  type ResearchIdea,
  ChineseResearchIdeaSchema,
  type SelectionPolicy,
  type ScoredPaper,
} from "../schema/report.js";
import {
  ArxivClient,
  dedupeArxivPapers,
  downloadPdf,
  extractPdfText,
  compressPaperText,
  filterArxivReleaseBatch,
} from "../sources/arxiv.js";
import { OpenAlexClient } from "../sources/openalex.js";
import {
  debateIdea,
  type DebateCheckpoint,
  type DebateOutcome,
} from "./debate.js";
import {
  developIdea,
  type IdeaCheckpoint,
  type IdeaResult,
  type PriorArtSearch,
} from "./ideas.js";
import {
  classifyExcludedTopic,
  selectPapers,
} from "./select.js";
import { summarizePapers } from "./summarize.js";

interface DomainCheckpoint {
  summaries: Record<string, PaperSummary>;
  idea?: IdeaResult;
  ideaProgress?: IdeaCheckpoint;
  debate?: DebateOutcome;
  debateProgress?: DebateCheckpoint;
  debateAttempts?: number;
}

interface DailyCheckpoint {
  version: number;
  date: string;
  inputHash: string;
  status: "running" | "complete";
  domains: Partial<Record<DomainId, DomainCheckpoint>>;
  budget: UsageSnapshot;
  report?: DailyReport;
  updatedAt: string;
}

const PIPELINE_VERSION = "daily-research-v4-hard-topic-exclusions";
const SELECTION_POLICY: SelectionPolicy = {
  source: "arxiv-rss",
  timeZone: "America/New_York",
  dateField: "item.pubDate",
  includedAnnouncementTypes: ["new", "cross"],
  excludedAnnouncementTypes: ["replace", "replace-cross", "unknown"],
  strictSameDay: true,
  maxPerDomain: 3,
  hardExcludedTopicsEnabled: true,
  excludedTopicPolicyVersion: "safety-security-attack-defense-v1",
};

export interface CheckpointStore {
  load(date: string): Promise<DailyCheckpoint | undefined>;
  save(date: string, checkpoint: DailyCheckpoint): Promise<void>;
}

export class FileCheckpointStore implements CheckpointStore {
  constructor(
    private readonly root = join(process.cwd(), "data", "checkpoints"),
  ) {}

  private path(date: string): string {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(`Invalid checkpoint date: ${date}`);
    }
    return join(this.root, `${date}.json`);
  }

  async load(date: string): Promise<DailyCheckpoint | undefined> {
    try {
      return JSON.parse(await readFile(this.path(date), "utf8")) as DailyCheckpoint;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async save(date: string, checkpoint: DailyCheckpoint): Promise<void> {
    const path = this.path(date);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, path);
  }
}

export interface DailyRunOptions {
  date: string;
  domains: readonly Domain[];
  papers: readonly ScoredPaper[];
  paperTexts?: Readonly<Record<string, string>>;
  searchPriorArt: PriorArtSearch;
  apiKey: string;
  cwd?: string;
  configuredModels?: FlagshipModelConfig;
  resolvedModels?: ResolvedModels;
  releaseStatus?: "complete" | "partial";
  selectionPolicy?: SelectionPolicy;
  exclusionSummary?: ExclusionSummary;
  checkpointStore?: CheckpointStore;
  now?: () => Date;
}

const activeDates = new Map<string, Promise<DailyReport>>();

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function textHashes(
  paperTexts: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(paperTexts ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, text]) => [
        id,
        createHash("sha256").update(text).digest("hex"),
      ]),
  );
}

function inputHash(
  options: DailyRunOptions,
  models: ResolvedModels,
  runtimeConfig: Record<string, number>,
): string {
  return createHash("sha256")
    .update(stable({
      pipelineVersion: PIPELINE_VERSION,
      promptVersion: PROMPT_VERSION,
      reportSchemaVersion: "1.0",
      date: options.date,
      domains: options.domains,
      papers: options.papers,
      paperTexts: textHashes(options.paperTexts),
      models,
      runtimeConfig,
    }))
    .digest("hex");
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

async function executeDailyRun(options: DailyRunOptions): Promise<DailyReport> {
  if (!options.apiKey.trim()) throw new Error("CURSOR_API_KEY is required.");
  const now = options.now ?? (() => new Date());
  const models =
    options.resolvedModels ??
    (await resolveFlagshipModels({
      apiKey: options.apiKey,
      configured: options.configuredModels,
    }));
  const runtimeConfig = {
    modelConcurrency: positiveIntegerEnv("MODEL_CONCURRENCY", 3),
    domainConcurrency: positiveIntegerEnv("DOMAIN_CONCURRENCY", 3),
    summaryConcurrency: positiveIntegerEnv("SUMMARY_CONCURRENCY", 3),
    modelTimeoutMs: positiveIntegerEnv("MODEL_TIMEOUT_MS", 600_000),
    maxPaperTextChars: positiveIntegerEnv("MAX_PAPER_TEXT_CHARS", 40_000),
    debateMinRounds: Math.max(3, positiveIntegerEnv("DEBATE_MIN_ROUNDS", 3)),
    debateMaxRounds: Math.min(5, positiveIntegerEnv("DEBATE_MAX_ROUNDS", 3)),
  };
  if (runtimeConfig.debateMinRounds > runtimeConfig.debateMaxRounds) {
    throw new Error(
      "DEBATE_MIN_ROUNDS must not exceed DEBATE_MAX_ROUNDS after enforcing the 3-5 round bounds.",
    );
  }
  const hash = inputHash(options, models, runtimeConfig);
  const store =
    options.checkpointStore ??
    new FileCheckpointStore(join(options.cwd ?? process.cwd(), "data", "checkpoints"));
  const loaded = await store.load(options.date);
  const existing =
    loaded?.version === 2 && loaded.inputHash === hash ? loaded : undefined;
  if (loaded && !existing) {
    console.warn(
      JSON.stringify({
        event: "checkpoint_ignored",
        date: options.date,
        reason: loaded.version !== 2 ? "version_changed" : "inputs_changed",
      }),
    );
  }
  if (existing?.status === "complete" && existing.report) {
    return DailyReportSchema.parse(existing.report);
  }

  const budget = new RunBudget(
    {
      maxRuns: positiveIntegerEnv("MAX_DAILY_RUNS", 180),
      maxTokens: positiveIntegerEnv("MAX_DAILY_TOKENS", 10_000_000),
    },
    existing?.budget,
  );
  const state: DailyCheckpoint = existing ?? {
    version: 2,
    date: options.date,
    inputHash: hash,
    status: "running",
    domains: {},
    budget: budget.snapshot(),
    updatedAt: now().toISOString(),
  };
  let persistQueue = Promise.resolve();
  const persist = async (): Promise<void> => {
    state.budget = budget.snapshot();
    state.updatedAt = now().toISOString();
    const snapshot = structuredClone(state);
    persistQueue = persistQueue.then(() => store.save(options.date, snapshot));
    await persistQueue;
  };
  const client = new AgentClient({
    apiKey: options.apiKey,
    cwd: options.cwd ?? process.cwd(),
    budget,
    maxConcurrency: runtimeConfig.modelConcurrency,
    timeoutMs: runtimeConfig.modelTimeoutMs,
    onUsage: async () => persist(),
  });

  interface DomainOutput {
    research?: DomainResearch;
    papers: DailyReport["papers"];
    warnings: string[];
  }
  const domainLimit = pLimit(runtimeConfig.domainConcurrency);
  const outputs = await Promise.all(
    options.domains.map((domain) =>
      domainLimit(async (): Promise<DomainOutput> => {
        const selected = options.papers.filter(
          (item) => item.score.domainId === domain.id,
        );
        if (selected.length === 0) {
          return {
            papers: [],
            warnings: [`${domain.name}: no qualifying papers`],
          };
        }
        const domainWarnings =
          selected.length < domain.maxPapers
            ? [`${domain.name}: selected ${selected.length}/${domain.maxPapers} papers`]
            : [];
        const domainState = state.domains[domain.id] ?? { summaries: {} };
        state.domains[domain.id] = domainState;

        const remaining = selected
          .filter(({ paper }) => !domainState.summaries[paper.baseArxivId])
          .map(({ paper }) => {
            const fullText = options.paperTexts?.[paper.baseArxivId];
            return {
              ...paper,
              ...(fullText
                ? {
                    fullText: compressPaperText(
                      fullText,
                      runtimeConfig.maxPaperTextChars,
                    ),
                  }
                : {}),
            };
          });
        if (remaining.length > 0) {
          await summarizePapers({
            client,
            model: models.summary,
            papers: remaining,
            domainId: domain.id,
            concurrency: runtimeConfig.summaryConcurrency,
            idempotencyPrefix: `${options.date}:${domain.id}`,
            onSummary: async (summary, paper) => {
              const paperId = String(paper.baseArxivId ?? paper.arxivId);
              domainState.summaries[paperId] = summary;
              await persist();
            },
          });
        }
        const orderedSummaries = selected.map(({ paper }) => {
          const summary = domainState.summaries[paper.baseArxivId];
          if (!summary) throw new Error(`Missing summary for ${paper.baseArxivId}.`);
          return summary;
        });

        if (!domainState.idea) {
          domainState.idea = await developIdea({
            client,
            model: models.idea,
            summaries: orderedSummaries,
            domainName: domain.name,
            searchPriorArt: options.searchPriorArt,
            idempotencyPrefix: `${options.date}:${domain.id}:idea`,
            maxRestarts: 1,
            maxReferences: 30,
            initialCheckpoint: domainState.ideaProgress,
            domainId: domain.id,
            candidate: 0,
            onCheckpoint: async (progress) => {
              domainState.ideaProgress = progress;
              await persist();
            },
          });
          delete domainState.ideaProgress;
          await persist();
        }

        while ((domainState.debateAttempts ?? 0) < 2) {
          const attempt = domainState.debateAttempts ?? 0;
          if (!domainState.debate) {
            domainState.debate = await debateIdea({
              client,
              idea: domainState.idea.idea,
              references: domainState.idea.ledger,
              initialCheckpoint: domainState.debateProgress,
              advocateModel: models.claude,
              skepticModel: models.openai,
              moderatorModel: models.claude,
              idempotencyPrefix: `${options.date}:${domain.id}:debate:${attempt}`,
              domainId: domain.id,
              candidate: attempt,
              minRounds: runtimeConfig.debateMinRounds,
              maxRounds: runtimeConfig.debateMaxRounds,
              onCheckpoint: async (progress) => {
                domainState.debateProgress = structuredClone(progress);
                await persist();
              },
            });
            delete domainState.debateProgress;
            await persist();
          }
          if (domainState.debate.result.approved) break;
          if (attempt >= 1) break;

          const revisedIdea: ResearchIdea = await client.promptJson({
            prompt: reviseRejectedIdeaPrompt({
              draft: domainState.idea.idea,
              debate: {
                consensus: domainState.debate.result.consensus,
                unresolvedQuestions:
                  domainState.debate.result.unresolvedQuestions,
              },
              references: domainState.idea.ledger,
            }),
            schema: ChineseResearchIdeaSchema,
            model: models.idea,
            idempotencyKey: `${options.date}:${domain.id}:targeted-revision`,
            context: {
              stage: "refinement",
              domainId: domain.id,
              candidate: attempt + 1,
              role: "debate-feedback",
            },
          });
          domainState.idea = { ...domainState.idea, idea: revisedIdea };
          domainState.debateAttempts = attempt + 1;
          delete domainState.debate;
          delete domainState.debateProgress;
          await persist();
        }
        if (!domainState.debate?.result.approved) {
          throw new Error(
            `${domain.name}: proposal did not pass debate after one targeted revision.`,
          );
        }

        const references = domainState.idea.ledger.map(
          (entry) => entry.reference,
        );
        const research: DomainResearch = {
          domainId: domain.id,
          idea: domainState.debate.result.finalIdea,
          refinements: domainState.idea.refinementHistory,
          debate: domainState.debate.result,
          references,
          restarts: domainState.idea.restarts,
          debateRounds: domainState.debate.rounds,
        };
        const papers: DailyReport["papers"] = selected.map((item) => ({
          paper: item.paper,
          score: item.score,
          summary: domainState.summaries[item.paper.baseArxivId]!,
          ideas: [],
          refinements: [],
          references: [],
          provenance: [
            {
              stage: "summarization",
              source: "Cursor SDK",
              retrievedAt: now().toISOString(),
              model: models.summary.id,
              promptVersion: PROMPT_VERSION,
              notes: [],
            },
          ],
        }));
        return { research, papers, warnings: domainWarnings };
      }),
    ),
  );
  const domainResearch = outputs.flatMap((output) =>
    output.research ? [output.research] : [],
  );
  const reportPapers = outputs.flatMap((output) => output.papers);
  const warnings = outputs.flatMap((output) => output.warnings);

  const report = DailyReportSchema.parse({
    schemaVersion: "1.0",
    reportDate: options.date,
    generatedAt: now().toISOString(),
    releaseStatus: options.releaseStatus ?? "complete",
    selectionPolicy: options.selectionPolicy ?? SELECTION_POLICY,
    exclusionSummary: options.exclusionSummary,
    domains: options.domains,
    papers: reportPapers,
    domainResearch,
    provenance: [
      {
        stage: "ingestion",
        source: "arXiv RSS/API",
        retrievedAt: now().toISOString(),
        inputHash: hash,
        notes: [
          `严格使用 ${options.date} 的 arXiv 发布批次（America/New_York）；item.pubDate 必须等于 reportDate；只纳入 new/cross，排除 replace/replace-cross`,
          `硬排除 safety/security/attack/defense 主题；共排除 ${options.exclusionSummary?.totalExcluded ?? 0} 篇，reason code 统计：${JSON.stringify(options.exclusionSummary?.byReason ?? {})}`,
          `模型：摘要=${models.summary.id}；研究构想=${models.idea.id}；辩论 Claude=${models.claude.id}；辩论 OpenAI=${models.openai.id}`,
          `用量：${budget.snapshot().runs} 次调用，${budget.snapshot().totalTokens} 个 token`,
          `流水线版本：${PIPELINE_VERSION}；提示词版本：${PROMPT_VERSION}`,
        ],
      },
    ],
    warnings,
  });
  state.report = report;
  state.status = "complete";
  await persist();
  return report;
}

export function runDailyPipeline(options: DailyRunOptions): Promise<DailyReport> {
  const key = `${options.cwd ?? process.cwd()}:${options.date}`;
  const active = activeDates.get(key);
  if (active) return active;
  const run = executeDailyRun(options).finally(() => activeDates.delete(key));
  activeDates.set(key, run);
  return run;
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function writeReport(path: string, report: DailyReport): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await rename(temporary, path);
  console.log(`Wrote ${path}`);
}

function releaseCoverage(
  selected: readonly ScoredPaper[],
): { status: "complete" | "partial"; warnings: string[] } {
  const counts = new Map<DomainId, number>();
  for (const item of selected) {
    counts.set(item.score.domainId, (counts.get(item.score.domainId) ?? 0) + 1);
  }
  const warnings = DOMAINS.flatMap((domain) => {
    const count = counts.get(domain.id) ?? 0;
    return count < SELECTION_POLICY.maxPerDomain
      ? [`${domain.name}：严格同日发布论文入选 ${count}/${SELECTION_POLICY.maxPerDomain} 篇，缺少 ${SELECTION_POLICY.maxPerDomain - count} 篇。`]
      : [];
  });
  return { status: warnings.length > 0 ? "partial" : "complete", warnings };
}

export function applyHardTopicExclusions(
  papers: readonly ArxivPaper[],
): { eligible: ArxivPaper[]; summary: ExclusionSummary } {
  const eligible: ArxivPaper[] = [];
  const byReason: Partial<Record<ExcludedTopicReasonCode, number>> = {};
  let totalExcluded = 0;
  for (const paper of papers) {
    const decision = classifyExcludedTopic(paper);
    if (!decision.excluded) {
      eligible.push(paper);
      continue;
    }
    totalExcluded += 1;
    console.log(JSON.stringify({
      event: "paper_hard_excluded",
      paperId: paper.baseArxivId,
      reasonCodes: decision.reasonCodes,
      matchedEvidence: decision.matchedEvidence,
    }));
    for (const reason of decision.reasonCodes) {
      byReason[reason] = (byReason[reason] ?? 0) + 1;
    }
  }
  return { eligible, summary: { totalExcluded, byReason } };
}

function emptyReleaseReport(
  date: string,
  releaseCount: number,
  generatedAt: string,
  exclusionSummary: ExclusionSummary = {
    totalExcluded: 0,
    byReason: {},
  },
): DailyReport {
  const noRelease = releaseCount === 0;
  return DailyReportSchema.parse({
    schemaVersion: "1.0",
    reportDate: date,
    generatedAt,
    releaseStatus: noRelease ? "no-release" : "partial",
    selectionPolicy: SELECTION_POLICY,
    exclusionSummary,
    domains: DOMAINS,
    papers: [],
    domainResearch: [],
    provenance: [
      {
        stage: "ingestion",
        source: "arXiv RSS",
        retrievedAt: generatedAt,
        notes: [
          `严格使用 ${date} 的 arXiv 发布批次（America/New_York）；item.pubDate 必须等于 reportDate；只纳入 new/cross，排除 replace/replace-cross`,
          `官方同日发布公告数量：${releaseCount}`,
          `硬排除主题论文数量：${exclusionSummary.totalExcluded}；reason code 统计：${JSON.stringify(exclusionSummary.byReason)}`,
        ],
      },
    ],
    warnings: noRelease
      ? [`arXiv 在 ${date} 没有发布 new/cross 类型的新论文公告。`]
      : exclusionSummary.totalExcluded === releaseCount
        ? [`${date} 的同日发布候选全部命中 safety/security/attack/defense 硬排除规则；未使用被排除论文回填。`]
        : [`${date} 的剩余同日发布论文均未达到当前领域相关性阈值。`],
  });
}

export async function runCli(): Promise<void> {
  const cwd = process.cwd();
  const requestedDate = argument("--date") ?? (process.env.REPORT_DATE || undefined);
  if (requestedDate && !/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
    throw new Error("--date must be YYYY-MM-DD");
  }

  const arxiv = new ArxivClient({
    userAgent:
      process.env.ARXIV_USER_AGENT ??
      "daily-arxiv-agent/0.1 (+https://github.com/a-F1/daily-arxiv-agent)",
  });
  const categories = [...new Set(DOMAINS.flatMap((domain) => domain.categories))];
  const batch = await arxiv.fetchRssBatch(categories);
  if (requestedDate && requestedDate !== batch.announcementDate) {
    throw new Error(
      `Official RSS currently exposes the ${batch.announcementDate} announcement batch, not requested ${requestedDate}; refusing to infer a historical release date.`,
    );
  }
  const fetched = dedupeArxivPapers(batch.papers);
  const date = requestedDate ?? batch.announcementDate;
  if (!date) {
    console.log("No arXiv announcement is currently available.");
    return;
  }
  const outputPath = join(cwd, "data", "reports", `${date}.json`);
  if (await exists(outputPath)) {
    console.log(`Report ${date} already exists; nothing to do.`);
    return;
  }
  const papers = filterArxivReleaseBatch(fetched, date);
  if (papers.length === 0) {
    await writeReport(outputPath, emptyReleaseReport(date, 0, new Date().toISOString()));
    return;
  }
  const exclusions = applyHardTopicExclusions(papers);
  const selected = selectPapers(exclusions.eligible, DOMAINS, {
    asOfDate: date,
    minimumScore: 2,
    maxPerDomain: 3,
  });
  if (selected.length === 0) {
    await writeReport(
      outputPath,
      emptyReleaseReport(
        date,
        papers.length,
        new Date().toISOString(),
        exclusions.summary,
      ),
    );
    return;
  }
  const coverage = releaseCoverage(selected);

  const rawApiKey = process.env.CURSOR_API_KEY;
  if (!rawApiKey) {
    throw new Error("CURSOR_API_KEY is required once new papers are selected.");
  }
  const apiKey = rawApiKey.replace(/[^\x21-\x7E]/g, "");
  if (!apiKey) throw new Error("CURSOR_API_KEY contains no usable ASCII characters.");
  if (apiKey !== rawApiKey) {
    console.warn("Removed invisible copy/paste characters from CURSOR_API_KEY.");
  }
  const paperTexts: Record<string, string> = {};
  for (const [index, item] of selected.entries()) {
    if (index > 0) await sleep(3_100);
    try {
      const bytes = await downloadPdf(item.paper.pdfUrl, {
        userAgent: process.env.ARXIV_USER_AGENT,
      });
      const extracted = await extractPdfText(bytes, {
        maxPages: Number(process.env.MAX_PDF_PAGES ?? 40),
      });
      paperTexts[item.paper.baseArxivId] = compressPaperText(
        extracted,
        positiveIntegerEnv("MAX_PAPER_TEXT_CHARS", 40_000),
      );
    } catch (error) {
      console.warn(`PDF extraction failed for ${item.paper.baseArxivId}:`, error);
    }
  }

  const openAlex = new OpenAlexClient({ email: process.env.OPENALEX_EMAIL });
  const report = await runDailyPipeline({
    date,
    domains: DOMAINS,
    papers: selected,
    paperTexts,
    apiKey,
    cwd,
    releaseStatus: coverage.status,
    selectionPolicy: SELECTION_POLICY,
    exclusionSummary: exclusions.summary,
    searchPriorArt: async (query) =>
      openAlex.searchPriorArt({
        title: query,
        beforeYear: Number(date.slice(0, 4)),
        maxResults: 10,
      }),
  });
  const enrichedReport = DailyReportSchema.parse({
    ...report,
    warnings: [...report.warnings, ...coverage.warnings],
  });
  await writeReport(outputPath, enrichedReport);
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === fileURLToPath(pathToFileURL(process.argv[1]));
if (isEntryPoint) {
  runCli().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
