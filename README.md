# Wallpaper cache Worker

A TypeScript Cloudflare Worker that serves NexWall wallpaper pages through a shared, on-demand KV cache. The app calls only this Worker; the NexWall production key stays in a Worker secret. A cold page request may contact NexWall. Repeated requests for the same page use the cache, and simultaneous misses are coordinated by a Durable Object.

Production endpoint: `https://wallpaper-cache.wallpaper-cache-worker.workers.dev/wallpapers?page=1`. See [APP_INTEGRATION.md](APP_INTEGRATION.md) for the Flutter contract.

## Setup

Use Node 22 or 24+. Run `npm ci --legacy-peer-deps`, `npm run check`, then `npm run deploy`. Add the production key in **Cloudflare → Workers & Pages → wallpaper-cache → Settings → Variables and Secrets → Add → Secret** under the exact name `NEXWALL_API_KEY`. Or enter it at the private prompt from `npx wrangler secret put NEXWALL_API_KEY`. Do not put the value in Git, `wrangler.jsonc`, Flutter, command arguments, or chat. `npm run deploy` uses `--keep-vars` to preserve dashboard variables and secrets.

The configured KV binding is `WALLPAPER_CACHE`; the named Durable Object binding is `REFRESH_COORDINATOR`. Its name and class are retained from the previous scheduled design so the durable request counter is not reset on deployment. There is no wallpaper refresh cron or public refresh endpoint. Local `npm run dev` has a separate KV and counter; use only a separate development key for local upstream testing.

## API contract

```text
GET /wallpapers?page=1
GET /wallpapers?page=2&snapshot=<version-from-page-1>
GET /wallpapers?page=1&category_id=13
GET /wallpapers?page=2&category_id=13&snapshot=<category-version>
GET /wallpapers?page=1&search=anime
GET /wallpapers?page=2&search=anime&snapshot=<search-version>
GET /categories
```

A page-1 request starts or reuses a six-hour browsing generation for that category or the unfiltered feed. Later pages require its `snapshot` UUID. A different category has a separate generation; start it at page 1 without carrying the old category's snapshot. The Worker forwards `page`, `category_id` when present, `per_page=100`, `type=image`, and `sort=newest` to NexWall only on a cache miss. `/categories` returns IDs and names available to the configured NexWall plan. The shared upstream response is cached for six hours; a cache fill counts against the same daily request budget. The provider's reported `last_page` and `per_page` drive pagination. There is no five-page or sixteen-page feed cap. `pagination.next_page` is `null` at the end. Unknown, duplicate, or malformed parameters are rejected. The response includes only metadata and hosted image URLs, never image files or the API key.

`search` accepts exactly these lowercase words: `gaming`, `anime`, `dark`, `dope`, `space`. Search and `category_id` cannot be combined. Each search term has its own cached pages and snapshot; carry that term and its returned `snapshot` through pagination. An uncached search page spends one upstream attempt under the same shared daily cap.

```json
{
  "data": [],
  "categories": [{ "id": 13, "name": "Nature & Landscapes" }],
  "selected_category_id": null,
  "pagination": {
    "current_page": 1,
    "per_page": 100,
    "requested_per_page": 100,
    "last_page": 50,
    "total": 5000,
    "has_more": true,
    "next_page": 2
  },
  "snapshot": "a UUID",
  "freshness": {
    "fetched_at": "ISO-8601 timestamp",
    "expires_at": "ISO-8601 timestamp",
    "age_seconds": 0,
    "status": "fresh"
  },
  "notices": [],
  "source": "NexWall",
  "environment": "production",
  "fallback_reason": null
}
```

`total` is the provider's reported count when available, otherwise `null`; it is not the number already cached. The `categories` list includes free categories observed in the returned page. It is not a complete category catalog and does not claim counts or cover images. Static, non-premium, non-restricted items are selected; provider rights and attribution fields are preserved. A short or empty `data` array is valid. A `snapshot` identifies a cache generation, **not** a NexWall server-side snapshot: as later pages are fetched on demand, new provider uploads can shift page boundaries. Clients should deduplicate item IDs across pages.

