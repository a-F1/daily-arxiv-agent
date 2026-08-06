import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ModelSelection } from "@cursor/sdk";
import pLimit from "p-limit";
import { AgentClient, RunBudget, type UsageSnapshot } from "../agents/client.js";
import { PROMPT_VERSION } from "../agents/prompts.js";
import { resolveSummaryModel } from "../agents/models.js";
import { DOMAINS } from "../domains.js";
import {
  DailyReportSchema,
  type DailyReport,
  type Domain,
  type DomainId,
  type ExclusionSummary,
  type ExcludedTopicReasonCode,
  type ArxivPaper,
  type PaperSummary,
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
import {
  classifyExcludedTopic,
  selectPapers,
} from "./select.js";
import { summarizePapers } from "./summarize.js";

interface DomainCheckpoint {
  summaries: Record<string, PaperSummary>;
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

const PIPELINE_VERSION = "daily-paper-summary-v6-resumable-budget";
const MAX_SUMMARY_ATTEMPTS_PER_PAPER = 2;
const SELECTION_POLICY: SelectionPolicy = {
  source: "arxiv-rss",
  timeZone: "America/New_York",
  dateField: "item.pubDate",
  includedAnnouncementTypes: ["new", "cross"],
  excludedAnnouncementTypes: ["replace", "replace-cross", "unknown"],
  strictSameDay: true,
  maxPerDomain: 3,
  hardExcludedTopicsEnabled: true,
  excludedTopicPolicyVersion:
    "safety-security-attack-defense-v1+cloud-computing-v1",
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
  apiKey: string;
  cwd?: string;
  configuredSummaryModel?: string;
  resolvedSummaryModel?: ModelSelection;
  releaseStatus?: "complete" | "partial";
  selectionPolicy?: SelectionPolicy;
  exclusionSummary?: ExclusionSummary;
  checkpointStore?: CheckpointStore;
  client?: AgentClient;
  clientFactory?: (
    budget: RunBudget,
    onUsage: () => Promise<void>,
  ) => AgentClient;
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
  summaryModel: ModelSelection,
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
      summaryModel,
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
  const summaryModel =
    options.resolvedSummaryModel ??
    (await resolveSummaryModel({
      apiKey: options.apiKey,
      configured: options.configuredSummaryModel,
    }));
  const runtimeConfig = {
    modelConcurrency: positiveIntegerEnv("MODEL_CONCURRENCY", 3),
    domainConcurrency: positiveIntegerEnv("DOMAIN_CONCURRENCY", 3),
    summaryConcurrency: positiveIntegerEnv("SUMMARY_CONCURRENCY", 3),
    modelTimeoutMs: positiveIntegerEnv("MODEL_TIMEOUT_MS", 600_000),
    maxPaperTextChars: positiveIntegerEnv("MAX_PAPER_TEXT_CHARS", 40_000),
    maxDailyRuns: positiveIntegerEnv("MAX_DAILY_RUNS", 18),
    maxDailyTokens: positiveIntegerEnv("MAX_DAILY_TOKENS", 2_000_000),
    maxSummaryAttemptsPerPaper: MAX_SUMMARY_ATTEMPTS_PER_PAPER,
  };
  const hash = inputHash(options, summaryModel, runtimeConfig);
  const store =
    options.checkpointStore ??
    new FileCheckpointStore(join(options.cwd ?? process.cwd(), "data", "checkpoints"));
  const loaded = await store.load(options.date);
  const existing =
    loaded?.version === 4 && loaded.inputHash === hash ? loaded : undefined;
  if (loaded && !existing) {
    console.warn(
      JSON.stringify({
        event: "checkpoint_ignored",
        date: options.date,
        reason: loaded.version !== 4 ? "version_changed" : "inputs_changed",
      }),
    );
  }
  if (existing?.status === "complete" && existing.report) {
    return DailyReportSchema.parse(existing.report);
  }

  const selectedPaperIds = new Set(
    options.papers.map(({ paper }) => paper.baseArxivId),
  );
  const completedPaperIds = new Set(
    Object.values(existing?.domains ?? {}).flatMap((domain) =>
      Object.keys(domain?.summaries ?? {}).filter((paperId) =>
        selectedPaperIds.has(paperId),
      ),
    ),
  );
  const pendingPaperCount = selectedPaperIds.size - completedPaperIds.size;
  const completedRuns = existing?.budget.runs ?? 0;
  const computedRunBudget =
    completedRuns + pendingPaperCount * MAX_SUMMARY_ATTEMPTS_PER_PAPER;
  const hardRunLimit = runtimeConfig.maxDailyRuns;
  const maxRuns = Math.min(computedRunBudget, hardRunLimit);
  console.log(
    JSON.stringify({
      event: "daily_run_budget",
      date: options.date,
      selectedPapers: selectedPaperIds.size,
      completedPapers: completedPaperIds.size,
      pendingPapers: pendingPaperCount,
      maxAttemptsPerPendingPaper: MAX_SUMMARY_ATTEMPTS_PER_PAPER,
      fixedGenerationOverhead: 0,
      computedRunBudget,
      hardRunLimit,
      effectiveRunBudget: maxRuns,
      restoredUsage: existing?.budget ?? {
        runs: 0,
        totalTokens: 0,
        estimatedCostCents: 0,
      },
    }),
  );
  const budget = new RunBudget(
    {
      maxRuns,
      maxTokens: runtimeConfig.maxDailyTokens,
    },
    existing?.budget,
  );
  const state: DailyCheckpoint = existing ?? {
    version: 4,
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
  const client =
    options.client ??
    options.clientFactory?.(budget, persist) ??
    new AgentClient({
      apiKey: options.apiKey,
      cwd: options.cwd ?? process.cwd(),
      budget,
      maxConcurrency: runtimeConfig.modelConcurrency,
      timeoutMs: runtimeConfig.modelTimeoutMs,
      onUsage: persist,
    });

  const domainLimit = pLimit(runtimeConfig.domainConcurrency);
  const outputs = await Promise.all(
    options.domains.map((domain) =>
      domainLimit(async () => {
        const selected = options.papers.filter(
          (item) => item.score.domainId === domain.id,
        );
        if (selected.length === 0) {
          return {
            papers: [] as DailyReport["papers"],
            warnings: [`${domain.name}：当天没有符合条件的论文。`],
          };
        }
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
            model: summaryModel,
            papers: remaining,
            domainId: domain.id,
            concurrency: runtimeConfig.summaryConcurrency,
            idempotencyPrefix: `${options.date}:${domain.id}:summary`,
            onSummary: async (summary, paper) => {
              domainState.summaries[String(paper.baseArxivId ?? paper.arxivId)] =
                summary;
              await persist();
            },
          });
        }
        const papers: DailyReport["papers"] = selected.map((item) => {
          const summary = domainState.summaries[item.paper.baseArxivId];
          if (!summary) throw new Error(`Missing summary for ${item.paper.baseArxivId}.`);
          return {
            paper: item.paper,
            score: item.score,
            summary,
            ideas: [],
            refinements: [],
            references: [],
            provenance: [
              {
                stage: "summarization",
                source: "Cursor SDK",
                retrievedAt: now().toISOString(),
                model: summaryModel.id,
                promptVersion: PROMPT_VERSION,
                notes: ["仅生成论文精读摘要，不生成研究构想、改进、先前工作检索或模型辩论。"],
              },
            ],
          };
        });
        return {
          papers,
          warnings:
            selected.length < domain.maxPapers
              ? [
                  `${domain.name}：严格同日发布论文入选 ${selected.length}/${domain.maxPapers} 篇，缺少 ${domain.maxPapers - selected.length} 篇。`,
                ]
              : [],
        };
      }),
    ),
  );
  const report = DailyReportSchema.parse({
    schemaVersion: "1.0",
    reportDate: options.date,
    generatedAt: now().toISOString(),
    releaseStatus: options.releaseStatus ?? "complete",
    selectionPolicy: options.selectionPolicy ?? SELECTION_POLICY,
    exclusionSummary: options.exclusionSummary,
    domains: options.domains,
    papers: outputs.flatMap((output) => output.papers),
    domainResearch: [],
    provenance: [
      {
        stage: "ingestion",
        source: "arXiv RSS/API",
        retrievedAt: now().toISOString(),
        inputHash: hash,
        notes: [
          `严格使用 ${options.date} 的 arXiv 发布批次（America/New_York）；item.pubDate 必须等于 reportDate；只纳入 new/cross，排除 replace/replace-cross。`,
          `评分与配额前执行 safety/security/attack/defense 与云计算主题硬排除；分类统计：${JSON.stringify(options.exclusionSummary?.byPolicy ?? { safetySecurity: 0, cloudComputing: 0 })}；reason code：${JSON.stringify(options.exclusionSummary?.byReason ?? {})}。`,
          `仅使用摘要模型 ${summaryModel.id}，每篇论文至多一次摘要调用；不生成 research idea、refinement、prior-art 或 debate。`,
          `用量：${budget.snapshot().runs} 次调用，${budget.snapshot().totalTokens} 个 token。`,
          `流水线版本：${PIPELINE_VERSION}；提示词版本：${PROMPT_VERSION}。`,
        ],
      },
    ],
    warnings: outputs.flatMap((output) => output.warnings),
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
  let safetySecurity = 0;
  let cloudComputing = 0;
  let totalExcluded = 0;
  for (const paper of papers) {
    const decision = classifyExcludedTopic(paper);
    if (!decision.excluded) {
      eligible.push(paper);
      continue;
    }
    totalExcluded += 1;
    if (
      decision.reasonCodes.some((reason) =>
        [
          "CLOUD_COMPUTING_SYSTEMS",
          "SERVERLESS_FAAS",
          "DATACENTER_INFRASTRUCTURE",
          "CHINESE_CLOUD_COMPUTING",
        ].includes(reason),
      )
    ) {
      cloudComputing += 1;
    }
    if (
      decision.reasonCodes.some(
        (reason) =>
          ![
            "CLOUD_COMPUTING_SYSTEMS",
            "SERVERLESS_FAAS",
            "DATACENTER_INFRASTRUCTURE",
            "CHINESE_CLOUD_COMPUTING",
          ].includes(reason),
      )
    ) {
      safetySecurity += 1;
    }
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
  return {
    eligible,
    summary: {
      totalExcluded,
      byReason,
      byPolicy: { safetySecurity, cloudComputing },
    },
  };
}

function emptyReleaseReport(
  date: string,
  releaseCount: number,
  generatedAt: string,
  exclusionSummary: ExclusionSummary = {
    totalExcluded: 0,
    byReason: {},
    byPolicy: { safetySecurity: 0, cloudComputing: 0 },
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
          `评分与配额前执行安全攻防与云计算两类硬排除；分类计数：${JSON.stringify(exclusionSummary.byPolicy ?? { safetySecurity: 0, cloudComputing: 0 })}；reason code：${JSON.stringify(exclusionSummary.byReason)}`,
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
