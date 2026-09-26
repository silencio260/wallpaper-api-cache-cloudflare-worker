import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext, runInDurableObject, reset, evictDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../src/index';
import { COORDINATOR_NAME, PERIOD_MS, UPSTREAM, SANDBOX_UPSTREAM, parsePage, type Snapshot, type Manifest } from '../src/model';
import { checkDatabase } from '../src/database';

// Driver I/O is mocked; real database connectivity is verified after binding Hyperdrive.
const database = vi.hoisted(() => ({ connect: vi.fn(), query: vi.fn(), end: vi.fn() }));
vi.mock('pg', () => ({ Client: class {
  connect = database.connect;
  query = database.query;
  end = database.end;
} }));

declare global { namespace Cloudflare { interface Env extends importEnv {} } }
interface importEnv extends Env {}
const stub = () => env.REFRESH_COORDINATOR.get(env.REFRESH_COORDINATOR.idFromName(COORDINATOR_NAME));
const item = (id: number) => ({ id, image_url: `https://images.example/${id}.webp`, thumbnail_url: `https://images.example/${id}-thumb.webp`, type: 'static', is_premium: false, attribution: 'Provider artist' });
const pageBody = (page: number) => ({ data: [item(page)], current_page: page, last_page: 50 });
const expected: { page: number; status: number; body: unknown; sandbox: boolean }[] = [];
let unexpectedRequests = 0;
function upstream(page: number, status = 200, body: unknown = pageBody(page), sandbox = false) {
  expected.push({ page, status, body, sandbox });
}
async function request(query = '', overrides: Partial<Env> = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://app.example/wallpapers${query}`), { ...env, ...overrides }, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
async function seed(expired = false) {
  const now = Date.now();
  const s: Snapshot = { version: crypto.randomUUID(), fetchedAt: now - 1000,
    expiresAt: expired ? now - 1 : now + PERIOD_MS, pages: [1, 2, 3, 4, 5].map(i => [item(i)]), notices: [] };
  await env.WALLPAPER_CACHE.put(`snapshot:${s.version}`, JSON.stringify(s));
  await runInDurableObject(stub(), async (_instance, state) => {
    await state.storage.put('manifest', { current: { version: s.version, expiresAt: s.expiresAt, availableUntil: s.expiresAt } });
  });
  return s;
}
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const next = expected.shift();
    if (!next) unexpectedRequests++;
    expect(next, 'Unexpected upstream request').toBeDefined();
    const url = new URL(String(input));
    expect(`${url.origin}${url.pathname}`).toBe(next!.sandbox ? SANDBOX_UPSTREAM : UPSTREAM);
    expect(url.searchParams.get('page')).toBe(String(next!.page));
    expect(url.searchParams.get('per_page')).toBe('100');
    expect(url.searchParams.get('type')).toBe('image');
    expect(new Headers(init?.headers).get('Authorization')).toBe(next!.sandbox ? null : 'Bearer test-secret-not-a-real-key');
    if (next!.sandbox) expect(url.searchParams.get('endpoint')).toBe('wallpapers');
    expect(init?.redirect).toBe('manual');
    return Response.json(next!.body, { status: next!.status });
  });
});
afterEach(async () => {
  const remaining = expected.length;
  const unexpected = unexpectedRequests;
  unexpectedRequests = 0;
  vi.restoreAllMocks(); expected.length = 0;
  await reset();
  expect(remaining).toBe(0);
  expect(unexpected).toBe(0);
});

