export const RAGPACK_FORMAT = 'ragpack';
export const RAGPACK_VERSION = 2;

export type RagpackManifest = {
  format: typeof RAGPACK_FORMAT;
  version: number;
  createdAt: string;
  stats: {
    papers: number;
    mentors: number;
    searchRecords: number;
    paperChunks: number;
  };
  files: {
    papers: Record<string, string>;
    mentors: Record<string, string>;
  };
};

export type RagpackExportResult = {
  outPath: string;
  sizeBytes: number;
  manifest: RagpackManifest;
  copiedPapers: number;
  copiedMentors: number;
  skippedFiles: string[];
};

export type RagpackImportResult = {
  bundleRoot: string;
  manifest: RagpackManifest;
  remappedPapers: number;
  remappedMentors: number;
};

export type RagpackJobState = {
  status: 'idle' | 'running' | 'done' | 'error';
  phase: string;
  message: string;
  progress?: { current: number; total: number };
  result?: RagpackExportResult | RagpackImportResult;
  error?: string;
};
