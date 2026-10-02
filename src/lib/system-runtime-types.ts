export type RuntimeKind = 'process' | 'worker' | 'gateway' | 'sidecar';

export type RuntimeStatus = 'up' | 'busy' | 'standby' | 'down' | 'missing' | 'checking';

export type RuntimeNode = {
  id: string;
  name: string;
  kind: RuntimeKind;
  status: RuntimeStatus;
  detail: string;
  caption?: string;
  pid?: number;
  port?: number;
  latencyMs?: number;
  version?: string;
  jobType?: string;
  since?: string;
};

export type RuntimeSnapshot = {
  updatedAt: string;
  mode?: string;
  split: boolean;
  nodes: RuntimeNode[];
};
