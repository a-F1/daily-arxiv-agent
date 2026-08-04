import { DomainSchema, type Domain, type DomainId } from "./schema/report.js";

const domainDefinitions = [
  {
    id: "agent",
    name: "AI Agents",
    description:
      "Autonomous and interactive language-model agents, including planning, tool use, memory, and multi-agent systems.",
    categories: ["cs.AI", "cs.CL", "cs.LG", "cs.MA", "cs.HC"],
    keywords: [
      "agent",
      "agentic",
      "multi-agent",
      "tool use",
      "tool-use",
      "function calling",
      "planning",
      "reasoning",
      "memory",
      "computer use",
      "web agent",
      "language model agent",
    ],
    negativeKeywords: ["reagent", "chemical agent", "contrast agent"],
    maxPapers: 3,
  },
  {
    id: "embodied-vla",
    name: "Embodied VLA and Action Models",
    description:
      "Vision-language-action models, robot foundation models, and learned policies for embodied control.",
    categories: ["cs.RO", "cs.CV", "cs.AI", "cs.LG"],
    keywords: [
      "vision-language-action",
      "vision language action",
      "vla",
      "action model",
      "robot policy",
      "robot learning",
      "embodied ai",
      "embodied agent",
      "manipulation",
      "imitation learning",
      "world model",
      "diffusion policy",
    ],
    negativeKeywords: ["human action recognition", "legal action"],
    maxPapers: 3,
  },
  {
    id: "architecture-design",
    name: "Neural Architecture Design",
    description:
      "Design and analysis of efficient, scalable neural architectures and foundation-model components.",
    categories: ["cs.LG", "cs.AI", "cs.CL", "cs.CV", "stat.ML"],
    keywords: [
      "architecture",
      "transformer",
      "state space model",
      "mixture of experts",
      "attention",
      "token mixer",
      "neural architecture search",
      "model design",
      "scaling law",
      "sparse model",
      "efficient inference",
      "long context",
    ],
    negativeKeywords: [
      "building architecture",
      "software architecture",
      "system architecture",
    ],
    maxPapers: 3,
  },
] as const;

export const DOMAINS: readonly Domain[] = Object.freeze(
  domainDefinitions.map((domain) => DomainSchema.parse(domain)),
);

export const DOMAIN_BY_ID: ReadonlyMap<DomainId, Domain> = new Map(
  DOMAINS.map((domain) => [domain.id, domain]),
);

export function getDomain(id: DomainId): Domain {
  const domain = DOMAIN_BY_ID.get(id);
  if (!domain) {
    throw new Error(`Unknown domain: ${id}`);
  }
  return domain;
}
