import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext, runInDurableObject, reset, evictDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../src/index';
import { COORDINATOR_NAME, PERIOD_MS, UPSTREAM, parsePage, type CachedPage } from '../src/model';
import { checkDatabase } from '../src/database';

const database = vi.hoisted(() => ({ connect: vi.fn(), query: vi.fn(), end: vi.fn() }));
vi.mock('pg', () => ({ Client: class { connect = database.connect; query = database.query; end = database.end; } }));
declare global { namespace Cloudflare { interface Env extends importEnv {} } }
interface importEnv extends Env {}
const stub = () => env.REFRESH_COORDINATOR.get(env.REFRESH_COORDINATOR.idFromName(COORDINATOR_NAME));
const item = (id: number) => ({ id, image_url: `https://images.example/${id}.webp`, thumbnail_url: `https://images.example/${id}-thumb.webp`, type: 'static', is_premium: false, attribution: 'Provider artist' });
const pageBody = (page: number, lastPage = 50) => ({ data: [item(page)], current_page: page, last_page: lastPage, per_page: 100, total: lastPage });
const expected: { page: number; categoryId: number | null; status: number; body: unknown }[] = [];
let calls = 0;
function upstream(page: number, status = 200, body: unknown = pageBody(page), categoryId: number | null = null) {
  expected.push({ page, categoryId, status, body });
}
async function request(query = '', overrides: Partial<Env> = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://app.example/wallpapers${query}`), { ...env, ...overrides }, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    calls++;
    const next = expected.shift();
    expect(next, 'Unexpected upstream request').toBeDefined();
    const url = new URL(String(input));
    expect(`${url.origin}${url.pathname}`).toBe(UPSTREAM);
    expect(url.searchParams.get('page')).toBe(String(next!.page));
    expect(url.searchParams.get('per_page')).toBe('100');
    expect(url.searchParams.get('type')).toBe('image');
    expect(url.searchParams.get('category_id')).toBe(next!.categoryId === null ? null : String(next!.categoryId));
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-secret-not-a-real-key');
    expect(init?.redirect).toBe('manual');
    await new Promise(resolve => setTimeout(resolve, 10));
    return Response.json(next!.body, { status: next!.status });
  });
});
afterEach(async () => {
  const remaining = expected.length;
  vi.restoreAllMocks(); expected.length = 0; calls = 0;
  await reset();
  expect(remaining).toBe(0);
});

