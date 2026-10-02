export type FileKind = 'pdf' | 'markdown' | 'text' | 'none';

/**
 * UI-facing source descriptor. OpenCode builds these directly from validated
 * Markdown path/line citations; the chat runtime no longer aggregates an
 * intermediate evidence ledger.
 */
export type DisplaySource = {
  id: string;
  label?: string;
  title: string;
  fileName: string;
  sourceType: string;
  sourceKey: string;
  fileKey: string;
  filePath: string;
  fileKind: FileKind;
  previewUrl: string;
  snippet: string;
  score: number;
  matchReason?: string;
  /** Relative path under knowledge-corpus / storage, used to linkify inline path citations. */
  corpusPath?: string;
  /** Alternate path spellings that should map to this source during rewrite/linkify. */
  pathAliases?: string[];
  /** Absolute http(s) URL for link citations (L1/L2). */
  url?: string;
  evidenceIds: string[];
};
