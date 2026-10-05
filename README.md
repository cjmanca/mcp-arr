# MCP *arr Server

![Architecture](docs/mcp-arr-architecture-diagram.png)

<!-- <p align="center">
  <img src="docs/mcp-arr-logo.png" alt="MCP *arr Server" width="400">
</p> -->

[![Oathe Security](https://img.shields.io/endpoint?url=https%3A%2F%2Faudit-engine.oathe.ai%2Fapi%2Fbadge%2Faplaceforallmystuff%2Fmcp-arr&style=for-the-badge&logo=data:image/svg%2Bxml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHZpZXdCb3g9JzAgMCAyNCAyNCcgZmlsbD0nd2hpdGUnPjxwYXRoIGQ9J00xMiAyQzkuMjQgMiA3IDQuMjQgNyA3djNINmMtMS4xIDAtMiAuOS0yIDJ2OGMwIDEuMS45IDIgMiAyaDEyYzEuMSAwIDItLjkgMi0ydi04YzAtMS4xLS45LTItMi0yaC0xVjdjMC0yLjc2LTIuMjQtNS01LTV6bTMgMTBIOVY3YzAtMS42NiAxLjM0LTMgMy0zczMgMS4zNCAzIDN2M3onLz48L3N2Zz4=&labelColor=000000&cacheSeconds=3600)](https://oathe.ai/report/aplaceforallmystuff/mcp-arr)
[![npm version](https://img.shields.io/npm/v/mcp-arr-server.svg)](https://www.npmjs.com/package/mcp-arr-server)
[![CI](https://github.com/aplaceforallmystuff/mcp-arr/actions/workflows/ci.yml/badge.svg)](https://github.com/aplaceforallmystuff/mcp-arr/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![MCP](https://img.shields.io/badge/MCP-Compatible-blue)](https://modelcontextprotocol.io)

MCP server for the [*arr media management suite](https://wiki.servarr.com/) - Sonarr, Radarr, Lidarr, and Prowlarr.

Supports both local `stdio` mode for Claude/Codex-style clients and remote HTTP mode for hosted MCP clients such as ChatGPT connectors.

## Why Use This?

- **Unified media management** - Control all your *arr applications from one interface
- **Natural language queries** - Ask about your library in plain English
- **Cross-service search** - Find content across TV, movies, and music simultaneously
- **Download monitoring** - Check queue status and progress across all services
- **Calendar integration** - See upcoming releases for all media types
- **Configuration review** - Get AI-powered suggestions for optimizing your setup
- **Flexible configuration** - Enable only the services you use

## Features

| Category | Capabilities |
|----------|-------------|
| **Sonarr (TV)** | List series, view episodes, search shows, trigger downloads, check queue, view calendar, review setup |
| **Radarr (Movies)** | List movies, search films, trigger downloads, check queue, view releases, review setup |
| **Lidarr (Music)** | List artists, view albums, search musicians, trigger downloads, check queue, view calendar, review setup |
| **Prowlarr (Indexers)** | List indexers, search across all trackers, test health, view statistics |
| **Cross-Service** | Status check, unified search across all configured services |
| **Configuration** | Quality profiles, download clients, naming conventions, health checks, storage info |
| **TRaSH Guides** | Reference quality profiles, custom formats, naming conventions, compare against recommendations |

## Prerequisites

- Node.js 18+
- At least one *arr application running with API access:
  - [Sonarr](https://sonarr.tv/) for TV series
  - [Radarr](https://radarr.video/) for movies
  - [Lidarr](https://lidarr.audio/) for music
  - [Prowlarr](https://prowlarr.com/) for indexer management

## Installation

### Using npm (Recommended)

```bash
npx mcp-arr-server
```

### Remote HTTP Mode

```bash
MCP_TRANSPORT=http PORT=3000 npx mcp-arr-server
```

By default the remote server listens on `127.0.0.1:3000` and serves MCP on `/mcp`.

Environment variables for remote mode:

- `MCP_TRANSPORT=http` to enable remote Streamable HTTP transport
- `HOST` to override the bind host (default `127.0.0.1`)
- `PORT` to override the port (default `3000`)
- `MCP_PATH` to override the MCP endpoint path (default `/mcp`)

### Docker

Prebuilt images are published to GitHub Container Registry on every release. You do not need to
build anything:

```bash
docker pull ghcr.io/aplaceforallmystuff/mcp-arr:latest
```

Tags follow the release version — `latest`, `1`, `1.7`, and each exact version such as `1.7.3`.
Pin to a major or minor tag if you want updates without surprises.

Run in local stdio mode:

```bash
docker run --rm -i \
  -e SONARR_URL=http://host.docker.internal:8989 \
  -e SONARR_API_KEY=your-sonarr-api-key \
  ghcr.io/aplaceforallmystuff/mcp-arr:latest
```

Run in remote HTTP mode:

```bash
docker run --rm -p 3000:3000 \
  -e MCP_TRANSPORT=http \
  -e HOST=0.0.0.0 \
  -e PORT=3000 \
  -e SONARR_URL=http://host.docker.internal:8989 \
  -e SONARR_API_KEY=your-sonarr-api-key \
  ghcr.io/aplaceforallmystuff/mcp-arr:latest
```

Minimal `docker-compose.yml`:

```yaml
services:
  mcp-arr:
    image: ghcr.io/aplaceforallmystuff/mcp-arr:latest
    ports:
      - "3000:3000"
    environment:
      MCP_TRANSPORT: http
      HOST: 0.0.0.0
      PORT: 3000
      SONARR_URL: http://host.docker.internal:8989
      SONARR_API_KEY: your-sonarr-api-key
      RADARR_URL: http://host.docker.internal:7878
      RADARR_API_KEY: your-radarr-api-key
```

#### Building it yourself

Only needed if you are developing against a change that is not released yet:

```bash
docker build -t mcp-arr .
```

### From Source

```bash
git clone https://github.com/aplaceforallmystuff/mcp-arr.git
cd mcp-arr
npm install
npm run build
```

## Configuration

### Getting API Keys

Each *arr application has an API key in Settings > General > Security:

1. Open your *arr application's web interface
2. Go to **Settings** > **General**
3. Find the **API Key** under the Security section
4. Copy the API key for use in configuration

### For Claude Desktop

Add to your Claude Desktop config file:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`

**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "arr": {
      "command": "npx",
      "args": ["-y", "mcp-arr-server"],
      "env": {
        "SONARR_URL": "http://localhost:8989",
        "SONARR_API_KEY": "your-sonarr-api-key",
        "RADARR_URL": "http://localhost:7878",
        "RADARR_API_KEY": "your-radarr-api-key",
        "LIDARR_URL": "http://localhost:8686",
        "LIDARR_API_KEY": "your-lidarr-api-key",
        "PROWLARR_URL": "http://localhost:9696",
        "PROWLARR_API_KEY": "your-prowlarr-api-key"
      }
    }
  }
}
```

### For Claude Code

Add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "arr": {
      "command": "npx",
      "args": ["-y", "mcp-arr-server"],
      "env": {
        "SONARR_URL": "http://localhost:8989",
        "SONARR_API_KEY": "your-sonarr-api-key",
        "RADARR_URL": "http://localhost:7878",
        "RADARR_API_KEY": "your-radarr-api-key"
      }
    }
  }
}
```

**Note**: Only configure the services you have running. The server automatically detects which services are available based on the environment variables you provide.

**TRaSH-only mode**: if you don’t configure any *arr services, the server still starts and exposes the TRaSH Guides reference tools plus generic `search` and `fetch`.

## ChatGPT / Remote MCP

To use `mcp-arr` with ChatGPT, run the server in remote HTTP mode on a reachable host and connect ChatGPT to the `/mcp` endpoint.

The server now exposes the generic `search` and `fetch` tools expected by ChatGPT-style remote MCP integrations:

- `search` discovers matching *arr media and TRaSH profiles
- `fetch` returns structured detail for a selected search result

The existing service-specific tools remain available for richer local or power-user workflows.

## Usage Examples

### Library Management
- "Show me all my TV series"
- "What movies do I have in Radarr?"
- "List all artists in my music library"

### Searching & Adding Content
- "Search for sci-fi shows on Sonarr"
- "Find action movies from the 90s"
- "Add this show to my TV library"
- "Add that movie to Radarr"
- "Search for jazz albums and add this artist"
- "Add this movie with my '4k' tag"
- "What tags do I have in Sonarr?"

### Download Queue
- "What's downloading right now?"
- "Check the Sonarr queue"
- "Show Radarr download progress"

### Upcoming Releases
- "What TV episodes are coming this week?"
- "Show upcoming movie releases"
- "Any new albums coming out this month?"

### Downloading Content
- "What episodes of this show am I missing?"
- "Download the missing episodes for that series"
- "Search for this specific movie"
- "Grab that album I'm missing"

### Indexer Management
- "Are my indexers healthy?"
- "How are my indexers performing?"
- "Test all my Prowlarr indexers"

### Configuration Review
- "Review my Sonarr setup and suggest improvements"
- "Show me my quality profiles in Radarr"
- "Are there any health issues with my Lidarr?"
- "What naming convention am I using for TV shows?"
- "Help me understand my quality profiles - why am I not getting 4K?"
- "Check my download client configuration"
- "How much free space do I have on my root folders?"

### Cross-Service
- "Check status of all my *arr services"
- "Search for 'comedy' across all services"

## Available Tools

### General Tools

| Tool | Description |
|------|-------------|
| `arr_status` | Get connection status for all configured *arr services |
| `arr_search_all` | Search across all configured services simultaneously |
| `search` | Generic discovery tool for remote MCP clients such as ChatGPT |
| `fetch` | Generic detail-fetch tool for items returned by `search` |
| `arr_get_operation` | Poll a long-running preview by its `operationId` (running / completed / failed / timed_out / cancelled) |
| `arr_cancel_operation` | Cancel a running preview operation by its `operationId` |

### Sonarr Tools (TV)

| Tool | Description |
|------|-------------|
| `sonarr_get_series` | List all TV series in your library |
| `sonarr_search` | Search for TV series by name (returns tvdbId for adding) |
| `sonarr_add_series` | Add a TV series to Sonarr (supports tags) |
| `sonarr_get_root_folders` | Get available root folders for adding series |
| `sonarr_get_quality_profiles` | Get available quality profiles for adding series |
| `sonarr_get_queue` | View current download queue with `limit` and `offset` pagination|
| `sonarr_delete_queue_item` | Remove a queue item; `removeFromClient` (default true), `blocklist`, `skipRedownload`, `changeCategory` |
| `sonarr_get_manual_import_candidates` | List Sonarr's native manual-import candidates for a `downloadId` (read-only, no paths accepted) |
| `sonarr_preview_manual_import` | Reprocess candidate mappings via Sonarr's native endpoint **without importing**; shows recalculated episodes and rejections; unmapped candidates return `mappingRequired` (never sent with a 0 `seriesId`); a slow preview returns a pollable `operationId` handle |
| `sonarr_execute_manual_import` | Queue Sonarr's native `ManualImport` command; explicit `importMode` (default `auto`), per-item `allowRejected=true` to override that candidate's rejections |
| `sonarr_get_calendar` | See upcoming episodes |
| `sonarr_get_episodes` | List episodes for a series (shows missing vs available) |
| `sonarr_search_missing` | Trigger search for all missing episodes in a series |
| `sonarr_search_episode` | Trigger search for specific episode(s) |
| `sonarr_refresh_series` | Trigger a metadata refresh for a specific series in Sonarr |

### Radarr Tools (Movies)

| Tool | Description |
|------|-------------|
| `radarr_get_movies` | List all movies in your library |
| `radarr_search` | Search for movies by name (returns tmdbId for adding) |
| `radarr_add_movie` | Add a movie to Radarr (supports tags) |
| `radarr_get_root_folders` | Get available root folders for adding movies |
| `radarr_get_quality_profiles` | Get available quality profiles for adding movies |
| `radarr_get_queue` | View current download queue with `limit` and `offset` pagination |
| `radarr_get_calendar` | See upcoming releases |
| `radarr_search_movie` | Trigger search to download a movie in your library |
| `radarr_search_movies` | Bulk-trigger searches for multiple movie IDs at once |
| `radarr_update_movie` | Update a movie's quality profile, monitored status, minimum availability, tags, or path |
| `radarr_delete_queue_item` | Remove a queue item; `removeFromClient` (default true), `blocklist`, `skipRedownload`, `changeCategory` |
| `radarr_get_manual_import_candidates` | List Radarr's native manual-import candidates for a `downloadId` (read-only, no paths accepted) |
| `radarr_preview_manual_import` | Reprocess candidate mappings via Radarr's native endpoint **without importing**; shows recalculated movie mapping and rejections; unmapped candidates return `mappingRequired` (never sent with a 0 `movieId`); a slow preview returns a pollable `operationId` handle |
| `radarr_execute_manual_import` | Queue Radarr's native `ManualImport` command; explicit `importMode` (default `auto`), per-item `allowRejected=true` to override that candidate's rejections |
| `radarr_refresh_movie` | Trigger a metadata refresh for a specific movie in Radarr |

### Lidarr Tools (Music)

| Tool | Description |
|------|-------------|
| `lidarr_get_artists` | List all artists in your library |
| `lidarr_search` | Search for artists by name (returns foreignArtistId for adding) |
| `lidarr_add_artist` | Add an artist to Lidarr (supports tags) |
| `lidarr_get_root_folders` | Get available root folders for adding artists |
| `lidarr_get_quality_profiles` | Get available quality profiles for adding artists |
| `lidarr_get_metadata_profiles` | Get available metadata profiles for adding artists |
| `lidarr_get_queue` | View current download queue with `limit` and `offset` pagination |
| `lidarr_delete_queue_item` | Remove a queue item; `removeFromClient` (default true), `blocklist`, `skipRedownload`, `changeCategory` |
| `lidarr_get_manual_import_candidates` | List Lidarr's native manual-import candidates for a `downloadId` (read-only, no paths accepted) |
| `lidarr_preview_manual_import` | Reprocess candidate mappings via Lidarr's native update endpoint **without importing**; Lidarr recomputes track mappings server-side; explicit `trackIds` are validated against the selected album release and preserved (`tracksSource` shows which mapping will import); overrides follow the native hierarchy artist → album → album release → tracks (a parent change clears inherited children — `mappingOverridesApplied`), and explicit `albumId`/`albumReleaseId` are validated against the album's native artist/release membership (`relationshipValidation`); an explicit `albumReleaseId` defaults `disableReleaseSwitching` to true (native UI behavior); reports `releaseSwitchImpact` (edition change vs the album's monitored release, recording overlap, and a `preserveCurrentRelease` remap suggestion) and per-item `currentReleaseEquivalent`; a slow preview returns a pollable `operationId` handle |
| `lidarr_execute_manual_import` | Queue Lidarr's native `ManualImport` command; explicit `importMode` (default `auto`) and `replaceExistingFiles` (default `false`), per-item `allowRejected=true` to override that candidate's rejections; explicit `trackIds` overrides survive into the command; hierarchy violations (stale children, cross-artist albums, cross-album releases) are refused before any request; **hard-blocks a release/edition switch on an album that already has files unless an exact `releaseSwitchAuthorizations` entry authorizes it** |
| `lidarr_get_albums` | List albums for an artist (shows missing vs available) |
| `lidarr_search_album` | Trigger search for a specific album |
| `lidarr_search_missing` | Trigger search for all missing albums for an artist |
| `lidarr_get_calendar` | See upcoming album releases |

### Prowlarr Tools (Indexers)

| Tool | Description |
|------|-------------|
| `prowlarr_get_indexers` | List all configured indexers |
| `prowlarr_search` | Search across all indexers |
| `prowlarr_test_indexers` | Test all indexers and return health status |
| `prowlarr_get_stats` | Get indexer statistics (queries, grabs, failures) |

### Configuration Review Tools

These tools are available for Sonarr, Radarr, and Lidarr. Replace `{service}` with the service name (e.g., `sonarr_get_quality_profiles`).

| Tool | Description |
|------|-------------|
| `{service}_get_quality_profiles` | Detailed quality profile information with allowed qualities and custom format scores |
| `{service}_get_health` | Health check warnings and issues detected by the application |
| `{service}_get_root_folders` | Storage paths, free space, and accessibility status |
| `{service}_get_download_clients` | Download client configurations and settings |
| `{service}_get_naming` | File and folder naming conventions |
| `{service}_get_tags` | Tag definitions for content organization |
| `{service}_review_setup` | **Comprehensive configuration dump for AI-assisted setup analysis** |

The `{service}_review_setup` tool returns all configuration in a single call, enabling natural language conversations about optimizing your setup. Claude can analyze your quality profiles, suggest improvements, explain why certain content isn't being grabbed, and help configure complex settings like custom formats.

> **⚠️ Disclaimer**: The configuration review tools provide **read-only** access to your *arr settings. Any changes to your configuration must be made directly in the *arr application interfaces. The AI's suggestions are recommendations only - always back up your configuration before making significant changes. The maintainers are not responsible for any configuration changes, data loss, or other issues that may arise from following AI-generated recommendations.

### TRaSH Guides Tools

Access community-curated quality profiles, custom formats, and naming conventions from [TRaSH Guides](https://trash-guides.info/) directly through Claude or ChatGPT. These tools work without any *arr configuration - they fetch reference data from the TRaSH Guides GitHub repository.

| Tool | Description |
|------|-------------|
| `trash_list_profiles` | List available TRaSH quality profiles for Radarr or Sonarr |
| `trash_get_profile` | Get detailed profile with custom formats, scores, and quality settings |
| `trash_list_custom_formats` | List custom formats with optional category filter (hdr, audio, resolution, etc.) |
| `trash_get_naming` | Get recommended naming conventions for Plex, Emby, Jellyfin, or standard |
| `trash_get_quality_sizes` | Get recommended min/max/preferred sizes for each quality level |
| `trash_compare_profile` | Compare your profile against TRaSH recommendations (requires *arr configured) |
| `trash_compare_naming` | Compare your naming config against TRaSH recommendations (requires *arr configured) |

**Example usage:**
- "What quality profiles does TRaSH recommend for 4K movies?"
- "Show me the remux-web-1080p profile details"
- "Compare my Radarr profile 4 against the TRaSH uhd-bluray-web profile"
- "What naming convention should I use for Plex?"
- "List HDR-related custom formats for Radarr"

Data is cached for 1 hour to minimize GitHub API calls.

## Manual Import Workflow (stuck downloads)

When Sonarr/Radarr/Lidarr finish a download but cannot import it automatically — unparseable filenames, missing episode/movie/album mapping, `Unable to determine if file is a sample`, partial multi-file imports — the manual-import tools reproduce the native **Interactive Import** workflow through MCP:

```text
*_get_queue                      → find the stuck item's downloadId + statusMessages
*_get_manual_import_candidates   → discover what the app sees for that downloadId
*_preview_manual_import          → (if needed) fix series/movie/album/track mapping, inspect the result
*_execute_manual_import          → queue the native ManualImport command
*_get_queue                      → re-check: did the queue entry clear?
```

**Security model.** The workflow is deliberately narrower than raw API access:

- Every tool is keyed by `downloadId`; the *arr app resolves the download location itself.
- Candidates are only previewable/importable if the native `/manualimport` endpoint returned them for that `downloadId`. The `candidateId` is the native resource id (a hash of the path).
- **A caller-supplied filesystem path is never accepted.** Execute re-fetches candidates, resolves each `candidateId`, merges only permitted mapping overrides, reprocesses through the native endpoint, validates the mapping, and only then submits the command. Nothing is cached between MCP calls, so a stale preview can never be imported.
- No queue items are deleted automatically and no blocklisting happens — Sonarr/Radarr/Lidarr update their tracked-download state normally.

**Behavioral rules.**

- `preview` is **non-importing** — it never moves, copies, or imports files.
- `preview` normally returns its result directly. If the app's native analysis runs longer than a short response budget (most often Lidarr), it returns a `running` handle with an `operationId` and a `pollAfterMs` interval; poll `arr_get_operation` with that id (it returns the exact preview result once `completed`) instead of starting a duplicate preview. `arr_cancel_operation` stops a running preview. Identical previews started while one is running are deduplicated to the same `operationId`.
- `execute` always sends `importMode` explicitly; the default is `auto`, matching the queue-driven Interactive Import behavior of the *arr UIs.
- Candidates with remaining native rejections are **refused** unless **that item** sets `allowRejected=true`. Authorization is per candidate: in a multi-file release you can force-import file B despite its rejection while file A (rejected, not authorized) stays blocked — the whole command is refused while any blocked candidate remains. The server never decides that a specific rejection (e.g. the sample check) is safe — the agent/human reviews the rejections from the preview and opts in explicitly. Overridden rejections are reported in the response for auditability.
- Candidates with **no valid entity mapping** (Sonarr series / Radarr movie) are reported as `mappingRequired` with `canPreview: false` and are **never sent to the native reprocess endpoint** — Sonarr/Radarr resolve the supplied id server-side and throw for unknown ids, so a fabricated `0` is never submitted. Supply a real `seriesId`/`movieId` override (found via `sonarr_get_series` / `radarr_get_movies`) first.
- Candidate resolution requires **exactly one** current candidate with the requested `candidateId`. Native ids are 31-bit path hashes and can collide: 0 matches → stale/unknown error, 2+ matches → `ambiguous candidate` refusal. Disambiguation is by re-running discovery, never by supplying a path.
- **Mappings and rejections are Sonarr's parse proposal — verify them, don't trust them.** Every discovery/preview response leads with a `verifyBeforeActing` directive: `mappingValid: true` means the proposal is *complete*, not that it is *correct*, and a rejection is Sonarr's opinion, not ground truth. Before recommending `execute` — especially `allowRejected=true` — check the proposal against the library: series identity, season/episode identity (`sonarr_get_episodes`), the release title and numbering where the name supplies them, and existing-file state. **Titles and numbering are both evidence, and neither is conclusive on its own.** A number mismatch does not by itself prove the mapping wrong (TheTVDB/TMDB/absolute-numbering conventions differ); a title that matches none of the detected episodes does not by itself prove it right (translations and fan-sub titles differ from official ones). When the evidence conflicts, treat the mapping as **ambiguous and investigate** — including `seasonNumber=0` for specials — rather than automatically trusting Sonarr's proposal or overriding it.
- **Sonarr overrides follow the native mapping hierarchy: series → season → episodes.** A `seriesId` override clears the inherited `seasonNumber` **and** episodes; a `seasonNumber` override clears the inherited episodes — the same dependency clearing the native Interactive Import UI performs. Supply the full corrected selection (`seriesId` + `seasonNumber` + `episodeIds`), not just the parent. This matters because Sonarr's reprocess resolves episode ids **globally** and pairs them with whatever `seriesId` is supplied, with no ownership check, so an inherited child mapping across a parent change would be imported rather than rejected. `preview` reports `episodesRequired` when a cleared selection has no replacement, and `execute` refuses it.
- **Caller-supplied `episodeIds` are validated against native episode data.** Every id is checked against `GET /api/v3/episode?seriesId=&seasonNumber=` — the exact query the native episode picker uses — so ids belonging to a **different series** or a **different season** are refused before anything is submitted. `episodeIds` require a valid **effective** `seasonNumber`: an inherited season that no parent override cleared is used as-is, so `episodeIds` alone are enough and `seasonNumber` does not need to be repeated — supply it only when a series override has cleared the inherited season (or the candidate had none). `preview` reports the finding in `episodeValidation` (with `unknownEpisodeIds`) without failing; `execute` refuses.
- **The preview reports the EFFECTIVE series.** When `seriesId` is overridden, the response shows the real id **and the real title** fetched from `GET /api/v3/series/{id}` — never the original candidate's title under a new id (the verify-before-acting guidance tells agents to check mappings by title, so a stale title is actively misleading). If the lookup fails, `title` is `null` rather than stale metadata.
- **Lidarr overrides follow the native mapping hierarchy: artist → album → album release → tracks.** An `artistId` override clears the inherited album, release **and** tracks; an `albumId` override clears the inherited release **and** tracks; an `albumReleaseId` override clears the inherited tracks — the same dependency clearing the native Interactive Import UI performs. Supply the full corrected selection below a changed parent; a cleared child is sent as `null` and Lidarr re-identifies it from the files. This matters because the native reprocess maps supplied ids straight into `IdentificationOverrides` with precedence **AlbumRelease > Album > Artist** and no ownership check, so an inherited child mapping across a parent change would be imported rather than rejected. `preview` reports `mappingOverridesApplied` (what a parent change cleared) and `dependencyProblems` (a child supplied under a cleared parent); `execute` refuses both before any request.
- **Explicit Lidarr `albumId`/`albumReleaseId` overrides are validated against native relationships.** An `albumId` must belong to the effective artist and an `albumReleaseId` must be a release of the effective album — checked via `GET /api/v1/album/{id}`, the native source for the album's `artistId` and its embedded `releases` (the native release picker reads the album's embedded releases; `GET /api/v1/release?albumId=` is the indexer release-**search** endpoint, not the album's own releases). Violations are refused as `invalidMappings` before anything is submitted; `preview` reports them in `relationshipValidation` without failing. Explicit `trackIds` keep their existing release-scoped validation.
- **Lidarr `disableReleaseSwitching` reproduces the native UI default.** Selecting an album release explicitly sets `disableReleaseSwitching: true` (native behavior; on import it persists as `album.AnyReleaseOk = false`, disabling automatic release selection for that album). An explicit `albumReleaseId` override therefore defaults the flag to `true` — set it to `false` explicitly to keep automatic selection. An unmodified candidate keeps the flag at its candidate value. **It controls FUTURE automatic switching only — it does NOT keep the current release for THIS import.**
- **Lidarr ManualImport always makes the effective imported release the album's monitored edition — this is a separate, destructive axis from `replaceExistingFiles`.** Native `ImportApprovedTracks.Import` ends with `SetMonitored(newRelease)` for the release the command targets, independent of `replaceExistingFiles`. So importing a candidate whose effective `albumReleaseId` differs from the album's currently-monitored release silently changes the album's **edition** (e.g. a 17-track deluxe → an 11-track standard), even with `replaceExistingFiles=false`. "Combine with existing files" does **not** mean "keep the existing edition". The MCP detects this: `preview` reports `releaseSwitchImpact` per album (current vs proposed release, track counts, the recordings shared / current-only / proposed-only, and a `preserveCurrentRelease` remap that upgrades the matching recordings on the CURRENT release so the edition is preserved), plus a per-item `currentReleaseEquivalent`. `execute` **hard-blocks** a switch on an album that already has files unless an exact `releaseSwitchAuthorizations=[{albumId, fromAlbumReleaseId, toAlbumReleaseId}]` entry authorizes it — validated against the album's current monitored release at execute time, so a stale `from` id is refused. `allowRejected`, `replaceExistingFiles` and `disableReleaseSwitching` do **not** authorize a release switch. For a partial quality upgrade that keeps the edition, apply the preview's `preserveCurrentRelease.itemOverrides`, re-preview, and confirm `releaseWillChange: false` before executing. The guard **fails closed**: if the album's current release, monitored state, or file count cannot be verified (album lookup fails, statistics missing, or zero/multiple monitored releases with files present), `preview` reports `assessmentAvailable: false` and `execute` refuses with no command — it never infers a "safe first import" from an unknown state, and `releaseSwitchAuthorizations` cannot override an unverifiable current release.
- **The Radarr preview reports the EFFECTIVE movie.** When `movieId` is overridden, the response shows the real id **and the real title/year** fetched from `GET /api/v3/movie/{id}` — never the original candidate's title under a new id. If the lookup fails, the metadata is `null` rather than stale. (Radarr has no dependent child identity below `movieId`, so no hierarchy clearing applies.)
- **Duplicate `candidateId`s in one request are refused** at parse time, before any native request — the same native file must never be submitted twice in one `ManualImport` command.
- **An existing file is not a reason to skip — compare quality, via `upgradeAssessment`.** The Sonarr preview includes an `upgradeAssessment` for each mapped candidate. Sonarr's own reprocess evaluates the existing file and rejects with *"Not an upgrade for existing episode file(s)"* (quality profile), *"Not a Custom Format upgrade for existing episode file(s)"* (CF score), or *"Episode already imported"* when the new file is not better — so verdict `not-an-upgrade` → **do not import**. `no-existing-file` → fills a gap; `no-upgrade-rejection` → Sonarr raised no upgrade rejection, so the file is **equal to or better** than the existing one (equal quality + equal CF surfaces no warning — a neutral, allowed replacement); the existing file(s) are listed with quality name and CF score — compare against `newQualityWeight`/`newCustomFormatScore`. After remapping a mis-parsed release, the preview re-evaluates against the **new** target's existing file — check the assessment post-remap.
- A successful execute returns a `commandId` with status `queued`: command acceptance is **asynchronous** and does not guarantee the import succeeded. Re-check the queue afterwards.
- Lidarr specifics: its native update endpoint has **no `trackIds` field** — it recomputes the track mapping server-side from artist/album/release overrides. An explicit `trackIds` override is therefore validated **strictly against the selected album release's track list** (`GET /track?albumReleaseId=…`, mirroring the native Interactive Import track selector) and **preserved into the final command**, so a corrected track mapping (Lidarr guessed Track 6 → you determined Track 7) survives reprocessing. Tracks from other releases of the same album, from other albums, or from the candidate's current mapping are **not** authorization targets; if Lidarr's recomputed mapping contains tracks outside the selected release's query, the preview surfaces the inconsistency (`releaseTrackMismatch`) without widening the allowlist. `tracksSource` shows which mapping will import.

**Lidarr manual-import options (three independent axes — do not conflate them):**

| Option | `false` | `true` |
|---|---|---|
| `filterExistingFiles` (default `true`) | `All Files` | `Unmapped Files Only` |
| `replaceExistingFiles` (default `false`) | `Combine with existing files` | `Replace Existing Files` *(existing files deleted)* |
| `albumReleaseId` / release switch | keep the album's monitored edition | switch the album's monitored edition (needs `releaseSwitchAuthorizations`) |

> **`filterExistingFiles`** only controls which files are discovered; it never deletes, replaces, or authorizes anything.
>
> **`replaceExistingFiles=true` is album-wide:** Lidarr removes **all** existing track files for **each affected album** before importing the selected replacement files — not only the files for the selected tracks. A partial selection or a later import failure can therefore leave the album missing files. `importMode=copy` does **not** make it non-destructive. `replaceExistingFiles=false` ("Combine with existing files") skips that album-wide pre-delete, but normal per-track upgrade processing still replaces the files mapped to the incoming tracks.
>
> **The release/edition switch is a third, separate axis.** ManualImport always calls `SetMonitored` on the effective imported release, so it changes which edition the album uses — `replaceExistingFiles` does **not** prevent that. A switch on an album that already has files is blocked unless an exact `releaseSwitchAuthorizations` entry authorizes it; `allowRejected` and `disableReleaseSwitching` do not authorize it either.
>
> Use the same `filterExistingFiles`/`replaceExistingFiles` values for discovery, preview and execute, and re-run discovery after changing either.

Example (Sonarr, the sample-file case):

```text
sonarr_get_queue
  → queueId 100, downloadId "ABC123", statusMessages: ["Unable to determine if file is a sample"]
sonarr_get_manual_import_candidates(downloadId="ABC123")
  → candidateId 123 already maps to The Good Fight S06E03, rejection present
sonarr_execute_manual_import(downloadId="ABC123", items=[{candidateId: 123, allowRejected: true}])
  → commandId queued; then sonarr_get_queue to confirm the entry cleared
```

Example (Lidarr, correcting a bad automatic track match):

```text
lidarr_get_manual_import_candidates(downloadId="ABC123")
  → candidateId 333: file01.flac mapped to Track 6 (id 501)
lidarr_preview_manual_import(downloadId="ABC123", items=[{candidateId: 333, trackIds: [502]}])
  → tracksSource "caller-override", tracks [502] — validated against the album
lidarr_execute_manual_import(downloadId="ABC123", items=[{candidateId: 333, trackIds: [502]}])
  → the native ManualImport command imports Track 7 (id 502)
```

### Live/integration validation

The automated suite runs against deterministic stub *arr apps. When real instances are available, these four scenarios are worth validating manually with the **preview** tools (non-destructive) before trusting execute:

1. **Sonarr, unknown series** — a candidate with no matched series must return `mappingRequired`/`canPreview: false`, not an API error from `seriesId=0`.
2. **Radarr, unknown movie** — same behavior with `movieId`.
3. **Lidarr, corrected track mapping** — preview a candidate with a `trackIds` override pointing at a different track of the **selected album release** (`GET /track?albumReleaseId=…`); the preview must show `tracksSource: "caller-override"` with your ids, and the eventual command must import them. A track from a *different release of the same album* must be refused.
4. **Sonarr, multi-file partial import** — a release where file 1 is rejected ("already imported / not a CF upgrade") and file 2 has the sample-indeterminate rejection: execute with `allowRejected: true` only on file 2's item must block file 1 (no command submitted while it remains blocked), never importing file 1.

## Development

```bash
# Watch mode for development
npm run watch

# Build TypeScript
npm run build

# Run locally
SONARR_URL="http://localhost:8989" SONARR_API_KEY="your-key" node dist/index.js
```

## Troubleshooting

### "No *arr services configured"
Ensure you have set at least one pair of URL and API_KEY environment variables:
```bash
SONARR_URL="http://localhost:8989"
SONARR_API_KEY="your-api-key"
```

### "API error: 401 Unauthorized"
The API key is incorrect. Verify it in your *arr application under Settings > General > Security.

### "fetch failed" or "ECONNREFUSED"
The *arr application is not running or the URL is incorrect. Verify:
- The application is running
- The URL and port are correct
- There's no firewall blocking the connection

### "Sonarr/Radarr/etc not configured"
You tried to use a tool for a service that isn't configured. Add the corresponding URL and API_KEY environment variables.

## License

MIT - see [LICENSE](LICENSE) for details.

## Links

- [Servarr Wiki](https://wiki.servarr.com/) - Documentation for all *arr applications
- [TRaSH Guides](https://trash-guides.info/) - Quality profiles, custom formats, and setup guides
- [Sonarr API Docs](https://sonarr.tv/docs/api/)
- [Model Context Protocol](https://modelcontextprotocol.io)
- [GitHub Repository](https://github.com/aplaceforallmystuff/mcp-arr)
