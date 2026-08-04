import type { ModelSelection } from "@cursor/sdk";
import { AgentClient } from "../agents/client.js";
import {
  debateDecisionPrompt,
  debateTurnPrompt,
} from "../agents/prompts.js";
import {
  DebateSchema,
  DebateTurnSchema,
  type Debate,
  type DebateTurn,
  type ResearchIdea,
} from "../schema/report.js";

export interface DebateOutcome {
  turns: DebateTurn[];
  result: Debate;
  rounds: number;
}

function requestsExtension(result: Debate): boolean {
  return !result.approved || result.unresolvedQuestions.length > 0;
}

export async function debateIdea(options: {
  client: AgentClient;
  idea: ResearchIdea;
  references?: readonly unknown[];
  advocateModel: ModelSelection;
  skepticModel: ModelSelection;
  moderatorModel?: ModelSelection;
  idempotencyPrefix: string;
  onRound?: (
    round: number,
    turns: readonly DebateTurn[],
    decision?: Debate,
  ) => void | Promise<void>;
}): Promise<DebateOutcome> {
  const moderatorModel = options.moderatorModel ?? options.advocateModel;
  const turns: DebateTurn[] = [];

  return options.client.withSession({
    model: options.advocateModel,
    name: `daily-arxiv advocate ${options.idempotencyPrefix}`,
    task: (advocate) =>
      options.client.withSession({
        model: options.skepticModel,
        name: `daily-arxiv skeptic ${options.idempotencyPrefix}`,
        task: async (skeptic) => {
          let finalDecision: Debate | undefined;
          let completedRounds = 0;

          for (let round = 1; round <= 5; round += 1) {
            turns.push(
              await advocate.send(
                debateTurnPrompt({
                  role: "advocate",
                  model: options.advocateModel.id,
                  idea: options.idea,
                  references: options.references,
                  round,
                  history: turns,
                }),
                DebateTurnSchema,
                `${options.idempotencyPrefix}:debate:${round}:advocate`,
              ),
            );
            turns.push(
              await skeptic.send(
                debateTurnPrompt({
                  role: "skeptic",
                  model: options.skepticModel.id,
                  idea: options.idea,
                  references: options.references,
                  round,
                  history: turns,
                }),
                DebateTurnSchema,
                `${options.idempotencyPrefix}:debate:${round}:skeptic`,
              ),
            );
            completedRounds = round;

            if (round < 3) {
              await options.onRound?.(round, turns);
              continue;
            }

            finalDecision = await options.client.promptJson({
              prompt: debateDecisionPrompt({
                idea: options.idea,
                references: options.references,
                turns,
                round,
                mayExtend: round < 5,
              }),
              schema: DebateSchema,
              model: moderatorModel,
              idempotencyKey: `${options.idempotencyPrefix}:debate:${round}:decision`,
            });
            await options.onRound?.(round, turns, finalDecision);

            if (round === 5 || !requestsExtension(finalDecision)) break;
          }

          if (!finalDecision) {
            throw new Error("Debate completed without a moderator decision.");
          }
          if (!finalDecision.approved) {
            throw new Error(
              "The proposal did not pass Claude/OpenAI debate after five rounds.",
            );
          }
          return { turns, result: finalDecision, rounds: completedRounds };
        },
      }),
  });
}