describe('cache-only app endpoint', () => {
  it('returns a useful unavailable response without an upstream call', async () => {
    const r = await request(); expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ error: { code: 'cache_unavailable' } });
  });
  it('serves repeated and simultaneous requests without any upstream calls', async () => {
    const s = await seed();
    const responses = await Promise.all(Array.from({ length: 20 }, () => request()));
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ snapshot: s.version, data: [item(1)] });
    }
    expect((await request(`?page=2&snapshot=${s.version}`)).status).toBe(200);
  });
  it.each(['?page=0', '?page=6', '?page=1.5', '?page=01', '?page=1&page=2', '?search=cat', '?page=2', '?snapshot=invalid'])('rejects invalid query %s', async query => {
    expect((await request(query)).status).toBe(400);
  });
  it('enforces expiry even when KV still holds the object', async () => {
    await seed(true); const r = await request(); expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ error: { code: 'cache_expired' } });
  });
  it('returns 410 for an explicitly requested expired snapshot', async () => {
    const old = await seed(true);
    const r = await request(`?page=2&snapshot=${old.version}`);
    expect(r.status).toBe(410);
    expect(await r.json()).toMatchObject({ error: { code: 'snapshot_expired' } });
  });
  it('rejects an unknown version instead of switching snapshots', async () => {
    await seed(); expect((await request(`?snapshot=${crypto.randomUUID()}`)).status).toBe(410);
  });
  it('applies emergency exclusions even on an edge cache hit', async () => {
    await seed(); await request();
    expect(await (await request('', { BLOCKED_WALLPAPER_IDS: '1' })).json()).toMatchObject({ data: [] });
    expect((await request('', { SERVICE_ENABLED: 'false' })).status).toBe(503);
  });
  it('throttles before storage reads', async () => {
    expect((await request('', { APP_RATE_LIMITER: { limit: async () => ({ success: false }) } })).status).toBe(429);
  });
  it('fails safely while the new KV snapshot propagates', async () => {
    const s = await seed(); await env.WALLPAPER_CACHE.delete(`snapshot:${s.version}`);
    expect(await (await request()).json()).toMatchObject({ error: { code: 'snapshot_propagating' } });
  });
  it('filters withdrawn IDs and uses updated metadata when browsing a previous version', async () => {
    const old = await seed();
    const next: Snapshot = { ...old, version: crypto.randomUUID(), pages: [[{ ...item(1), image_url: 'https://images.example/updated.webp' }], [], [], [], []] };
    await env.WALLPAPER_CACHE.put(`snapshot:${next.version}`, JSON.stringify(next));
    await runInDurableObject(stub(), async (_instance, state) => {
      const manifest: Manifest = { current: { version: next.version, expiresAt: next.expiresAt, availableUntil: next.expiresAt },
        previous: { version: old.version, expiresAt: old.expiresAt, availableUntil: Date.now() + 60000 } };
      await state.storage.put('manifest', manifest);
    });
    expect(await (await request(`?snapshot=${old.version}`)).json()).toMatchObject({ data: [{ image_url: 'https://images.example/updated.webp' }], freshness: { status: 'previous' } });
    expect(await (await request(`?page=2&snapshot=${old.version}`)).json()).toMatchObject({ data: [] });
  });
});

