# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [1.7.4] - 2026-10-02

### Added
- **Manual / Interactive Import workflow for Sonarr, Radarr, and Lidarr.** Nine new tools reproduce the native Interactive Import flow for downloads the apps refused to import automatically:
  - `sonarr_get_manual_import_candidates`, `sonarr_preview_manual_import`, `sonarr_execute_manual_import`
  - `radarr_get_manual_import_candidates`, `radarr_preview_manual_import`, `radarr_execute_manual_import`
  - `lidarr_get_manual_import_candidates`, `lidarr_preview_manual_import`, `lidarr_execute_manual_import`
  - Retrieve the app's import candidates for a stuck download, optionally remap them (series/season/episodes, artist/album/release/tracks, movie), then import. `preview` never imports; `execute` re-fetches and re-verifies from the app on every call, so a stale preview cannot be imported and **no caller-supplied filesystem path is ever accepted**. A successful execute queues the native import command — imports are asynchronous and queue items are **not** deleted. Lidarr's `replaceExistingFiles` keeps its native Interactive Import meaning: `false` = "Combine with existing files" (no album-wide delete), `true` = "Replace Existing Files" (Lidarr deletes **all** existing track files for each affected album before importing, so a partial selection can leave the album missing files); the `filterExistingFiles` candidate-visibility filter is a separate, non-destructive option applied consistently across discovery, preview and execute.
  - **Lidarr release/edition-switch guard.** Lidarr's manual import always makes the imported release the album's monitored edition, so importing a candidate from a *different edition* silently switches the album (e.g. a 17-track deluxe → an 11-track standard) even with `replaceExistingFiles=false`. `preview` now reports a `releaseSwitchImpact` per album (current vs proposed release, track counts, the recordings that would fall outside the proposed edition, and a `preserveCurrentRelease` remap that upgrades the matching recordings on the current edition), and `execute` **refuses** such a switch on an album that already has files unless an exact `releaseSwitchAuthorizations` (album / from-release / to-release) authorizes it. `allowRejected`, `replaceExistingFiles` and `disableReleaseSwitching` do not authorize a release switch. `lidarr_get_albums` now shows each album's monitored release and per-release track counts. The guard fails closed: when the album's current release / file state cannot be verified, `preview` reports it as unassessable and `execute` refuses, and a suggested preserve-current-release remap is rejected if it would map two files onto one track.
  - Sonarr's preview compares a candidate against the existing episode file(s). For season packs whose quality metadata lives only in the release name (not the per-file names), it merges the tracked release's custom-format context with each file's own, so a file Sonarr rejects as "Not a Custom Format upgrade" is reported as a release-level upgrade (`cf-upgrade-with-native-rejection`) rather than a blanket "do not import" — and, symmetrically, a release-only negative custom format that the per-file check cannot see is reported as a downgrade (`cf-downgrade-despite-native-acceptance`) even when Sonarr raised no rejection. A per-file custom-format rejection is no longer treated as grounds to blocklist a release. Quality, revision and already-imported rejections are always hard refusals, evaluated across all of Sonarr's rejections so their order never changes the verdict, and overriding any rejection still requires an explicit `allowRejected=true`. When release-level custom-format evidence is relevant but can't be evaluated safely (unreconciled scores, an unresolvable quality profile, a remap to a different series, or a season pack with no queue context), the preview reports `cf-assessment-ambiguous` instead of claiming the file is equal to or better; an ordinary single-file download with no such evidence keeps the normal accepted verdict.
- **Slow previews no longer time out.** A preview normally returns its result directly. When the app's native analysis takes longer than a short response budget (most often Lidarr, which fuzzy-matches albums/tracks server-side), the preview returns a pollable handle instead of leaving the caller waiting, and the work keeps running in the background. Two new tools support this: `arr_get_operation` (poll a preview by its `operationId` — running / completed / failed / timed_out / cancelled) and `arr_cancel_operation` (stop a preview you no longer want). Identical previews started while one is already running are deduplicated to the same operation. Preview is non-destructive, so handles live only in the running server process; a completed preview is never reused as import authority — `execute` always re-fetches and re-verifies from the app.
- **Queue-item removal for Sonarr and Lidarr.** New tools `sonarr_delete_queue_item` and `lidarr_delete_queue_item`, with the same controls as the Radarr tool: `removeFromClient` (default `true`), `blocklist`, `skipRedownload` and `changeCategory` (default `false`).