| Status | Meaning |
| --- | --- |
| 400 | Invalid page, category, or query |
| 410 | The requested generation expired; restart at page 1 |
| 429 | Per-IP throttling or the upstream attempt budget/quota was reached; respect `Retry-After` |
| 503 | Missing key, upstream/service failure, or `production_forbidden` when NexWall denies a feed with HTTP 403 |

The `X-Cache-Status` response header is `miss`, `hit`, or `edge` for operational checks. A first request for a page may take an upstream round trip. The same page is shared by all users while valid. A manually deleted KV page becomes a miss and is fetched again; a 15-second edge copy may briefly remain. Deleting a cache entry can consume a new NexWall request, so use `BLOCKED_WALLPAPER_IDS` for urgent content exclusion instead of deleting cache entries alone.

## Quota and expiry

The Durable Object reserves an attempt before each production request, including retries and failures. Its persisted count caps attempts at **80 per UTC day**, leaving margin below NexWall's documented Free-plan 100/day. The count survives Worker restarts and deployments. Two callers requesting the same cold page at once share one in-flight fetch; separate cold pages each use a request. A page retries once only for network/JSON errors or HTTP 5xx. A provider 401 or 429 stops further upstream calls until at least the next UTC day. A 403 blocks only the denied feed (unfiltered or a specific category), so a premium-category denial does not disable unrelated cached pages. The old global 403 block from the previous deployment remains active until its original expiry; it is not cleared just to retry a forbidden request. There is no sandbox fallback after hitting production limits; that would risk evading the provider's quota. If the key is absent, uncached pages return `missing_api_key` without calling the sandbox. Cached pages can still be served unless access is denied for their feed.

Each browsing generation and its KV pages expire six hours after the first page-1 request. Cache hits do not extend this time. An explicit expired `snapshot` returns 410; a new page-1 request without a snapshot starts a new generation. KV is eventually consistent; a newly written page may briefly be refetched from a different location. The named Durable Object coordinates concurrent misses and makes the quota limit strict. Public responses use `Cache-Control: no-store`; the Worker uses an internal edge copy for at most 15 seconds to reduce backend reads. A 120/minute per-IP limiter protects the app endpoint but is not the upstream quota counter.

Six hours is a proposed temporary retention policy, not provider-approved. NexWall's [API documentation](https://nexwall.kodnextech.com/wallpaper-api/docs) documents the 100-item maximum and Free-plan request allowance. Its [license](https://nexwall.kodnextech.com/wallpaper-api/license) permits reasonable temporary caching but prohibits catalog mirroring and quota evasion. This cache is for the app's user-driven browsing, not bulk export. Do not run a crawler against the Worker to fill the full catalog.

## Content removal and operations

The Worker filters known restricted, premium, withdrawn, and live items on each upstream fetch. It cannot learn about a later withdrawal until that page is fetched again or expires. For an urgent removal, add IDs to `BLOCKED_WALLPAPER_IDS`, increment `POLICY_VERSION` in `wrangler.jsonc`, and deploy. The block is applied to KV hits before responding. For a broad restriction, set `SERVICE_ENABLED=false` and deploy. Update local config too if changing dashboard variables so later deployments preserve the policy.

Run `npm run check` for TypeScript and Workers-runtime tests. Tests cover concurrent misses, cache hits, deleted-page refill, category filtering, expiry, pagination, quota persistence, retries, provider 429, and rights filtering. Run `npx wrangler tail --format json` or Workers Logs to see `upstream_attempt_reserved`, `page_cached`, `request_error`, and `app_request`. No keys, authorization headers, or provider response bodies are logged. Compare NexWall usage before and after repeated same-page requests: only the cold miss should count. Monitor Worker p50/p95 latency, KV operations, Durable Object activity, and provider quota headers/console.

## Optional Postgres/Hyperdrive

`src/database.ts` can perform a read-only `SELECT 1 AS ok` through a `HYPERDRIVE` binding when the scheduled handler is invoked. No Hyperdrive binding or wallpaper cron is currently configured, so this does not affect the wallpaper cache. To connect the existing Postgres database, create a Hyperdrive configuration in Cloudflare and add its non-secret ID to `wrangler.jsonc` as `"hyperdrive": [{ "binding": "HYPERDRIVE", "id": "YOUR_HYPERDRIVE_ID" }]`. Keep the database password in Cloudflare. See [Cloudflare's Hyperdrive guide](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/node-postgres/).
