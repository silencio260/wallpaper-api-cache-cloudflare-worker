# Flutter integration: Wallpaper Cache API

This guide connects an existing Flutter wallpaper screen to the deployed Cloudflare Worker. The Worker contacts NexWall only when a requested page is missing from its shared cache. The app never needs a NexWall key and must not call NexWall directly.

## 1. Choose the app environment explicitly

The production base URL is:

```text
https://wallpaper-cache.wallpaper-cache-worker.workers.dev
```

The sandbox app environment uses a locally running copy of this Worker. Start it from this repository with `npm run dev`. It needs a separate local development `NEXWALL_API_KEY` to fetch uncached pages; it does not use NexWall's public sandbox. On an Android emulator, the host machine is `10.0.2.2`; for an iOS simulator, use `http://127.0.0.1:8787`. A physical device needs a reachable development URL. Local data and the local request counter are separate from production.

Set explicit build values:

```sh
# Android emulator, local Worker
flutter run --dart-define=WALLPAPER_API_ENV=sandbox \
  --dart-define=WALLPAPER_SANDBOX_BASE_URL=http://10.0.2.2:8787

# Deployed Worker
flutter run --dart-define=WALLPAPER_API_ENV=cloudflare

# Release
flutter build apk --release --dart-define=WALLPAPER_API_ENV=cloudflare
```

The local Worker fetches a page on the first request and caches it. Use a separate development key because local mode has its own quota counter. On Android, allow Internet access. Cleartext HTTP to `10.0.2.2` may need an Android **debug-only** network security configuration; production remains HTTPS.

Create `lib/wallpapers/wallpaper_api_config.dart`:

```dart
import 'package:flutter/foundation.dart';

class WallpaperApiConfig {
  static const _environment = String.fromEnvironment('WALLPAPER_API_ENV');
  static const _sandboxBase = String.fromEnvironment(
    'WALLPAPER_SANDBOX_BASE_URL',
  );

  static Uri get baseUri {
    switch (_environment) {
      case 'cloudflare':
        return Uri.parse(
          'https://wallpaper-cache.wallpaper-cache-worker.workers.dev',
        );
      case 'sandbox':
        if (kReleaseMode) {
          throw StateError('Sandbox is unavailable in release builds.');
        }
        if (_sandboxBase.isEmpty) {
          throw StateError('Set WALLPAPER_SANDBOX_BASE_URL.');
        }
        return Uri.parse(_sandboxBase);
      default:
        throw StateError('Set WALLPAPER_API_ENV to sandbox or cloudflare.');
    }
  }
}
```

These values are endpoint configuration, not secrets. Keep `NEXWALL_API_KEY` only in the Cloudflare Worker's secret settings.

## 2. Add the HTTP client and models

Run `flutter pub add http`. Create `lib/wallpapers/wallpaper_api.dart`:

