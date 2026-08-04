import type { ModelSelection } from "@cursor/sdk";
import type { z } from "zod";
import { AgentClient } from "../agents/client.js";
import { summaryPrompt } from "../agents/prompts.js";
import { PaperSummarySchema } from "../schema/report.js";

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
  onSummary?: (
    summary: PaperSummary,
    paper: PaperInput,
    index: number,
  ) => void | Promise<void>;
}): Promise<PaperSummary[]> {
  const summaries: PaperSummary[] = [];
  for (const [index, paper] of options.papers.entries()) {
    const paperId = paper.id ?? paper.arxivId ?? String(index);
    const summary = await options.client.promptJson({
      prompt: summaryPrompt(paper),
      schema: PaperSummarySchema,
      model: options.model,
      idempotencyKey: `${options.idempotencyPrefix}:summary:${paperId}`,
    });
    summaries.push(summary);
    await options.onSummary?.(summary, paper, index);
  }
  return summaries;
}