### Changed
- **`radarr_delete_queue_item` gained `skipRedownload` and `changeCategory`.** Existing `queueId`/`removeFromClient`/`blocklist` behavior and defaults are unchanged; the two new options default to `false`.
- **Queue tools now report why an item didn't import.** `sonarr_get_queue`, `radarr_get_queue` and `lidarr_get_queue` pass through the native diagnostic fields — per-file rejection reasons (`statusMessages`), `errorMessage`, `downloadId`, `outputPath`, `indexer`, and the related series/movie/artist identifiers — so an import-pending item ("Episode file already imported", "Not a Custom Format upgrade", "Unable to determine if file is a sample") is distinguishable from an ordinary download. Sonarr's queue also keeps the tracked release's `customFormats`/`customFormatScore`. All previously returned fields and pagination are unchanged.

### Fixed
- **API requests now have real timeouts.** Every request to a *arr app previously had no deadline, so a genuinely hung endpoint (e.g. a long-running manual-import reprocess) could leave the server waiting indefinitely. Ordinary reads now abort after `ARR_API_TIMEOUT_MS` (default 120 s) and the expensive manual-import endpoints after `MANUAL_IMPORT_API_TIMEOUT_MS` (default 180 s); a preview operation also has an absolute deadline (`PREVIEW_MAX_RUNTIME_MS`, default 5 min) after which it is reported as `timed_out`. All are environment-configurable.
- **Queue DELETE no longer fails on empty response bodies.** The queue `DELETE` endpoints reply 200/204 with no body; the shared client threw when parsing it.
- **Queue `progress` no longer reports `NaN%` when the app returns the camelCase `sizeLeft` spelling** (used by Sonarr/Radarr v3). The mapping now falls back to `sizeLeft` when `sizeleft` is absent.
- **`removeFromClient=false` is now honored.** The parameter was omitted when false, so the apps' server-side default (`true`) deleted the release from the download client while the response reported it was kept. Every supplied option is now transmitted with its literal value.
- **Sonarr queue items keep their `seasonNumber`.** The native queue exposes `seasonNumber` at the top level; the mapper only read the nested `episode.seasonNumber`.

## [1.7.3] - 2026-07-29

### Fixed
- **Server no longer reports a stale version to clients.** `SERVER_VERSION` was hardcoded to `1.6.3` and had not been updated for three releases, so every client saw `1.6.3` in the `initialize` response regardless of the version actually running. It is now read from `package.json` at startup, which cannot drift. Falls back to `0.0.0-unknown` with a diagnostic on stderr if the file is unreadable, rather than failing startup.
- **`server.json` no longer drifts from the released version.** The MCP registry manifest was also stuck at `1.6.3`, in both its top-level `version` and its npm package entry. Because it is plain JSON it cannot read `package.json` at runtime, so it is now rewritten at bump time by `scripts/sync-server-json.mjs`, wired into the npm `version` lifecycle script. Running `npm version patch|minor|major` keeps the manifest in step automatically.

