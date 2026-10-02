export type ChatWorkbenchConfig = {
  apiBase: string;
  title: string;
  kicker: string;
  subtitle: string;
  panelStorageKey: string;
  welcomePrompts: string[];
  attachmentAccept?: string;
  attachmentHint?: string;
  allowedExtensions?: readonly string[];
  /** Pin pages whose API always uses one model role. */
  fixedModelRole?: 'small' | 'large';
  conversationKind?: 'chat' | 'research-review';
};
