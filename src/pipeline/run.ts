import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AgentClient, RunBudget, type UsageSnapshot } from "../agents/client.js";
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
  type PaperSummary,
  type ScoredPaper,
} from "../schema/report.js";
import {
  ArxivClient,
  dedupeArxivPapers,
  downloadPdf,
  extractPdfText,
} from "../sources/arxiv.js";
import { OpenAlexClient } from "../sources/openalex.js";
import { debateIdea, type DebateOutcome } from "./debate.js";
import {
  developIdea,
  type IdeaCheckpoint,
  type IdeaResult,
  type PriorArtSearch,
} from "./ideas.js";
import { selectPapers } from "./select.js";
import { summarizePapers } from "./summarize.js";

interface DomainCheckpoint {
  summaries: PaperSummary[];
  idea?: IdeaResult;
  ideaProgress?: IdeaCheckpoint;
  debate?: DebateOutcome;
}

interface DailyCheckpoint {
  version: 1;
  date: string;
  inputHash: string;
  status: "running" | "complete";
  domains: Partial<Record<DomainId, DomainCheckpoint>>;
  budget: UsageSnapshot;
  report?: DailyReport;
  updatedAt: string;
}

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

function inputHash(options: DailyRunOptions): string {
  return createHash("sha256")
    .update(stable({
      date: options.date,
      domains: options.domains,
      papers: options.papers,
    }))
    .digest("hex");
}

