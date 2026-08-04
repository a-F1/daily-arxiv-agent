import {
  Agent,
  type ModelSelection,
  type RunResult,
  type SDKAgent,
} from "@cursor/sdk";
import type { z } from "zod";

export interface UsageSnapshot {
  runs: number;
  totalTokens: number;
  estimatedCostCents: number;
}

export interface GuardLimits {
  maxRuns: number;
  maxTokens: number;
  maxEstimatedCostCents?: number;
  estimateCostCents?: (result: RunResult) => number;
}

export class RunBudget {
  private usage: UsageSnapshot;

  constructor(
    readonly limits: GuardLimits,
    initial: Partial<UsageSnapshot> = {},
  ) {
    if (
      limits.maxEstimatedCostCents !== undefined &&
      !limits.estimateCostCents
    ) {
      throw new Error(
        "A cost estimator is required when maxEstimatedCostCents is configured.",
      );
    }
    this.usage = {
      runs: initial.runs ?? 0,
      totalTokens: initial.totalTokens ?? 0,
      estimatedCostCents: initial.estimatedCostCents ?? 0,
    };
  }

  assertCanRun(): void {
    if (this.usage.runs >= this.limits.maxRuns) {
      throw new Error(`Run budget exhausted at ${this.limits.maxRuns} runs.`);
    }
    if (this.usage.totalTokens >= this.limits.maxTokens) {
      throw new Error(
        `Token budget exhausted at ${this.limits.maxTokens} tokens.`,
      );
    }
    if (
      this.limits.maxEstimatedCostCents !== undefined &&
      this.usage.estimatedCostCents >= this.limits.maxEstimatedCostCents
    ) {
      throw new Error(
        `Estimated cost budget exhausted at ${this.limits.maxEstimatedCostCents} cents.`,
      );
    }
  }

  record(result: RunResult): void {
    this.usage.runs += 1;
    this.usage.totalTokens += result.usage?.totalTokens ?? 0;
    this.usage.estimatedCostCents +=
      this.limits.estimateCostCents?.(result) ?? 0;

    if (
      this.usage.totalTokens > this.limits.maxTokens ||
      (this.limits.maxEstimatedCostCents !== undefined &&
        this.usage.estimatedCostCents >
          this.limits.maxEstimatedCostCents)
    ) {
      throw new Error("The most recent model run exceeded its configured budget.");
    }
  }

  snapshot(): UsageSnapshot {
    return { ...this.usage };
  }
}

export interface AgentClientOptions {
  apiKey: string;
  cwd: string;
  budget: RunBudget;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch (error) {
    throw new Error("Agent returned invalid JSON.", { cause: error });
  }
}

function assertFinished(result: RunResult): string {
  if (result.status !== "finished" || result.result === undefined) {
    throw new Error(
      `Cursor agent run ${result.id} ended with status "${result.status}".`,
    );
  }
  return result.result;
}

export class StructuredAgentSession {
  constructor(
    private readonly agent: SDKAgent,
    private readonly budget: RunBudget,
  ) {}

  async send<T>(
    prompt: string,
    schema: z.ZodType<T>,
    idempotencyKey?: string,
  ): Promise<T> {
    let currentPrompt = prompt;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      this.budget.assertCanRun();
      const run = await this.agent.send(currentPrompt, {
        ...(idempotencyKey ? { idempotencyKey: `${idempotencyKey}:${attempt}` } : {}),
      });
      const result = await run.wait();
      this.budget.record(result);
      try {
        return schema.parse(extractJson(assertFinished(result)));
      } catch (error) {
        lastError = error;
        currentPrompt =
          "Your previous response failed JSON schema validation. Return only a corrected complete JSON object.\n" +
          `Validation error: ${String(error).slice(0, 2_000)}`;
      }
    }
    throw new Error("Agent failed structured output validation twice.", {
      cause: lastError,
    });
  }
}

export class AgentClient {
  constructor(private readonly options: AgentClientOptions) {}

  get budget(): RunBudget {
    return this.options.budget;
  }

  async promptJson<T>(options: {
    prompt: string;
    schema: z.ZodType<T>;
    model: ModelSelection;
    idempotencyKey?: string;
  }): Promise<T> {
    let prompt = options.prompt;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      this.options.budget.assertCanRun();
      const result = await Agent.prompt(prompt, {
        apiKey: this.options.apiKey,
        model: options.model,
        ...(options.idempotencyKey
          ? { idempotencyKey: `${options.idempotencyKey}:${attempt}` }
          : {}),
        local: { cwd: this.options.cwd, settingSources: [] },
      });
      this.options.budget.record(result);
      try {
        return options.schema.parse(extractJson(assertFinished(result)));
      } catch (error) {
        lastError = error;
        prompt =
          `${options.prompt}\n\nYour previous response failed validation. ` +
          `Return only corrected JSON matching every requested field.\n` +
          `Validation error: ${String(error).slice(0, 2_000)}`;
      }
    }
    throw new Error("Agent failed structured output validation twice.", {
      cause: lastError,
    });
  }

  async withSession<T>(options: {
    model: ModelSelection;
    name: string;
    task: (session: StructuredAgentSession) => Promise<T>;
  }): Promise<T> {
    const agent = await Agent.create({
      apiKey: this.options.apiKey,
      model: options.model,
      name: options.name,
      local: { cwd: this.options.cwd, settingSources: [] },
    });
    try {
      return await options.task(
        new StructuredAgentSession(agent, this.options.budget),
      );
    } finally {
      await agent[Symbol.asyncDispose]();
    }
  }
}
