# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed
- **`removeFromClient=false` now reaches the app as an explicit `false`.** `ArrClient.deleteQueueItem()` appended queue `DELETE` query parameters only when they were truthy, so a caller asking for `removeFromClient=false` produced a request with the parameter **omitted** — and Sonarr, Radarr and Lidarr all default `removeFromClient` to `true` server-side. The result was the opposite of what was requested: the release was deleted from the download client (qBittorrent/SABnzbd/etc.) while the MCP response reported `removedFromClient: false`. Every supplied option (`removeFromClient`, `blocklist`, `skipRedownload`, `changeCategory`) is now transmitted with its literal value, and only genuinely unspecified options are omitted, so the native request can no longer disagree with the MCP response. MCP-level defaults are unchanged.
- **Sonarr queue items keep their `seasonNumber`.** The native Sonarr queue resource exposes `seasonNumber` at the **top level**, but the MCP mapper only read `episode.seasonNumber`. `getQueue()` never requests embedded episode resources, so live responses carry the season number top-level and MCP dropped it. The mapper now reads the top-level field first and keeps the nested value as a compatibility fallback.

## [1.7.4] - 2026-10-02

### Added
- **Manual / Interactive Import workflow for Sonarr, Radarr, and Lidarr.** Nine new tools reproduce the native Interactive Import flow for downloads the apps refused to import automatically (unparseable filenames, missing episode/movie/album mapping, `Unable to determine if file is a sample`, partial multi-file imports):
  - `sonarr_get_manual_import_candidates`, `sonarr_preview_manual_import`, `sonarr_execute_manual_import`
  - `radarr_get_manual_import_candidates`, `radarr_preview_manual_import`, `radarr_execute_manual_import`
  - `lidarr_get_manual_import_candidates`, `lidarr_preview_manual_import`, `lidarr_execute_manual_import`

  The workflow is keyed by `downloadId` end to end: candidates are discovered via the native `GET /manualimport` endpoint (the app resolves the download location from the tracked download), referenced by the native resource id (`candidateId`), optionally remapped through the native reprocess/update endpoint (`POST /manualimport`), and imported through the native `ManualImport` command (`POST /command`). No generic raw-API tool is exposed and **no caller-supplied filesystem path is ever accepted** — execute re-fetches, re-resolves, and re-reprocesses on every call, so stale previews cannot be imported and no candidate state is cached server-side.

  Behavioral details: `preview` never imports; `execute` always sends `importMode` explicitly (default `auto`, matching the queue-driven UI behavior); Sonarr duplicate-episode and Lidarr duplicate-track selections are refused, mirroring the native UI safeguards; a successful execute returns the `commandId` with status `queued` — imports are asynchronous and queue items are intentionally **not** deleted. Existing queue tools are untouched.

  Agent guidance: discovery and preview responses now lead with a `verifyBeforeActing` directive stating that the suggested mapping and rejection reasons are Sonarr/Radarr/Lidarr **parse guesses, not facts** — a complete-looking `mappingValid: true` can still point at the wrong episodes/movie/album, and agents must independently verify against `sonarr_get_episodes` / `radarr_get_movies` / `lidarr_get_albums` before recommending `execute`, especially `allowRejected=true`. For Sonarr, the directive makes the **title the verification key**: number mismatches between the release name and Sonarr's detected episodes are expected mapping-source differences (TheTVDB/TMDB/absolute numbering), not evidence of error — the mapping is suspect only when the name contains an episode title that does not match the detected episodes' titles (matched by meaning, not exact string, for fan-sub/anime translations). On a title mismatch, search seasons in order: guessed season → release-title season → Specials → nearest-outward; number-only names trust the mapping. The rejection "Single episode file contains all episodes in seasons" is flagged as an almost-never-correct mapping: the file is usually misnamed or the release is a special (the name usually includes the special's title) — Sonarr's season-spanning episode list is suspect by default. An existing target file is flagged as NOT a reason to skip: the Sonarr preview now includes an `upgradeAssessment` — the candidate's quality weight and custom format score compared against the existing episode file(s) (`GET /episodeFile`). Verdicts: `not-an-upgrade` → do not import (Sonarr rejects with "Not an upgrade" / "Not a Custom Format upgrade" / "Episode already imported"); `no-existing-file` → fills a gap; `no-upgrade-rejection` → Sonarr raised no upgrade rejection, so the file is equal to or better than the existing one (equal quality + equal CF surfaces no warning — neutral, allowed replacement); the existing file(s) are listed with quality name and CF score for comparison. (The native episode-file data exposes no qualityWeight, and files link to episodes only via `episode.episodeFileId` — verified live.) After remapping a mis-parsed release the preview re-evaluates against the new target's file — check post-remap. Worked Letterkenny example included (`S04 The Haunting of MoDean's II` is the season-0 special, not S04E01–06; the special's existing file is equal quality/CF → no warning, neutral import).

  Safety model (verified against the native Sonarr/Radarr/Lidarr sources):
  - **Missing mappings are never fabricated.** Sonarr's reprocess resolves `seriesId` via `GetSeries` and Radarr's resolves `movieId` via `GetMovie`, both throwing for unknown ids — so a candidate with no valid series/movie mapping (and no override) is returned as `mappingRequired`/`canPreview: false` and is never POSTed to `/manualimport` with a `0` id. A `0` override is refused at parse time.
  - **Rejection bypass is per candidate.** `allowRejected` moved from a request-wide boolean to the execute items: authorizing file B's rejection does not authorize file A's. Overridden rejections are reported for auditability; no rejection text is ever classified as safe server-side.
  - **Candidate resolution requires exactly one match.** Native candidate ids are 31-bit path hashes and can collide; 0 matches → stale/unknown error, 2+ matches → ambiguous refusal (never a silent first-match pick, never path-based disambiguation).
  - **Lidarr track corrections survive reprocessing.** The native `ManualImportUpdateResource` has no `trackIds` field (Lidarr recomputes tracks server-side), so an explicit `trackIds` override is validated **strictly against the selected album release's track list** (`GET /track?albumReleaseId=…`, mirroring the native Interactive Import track selector) and preserved into the final `ManualImport` command — a corrected Track 7 is imported, not Lidarr's guessed Track 6. Tracks from other releases of the same album, other albums, or the candidate's current mapping are not authorization targets; recomputed tracks outside the release query are surfaced (`releaseTrackMismatch`) without widening the allowlist. `tracksSource` shows which mapping will import.

- **Queue-item removal for Sonarr and Lidarr.** New tools `sonarr_delete_queue_item` and `lidarr_delete_queue_item` call the native queue `DELETE` endpoints (`/api/v3/queue/{id}` and `/api/v1/queue/{id}`) with `removeFromClient` (default `true`), `blocklist` (default `false`), `skipRedownload` (default `false`) and `changeCategory` (default `false`). The implementation lives in the shared `ArrClient` — Sonarr, Radarr and Lidarr expose identical queue-removal controls.

### Changed
- **`radarr_delete_queue_item` gained `skipRedownload` and `changeCategory`.** Existing `queueId`/`removeFromClient`/`blocklist` behavior and defaults are unchanged; the two new options default to `false`.
- **Queue tools now return native import diagnostics.** `sonarr_get_queue`, `radarr_get_queue` and `lidarr_get_queue` pass through the diagnostic fields the native *arr queue APIs supply instead of discarding them: structured `statusMessages` (per-file import rejection reasons, kept as `{title, messages[]}` groups — never flattened, classified or truncated), `errorMessage`, `downloadId`, `outputPath`, `indexer`/`indexerId`, and service-specific identifiers when the API provides them (`seriesId`/`episodeId`/`seasonNumber` for Sonarr, `movieId` for Radarr, `artistId`/`albumId` for Lidarr). All previously returned fields and the existing `limit`/`offset` pagination semantics are unchanged, so existing consumers keep working. An MCP client can now tell an ordinary downloading item apart from an import-pending item (e.g. "Episode file already imported", "Not a Custom Format upgrade", "Unable to determine if file is a sample") without direct Sonarr API access.

### Fixed
- **Queue DELETE no longer fails on empty response bodies.** The *arr queue `DELETE` endpoints reply 200/204 with no body; `ArrClient.request()` unconditionally called `response.json()`, which throws on an empty body. It now returns `undefined` for empty responses.
- **Queue `progress` no longer reports `NaN%` when the app returns the camelCase `sizeLeft` spelling** (used by Sonarr/Radarr v3). The mapping now falls back to `sizeLeft` when `sizeleft` is absent.

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
