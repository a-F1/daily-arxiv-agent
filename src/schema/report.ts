import { z } from "zod";

const NonEmptyString = z.string().trim().min(1);
const IsoDate = z.iso.date();
const IsoDateTime = z.iso.datetime({ offset: true });
const Url = z.url();

const TraditionalChineseCharacters =
  /[為與這個們來時後裡過學術驗結資風險題評證據應該將會]/u;

export function isSimplifiedChineseNarrative(value: string): boolean {
  const withoutMachineText = value
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\b(?:arXiv:?)?\d{4}\.\d{4,5}(?:v\d+)?\b/gi, "")
    .replace(/\b[A-Z][A-Z0-9.-]{1,}\b/g, "");
  const chineseCharacters = withoutMachineText.match(/[\u3400-\u9fff]/gu)?.length ?? 0;
  const latinCharacters = withoutMachineText.match(/[A-Za-z]/g)?.length ?? 0;
  return (
    chineseCharacters >= 2 &&
    chineseCharacters / Math.max(chineseCharacters + latinCharacters, 1) >= 0.15 &&
    !TraditionalChineseCharacters.test(withoutMachineText)
  );
}

export const SimplifiedChineseNarrativeSchema = NonEmptyString.refine(
  isSimplifiedChineseNarrative,
  "叙述字段必须以简体中文为主，不能是整段英文或繁体中文。",
);

export const DomainIdSchema = z.enum([
  "agent",
  "embodied-vla",
  "architecture-design",
]);
export type DomainId = z.infer<typeof DomainIdSchema>;

export const DomainSchema = z
  .object({
    id: DomainIdSchema,
    name: NonEmptyString,
    description: NonEmptyString,
    categories: z.array(NonEmptyString).min(1),
    keywords: z.array(NonEmptyString).min(1),
    negativeKeywords: z.array(NonEmptyString).default([]),
    maxPapers: z.number().int().min(1).max(10).default(3),
  })
  .strict();
export type Domain = z.infer<typeof DomainSchema>;

export const AuthorSchema = z
  .object({
    name: NonEmptyString,
    affiliation: NonEmptyString.optional(),
    orcid: NonEmptyString.optional(),
  })
  .strict();
export type Author = z.infer<typeof AuthorSchema>;

export const ArxivPaperSchema = z
  .object({
    arxivId: z
      .string()
      .trim()
      .regex(
        /^(?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?$/i,
        "Invalid arXiv identifier",
      ),
    baseArxivId: z
      .string()
      .trim()
      .regex(/^(?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7}|\d{4}\.\d{4,5})$/i),
    version: z.number().int().positive().optional(),
    title: NonEmptyString,
    abstract: NonEmptyString,
    authors: z.array(AuthorSchema).min(1),
    categories: z.array(NonEmptyString).min(1),
    primaryCategory: NonEmptyString,
    submittedAt: IsoDateTime.optional(),
    updatedAt: IsoDateTime.optional(),
    announcedOn: IsoDate,
    releaseDate: IsoDate,
    announcementType: z.enum([
      "new",
      "cross",
      "replace",
      "replace-cross",
      "unknown",
    ]),
    releaseSourceUrl: Url,
    absUrl: Url,
    pdfUrl: Url,
    doi: NonEmptyString.optional(),
    journalReference: NonEmptyString.optional(),
    comments: NonEmptyString.optional(),
    source: z.enum(["arxiv-rss", "arxiv-api"]),
  })
  .strict()
  .refine((paper) => paper.categories.includes(paper.primaryCategory), {
    message: "primaryCategory must be included in categories",
    path: ["primaryCategory"],
  });
export type ArxivPaper = z.infer<typeof ArxivPaperSchema>;

export const ScoreBreakdownSchema = z
  .object({
    category: z.number().min(0),
    titleKeyword: z.number().min(0),
    abstractKeyword: z.number().min(0),
    phrase: z.number().min(0),
    novelty: z.number().min(0),
    experimentalRigor: z.number().min(0),
    resultEvidence: z.number().min(0),
    resourceDisclosure: z.number().min(0),
    negative: z.number().max(0),
    recency: z.number().min(0),
  })
  .strict();
export type ScoreBreakdown = z.infer<typeof ScoreBreakdownSchema>;

export const PaperScoreSchema = z
  .object({
    domainId: DomainIdSchema,
    total: z.number(),
    breakdown: ScoreBreakdownSchema,
    matchedKeywords: z.array(NonEmptyString),
    matchedCategories: z.array(NonEmptyString),
    explanation: z.array(NonEmptyString).min(1),
    algorithmVersion: NonEmptyString,
  })
  .strict();
export type PaperScore = z.infer<typeof PaperScoreSchema>;

export const ScoredPaperSchema = z
  .object({
    paper: ArxivPaperSchema,
    score: PaperScoreSchema,
    rank: z.number().int().positive().optional(),
  })
  .strict();
export type ScoredPaper = z.infer<typeof ScoredPaperSchema>;

