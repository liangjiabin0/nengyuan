export type PptVoiceStatus =
  | 'draft'
  | 'ready'
  | 'checking'
  | 'generating'
  | 'done'
  | 'failed';

export type PptVoiceSlideStatus = 'idle' | 'ready' | 'previewed' | 'audio_ready' | 'failed';
export type PptVoiceEventLevel = 'info' | 'warn' | 'error' | 'thought' | 'output';
export type PptVoiceEmptyNotePolicy = 'error' | 'skip';

export type PptVoiceVoiceSettings = {
  model: string;
  voiceId: string;
  profileName: string;
  instruction: string;
  rate: number;
  pitch: number;
  volume: number;
  seed: number;
  emptyNotePolicy: PptVoiceEmptyNotePolicy;
  transitionBufferSeconds: number;
  lastSlideHoldSeconds: number;
  minimumSlideSeconds: number;
};

export type PptVoicePreflight = {
  slideCount: number;
  emptyNoteSlides: number[];
  characterCount: number;
  estimatedCostYuan: string;
};

export type PptVoiceProject = {
  id: string;
  title: string;
  sourceName: string;
  status: PptVoiceStatus;
  progress: number;
  progressDetail?: string;
  error?: string;
  voice: PptVoiceVoiceSettings;
  preflight?: PptVoicePreflight;
  hasOutput: boolean;
  hasVideo: boolean;
  hasReport: boolean;
  hasSlideImages: boolean;
  slideImageCount: number;
  createdAt: string;
  updatedAt: string;
};

export type PptVoiceSlide = {
  id: string;
  projectId: string;
  slideIndex: number;
  slideId: number;
  title: string;
  bodyText: string;
  rawNotes: string;
  notes: string;
  durationSeconds?: number;
  audioRelpath?: string;
  status: PptVoiceSlideStatus;
  error?: string;
  updatedAt: string;
};

export type PptVoiceEvent = {
  id: number;
  projectId: string;
  slideIndex?: number;
  level: PptVoiceEventLevel;
  text: string;
  createdAt: string;
};

export type PptVoiceMessage = {
  id: number;
  projectId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
};

export type PptVoiceProjectSnapshot = PptVoiceProject & {
  slides: PptVoiceSlide[];
  events: PptVoiceEvent[];
  messages: PptVoiceMessage[];
};

export type PptVoiceTtsSettings = {
  dashscopeApiKey: string;
  workspaceId: string;
  baseUrl: string;
  model: string;
  voiceId: string;
  profileName: string;
  instruction: string;
  rate: number;
  pitch: number;
  volume: number;
  seed: number;
};

export type PptVoiceHealth = {
  ok: boolean;
  python?: string;
  package?: boolean;
  pptx?: boolean;
  powerpoint?: boolean;
  libreoffice?: boolean;
  ffmpeg?: boolean;
  pdftoppm?: boolean;
  embedEngine?: 'powerpoint' | 'ooxml' | string;
  hasApiKey?: boolean;
  error?: string;
};
