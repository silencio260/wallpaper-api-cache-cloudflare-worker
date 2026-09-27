import type { RefreshCoordinator, PageResult } from './coordinator';
import { checkDatabase } from './database';
import { COORDINATOR_NAME, PAGE_SIZE, ServiceError, object, type CachedPage } from './model';
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

const CATEGORY_NAMES: Readonly<Record<number, string>> = {
  13: 'Nature & Landscapes', 1: 'AMOLED & OLED', 32: 'AI Generated',
  3: 'Anime & Manga', 9: 'Dark & Moody', 8: 'Cars & Bikes',
  11: 'Gaming', 6: 'Aesthetic & Vaporwave', 21: 'Devotional & Spiritual',
  57: 'Quotes & Typography',
};
const CATEGORY_ORDER = [13, 1, 32, 3, 9, 8, 11, 6, 21, 57];
const ALLOWED_SEARCH = new Set(["gaming", "anime", "dark", "dope", "space"]);
const coordinator = (env: Env) => env.REFRESH_COORDINATOR.get(env.REFRESH_COORDINATOR.idFromName(COORDINATOR_NAME));
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, {
  status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers },
});
const nextUTC = (now: number) => Date.parse(new Date(now).toISOString().slice(0, 10)) + 86400000;

async function serve(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== '/wallpapers' && url.pathname !== '/categories') return json({ error: { code: 'not_found' } }, 404);
  if (request.method !== 'GET') return json({ error: { code: 'method_not_allowed' } }, 405, { Allow: 'GET' });
  if (env.SERVICE_ENABLED !== 'true') throw new ServiceError('service_disabled');
  const limit = await env.APP_RATE_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'local' });
  if (!limit.success) return json({ error: { code: 'rate_limited', message: 'Please wait before requesting more pages.' } }, 429, { 'Retry-After': '60' });
  if (url.pathname === '/categories') {
    if (url.search) throw new ServiceError('invalid_query', 400);
    return json({ data: await coordinator(env).categories() });
  }
  for (const key of url.searchParams.keys()) {
    if (!['page', 'snapshot', 'category_id', 'search'].includes(key) || url.searchParams.getAll(key).length !== 1) throw new ServiceError('invalid_query', 400);
  }
  const pageText = url.searchParams.get('page') ?? '1';
  if (!/^[1-9]\d{0,3}$/.test(pageText)) throw new ServiceError('invalid_page', 400);
  const page = Number(pageText), version = url.searchParams.get('snapshot');
  const categoryText = url.searchParams.get('category_id');
  if (categoryText !== null && !/^[1-9]\d{0,3}$/.test(categoryText)) throw new ServiceError('invalid_category', 400);
  const categoryId = categoryText === null ? null : Number(categoryText);
  const searchText = url.searchParams.get('search');
  if (searchText !== null && (!ALLOWED_SEARCH.has(searchText) || categoryId !== null)) throw new ServiceError('invalid_search', 400);
  const search = searchText;
  if (version !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(version)) throw new ServiceError('invalid_snapshot', 400);
  if (page > 1 && !version) throw new ServiceError('snapshot_required', 400);

  // This short cache is an optimization. The Durable Object and KV decide misses.
  const cacheUrl = new URL(request.url);
  cacheUrl.pathname = `/__edge/${encodeURIComponent(env.POLICY_VERSION)}/wallpapers`;
  cacheUrl.search = new URLSearchParams({ page: String(page), category_id: categoryText ?? '', search: search ?? '', snapshot: version ?? '' }).toString();
  const edgeKey = new Request(cacheUrl);
  const edge = await caches.default.match(edgeKey);
  if (edge) {
    const result = new Response(edge.body, edge);
    result.headers.set('Cache-Control', 'no-store');
    result.headers.set('X-Cache-Status', 'edge');
    return result;
  }

  const result = await coordinator(env).getPage(page, version, categoryId, search) as PageResult;
  if ('error' in result) throw new ServiceError(result.error.code, result.error.status);
  const cached: CachedPage = result.page;
  const blocked = new Set(env.BLOCKED_WALLPAPER_IDS.split(',').map(id => id.trim()).filter(Boolean));
  const items = cached.items.filter(item => !blocked.has(String(item.id)));
  const observed = new Map<number, string>();
  for (const item of items) {
    const candidates = [item.category, ...(Array.isArray(item.categories) ? item.categories : [])];
    for (const candidate of candidates) {
      if (!object(candidate) || candidate.is_premium !== false) continue;
      const id = Number(candidate.id);
      if (!Number.isSafeInteger(id) || id < 1 || typeof candidate.name !== 'string') continue;
      observed.set(id, CATEGORY_NAMES[id] ?? candidate.name);
    }
  }
  const categories = [...observed].sort(([a], [b]) => {
    const ia = CATEGORY_ORDER.indexOf(a), ib = CATEGORY_ORDER.indexOf(b);
    return (ia < 0 ? Number.MAX_SAFE_INTEGER : ia) - (ib < 0 ? Number.MAX_SAFE_INTEGER : ib) || a - b;
  }).map(([id, name]) => ({ id, name }));
  const response = json({
    data: items,
    categories,
    selected_category_id: categoryId,
    selected_search: search,
    pagination: { current_page: page, per_page: cached.pageSize, requested_per_page: PAGE_SIZE,
      last_page: cached.lastPage, total: cached.total, has_more: page < cached.lastPage,
      next_page: page < cached.lastPage ? page + 1 : null },
    snapshot: cached.version,
    freshness: { fetched_at: new Date(cached.fetchedAt).toISOString(), expires_at: new Date(cached.expiresAt).toISOString(),
      age_seconds: Math.max(0, Math.floor((Date.now() - cached.fetchedAt) / 1000)), status: 'fresh' },
    notices: Object.keys(cached.notices).length ? [cached.notices] : [],
    source: 'NexWall', environment: 'production', fallback_reason: null,
  }, 200, { 'X-Cache-Status': result.cacheStatus });
  const ttl = Math.min(15, Math.floor((cached.expiresAt - Date.now()) / 1000));
  if (ttl > 0) ctx.waitUntil(caches.default.put(edgeKey, new Response(response.clone().body, {
    status: 200, headers: { 'Cache-Control': `public, max-age=${ttl}` },
  })).catch(() => console.warn(JSON.stringify({ event: 'edge_cache_write_failed' }))));
  return response;
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const start = Date.now();
    let response: Response;
    try { response = await serve(request, env, ctx); }
    catch (error) {
      const known = error instanceof ServiceError;
      const code = known ? error.code : 'service_error', status = known ? error.status : 503;
      const retry = status === 429 && code !== 'rate_limited'
        ? String(Math.ceil((nextUTC(Date.now()) - Date.now()) / 1000)) : status === 503 ? '60' : undefined;
      response = json({ error: { code, message: code === 'production_forbidden'
        ? 'NexWall denied access to this wallpaper selection (HTTP 403). Check the API plan and category permissions.'
        : status === 410 ? 'This selection has expired. Restart from page 1.'
        : status === 400 ? 'Check the page and snapshot parameters.'
          : status === 429 ? 'The upstream request budget is exhausted. Retry after the quota resets.'
            : 'Wallpapers are temporarily unavailable. Please retry later.' } }, status,
      retry ? { 'Retry-After': code === 'production_forbidden'
        ? String(Math.ceil((nextUTC(Date.now()) - Date.now()) / 1000)) : retry } : {});
      console.warn(JSON.stringify({ event: 'request_error', code }));
    }
    response.headers.set('Server-Timing', `worker;dur=${Date.now() - start}`);
    console.log(JSON.stringify({ event: 'app_request', status: response.status, durationMs: Date.now() - start }));
    return response;
  },
  // Retained for optional Hyperdrive checks; no scheduled handler fetches wallpapers.
  async scheduled(_controller, env): Promise<void> {
    if (!env.HYPERDRIVE) return;
    const start = Date.now();
    try {
      await checkDatabase(env.HYPERDRIVE);
      console.log(JSON.stringify({ event: 'database_check', status: 'ok', durationMs: Date.now() - start }));
    } catch {
      console.error(JSON.stringify({ event: 'database_check', status: 'failed', durationMs: Date.now() - start }));
    }
  },
} satisfies ExportedHandler<Env>;