export const PaperSummarySchema = z
  .object({
    oneLiner: NonEmptyString,
    motivation: NonEmptyString,
    method: NonEmptyString,
    experimentSetup: NonEmptyString,
    results: z.array(NonEmptyString).min(1),
    trainingResources: NonEmptyString,
    limitations: z.array(NonEmptyString),
    significance: NonEmptyString,
  })
  .strict();
export type PaperSummary = z.infer<typeof PaperSummarySchema>;

export const ChinesePaperSummarySchema = PaperSummarySchema.extend({
  oneLiner: SimplifiedChineseNarrativeSchema,
  motivation: SimplifiedChineseNarrativeSchema,
  method: SimplifiedChineseNarrativeSchema,
  experimentSetup: SimplifiedChineseNarrativeSchema,
  results: z.array(SimplifiedChineseNarrativeSchema).min(1),
  trainingResources: SimplifiedChineseNarrativeSchema,
  limitations: z.array(SimplifiedChineseNarrativeSchema),
  significance: SimplifiedChineseNarrativeSchema,
});

export const ResearchIdeaSchema = z
  .object({
    title: NonEmptyString,
    hypothesis: NonEmptyString,
    motivation: NonEmptyString,
    method: z.array(NonEmptyString).min(1),
    evaluation: z.array(NonEmptyString).min(1),
    expectedContribution: NonEmptyString,
    impactAssessment: NonEmptyString,
    noveltyAssessment: NonEmptyString,
    resourceAssessment: NonEmptyString,
    trainingResources: NonEmptyString,
    scores: z
      .object({
        impact: z.number().int().min(1).max(5),
        novelty: z.number().int().min(1).max(5),
        feasibility: z.number().int().min(1).max(5),
      })
      .strict(),
    feasible: z.boolean(),
    risks: z.array(NonEmptyString),
  })
  .strict();
export type ResearchIdea = z.infer<typeof ResearchIdeaSchema>;

export const ChineseResearchIdeaSchema = ResearchIdeaSchema.extend({
  title: SimplifiedChineseNarrativeSchema,
  hypothesis: SimplifiedChineseNarrativeSchema,
  motivation: SimplifiedChineseNarrativeSchema,
  method: z.array(SimplifiedChineseNarrativeSchema).min(1),
  evaluation: z.array(SimplifiedChineseNarrativeSchema).min(1),
  expectedContribution: SimplifiedChineseNarrativeSchema,
  impactAssessment: SimplifiedChineseNarrativeSchema,
  noveltyAssessment: SimplifiedChineseNarrativeSchema,
  resourceAssessment: SimplifiedChineseNarrativeSchema,
  trainingResources: SimplifiedChineseNarrativeSchema,
  risks: z.array(SimplifiedChineseNarrativeSchema),
});

export const RefinementSchema = z
  .object({
    round: z.number().int().positive(),
    originalIdeaTitle: NonEmptyString,
    critiquesAddressed: z.array(NonEmptyString),
    revisedHypothesis: NonEmptyString,
    revisedMethod: z.array(NonEmptyString).min(1),
    decision: z.enum(["accept", "revise", "reject"]),
    rationale: NonEmptyString,
    impactScore: z.number().int().min(1).max(5),
    noveltyScore: z.number().int().min(1).max(5),
    feasibilityScore: z.number().int().min(1).max(5),
  })
  .strict();
export type Refinement = z.infer<typeof RefinementSchema>;

export const ChineseRefinementSchema = RefinementSchema.extend({
  originalIdeaTitle: SimplifiedChineseNarrativeSchema,
  critiquesAddressed: z.array(SimplifiedChineseNarrativeSchema),
  revisedHypothesis: SimplifiedChineseNarrativeSchema,
  revisedMethod: z.array(SimplifiedChineseNarrativeSchema).min(1),
  rationale: SimplifiedChineseNarrativeSchema,
});

export const DebateTurnSchema = z
  .object({
    round: z.number().int().positive(),
    model: NonEmptyString,
    role: z.enum(["advocate", "skeptic", "reviewer", "synthesizer"]),
    claim: NonEmptyString,
    evidence: z.array(NonEmptyString),
    responseTo: z.number().int().nonnegative().optional(),
  })
  .strict();
export type DebateTurn = z.infer<typeof DebateTurnSchema>;

export const ChineseDebateTurnSchema = DebateTurnSchema.extend({
  claim: SimplifiedChineseNarrativeSchema,
  evidence: z.array(SimplifiedChineseNarrativeSchema),
});

export const DebateSchema = z
  .object({
    topic: NonEmptyString,
    turns: z.array(DebateTurnSchema).min(2),
    consensus: NonEmptyString.optional(),
    unresolvedQuestions: z.array(NonEmptyString),
    approved: z.boolean(),
    finalIdea: ResearchIdeaSchema,
  })
  .strict();
export type Debate = z.infer<typeof DebateSchema>;

