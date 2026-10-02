export type GridGuideTopic = {
  title: string;
  researchContent: string[];
  expectedGoal: string;
  assessmentIndicators: string[];
};

/** 库内或网上检索到的相关技术条目（供对话对标展示，不进入正式指南正文）。 */
export type TechLandscapeEntry = {
  title: string;
  gist: string;
  /** 相对本指南拟议内容的差异或空白 */
  gapOrDifference?: string;
  sourceLabel?: string;
  url?: string;
};

/** 本指南拟议创新点与已有/最新技术的结构化差异。 */
export type TechDifferentiation = {
  proposedInnovation: string;
  differenceFromExisting: string;
  differenceFromLatest: string;
};

export type TechLandscape = {
  overview: string;
  existingInCorpus: TechLandscapeEntry[];
  latestOnline: TechLandscapeEntry[];
  differentiations: TechDifferentiation[];
};

export type GridGuideDocument = {
  projectTitle: string;
  guide: {
    technicalCategory: string;
    overallObjective: string;
    topicSetup: string[];
    implementationPeriod: string;
    topics: GridGuideTopic[];
    maturityAndApplication: string;
    budgetLimit: string;
  };
  explanation: {
    technicalDemandAnalysis: string;
    currentStatusAndResearchWork: string;
    topicSetupExplanation: string;
    planningCorrespondence: {
      guideName: string;
      requirementNumber: string;
      requirementName: string;
      technicalField: string;
      proposingUnit: string;
    };
    undertakingEntity: string;
  };
  evidenceSummary: string[];
  /** 拟议新内容 vs 库内已有 vs 网络最新方向的对标结果，供设计对话完整展示 */
  techLandscape?: TechLandscape;
};

export type GridGuideMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  selection?: string;
  createdAt: string;
};

export type GridGuideAttachment = {
  id: string;
  conversationId: string;
  name: string;
  mediaType: string;
  extension: string;
  size: number;
  status: 'processing' | 'ready' | 'failed';
  error?: string;
  previewUrl: string;
  createdAt: string;
};

export type GridGuideProject = {
  id: string;
  title: string;
  idea: string;
  status: 'draft' | 'generating' | 'ready' | 'failed';
  progress: number;
  progressDetail?: string;
  document?: GridGuideDocument;
  taskFolder?: string;
  hasWorkspace?: boolean;
  messages: GridGuideMessage[];
  attachments?: GridGuideAttachment[];
  error?: string;
  createdAt: string;
  updatedAt: string;
};

export type GridGuideFileKind = 'dir' | 'file';

export type GridGuideFileNode = {
  name: string;
  path: string;
  type: GridGuideFileKind;
  extension?: string;
  size?: number;
  children?: GridGuideFileNode[];
};
