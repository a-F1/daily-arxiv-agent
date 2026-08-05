import type { ModelSelection } from "@cursor/sdk";
import type { z } from "zod";
import pLimit from "p-limit";
import { AgentClient } from "../agents/client.js";
import { summaryPrompt } from "../agents/prompts.js";
import {
  ChinesePaperSummarySchema,
  PaperSummarySchema,
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
      schema: ChinesePaperSummarySchema,
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
