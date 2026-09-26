export const PERIOD_MS = 6 * 60 * 60 * 1000;
// Four refreshes/day * 16 planned requests = 64, leaving 16 retry attempts under the 80/day ceiling.
export const PLANNED_PAGES_PER_REFRESH = 16;
export const PAGE_SIZE = 100;
export const DAILY_LIMIT = 80;
export const COORDINATOR_NAME = 'nexwall-production-v1';
export const UPSTREAM = 'https://nexwall.kodnextech.com/api/developer/v1/wallpapers';
export const SANDBOX_UPSTREAM = 'https://nexwall.kodnextech.com/wallpaper-api/sandbox';
export type FeedEnvironment = 'production' | 'sandbox';

export interface Wallpaper extends Record<string, unknown> {
  id: number | string;
  image_url: string;
  thumbnail_url: string;
}
export interface Snapshot {
  version: string;
  fetchedAt: number;
  expiresAt: number;
  pages: Wallpaper[][];
  notices: Record<string, unknown>[];
  environment?: FeedEnvironment;
  fallbackReason?: string;
  pageSize?: number;
}
export interface SnapshotRef {
  version: string;
  expiresAt: number;
  availableUntil: number;
  environment?: FeedEnvironment;
}
export interface Manifest {
  current: SnapshotRef;
  previous?: SnapshotRef;
}
export class ServiceError extends Error {
  constructor(public code: string, public status = 503) { super(code); }
}
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const truthy = (value: unknown) => value === true || value === 1 || value === '1' || value === 'true';
export function allowed(item: Record<string, unknown>): boolean {
  const category = object(item.category) ? item.category : {};
  return !['is_premium', 'is_restricted', 'restricted', 'is_deleted', 'is_live', 'withdrawn'].some(k => truthy(item[k]))
    && !truthy(category.is_premium)
    && ![false, 0, '0', 'false'].includes(item.is_active as never)
    && !['removed', 'restricted', 'withdrawn', 'inactive', 'deleted'].includes(String(item.status).toLowerCase())
    && (item.type === undefined || ['static', 'image'].includes(String(item.type)))
    && !item.video_url;
}
function httpsUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password; }
  catch { return false; }
}
export function parsePage(body: unknown, page: number): { items: Wallpaper[]; notices: Record<string, unknown>; pageSize: number; lastPage: number } {
  if (!object(body) || !Array.isArray(body.data) || body.data.length > PAGE_SIZE) throw new ServiceError('invalid_upstream_schema');
  const meta = object(body.meta) ? body.meta : body;
  if (meta.current_page !== page || !Number.isInteger(meta.last_page) || Number(meta.last_page) < 1) {
    throw new ServiceError('invalid_upstream_pagination');
  }
  const pageSize = meta.per_page ?? PAGE_SIZE;
  if (!Number.isInteger(pageSize) || Number(pageSize) < 1 || Number(pageSize) > PAGE_SIZE || body.data.length > Number(pageSize)) {
    throw new ServiceError('invalid_upstream_pagination');
  }
  const items: Wallpaper[] = [];
  for (const value of body.data) {
    if (!object(value)) throw new ServiceError('invalid_upstream_item');
    if (!allowed(value)) continue;
    if (!/^[1-9]\d*$/.test(String(value.id)) || !httpsUrl(value.image_url)
      || (value.thumbnail_url != null && !httpsUrl(value.thumbnail_url))) throw new ServiceError('invalid_upstream_item');
    // Preserve item metadata, including provider attribution and rights notices.
    items.push({ ...value, id: value.id as string | number, image_url: value.image_url,
      thumbnail_url: (value.thumbnail_url ?? value.image_url) as string });
  }
  const notices = Object.fromEntries(Object.entries(body).filter(([key]) => /attribution|license|rights|copyright|notice/i.test(key)));
  return { items, notices, pageSize: Number(pageSize), lastPage: Number(meta.last_page) };
}
