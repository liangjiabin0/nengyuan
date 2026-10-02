type MarkState = {
  pendingHref: string | null;
  startedAt: number;
};

let markState: MarkState = {
  pendingHref: null,
  startedAt: 0
};

export function setPageNavMarkState(next: MarkState) {
  markState = next;
}

export function logPageNavMark(phase: string, extra?: string) {
  if (typeof console === 'undefined' || !markState.startedAt) return;
  console.debug('[page-nav]', phase, {
    href: markState.pendingHref || '',
    ms: Date.now() - markState.startedAt,
    extra
  });
}
