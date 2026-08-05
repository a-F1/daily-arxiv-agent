const JSON_ONLY = [
  "只返回一个 JSON 值。",
  "不要使用 Markdown 代码围栏、额外说明或 schema 之外的字段。",
].join(" ");

const CHINESE_ONLY = [
  "所有叙述性字符串必须使用简体中文，禁止输出整句或整段英文。",
  "原始论文标题、作者名、模型名、arXiv ID、URL、BibTeX、公式、代码标识符和没有通行中文译名的必要技术专名可以保留原文。",
  "JSON 字段名和数值必须严格保持 schema 指定形式，不要翻译。",
].join(" ");

export const PROMPT_VERSION = "paper-summary-v5-bullets-zh-cn";

export function summaryPrompt(paper: unknown): string {
  return [
    "你是一名严谨的中文论文分析员；若提供论文全文，必须优先依据全文。",
    '返回：{"oneLiner":string,"motivation":string[],"method":string[],"experimentSetup":string[],"results":string[],"trainingResources":string[],"limitations":string[],"significance":string}。',
    "motivation、method、experimentSetup、results、trainingResources 必须是有序条目数组，每项使用简体中文、短而具体、信息密度高；不要把整个区块塞进一个长条目。",
    "建议每个区块 2–5 条；主要结果保留关键数值、基线和指标，训练/计算资源需区分已披露信息与未披露信息。",
    "保留定量结果。不得虚构算力信息；若原文没有披露，写“论文未披露”，任何估算必须明确标注。",
    CHINESE_ONLY,
    JSON_ONLY,
    `Paper:\n${JSON.stringify(paper)}`,
  ].join("\n\n");
}
