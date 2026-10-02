export type PatentStage =
  | 'source'
  | 'disclosure'
  | 'questions'
  | 'clarification'
  | 'prior_art'
  | 'strategy'
  | 'claims'
  | 'drawings'
  | 'specification'
  | 'audit'
  | 'ready'
  | 'failed';

export type PatentProjectStatus =
  | 'draft'
  | 'queued'
  | 'processing'
  | 'needs_input'
  | 'review_required'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  /** 兼容升级前已经生成的项目；读取后按 completed 展示。 */
  | 'ready';

export type PatentRunStatus =
  | 'queued'
  | 'running'
  | 'needs_input'
  | 'review_required'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type PatentGenerationRun = {
  id: string;
  projectId: string;
  status: PatentRunStatus;
  stage: PatentStage;
  progress: number;
  detail: string;
  error?: string;
  attempt: number;
  inputHash: string;
  cancelRequested: boolean;
  createdAt: string;
  startedAt?: string;
  heartbeatAt?: string;
  finishedAt?: string;
  updatedAt: string;
};

export type PatentGenerationEvent = {
  id: number;
  runId: string;
  projectId: string;
  type: PatentProgressEvent['type'];
  stage?: PatentStage;
  progress?: number;
  detail?: string;
  error?: string;
  createdAt: string;
};

export type PatentFormula = {
  id: string;
  index: number;
  latex: string;
  confidence: 'high' | 'medium' | 'low';
  context: string;
  objectId?: string;
  relationshipId?: string;
  warnings: string[];
};

export type PatentFigure = {
  id: string;
  index: number;
  caption: string;
  relationshipId?: string;
  target?: string;
  mediaType?: string;
};

export type PatentDiagramNode = {
  id: string;
  label: string;
  ref?: string;
  x?: number;
  y?: number;
};

export type PatentDiagramSpec = {
  figureNumber: number;
  title: string;
  kind: 'flowchart' | 'block' | 'structure';
  nodes: PatentDiagramNode[];
  edges: Array<{ from: string; to: string; label?: string }>;
  notes?: string[];
};

export type PatentDrawingAsset = {
  id: string;
  figureNumber: number;
  caption: string;
  source: 'extracted' | 'generated';
  fileName: string;
  relativePath: string;
  svgRelativePath?: string;
  mediaType: string;
  docxType: 'png' | 'jpg' | 'gif' | 'bmp' | 'svg';
  widthPx: number;
  heightPx: number;
  diagram?: PatentDiagramSpec;
};

export type PatentDrawingsBundle = {
  assets: PatentDrawingAsset[];
  generatedFromSuggestions: boolean;
  notes: string[];
};

export type PatentTable = {
  id: string;
  index: number;
  caption: string;
  rows: string[][];
};

export type PatentParsedSource = {
  text: string;
  charCount: number;
  paragraphs: string[];
  headings: string[];
  tables: PatentTable[];
  figures: PatentFigure[];
  formulas: PatentFormula[];
  formulaObjectsDetected: number;
  formulaObjectsRecovered: number;
  warnings: string[];
  metadata: {
    title?: string;
    authors?: string[];
    applicant?: string;
    organizations?: string[];
    abstract?: string;
    keywords?: string[];
    mediaCount?: number;
    imageCount?: number;
    equationProgramIds?: Record<string, number>;
  };
};

export type PatentBlocker = {
  id: string;
  severity: 'P0' | 'P1' | 'P2';
  category: 'identity' | 'source' | 'formula' | 'technical' | 'evidence' | 'legal';
  question: string;
  reason: string;
  resolved: boolean;
  answer?: string;
};

export type SourceAnchor = {
  id: string;
  quote: string;
  section?: string;
};

export type InventionFeature = {
  id: string;
  name: string;
  description: string;
  essential: boolean;
  technicalEffect: string;
  anchors: string[];
};

export type InventionDisclosure = {
  proposedTitle: string;
  technicalField: string;
  background: string;
  technicalProblems: string[];
  inventiveConcept: string;
  essentialFeatures: InventionFeature[];
  optionalFeatures: InventionFeature[];
  inputs: string[];
  outputs: string[];
  constraints: string[];
  technicalEffects: string[];
  embodiments: string[];
  figureSuggestions: string[];
  sourceAnchors: SourceAnchor[];
  assumptions: string[];
  missingInformation: Array<{
    severity: 'P0' | 'P1' | 'P2';
    question: string;
    reason: string;
  }>;
};

export type PriorArtCandidate = {
  id: string;
  title: string;
  publicationNumber?: string;
  applicant?: string;
  date?: string;
  url?: string;
  snippet: string;
  score: number;
  commonFeatures: string[];
  distinguishingFeatures: string[];
  risk: 'high' | 'medium' | 'low';
  riskReason: string;
};

export type PriorArtReport = {
  queries: string[];
  ipcCandidates: string[];
  candidates: PriorArtCandidate[];
  closestPriorArtId?: string;
  noveltyRisks: string[];
  searchLimitations: string[];
};

export type ClaimStrategy = {
  inventionTitle: string;
  coreContribution: string;
  objectiveTechnicalProblem: string;
  distinguishingFeatures: string[];
  nonObviousnessReasoning: string[];
  independentClaims: Array<{
    type: 'method' | 'system' | 'device' | 'storage_medium';
    scope: string;
    essentialFeatureIds: string[];
  }>;
  dependentClaimPlan: Array<{
    parentType: string;
    featureIds: string[];
    purpose: string;
  }>;
  fallbackPositions: string[];
  excludedMatter: string[];
};

export type PatentDraft = {
  title: string;
  abstract: string;
  abstractFigure: string;
  claims: string;
  technicalField: string;
  backgroundArt: string;
  inventionSummary: string;
  drawingDescription: string;
  embodiments: string;
  drawings?: PatentDrawingAsset[];
};

export type AuditIssue = {
  id: string;
  severity: 'error' | 'warning' | 'info';
  category: string;
  message: string;
  location?: string;
  suggestion?: string;
  repaired?: boolean;
};

export type PatentAudit = {
  score: number;
  passed: boolean;
  deterministicIssues: AuditIssue[];
  modelIssues: AuditIssue[];
  supportMatrix: Array<{
    claim: number;
    supported: boolean;
    evidence: string[];
    note: string;
  }>;
  remainingRisks: string[];
  rounds: number;
};

export type PatentProject = {
  id: string;
  title: string;
  status: PatentProjectStatus;
  currentStage: PatentStage;
  applicant: string;
  inventors: string[];
  contact: Record<string, string>;
  answers: Record<string, string>;
  blockers: PatentBlocker[];
  qualityScore: number;
  error?: string;
  source?: {
    id: string;
    name: string;
    mediaType: string;
    extension: string;
    size: number;
    parsed: PatentParsedSource;
  };
  disclosure?: InventionDisclosure;
  clarification?: {
    round: number;
    supplementaryFacts: string[];
    stillMissing: Array<{
      severity: 'P0' | 'P1' | 'P2';
      question: string;
      reason: string;
      options?: string[];
    }>;
    readyForDrafting: boolean;
  };
  priorArt?: PriorArtReport;
  strategy?: ClaimStrategy;
  drawings?: PatentDrawingsBundle;
  draft?: PatentDraft;
  audit?: PatentAudit;
  createdAt: string;
  updatedAt: string;
};

export type PatentProgressEvent =
  | { type: 'status'; stage: PatentStage; detail: string; progress: number }
  | { type: 'artifact'; kind: string; project: PatentProject }
  | { type: 'done'; project: PatentProject }
  | { type: 'error'; error: string; stage?: PatentStage };
