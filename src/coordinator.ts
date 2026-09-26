import { DurableObject } from 'cloudflare:workers';
import { DAILY_LIMIT, PLANNED_PAGES_PER_REFRESH, PAGE_SIZE, PERIOD_MS, UPSTREAM, SANDBOX_UPSTREAM, ServiceError, parsePage, type Manifest, type Snapshot, type FeedEnvironment } from './model';
import type { Env } from './index';

interface Control {
  day: string;
  attempts: number;
  lastSlot: number;
  lastGeneration?: string;
  leaseUntil: number;
  owner: string;
  blockedUntil: number;
  blockedReason?: string;
  sandboxBlockedUntil?: number;
}
const initial = (): Control => ({ day: '', attempts: 0, lastSlot: -1, leaseUntil: 0, owner: '', blockedUntil: 0 });
const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);
const nextDay = (now: number) => Date.parse(dayOf(now)) + 86400000;

export class RefreshCoordinator extends DurableObject<Env> {
  private running = false;

  async manifest(): Promise<Manifest | null> { return (await this.ctx.storage.get<Manifest>('manifest')) ?? null; }

  async refresh(scheduledTime: number): Promise<{ status: string }> {
    if (this.env.SERVICE_ENABLED !== 'true') return { status: 'disabled' };
    if (this.running) return { status: 'already_running' };
    const now = Date.now();
    // Ignore delayed deliveries from an earlier scheduling window and invalid times.
    if (!Number.isFinite(scheduledTime) || scheduledTime > now + 60000 || now - scheduledTime > PERIOD_MS) return { status: 'invalid_schedule' };
    const slot = Math.floor(scheduledTime / PERIOD_MS);
    const owner = crypto.randomUUID();
    this.running = true;
    try {
      const acquired = await this.ctx.storage.transaction(async tx => {
        const c = (await tx.get<Control>('control')) ?? initial();
        if (c.leaseUntil > now || c.lastSlot > slot
          || (c.lastSlot === slot && (c.lastGeneration ?? '1') === this.env.REFRESH_GENERATION)) return false;
        c.owner = owner; c.lastSlot = slot; c.lastGeneration = this.env.REFRESH_GENERATION;
        c.leaseUntil = now + 120000;
        await tx.put('control', c);
        return true;
      });
      if (!acquired) return { status: 'skipped' };
      const control = (await this.ctx.storage.get<Control>('control'))!;
      const fallbackReason = !this.env.NEXWALL_API_KEY?.trim() ? 'missing_api_key'
        : control.blockedUntil > now ? control.blockedReason ?? 'production_cooldown' : undefined;
      // A 403 is an access restriction, not a reason to switch sources.
      if (fallbackReason === 'production_forbidden') throw new ServiceError('upstream_cooldown');
      const snapshot: Snapshot = { version: owner, fetchedAt: now, expiresAt: now + PERIOD_MS,
        pages: [], notices: [], environment: fallbackReason ? 'sandbox' : 'production', fallbackReason };
      const seen = new Set<string>();
      for (let page = 1; page <= PLANNED_PAGES_PER_REFRESH; page++) {
        let body: unknown;
        try { body = await this.fetchPage(page, owner, snapshot.environment!); }
        catch (error) {
          if (snapshot.environment !== 'production' || !(error instanceof ServiceError)
            || !['upstream_http_401', 'upstream_http_429'].includes(error.code)) throw error;
          snapshot.environment = 'sandbox';
          snapshot.fallbackReason = error.code === 'upstream_http_429' ? 'production_rate_limited' : 'invalid_api_key';
          // Never mix production and sandbox pages in one published snapshot.
          snapshot.pages = []; snapshot.notices = []; snapshot.pageSize = undefined; seen.clear();
          page = 0;
          continue;
        }
        const parsed = parsePage(body, page);
        if (snapshot.pageSize !== undefined && snapshot.pageSize !== parsed.pageSize) throw new ServiceError('inconsistent_page_size');
        snapshot.pageSize = parsed.pageSize;
        snapshot.pages.push(parsed.items.filter(item => {
          const id = String(item.id);
          if (seen.has(id)) return false;
          seen.add(id); return true;
        }));
        snapshot.notices.push(parsed.notices);
        if (page >= parsed.lastPage) break;
      }
      // One immutable KV value contains every page: no torn multi-key snapshots.
      await this.env.WALLPAPER_CACHE.put(`snapshot:${owner}`, JSON.stringify(snapshot), {
        expiration: Math.ceil(snapshot.expiresAt / 1000),
      });
      await this.ctx.storage.transaction(async tx => {
        const c = await tx.get<Control>('control');
        if (c?.owner !== owner || c.leaseUntil <= Date.now()) throw new ServiceError('refresh_lease_lost');
        const old = await tx.get<Manifest>('manifest');
        const manifest: Manifest = {
          current: { version: owner, expiresAt: snapshot.expiresAt, availableUntil: snapshot.expiresAt, environment: snapshot.environment },
          previous: old?.current && old.current.expiresAt > Date.now()
            && (old.current.environment ?? 'production') === snapshot.environment
            ? { ...old.current, availableUntil: Math.min(old.current.expiresAt, Date.now() + 10 * 60000) } : undefined,
        };
        await tx.put('manifest', manifest);
      });
      console.log(JSON.stringify({ event: 'refresh_published', version: owner, environment: snapshot.environment,
        fallbackReason: snapshot.fallbackReason, items: seen.size, pageSize: snapshot.pageSize, durationMs: Date.now() - now }));
      return { status: 'published' };
    } catch (error) {
      const code = error instanceof ServiceError ? error.code : 'refresh_internal_error';
      console.error(JSON.stringify({ event: 'refresh_failed', code, durationMs: Date.now() - now }));
      return { status: code };
    } finally {
      try {
        await this.ctx.storage.transaction(async tx => {
          const c = await tx.get<Control>('control');
          if (c?.owner === owner) { c.leaseUntil = 0; await tx.put('control', c); }
        });
      } finally { this.running = false; }
    }
  }

