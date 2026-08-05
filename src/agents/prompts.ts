const JSON_ONLY = [
  "Return exactly one JSON value.",
  "Do not use Markdown fences, commentary, or fields outside the requested schema.",
].join(" ");

export const PROMPT_VERSION = "research-prompts-v3";

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

export function compactReferences(values: readonly unknown[], limit = 12): unknown[] {
  return values.slice(0, limit).map((value) => {
    const entry = asRecord(value);
    const reference = asRecord(entry["reference"] ?? value);
    return {
      id: reference["id"],
      title: reference["title"],
      year: reference["year"],
      doi: reference["doi"],
      citationCount: reference["citationCount"],
      usedIn: reference["usedIn"],
    };
  });
}

export function summaryPrompt(paper: unknown): string {
  return [
    "You are a precise Chinese research-paper analyst. Use the supplied full text when present.",
    'Return: {"oneLiner":string,"motivation":string,"method":string,"experimentSetup":string,"results":string[],"trainingResources":string,"limitations":string[],"significance":string}.',
    "Preserve quantitative results. Never invent compute: say 论文未披露, then clearly label any estimate.",
    JSON_ONLY,
    `Paper:\n${JSON.stringify(paper)}`,
  ].join("\n\n");
}

export function initialIdeaPrompt(
  summaries: readonly unknown[],
  domain?: string,
  rejectionFeedback?: unknown,
): string {
  return [
    `Propose one concrete, falsifiable research idea for ${domain ?? "this research area"} grounded in these summaries.`,
    'Return: {"title":string,"hypothesis":string,"motivation":string,"method":string[],"evaluation":string[],"expectedContribution":string,"impactAssessment":string,"noveltyAssessment":string,"resourceAssessment":string,"trainingResources":string,"scores":{"impact":1-5,"novelty":1-5,"feasibility":1-5},"feasible":boolean,"risks":string[]}.',
    "Feasible means the core experiment fits at most 8 H100 GPUs for 7 days. Be conservative.",
    JSON_ONLY,
    `Summaries:\n${JSON.stringify(summaries)}`,
    ...(rejectionFeedback === undefined
      ? []
      : [`A previous proposal failed debate. Avoid its weaknesses:\n${JSON.stringify(rejectionFeedback)}`]),
  ].join("\n\n");
}

export function refineIdeaPrompt(input: {
  draft: unknown;
  references: readonly unknown[];
  attempt: number;
}): string {
  return [
    "Act as a strict research lead.",
    'Return: {"round":number,"originalIdeaTitle":string,"critiquesAddressed":string[],"revisedHypothesis":string,"revisedMethod":string[],"decision":"accept"|"revise"|"reject","rationale":string,"impactScore":1-5,"noveltyScore":1-5,"feasibilityScore":1-5}.',
    "Accept only if all three scores are at least 4 and the core experiment fits 8 H100 GPUs for 7 days.",
    `This is refinement ${input.attempt} of 3.`,
    JSON_ONLY,
    `Current draft:\n${JSON.stringify(input.draft)}`,
    `Prior-art ledger (top compact entries):\n${JSON.stringify(compactReferences(input.references))}`,
  ].join("\n\n");
}

export function finalizeIdeaPrompt(input: {
  draft: unknown;
  references: readonly unknown[];
  refinement?: unknown;
}): string {
  return [
    "Revise the proposal using the critique and prior-art ledger.",
    "Return the complete revised ResearchIdea object in exactly the same shape used by the draft.",
    JSON_ONLY,
    `Draft:\n${JSON.stringify(input.draft)}`,
    `Refinement:\n${JSON.stringify(input.refinement)}`,
    `Prior-art ledger (top compact entries):\n${JSON.stringify(compactReferences(input.references))}`,
  ].join("\n\n");
}

export function reviseRejectedIdeaPrompt(input: {
  draft: unknown;
  debate: unknown;
  references: readonly unknown[];
}): string {
  return [
    "Apply only the moderator's concrete debate feedback to the existing proposal. Preserve sound parts; do not generate an unrelated candidate.",
    "Return the complete revised ResearchIdea object in exactly the same shape used by the draft.",
    JSON_ONLY,
    `Draft:\n${JSON.stringify(input.draft)}`,
    `Debate feedback:\n${JSON.stringify(input.debate)}`,
    `Prior-art ledger (top compact entries):\n${JSON.stringify(compactReferences(input.references))}`,
  ].join("\n\n");
}

export function debateTurnPrompt(input: {
  role: "advocate" | "skeptic";
  model: string;
  idea: unknown;
  references?: readonly unknown[];
  round: number;
  history: readonly unknown[];
}): string {
  return [
    `You are the ${input.role} in round ${input.round} of a research debate.`,
    input.role === "advocate"
      ? "Defend or improve the proposal with testable specifics; concede valid weaknesses."
      : "Stress-test novelty, assumptions, feasibility, and evaluation; propose decisive tests.",
    "Keep claim under 1200 Chinese characters and provide at most 4 concise evidence items.",
    `Return {"round":${input.round},"model":${JSON.stringify(input.model)},"role":${JSON.stringify(input.role)},"claim":string,"evidence":string[]}.`,
    JSON_ONLY,
    `Idea:\n${JSON.stringify(input.idea)}`,
    `Reference ledger (top compact entries):\n${JSON.stringify(compactReferences(input.references ?? []))}`,
    `Recent turns only:\n${JSON.stringify(input.history.slice(-4))}`,
  ].join("\n\n");
}

export function debateDecisionPrompt(input: {
  idea: unknown;
  references?: readonly unknown[];
  turns: readonly unknown[];
  round: number;
  mayExtend: boolean;
}): string {
  return [
    "You are an impartial research-program moderator.",
    'Return {"topic":string,"consensus":string,"unresolvedQuestions":string[],"decision":"approve"|"revise"|"reject"|"continue","finalIdea":a complete ResearchIdea object in the same shape as the input idea}.',
    "Approve only if impact, novelty, falsifiability, and the 8-H100/7-day budget remain defensible. For revise, return a targeted finalIdea incorporating agreed changes instead of requesting a new proposal.",
    input.mayExtend
      ? "List only material unresolved questions that another debate round could resolve."
      : 'This is the final round. decision must be "approve" or "reject"; give the best available consensus and any genuinely unresolved questions.',
    JSON_ONLY,
    `Rounds completed: ${input.round}`,
    `Idea:\n${JSON.stringify(input.idea)}`,
    `Reference ledger (top compact entries):\n${JSON.stringify(compactReferences(input.references ?? []))}`,
    `Recent debate turns:\n${JSON.stringify(input.turns.slice(-4))}`,
  ].join("\n\n");
}