describe('durable scheduled refresh', () => {
  it('coalesces concurrent refreshes and persists the planned attempts across eviction', async () => {
    for (let page = 1; page <= 16; page++) upstream(page);
    const results = await Promise.all(Array.from({ length: 10 }, () => stub().refresh(Date.now())));
    expect(results.filter(r => r.status === 'published')).toHaveLength(1);
    const manifest = await stub().manifest(); expect(manifest).not.toBeNull();
    const snapshot = await env.WALLPAPER_CACHE.get<Snapshot>(`snapshot:${manifest!.current.version}`, 'json');
    expect(snapshot?.pages).toHaveLength(16);
    await evictDurableObject(stub());
    expect((await stub().refresh(Date.now())).status).toBe('skipped');
    const control = await runInDurableObject(stub(), async (_instance, state) => state.storage.get<{ attempts: number }>('control'));
    expect(control?.attempts).toBe(16);
  });
  it('keeps the prior snapshot when a required page fails, counting retries', async () => {
    const old = await seed(); upstream(1); upstream(2, 500); upstream(2, 500);
    expect((await stub().refresh(Date.now())).status).toBe('upstream_http_500');
    expect((await stub().manifest())?.current.version).toBe(old.version);
    const control = await runInDurableObject(stub(), async (_instance, state) => state.storage.get<{ attempts: number }>('control'));
    expect(control?.attempts).toBe(3);
  });
  it('never sends attempt 81, even after restarting the object', async () => {
    await runInDurableObject(stub(), async (_instance, state) => {
      await state.storage.put('control', { day: new Date().toISOString().slice(0, 10), attempts: 80, lastSlot: -1, leaseUntil: 0, owner: '', blockedUntil: 0 });
    });
    await evictDurableObject(stub());
    expect((await stub().refresh(Date.now())).status).toBe('daily_budget_exhausted');
    expect(await stub().manifest()).toBeNull();
  });
  it('resets the daily counter on a new UTC day', async () => {
    await runInDurableObject(stub(), async (_instance, state) => {
      await state.storage.put('control', { day: '2020-01-01', attempts: 80, lastSlot: -1, leaseUntil: 0, owner: '', blockedUntil: 0 });
    });
    for (let page = 1; page <= 16; page++) upstream(page);
    expect((await stub().refresh(Date.now())).status).toBe('published');
  });
  it('follows the provider page count and serves pages beyond five', async () => {
    for (let page = 1; page <= 7; page++) upstream(page, 200, { ...pageBody(page), last_page: 7 });
    expect((await stub().refresh(Date.now())).status).toBe('published');
    const first = await (await request()).json() as { snapshot: string; pagination: { last_page: number } };
    expect(first.pagination.last_page).toBe(7);
    const last = await (await request(`?page=7&snapshot=${first.snapshot}`)).json();
    expect(last).toMatchObject({ data: [item(7)], pagination: { next_page: null, has_more: false } });
  });
  it('does not retry or follow redirects', async () => {
    upstream(1, 302);
    expect((await stub().refresh(Date.now())).status).toBe('upstream_http_302');
  });
  it('falls back after production quota exhaustion without retrying production', async () => {
    upstream(1, 429);
    for (let page = 1; page <= 16; page++) upstream(page, 200, { ...pageBody(page), per_page: 20 }, true);
    expect((await stub().refresh(Date.now())).status).toBe('published');
    expect((await stub().refresh(Date.now())).status).toBe('skipped');
    expect(await (await request()).json()).toMatchObject({ environment: 'sandbox', fallback_reason: 'production_rate_limited', pagination: { per_page: 20, requested_per_page: 100 } });
  });
  it('uses sandbox directly when the production secret is missing', async () => {
    for (let page = 1; page <= 16; page++) upstream(page, 200, { ...pageBody(page), per_page: 20 }, true);
    const result = await runInDurableObject(stub(), async (instance) => {
      const original = Reflect.get(instance, 'env');
      Reflect.set(instance, 'env', { ...original, NEXWALL_API_KEY: undefined });
      try { return await instance.refresh(Date.now()); }
      finally { Reflect.set(instance, 'env', original); }
    });
    expect(result.status).toBe('published');
    expect(await (await request()).json()).toMatchObject({ environment: 'sandbox', fallback_reason: 'missing_api_key' });
  });
  it('discards partial production pages before switching to sandbox', async () => {
    upstream(1, 200, { ...pageBody(1), data: [item(999)] }); upstream(2, 429);
    for (let page = 1; page <= 16; page++) upstream(page, 200, pageBody(page), true);
    expect((await stub().refresh(Date.now())).status).toBe('published');
    expect(await (await request()).json()).toMatchObject({ data: [item(1)], environment: 'sandbox' });
  });
  it('honors sandbox throttling too', async () => {
    upstream(1, 429); upstream(1, 429, {}, true);
    expect((await stub().refresh(Date.now())).status).toBe('upstream_http_429');
    expect(await stub().manifest()).toBeNull();
  });
  it('shares the 80-attempt cap across production and sandbox', async () => {
    await runInDurableObject(stub(), async (_instance, state) => {
      await state.storage.put('control', { day: new Date().toISOString().slice(0, 10), attempts: 79, lastSlot: -1, leaseUntil: 0, owner: '', blockedUntil: 0 });
    });
    upstream(1, 429);
    expect((await stub().refresh(Date.now())).status).toBe('daily_budget_exhausted');
    expect(await stub().manifest()).toBeNull();
  });
  it('withdraws the manifest on an access restriction', async () => {
    await seed(); upstream(1, 403);
    expect((await stub().refresh(Date.now())).status).toBe('upstream_http_403');
    expect(await stub().manifest()).toBeNull();
  });
  it('does not publish malformed upstream data', async () => {
    upstream(1, 200, { data: [], current_page: 99, last_page: 50 });
    expect((await stub().refresh(Date.now())).status).toBe('invalid_upstream_pagination');
    expect(await stub().manifest()).toBeNull();
  });
});

it('removes live, premium and restricted items while preserving rights notices', () => {
  const result = parsePage({ data: [item(1), { ...item(2), is_premium: true }, { ...item(3), type: 'live' }, { ...item(4), status: 'withdrawn' }], current_page: 1, last_page: 5, license: 'Provider rights' }, 1);
  expect(result.items).toEqual([item(1)]); expect(result.notices).toEqual({ license: 'Provider rights' });
});

it('checks Postgres read-only and closes its client', async () => {
  database.query.mockResolvedValueOnce({ rows: [{ ok: 1 }] });
  await checkDatabase({ connectionString: 'postgres://test-only' } as Hyperdrive);
  expect(database.query).toHaveBeenLastCalledWith('SELECT 1 AS ok');
  expect(database.end).toHaveBeenCalled();
});

it('closes the database client after a failed query', async () => {
  database.end.mockClear();
  database.query.mockRejectedValueOnce(new Error('test query failure'));
  await expect(checkDatabase({ connectionString: 'postgres://test-only' } as Hyperdrive)).rejects.toThrow('test query failure');
  expect(database.end).toHaveBeenCalledOnce();
});
