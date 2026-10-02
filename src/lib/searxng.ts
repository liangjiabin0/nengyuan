/** Shared SearXNG client defaults for mentor web search. */

export function getSearxngBaseUrl() {
  return (process.env.SEARXNG_BASE_URL || 'http://10.1.4.166:8080').replace(/\/+$/, '');
}

export function isMentorLocalCorpusDisabled() {
  // Default: mentors are web-only when SearXNG path is active.
  if (process.env.MENTOR_LOCAL_CORPUS === '1') return false;
  if (process.env.MENTOR_LOCAL_CORPUS === '0') return true;
  return true;
}
