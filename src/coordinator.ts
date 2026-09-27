import { DurableObject } from 'cloudflare:workers';
import { DAILY_LIMIT, PAGE_SIZE, PERIOD_MS, UPSTREAM, ServiceError, object, parsePage, type CachedPage, type FeedHead } from './model';
import type { Env } from './index';

interface Control {
  day: string;
  attempts: number;
  blockedUntil: number;
  blockedReason?: string;
}
export type PageResult = { page: CachedPage; cacheStatus: 'hit' | 'miss' } | { error: { code: string; status: number } };
export interface ProviderCategory { id: number; name: string; }
interface CategoryCache { items: ProviderCategory[]; expiresAt: number; }
const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);
const nextDay = (now: number) => Date.parse(dayOf(now)) + 86400000;
const familyOf = (categoryId: number | null, search: string | null) => search !== null ? `search-${search}` : categoryId === null ? 'all' : `category-${categoryId}`;

export class RefreshCoordinator extends DurableObject<Env> {
  private pending = new Map<string, Promise<CachedPage>>();
  private categoriesPending?: Promise<ProviderCategory[]>;

  async categories(): Promise<ProviderCategory[]> {
    const now = Date.now();
    const cached = await this.ctx.storage.get<CategoryCache>('available_categories');
    if (cached && cached.expiresAt > now) return cached.items;
    if (((await this.ctx.storage.get<number>('categories_retry_at')) ?? 0) > now) {
      throw new ServiceError('categories_unavailable');
    }
    this.categoriesPending ??= this.fetchCategories();
    try { return await this.categoriesPending; }
    finally { this.categoriesPending = undefined; }
  }