async function executeDailyRun(options: DailyRunOptions): Promise<DailyReport> {
  if (!options.apiKey.trim()) throw new Error("CURSOR_API_KEY is required.");
  const now = options.now ?? (() => new Date());
  const hash = inputHash(options);
  const store =
    options.checkpointStore ??
    new FileCheckpointStore(join(options.cwd ?? process.cwd(), "data", "checkpoints"));
  const existing = await store.load(options.date);
  if (existing && existing.inputHash !== hash) {
    throw new Error(`Checkpoint inputs changed for ${options.date}; remove its checkpoint to restart.`);
  }
  if (existing?.status === "complete" && existing.report) {
    return DailyReportSchema.parse(existing.report);
  }

  const budget = new RunBudget(
    { maxRuns: 120, maxTokens: 3_000_000 },
    existing?.budget,
  );
  const models =
    options.resolvedModels ??
    (await resolveFlagshipModels({
      apiKey: options.apiKey,
      configured: options.configuredModels,
    }));
  const client = new AgentClient({
    apiKey: options.apiKey,
    cwd: options.cwd ?? process.cwd(),
    budget,
  });
  const state: DailyCheckpoint = existing ?? {
    version: 1,
    date: options.date,
    inputHash: hash,
    status: "running",
    domains: {},
    budget: budget.snapshot(),
    updatedAt: now().toISOString(),
  };
  const persist = async (): Promise<void> => {
    state.budget = budget.snapshot();
    state.updatedAt = now().toISOString();
    await store.save(options.date, state);
  };

  const domainResearch: DomainResearch[] = [];
  const reportPapers: DailyReport["papers"] = [];
  const warnings: string[] = [];

  for (const domain of options.domains) {
    const selected = options.papers.filter((item) => item.score.domainId === domain.id);
    if (selected.length === 0) {
      warnings.push(`${domain.name}: no qualifying papers`);
      continue;
    }
    if (selected.length < domain.maxPapers) {
      warnings.push(`${domain.name}: selected ${selected.length}/${domain.maxPapers} papers`);
    }

    const domainState = state.domains[domain.id] ?? { summaries: [] };
    state.domains[domain.id] = domainState;
    if (domainState.summaries.length < selected.length) {
      const remaining = selected.slice(domainState.summaries.length).map(({ paper }) => ({
        ...paper,
        fullText: options.paperTexts?.[paper.baseArxivId],
      }));
      await summarizePapers({
        client,
        model: models.claude,
        papers: remaining,
        idempotencyPrefix: `${options.date}:${domain.id}`,
        onSummary: async (summary) => {
          domainState.summaries.push(summary);
          await persist();
        },
      });
    }

    if (!domainState.idea) {
      domainState.idea = await developIdea({
        client,
        model: models.openai,
        summaries: domainState.summaries,
        domainName: domain.name,
        searchPriorArt: options.searchPriorArt,
        idempotencyPrefix: `${options.date}:${domain.id}`,
        maxRestarts: 4,
        onCheckpoint: async (progress) => {
          domainState.ideaProgress = progress;
          await persist();
        },
      });
      delete domainState.ideaProgress;
      await persist();
    }

    if (!domainState.debate) {
      domainState.debate = await debateIdea({
        client,
        idea: domainState.idea.idea,
        references: domainState.idea.ledger,
        advocateModel: models.claude,
        skepticModel: models.openai,
        moderatorModel: models.claude,
        idempotencyPrefix: `${options.date}:${domain.id}`,
        onRound: persist,
      });
      await persist();
    }

    const references = domainState.idea.ledger.map((entry) => entry.reference);
    domainResearch.push({
      domainId: domain.id,
      idea: domainState.debate.result.finalIdea,
      refinements: domainState.idea.refinementHistory,
      debate: domainState.debate.result,
      references,
      restarts: domainState.idea.restarts,
      debateRounds: domainState.debate.rounds,
    });

    selected.forEach((item, index) => {
      reportPapers.push({
        paper: item.paper,
        score: item.score,
        summary: domainState.summaries[index]!,
        ideas: [],
        refinements: [],
        references: [],
        provenance: [
          {
            stage: "summarization",
            source: "Cursor SDK",
            retrievedAt: now().toISOString(),
            model: models.claude.id,
            promptVersion: "paper-summary-v2",
            notes: [],
          },
        ],
      });
    });
  }

  const report = DailyReportSchema.parse({
    schemaVersion: "1.0",
    reportDate: options.date,
    generatedAt: now().toISOString(),
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
          `Models: Claude=${models.claude.id}; OpenAI=${models.openai.id}`,
          `Usage: ${budget.snapshot().runs} runs, ${budget.snapshot().totalTokens} tokens`,
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
  const fetched = dedupeArxivPapers(await arxiv.fetchRss(categories));
  const date =
    requestedDate ??
    fetched.map((paper) => paper.announcedOn).sort().at(-1);
  if (!date) {
    console.log("No arXiv announcement is currently available.");
    return;
  }
  const papers = fetched.filter((paper) => paper.announcedOn === date);
  if (papers.length === 0) {
    console.log(`No arXiv papers found for ${date}.`);
    return;
  }

  const outputPath = join(cwd, "data", "reports", `${date}.json`);
  if (await exists(outputPath)) {
    console.log(`Report ${date} already exists; nothing to do.`);
    return;
  }
  const selected = selectPapers(papers, DOMAINS, {
    asOfDate: date,
    minimumScore: 2,
    maxPerDomain: 3,
  });
  if (selected.length === 0) {
    console.log(`No papers met the relevance threshold for ${date}.`);
    return;
  }

  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) throw new Error("CURSOR_API_KEY is required once new papers are selected.");
  const paperTexts: Record<string, string> = {};
  for (const [index, item] of selected.entries()) {
    if (index > 0) await sleep(3_100);
    try {
      const bytes = await downloadPdf(item.paper.pdfUrl, {
        userAgent: process.env.ARXIV_USER_AGENT,
      });
      paperTexts[item.paper.baseArxivId] = await extractPdfText(bytes, {
        maxPages: Number(process.env.MAX_PDF_PAGES ?? 40),
      });
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
    searchPriorArt: async (query) =>
      openAlex.searchPriorArt({
        title: query,
        beforeYear: Number(date.slice(0, 4)),
        maxResults: 10,
      }),
  });
  await mkdir(dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await rename(temporary, outputPath);
  console.log(`Wrote ${outputPath}`);
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
