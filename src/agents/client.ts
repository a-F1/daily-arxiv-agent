import {
  Agent,
  CursorSdkError,
  type ModelSelection,
  type Run,
  type RunResult,
  type SDKAgent,
} from "@cursor/sdk";
import { z } from "zod";

export interface UsageSnapshot {
  runs: number;
  totalTokens: number;
  estimatedCostCents: number;
}

export interface RunBudgetStatus extends UsageSnapshot {
  reservedRuns: number;
  reservedTokens: number;
  failedStartedRuns: number;
  consumedRuns: number;
  maxRuns: number;
  maxTokens: number;
}

export interface GuardLimits {
  maxRuns: number;
  maxTokens: number;
  maxEstimatedCostCents?: number;
  estimateCostCents?: (result: RunResult) => number;
}

export class RunBudget {
  private usage: UsageSnapshot;
  private reservedTokens = 0;
  private failedStartedRuns = 0;
  private readonly reservations = new Map<symbol, number>();

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
    if (this.consumedRuns() >= this.limits.maxRuns) {
      throw new Error(`Run budget exhausted at ${this.limits.maxRuns} runs.`);
    }
    if (this.usage.totalTokens + this.reservedTokens >= this.limits.maxTokens) {
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

  reserve(estimatedTokens: number): symbol {
    this.assertCanRun();
    const estimate = Math.max(0, Math.floor(estimatedTokens));
    if (this.usage.totalTokens + this.reservedTokens + estimate > this.limits.maxTokens) {
      throw new Error("The next model run would exceed its configured token budget.");
    }
    const reservation = Symbol("model-run");
    this.reservedTokens += estimate;
    this.reservations.set(reservation, estimate);
    return reservation;
  }

  complete(reservation: symbol, result: RunResult): void {
    const estimate = this.takeReservation(reservation);
    this.reservedTokens -= estimate;
    this.usage.runs += 1;
    this.recordUsage(result);
  }

  release(reservation: symbol, runStarted: boolean): void {
    const estimate = this.takeReservation(reservation);
    this.reservedTokens -= estimate;
    if (runStarted) {
      // Count unknown started attempts only for this process. They protect the
      // live hard limit but are deliberately absent from persisted snapshots,
      // because no completed usage was observed and a later schedule must not
      // inherit a suspended reservation.
      this.failedStartedRuns += 1;
    }
  }

  record(result: RunResult): void {
    this.usage.runs += 1;
    this.recordUsage(result);
  }

  private takeReservation(reservation: symbol): number {
    const estimate = this.reservations.get(reservation);
    if (estimate === undefined) throw new Error("Unknown model budget reservation.");
    this.reservations.delete(reservation);
    return estimate;
  }

  private recordUsage(result: RunResult): void {
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

  status(): RunBudgetStatus {
    return {
      ...this.snapshot(),
      reservedRuns: this.reservations.size,
      reservedTokens: this.reservedTokens,
      failedStartedRuns: this.failedStartedRuns,
      consumedRuns: this.consumedRuns(),
      maxRuns: this.limits.maxRuns,
      maxTokens: this.limits.maxTokens,
    };
  }

  private consumedRuns(): number {
    return this.usage.runs + this.reservations.size + this.failedStartedRuns;
  }
}

export class AsyncSemaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error("Semaphore limit must be a positive integer.");
    }
  }

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.waiters.shift()?.();
    };
  }
}

export interface RunContext {
  stage: "summary" | "idea" | "refinement" | "debate";
  domainId?: string;
  paperId?: string;
  candidate?: number;
  round?: number;
  role?: string;
  schemaAttempt?: number;
}

