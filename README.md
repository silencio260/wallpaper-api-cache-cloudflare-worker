# Wallpaper cache Worker

TypeScript Cloudflare Worker backed by KV and a SQLite Durable Object. The app path never contacts NexWall. Only a scheduled refresh can do so. The source contains no production credentials.

Deployed endpoint: **https://wallpaper-cache.wallpaper-cache-worker.workers.dev/wallpapers?page=1**.
Deployment version: see `npx wrangler deployments status`.

For Flutter client setup, see [APP_INTEGRATION.md](APP_INTEGRATION.md).

Deployment verification: 33 tests and TypeScript checks passed locally. The expanded live sandbox snapshot published 318 unique wallpapers across 16 pages; its page size is 20 because the sandbox clamps the requested 100. Its refresh log recorded 16 sandbox attempts and a durable daily count moving from 10 to 26. Authenticated production fetching and real Postgres connectivity remain unverified until the secret and Hyperdrive configuration are supplied.

## Development and deployment

Use Node 22 LTS or Node 24+.

```sh
npm ci --legacy-peer-deps
npm run check
npm run dry-run
npm run dev
```

The configured production account and `WALLPAPER_CACHE` namespace have been provisioned. Wrangler local mode uses separate local data. Tests use mock upstream responses and isolated local Cloudflare runtime storage; they do not use a real NexWall key.

Deploy with `npm run deploy`. Add the production key through **Cloudflare → Workers & Pages → wallpaper-cache → Settings → Variables and Secrets → Add → Secret**, named `NEXWALL_API_KEY`. Alternatively enter it into the private interactive prompt from `npx wrangler secret put NEXWALL_API_KEY`. Never put it in Wrangler vars, source files, Flutter, command arguments, or chat.

Refresh runs at **00:00, 06:00, 12:00, and 18:00 UTC** (01:00, 07:00, 13:00, and 19:00 Lagos). A missing key selects NexWall's public sandbox automatically. A production 401 or 429 also switches the entire refresh to sandbox; 403 access restrictions do not. Responses explicitly report `environment` and `fallback_reason`. Sandbox failures still return unavailable if no unexpired snapshot exists. No public refresh endpoint exists. Bootstrap can temporarily use a minute cron, with durable slot deduplication, then restore the normal cron after publication.

For local scheduled testing, use `npm run dev` and `curl 'http://localhost:8787/__scheduled?cron=0+*/6+*+*+*'`. Without a locally configured secret this fetches the public sandbox. Never use a production key with an independent local coordinator: it would have a separate counter.

## App API

```text
GET /wallpapers?page=1
GET /wallpapers?page=2&snapshot=<version-returned-by-page-1>
```

Pages start at 1 and continue through the published snapshot's `pagination.last_page`. Pages after 1 require a snapshot; unknown query parameters and duplicates are rejected. Each page contains up to the number the provider returns. Metadata and hosted URLs are returned; this server does not download or cache image files. Upstream duplicates, live images, premium entries and known restricted/withdrawn items are excluded. Empty or shorter pages are valid.

Every upstream request asks for **100 entries**, the documented production maximum. The public sandbox was verified to clamp this to **20 entries per page**. The Worker fetches up to 16 provider pages per refresh, or stops earlier at the provider's last page. This allows up to 320 sandbox items or 1,600 production items per snapshot while planning 64 requests per day and leaving 16 attempts for retries under the 80/day cap. `pagination.per_page` reports the provider's actual page size and `requested_per_page` reports 100. Both feeds use the verified `type=image` static-image filter (`type=static` returned no data). The sandbox URL is `/wallpaper-api/sandbox?endpoint=wallpapers`; it does not need a bearer token. The `sandbox_key_demo` token advertised in the console is not used.

```json
{
  "data": [],
  "pagination": {
    "current_page": 1,
    "per_page": 20,
    "requested_per_page": 100,
    "last_page": 16,
    "total": 0,
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
  "environment": "sandbox",
  "fallback_reason": "missing_api_key"
}
```

`total` counts this cached selection, not the provider catalog. `notices` preserves page-level rights information, and item metadata preserves attribution. Display applicable rights notices in clients. Preserve `snapshot` throughout pagination. On `410 snapshot_expired`, clear the old selection and restart at page 1. Distinguish offline transport errors from HTTP `503` service/cache errors. Do not silently fall back to NexWall.

| Status | Typical codes | Client handling |
| --- | --- | --- |
| 400 | `invalid_page`, `invalid_query`, `snapshot_required`, `invalid_snapshot` | Correct parameters |
| 410 | `snapshot_expired` | Restart pagination |
| 429 | `rate_limited` | Wait for `Retry-After` |
| 503 | `cache_unavailable`, `cache_expired`, `snapshot_propagating`, `service_error` | Show unavailable state; respect `Retry-After` |

Only `/wallpapers` is public. Native mobile HTTP clients do not require CORS. Browser access can be added with an explicit origin policy when needed.

## Consistency, expiry, budget

