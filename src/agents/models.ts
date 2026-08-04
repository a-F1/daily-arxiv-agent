import { Cursor, type ModelListItem, type ModelSelection } from "@cursor/sdk";

export type ModelProvider = "claude" | "openai";

export interface FlagshipModelConfig {
  claude: string;
  openai: string;
}

export interface ResolvedModels {
  claude: ModelSelection;
  openai: ModelSelection;
}

export const DEFAULT_MODEL_ENV = {
  claude: "CURSOR_CLAUDE_MODEL",
  openai: "CURSOR_OPENAI_MODEL",
} as const;

const PROVIDER_MARKERS: Record<ModelProvider, RegExp> = {
  claude: /(claude|anthropic)/i,
  openai: /(gpt|openai|o[134](?:[-.]|$))/i,
};

function searchableNames(model: ModelListItem): string[] {
  return [model.id, model.displayName, ...(model.aliases ?? [])];
}

function findExactModel(
  configuredId: string,
  available: readonly ModelListItem[],
): ModelListItem | undefined {
  const wanted = configuredId.trim().toLowerCase();
  return available.find((model) =>
    searchableNames(model).some((name) => name.toLowerCase() === wanted),
  );
}

export function resolveConfiguredModel(
  provider: ModelProvider,
  configuredId: string,
  available: readonly ModelListItem[],
): ModelSelection {
  if (!configuredId.trim()) {
    throw new Error(`A ${provider} flagship model ID must be configured.`);
  }

  const model = findExactModel(configuredId, available);
  if (!model) {
    const candidates = available
      .filter((candidate) =>
        searchableNames(candidate).some((name) => PROVIDER_MARKERS[provider].test(name)),
      )
      .map((candidate) => candidate.id)
      .slice(0, 20);
    throw new Error(
      `Configured ${provider} model "${configuredId}" is not available to this Cursor account. ` +
        `Available ${provider} candidates: ${candidates.join(", ") || "none"}.`,
    );
  }

  if (!searchableNames(model).some((name) => PROVIDER_MARKERS[provider].test(name))) {
    throw new Error(
      `Configured ${provider} model "${configuredId}" resolved to "${model.id}", which is not a model from provider ${provider}.`,
    );
  }

  return { id: model.id };
}

export function readModelConfig(
  env: NodeJS.ProcessEnv = process.env,
): FlagshipModelConfig {
  const claude = env[DEFAULT_MODEL_ENV.claude];
  const openai = env[DEFAULT_MODEL_ENV.openai];
  if (!claude || !openai) {
    throw new Error(
      `Set ${DEFAULT_MODEL_ENV.claude} and ${DEFAULT_MODEL_ENV.openai} to explicit account model IDs.`,
    );
  }
  return { claude, openai };
}

export async function resolveFlagshipModels(options: {
  apiKey: string;
  configured?: FlagshipModelConfig;
  listModels?: (apiKey: string) => Promise<ModelListItem[]>;
}): Promise<ResolvedModels> {
  const configured = options.configured ?? readModelConfig();
  const available = await (options.listModels ??
    ((apiKey) => Cursor.models.list({ apiKey })))(options.apiKey);

  return {
    claude: resolveConfiguredModel("claude", configured.claude, available),
    openai: resolveConfiguredModel("openai", configured.openai, available),
  };
}