### Documentation
- Documented `sonarr_refresh_series` and `radarr_refresh_movie` in the README tool tables. Both shipped in 1.6.1 (via [#9](https://github.com/aplaceforallmystuff/mcp-arr/pull/9)) but were never listed, leaving 43 of 45 tools documented.

### Security
- Bumped `@modelcontextprotocol/sdk` from 1.29.0 to **1.30.0** and refreshed `package-lock.json` to clear seven Dependabot advisories in transitive dependencies. All were pulled in via the SDK; none are direct dependencies of this project, and none are reachable from the code paths this server uses (it imports only `Server`, `StdioServerTransport` and `StreamableHTTPServerTransport`, and builds its own listener on `node:http`). The lockfile still matters because the Docker image installs with `npm ci`.
  - `fast-uri` 3.1.2 → **3.1.4** (via `ajv`) — host confusion via literal backslash authority delimiter (GHSA-v2hh-gcrm-f6hx, high) and via failed IDN canonicalization (GHSA-4c8g-83qw-93j6, high).
  - `hono` 4.12.26 → **4.12.32** — server-side XSS via JSX escaping bypass in `cx()` (GHSA-w62v-xxxg-mg59), `hono/jsx` cross-request context disclosure (GHSA-hvrm-45r6-mjfj), and API Gateway v1 adapter dropping a repeated request header during de-duplication (GHSA-xgm2-5f3f-mvvc). This server uses no JSX and no Lambda adapter.
  - `@hono/node-server` 1.19.14 → **2.0.12** — `serve-static` path traversal on Windows via encoded backslash `%5C` (GHSA-frvp-7c67-39w9). Required the SDK bump: 1.29.0 pinned `^1.19.9`, which cannot reach the patched 2.0.5; 1.30.0 widens the range to `^1.19.9 || ^2.0.5`. This server does not use `serve-static`.
  - `body-parser` 2.2.2 → **2.3.0** (via `express`) — denial of service when an invalid limit value silently disables size enforcement (GHSA-v422-hmwv-36x6). This server does not use Express.

## [1.7.2] - 2026-06-30

### Fixed
- **HTTP transport no longer deadlocks behind a gateway/proxy** ([#22](https://github.com/aplaceforallmystuff/mcp-arr/pull/22), by [@rwlove](https://github.com/rwlove); fixes [#21](https://github.com/aplaceforallmystuff/mcp-arr/issues/21)). The previous implementation shared a single module-level `Server` and serialized every request through a queue, because one `Server` can only be connected to one transport at a time. The moment a streamable-HTTP client (e.g. an MCP gateway/proxy such as n8n) opened its long-lived `GET` SSE stream, that request never completed and blocked the queue permanently — every subsequent `POST` (`initialize`, `tools/list`, `tools/call`, …) hung with no response. The transport now builds a **fresh `Server` + `StreamableHTTPServerTransport` per request** (the SDK's documented stateless pattern) and tears them down on response close, so a long-lived stream can no longer block other requests. The stdio transport is unchanged. Verified: with a GET stream held open, a concurrent POST went from timing out at 8 s to returning in ~2 ms.

## [1.7.1] - 2026-06-30

### Security
- Bumped `hono` from 4.12.22 to **4.12.26** ([#26](https://github.com/aplaceforallmystuff/mcp-arr/pull/26)) to clear five advisories affecting `hono <= 4.12.24`: CORS middleware reflecting any origin with credentials (GHSA-88fw-hqm2-52qc), `serve-static` path traversal via encoded backslash on Windows (GHSA-wwfh-h76j-fc44), body-limit bypass on AWS Lambda (GHSA-rv63-4mwf-qqc2), and `Set-Cookie` / repeated-header dropping in the Lambda adapters (GHSA-j6c9-x7qj-28xf, GHSA-wgpf-jwqj-8h8p). Thanks to [@acesplit](https://github.com/acesplit) (#25) for the early report.

## [1.7.0] - 2026-06-30

### Added
- **Radarr feature expansion** ([#12](https://github.com/aplaceforallmystuff/mcp-arr/pull/12), by [@rappo](https://github.com/rappo)):
  - `radarr_update_movie` — update an existing movie's monitored state, quality profile, and other editable fields
  - `radarr_search_movies` — bulk-trigger searches across multiple movies at once
  - `radarr_delete_queue_item` — remove a stuck or unwanted item from the Radarr download queue
  - Quality-profile and quality fields surfaced on movie responses
- **Tag-triggered release pipeline** ([#20](https://github.com/aplaceforallmystuff/mcp-arr/pull/20), based on [#11](https://github.com/aplaceforallmystuff/mcp-arr/pull/11) by [@alejandrosnz](https://github.com/alejandrosnz)):
  - Multi-arch Docker images (`linux/amd64` + `linux/arm64`) built and pushed to **GHCR** on every `vX.Y.Z` tag, tagged `latest` / major / minor / exact
  - GitHub Release created automatically with notes pulled from this CHANGELOG
  - Hardened: every action pinned to a commit SHA, `workflow_dispatch` inputs passed via env vars, per-job least-privilege permissions, strict semver + package.json + CHANGELOG validation guards
  - **No npm publish and no stored `NPM_TOKEN`** — the pipeline uses only the per-run, auto-expiring `GITHUB_TOKEN`. npm publishing stays manual and passkey-gated.
- **`docker-compose.yml`** for self-hosters (n8n etc.) to run the server in HTTP mode in one command. Note: the compose HTTP endpoint is unauthenticated — intended for LAN / behind a reverse proxy only. Addresses the public-image request in [#5](https://github.com/aplaceforallmystuff/mcp-arr/issues/5).

## [1.6.5] - 2026-06-11

### Fixed
- HTTP transport now runs in **stateless mode** — a fresh `StreamableHTTPServerTransport` per request with no `Mcp-Session-Id` issued — fixing `400 Bad Request: Mcp-Session-Id header is required` for MCP clients that do not echo the session header back (notably **Claude Code**). The stateful implementation in 1.6.3/1.6.4 only worked for clients that round-tripped the session id. Request handling is serialized so the shared server is only ever connected to one transport at a time, and a fresh transport per request still sidesteps the SDK 1.27.x stateless-reuse guard. Added a regression test that exercises the no-session-header path. Thanks to [@jakefriz](https://github.com/jakefriz) (#15) and [@alejandrosnz](https://github.com/alejandrosnz) (#11) for independently identifying the stateless fix.

## [1.6.4] - 2026-06-10

### Security
- Bumped `@modelcontextprotocol/sdk` to `^1.29.0` to clear transitive CVEs in nested dependencies

### Note
- Supersedes the never-published-to-npm 1.6.3 (which was tagged but not released); 1.6.4 includes all 1.6.3 changes plus the dependency security update.

## [1.6.3] - 2026-04-27

### Fixed
- Fixed remote HTTP MCP mode failing after initialization with `@modelcontextprotocol/sdk` 1.27.x by enabling stateful HTTP sessions with generated MCP session IDs (#5, reported by [@michaelheyman](https://github.com/michaelheyman))

## [1.6.2] - 2026-04-22

### Fixed
- Upgraded `hono` and `path-to-regexp` to resolve 1 high and 2 moderate severity vulnerabilities (cookie name handling, path traversal in `toSSG`, static-serve middleware bypass, JSX SSR injection, IPv6 matching in `ipRestriction`, and ReDoS in `path-to-regexp`)

## [1.6.1] - 2026-04-22

### Added
- Remote HTTP MCP mode via `MCP_TRANSPORT=http` (with `HOST`, `PORT`, `MCP_PATH` env vars)
- Generic `search` and `fetch` tools for hosted/remote MCP clients (e.g. ChatGPT connectors)
- Docker usage examples in the README for both stdio and HTTP mode
- `limit` / `offset` pagination for:
  - `sonarr_get_queue`
  - `radarr_get_queue`
  - `lidarr_get_queue`
- `sonarr_refresh_series` and `radarr_refresh_movie` tools for triggering targeted metadata refresh ([#9](https://github.com/aplaceforallmystuff/mcp-arr/pull/9), contributed by [@ismael9291](https://github.com/ismael9291))
- `limit` / `offset` / `search` pagination for `sonarr_get_series` and `radarr_get_movies` ([#9](https://github.com/aplaceforallmystuff/mcp-arr/pull/9), contributed by [@ismael9291](https://github.com/ismael9291))

### Changed
- The server now starts in TRaSH-only mode even when no local *arr services are configured
- Queue responses now include pagination metadata (`total`, `returned`, `hasMore`, `nextOffset`, etc.)
- Refresh tool responses validate that the target exists before dispatching the command, and echo the resolved `id` / `title` / `year`
- README and server metadata updated to reflect remote MCP support and current versioning

### Fixed
- Broken README architecture image path
- Version drift between `package.json`, `server.json`, and runtime version metadata

### Removed
- Readarr (Books) support — replaced by Booklore + Shelfmark in Docker stack

## [1.5.4] - 2026-03-19

### Fixed
- Duplicate tool registrations for `sonarr_get_quality_profiles`, `sonarr_get_root_folders`, `radarr_get_quality_profiles`, and `radarr_get_root_folders` — each was registered twice (via `addConfigTools()` and manually), causing 8 duplicate entries ([#6](https://github.com/aplaceforallmystuff/mcp-arr/issues/6), reported by [@a1ad](https://github.com/a1ad))
- Updated dependencies to fix 3 high severity vulnerabilities (hono, @hono/node-server, express-rate-limit)

## [1.5.3] - 2026-02-27

### Fixed
- `lidarr_search` now returns `artistName` and `disambiguation` instead of generic `title` field
- `lidarr_search` accepts `term`, `query`, `artist`, or `name` parameters with validation
- Fixed null safety on `overview` field truncation in Lidarr search results

Based on [PR #2](https://github.com/aplaceforallmystuff/mcp-arr/pull/2) by [@bndlfm](https://github.com/bndlfm).

## [1.5.2] - 2026-02-27

### Fixed
- `@modelcontextprotocol/sdk` moved from devDependencies to dependencies — fixes `ERR_MODULE_NOT_FOUND` when installed via `npx` (#3)

## [1.5.1] - 2026-02-27

### Added
- Optional `tags` parameter on all add tools (`sonarr_add_series`, `radarr_add_movie`, `lidarr_add_artist`, `readarr_add_author`) - accepts array of tag IDs from the corresponding `*_get_tags` tool

## [1.5.0] - 2026-02-25

### Added
- `sonarr_add_series` - Add TV series to Sonarr library
- `radarr_add_movie` - Add movies to Radarr library
- `lidarr_add_artist` - Add artists to Lidarr library
- `readarr_add_author` - Add authors to Readarr library
- Helper tools for each service: `*_get_root_folders`, `*_get_quality_profiles`
- `lidarr_get_metadata_profiles` and `readarr_get_metadata_profiles` helpers

### Changed
- Search tool descriptions now reference the add workflow (e.g., "returns tvdbId needed for sonarr_add_series")

### Fixed
- Dependency vulnerabilities in @modelcontextprotocol/sdk, ajv, hono, and qs

## [1.4.1] - 2026-01-13

### Changed
- Updated `@modelcontextprotocol/sdk` to 1.25.2
- Updated `@types/node` to 20.19.29

### Fixed
- Security vulnerability in `qs` dependency (GHSA-6rw7-vpxm-498p)

### Added
- `CLAUDE.md` for Claude Code contributors

## [1.4.0] - 2025-12-01

### Added
- **TRaSH Guides Integration** - Access community-curated quality profiles, custom formats, and naming conventions directly through Claude:
  - `trash_list_profiles` - List available TRaSH quality profiles for Radarr or Sonarr
  - `trash_get_profile` - Get detailed profile with custom formats, scores, and quality settings
  - `trash_list_custom_formats` - List custom formats with optional category filter (hdr, audio, resolution, source, streaming, anime, unwanted, release, language)
  - `trash_get_naming` - Get recommended naming conventions for Plex, Emby, Jellyfin, or standard
  - `trash_get_quality_sizes` - Get recommended min/max/preferred sizes for each quality level
  - `trash_compare_profile` - Compare your profile against TRaSH recommendations
  - `trash_compare_naming` - Compare your naming config against TRaSH recommendations

- New `trash-client.ts` module for fetching and caching TRaSH Guides data from GitHub
- 1-hour cache for TRaSH data to minimize GitHub API calls
- Custom format categorization (HDR, audio, resolution, source, streaming, anime, etc.)

### Purpose
TRaSH Guides tools enable users to reference community best practices for *arr configuration without leaving Claude. Compare your current setup against TRaSH recommendations to identify missing custom formats, quality settings differences, and naming improvements.

## [1.3.0] - 2025-11-29

### Added
- **Configuration Review Tools** - New tools to inspect and analyze *arr service configurations:
  - `{service}_get_quality_profiles` - Detailed quality profile information including allowed qualities, upgrade settings, and custom format scores
  - `{service}_get_health` - Health check warnings and issues detected by the application
  - `{service}_get_root_folders` - Storage paths, free space, and accessibility status
  - `{service}_get_download_clients` - Download client configurations and settings
  - `{service}_get_naming` - File and folder naming conventions
  - `{service}_get_tags` - Tag definitions for content organization
  - `{service}_review_setup` - Comprehensive configuration dump for AI-assisted setup analysis

  These tools are available for Sonarr, Radarr, Lidarr, and Readarr (replace `{service}` with service name).

- New API client methods for configuration retrieval:
  - `getQualityProfiles()` - Full quality profile details
  - `getQualityDefinitions()` - Size limits per quality level
  - `getDownloadClients()` - Download client configurations
  - `getNamingConfig()` - Naming conventions
  - `getMediaManagement()` - File handling settings
  - `getHealth()` - Health check warnings
  - `getTags()` - Tag definitions
  - `getIndexers()` - Per-app indexer configs
  - `getMetadataProfiles()` - Metadata profiles (Lidarr/Readarr only)

### Purpose
The new configuration review tools enable natural language conversations about *arr setup optimization. Users can ask Claude to review their configuration and suggest improvements, especially helpful for understanding complex quality profiles and media management settings.

## [1.2.0] - 2025-11-28

### Added
- Sonarr episode management tools:
  - `sonarr_get_episodes` - List episodes for a series with availability status
  - `sonarr_search_missing` - Trigger search for missing episodes
  - `sonarr_search_episode` - Search for specific episodes
- Radarr download tools:
  - `radarr_search_movie` - Trigger search for a movie
- Lidarr album management tools:
  - `lidarr_get_albums` - List albums for an artist with availability status
  - `lidarr_search_album` - Trigger search for a specific album
  - `lidarr_search_missing` - Search for all missing albums for an artist
  - `lidarr_get_calendar` - View upcoming album releases
- Readarr book management tools:
  - `readarr_get_books` - List books for an author
  - `readarr_search_book` - Trigger search for specific books
  - `readarr_search_missing` - Search for missing books
  - `readarr_get_calendar` - View upcoming book releases
- Prowlarr indexer tools:
  - `prowlarr_test_indexers` - Health check all indexers
  - `prowlarr_get_stats` - Indexer statistics

## [1.1.0] - 2025-11-28

### Fixed
- Corrected API version for Lidarr, Readarr, and Prowlarr (use `/api/v1` instead of `/api/v3`)
- Added configurable `apiVersion` property to base ArrClient class

### Added
- `server.json` for MCP registry compatibility

## [1.0.0] - 2025-11-28

### Added
- Initial release with MCP tools for *arr media management suite
- **Sonarr** (TV) tools:
  - `sonarr_get_series` - List all TV series in library
  - `sonarr_search` - Search for TV series to add
  - `sonarr_get_queue` - View download queue
  - `sonarr_get_calendar` - View upcoming episodes
- **Radarr** (Movies) tools:
  - `radarr_get_movies` - List all movies in library
  - `radarr_search` - Search for movies to add
  - `radarr_get_queue` - View download queue
  - `radarr_get_calendar` - View upcoming releases
- **Lidarr** (Music) tools:
  - `lidarr_get_artists` - List all artists in library
  - `lidarr_search` - Search for artists to add
  - `lidarr_get_queue` - View download queue
- **Readarr** (Books) tools:
  - `readarr_get_authors` - List all authors in library
  - `readarr_search` - Search for authors to add
  - `readarr_get_queue` - View download queue
- **Prowlarr** (Indexers) tools:
  - `prowlarr_get_indexers` - List configured indexers
  - `prowlarr_search` - Search across all indexers
- **Cross-service** tools:
  - `arr_status` - Check health of all configured services
  - `arr_search_all` - Search across all media types