- A named Durable Object serializes scheduled jobs. A persisted slot ID deduplicates cron deliveries and survives restarts; a persisted lease prevents overlap. A crash may skip that refresh window rather than duplicate its traffic.
- The durable counter reserves an attempt **before** every upstream request. It resets at midnight UTC and caps attempts at 80, including retries and failures. It fails closed when persistence fails. Keep the same coordinator name/binding and storage when redeploying. Sharing the NexWall key with another Worker or service creates uncounted traffic and must be avoided.
- Every normal job fetches up to 16 pages (`per_page=100&type=image&sort=newest`), stopping at the provider's last page: up to 64 planned calls/day. Each page permits at most one retry for network/JSON errors or HTTP 5xx. Production 401/429 suppress production requests until at least the next UTC day, then restart the selection at sandbox page 1. `Retry-After` can extend cooldown. Sandbox 401/403/429 stops the refresh and starts a separate sandbox cooldown. Production 403 stops the refresh without fallback. Redirects are not followed. All attempts against both sources, including partial production pages discarded before fallback, share the 80/day cap; hitting the local cap does not open another budget.
- All pages must pass validation before a single immutable KV snapshot is saved. Only then is its reference published atomically in Durable Object storage. A failed page never partially replaces the previous snapshot. A new version may briefly return `snapshot_propagating` at another location while KV propagates.
- Retention is strictly **six hours from refresh start**, including fetching time. Expiry is checked during every request, independently of storage/cache eviction. A retained prior snapshot is usable for at most ten minutes after publication, and never beyond its original six-hour expiry. With exactly six-hour scheduling, old versions will usually already be expired at rollover. Refresh failure or propagation can create a service gap; there is no stale grace extension.
- The current manifest and complete snapshot use 15-second internal edge caches to reduce backend reads. Public responses use `no-store` so clients do not unknowingly retain service responses beyond expiry. Pagination of a previous snapshot drops IDs absent from the new selection and uses current URLs/rights for IDs still present. This can shorten a page.
- A 120/minute per-IP edge rate limit runs before cache reads. Cloudflare rate limit counters are local to a location and approximate; this is abuse mitigation, not an identity or global request budget. Shared mobile-network IPs share that allowance.

## Removals and restrictions

Scheduled refreshes detect changed availability; this is not an instantaneous removal feed. For an urgent removal, set `BLOCKED_WALLPAPER_IDS` to comma-separated IDs in `wrangler.jsonc`, increment `POLICY_VERSION`, and deploy. Exclusions run even on cache hits. For broad access restrictions set `SERVICE_ENABLED=false` and deploy. Update the local config too if changing dashboard variables, to avoid undoing the change on a later deployment.

Successful refreshes remove missing/restricted IDs from retained-page responses. Upstream 401/403 invalidates the manifest, subject to the existing 15-second manifest edge cache. KV payloads auto-expire within six hours; remove affected snapshot keys from KV as well if immediate physical deletion is required. Do not delete only KV keys and assume all edge copies are purged. Revoke service or apply exclusions first.

Six hours is a proposed application retention policy, not a provider-approved caching period. NexWall permits reasonable temporary caching but prohibits catalog mirroring, quota evasion and offering its API under another brand. This service is a bounded application backend, not a public replacement for NexWall. See the [NexWall license](https://nexwall.kodnextech.com/wallpaper-api/license) and [API documentation](https://nexwall.kodnextech.com/wallpaper-api/docs). The public sandbox was verified separately to return 20 items per page when requesting 100; the first production refresh must still verify the authenticated response schema. Schema mismatches fail closed and log an error code without exposing response bodies or credentials.

## Postgres through Hyperdrive

The driver is `pg`; the Worker enables Node.js compatibility. `src/database.ts` creates a client per invocation using `env.HYPERDRIVE.connectionString`, runs a read-only `SELECT 1 AS ok`, and closes the client. Hyperdrive maintains the underlying pool. No database schema changes or table writes are made.

The account initially had no Hyperdrive configurations. Create one in Cloudflare's **Storage & databases → Hyperdrive** using the direct Postgres endpoint and credentials. Keep the password there. Disable query caching when connection pooling alone is desired. Add the resulting non-secret ID to `wrangler.jsonc`:

```json
"hyperdrive": [{ "binding": "HYPERDRIVE", "id": "YOUR_HYPERDRIVE_ID" }]
```

The next scheduled event checks connectivity and logs `database_check` with status and latency. Database failures do not interrupt the independent KV wallpaper service. The binding is optional until the existing database is identified; do not interpret a successful Worker deployment as a verified database connection. For local testing, use a separate development database with `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` in your private environment, never a tracked config file. See [Cloudflare's pg/Hyperdrive instructions](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/node-postgres/).

## Operations and verification

`npm run check` runs TypeScript and Workers-runtime tests covering concurrent cache reads, expiry, pagination, KV propagation, withdrawal filtering, concurrent refresh, restart persistence, day rollover, failed pages, retries, budget exhaustion, redirect handling and upstream access failures.

Use `npx wrangler tail --format json` or Workers Logs to inspect `scheduled_refresh`, `refresh_published`, `refresh_failed`, `database_check`, and `app_request`. No headers, keys, database connection strings or provider bodies are logged. Missing secret, repeated refresh failures, fewer-than-expected item counts and non-200 app response rates warrant investigation. Counters can also be inspected in Durable Object storage through Cloudflare tooling; never clear them to work around quota limits.

Worker Analytics reports request volume, errors and latency. KV Analytics reports reads/writes; Durable Object metrics report calls/storage; Hyperdrive metrics report connections and queries. Internal edge caching reduces backend reads but does not eliminate Worker invocations. Track production p50/p95 latency and daily usage before broad rollout. `Server-Timing` measures Worker handler time; use client timings for network-inclusive latency.

After the first successful refresh, request page 1 repeatedly/concurrently, preserve its version for page 2, and compare NexWall's usage before/after. App reads must add zero NexWall calls. Do not run a high-volume load test against the provider. Flutter builds and device checks are outside this server repository.
