const JSON_ONLY = [
  "只返回一个 JSON 值。",
  "不要使用 Markdown 代码围栏、额外说明或 schema 之外的字段。",
].join(" ");

const CHINESE_ONLY = [
  "所有叙述性字符串必须使用简体中文，禁止输出整句或整段英文。",
  "原始论文标题、作者名、模型名、arXiv ID、URL、BibTeX、公式、代码标识符和没有通行中文译名的必要技术专名可以保留原文。",
  "JSON 字段名、枚举值和数值必须严格保持 schema 指定形式，不要翻译。",
].join(" ");

export const PROMPT_VERSION = "research-prompts-v4-zh-cn";

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
    "你是一名严谨的中文论文分析员；若提供论文全文，必须优先依据全文。",
    '返回：{"oneLiner":string,"motivation":string,"method":string,"experimentSetup":string,"results":string[],"trainingResources":string,"limitations":string[],"significance":string}。',
    "保留定量结果。不得虚构算力信息；若原文没有披露，写“论文未披露”，任何估算必须明确标注。",
    CHINESE_ONLY,
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
    `基于这些摘要，为${domain ?? "该研究领域"}提出一个具体、可证伪的研究构想。`,
    '返回：{"title":string,"hypothesis":string,"motivation":string,"method":string[],"evaluation":string[],"expectedContribution":string,"impactAssessment":string,"noveltyAssessment":string,"resourceAssessment":string,"trainingResources":string,"scores":{"impact":1-5,"novelty":1-5,"feasibility":1-5},"feasible":boolean,"risks":string[]}。',
    "可行表示核心实验最多使用 8 张 H100、在 7 天内完成；必须保守评估。",
    CHINESE_ONLY,
    JSON_ONLY,
    `Summaries:\n${JSON.stringify(summaries)}`,
    ...(rejectionFeedback === undefined
      ? []
      : [`前一个方案未通过辩论；新方案必须避开这些缺陷：\n${JSON.stringify(rejectionFeedback)}`]),
  ].join("\n\n");
}

export function refineIdeaPrompt(input: {
  draft: unknown;
  references: readonly unknown[];
  attempt: number;
}): string {
  return [
    "你是一名严格的研究负责人。",
    '返回：{"round":number,"originalIdeaTitle":string,"critiquesAddressed":string[],"revisedHypothesis":string,"revisedMethod":string[],"decision":"accept"|"revise"|"reject","rationale":string,"impactScore":1-5,"noveltyScore":1-5,"feasibilityScore":1-5}。',
    "只有当三项评分均不低于 4，且核心实验可在 8 张 H100、7 天内完成时，才能接受。",
    `这是三次改进中的第 ${input.attempt} 次。`,
    CHINESE_ONLY,
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
    "依据评审意见和已有工作清单修改方案。",
    "返回完整的修改后 ResearchIdea 对象，结构必须与草案完全一致。",
    CHINESE_ONLY,
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
    "只把主持人的具体辩论反馈应用到现有方案；保留合理部分，不得生成无关的新方案。",
    "返回完整的修改后 ResearchIdea 对象，结构必须与草案完全一致。",
    CHINESE_ONLY,
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
    `你在第 ${input.round} 轮研究辩论中担任${input.role === "advocate" ? "支持方" : "质疑方"}。`,
    input.role === "advocate"
      ? "用可检验的具体内容捍卫或改进方案，并承认成立的缺陷。"
      : "严格检验新颖性、假设、可行性和评估设计，并提出决定性测试。",
    "claim 不超过 1200 个汉字，evidence 最多包含 4 条简洁证据。",
    `返回 {"round":${input.round},"model":${JSON.stringify(input.model)},"role":${JSON.stringify(input.role)},"claim":string,"evidence":string[]}。`,
    CHINESE_ONLY,
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
    "你是一名公正的研究项目辩论主持人。",
    '返回 {"topic":string,"consensus":string,"unresolvedQuestions":string[],"decision":"approve"|"revise"|"reject"|"continue","finalIdea":与输入 idea 结构相同的完整 ResearchIdea 对象}。',
    "只有影响力、新颖性、可证伪性和 8 张 H100/7 天预算都站得住脚时才能批准。若需修改，必须返回纳入共识修改的定向 finalIdea，不得要求另起方案。",
    input.mayExtend
      ? "只列出能够由下一轮辩论解决的实质性未决问题。"
      : '这是最后一轮；decision 必须为 "approve" 或 "reject"，并给出当前最佳共识及真正未决的问题。',
    CHINESE_ONLY,
    JSON_ONLY,
    `Rounds completed: ${input.round}`,
    `Idea:\n${JSON.stringify(input.idea)}`,
    `Reference ledger (top compact entries):\n${JSON.stringify(compactReferences(input.references ?? []))}`,
    `Recent debate turns:\n${JSON.stringify(input.turns.slice(-4))}`,
  ].join("\n\n");
}
