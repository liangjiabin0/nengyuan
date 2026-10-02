export type ChatReproStageStatus = 'pending' | 'running' | 'done' | 'failed';

export type ChatReproStage = {
  id: string;
  title: string;
  status: ChatReproStageStatus;
  artifacts?: string[];
  summary?: string;
  error?: string;
  sessionId?: string;
};

export type ChatReproProgress = {
  version: 1;
  slug: string;
  title?: string;
  stages: ChatReproStage[];
  updatedAt: string;
};