  private async fetchCategories(): Promise<ProviderCategory[]> {
    try {
      if (!this.env.NEXWALL_API_KEY?.trim()) throw new ServiceError('missing_api_key');
      await this.reserve('categories');
      const response = await fetch('https://nexwall.kodnextech.com/api/developer/v1/categories', {
        headers: { Accept: 'application/json', Authorization: `Bearer ${this.env.NEXWALL_API_KEY}` },
        redirect: 'manual', signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ServiceError(`categories_http_${response.status}`);
      }
      const body: unknown = await response.json();
      if (!object(body) || !Array.isArray(body.data)) throw new ServiceError('invalid_categories_schema');
      const items: ProviderCategory[] = [];
      for (const value of body.data) {
        if (!object(value) || !Number.isSafeInteger(value.id) || Number(value.id) < 1
          || typeof value.name !== 'string' || !value.name.trim()) throw new ServiceError('invalid_categories_schema');
        items.push({ id: Number(value.id), name: value.name });
      }
      await this.ctx.storage.put('available_categories', { items, expiresAt: Date.now() + PERIOD_MS } satisfies CategoryCache);
      return items;
    } catch (error) {
      await this.ctx.storage.put('categories_retry_at', Date.now() + 10 * 60_000);
      throw error;
    }
  }

  async getPage(page: number, version: string | null, categoryId: number | null, search: string | null = null): Promise<PageResult> {
    try {
      if (this.env.SERVICE_ENABLED !== 'true') throw new ServiceError('service_disabled');
      const family = familyOf(categoryId, search);
      const headKey = `head:${family}`;
      const now = Date.now();
      let head = await this.ctx.storage.get<FeedHead>(headKey);
      if (version && (!head || head.version !== version || head.expiresAt <= now)) {
        throw new ServiceError('snapshot_expired', 410);
      }
      if (!head || head.expiresAt <= now) {
        if (page !== 1) throw new ServiceError('snapshot_expired', 410);
        // A new browsing generation is created only when page 1 is requested.
        head = await this.ctx.storage.transaction(async tx => {
          const latest = await tx.get<FeedHead>(headKey);
          if (latest && latest.expiresAt > Date.now()) return latest;
          const created: FeedHead = { version: crypto.randomUUID(), expiresAt: Date.now() + PERIOD_MS };
          await tx.put(headKey, created);
          return created;
        });
      }
      const control = await this.ctx.storage.get<Control>('control');
      if (control && control.blockedUntil > now
        && ['invalid_api_key', 'production_forbidden'].includes(control.blockedReason ?? '')) {
        throw new ServiceError(control.blockedReason!, 503);
      }
      if ((await this.ctx.storage.get<number>(`forbidden:${family}`) ?? 0) > now) {
        throw new ServiceError('production_forbidden', 503);
      }
      if (page > (head.lastPage ?? Number.MAX_SAFE_INTEGER)) throw new ServiceError('invalid_page', 400);
      const cacheKey = `page:${family}:${head.version}:${page}`;
      // All requests for this page pass through the named Durable Object. Share a
      // pending miss so concurrent users consume only one upstream attempt.
      let pending = this.pending.get(cacheKey);
      const hit = !pending && await this.readCached(cacheKey, head.version, page, categoryId, search);
      if (hit) return { page: hit, cacheStatus: 'hit' };
      pending = this.pending.get(cacheKey);
      if (!pending) {
        pending = this.fill(cacheKey, head, headKey, page, categoryId, search, family);
        this.pending.set(cacheKey, pending);
        void pending.finally(() => { if (this.pending.get(cacheKey) === pending) this.pending.delete(cacheKey); }).catch(() => {});
      }
      return { page: await pending, cacheStatus: 'miss' };
    } catch (error) {
      const known = error instanceof ServiceError;
      return { error: { code: known ? error.code : 'service_error', status: known ? error.status : 503 } };
    }
  }

  private async readCached(key: string, version: string, page: number, categoryId: number | null, search: string | null): Promise<CachedPage | null> {
    const entry = await this.env.WALLPAPER_CACHE.get<CachedPage>(key, 'json');
    return entry?.version === version && entry.page === page && entry.categoryId === categoryId && (entry.search ?? null) === search && entry.expiresAt > Date.now()
      ? entry : null;
  }

  private async fill(key: string, head: FeedHead, headKey: string, page: number, categoryId: number | null, search: string | null, family: string): Promise<CachedPage> {
    if (!this.env.NEXWALL_API_KEY?.trim()) throw new ServiceError('missing_api_key');
    const parsed = parsePage(await this.fetchPage(page, categoryId, search, family), page);
    const fetchedAt = Date.now();
    if (head.expiresAt <= fetchedAt) throw new ServiceError('snapshot_expired', 410);
    const value: CachedPage = { version: head.version, fetchedAt, expiresAt: head.expiresAt,
      page, categoryId, search, items: parsed.items, notices: parsed.notices, pageSize: parsed.pageSize,
      lastPage: parsed.lastPage, total: parsed.total };
    // KV is the page cache. A missing/deleted entry can be refilled on the next request.
    await this.env.WALLPAPER_CACHE.put(key, JSON.stringify(value), { expiration: Math.ceil(head.expiresAt / 1000) });
    if (page === 1) {
      await this.ctx.storage.transaction(async tx => {
        const current = await tx.get<FeedHead>(headKey);
        if (current?.version === head.version) await tx.put(headKey, { ...current, lastPage: parsed.lastPage });
      });
    }
    console.log(JSON.stringify({ event: 'page_cached', version: head.version, page, categoryId,
      items: value.items.length, lastPage: value.lastPage }));
    return value;
  }

  private async reserve(family: string): Promise<void> {
    const budget = await this.ctx.storage.transaction(async tx => {
      // Reuse the existing durable counter from the scheduled design.
      const c = (await tx.get<Control>('control')) ?? { day: '', attempts: 0, blockedUntil: 0 };
      const now = Date.now(), day = dayOf(now);
      if (c.day > day || c.blockedUntil > now) throw new ServiceError(c.blockedReason ?? 'upstream_cooldown', 429);
      if (((await tx.get<number>(`forbidden:${family}`)) ?? 0) > now) throw new ServiceError('production_forbidden', 503);
      if (c.day !== day) { c.day = day; c.attempts = 0; }
      if (c.attempts >= DAILY_LIMIT) throw new ServiceError('daily_budget_exhausted', 429);
      c.attempts++;
      // Reserve before the network call: failures, timeouts and retries all count.
      await tx.put('control', c);
      return { day: c.day, attempts: c.attempts };
    });
    console.log(JSON.stringify({ event: 'upstream_attempt_reserved', environment: 'production', ...budget, limit: DAILY_LIMIT }));
  }

  private async fetchPage(page: number, categoryId: number | null, search: string | null, family: string): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.reserve(family);
      const url = new URL(UPSTREAM);
      url.search = new URLSearchParams({ page: String(page), per_page: String(PAGE_SIZE), type: 'image', sort: 'newest' }).toString();
      if (categoryId !== null) url.searchParams.set('category_id', String(categoryId));
      if (search !== null) url.searchParams.set('search', search);
      let response: Response;
      try {
        response = await fetch(url, { headers: { Accept: 'application/json', Authorization: `Bearer ${this.env.NEXWALL_API_KEY}` },
          redirect: 'manual', signal: AbortSignal.timeout(8000) });
        if (response.ok) return await response.json();
      } catch {
        if (attempt === 1) throw new ServiceError('upstream_network_or_json_error');
        await new Promise(resolve => setTimeout(resolve, 250));
        continue;
      }
      if ([401, 403, 429].includes(response.status)) {
        await this.ctx.storage.transaction(async tx => {
          const c = (await tx.get<Control>('control'))!;
          const retry = response.headers.get('Retry-After');
          const until = retry && /^\d+$/.test(retry) ? Date.now() + Number(retry) * 1000 : Date.parse(retry ?? '');
          const blockedUntil = Math.max(nextDay(Date.now()), Number.isFinite(until) ? until : 0);
          if (response.status === 403) {
            // A category-specific denial must not disable unrelated cached feeds.
            await tx.put(`forbidden:${family}`, blockedUntil);
          } else {
            c.blockedUntil = blockedUntil;
            c.blockedReason = response.status === 429 ? 'production_rate_limited' : 'invalid_api_key';
            await tx.put('control', c);
          }
        });
        console.warn(JSON.stringify({ event: 'upstream_access_denied', status: response.status, page, categoryId }));
      }
      await response.body?.cancel();
      if (response.status === 403) throw new ServiceError('production_forbidden');
      if (response.status < 500 || attempt === 1) throw new ServiceError(`upstream_http_${response.status}`,
        response.status === 429 ? 429 : 503);
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new ServiceError('upstream_unavailable');
  }
}