export interface AgentClientOptions {
  apiKey: string;
  cwd: string;
  budget: RunBudget;
  maxConcurrency?: number;
  timeoutMs?: number;
  heartbeatMs?: number;
  onUsage?: (usage: UsageSnapshot) => void | Promise<void>;
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

class ModelRunTimeoutError extends Error {
  readonly isRetryable = true;
}

function emit(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, timestamp: new Date().toISOString(), ...fields }));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function estimatedRunTokens(prompt: string): number {
  return Math.ceil(prompt.length / 4) + 8_192;
}

export function structuredCorrectionPrompt(
  originalPrompt: string,
  error: unknown,
): string {
  return (
    `${originalPrompt}\n\n上一次响应未通过 JSON schema 或简体中文校验。` +
    "请只返回纠正后的完整 JSON；所有叙述字段必须使用简体中文，字段名和枚举值保持不变。\n" +
    `校验错误：${String(error).slice(0, 2_000)}`
  );
}

async function waitForRun(
  run: Run,
  timeoutMs: number,
  heartbeatMs: number,
  fields: Record<string, unknown>,
): Promise<RunResult> {
  const startedAt = Date.now();
  const heartbeat = setInterval(() => {
    emit("model_run_heartbeat", {
      ...fields,
      runId: run.id,
      elapsedMs: Date.now() - startedAt,
      status: run.status,
    });
  }, heartbeatMs);
  heartbeat.unref();
  let timeout: NodeJS.Timeout | undefined;
  try {
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(async () => {
        if (run.supports("cancel")) {
          void run.cancel().catch(() => {
            // The timeout remains the primary failure.
          });
        }
        reject(new ModelRunTimeoutError(`Model run timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      timeout.unref();
    });
    return await Promise.race([run.wait(), timedOut]);
  } finally {
    clearInterval(heartbeat);
    if (timeout) clearTimeout(timeout);
  }
}

export class StructuredAgentSession {
  constructor(
    private readonly agent: SDKAgent,
    private readonly client: AgentClient,
  ) {}

  async send<T>(
    prompt: string,
    schema: z.ZodType<T>,
    idempotencyKey?: string,
    context: RunContext = { stage: "refinement" },
  ): Promise<T> {
    let currentPrompt = prompt;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await this.client.execute(
        this.agent,
        currentPrompt,
        idempotencyKey ? `${idempotencyKey}:schema:${attempt}` : undefined,
        context,
      );
      const text = assertFinished(result);
      try {
        return schema.parse(extractJson(text));
      } catch (error) {
        lastError = error;
        currentPrompt = structuredCorrectionPrompt(prompt, error);
      }
    }
    throw new Error("Agent failed structured output validation twice.", {
      cause: lastError,
    });
  }
}

export class AgentClient {
  private readonly semaphore: AsyncSemaphore;
  private readonly timeoutMs: number;
  private readonly heartbeatMs: number;

  constructor(private readonly options: AgentClientOptions) {
    this.semaphore = new AsyncSemaphore(options.maxConcurrency ?? 3);
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000;
    this.heartbeatMs = options.heartbeatMs ?? 60_000;
  }

  get budget(): RunBudget {
    return this.options.budget;
  }

  private async createAgent(
    model: ModelSelection,
    name: string,
  ): Promise<SDKAgent> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await Agent.create({
          apiKey: this.options.apiKey,
          model,
          name,
          local: { cwd: this.options.cwd, settingSources: [] },
        });
      } catch (error) {
        const retryable =
          error instanceof CursorSdkError && error.isRetryable && attempt === 0;
        emit("agent_create_error", {
          model: model.id,
          attempt,
          retryable,
          errorType: error instanceof Error ? error.name : "unknown",
        });
        if (!retryable) throw error;
        await delay(1_000 + Math.floor(Math.random() * 500));
      }
    }
    throw new Error("Agent creation failed.");
  }

  async promptJson<T>(options: {
    prompt: string;
    schema: z.ZodType<T>;
    model: ModelSelection;
    idempotencyKey?: string;
    context?: RunContext;
  }): Promise<T> {
    let prompt = options.prompt;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const agent = await this.createAgent(
        options.model,
        `daily-arxiv ${options.context?.stage ?? "structured-output"}`,
      );
      try {
        const result = await this.execute(
          agent,
          prompt,
          options.idempotencyKey
            ? `${options.idempotencyKey}:schema:${attempt}`
            : undefined,
          {
            ...(options.context ?? { stage: "summary" }),
            schemaAttempt: attempt,
          },
        );
        return options.schema.parse(extractJson(assertFinished(result)));
      } catch (error) {
        lastError = error;
        if (
          error instanceof CursorSdkError ||
          error instanceof ModelRunTimeoutError ||
          (error instanceof Error &&
            !(error instanceof z.ZodError) &&
            !error.message.includes("invalid JSON"))
        ) {
          throw error;
        }
        prompt = structuredCorrectionPrompt(options.prompt, error);
      } finally {
        await agent[Symbol.asyncDispose]();
      }
    }
    throw new Error("Agent failed structured output validation twice.", {
      cause: lastError,
    });
  }

  async execute(
    agent: SDKAgent,
    prompt: string,
    idempotencyKey: string | undefined,
    context: RunContext,
  ): Promise<RunResult> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const release = await this.semaphore.acquire();
      let reservation: symbol;
      try {
        reservation = this.options.budget.reserve(estimatedRunTokens(prompt));
      } catch (error) {
        emit("model_run_budget_rejected", {
          ...context,
          model: agent.model?.id,
          attempt,
          budget: this.options.budget.status(),
        });
        release();
        throw error;
      }
      const startedAt = Date.now();
      const fields = {
        ...context,
        model: agent.model?.id,
        attempt,
        promptChars: prompt.length,
      };
      let runStarted = false;
      let reservationSettled = false;
      try {
        const run = await agent.send(prompt, {
          ...(idempotencyKey
            ? { idempotencyKey: `${idempotencyKey}:transport:${attempt}` }
            : {}),
        });
        runStarted = true;
        emit("model_run_start", {
          ...fields,
          runId: run.id,
          agentId: run.agentId,
          budget: this.options.budget.status(),
        });
        const result = await waitForRun(
          run,
          this.timeoutMs,
          this.heartbeatMs,
          fields,
        );
        reservationSettled = true;
        try {
          this.options.budget.complete(reservation, result);
        } finally {
          await this.options.onUsage?.(this.options.budget.snapshot());
        }
        emit("model_run_finish", {
          ...fields,
          runId: result.id,
          status: result.status,
          elapsedMs: Date.now() - startedAt,
          inputTokens: result.usage?.inputTokens ?? 0,
          outputTokens: result.usage?.outputTokens ?? 0,
          totalTokens: result.usage?.totalTokens ?? 0,
          budget: this.options.budget.status(),
        });
        return result;
      } catch (error) {
        if (!reservationSettled) {
          this.options.budget.release(reservation, runStarted);
          await this.options.onUsage?.(this.options.budget.snapshot());
        }
        lastError = error;
        const retryable =
          error instanceof ModelRunTimeoutError ||
          (error instanceof CursorSdkError && error.isRetryable);
        emit("model_run_error", {
          ...fields,
          elapsedMs: Date.now() - startedAt,
          retryable,
          errorType: error instanceof Error ? error.name : "unknown",
          budget: this.options.budget.status(),
        });
        if (!retryable || attempt === 1) throw error;
        await delay(1_000 * 2 ** attempt + Math.floor(Math.random() * 500));
      } finally {
        release();
      }
    }
    throw lastError;
  }

  async withSession<T>(options: {
    model: ModelSelection;
    name: string;
    task: (session: StructuredAgentSession) => Promise<T>;
  }): Promise<T> {
    const agent = await this.createAgent(options.model, options.name);
    try {
      return await options.task(
        new StructuredAgentSession(agent, this),
      );
    } finally {
      await agent[Symbol.asyncDispose]();
    }
  }
}
