export const dynamic = 'force-dynamic';

/** Cheap liveness probe for the Next process. Must stay off `/api` so split-mode rewrites do not send it to the API sidecar. */
export function GET() {
  return new Response('ok', {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}
