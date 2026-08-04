import type { ModelSelection } from "@cursor/sdk";
import { AgentClient } from "../agents/client.js";
import {
  finalizeIdeaPrompt,
  initialIdeaPrompt,
  refineIdeaPrompt,
} from "../agents/prompts.js";
import {
  ReferenceSchema,
  RefinementSchema,
  ResearchIdeaSchema,
  type Reference,
  type Refinement,
  type ResearchIdea,
} from "../schema/report.js";
import type { PaperSummary } from "./summarize.js";

export type PriorArtSearch = (query: string) => Promise<readonly unknown[]>;

export interface ReferenceLedgerEntry {
  reference: Reference;
  queries: string[];
}

export interface IdeaCheckpoint {
  restart: number;
  refinement: number;
  draft: ResearchIdea;
  review?: Refinement;
  ledger: readonly ReferenceLedgerEntry[];
}

export interface IdeaResult {
  idea: ResearchIdea;
  ledger: ReferenceLedgerEntry[];
  refinementHistory: Refinement[];
  restarts: number;
  refinements: number;
}

function searchQueries(idea: ResearchIdea): string[] {
  return [
    `"${idea.title}"`,
    idea.hypothesis,
    `${idea.title} ${idea.method[0] ?? ""}`.trim(),
  ];
}

function referenceKey(reference: Reference): string {
  return (
    reference.doi?.toLowerCase() ??
    reference.url?.toLowerCase() ??
    reference.openAlexId?.toLowerCase() ??
    reference.id.toLowerCase()
  );
}

async function updateLedger(options: {
  idea: ResearchIdea;
  ledger: Map<string, ReferenceLedgerEntry>;
  search: PriorArtSearch;
  maxReferences: number;
}): Promise<void> {
  for (const query of searchQueries(options.idea)) {
    const results = await options.search(query);
    for (const raw of results) {
      const reference = ReferenceSchema.parse(raw);
      reference.usedIn = [
        ...new Set([...reference.usedIn, `prior-art query: ${query}`]),
      ];
      const key = referenceKey(reference);
      const current = options.ledger.get(key);
      if (current) {
        if (!current.queries.includes(query)) current.queries.push(query);
      } else {
        options.ledger.set(key, { reference, queries: [query] });
      }
      if (options.ledger.size >= options.maxReferences) return;
    }
  }
}

export async function developIdea(options: {
  client: AgentClient;
  model: ModelSelection;
  summaries: readonly PaperSummary[];
  domainName: string;
  searchPriorArt: PriorArtSearch;
  idempotencyPrefix: string;
  maxRestarts?: number;
  maxReferences?: number;
  onCheckpoint?: (checkpoint: IdeaCheckpoint) => void | Promise<void>;
}): Promise<IdeaResult> {
  const maxRestarts = options.maxRestarts ?? 2;
  const maxReferences = options.maxReferences ?? 100;
  const ledger = new Map<string, ReferenceLedgerEntry>();
  const refinementHistory: Refinement[] = [];
  let totalRefinements = 0;

  for (let restart = 0; restart <= maxRestarts; restart += 1) {
    let idea = await options.client.promptJson({
      prompt: initialIdeaPrompt(options.summaries, options.domainName),
      schema: ResearchIdeaSchema,
      model: options.model,
      idempotencyKey: `${options.idempotencyPrefix}:idea:${restart}:initial`,
    });
    await updateLedger({
      idea,
      ledger,
      search: options.searchPriorArt,
      maxReferences,
    });

    const completed = await options.client.withSession({
      model: options.model,
      name: `daily-arxiv idea ${options.idempotencyPrefix} restart ${restart}`,
      task: async (session) => {
        for (let refinement = 1; refinement <= 3; refinement += 1) {
          totalRefinements += 1;
          const review = await session.send(
            refineIdeaPrompt({
              draft: idea,
              references: [...ledger.values()],
              attempt: refinement,
            }),
            RefinementSchema,
            `${options.idempotencyPrefix}:idea:${restart}:review:${refinement}`,
          );
          refinementHistory.push(review);
          await options.onCheckpoint?.({
            restart,
            refinement,
            draft: idea,
            review,
            ledger: [...ledger.values()],
          });

          if (review.decision === "reject") return undefined;
          if (
            review.decision === "accept" &&
            review.impactScore >= 4 &&
            review.noveltyScore >= 4 &&
            review.feasibilityScore >= 4 &&
            idea.feasible
          ) return idea;
          if (refinement === 3) return undefined;

          idea = await session.send(
            finalizeIdeaPrompt({
              draft: idea,
              refinement: review,
              references: [...ledger.values()],
            }),
            ResearchIdeaSchema,
            `${options.idempotencyPrefix}:idea:${restart}:revise:${refinement}`,
          );
          await updateLedger({
            idea,
            ledger,
            search: options.searchPriorArt,
            maxReferences,
          });
        }
        return undefined;
      },
    });

    if (completed) {
      return {
        idea: completed,
        ledger: [...ledger.values()],
        refinementHistory,
        restarts: restart,
        refinements: totalRefinements,
      };
    }
  }

  throw new Error(
    `No idea passed review after ${maxRestarts + 1} bounded candidate attempts.`,
  );
}