export const ReferenceSchema = z
  .object({
    id: NonEmptyString,
    title: NonEmptyString,
    authors: z.array(NonEmptyString),
    year: z.number().int().min(1600).max(3000).nullable(),
    doi: NonEmptyString.optional(),
    arxivId: NonEmptyString.optional(),
    venue: NonEmptyString.optional(),
    url: Url.optional(),
    citationCount: z.number().int().nonnegative().optional(),
    openAlexId: NonEmptyString.optional(),
    usedIn: z.array(NonEmptyString).default([]),
  })
  .strict();
export type Reference = z.infer<typeof ReferenceSchema>;

export const ProvenanceRecordSchema = z
  .object({
    stage: z.enum([
      "ingestion",
      "selection",
      "pdf-extraction",
      "summarization",
      "ideation",
      "refinement",
      "prior-art",
      "debate",
    ]),
    source: NonEmptyString,
    retrievedAt: IsoDateTime,
    inputHash: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
    model: NonEmptyString.optional(),
    promptVersion: NonEmptyString.optional(),
    notes: z.array(NonEmptyString).default([]),
  })
  .strict();
export type ProvenanceRecord = z.infer<typeof ProvenanceRecordSchema>;

export const ReportPaperSchema = z
  .object({
    paper: ArxivPaperSchema,
    score: PaperScoreSchema,
    summary: PaperSummarySchema,
    ideas: z.array(ResearchIdeaSchema).default([]),
    refinements: z.array(RefinementSchema).default([]),
    debate: DebateSchema.optional(),
    references: z.array(ReferenceSchema).default([]),
    provenance: z.array(ProvenanceRecordSchema).min(1),
  })
  .strict();
export type ReportPaper = z.infer<typeof ReportPaperSchema>;

export const DomainResearchSchema = z
  .object({
    domainId: DomainIdSchema,
    idea: ResearchIdeaSchema,
    refinements: z.array(RefinementSchema),
    debate: DebateSchema,
    references: z.array(ReferenceSchema),
    restarts: z.number().int().nonnegative(),
    debateRounds: z.number().int().min(3).max(5),
  })
  .strict();
export type DomainResearch = z.infer<typeof DomainResearchSchema>;

export const ExcludedTopicReasonCodeSchema = z.enum([
  "AI_SAFETY_ALIGNMENT",
  "SECURITY_CYBERSECURITY",
  "ATTACK_ADVERSARIAL",
  "JAILBREAK_PROMPT_INJECTION",
  "POISONING_BACKDOOR",
  "DEFENSE_MITIGATION",
  "RED_TEAM_EXPLOIT",
  "CHINESE_SECURITY_TOPIC",
]);
export type ExcludedTopicReasonCode = z.infer<
  typeof ExcludedTopicReasonCodeSchema
>;

export const ExclusionSummarySchema = z
  .object({
    totalExcluded: z.number().int().nonnegative(),
    byReason: z
      .partialRecord(
        ExcludedTopicReasonCodeSchema,
        z.number().int().nonnegative(),
      )
      .default({}),
  })
  .strict();
export type ExclusionSummary = z.infer<typeof ExclusionSummarySchema>;

export const SelectionPolicySchema = z
  .object({
    source: z.literal("arxiv-rss"),
    timeZone: z.literal("America/New_York"),
    dateField: z.literal("item.pubDate"),
    includedAnnouncementTypes: z
      .array(z.enum(["new", "cross"]))
      .min(1),
    excludedAnnouncementTypes: z.array(
      z.enum(["replace", "replace-cross", "unknown"]),
    ),
    strictSameDay: z.literal(true),
    maxPerDomain: z.number().int().positive(),
    hardExcludedTopicsEnabled: z.boolean().default(false),
    excludedTopicPolicyVersion: NonEmptyString.optional(),
  })
  .strict();
export type SelectionPolicy = z.infer<typeof SelectionPolicySchema>;

export const DailyReportSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    reportDate: IsoDate,
    generatedAt: IsoDateTime,
    releaseStatus: z.enum(["complete", "partial", "no-release"]).default("complete"),
    selectionPolicy: SelectionPolicySchema.optional(),
    exclusionSummary: ExclusionSummarySchema.optional(),
    domains: z.array(DomainSchema).min(1),
    papers: z.array(ReportPaperSchema),
    domainResearch: z.array(DomainResearchSchema),
    provenance: z.array(ProvenanceRecordSchema).min(1),
    warnings: z.array(NonEmptyString).default([]),
  })
  .strict()
  .superRefine((report, context) => {
    const domainIds = new Set(report.domains.map((domain) => domain.id));
    for (const [index, item] of report.papers.entries()) {
      if (!domainIds.has(item.score.domainId)) {
        context.addIssue({
          code: "custom",
          message: `Unknown report domain: ${item.score.domainId}`,
          path: ["papers", index, "score", "domainId"],
        });
      }
    }
  });
export type DailyReport = z.infer<typeof DailyReportSchema>;
