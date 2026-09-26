import type { RefreshCoordinator } from './coordinator';
import { checkDatabase } from './database';
import { COORDINATOR_NAME, PAGE_SIZE, ServiceError, type Manifest, type Snapshot } from './model';
export { RefreshCoordinator } from './coordinator';

export interface Env {
  WALLPAPER_CACHE: KVNamespace;
  REFRESH_COORDINATOR: DurableObjectNamespace<RefreshCoordinator>;
  APP_RATE_LIMITER: RateLimit;
  NEXWALL_API_KEY?: string;
  SERVICE_ENABLED: string;
  BLOCKED_WALLPAPER_IDS: string;
  POLICY_VERSION: string;
  REFRESH_GENERATION: string;
  HYPERDRIVE?: Hyperdrive;
}

const coordinator = (env: Env) => env.REFRESH_COORDINATOR.get(env.REFRESH_COORDINATOR.idFromName(COORDINATOR_NAME));
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, {
  status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers },
});

async function cached<T>(request: Request, key: string, env: Env, ctx: ExecutionContext,
  loader: () => Promise<T | null>): Promise<T | null> {
  const url = new URL(request.url);
  url.pathname = `/__internal_cache/${encodeURIComponent(env.POLICY_VERSION)}/${key}`;
  url.search = '';
  const cacheKey = new Request(url);
  const hit = await caches.default.match(cacheKey);
  if (hit) return hit.json<T>();
  const result = await loader();
  if (result) ctx.waitUntil(caches.default.put(cacheKey, Response.json(result, {
    headers: { 'Cache-Control': 'public, max-age=15' },
  })).catch(() => console.warn(JSON.stringify({ event: 'edge_cache_write_failed' }))));
  return result;
}

async function serve(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== '/wallpapers') return json({ error: { code: 'not_found' } }, 404);
  if (request.method !== 'GET') return json({ error: { code: 'method_not_allowed' } }, 405, { Allow: 'GET' });
  if (env.SERVICE_ENABLED !== 'true') throw new ServiceError('service_disabled');
  const limit = await env.APP_RATE_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'local' });
  if (!limit.success) return json({ error: { code: 'rate_limited', message: 'Please wait before requesting more pages.' } }, 429, { 'Retry-After': '60' });
  for (const key of url.searchParams.keys()) {
    if (!['page', 'snapshot'].includes(key) || url.searchParams.getAll(key).length !== 1) throw new ServiceError('invalid_query', 400);
  }
  const pageText = url.searchParams.get('page') ?? '1';
  if (!/^[1-9]\d{0,3}$/.test(pageText)) throw new ServiceError('invalid_page', 400);
  const page = Number(pageText), version = url.searchParams.get('snapshot');
  if (version !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(version)) throw new ServiceError('invalid_snapshot', 400);
  if (page > 1 && !version) throw new ServiceError('snapshot_required', 400);

  const manifest = await cached<Manifest>(request, 'manifest', env, ctx, () => coordinator(env).manifest());
  if (!manifest) throw new ServiceError('cache_unavailable');
  const now = Date.now();
  if (manifest.current.expiresAt <= now) {
    throw new ServiceError(version ? 'snapshot_expired' : 'cache_expired', version ? 410 : 503);
  }
  const ref = !version || version === manifest.current.version ? manifest.current
    : version === manifest.previous?.version ? manifest.previous : null;
  if (!ref || ref.availableUntil <= now || ref.expiresAt <= now) throw new ServiceError('snapshot_expired', 410);
  const load = (v: string) => cached<Snapshot>(request, `snapshot/${v}`, env, ctx,
    () => env.WALLPAPER_CACHE.get<Snapshot>(`snapshot:${v}`, 'json'));
  const snapshot = await load(ref.version);
  if (!snapshot) throw new ServiceError('snapshot_propagating');
  if (snapshot.expiresAt <= Date.now()) throw new ServiceError('cache_expired');
  if (page > snapshot.pages.length) throw new ServiceError('invalid_page', 400);
  const current = ref.version === manifest.current.version ? snapshot : await load(manifest.current.version);
  if (!current || current.expiresAt <= Date.now()) throw new ServiceError('cache_unavailable');
  // A retained page keeps its ordering but only serves still-selected IDs, using updated URLs/rights.
  const currentItems = new Map(current.pages.flat().map(item => [String(item.id), item]));
  const blocked = new Set(env.BLOCKED_WALLPAPER_IDS.split(',').map(id => id.trim()).filter(Boolean));
  const pages = snapshot.pages.map(items => items.flatMap(item => {
    const id = String(item.id), latest = currentItems.get(id);
    return latest && !blocked.has(id) ? [latest] : [];
  }));
  const end = Math.min(ref.availableUntil, snapshot.expiresAt);
  return json({
    data: pages[page - 1],
    pagination: { current_page: page, per_page: snapshot.pageSize ?? PAGE_SIZE, requested_per_page: PAGE_SIZE,
      last_page: pages.length, total: pages.flat().length, has_more: page < pages.length,
      next_page: page < pages.length ? page + 1 : null },
    snapshot: snapshot.version,
    freshness: { fetched_at: new Date(snapshot.fetchedAt).toISOString(), expires_at: new Date(end).toISOString(),
      age_seconds: Math.max(0, Math.floor((Date.now() - snapshot.fetchedAt) / 1000)),
      status: ref.version === manifest.current.version ? 'fresh' : 'previous' },
    notices: current.notices,
    source: 'NexWall',
    environment: snapshot.environment ?? 'production',
    fallback_reason: snapshot.fallbackReason ?? null,
  });
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const start = Date.now();
    let response: Response;
    try { response = await serve(request, env, ctx); }
    catch (error) {
      const known = error instanceof ServiceError;
      const code = known ? error.code : 'service_error', status = known ? error.status : 503;
      response = json({ error: { code, message: status === 410 ? 'This snapshot has expired. Restart from page 1.'
        : status === 400 ? 'Check the page and snapshot parameters.' : 'Wallpapers are temporarily unavailable. Please retry later.' } }, status,
        status === 503 ? { 'Retry-After': '60' } : {});
      console.warn(JSON.stringify({ event: 'request_error', code }));
    }
    response.headers.set('Server-Timing', `worker;dur=${Date.now() - start}`);
    console.log(JSON.stringify({ event: 'app_request', status: response.status, durationMs: Date.now() - start }));
    return response;
  },
  async scheduled(controller, env): Promise<void> {
    if (env.HYPERDRIVE) {
      const start = Date.now();
      try {
        await checkDatabase(env.HYPERDRIVE);
        console.log(JSON.stringify({ event: 'database_check', status: 'ok', durationMs: Date.now() - start }));
      } catch {
        // Never log driver errors: they may contain database hosts or credentials.
        console.error(JSON.stringify({ event: 'database_check', status: 'failed', durationMs: Date.now() - start }));
      }
    }
    const result = await coordinator(env).refresh(controller.scheduledTime);
    console.log(JSON.stringify({ event: 'scheduled_refresh', ...result }));
  },
} satisfies ExportedHandler<Env>;