  private async reserve(owner: string, environment: FeedEnvironment): Promise<void> {
    const budget = await this.ctx.storage.transaction(async tx => {
      const c = (await tx.get<Control>('control')) ?? initial();
      const now = Date.now(), day = dayOf(now);
      if (c.owner !== owner || c.leaseUntil <= now) throw new ServiceError('refresh_lease_lost');
      const blockedUntil = environment === 'production' ? c.blockedUntil : c.sandboxBlockedUntil ?? 0;
      if (c.day > day || blockedUntil > now) throw new ServiceError('upstream_cooldown');
      if (c.day !== day) { c.day = day; c.attempts = 0; }
      if (c.attempts >= DAILY_LIMIT) throw new ServiceError('daily_budget_exhausted');
      c.attempts++;
      c.leaseUntil = now + 120000;
      // Commit before sending: timeouts, redirects, HTTP failures and retries count.
      await tx.put('control', c);
      return { day: c.day, attempts: c.attempts };
    });
    console.log(JSON.stringify({ event: 'upstream_attempt_reserved', environment, ...budget, limit: DAILY_LIMIT }));
  }

  private async fetchPage(page: number, owner: string, environment: FeedEnvironment): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.reserve(owner, environment);
      const url = new URL(environment === 'production' ? UPSTREAM : SANDBOX_UPSTREAM);
      url.search = new URLSearchParams({ page: String(page), per_page: String(PAGE_SIZE), type: 'image', sort: 'newest' }).toString();
      if (environment === 'sandbox') url.searchParams.set('endpoint', 'wallpapers');
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (environment === 'production') headers.Authorization = `Bearer ${this.env.NEXWALL_API_KEY}`;
      let response: Response;
      try {
        response = await fetch(url, { headers,
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
          if (environment === 'sandbox') c.sandboxBlockedUntil = blockedUntil;
          else {
            c.blockedUntil = blockedUntil;
            c.blockedReason = response.status === 429 ? 'production_rate_limited'
              : response.status === 401 ? 'invalid_api_key' : 'production_forbidden';
          }
          await tx.put('control', c);
          // Access failures invalidate the old selection too.
          if (response.status !== 429) await tx.delete('manifest');
        });
      }
      await response.body?.cancel();
      if (response.status < 500 || attempt === 1) throw new ServiceError(`upstream_http_${response.status}`);
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new ServiceError('upstream_unavailable');
  }
}