```dart
import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'wallpaper_api_config.dart';

enum WallpaperFailure { offline, unavailable, expired, throttled, invalidRequest }

class WallpaperApiException implements Exception {
  const WallpaperApiException(this.kind, this.message);

  final WallpaperFailure kind;
  final String message;
}

class WallpaperItem {
  const WallpaperItem({
    required this.id,
    required this.imageUrl,
    required this.thumbnailUrl,
    required this.metadata,
  });

  final String id;
  final String imageUrl;
  final String thumbnailUrl;
  final Map<String, dynamic> metadata;

  factory WallpaperItem.fromJson(Map<String, dynamic> json) {
    final id = json['id'];
    final imageUrl = json['image_url'];
    final thumbnailUrl = json['thumbnail_url'] ?? imageUrl;
    if (id == null || imageUrl is! String || thumbnailUrl is! String) {
      throw const FormatException('Invalid wallpaper metadata');
    }
    return WallpaperItem(
      id: id.toString(),
      imageUrl: imageUrl,
      thumbnailUrl: thumbnailUrl,
      metadata: json,
    );
  }
}

class WallpaperPage {
  const WallpaperPage({
    required this.items,
    required this.snapshot,
    required this.nextPage,
    required this.expiresAt,
    required this.environment,
    required this.notices,
  });

  final List<WallpaperItem> items;
  final String snapshot;
  final int? nextPage;
  final DateTime expiresAt;
  final String environment;
  final List<dynamic> notices;

  factory WallpaperPage.fromJson(Map<String, dynamic> json) {
    final data = json['data'] as List<dynamic>;
    final pagination = json['pagination'] as Map<String, dynamic>;
    final freshness = json['freshness'] as Map<String, dynamic>;
    return WallpaperPage(
      items: data
          .map((value) => WallpaperItem.fromJson(value as Map<String, dynamic>))
          .toList(growable: false),
      snapshot: json['snapshot'] as String,
      nextPage: pagination['next_page'] as int?,
      expiresAt: DateTime.parse(freshness['expires_at'] as String),
      environment: json['environment'] as String,
      notices: (json['notices'] as List<dynamic>?) ?? const [],
    );
  }
}

class WallpaperApi {
  WallpaperApi(this._client);

  final http.Client _client;

  Future<WallpaperPage> fetchPage({int page = 1, String? snapshot}) async {
    if (page < 1 || (page > 1 && snapshot == null)) {
      throw const WallpaperApiException(
        WallpaperFailure.invalidRequest,
        'Invalid page or missing snapshot.',
      );
    }

    final base = WallpaperApiConfig.baseUri;
    final uri = base.replace(
      path: '/wallpapers',
      queryParameters: {
        'page': page.toString(),
        if (snapshot != null) 'snapshot': snapshot,
      },
    );

    late http.Response response;
    try {
      response = await _client.get(
        uri,
        headers: const {'Accept': 'application/json'},
      ).timeout(const Duration(seconds: 20));
    } on TimeoutException {
      throw const WallpaperApiException(
        WallpaperFailure.offline,
        'The connection timed out. Check your network and retry.',
      );
    } on http.ClientException {
      throw const WallpaperApiException(
        WallpaperFailure.offline,
        'You appear to be offline. Check your connection and retry.',
      );
    }

    if (response.statusCode == 410) {
      throw const WallpaperApiException(
        WallpaperFailure.expired,
        'This wallpaper selection expired. Reload from page 1.',
      );
    }
    if (response.statusCode == 429) {
      throw const WallpaperApiException(
        WallpaperFailure.throttled,
        'Too many requests. Wait a moment before retrying.',
      );
    }
    if (response.statusCode == 400) {
      throw const WallpaperApiException(
        WallpaperFailure.invalidRequest,
        'The wallpaper request is invalid.',
      );
    }
    if (response.statusCode != 200) {
      throw const WallpaperApiException(
        WallpaperFailure.unavailable,
        'Wallpapers are temporarily unavailable. Try again later.',
      );
    }

    try {
      final body = jsonDecode(response.body) as Map<String, dynamic>;
      return WallpaperPage.fromJson(body);
    } catch (_) {
      throw const WallpaperApiException(
        WallpaperFailure.unavailable,
        'The wallpaper service returned an invalid response.',
      );
    }
  }

  void close() => _client.close();
}
```

Instantiate once for the screen or existing repository layer: `final api = WallpaperApi(http.Client());`. Close it when the owner is disposed. Use your existing dependency injection setup if you have one.

## 3. Preserve the snapshot during pagination

Create `lib/wallpapers/wallpaper_feed_controller.dart` and connect it to your existing grid's state management. This example owns the API client and clears expired items even if the user leaves the screen open:

```dart
import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import 'wallpaper_api.dart';

class WallpaperFeedController extends ChangeNotifier {
  WallpaperFeedController() : _api = WallpaperApi(http.Client());

  final WallpaperApi _api;
  Timer? _expiryTimer;
  final List<WallpaperItem> items = [];
  final List<dynamic> notices = [];

  String? snapshot;
  int? nextPage;
  DateTime? expiresAt;
  String? environment;
  WallpaperApiException? error;
  bool loading = false;

  Future<void> refresh() async {
    if (loading) return;
    loading = true;
    error = null;
    notifyListeners();
    try {
      final first = await _api.fetchPage();
      items
        ..clear()
        ..addAll(first.items);
      notices
        ..clear()
        ..addAll(first.notices);
      snapshot = first.snapshot;
      nextPage = first.nextPage;
      environment = first.environment;
      _setExpiry(first.expiresAt);
    } on WallpaperApiException catch (failure) {
      error = failure;
    } finally {
      loading = false;
      notifyListeners();
    }
  }

  Future<void> loadMore() async {
    if (loading || nextPage == null || snapshot == null) return;
    if (expiresAt == null || !DateTime.now().isBefore(expiresAt!)) {
      _expire();
      return;
    }
    loading = true;
    error = null;
    notifyListeners();
    try {
      final next = await _api.fetchPage(
        page: nextPage!,
        snapshot: snapshot,
      );
      if (next.snapshot != snapshot) {
        _expire();
        return;
      }
      items.addAll(next.items);
      nextPage = next.nextPage;
      _setExpiry(next.expiresAt);
    } on WallpaperApiException catch (failure) {
      if (failure.kind == WallpaperFailure.expired) {
        _expire();
      } else {
        error = failure;
      }
    } finally {
      loading = false;
      notifyListeners();
    }
  }

  void _setExpiry(DateTime value) {
    _expiryTimer?.cancel();
    expiresAt = value;
    final remaining = value.difference(DateTime.now());
    if (remaining <= Duration.zero) {
      _expire();
    } else {
      _expiryTimer = Timer(remaining, _expire);
    }
  }

  void _expire() {
    _expiryTimer?.cancel();
    items.clear();
    notices.clear();
    snapshot = null;
    nextPage = null;
    expiresAt = null;
    environment = null;
    error = const WallpaperApiException(
      WallpaperFailure.expired,
      'This selection expired. Reload to see current wallpapers.',
    );
    notifyListeners();
  }

  @override
  void dispose() {
    _expiryTimer?.cancel();
    _api.close();
    super.dispose();
  }
}
```

Request **one next page at a time**. Keep the snapshot returned by page 1 until the user explicitly refreshes the feed. `pagination.next_page` is `null` on the final page. On HTTP `410`, clear the current items and snapshot, show “Selection expired,” and offer a button that reloads page 1. The response's `freshness.expires_at` is authoritative; clear or hide items when it passes, even if the user stays on the screen. Do not persist item metadata or URLs past that time.

The Worker requests `per_page=100` upstream. The response reports the actual `pagination.per_page` and `requested_per_page=100`. There is no fixed five-page or sixteen-page feed cap. Each previously uncached page consumes one NexWall request, up to the shared daily attempt limit. Build the grid from `data.length`, follow `next_page`, and deduplicate IDs if the upstream feed shifts while browsing.

## 4. Keep the existing wallpaper UI

- **Grid:** Use `item.thumbnailUrl` for each tile and keep the current loading and scrolling behavior.
- **Preview:** Pass the selected `WallpaperItem` to the existing preview screen and use `item.imageUrl` for the full image.
- **Download/apply:** Pass `item.imageUrl` to the existing download or wallpaper setting code. Keep its permission and progress handling. The Worker returns metadata and hosted URLs, not image bytes.
- **Rights:** Preserve and display applicable `metadata` attribution or rights fields and page-level `notices` where the provider supplies them. Keep any required attribution visible in the UI.
- **Errors:** Show a network message for `offline`, an expired selection message for `expired`, a retry-later message for `unavailable`, and a short wait message for `throttled`. Do not silently switch the app to a direct NexWall request.

These UI operations do not alter the existing image flow. Opening an uncached grid page can consume a NexWall request; repeated and simultaneous requests for the same page share its cached result.

## 5. Verify the integration

Use the deployed API first:

```sh
curl -i 'https://wallpaper-cache.wallpaper-cache-worker.workers.dev/wallpapers?page=1'
```

Copy the returned `snapshot`, then request `?page=2&snapshot=THE_VERSION`. Follow `pagination.next_page` until it is `null`. There is no sandbox fallback. The Worker needs `NEXWALL_API_KEY` as a Cloudflare secret to fill an uncached page; the app build needs no change. A deleted KV page is refilled on demand, subject to the daily quota.

Check these cases in the app: airplane mode, HTTP 503, snapshot expiry/410, rapid repeated scrolling, a refresh while browsing page 2, preview, download, and applying a wallpaper. Confirm that the `snapshot` parameter stays the same across pages. App builds and device checks belong in the Flutter project.

The [NexWall license](https://nexwall.kodnextech.com/wallpaper-api/license) permits reasonable temporary caching and requires honoring removals and rights notices. This Worker expires each browsing generation and its cached pages six hours after the first page-1 request. See [README.md](README.md) for server deployment and operation details.
