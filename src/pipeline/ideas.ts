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
  refinementHistory?: readonly Refinement[];
  totalRefinements?: number;
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
  rejectionFeedback?: unknown;
  searchPriorArt: PriorArtSearch;
  idempotencyPrefix: string;
  maxRestarts?: number;
  maxReferences?: number;
  initialCheckpoint?: IdeaCheckpoint;
  domainId?: string;
  candidate?: number;
  onCheckpoint?: (checkpoint: IdeaCheckpoint) => void | Promise<void>;
}): Promise<IdeaResult> {
  const maxRestarts = options.maxRestarts ?? 2;
  const maxReferences = options.maxReferences ?? 100;
  let resume = options.initialCheckpoint;
  const ledger = new Map<string, ReferenceLedgerEntry>(
    (resume?.ledger ?? []).map((entry) => [referenceKey(entry.reference), {
      reference: entry.reference,
      queries: [...entry.queries],
    }]),
  );
  const refinementHistory: Refinement[] = [
    ...(resume?.refinementHistory ?? []),
  ];
  let totalRefinements = resume?.totalRefinements ?? refinementHistory.length;
  let fallbackIdea: ResearchIdea | undefined = resume?.draft;

  for (
    let restart = resume?.restart ?? 0;
    restart <= maxRestarts;
    restart += 1
  ) {
    let idea: ResearchIdea;
    let firstRefinement = 1;
    const resumingThisRestart = resume?.restart === restart;
    if (resumingThisRestart && resume) {
      idea = resume.draft;
      firstRefinement = Math.max(1, resume.refinement);
    } else {
      idea = await options.client.promptJson({
        prompt: initialIdeaPrompt(
          options.summaries,
          options.domainName,
          options.rejectionFeedback,
        ),
        schema: ResearchIdeaSchema,
        model: options.model,
        idempotencyKey: `${options.idempotencyPrefix}:idea:${restart}:initial`,
        context: {
          stage: "idea",
          domainId: options.domainId,
          candidate: options.candidate,
        },
      });
      await updateLedger({
        idea,
        ledger,
        search: options.searchPriorArt,
        maxReferences,
      });
      await options.onCheckpoint?.({
        restart,
        refinement: 1,
        draft: idea,
        ledger: [...ledger.values()],
        refinementHistory,
        totalRefinements,
      });
    }
    fallbackIdea = idea;
    resume = undefined;

    for (let refinement = firstRefinement; refinement <= 3; refinement += 1) {
      const replacingCheckpointedReview =
        resumingThisRestart &&
        refinementHistory.at(-1)?.round === refinement;
      if (!replacingCheckpointedReview) totalRefinements += 1;
      const review = await options.client.promptJson({
        prompt: refineIdeaPrompt({
          draft: idea,
          references: [...ledger.values()],
          attempt: refinement,
        }),
        schema: RefinementSchema,
        model: options.model,
        idempotencyKey: `${options.idempotencyPrefix}:idea:${restart}:review:${refinement}`,
        context: {
          stage: "refinement",
          domainId: options.domainId,
          candidate: options.candidate,
          round: refinement,
        },
      });
      if (replacingCheckpointedReview) {
        refinementHistory.pop();
      }
      refinementHistory.push(review);
      await options.onCheckpoint?.({
        restart,
        refinement,
        draft: idea,
        review,
        ledger: [...ledger.values()],
        refinementHistory,
        totalRefinements,
      });

      if (review.decision === "reject") break;
      if (
        review.decision === "accept" &&
        review.impactScore >= 4 &&
        review.noveltyScore >= 4 &&
        review.feasibilityScore >= 4 &&
        idea.feasible
      ) {
        return {
          idea,
          ledger: [...ledger.values()],
          refinementHistory,
          restarts: restart,
          refinements: totalRefinements,
        };
      }
      if (refinement === 3) break;

      idea = await options.client.promptJson({
        prompt: finalizeIdeaPrompt({
          draft: idea,
          refinement: review,
          references: [...ledger.values()],
        }),
        schema: ResearchIdeaSchema,
        model: options.model,
        idempotencyKey: `${options.idempotencyPrefix}:idea:${restart}:revise:${refinement}`,
        context: {
          stage: "refinement",
          domainId: options.domainId,
          candidate: options.candidate,
          round: refinement,
          role: "revision",
        },
      });
      await updateLedger({
        idea,
        ledger,
        search: options.searchPriorArt,
        maxReferences,
      });
      fallbackIdea = idea;
      await options.onCheckpoint?.({
        restart,
        refinement: refinement + 1,
        draft: idea,
        ledger: [...ledger.values()],
        refinementHistory,
        totalRefinements,
      });
    }
  }

  if (fallbackIdea) {
    return {
      idea: fallbackIdea,
      ledger: [...ledger.values()],
      refinementHistory,
      restarts: maxRestarts,
      refinements: totalRefinements,
    };
  }
  throw new Error(
    `No idea passed review after ${maxRestarts + 1} bounded candidate attempts.`,
  );
}