describe('on-demand cache', () => {
  it('fills only requested pages and returns the provider pagination', async () => {
    upstream(1, 200, pageBody(1, 25)); upstream(2, 200, pageBody(2, 25));
    const first = await request();
    expect(first.status).toBe(200);
    expect(first.headers.get('X-Cache-Status')).toBe('miss');
    const body = await first.json() as { snapshot: string; pagination: { last_page: number; next_page: number; per_page: number; total: number } };
    expect(body.pagination).toMatchObject({ last_page: 25, next_page: 2, per_page: 100, total: 25 });
    const second = await request(`?page=2&snapshot=${body.snapshot}`);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ data: [item(2)], snapshot: body.snapshot });
    expect(calls).toBe(2);
  });
  it('shares a cold miss across simultaneous requests and serves repeats without upstream calls', async () => {
    upstream(1);
    const results = await Promise.all(Array.from({ length: 12 }, () => request()));
    expect(results.every(r => r.status === 200)).toBe(true);
    expect(calls).toBe(1);
    const version = (await results[0].json() as { snapshot: string }).snapshot;
    expect((await request(`?snapshot=${version}`)).status).toBe(200);
    expect(calls).toBe(1);
  });
  it('refills a manually deleted KV page without a stale manifest error', async () => {
    upstream(1);
    const version = (await (await request()).json() as { snapshot: string }).snapshot;
    await env.WALLPAPER_CACHE.delete(`page:all:${version}:1`);
    upstream(1);
    const restored = await request(`?snapshot=${version}`);
    expect(restored.status).toBe(200);
    expect(restored.headers.get('X-Cache-Status')).toBe('miss');
    expect(calls).toBe(2);
  });
  it('keeps category pages separate and forwards the category filter upstream', async () => {
    upstream(1, 200, pageBody(1, 3), 13);
    const response = await request('?category_id=13');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ selected_category_id: 13, pagination: { last_page: 3 } });
  });
  it('only advertises free categories observed in the returned page', async () => {
    upstream(1, 200, { ...pageBody(1, 1), data: [{ ...item(1), categories: [
      { id: 13, name: 'Nature & Landscapes', is_premium: false },
      { id: 32, name: 'AI Generated', is_premium: true },
    ] }] });
    const body = await (await request()).json() as { categories: Array<{ id: number }> };
    expect(body.categories.map(category => category.id)).toEqual([13]);
  });
  it('returns null next_page on the final page', async () => {
    upstream(1, 200, pageBody(1, 1));
    const body = await (await request()).json();
    expect(body).toMatchObject({ pagination: { next_page: null, has_more: false } });
    expect((await request('?page=2&snapshot=' + (body as { snapshot: string }).snapshot)).status).toBe(400);
  });
  it.each(['?page=0', '?page=1.5', '?page=01', '?page=1&page=2', '?search=cat', '?page=2', '?snapshot=invalid', '?category_id=0'])('rejects invalid query %s', async query => {
    expect((await request(query)).status).toBe(400);
  });
  it('returns 410 for an expired selection and starts a new one from page 1', async () => {
    upstream(1);
    const first = await (await request()).json() as { snapshot: string };
    await runInDurableObject(stub(), async (_instance, state) => {
      await state.storage.put('head:all', { version: first.snapshot, expiresAt: Date.now() - 1, lastPage: 50 });
    });
    expect((await request(`?page=2&snapshot=${first.snapshot}`)).status).toBe(410);
    const refreshed = await (await request('?page=1&snapshot=' + first.snapshot)).json();
    expect(refreshed).toMatchObject({ error: { code: 'snapshot_expired' } });
  });
  it('never sends attempt 81, including after Durable Object restart', async () => {
    await runInDurableObject(stub(), async (_instance, state) => {
      await state.storage.put('control', { day: new Date().toISOString().slice(0, 10), attempts: 80, blockedUntil: 0 });
    });
    await evictDurableObject(stub());
    const response = await request();
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: { code: 'daily_budget_exhausted' } });
    expect(calls).toBe(0);
  });
  it('preserves the existing durable count across the design change', async () => {
    await runInDurableObject(stub(), async (_instance, state) => {
      await state.storage.put('control', { day: new Date().toISOString().slice(0, 10), attempts: 79,
        lastSlot: 0, leaseUntil: 0, owner: '', blockedUntil: 0 });
    });
    upstream(1);
    expect((await request()).status).toBe(200);
    const control = await runInDurableObject(stub(), async (_instance, state) => state.storage.get<{ attempts: number }>('control'));
    expect(control?.attempts).toBe(80);
    expect((await request('?category_id=13')).status).toBe(429);
    expect(calls).toBe(1);
  });
  it('does not contact upstream without a key', async () => {
    const result = await runInDurableObject(stub(), async instance => {
      const original = Reflect.get(instance, 'env');
      Reflect.set(instance, 'env', { ...original, NEXWALL_API_KEY: undefined });
      try { return await instance.getPage(1, null, null); }
      finally { Reflect.set(instance, 'env', original); }
    });
    expect(result).toMatchObject({ error: { code: 'missing_api_key', status: 503 } });
    expect(calls).toBe(0);
  });
  it('does not retry a provider 429 or evade its quota', async () => {
    upstream(1, 429);
    const response = await request();
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: { code: 'upstream_http_429' } });
    expect((await request('?category_id=13')).status).toBe(429);
    expect(calls).toBe(1);
  });
  it('scopes a provider 403 to the denied category instead of blocking other feeds', async () => {
    upstream(1, 403, {}, 32);
    const denied = await request('?category_id=32');
    expect(denied.status).toBe(503);
    expect(await denied.json()).toMatchObject({ error: { code: 'production_forbidden' } });
    const blocked = await request('?category_id=32');
    expect(await blocked.json()).toMatchObject({ error: { code: 'production_forbidden' } });
    upstream(1, 200, pageBody(1, 1));
    expect((await request()).status).toBe(200);
    expect(calls).toBe(2);
  });
  it('allows a new fetch after a legacy global 403 cooldown expires', async () => {
    await runInDurableObject(stub(), async (_instance, state) => {
      await state.storage.put('control', { day: new Date().toISOString().slice(0, 10), attempts: 1,
        blockedUntil: Date.now() + 60_000, blockedReason: 'production_forbidden' });
    });
    expect(await (await request()).json()).toMatchObject({ error: { code: 'production_forbidden' } });
    expect(calls).toBe(0);
    await runInDurableObject(stub(), async (_instance, state) => {
      await state.storage.put('control', { day: new Date().toISOString().slice(0, 10), attempts: 1,
        blockedUntil: Date.now() - 1, blockedReason: 'production_forbidden' });
    });
    upstream(1, 200, pageBody(1, 1));
    expect((await request()).status).toBe(200);
    expect(calls).toBe(1);
  });
  it('counts failed attempts and retries of a server error', async () => {
    upstream(1, 500); upstream(1, 200, pageBody(1, 1));
    expect((await request()).status).toBe(200);
    const control = await runInDurableObject(stub(), async (_instance, state) => state.storage.get<{ attempts: number }>('control'));
    expect(control?.attempts).toBe(2);
  });
  it('filters restricted items and retains rights notices', async () => {
    upstream(1, 200, { data: [item(1), { ...item(2), is_premium: true }], current_page: 1,
      last_page: 1, per_page: 100, license: 'Provider rights' });
    const body = await (await request()).json();
    expect(body).toMatchObject({ data: [item(1)], notices: [{ license: 'Provider rights' }] });
  });
});

it('parses static-only pages and preserves provider notices', () => {
  const result = parsePage({ data: [item(1), { ...item(2), is_premium: true }, { ...item(3), type: 'live' }],
    current_page: 1, last_page: 5, license: 'Provider rights' }, 1);
  expect(result.items).toEqual([item(1)]); expect(result.notices).toEqual({ license: 'Provider rights' });
});
it('checks Postgres read-only and closes its client', async () => {
  database.query.mockResolvedValueOnce({ rows: [{ ok: 1 }] });
  await checkDatabase({ connectionString: 'postgres://test-only' } as Hyperdrive);
  expect(database.query).toHaveBeenLastCalledWith('SELECT 1 AS ok');
  expect(database.end).toHaveBeenCalled();
});
it('closes the database client after a failed query', async () => {
  database.end.mockClear(); database.query.mockRejectedValueOnce(new Error('test query failure'));
  await expect(checkDatabase({ connectionString: 'postgres://test-only' } as Hyperdrive)).rejects.toThrow('test query failure');
  expect(database.end).toHaveBeenCalledOnce();
});
