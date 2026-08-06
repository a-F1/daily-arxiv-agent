import type { ModelSelection } from "@cursor/sdk";
import { z } from "zod";
import pLimit from "p-limit";
import { AgentClient } from "../agents/client.js";
import { summaryPrompt } from "../agents/prompts.js";
import {
  ChinesePaperSummarySchema,
  PaperSummarySchema,
  isSimplifiedChineseNarrative,
} from "../schema/report.js";

export type PaperSummary = z.infer<typeof PaperSummarySchema>;

export interface PaperInput {
  id?: string;
  arxivId?: string;
  title: string;
  abstract?: string;
  authors?: unknown[];
  publishedAt?: string;
  url?: string;
  fullText?: string;
  [key: string]: unknown;
}

export function normalizeSummaryOutput(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const normalized = { ...(value as Record<string, unknown>) };
  for (const field of [
    "motivation",
    "method",
    "experimentSetup",
    "results",
    "trainingResources",
    "limitations",
  ]) {
    const raw = normalized[field];
    const items =
      typeof raw === "string"
        ? [raw]
        : Array.isArray(raw)
          ? raw.filter((item): item is string => typeof item === "string")
          : undefined;
    if (!items) continue;
    const chineseItems = items.filter(isSimplifiedChineseNarrative);
    normalized[field] = chineseItems.length > 0 ? chineseItems : items;
  }
  if (Array.isArray(normalized.significance)) {
    const items = normalized.significance.filter(
      (item): item is string =>
        typeof item === "string" && isSimplifiedChineseNarrative(item),
    );
    if (items.length > 0) normalized.significance = items.join("；");
  }
  return normalized;
}

const GeneratedPaperSummarySchema = z.preprocess(
  normalizeSummaryOutput,
  ChinesePaperSummarySchema,
);

export async function summarizePapers(options: {
  client: AgentClient;
  model: ModelSelection;
  papers: readonly PaperInput[];
  idempotencyPrefix: string;
  domainId?: string;
  concurrency?: number;
  onSummary?: (
    summary: PaperSummary,
    paper: PaperInput,
    index: number,
  ) => void | Promise<void>;
}): Promise<PaperSummary[]> {
  const limit = pLimit(options.concurrency ?? 3);
  return Promise.all(options.papers.map((paper, index) => limit(async () => {
    const paperId = paper.id ?? paper.arxivId ?? String(index);
    const summary = await options.client.promptJson({
      prompt: summaryPrompt(paper),
      schema: GeneratedPaperSummarySchema,
      model: options.model,
      idempotencyKey: `${options.idempotencyPrefix}:summary:${paperId}`,
      context: {
        stage: "summary",
        domainId: options.domainId,
        paperId: String(paperId),
      },
    });
    await options.onSummary?.(summary, paper, index);
    return summary;
  })));
}
