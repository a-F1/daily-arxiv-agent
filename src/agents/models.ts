import { Cursor, type ModelListItem, type ModelSelection } from "@cursor/sdk";

export const SUMMARY_MODEL_ENV = "CURSOR_SUMMARY_MODEL";
export const DEFAULT_SUMMARY_MODEL = "composer-2.5";

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

export function readSummaryModelConfig(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env[SUMMARY_MODEL_ENV] || DEFAULT_SUMMARY_MODEL;
}

export async function resolveSummaryModel(options: {
  apiKey: string;
  configured?: string;
  listModels?: (apiKey: string) => Promise<ModelListItem[]>;
}): Promise<ModelSelection> {
  const configured = options.configured ?? readSummaryModelConfig();
  const available = await (options.listModels ??
    ((apiKey) => Cursor.models.list({ apiKey })))(options.apiKey);
  const model = findExactModel(configured, available);
  if (!model) {
    throw new Error(
      `Configured summary model "${configured}" is not available to this Cursor account.`,
    );
  }
  return { id: model.id };
}
