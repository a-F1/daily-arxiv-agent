import type { ModelSelection } from "@cursor/sdk";
import { z } from "zod";
import { AgentClient } from "../agents/client.js";
import {
  debateDecisionPrompt,
  debateTurnPrompt,
} from "../agents/prompts.js";
import {
  DebateSchema,
  DebateTurnSchema,
  ResearchIdeaSchema,
  type Debate,
  type DebateTurn,
  type ResearchIdea,
} from "../schema/report.js";

export interface DebateOutcome {
  turns: DebateTurn[];
  result: Debate;
  rounds: number;
}

const ModeratorDecisionSchema = z
  .object({
    topic: z.string().trim().min(1),
    consensus: z.string().trim().min(1),
    unresolvedQuestions: z.array(z.string().trim().min(1)),
    decision: z.enum(["approve", "revise", "reject", "continue"]),
    finalIdea: ResearchIdeaSchema,
  })
  .strict();

type ModeratorDecision = z.infer<typeof ModeratorDecisionSchema>;

export interface DebateCheckpoint {
  turns: readonly DebateTurn[];
  workingIdea: ResearchIdea;
  decision?: ModeratorDecision;
}

export async function debateIdea(options: {
  client: AgentClient;
  idea: ResearchIdea;
  references?: readonly unknown[];
  initialTurns?: readonly DebateTurn[];
  initialCheckpoint?: DebateCheckpoint;
  advocateModel: ModelSelection;
  skepticModel: ModelSelection;
  moderatorModel?: ModelSelection;
  idempotencyPrefix: string;
  domainId?: string;
  candidate?: number;
  minRounds?: number;
  maxRounds?: number;
  onCheckpoint?: (
    checkpoint: DebateCheckpoint,
  ) => void | Promise<void>;
  onRound?: (
    round: number,
    turns: readonly DebateTurn[],
    decision?: Debate,
  ) => void | Promise<void>;
}): Promise<DebateOutcome> {
  const moderatorModel = options.moderatorModel ?? options.advocateModel;
  const minRounds = options.minRounds ?? 3;
  const maxRounds = options.maxRounds ?? 5;
  if (minRounds < 3 || maxRounds > 5 || minRounds > maxRounds) {
    throw new Error("Debate rounds must satisfy 3 <= minRounds <= maxRounds <= 5.");
  }
  const turns: DebateTurn[] = [
    ...(options.initialCheckpoint?.turns ?? options.initialTurns ?? []),
  ];
  let workingIdea = options.initialCheckpoint?.workingIdea ?? options.idea;

  return options.client.withSession({
    model: options.advocateModel,
    name: `daily-arxiv advocate ${options.idempotencyPrefix}`,
    task: (advocate) =>
      options.client.withSession({
        model: options.skepticModel,
        name: `daily-arxiv skeptic ${options.idempotencyPrefix}`,
        task: async (skeptic) => {
          let finalDecision = options.initialCheckpoint?.decision;
          let completedRounds = 0;
          const checkpointRound = turns.reduce(
            (maximum, turn) => Math.max(maximum, turn.round),
            0,
          );
          if (
            finalDecision &&
            (finalDecision.decision === "approve" ||
              finalDecision.decision === "reject")
          ) {
            const result = DebateSchema.parse({
              topic: finalDecision.topic,
              turns,
              consensus: finalDecision.consensus,
              unresolvedQuestions: finalDecision.unresolvedQuestions,
              approved: finalDecision.decision === "approve",
              finalIdea: finalDecision.finalIdea,
            });
            return { turns, result, rounds: checkpointRound };
          }
          const firstRound = finalDecision ? checkpointRound + 1 : 1;

          for (let round = firstRound; round <= maxRounds; round += 1) {
            let advocateTurn = turns.find(
              (turn) => turn.round === round && turn.role === "advocate",
            );
            if (!advocateTurn) {
              advocateTurn = await advocate.send(
                debateTurnPrompt({
                  role: "advocate",
                  model: options.advocateModel.id,
                  idea: workingIdea,
                  references: options.references,
                  round,
                  history: turns,
                }),
                DebateTurnSchema,
                `${options.idempotencyPrefix}:debate:${round}:advocate`,
                {
                  stage: "debate",
                  domainId: options.domainId,
                  candidate: options.candidate,
                  round,
                  role: "advocate",
                },
              );
              turns.push(advocateTurn);
              await options.onCheckpoint?.({ turns, workingIdea });
            }

            let skepticTurn = turns.find(
              (turn) => turn.round === round && turn.role === "skeptic",
            );
            if (!skepticTurn) {
              skepticTurn = await skeptic.send(
                debateTurnPrompt({
                  role: "skeptic",
                  model: options.skepticModel.id,
                  idea: workingIdea,
                  references: options.references,
                  round,
                  history: turns,
                }),
                DebateTurnSchema,
                `${options.idempotencyPrefix}:debate:${round}:skeptic`,
                {
                  stage: "debate",
                  domainId: options.domainId,
                  candidate: options.candidate,
                  round,
                  role: "skeptic",
                },
              );
              turns.push(skepticTurn);
              await options.onCheckpoint?.({ turns, workingIdea });
            }
            completedRounds = round;

            if (round < minRounds) {
              await options.onRound?.(round, turns);
              continue;
            }

            finalDecision = await options.client.promptJson({
              prompt: debateDecisionPrompt({
                idea: workingIdea,
                references: options.references,
                turns,
                round,
                mayExtend: round < maxRounds,
              }),
              schema: ModeratorDecisionSchema,
              model: moderatorModel,
              idempotencyKey: `${options.idempotencyPrefix}:debate:${round}:decision`,
              context: {
                stage: "debate",
                domainId: options.domainId,
                candidate: options.candidate,
                round,
                role: "moderator",
              },
            });
            workingIdea = finalDecision.finalIdea;
            const assembled = DebateSchema.parse({
              topic: finalDecision.topic,
              turns,
              consensus: finalDecision.consensus,
              unresolvedQuestions: finalDecision.unresolvedQuestions,
              approved: finalDecision.decision === "approve",
              finalIdea: finalDecision.finalIdea,
            });
            await options.onCheckpoint?.({
              turns,
              workingIdea,
              decision: finalDecision,
            });
            await options.onRound?.(round, turns, assembled);

            if (
              finalDecision.decision === "approve" ||
              finalDecision.decision === "reject" ||
              round === maxRounds
            ) {
              return { turns, result: assembled, rounds: completedRounds };
            }
          }
          if (!finalDecision) {
            throw new Error("Debate completed without a moderator decision.");
          }
          const result = DebateSchema.parse({
            topic: finalDecision.topic,
            turns,
            consensus: finalDecision.consensus,
            unresolvedQuestions: finalDecision.unresolvedQuestions,
            approved: finalDecision.decision === "approve",
            finalIdea: finalDecision.finalIdea,
          });
          return { turns, result, rounds: completedRounds };
        },
      }),
  });
}
