#!/usr/bin/env node
/**
 * MCP Server for *arr Media Management Suite
 *
 * Provides tools for managing Sonarr (TV), Radarr (Movies), Lidarr (Music),
 * and Prowlarr (Indexers) through Claude Code.
 *
 * Environment variables:
 * - SONARR_URL, SONARR_API_KEY
 * - RADARR_URL, RADARR_API_KEY
 * - LIDARR_URL, LIDARR_API_KEY
 * - PROWLARR_URL, PROWLARR_API_KEY
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import {
  SonarrClient,
  RadarrClient,
  LidarrClient,
  ProwlarrClient,
  ArrService,
  ArrRequestTimeoutError,
} from "./arr-client.js";
import type {
  QueueStatusMessage,
  QueueItem,
  QualityProfile,
  ManualImportQuality,
  ManualImportLanguage,
  ManualImportRejection,
  LidarrManualImportRejection,
  SonarrManualImportCandidate,
  SonarrManualImportReprocessItem,
  SonarrManualImportCommandFile,
  SonarrManualImportEpisode,
  SonarrEpisodeFile,
  SonarrEpisodeWithFile,
  RadarrManualImportCandidate,
  RadarrManualImportReprocessItem,
  RadarrManualImportCommandFile,
  LidarrManualImportCandidate,
  LidarrManualImportUpdateItem,
  LidarrManualImportCommandFile,
  LidarrTrack,
} from "./arr-client.js";
import { trashClient, TrashService } from "./trash-client.js";
import {
  previewOperations,
  kindLabel,
  type PreviewExecutionContext,
  type PreviewOperation,
  type PreviewOperationKind,
} from "./preview-operations.js";
import {
  previewSyncBudgetMs,
  operationPollIntervalMs,
} from "./config.js";

/**
 * A context for the synchronous (non-async-wrapped) execute path: a signal that
 * is never aborted (so only the per-request API timeouts apply) and a no-op
 * stage reporter. Execute is deliberately NOT registered as a preview
 * operation — it is destructive and revalidates from native state on every
 * call, so it must stay independent of the preview registry.
 */
function standaloneContext(): PreviewExecutionContext {
  return { signal: new AbortController().signal, setStage: () => {} };
}

/**
 * Best-effort preview helpers swallow native lookup failures (404/500/connection
 * errors) and return a fallback so a preview can still report a candidate. A
 * whole-preview deadline or an explicit arr_cancel_operation aborts the
 * operation's own signal, and that abort must NOT be mistaken for an ordinary
 * metadata failure — it unwinds the preview so the manager records the terminal
 * operation state. Keyed strictly on the operation signal, so a request's
 * private per-request timeout (a distinct controller) still surfaces its own
 * error normally, and execute's never-aborted signal makes this a no-op.
 */
function rethrowIfOperationAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Preview operation aborted.");
}

// Read from package.json rather than hardcoding, so the version reported to
// clients can never drift from the released version. package.json sits at the
// package root in every distribution: npm always ships it, and the Dockerfile
// copies it alongside dist/.
function readServerVersion(): string {
  try {
    const pkgUrl = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(pkgUrl, "utf8")) as { version?: string };
    if (pkg.version) return pkg.version;
    console.error("[mcp-arr] package.json has no version field");
  } catch (error) {
    console.error(
      `[mcp-arr] could not read version from package.json: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return "0.0.0-unknown";
}

const SERVER_VERSION = readServerVersion();
const TRANSPORT_MODE = (process.env.MCP_TRANSPORT || "stdio").toLowerCase();
const HTTP_HOST = process.env.HOST || "127.0.0.1";
const HTTP_PORT = Number(process.env.PORT || "3000");
const HTTP_PATH = process.env.MCP_PATH || "/mcp";

// Configuration from environment
interface ServiceConfig {
  name: ArrService;
  displayName: string;
  url?: string;
  apiKey?: string;
}

const services: ServiceConfig[] = [
  { name: 'sonarr', displayName: 'Sonarr (TV)', url: process.env.SONARR_URL, apiKey: process.env.SONARR_API_KEY },
  { name: 'radarr', displayName: 'Radarr (Movies)', url: process.env.RADARR_URL, apiKey: process.env.RADARR_API_KEY },
  { name: 'lidarr', displayName: 'Lidarr (Music)', url: process.env.LIDARR_URL, apiKey: process.env.LIDARR_API_KEY },
  { name: 'prowlarr', displayName: 'Prowlarr (Indexers)', url: process.env.PROWLARR_URL, apiKey: process.env.PROWLARR_API_KEY },
];

// Check which services are configured
const configuredServices = services.filter(s => s.url && s.apiKey);

// Initialize clients for configured services
const clients: {
  sonarr?: SonarrClient;
  radarr?: RadarrClient;
  lidarr?: LidarrClient;
  prowlarr?: ProwlarrClient;
} = {};

for (const service of configuredServices) {
  const config = { url: service.url!, apiKey: service.apiKey! };
  switch (service.name) {
    case 'sonarr':
      clients.sonarr = new SonarrClient(config);
      break;
    case 'radarr':
      clients.radarr = new RadarrClient(config);
      break;
    case 'lidarr':
      clients.lidarr = new LidarrClient(config);
      break;
    case 'prowlarr':
      clients.prowlarr = new ProwlarrClient(config);
      break;
  }
}

// Build tools based on configured services
const TOOLS: Tool[] = [
  // General tool available for all
  {
    name: "arr_status",
    description: configuredServices.length > 0
      ? `Get status of all configured *arr services. Currently configured: ${configuredServices.map(s => s.displayName).join(', ')}`
      : "Get status of all supported *arr services. No local *arr services are currently configured, but TRaSH reference tools remain available.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "arr_get_operation",
    description: "Poll a long-running preview operation by operationId. A *_preview_manual_import that outlives the synchronous response budget returns a running handle with an operationId; poll this tool at the handle's pollAfterMs. Statuses: running (stage + pollAfterMs), completed (the exact normal preview result), failed (error), timed_out (preview exceeded its operation deadline), cancelled. An unknown/expired id returns status expired-or-unknown. Operations live only in this running mcp-arr process.",
    inputSchema: {
      type: "object" as const,
      properties: {
        operationId: { type: "string", description: "The operationId from a *_preview_manual_import running handle" },
      },
      required: ["operationId"],
    },
  },
  {
    name: "arr_cancel_operation",
    description: "Cancel a running preview operation by operationId (e.g. you previewed the wrong candidates). Applies only to operations owned by this running mcp-arr process. A running operation is aborted and marked cancelled; a completed/failed/timed_out/cancelled operation keeps its terminal status unchanged; an unknown id returns expired-or-unknown. Aborting stops mcp-arr waiting and aborts the in-flight API request, but cannot guarantee the app stops CPU-side work already in progress.",
    inputSchema: {
      type: "object" as const,
      properties: {
        operationId: { type: "string", description: "The operationId from a *_preview_manual_import running handle" },
      },
      required: ["operationId"],
    },
  },
  {
    name: "search",
    description: "Search across configured *arr libraries plus TRaSH Guides reference profiles. This is the primary discovery tool for remote MCP clients such as ChatGPT.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Natural-language search query",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "fetch",
    description: "Fetch a specific item returned by search. Accepts an opaque item id from the search tool.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "Opaque result id returned by search",
        },
      },
      required: ["id"],
    },
  },
];

// Configuration review tools for each service
// These are added dynamically based on configured services

// Helper function to create config tools for a service
function addConfigTools(serviceName: string, displayName: string) {
  TOOLS.push(
    {
      name: `${serviceName}_get_quality_profiles`,
      description: `Get detailed quality profiles from ${displayName}. Shows allowed qualities, upgrade settings, and custom format scores.`,
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },
    {
      name: `${serviceName}_get_health`,
      description: `Get health check warnings and issues from ${displayName}. Shows any problems detected by the application.`,
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },
    {
      name: `${serviceName}_get_root_folders`,
      description: `Get root folders and storage info from ${displayName}. Shows paths, free space, and unmapped folders.`,
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },
    {
      name: `${serviceName}_get_download_clients`,
      description: `Get download client configurations from ${displayName}. Shows configured clients and their settings.`,
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },
    {
      name: `${serviceName}_get_naming`,
      description: `Get file naming configuration from ${displayName}. Shows naming patterns for files and folders.`,
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },
    {
      name: `${serviceName}_get_tags`,
      description: `Get all tags defined in ${displayName}. Tags can be used to organize and filter content.`,
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },
    {
      name: `${serviceName}_review_setup`,
      description: `Get comprehensive configuration review for ${displayName}. Returns all settings for analysis: quality profiles, download clients, naming, storage, indexers, health warnings, and more. Use this to analyze the setup and suggest improvements.`,
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    }
  );
}

// Add config tools for each configured service (except Prowlarr which has different config)
if (clients.sonarr) addConfigTools('sonarr', 'Sonarr (TV)');
if (clients.radarr) addConfigTools('radarr', 'Radarr (Movies)');
if (clients.lidarr) addConfigTools('lidarr', 'Lidarr (Music)');

// Sonarr tools
if (clients.sonarr) {
  TOOLS.push(
    {
      name: "sonarr_get_series",
      description: "Get TV series from Sonarr library with optional pagination and title filtering. Defaults to limit=25 to avoid very large responses. Use offset to fetch additional pages.",
      inputSchema: {
        type: "object" as const,
        properties: {
          limit: {
            type: "number",
            description: "Maximum number of series to return (default: 25, max: 100)",
          },
          offset: {
            type: "number",
            description: "Number of series to skip before returning results (default: 0)",
          },
          search: {
            type: "string",
            description: "Optional case-insensitive title filter",
          },
        },
        required: [],
      },
    },
    {
      name: "sonarr_search",
      description: "Search for TV series by name. Returns results with tvdbId needed for sonarr_add_series.",
      inputSchema: {
        type: "object" as const,
        properties: {
          term: {
            type: "string",
            description: "Search term (show name)",
          },
        },
        required: ["term"],
      },
    },
    {
      name: "sonarr_get_queue",
      description: "Get Sonarr download queue, including import diagnostics: structured statusMessages (per-file import rejection reasons), errorMessage, trackedDownloadStatus/State, downloadId, outputPath, indexer, seriesId/episodeId/seasonNumber, and the tracked release's customFormats/customFormatScore for correlating with the library. Use these to understand why a completed download was not imported automatically. Supports pagination with limit and offset.",
      inputSchema: {
        type: "object" as const,
        properties: {
          limit: {
            type: "number",
            description: "Maximum number of queue items to return (default: 25, max: 100)",
          },
          offset: {
            type: "number",
            description: "Number of queue items to skip before returning results (default: 0)",
          },
        },
        required: [],
      },
    },
    {
      name: "sonarr_delete_queue_item",
      description: "Remove an item from the Sonarr download queue (destructive). Use sonarr_get_queue to find queue item IDs. removeFromClient=true (default) also removes the item from the download client. blocklist=true blocklists the release so it will not be grabbed again; combine with skipRedownload=false to let Sonarr find a replacement (bad release), or leave blocklist=false for valid-but-unneeded items (already imported, not an upgrade). skipRedownload=true suppresses automatic replacement/redownload when blocklisting. changeCategory=true marks the item as imported by changing its queue category.",
      inputSchema: {
        type: "object" as const,
        properties: {
          queueId: {
            type: "number",
            description: "Queue item ID (from sonarr_get_queue)",
          },
          removeFromClient: {
            type: "boolean",
            description: "Also remove the item from the download client (default: true)",
          },
          blocklist: {
            type: "boolean",
            description: "Blocklist the release so it will not be grabbed again (default: false)",
          },
          skipRedownload: {
            type: "boolean",
            description: "When blocklisting/failing the download, suppress automatic replacement/redownload (default: false)",
          },
          changeCategory: {
            type: "boolean",
            description: "Mark the item as imported by changing its queue category (default: false)",
          },
        },
        required: ["queueId"],
      },
    },
    {
      name: "sonarr_get_manual_import_candidates",
      description: "Discover Sonarr's native manual-import candidates for a tracked download (read-only). Sonarr resolves the download location from the downloadId — never supply a path. Returns each candidate's candidateId (the native manual-import resource id), display path, quality, languages, mapped series/season/episodes, custom formats, and structured rejections (e.g. 'Unable to determine if file is a sample'). IMPORTANT: the returned mapping and rejection reasons are Sonarr's parse PROPOSAL derived from the release name — not verified facts. Verify against sonarr_get_episodes before recommending execute/allowRejected. Titles and numbering are both evidence and neither is conclusive alone; when they conflict, treat the mapping as ambiguous and investigate (including seasonNumber=0 for specials) rather than trusting the proposal or overriding it. Use sonarr_get_queue first to find the downloadId. Workflow: get candidates -> preview corrected mapping if needed -> execute manual import -> re-check queue.",
      inputSchema: {
        type: "object" as const,
        properties: {
          downloadId: {
            type: "string",
            description: "Tracked download ID from sonarr_get_queue (required)",
          },
          seriesId: {
            type: "integer",
            minimum: 1,
            description: "Optional series hint passed to the native endpoint (positive integer; omit when unspecified — 0 is never a valid native id)",
          },
          seasonNumber: {
            type: "integer",
            minimum: 0,
            description: "Optional season hint passed to the native endpoint (non-negative integer; 0 is the Specials season)",
          },
          filterExistingFiles: {
            type: "boolean",
            description: "Filter out files that already map to existing episode files (native filterExistingFiles, default: true)",
          },
        },
        required: ["downloadId"],
      },
    },
    {
      name: "sonarr_preview_manual_import",
      description: "Preview (reprocess) a manual import in Sonarr WITHOUT importing anything. Re-fetches the native candidates for the downloadId, resolves each candidateId, merges only the supplied mapping overrides (seriesId/seasonNumber/episodeIds/releaseGroup), sends Sonarr's native manual-import reprocess request, and returns Sonarr's recalculated mapping, quality, languages and rejections. Candidates with no valid series mapping (and no seriesId override) are returned as mappingRequired/canPreview=false and are never sent to Sonarr — a 0 seriesId is never submitted, because Sonarr's reprocess resolves the series and throws for unknown ids. Overrides follow the native hierarchy series -> season -> episodes: a seriesId override clears the inherited seasonNumber and episodes, and a seasonNumber override clears the inherited episodes, so supply the full corrected selection rather than only the parent. Explicit episodeIds are validated against GET /api/v3/episode?seriesId=&seasonNumber= and reported in episodeValidation. The reported series is the EFFECTIVE series (its real id and title), never the original candidate's title under an overridden id. Use this to fix unparseable filenames or wrong episode mappings and inspect the result; then run sonarr_execute_manual_import with the same overrides. Non-destructive: never moves, copies, or imports files. Normally returns the result directly; if native analysis takes longer than the synchronous response budget, it returns a running operationId handle instead — poll arr_get_operation at the indicated interval rather than starting a duplicate preview. The preview's upgradeAssessment merges the tracked release's queue custom-format context with the file's own CF context (deduplicated by custom-format id, scored against the effective series' quality profile) to assess the pending candidate against existing files — a per-file CF rejection that the release-level evidence contradicts is reported as cf-upgrade-with-native-rejection, not a hard do-not-import, and a release-only negative CF that the per-file evaluation cannot see is reported as cf-downgrade-despite-native-acceptance even when Sonarr raised no rejection. Quality/revision/already-imported rejections are always hard not-an-upgrade refusals. When release-level CF provenance is relevant but cannot be evaluated safely (invalid/unresolvable attribution, effective-series mismatch, or a season pack with no queue context), the verdict is cf-assessment-ambiguous rather than an acceptance, so 'no-upgrade-rejection' never overstates certainty.",
      inputSchema: {
        type: "object" as const,
        properties: {
          downloadId: {
            type: "string",
            description: "Tracked download ID from sonarr_get_queue (required)",
          },
          items: {
            type: "array",
            description: "Candidates to preview, each identified by candidateId from sonarr_get_manual_import_candidates. Mapping overrides are optional; omitted fields keep Sonarr's current values.",
            items: {
              type: "object",
              properties: {
                candidateId: {
                  type: "number",
                  description: "Candidate id from sonarr_get_manual_import_candidates (required)",
                },
                seriesId: {
                  type: "number",
                  description: "Override the series this file should import as",
                },
                seasonNumber: {
                  type: "integer",
                  minimum: 0,
                  description: "Override the season number (non-negative integer; 0 is the Specials season)",
                },
                episodeIds: {
                  type: "array",
                  items: { type: "number" },
                  description: "Override the episode IDs to map this file to (from sonarr_get_episodes)",
                },
                releaseGroup: {
                  type: "string",
                  description: "Override the release group",
                },
              },
              required: ["candidateId"],
            },
          },
        },
        required: ["downloadId", "items"],
      },
    },
    {
      name: "sonarr_execute_manual_import",
      description: "Execute a manual import in Sonarr (DESTRUCTIVE: moves/copies media files). Always re-validates from scratch: re-fetches native candidates for the downloadId, resolves each candidateId (fails if a candidate disappeared or is ambiguous; duplicate candidateIds in one request are refused), merges only permitted mapping overrides, reprocesses through Sonarr's native endpoint, verifies series/episode/quality mapping, then queues Sonarr's native ManualImport command with an explicit importMode. Caller-supplied paths are never accepted — paths come only from native candidates. Candidates with no valid series mapping are refused before any native request (never sent with a fabricated 0). Overrides follow the native hierarchy series -> season -> episodes: a seriesId override clears the inherited seasonNumber and episodes, and a seasonNumber override clears the inherited episodes. Caller-supplied episodeIds are validated against GET /api/v3/episode?seriesId=&seasonNumber= and the command is refused when any id is not an episode of the effective series and season — Sonarr's own reprocess resolves episode ids globally and pairs them with the supplied seriesId without checking ownership, so this is the only layer that can catch a cross-series/cross-season selection. Candidates with remaining rejections are refused unless that item sets allowRejected=true (mirrors the Interactive Import 'import anyway' override; authorization is per candidate, so a multi-file release can import one file despite its rejection while a rejected file you did not authorize stays blocked). VERIFY BEFORE EXECUTING: Sonarr's suggested mapping and rejections are a parse proposal, not facts — confirm the mapping against sonarr_get_episodes before authorizing an import. Returns the command id — the import runs asynchronously, so re-check sonarr_get_queue afterwards. Does NOT delete queue items.",
      inputSchema: {
        type: "object" as const,
        properties: {
          downloadId: {
            type: "string",
            description: "Tracked download ID from sonarr_get_queue (required)",
          },
          items: {
            type: "array",
            description: "Candidates to import, each identified by candidateId, with the same optional mapping overrides as sonarr_preview_manual_import. Preview first when the mapping needs correcting.",
            items: {
              type: "object",
              properties: {
                candidateId: {
                  type: "number",
                  description: "Candidate id from sonarr_get_manual_import_candidates (required)",
                },
                seriesId: {
                  type: "number",
                  description: "Override the series this file should import as (positive id; 0 is never sent to Sonarr)",
                },
                seasonNumber: {
                  type: "integer",
                  minimum: 0,
                  description: "Override the season number (non-negative integer; 0 is the Specials season)",
                },
                episodeIds: {
                  type: "array",
                  items: { type: "number" },
                  description: "Override the episode IDs to map this file to (from sonarr_get_episodes)",
                },
                releaseGroup: {
                  type: "string",
                  description: "Override the release group",
                },
                allowRejected: {
                  type: "boolean",
                  description: "Import THIS candidate even when Sonarr reports remaining rejections for it (default: false). Only set true after reasoning about each rejection from the preview result.",
                },
              },
              required: ["candidateId"],
            },
          },
          importMode: {
            type: "string",
            enum: ["auto", "copy", "move"],
            description: "Import mode sent explicitly to Sonarr's ManualImport command (default: auto, matching queue-driven Interactive Import)",
          },
        },
        required: ["downloadId", "items"],
      },
    },
    {
      name: "sonarr_get_calendar",
      description: "Get upcoming TV episodes from Sonarr",
      inputSchema: {
        type: "object" as const,
        properties: {
          days: {
            type: "number",
            description: "Number of days to look ahead (default: 7)",
          },
        },
        required: [],
      },
    },
    {
      name: "sonarr_get_episodes",
      description: "Get episodes for a TV series. Shows which episodes are available and which are missing.",
      inputSchema: {
        type: "object" as const,
        properties: {
          seriesId: {
            type: "number",
            description: "Series ID to get episodes for",
          },
          seasonNumber: {
            type: "number",
            description: "Optional: filter to a specific season",
          },
        },
        required: ["seriesId"],
      },
    },
    {
      name: "sonarr_search_missing",
      description: "Trigger a search for all missing episodes in a series",
      inputSchema: {
        type: "object" as const,
        properties: {
          seriesId: {
            type: "number",
            description: "Series ID to search for missing episodes",
          },
        },
        required: ["seriesId"],
      },
    },
    {
      name: "sonarr_search_episode",
      description: "Trigger a search for specific episode(s)",
      inputSchema: {
        type: "object" as const,
        properties: {
          episodeIds: {
            type: "array",
            items: { type: "number" },
            description: "Episode ID(s) to search for",
          },
        },
        required: ["episodeIds"],
      },
    },
    {
      name: "sonarr_refresh_series",
      description: "Trigger a metadata refresh for a specific series in Sonarr",
      inputSchema: {
        type: "object" as const,
        properties: {
          seriesId: {
            type: "number",
            description: "Series ID to refresh",
          },
        },
        required: ["seriesId"],
      },
    },
    {
      name: "sonarr_add_series",
      description: "Add a TV series to Sonarr. Use sonarr_search first to find the tvdbId, and sonarr_get_root_folders / sonarr_get_quality_profiles to get valid values for rootFolderPath and qualityProfileId. Use sonarr_get_tags to get valid tag IDs.",
      inputSchema: {
        type: "object" as const,
        properties: {
          tvdbId: {
            type: "number",
            description: "TVDB ID from sonarr_search results",
          },
          title: {
            type: "string",
            description: "Series title",
          },
          qualityProfileId: {
            type: "number",
            description: "Quality profile ID from sonarr_get_quality_profiles",
          },
          rootFolderPath: {
            type: "string",
            description: "Root folder path from sonarr_get_root_folders",
          },
          monitored: {
            type: "boolean",
            description: "Whether to monitor the series (default: true)",
          },
          seasonFolder: {
            type: "boolean",
            description: "Whether to use season folders (default: true)",
          },
          tags: {
            type: "array",
            items: { type: "number" },
            description: "Array of tag IDs from sonarr_get_tags (optional)",
          },
        },
        required: ["tvdbId", "title", "qualityProfileId", "rootFolderPath"],
      },
    },
  );
}

// Radarr tools
if (clients.radarr) {
  TOOLS.push(
    {
      name: "radarr_get_movies",
      description: "Get movies from Radarr library with optional pagination and title filtering. Defaults to limit=25 to avoid very large responses. Use offset to fetch additional pages.",
      inputSchema: {
        type: "object" as const,
        properties: {
          limit: {
            type: "number",
            description: "Maximum number of movies to return (default: 25, max: 100)",
          },
          offset: {
            type: "number",
            description: "Number of movies to skip before returning results (default: 0)",
          },
          search: {
            type: "string",
            description: "Optional case-insensitive title filter",
          },
        },
        required: [],
      },
    },
    {
      name: "radarr_search",
      description: "Search for movies by name. Returns results with tmdbId needed for radarr_add_movie.",
      inputSchema: {
        type: "object" as const,
        properties: {
          term: {
            type: "string",
            description: "Search term (movie name)",
          },
        },
        required: ["term"],
      },
    },
    {
      name: "radarr_get_queue",
      description: "Get Radarr download queue, including import diagnostics: structured statusMessages (per-file import rejection reasons), errorMessage, trackedDownloadStatus/State, downloadId, outputPath, indexer, and movieId for correlating with the library. Use these to understand why a completed download was not imported automatically. Supports pagination with limit and offset.",
      inputSchema: {
        type: "object" as const,
        properties: {
          limit: {
            type: "number",
            description: "Maximum number of queue items to return (default: 25, max: 100)",
          },
          offset: {
            type: "number",
            description: "Number of queue items to skip before returning results (default: 0)",
          },
        },
        required: [],
      },
    },
    {
      name: "radarr_get_calendar",
      description: "Get upcoming movie releases from Radarr",
      inputSchema: {
        type: "object" as const,
        properties: {
          days: {
            type: "number",
            description: "Number of days to look ahead (default: 30)",
          },
        },
        required: [],
      },
    },
    {
      name: "radarr_search_movie",
      description: "Trigger a search to download a movie that's already in your library",
      inputSchema: {
        type: "object" as const,
        properties: {
          movieId: {
            type: "number",
            description: "Movie ID to search for",
          },
        },
        required: ["movieId"],
      },
    },
    {
      name: "radarr_refresh_movie",
      description: "Trigger a metadata refresh for a specific movie in Radarr",
      inputSchema: {
        type: "object" as const,
        properties: {
          movieId: {
            type: "number",
            description: "Movie ID to refresh",
          },
        },
        required: ["movieId"],
      },
    },
    {
      name: "radarr_add_movie",
      description: "Add a movie to Radarr. Use radarr_search first to find the tmdbId, and radarr_get_root_folders / radarr_get_quality_profiles to get valid values. Use radarr_get_tags to get valid tag IDs.",
      inputSchema: {
        type: "object" as const,
        properties: {
          tmdbId: {
            type: "number",
            description: "TMDB ID from radarr_search results",
          },
          title: {
            type: "string",
            description: "Movie title",
          },
          qualityProfileId: {
            type: "number",
            description: "Quality profile ID from radarr_get_quality_profiles",
          },
          rootFolderPath: {
            type: "string",
            description: "Root folder path from radarr_get_root_folders",
          },
          monitored: {
            type: "boolean",
            description: "Whether to monitor the movie (default: true)",
          },
          minimumAvailability: {
            type: "string",
            enum: ["announced", "inCinemas", "released", "tba"],
            description: "When to consider the movie available (default: announced)",
          },
          tags: {
            type: "array",
            items: { type: "number" },
            description: "Array of tag IDs from radarr_get_tags (optional)",
          },
        },
        required: ["tmdbId", "title", "qualityProfileId", "rootFolderPath"],
      },
    },
    {
      name: "radarr_update_movie",
      description: "Update a movie in Radarr. Can change qualityProfileId, monitored status, minimumAvailability, tags, and path. Fetches the full movie object, applies your changes, and PUTs it back.",
      inputSchema: {
        type: "object" as const,
        properties: {
          movieId: {
            type: "number",
            description: "Movie ID to update",
          },
          qualityProfileId: {
            type: "number",
            description: "New quality profile ID (from radarr_get_quality_profiles)",
          },
          monitored: {
            type: "boolean",
            description: "Whether to monitor the movie",
          },
          minimumAvailability: {
            type: "string",
            enum: ["announced", "inCinemas", "released", "tba"],
            description: "When to consider the movie available",
          },
          tags: {
            type: "array",
            items: { type: "number" },
            description: "Replace all tags with this list of tag IDs",
          },
          path: {
            type: "string",
            description: "New file path for the movie",
          },
        },
        required: ["movieId"],
      },
    },
    {
      name: "radarr_delete_queue_item",
      description: "Remove an item from the Radarr download queue (destructive). Use radarr_get_queue to find queue item IDs. removeFromClient=true (default) also removes the item from the download client. blocklist=true blocklists the release so it will not be grabbed again; combine with skipRedownload=false to let Radarr find a replacement (bad release), or leave blocklist=false for valid-but-unneeded items (already imported, not an upgrade). skipRedownload=true suppresses automatic replacement/redownload when blocklisting. changeCategory=true marks the item as imported by changing its queue category.",
      inputSchema: {
        type: "object" as const,
        properties: {
          queueId: {
            type: "number",
            description: "Queue item ID (from radarr_get_queue)",
          },
          removeFromClient: {
            type: "boolean",
            description: "Also remove the item from the download client (default: true)",
          },
          blocklist: {
            type: "boolean",
            description: "Blocklist the release so it will not be grabbed again (default: false)",
          },
          skipRedownload: {
            type: "boolean",
            description: "When blocklisting/failing the download, suppress automatic replacement/redownload (default: false)",
          },
          changeCategory: {
            type: "boolean",
            description: "Mark the item as imported by changing its queue category (default: false)",
          },
        },
        required: ["queueId"],
      },
    },
    {
      name: "radarr_get_manual_import_candidates",
      description: "Discover Radarr's native manual-import candidates for a tracked download (read-only). Radarr resolves the download location from the downloadId — never supply a path. Returns each candidate's candidateId (the native manual-import resource id), display path, quality, languages, mapped movie, custom formats, and structured rejections. Use radarr_get_queue first to find the downloadId. Workflow: get candidates -> preview corrected mapping if needed -> execute manual import -> re-check queue.",
      inputSchema: {
        type: "object" as const,
        properties: {
          downloadId: {
            type: "string",
            description: "Tracked download ID from radarr_get_queue (required)",
          },
          movieId: {
            type: "integer",
            minimum: 1,
            description: "Optional movie hint passed to the native endpoint (positive integer; omit when unspecified — 0 is never a valid native id)",
          },
          filterExistingFiles: {
            type: "boolean",
            description: "Filter out files that already map to existing movie files (native filterExistingFiles, default: true)",
          },
        },
        required: ["downloadId"],
      },
    },
    {
      name: "radarr_preview_manual_import",
      description: "Preview (reprocess) a manual import in Radarr WITHOUT importing anything. Re-fetches the native candidates for the downloadId, resolves each candidateId, merges only the supplied mapping overrides (movieId/releaseGroup), sends Radarr's native manual-import reprocess request, and returns Radarr's recalculated mapping, quality, languages and rejections. Candidates with no valid movie mapping (and no movieId override) are returned as mappingRequired/canPreview=false and are never sent to Radarr — a 0 movieId is never submitted, because Radarr's reprocess resolves the movie and throws for unknown ids. Use this to fix unparseable filenames or wrong movie mappings and inspect the result; then run radarr_execute_manual_import with the same overrides. Non-destructive: never moves, copies, or imports files. Normally returns the result directly; if native analysis takes longer than the synchronous response budget, it returns a running operationId handle instead — poll arr_get_operation at the indicated interval rather than starting a duplicate preview.",
      inputSchema: {
        type: "object" as const,
        properties: {
          downloadId: {
            type: "string",
            description: "Tracked download ID from radarr_get_queue (required)",
          },
          items: {
            type: "array",
            description: "Candidates to preview, each identified by candidateId from radarr_get_manual_import_candidates. Mapping overrides are optional; omitted fields keep Radarr's current values.",
            items: {
              type: "object",
              properties: {
                candidateId: {
                  type: "number",
                  description: "Candidate id from radarr_get_manual_import_candidates (required)",
                },
                movieId: {
                  type: "number",
                  description: "Override the movie this file should import as",
                },
                releaseGroup: {
                  type: "string",
                  description: "Override the release group",
                },
              },
              required: ["candidateId"],
            },
          },
        },
        required: ["downloadId", "items"],
      },
    },
    {
      name: "radarr_execute_manual_import",
      description: "Execute a manual import in Radarr (DESTRUCTIVE: moves/copies media files). Always re-validates from scratch: re-fetches native candidates for the downloadId, resolves each candidateId (fails if a candidate disappeared or is ambiguous), merges only permitted mapping overrides, reprocesses through Radarr's native endpoint, verifies movie/quality mapping, then queues Radarr's native ManualImport command with an explicit importMode. Caller-supplied paths are never accepted — paths come only from native candidates. Candidates with no valid movie mapping are refused before any native request (never sent with a fabricated 0). Candidates with remaining rejections are refused unless that item sets allowRejected=true (mirrors the Interactive Import 'import anyway' override; authorization is per candidate). VERIFY BEFORE EXECUTING: Radarr's suggested mapping and rejections are parse guesses, not facts — confirm the movie (title/year/edition) against radarr_get_movies before authorizing an import. Returns the command id — the import runs asynchronously, so re-check radarr_get_queue afterwards. Does NOT delete queue items.",
      inputSchema: {
        type: "object" as const,
        properties: {
          downloadId: {
            type: "string",
            description: "Tracked download ID from radarr_get_queue (required)",
          },
          items: {
            type: "array",
            description: "Candidates to import, each identified by candidateId, with the same optional mapping overrides as radarr_preview_manual_import. Preview first when the mapping needs correcting.",
            items: {
              type: "object",
              properties: {
                candidateId: {
                  type: "number",
                  description: "Candidate id from radarr_get_manual_import_candidates (required)",
                },
                movieId: {
                  type: "number",
                  description: "Override the movie this file should import as (positive id; 0 is never sent to Radarr)",
                },
                releaseGroup: {
                  type: "string",
                  description: "Override the release group",
                },
                allowRejected: {
                  type: "boolean",
                  description: "Import THIS candidate even when Radarr reports remaining rejections for it (default: false). Only set true after reasoning about each rejection from the preview result.",
                },
              },
              required: ["candidateId"],
            },
          },
          importMode: {
            type: "string",
            enum: ["auto", "copy", "move"],
            description: "Import mode sent explicitly to Radarr's ManualImport command (default: auto, matching queue-driven Interactive Import)",
          },
        },
        required: ["downloadId", "items"],
      },
    },
    {
      name: "radarr_search_movies",
      description: "Trigger a search for multiple movies at once. Accepts an array of movie IDs. Use this for bulk upgrade requests instead of calling radarr_search_movie one at a time.",
      inputSchema: {
        type: "object" as const,
        properties: {
          movieIds: {
            type: "array",
            items: { type: "number" },
            description: "Array of movie IDs to search for",
          },
        },
        required: ["movieIds"],
      },
    },
  );
}

// Lidarr tools
if (clients.lidarr) {
  TOOLS.push(
    {
      name: "lidarr_get_artists",
      description: "Get all artists in Lidarr library",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },
    {
      name: "lidarr_search",
      description: "Search for artists by name. Returns results with foreignArtistId needed for lidarr_add_artist.",
      inputSchema: {
        type: "object" as const,
        properties: {
          term: {
            type: "string",
            description: "Search term (artist name)",
          },
        },
        required: ["term"],
      },
    },
    {
      name: "lidarr_get_queue",
      description: "Get Lidarr download queue, including import diagnostics: structured statusMessages (per-file import rejection reasons), errorMessage, trackedDownloadStatus/State, downloadId, outputPath, indexer, and artistId/albumId for correlating with the library. Use these to understand why a completed download was not imported automatically. Supports pagination with limit and offset.",
      inputSchema: {
        type: "object" as const,
        properties: {
          limit: {
            type: "number",
            description: "Maximum number of queue items to return (default: 25, max: 100)",
          },
          offset: {
            type: "number",
            description: "Number of queue items to skip before returning results (default: 0)",
          },
        },
        required: [],
      },
    },
    {
      name: "lidarr_get_albums",
      description: "Get albums for an artist in Lidarr. Shows which albums are available and which are missing.",
      inputSchema: {
        type: "object" as const,
        properties: {
          artistId: {
            type: "number",
            description: "Artist ID to get albums for",
          },
        },
        required: ["artistId"],
      },
    },
    {
      name: "lidarr_search_album",
      description: "Trigger a search for a specific album to download",
      inputSchema: {
        type: "object" as const,
        properties: {
          albumId: {
            type: "number",
            description: "Album ID to search for",
          },
        },
        required: ["albumId"],
      },
    },
    {
      name: "lidarr_search_missing",
      description: "Trigger a search for all missing albums for an artist",
      inputSchema: {
        type: "object" as const,
        properties: {
          artistId: {
            type: "number",
            description: "Artist ID to search missing albums for",
          },
        },
        required: ["artistId"],
      },
    },
    {
      name: "lidarr_get_calendar",
      description: "Get upcoming album releases from Lidarr",
      inputSchema: {
        type: "object" as const,
        properties: {
          days: {
            type: "number",
            description: "Number of days to look ahead (default: 30)",
          },
        },
        required: [],
      },
    },
    {
      name: "lidarr_add_artist",
      description: "Add an artist to Lidarr. Use lidarr_search first to find the foreignArtistId, and lidarr_get_root_folders / lidarr_get_quality_profiles / lidarr_get_metadata_profiles to get valid values. Use lidarr_get_tags to get valid tag IDs.",
      inputSchema: {
        type: "object" as const,
        properties: {
          foreignArtistId: {
            type: "string",
            description: "Foreign artist ID (MusicBrainz ID) from lidarr_search results",
          },
          artistName: {
            type: "string",
            description: "Artist name",
          },
          qualityProfileId: {
            type: "number",
            description: "Quality profile ID from lidarr_get_quality_profiles",
          },
          metadataProfileId: {
            type: "number",
            description: "Metadata profile ID from lidarr_get_metadata_profiles",
          },
          rootFolderPath: {
            type: "string",
            description: "Root folder path from lidarr_get_root_folders",
          },
          monitored: {
            type: "boolean",
            description: "Whether to monitor the artist (default: true)",
          },
          tags: {
            type: "array",
            items: { type: "number" },
            description: "Array of tag IDs from lidarr_get_tags (optional)",
          },
        },
        required: ["foreignArtistId", "artistName", "qualityProfileId", "metadataProfileId", "rootFolderPath"],
      },
    },
    {
      name: "lidarr_get_root_folders",
      description: "Get available root folders for Lidarr. Use this to find valid rootFolderPath values when adding an artist.",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },
    {
      name: "lidarr_get_quality_profiles",
      description: "Get available quality profiles for Lidarr. Use this to find valid qualityProfileId values when adding an artist.",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },
    {
      name: "lidarr_get_metadata_profiles",
      description: "Get available metadata profiles for Lidarr. Use this to find valid metadataProfileId values when adding an artist.",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },
    {
      name: "lidarr_delete_queue_item",
      description: "Remove an item from the Lidarr download queue (destructive). Use lidarr_get_queue to find queue item IDs. removeFromClient=true (default) also removes the item from the download client. blocklist=true blocklists the release so it will not be grabbed again; combine with skipRedownload=false to let Lidarr find a replacement (bad release), or leave blocklist=false for valid-but-unneeded items (already imported, not an upgrade). skipRedownload=true suppresses automatic replacement/redownload when blocklisting. changeCategory=true marks the item as imported by changing its queue category.",
      inputSchema: {
        type: "object" as const,
        properties: {
          queueId: {
            type: "number",
            description: "Queue item ID (from lidarr_get_queue)",
          },
          removeFromClient: {
            type: "boolean",
            description: "Also remove the item from the download client (default: true)",
          },
          blocklist: {
            type: "boolean",
            description: "Blocklist the release so it will not be grabbed again (default: false)",
          },
          skipRedownload: {
            type: "boolean",
            description: "When blocklisting/failing the download, suppress automatic replacement/redownload (default: false)",
          },
          changeCategory: {
            type: "boolean",
            description: "Mark the item as imported by changing its queue category (default: false)",
          },
        },
        required: ["queueId"],
      },
    },
    {
      name: "lidarr_get_manual_import_candidates",
      description: "Discover Lidarr's native manual-import candidates for a tracked download (read-only). Lidarr resolves the download location from the downloadId — never supply a path. Returns each candidate's candidateId (the native manual-import resource id), display path, quality, mapped artist/album/albumReleaseId/tracks, additionalFile/replaceExistingFiles/disableReleaseSwitching flags, and structured native rejections normalized as {reason, type} — Lidarr may serialize an empty rejection object, which is represented as null reason/type rather than discarded. An untracked downloadId yields an empty list. Use lidarr_get_queue first to find the downloadId. Workflow: get candidates -> preview corrected mapping if needed -> execute manual import -> re-check queue.",
      inputSchema: {
        type: "object" as const,
        properties: {
          downloadId: {
            type: "string",
            description: "Tracked download ID from lidarr_get_queue (required)",
          },
          artistId: {
            type: "integer",
            minimum: 1,
            description: "Optional artist hint passed to the native endpoint (positive integer; omit when unspecified — 0 is never a valid native id)",
          },
          filterExistingFiles: {
            type: "boolean",
            description: "Filter to files matching the tracked release (native filterExistingFiles, default: true)",
          },
          replaceExistingFiles: {
            type: "boolean",
            description: "Native replaceExistingFiles discovery option (default: false, matching the Interactive Import UI)",
          },
        },
        required: ["downloadId"],
      },
    },
    {
      name: "lidarr_preview_manual_import",
      description: "Preview (update/reprocess) a manual import in Lidarr WITHOUT importing anything. Re-fetches the native candidates for the downloadId, resolves each candidateId, merges only the supplied mapping overrides (artistId/albumId/albumReleaseId/trackIds/disableReleaseSwitching), sends Lidarr's native POST /manualimport update, and returns the resulting mapping and rejections. IMPORTANT Lidarr semantics: the backend re-runs its import decision with the artist/album/release overrides and RECOMPUTES the track mapping itself — the native update endpoint drops the resource's Tracks/TrackIds when building the item. Supplied trackIds are validated against the selected album release's track list (GET /track?albumReleaseId=…) and PRESERVED: the preview response shows exactly the tracks that lidarr_execute_manual_import will import (tracksSource marks caller-override vs lidarr-recomputed). The mapping is a hierarchy artist → album → album release → tracks: an artistId override clears the inherited album/release/tracks, an albumId override clears the inherited release/tracks, an albumReleaseId override clears the inherited tracks (native Interactive Import behavior — the native reprocess resolves supplied ids with precedence AlbumRelease > Album > Artist and NO ownership check, so the MCP clears dependents and validates explicit overrides: albumId→artist via GET /album/{id}.artistId, albumReleaseId→album via GET /album/{id} and that album's embedded releases[], trackIds→release via GET /track?albumReleaseId=). Items whose explicit ids break the hierarchy are reported with canPreview=false and are NOT sent to the native reprocess (Lidarr throws on the lookup first). mappingOverridesApplied reports which inherited children a parent change cleared; dependencyProblems/relationshipValidation report a broken hierarchy. An explicit albumReleaseId defaults disableReleaseSwitching to true (native UI; persists as album.AnyReleaseOk=false on import) — set it false explicitly to keep automatic release selection. Non-destructive: never moves, copies, or imports files. Normally returns the result directly; if native analysis takes longer than the synchronous response budget, it returns a running operationId handle instead — poll arr_get_operation at the indicated interval rather than starting a duplicate preview.",
      inputSchema: {
        type: "object" as const,
        properties: {
          downloadId: {
            type: "string",
            description: "Tracked download ID from lidarr_get_queue (required)",
          },
          items: {
            type: "array",
            description: "Candidates to preview, each identified by candidateId from lidarr_get_manual_import_candidates. Mapping overrides are optional; omitted fields keep Lidarr's current values UNLESS a parent override clears them (artistId clears album/release/tracks; albumId clears release/tracks; albumReleaseId clears tracks).",
            items: {
              type: "object",
              properties: {
                candidateId: {
                  type: "number",
                  description: "Candidate id from lidarr_get_manual_import_candidates (required)",
                },
                artistId: {
                  type: "number",
                  description: "Override the artist this file should import as. Clears the inherited album, album release and tracks (native hierarchy) — supply the full corrected selection below it.",
                },
                albumId: {
                  type: "number",
                  description: "Override the album this file should import as (must belong to the effective artist). Clears the inherited album release and tracks — supply the full corrected selection below it.",
                },
                albumReleaseId: {
                  type: "number",
                  description: "Override the album release (must be a release of the effective album). Clears the inherited tracks. Defaults disableReleaseSwitching to true (native UI behavior).",
                },
                trackIds: {
                  type: "array",
                  items: { type: "number" },
                  description: "Explicit track mapping override: validated against the selected album release's track list and preserved into the preview result (and the eventual command). Omit to use Lidarr's server-side recomputed tracks.",
                },
                disableReleaseSwitching: {
                  type: "boolean",
                  description: "Turn off the album's automatic release selection (native disableReleaseSwitching; persists as album.AnyReleaseOk=false on import). Defaults to true when an albumReleaseId is supplied explicitly — set false to keep automatic selection.",
                },
              },
              required: ["candidateId"],
            },
          },
          replaceExistingFiles: {
            type: "boolean",
            description: "Consider replacing existing track files during reprocessing (default: false, matching the Interactive Import UI)",
          },
        },
        required: ["downloadId", "items"],
      },
    },
    {
      name: "lidarr_execute_manual_import",
      description: "Execute a manual import in Lidarr (DESTRUCTIVE: moves/copies media files). Always re-validates from scratch: re-fetches native candidates for the downloadId, resolves each candidateId (fails if a candidate disappeared or is ambiguous), merges only permitted mapping overrides, reprocesses through Lidarr's native POST /manualimport (which recomputes the track mapping server-side), verifies artist/album/release/track/quality mapping against the reprocessed result, then queues Lidarr's native ManualImport command with explicit importMode and replaceExistingFiles. Caller-supplied paths are never accepted — paths come only from native candidates. Overrides follow the native hierarchy artist → album → album release → tracks: a parent override clears the inherited children (the native reprocess resolves supplied ids with precedence AlbumRelease > Album > Artist and no ownership check, so a stale child inherited across a parent change would import), and explicit overrides are validated BEFORE any request — albumId must belong to the effective artist (GET /album/{id}.artistId), albumReleaseId must be a release of the effective album (GET /album/{id} and that album's embedded releases[]), trackIds must belong to the selected release (GET /track?albumReleaseId=); violations are refused as invalidMappings with no reprocess and no command. Explicit trackIds are PRESERVED into the final command (Lidarr's server-side recomputation is used only when trackIds is omitted) — this is how a corrected track mapping survives reprocessing. An explicit albumReleaseId defaults disableReleaseSwitching to true (native UI behavior; persists as album.AnyReleaseOk=false on import). Candidates with remaining rejections are refused unless that item sets allowRejected=true (the override decision is yours, per candidate). VERIFY BEFORE EXECUTING: Lidarr's suggested artist/album/release/track mapping and rejections are parse guesses, not facts — confirm the album and track list against lidarr_get_albums before authorizing an import. Returns the command id — the import runs asynchronously, so re-check lidarr_get_queue afterwards. Does NOT delete queue items.",
      inputSchema: {
        type: "object" as const,
        properties: {
          downloadId: {
            type: "string",
            description: "Tracked download ID from lidarr_get_queue (required)",
          },
          items: {
            type: "array",
            description: "Candidates to import, each identified by candidateId, with the same optional mapping overrides as lidarr_preview_manual_import. Preview first when the mapping needs correcting.",
            items: {
              type: "object",
              properties: {
                candidateId: {
                  type: "number",
                  description: "Candidate id from lidarr_get_manual_import_candidates (required)",
                },
                artistId: {
                  type: "number",
                  description: "Override the artist this file should import as. Clears the inherited album, album release and tracks (native hierarchy) — supply the full corrected selection below it.",
                },
                albumId: {
                  type: "number",
                  description: "Override the album this file should import as (must belong to the effective artist). Clears the inherited album release and tracks — supply the full corrected selection below it.",
                },
                albumReleaseId: {
                  type: "number",
                  description: "Override the album release (must be a release of the effective album). Clears the inherited tracks. Defaults disableReleaseSwitching to true (native UI behavior).",
                },
                trackIds: {
                  type: "array",
                  items: { type: "number" },
                  description: "Explicit track mapping override: validated strictly against the selected album release's track list (GET /track?albumReleaseId=…) and used as-is in the final ManualImport command. Tracks from other releases of the same album are refused. Omit to use Lidarr's server-side recomputed tracks.",
                },
                disableReleaseSwitching: {
                  type: "boolean",
                  description: "Turn off the album's automatic release selection (native disableReleaseSwitching; persists as album.AnyReleaseOk=false on import). Defaults to true when an albumReleaseId is supplied explicitly — set false to keep automatic selection.",
                },
                allowRejected: {
                  type: "boolean",
                  description: "Import THIS candidate even when Lidarr reports remaining rejections for it (default: false). Only set true after reasoning about each rejection from the preview result.",
                },
              },
              required: ["candidateId"],
            },
          },
          importMode: {
            type: "string",
            enum: ["auto", "copy", "move"],
            description: "Import mode sent explicitly to Lidarr's ManualImport command (default: auto, matching queue-driven Interactive Import)",
          },
          replaceExistingFiles: {
            type: "boolean",
            description: "Allow the import to replace existing track files (default: false — the safer non-destructive behavior used by the Interactive Import UI)",
          },
        },
        required: ["downloadId", "items"],
      },
    }
  );
}

// Prowlarr tools
if (clients.prowlarr) {
  TOOLS.push(
    {
      name: "prowlarr_get_indexers",
      description: "Get all configured indexers in Prowlarr",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },
    {
      name: "prowlarr_search",
      description: "Search across all Prowlarr indexers",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: {
            type: "string",
            description: "Search query",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "prowlarr_test_indexers",
      description: "Test all indexers and return their health status",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },
    {
      name: "prowlarr_get_stats",
      description: "Get indexer statistics (queries, grabs, failures)",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    }
  );
}

// Cross-service search tool
TOOLS.push({
  name: "arr_search_all",
  description: "Search across all configured *arr services for any media",
  inputSchema: {
    type: "object" as const,
    properties: {
      term: {
        type: "string",
        description: "Search term",
      },
    },
    required: ["term"],
  },
});

// TRaSH Guides tools (always available - no *arr config required)
TOOLS.push(
  {
    name: "trash_list_profiles",
    description: "List available TRaSH Guides quality profiles for Radarr or Sonarr. Shows recommended profiles for different use cases (1080p, 4K, Remux, etc.)",
    inputSchema: {
      type: "object" as const,
      properties: {
        service: {
          type: "string",
          enum: ["radarr", "sonarr"],
          description: "Which service to get profiles for",
        },
      },
      required: ["service"],
    },
  },
  {
    name: "trash_get_profile",
    description: "Get a specific TRaSH Guides quality profile with all custom format scores, quality settings, and implementation details",
    inputSchema: {
      type: "object" as const,
      properties: {
        service: {
          type: "string",
          enum: ["radarr", "sonarr"],
          description: "Which service",
        },
        profile: {
          type: "string",
          description: "Profile name (e.g., 'remux-web-1080p', 'uhd-bluray-web', 'hd-bluray-web')",
        },
      },
      required: ["service", "profile"],
    },
  },
  {
    name: "trash_list_custom_formats",
    description: "List available TRaSH Guides custom formats. Can filter by category: hdr, audio, resolution, source, streaming, anime, unwanted, release, language",
    inputSchema: {
      type: "object" as const,
      properties: {
        service: {
          type: "string",
          enum: ["radarr", "sonarr"],
          description: "Which service",
        },
        category: {
          type: "string",
          description: "Optional filter by category",
        },
      },
      required: ["service"],
    },
  },
  {
    name: "trash_get_naming",
    description: "Get TRaSH Guides recommended naming conventions for your media server (Plex, Emby, Jellyfin, or standard)",
    inputSchema: {
      type: "object" as const,
      properties: {
        service: {
          type: "string",
          enum: ["radarr", "sonarr"],
          description: "Which service",
        },
        mediaServer: {
          type: "string",
          enum: ["plex", "emby", "jellyfin", "standard"],
          description: "Which media server you use",
        },
      },
      required: ["service", "mediaServer"],
    },
  },
  {
    name: "trash_get_quality_sizes",
    description: "Get TRaSH Guides recommended min/max/preferred sizes for each quality level",
    inputSchema: {
      type: "object" as const,
      properties: {
        service: {
          type: "string",
          enum: ["radarr", "sonarr"],
          description: "Which service",
        },
        type: {
          type: "string",
          description: "Content type: 'movie', 'anime' for Radarr; 'series', 'anime' for Sonarr",
        },
      },
      required: ["service"],
    },
  },
  {
    name: "trash_compare_profile",
    description: "Compare your quality profile against TRaSH Guides recommendations. Shows missing custom formats, scoring differences, and quality settings. Requires the corresponding *arr service to be configured.",
    inputSchema: {
      type: "object" as const,
      properties: {
        service: {
          type: "string",
          enum: ["radarr", "sonarr"],
          description: "Which service",
        },
        profileId: {
          type: "number",
          description: "Your quality profile ID to compare",
        },
        trashProfile: {
          type: "string",
          description: "TRaSH profile name to compare against",
        },
      },
      required: ["service", "profileId", "trashProfile"],
    },
  },
  {
    name: "trash_compare_naming",
    description: "Compare your naming configuration against TRaSH Guides recommendations. Requires the corresponding *arr service to be configured.",
    inputSchema: {
      type: "object" as const,
      properties: {
        service: {
          type: "string",
          enum: ["radarr", "sonarr"],
          description: "Which service",
        },
        mediaServer: {
          type: "string",
          enum: ["plex", "emby", "jellyfin", "standard"],
          description: "Which media server you use",
        },
      },
      required: ["service", "mediaServer"],
    },
  }
);

// Build a fresh MCP server instance with all request handlers registered.
// The HTTP transport builds a new instance per request (see startHttpServer)
// so concurrent / long-lived transports never share a single server. A shared
// server can only be connected to one transport at a time, which is why the
// old code funnelled every request through a serialized queue — and that queue
// deadlocked the moment a streamable client opened its long-lived GET (SSE)
// stream, since that request never completes.
function buildServer(): Server {
  const server = new Server(
    {
      name: "mcp-arr",
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );
  registerHandlers(server);
  return server;
}

// Module-level instance used by the stdio transport (single, long-lived session).
const server = buildServer();

type SearchEntry = {
  id: string;
  title: string;
  url: string;
  type: string;
  service: string;
  summary?: string;
};

function buildResourceUrl(path: string): string {
  return `mcp-arr://${path}`;
}

function jsonText(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function textError(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

async function runUnifiedSearch(query: string): Promise<SearchEntry[]> {
  const results: SearchEntry[] = [];
  const trimmedQuery = query.trim();

  if (trimmedQuery.length === 0) {
    return results;
  }

  const lowerQuery = trimmedQuery.toLowerCase();

  for (const service of ["radarr", "sonarr"] as const) {
    const profiles = await trashClient.listProfiles(service);
    results.push(
      ...profiles
        .filter((profile) =>
          profile.name.toLowerCase().includes(lowerQuery) ||
          profile.description?.toLowerCase().includes(lowerQuery)
        )
        .slice(0, 8)
        .map((profile) => ({
          id: `trash-profile:${service}:${profile.name}`,
          title: `${profile.name} (${service})`,
          url: buildResourceUrl(`trash/profile/${service}/${encodeURIComponent(profile.name)}`),
          type: "trash_profile",
          service,
          summary: profile.description?.replace(/<br>/g, " "),
        }))
    );
  }

  if (clients.sonarr) {
    const series = await clients.sonarr.searchSeries(trimmedQuery);
    results.push(
      ...series.slice(0, 5).map((item) => ({
        id: `arr:sonarr:series:${item.tvdbId}`,
        title: `${item.title}${item.year ? ` (${item.year})` : ""}`,
        url: buildResourceUrl(`arr/sonarr/series/${item.tvdbId}`),
        type: "series",
        service: "sonarr",
        summary: item.overview?.slice(0, 220),
      }))
    );
  }

  if (clients.radarr) {
    const movies = await clients.radarr.searchMovies(trimmedQuery);
    results.push(
      ...movies.slice(0, 5).map((item) => ({
        id: `arr:radarr:movie:${item.tmdbId}`,
        title: `${item.title}${item.year ? ` (${item.year})` : ""}`,
        url: buildResourceUrl(`arr/radarr/movie/${item.tmdbId}`),
        type: "movie",
        service: "radarr",
        summary: item.overview?.slice(0, 220),
      }))
    );
  }

  if (clients.lidarr) {
    const artists = await clients.lidarr.searchArtists(trimmedQuery);
    results.push(
      ...artists.slice(0, 5).map((item) => ({
        id: `arr:lidarr:artist:${item.foreignArtistId}`,
        title: item.artistName || item.title,
        url: buildResourceUrl(`arr/lidarr/artist/${item.foreignArtistId}`),
        type: "artist",
        service: "lidarr",
        summary: item.overview?.slice(0, 220),
      }))
    );
  }

  return results;
}

async function fetchSearchEntry(id: string): Promise<unknown> {
  const [kind, service, subtype, rawId] = id.split(":");

  if (kind === "trash-profile" && (service === "radarr" || service === "sonarr")) {
    const profile = await trashClient.getProfile(service, rawId);
    if (!profile) {
      throw new Error(`TRaSH profile '${rawId}' not found for ${service}`);
    }

    return {
      id,
      title: `${profile.name} (${service})`,
      url: buildResourceUrl(`trash/profile/${service}/${encodeURIComponent(profile.name)}`),
      service,
      type: "trash_profile",
      data: {
        name: profile.name,
        description: profile.trash_description?.replace(/<br>/g, "\n"),
        upgradeAllowed: profile.upgradeAllowed,
        cutoff: profile.cutoff,
        minFormatScore: profile.minFormatScore,
        cutoffFormatScore: profile.cutoffFormatScore,
        language: profile.language,
        qualities: profile.items,
        customFormats: Object.entries(profile.formatItems || {}).map(([name, trashId]) => ({
          name,
          trash_id: trashId,
        })),
      },
    };
  }

  if (kind !== "arr") {
    throw new Error(`Unsupported fetch id '${id}'`);
  }

  if (service === "sonarr" && subtype === "series" && clients.sonarr) {
    const tvdbId = Number(rawId);
    const matches = (await clients.sonarr.searchSeries(rawId)).filter((item) => item.tvdbId === tvdbId);
    return {
      id,
      title: matches[0]?.title || rawId,
      url: buildResourceUrl(`arr/sonarr/series/${rawId}`),
      service,
      type: subtype,
      data: matches.slice(0, 10),
    };
  }

  if (service === "radarr" && subtype === "movie" && clients.radarr) {
    const tmdbId = Number(rawId);
    const matches = (await clients.radarr.searchMovies(rawId)).filter((item) => item.tmdbId === tmdbId);
    return {
      id,
      title: matches[0]?.title || rawId,
      url: buildResourceUrl(`arr/radarr/movie/${rawId}`),
      service,
      type: subtype,
      data: matches.slice(0, 10),
    };
  }

  if (service === "lidarr" && subtype === "artist" && clients.lidarr) {
    const matches = (await clients.lidarr.searchArtists(rawId)).filter((item) => item.foreignArtistId === rawId);
    return {
      id,
      title: matches[0]?.artistName || matches[0]?.title || rawId,
      url: buildResourceUrl(`arr/lidarr/artist/${rawId}`),
      service,
      type: subtype,
      data: matches.slice(0, 10),
    };
  }

  throw new Error(`Unsupported or unavailable fetch target '${id}'`);
}

type QueueCapableClient = SonarrClient | RadarrClient | LidarrClient;

/**
 * Shape of each item returned by the *_get_queue tools. All fields come
 * straight from the native *arr queue API; diagnostic fields are passed
 * through faithfully (statusMessages keeps its structured shape) so the
 * calling agent can reason about why a completed download was not
 * imported. Service-specific IDs are only present when the native API
 * supplied them for that item.
 */
interface MappedQueueItem {
  id: number;
  title: string;
  status: string;
  progress: string;
  timeLeft: string;
  downloadClient: string;
  protocol: string;
  trackedDownloadStatus: string;
  trackedDownloadState: string;
  statusMessages: QueueStatusMessage[];
  errorMessage: string | null;
  downloadId: string | null;
  outputPath: string | null;
  indexer: string | null;
  indexerId: number | null;
  seriesId?: number;
  episodeId?: number;
  seasonNumber?: number;
  movieId?: number;
  artistId?: number;
  albumId?: number;
  customFormats?: Array<{ id: number | null; name: string | null }>;
  customFormatScore?: number;
}

async function getPaginatedQueue(
  client: QueueCapableClient,
  args: { limit?: number; offset?: number } | undefined
) {
  const limit = Math.min(Math.max(Math.floor(args?.limit ?? 25), 1), 100);
  const offset = Math.max(Math.floor(args?.offset ?? 0), 0);
  const pageSize = 100;
  const records = [];
  let totalRecords = 0;
  let page = 1;

  while (true) {
    const queuePage = await client.getQueue(page, pageSize);
    totalRecords = queuePage.totalRecords;
    records.push(...queuePage.records);

    if (records.length >= totalRecords || queuePage.records.length === 0) {
      break;
    }

    page += 1;
  }

  const items: MappedQueueItem[] = records.slice(offset, offset + limit).map((q) => {
    const sizeleft = q.sizeleft ?? q.sizeLeft;
    const item: MappedQueueItem = {
      id: q.id,
      title: q.title,
      status: q.status,
      progress: q.size > 0 && sizeleft != null ? ((1 - sizeleft / q.size) * 100).toFixed(1) + "%" : "unknown",
      timeLeft: q.timeleft,
      downloadClient: q.downloadClient,
      protocol: q.protocol,
      trackedDownloadStatus: q.trackedDownloadStatus,
      trackedDownloadState: q.trackedDownloadState,
      // Import/download diagnostics, passed through from the native API
      // without flattening, classifying, or truncating them.
      statusMessages: Array.isArray(q.statusMessages) ? q.statusMessages : [],
      errorMessage: q.errorMessage ?? null,
      downloadId: q.downloadId ?? null,
      outputPath: q.outputPath ?? null,
      indexer: q.indexer ?? null,
      indexerId: q.indexerId ?? null,
    };
    // Service-specific identifiers, only when the native API provided them.
    if (q.seriesId != null) item.seriesId = q.seriesId;
    if (q.episodeId != null) item.episodeId = q.episodeId;
    // Sonarr exposes seasonNumber on the queue resource itself; the embedded
    // episode value is only a fallback for responses that carry one.
    if (q.seasonNumber != null) item.seasonNumber = q.seasonNumber;
    else if (q.episode?.seasonNumber != null) item.seasonNumber = q.episode.seasonNumber;
    if (q.movieId != null) item.movieId = q.movieId;
    if (q.artistId != null) item.artistId = q.artistId;
    if (q.albumId != null) item.albumId = q.albumId;
    // Tracked-release custom-format context (Sonarr queue only). Passed through
    // from the native values — the MCP never recomputes the score here.
    if (q.customFormats != null) {
      item.customFormats = q.customFormats.map((cf) => ({ id: cf.id ?? null, name: cf.name ?? null }));
    }
    if (q.customFormatScore != null) item.customFormatScore = q.customFormatScore;
    return item;
  });

  return {
    total: totalRecords,
    returned: items.length,
    offset,
    limit,
    hasMore: offset + items.length < totalRecords,
    nextOffset: offset + items.length < totalRecords ? offset + items.length : null,
    items,
  };
}

// ---------------------------------------------------------------------------
// Manual / Interactive Import orchestration
//
// Security model (intentionally narrower than raw authenticated API access):
//
//   downloadId → native /manualimport candidate discovery → candidateId
//     → optional mapping overrides → native reprocessing → ManualImport command
//
// A candidate may only be previewed or imported if it was returned by the
// native manual-import endpoint for the specified downloadId. The model never
// supplies a filesystem path: paths are taken exclusively from freshly fetched
// native candidates. No candidate state is cached between MCP calls — every
// preview and every execute re-fetches and re-reprocesses from scratch.
// ---------------------------------------------------------------------------

type ManualImportMode = "auto" | "copy" | "move";
const MANUAL_IMPORT_MODES: ManualImportMode[] = ["auto", "copy", "move"];

interface ManualImportOverrideItem {
  candidateId: number;
  // Sonarr
  seriesId?: number;
  seasonNumber?: number;
  episodeIds?: number[];
  // Radarr
  movieId?: number;
  // Lidarr
  artistId?: number;
  albumId?: number;
  albumReleaseId?: number;
  trackIds?: number[];
  disableReleaseSwitching?: boolean;
  // Sonarr/Radarr/Lidarr
  releaseGroup?: string;
  /**
   * Per-candidate rejection bypass (execute tools only). Authorization is
   * deliberately scoped to the single candidate it is set on — a request-wide
   * boolean would grant broader authority than necessary for multi-file
   * releases.
   */
  allowRejected?: boolean;
}

interface ManualImportToolArgs {
  downloadId?: string;
  items?: ManualImportOverrideItem[];
  importMode?: ManualImportMode;
  replaceExistingFiles?: boolean;
  // discovery hints
  seriesId?: number;
  seasonNumber?: number;
  movieId?: number;
  artistId?: number;
  filterExistingFiles?: boolean;
}

/**
 * Sonarr season numbers are non-negative integers, and 0 is a real season
 * (Specials). A negative or fractional value is never a valid season, so it
 * must be refused at the MCP boundary rather than forwarded to the native
 * endpoints. Sonarr-specific: only Sonarr carries seasonNumber, so this is
 * never applied to Radarr or Lidarr arguments.
 */
function assertSonarrSeasonNumber(value: unknown, label: string): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer when supplied (season 0 is the Specials season).`);
  }
}

/**
 * Entity ids (seriesId / movieId / artistId) are native database ids: 0,
 * negatives, and fractions are never valid, and the apps throw on id-0
 * lookups. Discovery hints bypass the item-level parser, so they need the
 * same boundary check the preview/execute items already get — refuse before
 * any native request. `undefined` means "no hint": omit the field, never
 * send 0 to mean unspecified.
 */
function assertPositiveEntityId(value: unknown, label: string): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer when supplied (0 is never a valid native id).`);
  }
}

/**
 * Shared argument parsing for the six preview/execute tools.
 *
 * `service` scopes the Sonarr-specific checks: `seasonNumber` is a Sonarr
 * mapping field, so Radarr/Lidarr requests are never judged by it.
 */
function parseManualImportArgs(args: unknown, service: "sonarr" | "radarr" | "lidarr"): {
  downloadId: string;
  items: ManualImportOverrideItem[];
  importMode: ManualImportMode;
  replaceExistingFiles: boolean;
} {
  const a = (args ?? {}) as ManualImportToolArgs;
  if (typeof a.downloadId !== "string" || a.downloadId.trim() === "") {
    throw new Error(
      "downloadId is required (from *_get_queue). Manual import operates only on a tracked download — a caller-supplied filesystem path is never accepted.",
    );
  }
  if (!Array.isArray(a.items) || a.items.length === 0) {
    throw new Error(
      "items is required: at least one { candidateId, ... } entry taken from *_get_manual_import_candidates for this downloadId.",
    );
  }
  const seenCandidateIds = new Set<number>();
  for (const item of a.items) {
    if (!item || typeof item.candidateId !== "number" || !Number.isInteger(item.candidateId)) {
      throw new Error("every item must include a numeric candidateId from *_get_manual_import_candidates.");
    }
    // The same native file must never be submitted twice in one ManualImport
    // command. Checked at parse time, before any native request: two entries
    // with one candidateId resolve to the same candidate, so episode-collision
    // detection (which compares mappings ACROSS distinct candidates) cannot see
    // them, and the command would import the same path twice.
    if (seenCandidateIds.has(item.candidateId)) {
      throw new Error(
        `duplicate candidateId ${item.candidateId} in items: each candidate may appear only once per request. Merge the entry's overrides into a single item.`,
      );
    }
    seenCandidateIds.add(item.candidateId);
    // Entity ids, when supplied, must be real positive ids. 0/negative values
    // are never valid native entity ids and must not be forwarded to the
    // *arr APIs (Sonarr/Radarr/Lidarr all throw on id 0 lookups).
    for (const key of ["seriesId", "movieId", "artistId", "albumId", "albumReleaseId"] as const) {
      const value = item[key];
      if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value <= 0)) {
        throw new Error(`item ${key} must be a positive integer id when supplied (0 is never a valid native id).`);
      }
    }
    for (const key of ["episodeIds", "trackIds"] as const) {
      const value = item[key];
      if (value !== undefined) {
        if (!Array.isArray(value) || value.length === 0 || value.some((id) => typeof id !== "number" || !Number.isInteger(id) || id <= 0)) {
          throw new Error(`item ${key} must be a non-empty array of positive integer ids when supplied.`);
        }
      }
    }
    // Sonarr's seasonNumber override: validated here, at the parse boundary,
    // so -1 / 1.5 / NaN never reach a native request.
    if (service === "sonarr") {
      assertSonarrSeasonNumber(item.seasonNumber, "item seasonNumber");
    }
  }
  const importMode = a.importMode ?? "auto";
  if (!MANUAL_IMPORT_MODES.includes(importMode)) {
    throw new Error(`importMode must be one of: ${MANUAL_IMPORT_MODES.join(", ")}.`);
  }
  return {
    downloadId: a.downloadId.trim(),
    items: a.items,
    // importMode is ALWAYS sent explicitly to the native command; "auto"
    // mirrors the queue-driven Interactive Import behavior of the *arr UIs.
    importMode,
    // Lidarr's Interactive Import UI defaults replaceExistingFiles to false
    // (the safer, non-destructive behavior); match it.
    replaceExistingFiles: a.replaceExistingFiles === true,
  };
}

/**
 * Resolve caller-supplied candidateIds against a freshly fetched native
 * candidate list. A candidateId that is not currently present is a hard
 * failure — this is what keeps execute from importing stale or fabricated
 * state.
 *
 * Resolution requires EXACTLY ONE match. Native candidate ids are 31-bit
 * hashes of the file path (HashConverter.GetHashInt31), so collisions are
 * possible; when two current candidates share an id, choosing one
 * automatically (e.g. `.find()`) could import the wrong file. We refuse and
 * tell the caller to disambiguate by re-running discovery — never by
 * supplying a path, which the execute API intentionally does not trust.
 */
function resolveManualImportCandidates<T extends { id: number; path: string }>(
  service: string,
  candidates: T[],
  items: ManualImportOverrideItem[],
): Array<{ candidate: T; override: ManualImportOverrideItem }> {
  return items.map((override) => {
    const matches = candidates.filter((c) => c.id === override.candidateId);
    if (matches.length === 0) {
      const available = candidates.map((c) => c.id).join(", ") || "none";
      throw new Error(
        `candidateId ${override.candidateId} is not among ${service}'s current manual-import candidates for this download (available candidateIds: ${available}). The files or queue state changed since discovery — re-run the *_get_manual_import_candidates tool before previewing or executing.`,
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `candidateId ${override.candidateId} matches ${matches.length} current manual-import candidates (${matches.map((c) => c.path).join("; ")}). ${service}'s native candidate ids are path hashes and can collide; refusing to choose one automatically. Re-run ${service}_get_manual_import_candidates and select the intended file — do not supply a path to disambiguate.`,
      );
    }
    return { candidate: matches[0], override };
  });
}

/** The native UI requires a quality object on every imported file. */
function hasManualImportQuality(quality?: ManualImportQuality | null): boolean {
  return !!quality && !!quality.quality;
}

function compactSonarrCandidate(c: SonarrManualImportCandidate) {
  return {
    candidateId: c.id,
    // path/relativePath are for DISPLAY ONLY; execute never accepts a caller path.
    path: c.path,
    relativePath: c.relativePath ?? null,
    folderName: c.folderName ?? null,
    name: c.name ?? null,
    size: c.size ?? null,
    downloadId: c.downloadId ?? null,
    series: c.series ? { id: c.series.id, title: c.series.title } : null,
    seasonNumber: c.seasonNumber ?? null,
    episodes: (c.episodes ?? []).map((e) => ({
      id: e.id,
      seasonNumber: e.seasonNumber ?? null,
      episodeNumber: e.episodeNumber ?? null,
      title: e.title ?? null,
    })),
    episodeFileId: c.episodeFileId ?? null,
    quality: c.quality ?? null,
    languages: c.languages ?? [],
    qualityWeight: c.qualityWeight ?? null,
    releaseGroup: c.releaseGroup ?? null,
    indexerFlags: c.indexerFlags ?? 0,
    releaseType: c.releaseType ?? null,
    customFormats: (c.customFormats ?? []).map((cf) => ({ id: cf.id ?? null, name: cf.name ?? null, score: cf.score ?? null })),
    customFormatScore: c.customFormatScore ?? null,
    rejections: (c.rejections ?? []).map((r) => ({ reason: r.reason, type: r.type ?? null })),
  };
}

function compactRadarrCandidate(c: RadarrManualImportCandidate) {
  return {
    candidateId: c.id,
    path: c.path,
    relativePath: c.relativePath ?? null,
    folderName: c.folderName ?? null,
    name: c.name ?? null,
    size: c.size ?? null,
    downloadId: c.downloadId ?? null,
    movie: c.movie ? { id: c.movie.id, title: c.movie.title, year: c.movie.year ?? null } : null,
    movieFileId: c.movieFileId ?? null,
    quality: c.quality ?? null,
    languages: c.languages ?? [],
    qualityWeight: c.qualityWeight ?? null,
    releaseGroup: c.releaseGroup ?? null,
    indexerFlags: c.indexerFlags ?? 0,
    customFormats: (c.customFormats ?? []).map((cf) => ({ id: cf.id ?? null, name: cf.name ?? null, score: cf.score ?? null })),
    customFormatScore: c.customFormatScore ?? null,
    rejections: (c.rejections ?? []).map((r) => ({ reason: r.reason, type: r.type ?? null })),
  };
}

function compactLidarrCandidate(c: LidarrManualImportCandidate) {
  return {
    candidateId: c.id,
    path: c.path,
    name: c.name ?? null,
    size: c.size ?? null,
    downloadId: c.downloadId ?? null,
    artist: c.artist ? { id: c.artist.id, artistName: c.artist.artistName } : null,
    album: c.album ? { id: c.album.id, title: c.album.title } : null,
    albumReleaseId: c.albumReleaseId ?? 0,
    tracks: (c.tracks ?? []).map((t) => ({
      id: t.id,
      title: t.title ?? null,
      trackNumber: t.trackNumber ?? null,
      position: t.position ?? null,
      mediumNumber: t.mediumNumber ?? null,
    })),
    quality: c.quality ?? null,
    releaseGroup: c.releaseGroup ?? null,
    qualityWeight: c.qualityWeight ?? null,
    indexerFlags: c.indexerFlags ?? 0,
    // Lidarr's core Rejection serializes as { reason, type } like Sonarr/Radarr
    // (reason may be null; type omitted when default — {} is valid).
    rejections: (c.rejections ?? []).map((r) => ({ reason: r.reason ?? null, type: r.type ?? null })),
    additionalFile: c.additionalFile ?? false,
    replaceExistingFiles: c.replaceExistingFiles ?? null,
    disableReleaseSwitching: c.disableReleaseSwitching ?? false,
  };
}

/**
 * Prominent directive returned FIRST in Sonarr discovery/preview responses.
 * Agents have repeatedly treated Sonarr's suggested mapping and rejection
 * reasons as fact, recommended allowRejected=true, and imported files into the
 * wrong episodes — a complete-looking mapping (mappingValid: true) is only a
 * parse proposal. The principle that must survive is that the mapping is a
 * proposal, not ground truth. The evidence rules stay deliberately balanced:
 * titles and numbering are BOTH evidence and conflicts are ambiguous, so no
 * single incident's heuristic is encoded as universal production behavior.
 * Kept short — this text is returned on every discovery/preview call.
 */
const SONARR_VERIFY_DIRECTIVE = [
  "Sonarr's mapping and rejection reasons are a parse PROPOSAL derived from the release name — not verified facts. mappingValid: true means the proposal is complete, not that it is correct; a rejection is Sonarr's opinion, not ground truth.",
  "Before execute — especially before allowRejected=true — verify the proposal against the library: series identity, season/episode identity (sonarr_get_episodes), the release title and numbering where the name supplies them, and existing-file state.",
  "Titles and numbering are both evidence, and neither is conclusive alone. A number mismatch does not by itself prove the mapping wrong (TheTVDB/TMDB/absolute-numbering conventions differ); a title that matches none of the detected episodes does not by itself prove it right (translations and fan-sub titles differ from official ones). When the evidence conflicts, treat the mapping as AMBIGUOUS and investigate — including seasonNumber=0 for specials — rather than automatically trusting Sonarr's proposal or overriding it.",
  "An existing file on the target episode is not by itself a reason to skip: read the preview's upgradeAssessment. 'no-existing-file' → fills a gap; 'no-upgrade-rejection' → Sonarr raised no hard/native upgrade rejection and the available provenance-aware CF evidence does not show a downgrade (it is NOT a universal 'equal to or better' claim); 'cf-downgrade-despite-native-acceptance' → release/file CF provenance shows a downgrade even though Sonarr's stripped per-file metadata triggered no CF rejection; 'not-an-upgrade' → Sonarr rejects it as not better (quality/revision, already-imported, or a CF downgrade confirmed by release+file evidence); 'cf-upgrade-with-native-rejection' → the tracked release + file CF evidence scores the candidate ABOVE the existing file(s) even though Sonarr's per-file CF check rejected it; 'cf-assessment-ambiguous' → the CF comparison cannot be computed safely (mixed outcomes, invalid/unresolvable attribution, effective-series mismatch, or a season pack whose release-level CF context is unavailable). A per-file native CF rejection is NOT sufficient evidence to remove/blocklist a tracked release when release-level CF provenance conflicts with it — blocklisting acts on the whole release. Re-check after any remap — the preview evaluates against the NEW target's file.",
];

const RADARR_VERIFY_DIRECTIVE = [
  "Radarr's suggested movie mapping and rejection reasons are PARSE GUESSES derived from the release name — NOT verified facts. A complete-looking mapping can point at the wrong movie (wrong year, wrong edition, sequel/confusion).",
  "Before recommending execute — especially before setting allowRejected=true — independently VERIFY the mapping against your library (radarr_get_movies / radarr_search): title, year, and edition must plausibly match the release. Do not treat the suggested mapping as fact.",
];

const LIDARR_VERIFY_DIRECTIVE = [
  "Lidarr's suggested artist/album/release mapping, track mapping, and rejection reasons are PARSE GUESSES derived from the files — NOT verified facts. A complete-looking mapping can point at the wrong album (wrong year, wrong edition, comp vs studio album).",
  "Before recommending execute — especially before setting allowRejected=true — independently VERIFY the mapping (lidarr_get_artists / lidarr_get_albums): artist, album title, year/edition, and the track list must plausibly correspond to the files. Do not treat the suggested mapping as fact.",
];

function manualImportGuidance(service: string, downloadId: string) {
  const lines = [
    `Preview is non-importing: nothing has been moved, copied, or imported.`,
    `To import, call ${service}_execute_manual_import with the same downloadId and items (candidateId + any mapping overrides).`,
    `Candidates with remaining rejections are refused by the execute tool unless that item sets allowRejected=true — decide per candidate, from the rejections above, whether overriding is appropriate.`,
    `Candidates with no valid entity mapping (series/movie/artist+album) are reported as mappingRequired and are never sent to the native reprocess endpoint; supply an explicit id override first.`,
    `Queue imports default to importMode=auto; command acceptance is asynchronous, so re-check ${service}_get_queue afterwards.`,
  ];
  if (service === "sonarr") {
    lines.push(
      "A per-file native Custom Format rejection is NOT sufficient evidence to remove/blocklist the tracked release: blocklisting acts on the whole release, so weigh the release-level CF provenance in upgradeAssessment.customFormatAssessment first. This tool never removes or blocklists queue items.",
    );
  }
  return lines;
}

function jsonTextError(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    isError: true,
  };
}

// --- Sonarr -----------------------------------------------------------------

/**
 * The Sonarr mapping is a hierarchy: series → season → episodes.
 *
 * Native Interactive Import clears the dependents when a parent is reselected
 * (frontend/src/InteractiveImport/Interactive/InteractiveImportRow.tsx):
 *
 *   onSeriesSelect → updateInteractiveImportItem(id, { series, seasonNumber: undefined, episodes: [] })
 *   onSeasonSelect → updateInteractiveImportItem(id, { seasonNumber, episodes: [] })
 *
 * The MCP layer must do the same, because Sonarr's reprocess endpoint does NOT
 * validate the pairing: `ManualImportService.ReprocessItem` resolves
 * `episodeIds` globally (`_episodeService.GetEpisodes(episodeIds)`) and assigns
 * them to whatever `seriesId` was supplied, so a stale child mapping inherited
 * across a parent change is accepted and imported rather than rejected.
 */
interface SonarrEffectiveMapping {
  seriesId: number;
  seasonNumber: number | null;
  episodeIds: number[];
  seriesChanged: boolean;
  seasonChanged: boolean;
}

function sonarrOriginalSeriesId(candidate: SonarrManualImportCandidate): number {
  return candidate.series?.id ?? candidate.seriesId ?? 0;
}

function sonarrEffectiveMapping(
  candidate: SonarrManualImportCandidate,
  override: ManualImportOverrideItem,
): SonarrEffectiveMapping {
  const originalSeriesId = sonarrOriginalSeriesId(candidate);
  const originalSeasonNumber = candidate.seasonNumber ?? null;
  const originalEpisodeIds = (candidate.episodes ?? []).map((e) => e.id);

  const seriesChanged = override.seriesId !== undefined && override.seriesId !== originalSeriesId;
  const seasonChanged = override.seasonNumber !== undefined && override.seasonNumber !== originalSeasonNumber;

  return {
    seriesId: override.seriesId ?? originalSeriesId,
    seasonNumber: override.seasonNumber !== undefined
      ? override.seasonNumber
      : seriesChanged ? null : originalSeasonNumber,
    episodeIds: override.episodeIds !== undefined
      ? override.episodeIds
      : seriesChanged || seasonChanged ? [] : originalEpisodeIds,
    seriesChanged,
    seasonChanged,
  };
}

function buildSonarrReprocessItem(
  candidate: SonarrManualImportCandidate,
  override: ManualImportOverrideItem,
  downloadId: string,
): SonarrManualImportReprocessItem {
  // Only identity/mapping fields may be overridden; everything Sonarr already
  // determined (quality, languages, indexer flags, release type) is taken from
  // the freshly fetched candidate, mirroring the Interactive Import UI.
  const mapping = sonarrEffectiveMapping(candidate, override);
  return {
    id: candidate.id,
    path: candidate.path,
    seriesId: mapping.seriesId,
    seasonNumber: mapping.seasonNumber,
    episodeIds: mapping.episodeIds,
    quality: candidate.quality ?? null,
    languages: candidate.languages ?? [],
    releaseGroup: override.releaseGroup ?? candidate.releaseGroup ?? null,
    indexerFlags: candidate.indexerFlags ?? 0,
    releaseType: candidate.releaseType ?? null,
    downloadId: candidate.downloadId ?? downloadId,
  };
}

/**
 * Sonarr's reprocess service resolves the series via `seriesService.GetSeries`
 * and throws for a missing id, so an unmapped candidate must never be sent to
 * POST /manualimport with a fabricated 0. The caller must supply a real
 * seriesId (discovered via sonarr_get_series) first.
 */
function sonarrEffectiveSeriesId(candidate: SonarrManualImportCandidate, override: ManualImportOverrideItem): number {
  return sonarrEffectiveMapping(candidate, override).seriesId;
}

/**
 * Episodes for one (series, season) — `GET /api/v3/episode?seriesId=&seasonNumber=`,
 * the query the native episode picker uses. Cached per preview/execute call:
 * the episode-id validation and the upgrade assessment ask for the same season.
 */
async function getSonarrSeasonEpisodes(
  client: SonarrClient,
  seriesId: number,
  seasonNumber: number,
  cache: Map<string, SonarrEpisodeWithFile[]>,
  ctx: PreviewExecutionContext,
): Promise<SonarrEpisodeWithFile[]> {
  const key = `${seriesId}:${seasonNumber}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const episodes = await client.getEpisodesWithFiles(seriesId, seasonNumber, ctx.signal);
  cache.set(key, episodes);
  return episodes;
}

/**
 * Episode files for a series, joined onto the season's episodes by
 * episodeFileId. The episode resource is the only native shape that links
 * files to episodes — the file list itself has no episode linkage.
 */
async function joinSonarrSeasonEpisodeFiles(
  client: SonarrClient,
  seriesId: number,
  seasonNumber: number,
  episodeCache: Map<string, SonarrEpisodeWithFile[]>,
  fileCache: Map<number, SonarrEpisodeFile[]>,
  ctx: PreviewExecutionContext,
): Promise<Array<SonarrEpisodeWithFile & { _file?: SonarrEpisodeFile }>> {
  const episodes = await getSonarrSeasonEpisodes(client, seriesId, seasonNumber, episodeCache, ctx);

  const cachedFiles = fileCache.get(seriesId);
  const files = cachedFiles ?? await client.getEpisodeFiles(seriesId, ctx.signal);
  if (!cachedFiles) fileCache.set(seriesId, files);

  const fileById = new Map(files.map((f) => [f.id, f]));
  return episodes.map((ep) => ({ ...ep, _file: fileById.get(ep.episodeFileId ?? 0) }));
}

/**
 * Validate caller-supplied episodeIds against native Sonarr data.
 *
 * Sonarr's own reprocess resolves episode ids globally and pairs them with the
 * supplied seriesId without checking ownership, so an id from another series —
 * or another season — survives reprocessing and reaches the import command.
 * The MCP layer is the only place that can catch it, so an explicit selection
 * is checked against `GET /api/v3/episode?seriesId=&seasonNumber=` (the exact
 * query the native episode picker uses) before anything is submitted.
 */
async function validateSonarrEpisodeIds(
  client: SonarrClient,
  mapping: SonarrEffectiveMapping,
  callerSupplied: boolean,
  cache: Map<string, SonarrEpisodeWithFile[]>,
  ctx: PreviewExecutionContext,
): Promise<Record<string, unknown>> {
  const { seriesId, seasonNumber, episodeIds } = mapping;
  const base = {
    checked: callerSupplied,
    seasonNumber,
    episodeIds,
  };

  if (!callerSupplied) {
    return { ...base, ok: true, unknownEpisodeIds: [], note: "episodeIds came from Sonarr's own parse for this candidate; not caller-supplied, so not re-validated." };
  }
  if (episodeIds.length === 0) {
    return { ...base, ok: true, unknownEpisodeIds: [], note: "no explicit episodeIds supplied." };
  }
  const season = seasonNumber;
  if (typeof season !== "number" || !Number.isInteger(season)) {
    return {
      ...base,
      ok: false,
      unknownEpisodeIds: episodeIds,
      reason: "episodeIds require a valid effective seasonNumber; no effective season is available for this mapping — the inherited season was cleared by a series override (or the candidate had none). Supply the corrected seasonNumber together with the episodeIds. An inherited season that a parent change did NOT clear stays valid: episodeIds alone are validated against it, so seasonNumber does not need to be repeated.",
    };
  }

  const seasonEpisodes = await getSonarrSeasonEpisodes(client, seriesId, season, cache, ctx);
  const knownIds = new Set(seasonEpisodes.map((e) => e.id));
  const unknownEpisodeIds = episodeIds.filter((id) => !knownIds.has(id));

  return {
    ...base,
    ok: unknownEpisodeIds.length === 0,
    unknownEpisodeIds,
    seasonEpisodeCount: seasonEpisodes.length,
    ...(unknownEpisodeIds.length > 0
      ? {
          reason:
            `episodeIds ${unknownEpisodeIds.join(", ")} are not episodes of series ${seriesId} season ${seasonNumber} (GET /api/v3/episode?seriesId=${seriesId}&seasonNumber=${seasonNumber} returned ${seasonEpisodes.length} episodes). They belong to a different series or season — Sonarr's reprocess would accept them and import into the wrong episode.`,
        }
      : {}),
  };
}

/**
 * The effective series identity for a response.
 *
 * Sonarr's reprocess response carries no `series` object, so an overridden
 * seriesId paired with the ORIGINAL candidate's title would report a real id
 * with a stale, unrelated title — and the verify-before-acting guidance tells
 * agents to check mappings by title. Fetch the real series when the id changed,
 * and report `title: null` rather than stale metadata if the fetch fails.
 */
async function sonarrEffectiveSeries(
  client: SonarrClient,
  seriesId: number,
  candidate: SonarrManualImportCandidate,
  cache: Map<number, { id: number; title: string | null }>,
  ctx: PreviewExecutionContext,
): Promise<{ id: number; title: string | null }> {
  if (seriesId <= 0) return { id: seriesId, title: null };

  if (seriesId === sonarrOriginalSeriesId(candidate) && candidate.series) {
    return { id: seriesId, title: candidate.series.title };
  }

  const cached = cache.get(seriesId);
  if (cached) return cached;

  let resolved: { id: number; title: string | null };
  try {
    const series = await client.getSeriesById(seriesId, ctx.signal);
    resolved = { id: seriesId, title: series?.title ?? null };
  } catch (error) {
    rethrowIfOperationAborted(ctx.signal);
    if (error instanceof ArrRequestTimeoutError) throw error;
    resolved = { id: seriesId, title: null };
  }
  cache.set(seriesId, resolved);
  return resolved;
}

/**
 * Tracked-release custom-format context carried by Sonarr's queue resource
 * (`customFormats` / `customFormatScore`, derived from `RemoteEpisode` and
 * scored against the series quality profile). This is the native release-level
 * evidence the manual-import file evaluation can miss (e.g. season packs whose
 * per-file names strip the release metadata). Never reconstructed from the
 * title — if no queue item matches the downloadId, the context is unavailable.
 */
interface SonarrReleaseContext {
  available: boolean;
  title: string | null;
  customFormats: Array<{ id: number; name: string | null }>;
  nativeScore: number | null;
  seriesId: number | null;
  reason: string | null;
}

async function findSonarrReleaseContext(client: SonarrClient, downloadId: string, ctx: PreviewExecutionContext): Promise<SonarrReleaseContext> {
  const pageSize = 100;
  let page = 1;
  while (true) {
    let queue: { records: QueueItem[]; totalRecords: number };
    try {
      queue = await client.getQueue(page, pageSize, ctx.signal);
    } catch (error) {
      rethrowIfOperationAborted(ctx.signal);
      if (error instanceof ArrRequestTimeoutError) throw error;
      return { available: false, title: null, customFormats: [], nativeScore: null, seriesId: null, reason: "queue-unavailable" };
    }
    const match = (queue.records ?? []).find((q) => q.downloadId === downloadId);
    if (match) {
      return {
        available: true,
        title: match.title ?? null,
        customFormats: (match.customFormats ?? [])
          .filter((cf) => typeof cf.id === "number")
          .map((cf) => ({ id: cf.id as number, name: cf.name ?? null })),
        nativeScore: match.customFormatScore ?? null,
        seriesId: match.seriesId ?? null,
        reason: null,
      };
    }
    const fetched = page * pageSize;
    if ((queue.records?.length ?? 0) === 0 || fetched >= (queue.totalRecords ?? 0)) {
      return { available: false, title: null, customFormats: [], nativeScore: null, seriesId: null, reason: "queue-item-not-found" };
    }
    page += 1;
  }
}

/**
 * `customFormatId -> { name, score }` for the effective series' quality
 * profile. Cached per preview call (keyed by seriesId) so a multi-file season
 * pack resolves the profile once, not once per candidate. Returns null when
 * the series/profile cannot be resolved — the caller must then treat CF
 * attribution as unavailable rather than inventing a total.
 */
async function resolveSonarrProfileCFScores(
  client: SonarrClient,
  seriesId: number,
  profileCache: Map<number, Map<number, { name: string; score: number }> | null>,
  ctx: PreviewExecutionContext,
): Promise<Map<number, { name: string; score: number }> | null> {
  if (seriesId <= 0) return null;
  if (profileCache.has(seriesId)) return profileCache.get(seriesId) ?? null;

  let map: Map<number, { name: string; score: number }> | null = null;
  try {
    const series = await client.getSeriesById(seriesId, ctx.signal);
    const profiles = await client.getQualityProfiles(ctx.signal);
    const profile: QualityProfile | undefined = profiles.find((p) => p.id === series.qualityProfileId);
    if (profile) {
      map = new Map();
      for (const f of profile.formatItems ?? []) {
        map.set(f.format, { name: f.name, score: f.score });
      }
    }
  } catch (error) {
    rethrowIfOperationAborted(ctx.signal);
    if (error instanceof ArrRequestTimeoutError) throw error;
    map = null;
  }
  profileCache.set(seriesId, map);
  return map;
}

interface SonarrCFContributor {
  id: number;
  name: string | null;
  score: number;
  matchedAt: Array<"release" | "file">;
}

/**
 * Merge the tracked-release and file/import custom-format match sets into one
 * effective pending-candidate set, deduplicated strictly by custom-format id
 * (a format matched at both levels contributes once, never twice). Each unique
 * id's score comes from the effective quality profile. The native totals are
 * kept as consistency checks: when the profile-attributed sums disagree with
 * them, attribution is reported invalid so no hard verdict is built on it.
 */
function mergeSonarrCustomFormats(
  releaseCFs: Array<{ id: number; name: string | null }>,
  fileCFs: Array<{ id?: number; name?: string; score?: number }>,
  profileScores: Map<number, { name: string; score: number }>,
  nativeReleaseScore: number | null,
  nativeFileScore: number | null,
): {
  contributors: SonarrCFContributor[];
  releaseScore: number;
  fileScore: number;
  effectiveScore: number;
  scoreAttributionValid: boolean;
  attributionProblems: string[];
} {
  const byId = new Map<number, SonarrCFContributor>();
  const add = (id: number, name: string | null, at: "release" | "file") => {
    let entry = byId.get(id);
    if (!entry) {
      entry = { id, name: name ?? null, score: 0, matchedAt: [] };
      byId.set(id, entry);
    }
    if (name && !entry.name) entry.name = name;
    if (!entry.matchedAt.includes(at)) entry.matchedAt.push(at);
  };
  for (const cf of releaseCFs) add(cf.id, cf.name, "release");
  for (const cf of fileCFs) {
    if (typeof cf.id === "number") add(cf.id, cf.name ?? null, "file");
  }

  const problems: string[] = [];
  let releaseScore = 0;
  let fileScore = 0;
  let effectiveScore = 0;
  let valid = true;
  for (const entry of byId.values()) {
    const profile = profileScores.get(entry.id);
    if (!profile) {
      valid = false;
      problems.push(`custom format id ${entry.id}${entry.name ? ` (${entry.name})` : ""} is not present in the effective series quality profile`);
      entry.score = 0;
    } else {
      entry.score = profile.score;
      entry.name = profile.name;
    }
    effectiveScore += entry.score;
    if (entry.matchedAt.includes("release")) releaseScore += entry.score;
    if (entry.matchedAt.includes("file")) fileScore += entry.score;
  }

  if (nativeReleaseScore != null && nativeReleaseScore !== releaseScore) {
    valid = false;
    problems.push(`native release score ${nativeReleaseScore} does not equal the profile-attributed release CF sum ${releaseScore}`);
  }
  if (nativeFileScore != null && nativeFileScore !== fileScore) {
    valid = false;
    problems.push(`native file score ${nativeFileScore} does not equal the profile-attributed file CF sum ${fileScore}`);
  }

  return {
    contributors: [...byId.values()].sort((a, b) => b.score - a.score),
    releaseScore,
    fileScore,
    effectiveScore,
    scoreAttributionValid: valid,
    attributionProblems: problems,
  };
}

/**
 * Classify Sonarr's manual-import upgrade rejections. Sonarr's import decision
 * maker can return SEVERAL rejections from different specifications, so the
 * assessment must scan all of them and never trust array order.
 *
 * Quality, revision and already-imported rejections are HARD: a favorable
 * custom-format score must NOT override them. The custom-format rejection is
 * the one case where release-level CF provenance can legitimately conflict
 * with Sonarr's per-file evaluation.
 *
 * "Not a quality revision upgrade for existing episode file(s)" is a distinct
 * native string that does NOT contain "not an upgrade", so it needs its own
 * pattern — matching only /not an upgrade/ would miss it entirely.
 */
interface SonarrUpgradeRejections {
  quality?: ManualImportRejection;
  revision?: ManualImportRejection;
  alreadyImported?: ManualImportRejection;
  customFormat?: ManualImportRejection;
}

function classifySonarrUpgradeRejections(rejections: ManualImportRejection[]): SonarrUpgradeRejections {
  const out: SonarrUpgradeRejections = {};
  for (const r of rejections) {
    const text = r.reason ?? "";
    if (!out.customFormat && /custom format upgrade/i.test(text)) out.customFormat = r;
    if (!out.revision && /not a quality revision upgrade/i.test(text)) out.revision = r;
    if (!out.quality && /not an upgrade/i.test(text)) out.quality = r;
    if (!out.alreadyImported && /already imported/i.test(text)) out.alreadyImported = r;
  }
  return out;
}

function compareSonarrCFScore(effectiveScore: number, existingScores: number[]): "upgrade" | "neutral" | "downgrade" | "mixed" {
  if (existingScores.length === 0) return "neutral";
  if (existingScores.every((s) => effectiveScore === s)) return "neutral";
  if (existingScores.every((s) => effectiveScore >= s)) return "upgrade";
  if (existingScores.every((s) => effectiveScore < s)) return "downgrade";
  return "mixed";
}

/**
 * Compare a manual-import candidate against the files already on disk for its
 * mapped episodes. Sonarr's own reprocess evaluates the existing file and
 * raises "Not an upgrade for existing episode file(s)" (quality profile) /
 * "Not a Custom Format upgrade for existing episode file(s)" (CF score) /
 * "Episode already imported" when the new file is not better — including
 * after a remap in preview.
 *
 * Sonarr's per-file CF evaluation uses only the file/import context, so a
 * season pack whose release-level metadata (source, audio, …) lives only in the
 * release name scores 0 per file and is rejected as "not a CF upgrade" even
 * when the tracked release clearly beats the existing file. The tracked
 * release's queue CF context is merged with the file CF context (deduplicated
 * by custom-format id, scored against the effective quality profile) to build
 * the effective pending-candidate CF score. The comparison is applied
 * symmetrically: a per-file CF rejection the release evidence contradicts is
 * reported as an upgrade, and a release-only negative CF that the per-file
 * evaluation cannot see is reported as a downgrade even when Sonarr raised no
 * rejection. Quality/revision/already-imported rejections are hard refusals
 * that a favorable CF score never overrides, and the classification scans ALL
 * rejections so array order never changes the verdict.
 */
async function assessSonarrUpgrade(
  client: SonarrClient,
  candidate: SonarrManualImportCandidate,
  reprocessed: SonarrManualImportCandidate,
  seriesId: number,
  episodes: SonarrManualImportEpisode[],
  rejections: ManualImportRejection[],
  episodeCache: Map<string, SonarrEpisodeWithFile[]>,
  fileCache: Map<number, SonarrEpisodeFile[]>,
  releaseContext: SonarrReleaseContext,
  profileCache: Map<number, Map<number, { name: string; score: number }> | null>,
  ctx: PreviewExecutionContext,
): Promise<Record<string, unknown>> {
  const newQualityWeight = reprocessed.qualityWeight ?? candidate.qualityWeight ?? 0;
  const fileCustomFormats = reprocessed.customFormats ?? candidate.customFormats ?? [];
  const fileNativeScore = reprocessed.customFormatScore ?? candidate.customFormatScore ?? 0;
  const releaseType = reprocessed.releaseType ?? candidate.releaseType ?? null;
  const seasonPack = releaseType === "seasonPack";

  const classified = classifySonarrUpgradeRejections(rejections);
  const hardRejection = classified.quality ?? classified.revision ?? classified.alreadyImported;
  const cfRejection = classified.customFormat;
  const drivingRejection = hardRejection ?? cfRejection ?? null;

  const seasonNumber = reprocessed.seasonNumber ?? candidate.seasonNumber;
  const existingFiles: Array<Record<string, unknown>> = [];
  if (typeof seasonNumber === "number") {
    const eps = await joinSonarrSeasonEpisodeFiles(client, seriesId, seasonNumber, episodeCache, fileCache, ctx);
    for (const e of episodes) {
      const ep = eps.find((x) => x.id === e.id);
      const f = (ep as { _file?: SonarrEpisodeFile } | undefined)?._file;
      if (ep?.hasFile && f) {
        existingFiles.push({
          episodeId: e.id,
          quality: f.quality?.quality?.name ?? null,
          customFormatScore: f.customFormatScore ?? 0,
          qualityCutoffNotMet: f.qualityCutoffNotMet ?? null,
          releaseGroup: f.releaseGroup ?? null,
        });
      }
    }
  }

  // Effective-series guard: the tracked queue CF set was computed for the
  // tracked release's series. A remap to a different series must not inherit it.
  const effectiveSeriesMatchesQueue = releaseContext.seriesId == null || releaseContext.seriesId === seriesId;
  const usableForEffectiveScore = releaseContext.available && effectiveSeriesMatchesQueue;

  let customFormatAssessment: Record<string, unknown> | null = null;
  let comparison: "upgrade" | "neutral" | "downgrade" | "mixed" | "unavailable" = "unavailable";
  if (releaseContext.available) {
    const profileScores = await resolveSonarrProfileCFScores(client, seriesId, profileCache, ctx);
    const merged = usableForEffectiveScore && profileScores
      ? mergeSonarrCustomFormats(
          releaseContext.customFormats,
          fileCustomFormats,
          profileScores,
          releaseContext.nativeScore,
          fileNativeScore,
        )
      : null;
    if (merged) {
      comparison = compareSonarrCFScore(merged.effectiveScore, existingFiles.map((f) => f.customFormatScore as number));
    }
    customFormatAssessment = {
      release: {
        title: releaseContext.title,
        nativeScore: releaseContext.nativeScore,
        formats: releaseContext.customFormats,
      },
      file: {
        nativeScore: fileNativeScore,
        formats: fileCustomFormats.map((cf) => ({ id: cf.id ?? null, name: cf.name ?? null })),
      },
      effectiveCandidate: merged
        ? { score: merged.effectiveScore, contributors: merged.contributors }
        : null,
      scoreAttributionValid: merged ? merged.scoreAttributionValid : false,
      attributionProblems: merged
        ? merged.attributionProblems
        : (usableForEffectiveScore
          ? ["the effective series' quality profile could not be resolved"]
          : ["effective-series-mismatch: the tracked release's CF matches do not safely apply to the remapped series"]),
      comparison,
    };
  }

  const acceptedNote = "Sonarr raised no native upgrade rejection, and the available CF evidence does not show the pending candidate as worse than the existing file(s). Compare the listed existing quality names and custom format scores against the candidate (newQualityWeight/newCustomFormatScore) to judge upgrade vs neutral.";
  const ordinaryNote = "Sonarr raised no native upgrade rejection and no conflicting release-level CF evidence is available for this ordinary file case. Compare the listed existing quality names and custom format scores against the candidate (newQualityWeight/newCustomFormatScore) to judge upgrade vs neutral.";

  // Provenance is materially relevant when release-level CF context exists (or
  // is expected, for a season pack) but cannot be evaluated safely. In that
  // case the absence of a native rejection does NOT prove the candidate is
  // equal to or better, so the assessment stays ambiguous rather than accepting.
  const validProvenance =
    existingFiles.length > 0 &&
    !!customFormatAssessment &&
    customFormatAssessment.scoreAttributionValid === true &&
    !!customFormatAssessment.effectiveCandidate;
  const provenanceRelevantButUnusable =
    existingFiles.length > 0 &&
    !validProvenance &&
    (releaseContext.available ? true : seasonPack);

  let verdict: string;
  let note: string;
  if (hardRejection) {
    verdict = "not-an-upgrade";
    if (classified.alreadyImported && !classified.quality && !classified.revision) {
      note = `Sonarr reports the episode is already imported ("${hardRejection.reason}"). Do not import.`;
    } else {
      note = `Sonarr's own decision rejects this mapping on quality/revision grounds ("${hardRejection.reason}") — the new file is NOT better than the existing episode file(s). A higher custom-format score does not override a lower quality. Do not import.`;
    }
  } else if (cfRejection) {
    if (!releaseContext.available) {
      if (seasonPack) {
        verdict = "cf-assessment-ambiguous";
        note = "Sonarr rejected the individual file on a per-file Custom Format basis, and this is a season pack whose release-level CF metadata is not present in the file names. The tracked release's custom-format context is unavailable, so the pending-candidate CF comparison cannot be computed. This is NOT sufficient evidence to remove/blocklist the release — resolve the queue context (sonarr_get_queue) and re-preview. Execution requires explicit allowRejected=true.";
      } else {
        verdict = "not-an-upgrade";
        note = `Sonarr's own decision rejects this mapping ("${cfRejection.reason}") — the new file is NOT better than the existing episode file(s). Do not import.`;
      }
    } else if (!effectiveSeriesMatchesQueue) {
      verdict = "cf-assessment-ambiguous";
      note = "The candidate was remapped to a series other than the tracked release's series, so the tracked release's custom-format matches do not safely apply to the effective series. The CF comparison is ambiguous — verify the target series' quality profile before deciding. Execution requires explicit allowRejected=true.";
    } else if (!customFormatAssessment || !customFormatAssessment.scoreAttributionValid || !(customFormatAssessment.effectiveCandidate as { score: number } | null)) {
      verdict = "cf-assessment-ambiguous";
      note = "The tracked-release and file custom-format IDs could not be fully attributed to the effective series' quality profile, so the pending-candidate CF score is not reliable for a hard verdict. This is NOT sufficient evidence to remove/blocklist the release. Execution requires explicit allowRejected=true.";
    } else if (comparison === "upgrade") {
      verdict = "cf-upgrade-with-native-rejection";
      note = "The tracked release + file CF evidence scores this pending candidate above the existing file(s), but Sonarr's native manual-import decision rejected the individual file using its file/import CF context. Do not remove or blocklist this release solely because of that per-file CF rejection. Execution still requires explicit allowRejected=true.";
    } else if (comparison === "downgrade" || comparison === "neutral") {
      verdict = "not-an-upgrade";
      note = `Sonarr's own decision rejects this mapping ("${cfRejection.reason}") and the tracked-release + file CF evidence confirms the pending candidate does not improve on the existing file(s). Do not import.`;
    } else {
      verdict = "cf-assessment-ambiguous";
      note = "The pending candidate's effective CF score is better than some existing files and worse than others (mixed). Decide per episode; a per-file CF rejection is not sufficient evidence to blocklist the whole release. Execution requires explicit allowRejected=true.";
    }
  } else if (existingFiles.length === 0) {
    verdict = "no-existing-file";
    note = "No existing file for the mapped episodes — importing fills a gap.";
  } else if (provenanceRelevantButUnusable) {
    // Release-level CF context is relevant (present, or expected for a season
    // pack) but cannot be evaluated safely. Do not convert that uncertainty
    // into an acceptance conclusion.
    verdict = "cf-assessment-ambiguous";
    if (!releaseContext.available) {
      note = "This is a season pack whose release-level Custom Format metadata is not present in the individual file names, and the tracked release's custom-format context is unavailable. Sonarr raised no native upgrade rejection, but for a season pack that does not prove the candidate is equal to or better — resolve the queue context (sonarr_get_queue) and re-preview.";
    } else if (!effectiveSeriesMatchesQueue) {
      note = "The candidate was remapped to a series other than the tracked release's series, so the tracked release's custom-format matches do not safely apply to the effective series. Sonarr raised no native upgrade rejection, but the release-level CF evidence cannot be evaluated for the new series — the comparison is ambiguous. Verify the target series' quality profile before deciding.";
    } else if (!customFormatAssessment || !customFormatAssessment.effectiveCandidate) {
      note = "The effective series' quality profile could not be resolved, so the tracked release's custom-format matches cannot be scored. Sonarr raised no native upgrade rejection, but the release-level CF evidence cannot be evaluated — the comparison is ambiguous.";
    } else {
      note = "The tracked-release and file custom-format IDs could not be reconciled with the effective series' quality profile, so the pending-candidate CF score is not reliable. Sonarr raised no native upgrade rejection, but that does not prove the candidate is equal to or better — the comparison is ambiguous.";
    }
  } else if (validProvenance) {
    // No native rejection, and the provenance-aware comparison applies
    // symmetrically: release-only metadata the per-file evaluation cannot see
    // can make the candidate a CF downgrade (or a mixed result) that Sonarr's
    // stripped filename assessment never surfaces as a rejection.
    if (comparison === "downgrade") {
      verdict = "cf-downgrade-despite-native-acceptance";
      note = "Sonarr raised no per-file Custom Format upgrade rejection, but the tracked release + file CF provenance scores this pending candidate below the existing file(s). Release-level negative Custom Formats were lost from the individual filename, so the native per-file assessment overstates the candidate. Do not treat the absence of a native rejection as evidence that this is an upgrade.";
    } else if (comparison === "mixed") {
      verdict = "cf-assessment-ambiguous";
      note = "The pending candidate's effective CF score is better than some existing files and worse than others (mixed). Sonarr raised no rejection, so execution is not blocked, but the CF evidence is not uniform — decide per episode.";
    } else {
      verdict = "no-upgrade-rejection";
      note = acceptedNote;
    }
  } else {
    // Ordinary single-file release with no release-level CF context and no
    // evidence of provenance divergence: preserve the native behavior.
    verdict = "no-upgrade-rejection";
    note = ordinaryNote;
  }

  return {
    verdict,
    newQualityWeight,
    newCustomFormatScore: fileNativeScore,
    existingFiles,
    note,
    customFormatAssessment,
    releaseContext: {
      available: releaseContext.available,
      usableForEffectiveScore,
      reason: effectiveSeriesMatchesQueue ? releaseContext.reason : "effective-series-mismatch",
      metadataInheritanceLikely: seasonPack,
    },
    nativeImportRejection: drivingRejection?.reason ?? null,
  };
}

function mappingRequiredEntry(candidateId: number, name: string | null, path: string, missing: string[]) {
  return {
    candidateId,
    name,
    path,
    canPreview: false,
    mappingRequired: true,
    missing,
  };
}

async function previewSonarrManualImport(client: SonarrClient, args: unknown, ctx: PreviewExecutionContext) {
  const { downloadId, items } = parseManualImportArgs(args, "sonarr");
  const a = (args ?? {}) as ManualImportToolArgs;

  ctx.setStage("discovering-candidates");
  const candidates = await client.getManualImportCandidates({
    downloadId,
    seriesId: a.seriesId,
    filterExistingFiles: a.filterExistingFiles,
  }, ctx.signal);
  if (candidates.length === 0) {
    throw new Error(
      `Sonarr returned no manual-import candidates for downloadId '${downloadId}'. The download is likely no longer tracked — check sonarr_get_queue.`,
    );
  }

  const resolved = resolveManualImportCandidates("Sonarr", candidates, items);
  const previewable = resolved.filter(({ candidate, override }) => sonarrEffectiveSeriesId(candidate, override) > 0);
  const unmapped = resolved.filter(({ candidate, override }) => sonarrEffectiveSeriesId(candidate, override) <= 0);

  ctx.setStage("native-reprocess");
  const reprocessed = previewable.length > 0
    ? await client.reprocessManualImport(previewable.map(({ candidate, override }) => buildSonarrReprocessItem(candidate, override, downloadId)), ctx.signal)
    : [];
  const byId = new Map(reprocessed.map((r) => [r.id, r]));

  ctx.setStage("resolving-related-data");
  const previews: Array<Record<string, unknown>> = [];
  const episodeCache = new Map<string, SonarrEpisodeWithFile[]>();
  const fileCache = new Map<number, SonarrEpisodeFile[]>();
  const seriesCache = new Map<number, { id: number; title: string | null }>();
  // Tracked-release CF context and quality-profile scores are resolved once per
  // preview call and reused for every candidate from the same download.
  const releaseContext = await findSonarrReleaseContext(client, downloadId, ctx);
  const profileCache = new Map<number, Map<number, { name: string; score: number }> | null>();
  for (const { candidate, override } of previewable) {
    const r = byId.get(candidate.id);
    if (!r) {
      throw new Error(
        `Sonarr did not return candidate ${candidate.id} after reprocessing; the candidate changed — re-run sonarr_get_manual_import_candidates.`,
      );
    }
    const mapping = sonarrEffectiveMapping(candidate, override);
    const seriesId = r.seriesId ?? mapping.seriesId;
    const episodes = r.episodes ?? [];
    const rejections = r.rejections ?? [];
    const mappingValid = seriesId > 0 && episodes.length > 0 && hasManualImportQuality(r.quality);
    const episodeValidation = await validateSonarrEpisodeIds(
      client,
      { ...mapping, seriesId },
      override.episodeIds !== undefined,
      episodeCache,
      ctx,
    );
    const upgradeAssessment = mappingValid && episodeValidation.ok !== false
      ? await assessSonarrUpgrade(client, candidate, r, seriesId, episodes, rejections, episodeCache, fileCache, releaseContext, profileCache, ctx)
      : null;
    previews.push({
      candidateId: candidate.id,
      name: candidate.name ?? null,
      path: candidate.path,
      canPreview: true,
      mappingRequired: false,
      // Effective identity, resolved from the effective id — never the
      // original candidate's title under an overridden id.
      series: await sonarrEffectiveSeries(client, seriesId, candidate, seriesCache, ctx),
      seasonNumber: r.seasonNumber ?? null,
      episodes: episodes.map((e) => ({
        id: e.id,
        seasonNumber: e.seasonNumber ?? null,
        episodeNumber: e.episodeNumber ?? null,
        title: e.title ?? null,
      })),
      episodeFileId: candidate.episodeFileId ?? null,
      quality: r.quality ?? null,
      languages: r.languages ?? [],
      releaseGroup: r.releaseGroup ?? null,
      indexerFlags: r.indexerFlags ?? 0,
      releaseType: r.releaseType ?? null,
      customFormatScore: r.customFormatScore ?? null,
      rejections: rejections.map((rej) => ({ reason: rej.reason, type: rej.type ?? null })),
      mappingValid,
      // Sonarr's reprocess returns no episodes when the caller cleared them
      // (a parent override with no replacement selection): the mapping is
      // incomplete and execute will refuse until episodes are supplied.
      episodesRequired: episodes.length === 0,
      episodeValidation,
      // Transparency: which inherited children a parent override invalidated.
      mappingOverridesApplied: {
        seriesId: override.seriesId ?? null,
        seasonNumber: override.seasonNumber ?? null,
        episodeIds: override.episodeIds ?? null,
        seriesChanged: mapping.seriesChanged,
        seasonChanged: mapping.seasonChanged,
        clearedSeasonNumber: mapping.seriesChanged && override.seasonNumber === undefined,
        clearedEpisodeIds: (mapping.seriesChanged || mapping.seasonChanged) && override.episodeIds === undefined,
      },
      canExecuteWithoutOverride: mappingValid && rejections.length === 0 && episodeValidation.ok !== false,
      upgradeAssessment,
    });
  }

  for (const { candidate, override } of unmapped) {
    previews.push(mappingRequiredEntry(candidate.id, candidate.name ?? null, candidate.path, ["seriesId"]));
  }

  return {
    verifyBeforeActing: SONARR_VERIFY_DIRECTIVE,
    downloadId,
    count: previews.length,
    items: previews,
    notes: [
      "Sonarr's mapping is a proposal, not ground truth — see verifyBeforeActing.",
      "A seriesId override clears the inherited seasonNumber and episodes, and a seasonNumber override clears the inherited episodes (native Interactive Import behavior). episodeIds are validated against GET /api/v3/episode?seriesId=&seasonNumber= and must belong to the EFFECTIVE series and season — an inherited season that no parent change cleared is the effective one, so episodeIds alone are enough; supply seasonNumber only when a parent override cleared it.",
    ],
    guidance: manualImportGuidance("sonarr", downloadId),
  };
}

async function executeSonarrManualImport(client: SonarrClient, args: unknown) {
  const { downloadId, items, importMode } = parseManualImportArgs(args, "sonarr");

  // Always re-discover from the native endpoint — never trust an earlier
  // preview's data, and never accept a caller-supplied path.
  const candidates = await client.getManualImportCandidates({ downloadId });
  if (candidates.length === 0) {
    throw new Error(
      `Sonarr returned no manual-import candidates for downloadId '${downloadId}'. The download is likely no longer tracked — check sonarr_get_queue.`,
    );
  }

  const resolved = resolveManualImportCandidates("Sonarr", candidates, items);

  // Fail cleanly BEFORE any native request when a candidate has no valid
  // series mapping: Sonarr's reprocess service resolves seriesId via
  // GetSeries and throws for 0, so an unmapped item must be reported as
  // mapping-required, never sent with a fabricated id.
  const unmapped = resolved.filter(({ candidate, override }) => sonarrEffectiveSeriesId(candidate, override) <= 0);
  if (unmapped.length > 0) {
    return jsonTextError({
      error: "Sonarr candidates selected for import have no valid series mapping; refusing to send them to the native manual-import endpoint.",
      downloadId,
      mappingRequired: unmapped.map(({ candidate }) => ({
        candidateId: candidate.id,
        name: candidate.name ?? null,
        path: candidate.path,
        mappingRequired: true,
        missing: ["seriesId"],
      })),
      guidance: [
        "1. Find the series id (sonarr_get_series / sonarr_search) and re-run sonarr_preview_manual_import with an explicit seriesId override per candidate.",
        "2. Then execute with the same overrides. A 0 seriesId is never sent to Sonarr.",
      ],
    });
  }

  // Validate every caller-supplied episode selection against native episode
  // data BEFORE anything is submitted. Sonarr's reprocess resolves episode ids
  // globally (`_episodeService.GetEpisodes(episodeIds)`) and pairs them with
  // the supplied seriesId without checking ownership, so a cross-series or
  // cross-season selection would survive reprocessing and reach the import
  // command — the native app offers no protection against it.
  const episodeCache = new Map<string, SonarrEpisodeWithFile[]>();
  const invalidSelections: Array<Record<string, unknown>> = [];
  const execCtx = standaloneContext();
  for (const { candidate, override } of resolved) {
    if (override.episodeIds === undefined) continue;
    const mapping = sonarrEffectiveMapping(candidate, override);
    const validation = await validateSonarrEpisodeIds(client, mapping, true, episodeCache, execCtx);
    if (validation.ok === false) {
      invalidSelections.push({
        candidateId: candidate.id,
        name: candidate.name ?? null,
        path: candidate.path,
        effectiveSeriesId: mapping.seriesId,
        effectiveSeasonNumber: mapping.seasonNumber,
        episodeIds: mapping.episodeIds,
        unknownEpisodeIds: validation.unknownEpisodeIds,
        seriesChanged: mapping.seriesChanged,
        seasonChanged: mapping.seasonChanged,
        reason: validation.reason,
      });
    }
  }
  if (invalidSelections.length > 0) {
    return jsonTextError({
      error: "Caller-supplied episodeIds are not episodes of the effective series/season; refusing to submit the manual import.",
      downloadId,
      invalidSelections,
      guidance: [
        "1. List the target season's real episodes: sonarr_get_episodes(seriesId, seasonNumber) — the ids Sonarr can import into are exactly those.",
        "2. Re-run sonarr_preview_manual_import with episodeIds drawn from that list. episodeIds must belong to the effective seriesId AND the effective seasonNumber.",
        "3. A seriesId override clears the inherited season and episodes, and a seasonNumber override clears the inherited episodes: when a parent change clears the season, supply the corrected seasonNumber together with the episodeIds. An inherited season that no parent change cleared stays valid — episodeIds alone are validated against it, so there is no need to repeat seasonNumber.",
      ],
    });
  }

  const payload = resolved.map(({ candidate, override }) => buildSonarrReprocessItem(candidate, override, downloadId));
  const reprocessed = await client.reprocessManualImport(payload);
  const byId = new Map(reprocessed.map((r) => [r.id, r]));

  const files: SonarrManualImportCommandFile[] = [];
  const blocked: Array<{ candidateId: number; name: string | null; rejections: ManualImportRejection[] }> = [];
  const overriddenRejections: Array<{ candidateId: number; name: string | null; rejections: ManualImportRejection[] }> = [];
  const episodeOwners = new Map<number, number>();

  for (const { candidate, override } of resolved) {
    const r = byId.get(candidate.id);
    if (!r) {
      throw new Error(
        `Candidate ${candidate.id} (${candidate.name ?? candidate.path}) disappeared during reprocessing — the download changed; re-run sonarr_get_manual_import_candidates.`,
      );
    }

    const mapping = sonarrEffectiveMapping(candidate, override);
    const seriesId = r.seriesId ?? mapping.seriesId;
    const episodes = r.episodes ?? [];
    const rejections = r.rejections ?? [];

    if (seriesId <= 0) {
      throw new Error(
        `Candidate ${candidate.id} has no valid series mapping after reprocessing. Run sonarr_preview_manual_import with an explicit seriesId (find one via sonarr_get_series) before executing.`,
      );
    }
    if (episodes.length === 0) {
      // Expected when a parent override cleared the inherited selection and no
      // replacement was supplied: Sonarr rejects with "Episodes not selected".
      throw new Error(
        `Candidate ${candidate.id} has no episode mapping after reprocessing${mapping.seasonChanged || mapping.seriesChanged ? " (the series/season override cleared the inherited episodes, and Sonarr's reprocess returned no replacement selection)" : ""}. Run sonarr_get_episodes(seriesId, seasonNumber) to list the real episodes, then sonarr_preview_manual_import with explicit episodeIds for that series and season before executing.`,
      );
    }
    if (!hasManualImportQuality(r.quality)) {
      throw new Error(
        `Candidate ${candidate.id} has no quality determined by Sonarr after reprocessing; the native import decision cannot proceed.`,
      );
    }

    // Native UI safeguard: each episode is mapped to a single file.
    for (const e of episodes) {
      const owner = episodeOwners.get(e.id);
      if (owner !== undefined && owner !== candidate.id) {
        throw new Error(
          `Episode ${e.id} is mapped to both candidate ${owner} and candidate ${candidate.id}. Sonarr's Interactive Import maps each episode to exactly one file — adjust episodeIds so the selections do not overlap.`,
        );
      }
      episodeOwners.set(e.id, candidate.id);
    }

    // Rejection bypass is authorized per candidate: a multi-file release may
    // contain files the caller intends to force-import alongside files they
    // do NOT intend to import despite their rejections.
    if (rejections.length > 0 && override.allowRejected !== true) {
      blocked.push({ candidateId: candidate.id, name: candidate.name ?? null, rejections });
      continue;
    }
    if (rejections.length > 0) {
      overriddenRejections.push({ candidateId: candidate.id, name: candidate.name ?? null, rejections });
    }

    files.push({
      path: r.path,
      folderName: candidate.folderName,
      seriesId,
      episodeIds: episodes.map((e) => e.id),
      episodeFileId: candidate.episodeFileId ?? null,
      quality: r.quality as ManualImportQuality,
      languages: r.languages ?? [],
      releaseGroup: r.releaseGroup ?? null,
      indexerFlags: r.indexerFlags ?? 0,
      releaseType: r.releaseType ?? null,
      downloadId: r.downloadId ?? downloadId,
    });
  }

  if (blocked.length > 0) {
    return jsonTextError({
      error: "Sonarr reports import rejections for candidates whose item-level allowRejected is false; execution refused.",
      downloadId,
      blocked,
      guidance: [
        "1. Correct the mapping and preview again: sonarr_preview_manual_import with seriesId/seasonNumber/episodeIds overrides.",
        "2. Or, after reviewing each rejection above, set allowRejected=true on exactly the item(s) you intend to import despite their rejections (this is the purpose of manual/interactive import). Candidates you leave at allowRejected=false stay blocked, and the whole command is refused while any blocked candidate remains.",
      ],
    });
  }

  const command = await client.executeManualImport(files, importMode);

  return jsonText({
    commandId: command.id,
    status: "queued",
    importMode,
    downloadId,
    files: files.map((f) => ({
      path: f.path,
      seriesId: f.seriesId,
      episodeIds: f.episodeIds,
      episodeFileId: f.episodeFileId ?? null,
      quality: f.quality,
      languages: f.languages,
      releaseGroup: f.releaseGroup ?? null,
      releaseType: f.releaseType ?? null,
    })),
    overriddenRejections,
    message:
      "Sonarr accepted the ManualImport command and queued it. The import runs asynchronously and is NOT guaranteed to succeed — do not treat this as completed. Re-check sonarr_get_queue to see whether the queue entry cleared or still needs attention. The queue item is intentionally left in place.",
  });
}

// --- Radarr -----------------------------------------------------------------

/**
 * Radarr's reprocess service resolves the movie via `movieService.GetMovie`
 * and throws for a missing id, so an unmapped candidate must never be sent to
 * POST /manualimport with a fabricated 0.
 */
function radarrEffectiveMovieId(candidate: RadarrManualImportCandidate, override: ManualImportOverrideItem): number {
  return override.movieId ?? candidate.movie?.id ?? 0;
}

/**
 * Effective movie identity for a preview: Radarr's reprocess echoes the
 * request item (which carries `movieId`, not a `movie` object), so an
 * overridden id must never be paired with the ORIGINAL candidate's title —
 * the same stale-metadata class the Sonarr series lookup fixes. The effective
 * movie is fetched from `GET /api/v3/movie/{id}`; a failed lookup reports
 * null metadata rather than the candidate's stale title.
 */
async function radarrEffectiveMovie(
  client: RadarrClient,
  movieId: number,
  candidate: RadarrManualImportCandidate,
  reprocessed: RadarrManualImportCandidate,
  cache: Map<number, { id: number; title: string | null; year: number | null }>,
  ctx: PreviewExecutionContext,
): Promise<{ id: number; title: string | null; year: number | null }> {
  if (movieId <= 0) return { id: movieId, title: null, year: null };

  if (reprocessed.movie?.id === movieId && reprocessed.movie) {
    return { id: movieId, title: reprocessed.movie.title ?? null, year: reprocessed.movie.year ?? null };
  }
  if (movieId === (candidate.movie?.id ?? 0) && candidate.movie) {
    return { id: movieId, title: candidate.movie.title ?? null, year: candidate.movie.year ?? null };
  }

  const cached = cache.get(movieId);
  if (cached) return cached;

  let resolved: { id: number; title: string | null; year: number | null };
  try {
    const movie = await client.getMovieById(movieId, ctx.signal);
    resolved = { id: movieId, title: movie?.title ?? null, year: movie?.year ?? null };
  } catch (error) {
    rethrowIfOperationAborted(ctx.signal);
    if (error instanceof ArrRequestTimeoutError) throw error;
    resolved = { id: movieId, title: null, year: null };
  }
  cache.set(movieId, resolved);
  return resolved;
}

function buildRadarrReprocessItem(
  candidate: RadarrManualImportCandidate,
  override: ManualImportOverrideItem,
  downloadId: string,
): RadarrManualImportReprocessItem {
  return {
    id: candidate.id,
    path: candidate.path,
    movieId: radarrEffectiveMovieId(candidate, override),
    quality: candidate.quality ?? null,
    languages: candidate.languages ?? [],
    releaseGroup: override.releaseGroup ?? candidate.releaseGroup ?? null,
    indexerFlags: candidate.indexerFlags ?? 0,
    downloadId: candidate.downloadId ?? downloadId,
  };
}

async function previewRadarrManualImport(client: RadarrClient, args: unknown, ctx: PreviewExecutionContext) {
  const { downloadId, items } = parseManualImportArgs(args, "radarr");
  const a = (args ?? {}) as ManualImportToolArgs;

  ctx.setStage("discovering-candidates");
  const candidates = await client.getManualImportCandidates({
    downloadId,
    movieId: a.movieId,
    filterExistingFiles: a.filterExistingFiles,
  }, ctx.signal);
  if (candidates.length === 0) {
    throw new Error(
      `Radarr returned no manual-import candidates for downloadId '${downloadId}'. The download is likely no longer tracked — check radarr_get_queue.`,
    );
  }

  const resolved = resolveManualImportCandidates("Radarr", candidates, items);
  const previewable = resolved.filter(({ candidate, override }) => radarrEffectiveMovieId(candidate, override) > 0);
  const unmapped = resolved.filter(({ candidate, override }) => radarrEffectiveMovieId(candidate, override) <= 0);

  ctx.setStage("native-reprocess");
  const reprocessed = previewable.length > 0
    ? await client.reprocessManualImport(previewable.map(({ candidate, override }) => buildRadarrReprocessItem(candidate, override, downloadId)), ctx.signal)
    : [];
  const byId = new Map(reprocessed.map((r) => [r.id, r]));

  ctx.setStage("resolving-related-data");
  const movieCache = new Map<number, { id: number; title: string | null; year: number | null }>();
  const previews: Array<Record<string, unknown>> = [];
  for (const { candidate, override } of previewable) {
    const r = byId.get(candidate.id);
    if (!r) {
      throw new Error(
        `Radarr did not return candidate ${candidate.id} after reprocessing; the candidate changed — re-run radarr_get_manual_import_candidates.`,
      );
    }
    const movieId = r.movie?.id ?? radarrEffectiveMovieId(candidate, override);
    const rejections = r.rejections ?? [];
    const mappingValid = movieId > 0 && hasManualImportQuality(r.quality);
    previews.push({
      candidateId: candidate.id,
      name: candidate.name ?? null,
      path: candidate.path,
      canPreview: true,
      mappingRequired: false,
      // Effective identity, resolved from the effective id — never the
      // original candidate's title under an overridden id.
      movie: movieId > 0 ? await radarrEffectiveMovie(client, movieId, candidate, r, movieCache, ctx) : null,
      movieFileId: candidate.movieFileId ?? null,
      quality: r.quality ?? null,
      languages: r.languages ?? [],
      releaseGroup: r.releaseGroup ?? null,
      indexerFlags: r.indexerFlags ?? 0,
      customFormatScore: r.customFormatScore ?? null,
      rejections: rejections.map((rej) => ({ reason: rej.reason, type: rej.type ?? null })),
      mappingValid,
      canExecuteWithoutOverride: mappingValid && rejections.length === 0,
    });
  }

  for (const { candidate } of unmapped) {
    previews.push(mappingRequiredEntry(candidate.id, candidate.name ?? null, candidate.path, ["movieId"]));
  }

  return {
    verifyBeforeActing: RADARR_VERIFY_DIRECTIVE,
    downloadId,
    count: previews.length,
    items: previews,
    guidance: manualImportGuidance("radarr", downloadId),
  };
}

async function executeRadarrManualImport(client: RadarrClient, args: unknown) {
  const { downloadId, items, importMode } = parseManualImportArgs(args, "radarr");

  const candidates = await client.getManualImportCandidates({ downloadId });
  if (candidates.length === 0) {
    throw new Error(
      `Radarr returned no manual-import candidates for downloadId '${downloadId}'. The download is likely no longer tracked — check radarr_get_queue.`,
    );
  }

  const resolved = resolveManualImportCandidates("Radarr", candidates, items);

  // Fail cleanly BEFORE any native request when a candidate has no valid
  // movie mapping: Radarr's reprocess service resolves movieId via GetMovie
  // and throws for 0.
  const unmapped = resolved.filter(({ candidate, override }) => radarrEffectiveMovieId(candidate, override) <= 0);
  if (unmapped.length > 0) {
    return jsonTextError({
      error: "Radarr candidates selected for import have no valid movie mapping; refusing to send them to the native manual-import endpoint.",
      downloadId,
      mappingRequired: unmapped.map(({ candidate }) => ({
        candidateId: candidate.id,
        name: candidate.name ?? null,
        path: candidate.path,
        mappingRequired: true,
        missing: ["movieId"],
      })),
      guidance: [
        "1. Find the movie id (radarr_get_movies / radarr_search) and re-run radarr_preview_manual_import with an explicit movieId override per candidate.",
        "2. Then execute with the same overrides. A 0 movieId is never sent to Radarr.",
      ],
    });
  }

  const payload = resolved.map(({ candidate, override }) => buildRadarrReprocessItem(candidate, override, downloadId));
  const reprocessed = await client.reprocessManualImport(payload);
  const byId = new Map(reprocessed.map((r) => [r.id, r]));

  const files: RadarrManualImportCommandFile[] = [];
  const blocked: Array<{ candidateId: number; name: string | null; rejections: ManualImportRejection[] }> = [];
  const overriddenRejections: Array<{ candidateId: number; name: string | null; rejections: ManualImportRejection[] }> = [];

  for (const { candidate, override } of resolved) {
    const r = byId.get(candidate.id);
    if (!r) {
      throw new Error(
        `Candidate ${candidate.id} (${candidate.name ?? candidate.path}) disappeared during reprocessing — the download changed; re-run radarr_get_manual_import_candidates.`,
      );
    }

    const movieId = r.movie?.id ?? radarrEffectiveMovieId(candidate, override);
    const rejections = r.rejections ?? [];

    if (movieId <= 0) {
      throw new Error(
        `Candidate ${candidate.id} has no valid movie mapping after reprocessing. Run radarr_preview_manual_import with an explicit movieId (find one via radarr_get_movies) before executing.`,
      );
    }
    if (!hasManualImportQuality(r.quality)) {
      throw new Error(
        `Candidate ${candidate.id} has no quality determined by Radarr after reprocessing; the native import decision cannot proceed.`,
      );
    }

    // Rejection bypass is authorized per candidate (see Sonarr).
    if (rejections.length > 0 && override.allowRejected !== true) {
      blocked.push({ candidateId: candidate.id, name: candidate.name ?? null, rejections });
      continue;
    }
    if (rejections.length > 0) {
      overriddenRejections.push({ candidateId: candidate.id, name: candidate.name ?? null, rejections });
    }

    files.push({
      path: r.path,
      folderName: candidate.folderName,
      movieId,
      quality: r.quality as ManualImportQuality,
      languages: r.languages ?? [],
      releaseGroup: r.releaseGroup ?? null,
      indexerFlags: r.indexerFlags ?? 0,
      downloadId: r.downloadId ?? downloadId,
    });
  }

  if (blocked.length > 0) {
    return jsonTextError({
      error: "Radarr reports import rejections for candidates whose item-level allowRejected is false; execution refused.",
      downloadId,
      blocked,
      guidance: [
        "1. Correct the mapping and preview again: radarr_preview_manual_import with a movieId override.",
        "2. Or, after reviewing each rejection above, set allowRejected=true on exactly the item(s) you intend to import despite their rejections (this is the purpose of manual/interactive import). Candidates you leave at allowRejected=false stay blocked, and the whole command is refused while any blocked candidate remains.",
      ],
    });
  }

  const command = await client.executeManualImport(files, importMode);

  return jsonText({
    commandId: command.id,
    status: "queued",
    importMode,
    downloadId,
    files: files.map((f) => ({
      path: f.path,
      movieId: f.movieId,
      quality: f.quality,
      languages: f.languages,
      releaseGroup: f.releaseGroup ?? null,
    })),
    overriddenRejections,
    message:
      "Radarr accepted the ManualImport command and queued it. The import runs asynchronously and is NOT guaranteed to succeed — do not treat this as completed. Re-check radarr_get_queue to see whether the queue entry cleared or still needs attention. The queue item is intentionally left in place.",
  });
}

// --- Lidarr -----------------------------------------------------------------
//
// Lidarr's manual-import workflow differs materially from Sonarr/Radarr:
// POST /api/v1/manualimport (UpdateItems) re-runs the native import decision
// with artist/album/release overrides and RECOMPUTES the track mapping,
// quality and rejections server-side; caller-sent trackIds are ignored by the
// backend. The final ManualImport command consumes the reprocessed result.

/**
 * The Lidarr mapping is a hierarchy: artist → album → album release → tracks.
 *
 * Native Interactive Import clears the dependents when a parent is reselected
 * (frontend/src/InteractiveImport/{Artist,Album,AlbumRelease}/*Connector.js):
 *
 *   onArtistSelect      → { album: undefined, albumReleaseId: undefined, tracks: [] }
 *   onAlbumSelect       → { albumReleaseId: undefined, tracks: [] }
 *   onAlbumReleaseSelect→ { albumReleaseId, disableReleaseSwitching: true, tracks: [] }
 *
 * The MCP layer must do the same, because the native reprocess does NOT
 * validate the pairing: `ManualImportController.UpdateImportItems` maps the
 * supplied ids straight into `IdentificationOverrides { Artist, Album,
 * AlbumRelease }`, and `CandidateService.GetDbCandidatesFromTags` resolves
 * them with precedence AlbumRelease > Album > Artist — a forced release wins
 * and its own album is used, so an inherited child id sent under a new parent
 * id is accepted and imported, not rejected.
 *
 * A cleared child is sent as null, which is native-valid: the controller
 * leaves the override null and `ManualImportService.UpdateItems` re-identifies
 * the entity from the files (tracks are always recomputed server-side — the
 * controller drops the resource's Tracks/TrackIds when building the item).
 */
interface LidarrEffectiveMapping {
  artistId: number;
  albumId: number;
  albumReleaseId: number;
  artistChanged: boolean;
  albumChanged: boolean;
  releaseChanged: boolean;
}

function lidarrEffectiveMapping(
  candidate: LidarrManualImportCandidate,
  override: ManualImportOverrideItem,
): LidarrEffectiveMapping {
  const originalArtistId = candidate.artist?.id ?? 0;
  const originalAlbumId = candidate.album?.id ?? 0;
  const originalAlbumReleaseId = candidate.albumReleaseId ?? 0;

  const artistChanged = override.artistId !== undefined && override.artistId !== originalArtistId;
  const albumChanged = override.albumId !== undefined && override.albumId !== originalAlbumId;
  const releaseChanged = override.albumReleaseId !== undefined && override.albumReleaseId !== originalAlbumReleaseId;

  return {
    artistId: override.artistId ?? originalArtistId,
    // A parent change clears its descendants (native UI semantics); an
    // explicit child override is kept and validated against the new parent.
    albumId: override.albumId !== undefined
      ? override.albumId
      : artistChanged ? 0 : originalAlbumId,
    albumReleaseId: override.albumReleaseId !== undefined
      ? override.albumReleaseId
      : artistChanged || albumChanged ? 0 : originalAlbumReleaseId,
    artistChanged,
    albumChanged,
    releaseChanged,
  };
}

/**
 * Native UI semantics for `disableReleaseSwitching`: selecting an album
 * release explicitly sets it to `true` (SelectAlbumReleaseModalContentConnector
 * — `disableReleaseSwitching: true`), and `ManualImportService.Execute` turns
 * it into a persistent album change (`album.AnyReleaseOk = false`), which is
 * why the native UI warns that overriding a release disables automatic
 * release selection. The MCP reproduces that default: an explicit
 * `albumReleaseId` implies `true`; a caller who wants to keep the album's
 * automatic release selection can set it to `false` explicitly.
 */
function lidarrEffectiveDisableReleaseSwitching(
  candidate: LidarrManualImportCandidate,
  override: ManualImportOverrideItem,
): boolean {
  if (override.disableReleaseSwitching !== undefined) return override.disableReleaseSwitching;
  if (override.albumReleaseId !== undefined) return true;
  return candidate.disableReleaseSwitching ?? false;
}

function buildLidarrUpdateItem(
  candidate: LidarrManualImportCandidate,
  override: ManualImportOverrideItem,
  downloadId: string,
  replaceExistingFiles: boolean,
): LidarrManualImportUpdateItem {
  const mapping = lidarrEffectiveMapping(candidate, override);
  return {
    id: candidate.id,
    path: candidate.path,
    name: candidate.name ?? undefined,
    // Lidarr looks these ids up natively (GetArtist/GetAlbum/GetRelease);
    // sending 0 would throw, so omit unknown entities entirely. A cleared
    // child is null, which the controller maps to a null override so the
    // backend re-identifies it from the files.
    artistId: mapping.artistId > 0 ? mapping.artistId : null,
    albumId: mapping.albumId > 0 ? mapping.albumId : null,
    albumReleaseId: mapping.albumReleaseId > 0 ? mapping.albumReleaseId : null,
    // NOTE: the native ManualImportUpdateResource declares TrackIds, but
    // UpdateImportItems drops Tracks/TrackIds when building the
    // ManualImportItem — Lidarr recomputes tracks server-side. Caller track
    // corrections are applied to the final command (validated via getTracks),
    // not here.
    quality: candidate.quality ?? null,
    releaseGroup: candidate.releaseGroup ?? null,
    indexerFlags: candidate.indexerFlags ?? 0,
    downloadId: candidate.downloadId ?? downloadId,
    additionalFile: candidate.additionalFile ?? false,
    replaceExistingFiles,
    disableReleaseSwitching: lidarrEffectiveDisableReleaseSwitching(candidate, override),
  };
}

/**
 * Structural parent/child dependency violations: a child override supplied
 * when its parent is not (or is no longer) in the mapping. Mirrors the native
 * UI, where the album picker only opens for an artist and the release/track
 * pickers only open for an album/release.
 */
function lidarrDependencyProblems(
  mapping: LidarrEffectiveMapping,
  override: ManualImportOverrideItem,
): string[] {
  const problems: string[] = [];
  if (override.albumId !== undefined && mapping.artistId <= 0) {
    problems.push(`albumId ${mapping.albumId} supplied with no effective artistId — supply the artistId the album belongs to`);
  }
  if (override.albumReleaseId !== undefined && mapping.albumId <= 0) {
    problems.push(`albumReleaseId ${mapping.albumReleaseId} supplied with no effective albumId${mapping.artistChanged ? " (the artist override cleared the inherited album)" : ""} — supply the albumId the release belongs to`);
  }
  if (override.trackIds !== undefined && override.trackIds.length > 0 && mapping.albumReleaseId <= 0) {
    problems.push(`trackIds supplied with no effective albumReleaseId${mapping.artistChanged || mapping.albumChanged ? " (a parent override cleared the inherited release)" : ""} — supply the albumReleaseId the tracks belong to`);
  }
  return problems;
}

/**
 * The album resource (GET /api/v1/album/{id}) is the native source for BOTH
 * relationships: `artistId` (album→artist) and the embedded `releases` array
 * (release→album). Note `GET /api/v1/release?albumId=` is the indexer
 * release-SEARCH endpoint (guid/quality/age results), not the album's own
 * releases — the native release picker reads the album's embedded releases.
 */
interface LidarrAlbumIdentity {
  id: number;
  artistId: number;
  releases: Array<{ id: number; albumId: number }>;
}

async function getLidarrAlbumIdentity(
  client: LidarrClient,
  albumId: number,
  cache: Map<number, LidarrAlbumIdentity | null>,
  ctx: PreviewExecutionContext,
): Promise<LidarrAlbumIdentity | null> {
  if (cache.has(albumId)) return cache.get(albumId) ?? null;
  let resolved: LidarrAlbumIdentity | null;
  try {
    const album = await client.getAlbumById(albumId, ctx.signal);
    resolved = album && album.id > 0
      ? { id: album.id, artistId: album.artistId, releases: album.releases ?? [] }
      : null;
  } catch (error) {
    rethrowIfOperationAborted(ctx.signal);
    if (error instanceof ArrRequestTimeoutError) throw error;
    resolved = null;
  }
  cache.set(albumId, resolved);
  return resolved;
}

/**
 * Validate the identity relationships an explicit override can break:
 *
 *   album belongs to artist        (GET /album/{id} → artistId)
 *   album release belongs to album (GET /album/{id} → releases[].albumId)
 *
 * Only explicitly supplied ids are checked — an inherited id came from the
 * native candidate's own mapping and is coherent by construction. The
 * trackIds → release check lives in resolveLidarrTrackIds (release-scoped).
 * A failed lookup is reported as unverifiable, never as a pass.
 */
async function validateLidarrRelationships(
  client: LidarrClient,
  mapping: LidarrEffectiveMapping,
  override: ManualImportOverrideItem,
  albumCache: Map<number, LidarrAlbumIdentity | null>,
  ctx: PreviewExecutionContext,
): Promise<{ checked: boolean; ok: boolean; problems: string[] }> {
  const problems: string[] = [];
  const checked = override.albumId !== undefined || override.albumReleaseId !== undefined;
  if (!checked) return { checked: false, ok: true, problems: [] };

  if ((override.albumId !== undefined || override.albumReleaseId !== undefined) && mapping.albumId > 0) {
    const album = await getLidarrAlbumIdentity(client, mapping.albumId, albumCache, ctx);
    if (!album) {
      problems.push(`album ${mapping.albumId} could not be fetched from Lidarr; its artist and release membership are unverifiable`);
    } else {
      if (override.albumId !== undefined && mapping.artistId > 0 && album.artistId !== mapping.artistId) {
        problems.push(`album ${mapping.albumId} belongs to artist ${album.artistId}, not the effective artist ${mapping.artistId}`);
      }
      if (override.albumReleaseId !== undefined && !album.releases.some((r) => r.id === mapping.albumReleaseId && r.albumId === mapping.albumId)) {
        problems.push(`album release ${mapping.albumReleaseId} is not a release of album ${mapping.albumId}`);
      }
    }
  }

  return { checked: true, ok: problems.length === 0, problems };
}

/**
 * Decide the track ids a candidate will import with.
 *
 * Lidarr's reprocess recomputes tracks server-side, so a caller-corrected
 * mapping (the primary reason this feature exists — e.g. Lidarr guessed
 * Track 6, the agent determined Track 7) must survive reprocessing and reach
 * the final ManualImport command.
 *
 * An explicit override is validated STRICTLY against the selected album
 * release's track list (`GET /track?albumReleaseId=…` → GetTracksByRelease),
 * mirroring the native Interactive Import track selector, which only offers
 * the selectable tracks of the chosen release. Tracks from other releases of
 * the same album, from other albums, or from the candidate's current mapping
 * are NOT authorization targets: the allowlist is the release query, never a
 * union. If the reprocessed candidate contains tracks outside that release
 * query, the inconsistency is surfaced (releaseTrackMismatch) rather than
 * widening what the caller may select.
 */
async function resolveLidarrTrackIds(
  client: LidarrClient,
  reprocessed: LidarrManualImportCandidate,
  override: ManualImportOverrideItem,
  releaseTrackCache: Map<number, LidarrTrack[]>,
  ctx: PreviewExecutionContext,
): Promise<{
  trackIds: number[];
  source: "caller-override" | "lidarr-recomputed";
  tracks: LidarrTrack[];
  releaseTrackMismatch: number[];
}> {
  const recomputed = reprocessed.tracks ?? [];
  if (!override.trackIds || override.trackIds.length === 0) {
    return { trackIds: recomputed.map((t) => t.id), source: "lidarr-recomputed", tracks: recomputed, releaseTrackMismatch: [] };
  }

  const albumReleaseId = reprocessed.albumReleaseId ?? 0;
  if (albumReleaseId <= 0) {
    throw new Error(
      `Candidate ${reprocessed.id} supplied trackIds without a resolvable album release; run lidarr_preview_manual_import with an explicit albumReleaseId (from the album's releases) first.`,
    );
  }
  let releaseTracks = releaseTrackCache.get(albumReleaseId);
  if (!releaseTracks) {
    releaseTracks = await client.getTracks({ albumReleaseId }, ctx.signal);
    releaseTrackCache.set(albumReleaseId, releaseTracks);
  }
  const validIds = new Set(releaseTracks.map((t) => t.id));
  const invalid = override.trackIds.filter((id) => !validIds.has(id));
  if (invalid.length > 0) {
    throw new Error(
      `Track ids ${invalid.join(", ")} are not tracks of album release ${albumReleaseId}; refusing to import tracks outside the selected release. Valid track ids for this release: ${releaseTracks.map((t) => t.id).join(", ") || "none"}.`,
    );
  }
  // Surface (do not authorize) candidate tracks that the release query does
  // not contain — a native mapping/release-list inconsistency the caller
  // should know about.
  const releaseTrackMismatch = recomputed.filter((t) => !validIds.has(t.id)).map((t) => t.id);
  return {
    trackIds: override.trackIds,
    source: "caller-override",
    tracks: override.trackIds.map((id) => releaseTracks.find((t) => t.id === id)).filter((t): t is LidarrTrack => !!t),
    releaseTrackMismatch,
  };
}

async function previewLidarrManualImport(client: LidarrClient, args: unknown, ctx: PreviewExecutionContext) {
  const { downloadId, items, replaceExistingFiles } = parseManualImportArgs(args, "lidarr");
  const a = (args ?? {}) as ManualImportToolArgs;

  ctx.setStage("discovering-candidates");
  const candidates = await client.getManualImportCandidates({
    downloadId,
    artistId: a.artistId,
    filterExistingFiles: a.filterExistingFiles,
    replaceExistingFiles,
  }, ctx.signal);
  if (candidates.length === 0) {
    throw new Error(
      `Lidarr returned no manual-import candidates for downloadId '${downloadId}'. The download is likely no longer tracked — check lidarr_get_queue.`,
    );
  }

  const resolved = resolveManualImportCandidates("Lidarr", candidates, items);

  // Validate BEFORE reprocessing, mirroring the Sonarr preview's
  // previewable/unmapped split. A nonexistent explicit albumId/albumReleaseId
  // makes native Lidarr throw inside GetAlbum/GetRelease during the update,
  // so an item whose caller-supplied ids are structurally broken is never
  // POSTed — it is returned as a diagnostic entry instead. Only explicit
  // override ids are checked; inherited ids came from Lidarr's own mapping.
  ctx.setStage("validating-mappings");
  const albumIdentityCache = new Map<number, LidarrAlbumIdentity | null>();
  const mappings: Array<{
    candidate: LidarrManualImportCandidate;
    override: ManualImportOverrideItem;
    mapping: LidarrEffectiveMapping;
    dependencyProblems: string[];
    relationshipValidation: { checked: boolean; ok: boolean; problems: string[] };
  }> = [];
  for (const { candidate, override } of resolved) {
    const mapping = lidarrEffectiveMapping(candidate, override);
    const dependencyProblems = lidarrDependencyProblems(mapping, override);
    const relationshipValidation = await validateLidarrRelationships(
      client, mapping, override, albumIdentityCache, ctx,
    );
    mappings.push({ candidate, override, mapping, dependencyProblems, relationshipValidation });
  }

  const previewable = mappings.filter(
    (m) => m.dependencyProblems.length === 0 && m.relationshipValidation.ok,
  );
  const rejected = mappings.filter(
    (m) => m.dependencyProblems.length > 0 || !m.relationshipValidation.ok,
  );

  const payload = previewable.map(({ candidate, override }) =>
    buildLidarrUpdateItem(candidate, override, downloadId, replaceExistingFiles),
  );
  ctx.setStage("native-reprocess");
  const reprocessed = payload.length > 0
    ? await client.updateManualImport(payload, ctx.signal)
    : [];
  const byId = new Map(reprocessed.map((r) => [r.id, r]));

  ctx.setStage("resolving-tracks");
  const releaseTrackCache = new Map<number, LidarrTrack[]>();
  // Keyed by candidateId, then emitted in the caller's original item order
  // below — a mixed valid/invalid request reads in the order it was sent.
  const previewById = new Map<number, Record<string, unknown>>();
  const mismatches: Array<{ candidateId: number; tracksOutsideRelease: number[] }> = [];
  for (const { candidate, override, mapping, dependencyProblems, relationshipValidation } of previewable) {
    const r = byId.get(candidate.id);
    if (!r) {
      throw new Error(
        `Lidarr did not return candidate ${candidate.id} after updating; the candidate changed — re-run lidarr_get_manual_import_candidates.`,
      );
    }
    const resolvedTracks = await resolveLidarrTrackIds(client, r, override, releaseTrackCache, ctx);
    if (resolvedTracks.releaseTrackMismatch.length > 0) {
      mismatches.push({ candidateId: candidate.id, tracksOutsideRelease: resolvedTracks.releaseTrackMismatch });
    }
    const rejections = r.rejections ?? [];
    const mappingValid =
      (r.artist?.id ?? 0) > 0 &&
      (r.album?.id ?? 0) > 0 &&
      (r.albumReleaseId ?? 0) > 0 &&
      resolvedTracks.trackIds.length > 0 &&
      hasManualImportQuality(r.quality) &&
      dependencyProblems.length === 0 &&
      relationshipValidation.ok;
    previewById.set(candidate.id, {
      candidateId: candidate.id,
      name: candidate.name ?? null,
      path: candidate.path,
      canPreview: true,
      mappingRequired: false,
      // Effective identity only: the reprocessed response's entities are
      // resolved from the ids that were sent (null children are re-identified
      // from the files), so a remap never pairs a new id with the old title.
      artist: r.artist ? { id: r.artist.id, artistName: r.artist.artistName } : null,
      album: r.album ? { id: r.album.id, title: r.album.title } : null,
      albumReleaseId: r.albumReleaseId ?? 0,
      tracks: resolvedTracks.tracks.map((t) => ({
        id: t.id,
        title: t.title ?? null,
        trackNumber: t.trackNumber ?? null,
        position: t.position ?? null,
        mediumNumber: t.mediumNumber ?? null,
      })),
      tracksSource: resolvedTracks.source,
      releaseTrackMismatch: resolvedTracks.releaseTrackMismatch,
      quality: r.quality ?? null,
      releaseGroup: r.releaseGroup ?? null,
      indexerFlags: r.indexerFlags ?? 0,
      rejections: rejections.map((rej) => ({ reason: rej.reason ?? null, type: rej.type ?? null })),
      additionalFile: r.additionalFile ?? false,
      replaceExistingFiles: r.replaceExistingFiles ?? replaceExistingFiles,
      disableReleaseSwitching: r.disableReleaseSwitching ?? false,
      // Transparency: which inherited children a parent override invalidated.
      mappingOverridesApplied: {
        artistId: override.artistId ?? null,
        albumId: override.albumId ?? null,
        albumReleaseId: override.albumReleaseId ?? null,
        trackIds: override.trackIds ?? null,
        artistChanged: mapping.artistChanged,
        albumChanged: mapping.albumChanged,
        releaseChanged: mapping.releaseChanged,
        clearedAlbum: mapping.artistChanged && override.albumId === undefined,
        clearedAlbumRelease: (mapping.artistChanged || mapping.albumChanged) && override.albumReleaseId === undefined,
        disableReleaseSwitching: lidarrEffectiveDisableReleaseSwitching(candidate, override),
      },
      dependencyProblems,
      relationshipValidation,
      mappingValid,
      canExecuteWithoutOverride: mappingValid && rejections.length === 0,
    });
  }

  // Caller-supplied ids that break the hierarchy are reported, not submitted:
  // native Lidarr would throw on GetAlbum/GetRelease before the MCP could
  // diagnose. No effective artist/album names are fabricated for these.
  for (const { candidate, override, mapping, dependencyProblems, relationshipValidation } of rejected) {
    previewById.set(candidate.id, {
      candidateId: candidate.id,
      name: candidate.name ?? null,
      path: candidate.path,
      canPreview: false,
      mappingRequired: false,
      submittedToNativeReprocess: false,
      artist: null,
      album: null,
      albumReleaseId: mapping.albumReleaseId,
      tracks: [],
      tracksSource: null,
      quality: null,
      mappingOverridesApplied: {
        artistId: override.artistId ?? null,
        albumId: override.albumId ?? null,
        albumReleaseId: override.albumReleaseId ?? null,
        trackIds: override.trackIds ?? null,
        artistChanged: mapping.artistChanged,
        albumChanged: mapping.albumChanged,
        releaseChanged: mapping.releaseChanged,
        clearedAlbum: mapping.artistChanged && override.albumId === undefined,
        clearedAlbumRelease: (mapping.artistChanged || mapping.albumChanged) && override.albumReleaseId === undefined,
        disableReleaseSwitching: lidarrEffectiveDisableReleaseSwitching(candidate, override),
      },
      dependencyProblems,
      relationshipValidation,
      mappingValid: false,
      canExecuteWithoutOverride: false,
    });
  }

  // Emit in the caller's original item order, not valid-then-invalid.
  const previews = mappings.map((m) => previewById.get(m.candidate.id)).filter((p): p is Record<string, unknown> => !!p);

  return {
    verifyBeforeActing: LIDARR_VERIFY_DIRECTIVE,
    downloadId,
    count: previews.length,
    items: previews,
    notes: [
      "Lidarr recomputes the track mapping server-side from the artist/album/release overrides; the tracks shown here are what lidarr_execute_manual_import will import.",
      "tracksSource=caller-override means your explicit trackIds were validated against the selected album release's track list (GET /track?albumReleaseId=…) and will be used as-is; tracksSource=lidarr-recomputed means Lidarr's server-side mapping is being used.",
      "The mapping is a hierarchy artist → album → album release → tracks: an artistId override clears the inherited album, release and tracks, an albumId override clears the inherited release and tracks, and an albumReleaseId override clears the inherited tracks (native Interactive Import behavior). Supply the full corrected selection below a changed parent — a cleared child is re-identified by Lidarr from the files, and execute refuses an incomplete mapping.",
      "Supplying an explicit albumReleaseId defaults disableReleaseSwitching to true (native UI behavior; it persists as album.AnyReleaseOk=false on import). Set it to false explicitly to keep the album's automatic release selection.",
      "Items whose explicit ids break the hierarchy (nonexistent album/release, child under a cleared parent) are NOT sent to the native reprocess — Lidarr would throw on the lookup before it could diagnose them. They are returned with canPreview=false, dependencyProblems and relationshipValidation; fix the ids and preview again.",
      ...(mismatches.length > 0
        ? [`Inconsistency surfaced (not authorized): Lidarr's recomputed mapping for ${mismatches.map((m) => `candidate ${m.candidateId} [tracks ${m.tracksOutsideRelease.join(", ")}]`).join("; ")} includes tracks outside the selected release's track query. The caller-override allowlist stays the release list; review the release selection if this is unexpected.`]
        : []),
    ],
    guidance: manualImportGuidance("lidarr", downloadId),
  };
}

async function executeLidarrManualImport(client: LidarrClient, args: unknown) {
  const { downloadId, items, importMode, replaceExistingFiles } = parseManualImportArgs(args, "lidarr");

  const candidates = await client.getManualImportCandidates({ downloadId, replaceExistingFiles });
  if (candidates.length === 0) {
    throw new Error(
      `Lidarr returned no manual-import candidates for downloadId '${downloadId}'. The download is likely no longer tracked — check lidarr_get_queue.`,
    );
  }

  const resolved = resolveManualImportCandidates("Lidarr", candidates, items);

  // Validate the hierarchy BEFORE anything is submitted. The native reprocess
  // resolves supplied ids straight into IdentificationOverrides with precedence
  // AlbumRelease > Album > Artist and no ownership check, so a stale child
  // inherited across a parent change — or a child supplied under a parent that
  // does not own it — would survive reprocessing and reach the import command.
  const albumIdentityCache = new Map<number, LidarrAlbumIdentity | null>();
  const invalidMappings: Array<Record<string, unknown>> = [];
  const execCtx = standaloneContext();
  for (const { candidate, override } of resolved) {
    const mapping = lidarrEffectiveMapping(candidate, override);
    const dependencyProblems = lidarrDependencyProblems(mapping, override);
    const relationshipValidation = await validateLidarrRelationships(
      client, mapping, override, albumIdentityCache, execCtx,
    );
    if (dependencyProblems.length > 0 || !relationshipValidation.ok) {
      invalidMappings.push({
        candidateId: candidate.id,
        name: candidate.name ?? null,
        path: candidate.path,
        effectiveArtistId: mapping.artistId,
        effectiveAlbumId: mapping.albumId,
        effectiveAlbumReleaseId: mapping.albumReleaseId,
        artistChanged: mapping.artistChanged,
        albumChanged: mapping.albumChanged,
        releaseChanged: mapping.releaseChanged,
        dependencyProblems,
        relationshipProblems: relationshipValidation.problems,
      });
    }
  }
  if (invalidMappings.length > 0) {
    return jsonTextError({
      error: "Caller-supplied Lidarr overrides break the artist → album → album release hierarchy; refusing to submit the manual import.",
      downloadId,
      invalidMappings,
      guidance: [
        "1. The mapping is a hierarchy: an artistId override clears the inherited album/release/tracks, an albumId override clears the inherited release/tracks, an albumReleaseId override clears the inherited tracks. Supply the full corrected selection below a changed parent.",
        "2. An explicit albumId must belong to the effective artist (lidarr_get_albums(artistId)); an explicit albumReleaseId must be a release of the effective album (GET /api/v1/album/{albumId} and that album's embedded releases[]); explicit trackIds must belong to the selected release (GET /api/v1/track?albumReleaseId=…).",
        "3. Re-run lidarr_preview_manual_import with the corrected overrides — it reports dependencyProblems and relationshipValidation per item without importing.",
      ],
    });
  }

  const payload = resolved.map(({ candidate, override }) =>
    buildLidarrUpdateItem(candidate, override, downloadId, replaceExistingFiles),
  );
  const reprocessed = await client.updateManualImport(payload);
  const byId = new Map(reprocessed.map((r) => [r.id, r]));

  const files: LidarrManualImportCommandFile[] = [];
  const blocked: Array<{ candidateId: number; name: string | null; rejections: LidarrManualImportRejection[] }> = [];
  const overriddenRejections: Array<{ candidateId: number; name: string | null; rejections: LidarrManualImportRejection[] }> = [];
  const trackOwners = new Map<number, number>();
  const releaseTrackCache = new Map<number, LidarrTrack[]>();
  const mismatches: Array<{ candidateId: number; tracksOutsideRelease: number[] }> = [];

  for (const { candidate, override } of resolved) {
    const r = byId.get(candidate.id);
    if (!r) {
      throw new Error(
        `Candidate ${candidate.id} (${candidate.name ?? candidate.path}) disappeared during reprocessing — the download changed; re-run lidarr_get_manual_import_candidates.`,
      );
    }

    const artistId = r.artist?.id ?? 0;
    const albumId = r.album?.id ?? 0;
    const albumReleaseId = r.albumReleaseId ?? 0;
    const rejections = r.rejections ?? [];

    if (artistId <= 0) {
      throw new Error(
        `Candidate ${candidate.id} has no valid artist mapping after reprocessing. Run lidarr_preview_manual_import with an explicit artistId (find one via lidarr_get_artists) before executing.`,
      );
    }
    if (albumId <= 0) {
      throw new Error(
        `Candidate ${candidate.id} has no valid album mapping after reprocessing. Run lidarr_preview_manual_import with an explicit albumId (find one via lidarr_get_albums) before executing.`,
      );
    }
    if (albumReleaseId <= 0) {
      throw new Error(
        `Candidate ${candidate.id} has no valid album release after reprocessing. Run lidarr_preview_manual_import with an explicit albumReleaseId (from the album's releases) before executing.`,
      );
    }
    // Caller track overrides survive reprocessing (validated strictly against
    // the selected album release); otherwise Lidarr's recomputed mapping is
    // used.
    const resolvedTracks = await resolveLidarrTrackIds(client, r, override, releaseTrackCache, execCtx);
    if (resolvedTracks.releaseTrackMismatch.length > 0) {
      mismatches.push({ candidateId: candidate.id, tracksOutsideRelease: resolvedTracks.releaseTrackMismatch });
    }
    if (resolvedTracks.trackIds.length === 0) {
      throw new Error(
        `Candidate ${candidate.id} has no track mapping after reprocessing; Lidarr recomputes tracks server-side from the album/release — check the preview result.`,
      );
    }
    if (!hasManualImportQuality(r.quality)) {
      throw new Error(
        `Candidate ${candidate.id} has no quality determined by Lidarr after reprocessing; the native import decision cannot proceed.`,
      );
    }

    // Native UI safeguard: each track is mapped to a single file.
    for (const id of resolvedTracks.trackIds) {
      const owner = trackOwners.get(id);
      if (owner !== undefined && owner !== candidate.id) {
        throw new Error(
          `Track ${id} is mapped to both candidate ${owner} and candidate ${candidate.id}. Lidarr's Interactive Import maps each track to exactly one file — adjust the album/release/track selection so the files do not overlap.`,
        );
      }
      trackOwners.set(id, candidate.id);
    }

    // Rejection bypass is authorized per candidate (see Sonarr).
    if (rejections.length > 0 && override.allowRejected !== true) {
      blocked.push({ candidateId: candidate.id, name: candidate.name ?? null, rejections });
      continue;
    }
    if (rejections.length > 0) {
      overriddenRejections.push({ candidateId: candidate.id, name: candidate.name ?? null, rejections });
    }

    files.push({
      path: r.path,
      artistId,
      albumId,
      albumReleaseId,
      trackIds: resolvedTracks.trackIds,
      quality: r.quality as ManualImportQuality,
      releaseGroup: r.releaseGroup ?? null,
      indexerFlags: r.indexerFlags ?? 0,
      downloadId: r.downloadId ?? downloadId,
      disableReleaseSwitching: r.disableReleaseSwitching ?? false,
    });
  }

  if (blocked.length > 0) {
    return jsonTextError({
      error: "Lidarr reports import rejections for candidates whose item-level allowRejected is false; execution refused.",
      downloadId,
      blocked,
      guidance: [
        "1. Correct the mapping and preview again: lidarr_preview_manual_import with artistId/albumId/albumReleaseId/trackIds overrides.",
        "2. Or, after reviewing each rejection above, set allowRejected=true on exactly the item(s) you intend to import despite their rejections (this is the purpose of manual/interactive import). Candidates you leave at allowRejected=false stay blocked, and the whole command is refused while any blocked candidate remains.",
      ],
    });
  }

  const command = await client.executeManualImport(files, importMode, replaceExistingFiles);

  return jsonText({
    commandId: command.id,
    status: "queued",
    importMode,
    replaceExistingFiles,
    downloadId,
    files: files.map((f) => ({
      path: f.path,
      artistId: f.artistId,
      albumId: f.albumId,
      albumReleaseId: f.albumReleaseId,
      trackIds: f.trackIds,
      quality: f.quality,
      releaseGroup: f.releaseGroup ?? null,
      disableReleaseSwitching: f.disableReleaseSwitching ?? false,
    })),
    overriddenRejections,
    ...(mismatches.length > 0
      ? {
          notes: [
            `Inconsistency surfaced: Lidarr's recomputed mapping for ${mismatches.map((m) => `candidate ${m.candidateId} [tracks ${m.tracksOutsideRelease.join(", ")}]`).join("; ")} includes tracks outside the selected release's track query. The import used the validated caller override; review the release selection if this is unexpected.`,
          ],
        }
      : {}),
    message:
      "Lidarr accepted the ManualImport command and queued it. The import runs asynchronously and is NOT guaranteed to succeed — do not treat this as completed. Re-check lidarr_get_queue to see whether the queue entry cleared or still needs attention. The queue item is intentionally left in place.",
  });
}

// --- Preview operation registry (soft-budget fast path + async handle) -----

/**
 * Deterministic fingerprint of a preview request: service, downloadId, the
 * normalized items (caller order preserved — it is semantically part of the
 * request), mapping overrides, and the preview-affecting discovery flags. Used
 * only to deduplicate an identical preview that is ALREADY running; terminal
 * results are never reused as a cache, so a re-run always re-fetches native
 * state.
 */
function previewFingerprint(service: "sonarr" | "radarr" | "lidarr", args: unknown): string {
  const a = (args ?? {}) as ManualImportToolArgs & Record<string, unknown>;
  const rawItems = Array.isArray(a.items) ? a.items : [];
  const items = rawItems.map((it) => {
    const o: Record<string, unknown> = { candidateId: it.candidateId };
    for (const k of [
      "seriesId", "seasonNumber", "episodeIds", "movieId", "artistId",
      "albumId", "albumReleaseId", "trackIds", "disableReleaseSwitching",
      "releaseGroup", "allowRejected",
    ] as const) {
      if (it[k] !== undefined) o[k] = it[k];
    }
    return o;
  });
  const norm: Record<string, unknown> = {
    service,
    downloadId: typeof a.downloadId === "string" ? a.downloadId.trim() : a.downloadId,
    items,
    replaceExistingFiles: a.replaceExistingFiles === true,
  };
  for (const k of ["seriesId", "seasonNumber", "movieId", "artistId", "filterExistingFiles"] as const) {
    if (a[k] !== undefined) norm[k] = a[k];
  }
  return JSON.stringify(norm);
}

function runningHandle(op: PreviewOperation, deduplicated: boolean) {
  const handle: Record<string, unknown> = {
    status: "running",
    operationId: op.id,
    operation: op.kind,
    stage: op.stage ?? "starting",
    startedAt: new Date(op.startedAt).toISOString(),
    hardTimeoutAt: new Date(op.deadlineAt).toISOString(),
    elapsedMs: Date.now() - op.startedAt,
    pollAfterMs: operationPollIntervalMs(),
    guidance: `The ${kindLabel(op.kind)} is still running in the app. Poll arr_get_operation with this operationId at the indicated interval instead of starting another identical preview.`,
  };
  if (deduplicated) handle.deduplicated = true;
  return handle;
}

/**
 * Run a preview with a soft synchronous response budget. Fast previews return
 * the exact normal preview result (unchanged shape, no wrapper). A preview
 * still running when the budget expires returns a pollable handle; the work
 * continues in the module-level registry, independent of this MCP request.
 */
async function runPreviewTool<C>(
  kind: PreviewOperationKind,
  service: "sonarr" | "radarr" | "lidarr",
  client: C,
  args: unknown,
  executor: (client: C, args: unknown, ctx: PreviewExecutionContext) => Promise<unknown>,
): Promise<ReturnType<typeof jsonText> | ReturnType<typeof textError>> {
  const fingerprint = previewFingerprint(service, args);
  const existing = previewOperations.findRunning(fingerprint);
  if (existing) {
    return jsonText(runningHandle(existing, true));
  }

  const op = previewOperations.start(kind, fingerprint, (ctx) => executor(client, args, ctx));
  const settled = await previewOperations.awaitWithBudget(op, previewSyncBudgetMs());

  if (settled.status === "running") {
    return jsonText(runningHandle(settled, false));
  }
  if (settled.status === "completed") {
    return jsonText(settled.result);
  }
  if (settled.status === "failed") {
    return textError(`Error: ${settled.error}`);
  }
  // timed_out / cancelled reached within the synchronous budget (rare).
  return jsonText({
    status: settled.status,
    operationId: settled.id,
    operation: settled.kind,
    error: settled.error ?? null,
  });
}

function operationPollView(op: PreviewOperation) {
  const base = { operationId: op.id, status: op.status, operation: op.kind };
  if (op.status === "running") {
    return {
      ...base,
      stage: op.stage ?? "starting",
      elapsedMs: Date.now() - op.startedAt,
      pollAfterMs: operationPollIntervalMs(),
    };
  }
  if (op.status === "completed") {
    return { ...base, result: op.result };
  }
  if (op.status === "failed") {
    return { ...base, error: op.error ?? null };
  }
  if (op.status === "timed_out") {
    return {
      ...base,
      stage: op.stage ?? null,
      elapsedMs: (op.completedAt ?? Date.now()) - op.startedAt,
      error: op.error ?? "preview exceeded the configured operation timeout.",
    };
  }
  return { ...base };
}

// Registers the MCP request handlers on a server instance. Called by
// buildServer() for every server created (one per HTTP request, plus the
// module-level stdio instance).
function registerHandlers(server: Server): void {
// Handle list tools request
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "search": {
        const query = (args as { query: string }).query;
        const results = await runUnifiedSearch(query);
        return jsonText({ results });
      }

      case "fetch": {
        const id = (args as { id: string }).id;
        const result = await fetchSearchEntry(id);
        return jsonText(result);
      }

      case "arr_get_operation": {
        const operationId = (args as { operationId?: string })?.operationId;
        if (typeof operationId !== "string" || operationId.trim() === "") {
          throw new Error("operationId is required (from a *_preview_manual_import running handle).");
        }
        const op = previewOperations.get(operationId.trim());
        if (!op) {
          return jsonText({
            status: "expired-or-unknown",
            operationId,
            guidance: "This operation is no longer available (completed and expired, cancelled, or never existed). Run the preview again.",
          });
        }
        return jsonText(operationPollView(op));
      }

      case "arr_cancel_operation": {
        const operationId = (args as { operationId?: string })?.operationId;
        if (typeof operationId !== "string" || operationId.trim() === "") {
          throw new Error("operationId is required (from a *_preview_manual_import running handle).");
        }
        const op = previewOperations.cancel(operationId.trim());
        if (!op) {
          return jsonText({
            status: "expired-or-unknown",
            operationId,
            guidance: "This operation is no longer available. Run the preview again.",
          });
        }
        return jsonText({
          operationId: op.id,
          status: op.status,
          operation: op.kind,
          note: op.status === "cancelled"
            ? "Cancellation requested. mcp-arr has stopped waiting and aborted the in-flight request; the app may still finish CPU-side work already in progress."
            : "The operation was already terminal; its status is unchanged.",
        });
      }

      case "arr_status": {
        const statuses: Record<string, unknown> = {};
        for (const service of configuredServices) {
          try {
            const client = clients[service.name];
            if (client) {
              const status = await client.getStatus();
              statuses[service.name] = {
                configured: true,
                connected: true,
                version: status.version,
                appName: status.appName,
              };
            }
          } catch (error) {
            statuses[service.name] = {
              configured: true,
              connected: false,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }
        // Add unconfigured services
        for (const service of services) {
          if (!statuses[service.name]) {
            statuses[service.name] = { configured: false };
          }
        }
        return jsonText(statuses);
      }

      // Dynamic config tool handlers
      // Quality Profiles
      case "sonarr_get_quality_profiles":
      case "radarr_get_quality_profiles":
      case "lidarr_get_quality_profiles": {
        const serviceName = name.split('_')[0] as keyof typeof clients;
        const client = clients[serviceName];
        if (!client) throw new Error(`${serviceName} not configured`);
        const profiles = await client.getQualityProfiles();
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              count: profiles.length,
              profiles: profiles.map(p => ({
                id: p.id,
                name: p.name,
                upgradeAllowed: p.upgradeAllowed,
                cutoff: p.cutoff,
                allowedQualities: p.items
                  .filter(i => i.allowed)
                  .map(i => i.quality?.name || i.name || (i.items?.map(q => q.quality.name).join(', ')))
                  .filter(Boolean),
                customFormats: p.formatItems?.filter(f => f.score !== 0).map(f => ({
                  name: f.name,
                  score: f.score,
                })) || [],
                minFormatScore: p.minFormatScore,
                cutoffFormatScore: p.cutoffFormatScore,
              })),
            }, null, 2),
          }],
        };
      }

      // Health checks
      case "sonarr_get_health":
      case "radarr_get_health":
      case "lidarr_get_health": {
        const serviceName = name.split('_')[0] as keyof typeof clients;
        const client = clients[serviceName];
        if (!client) throw new Error(`${serviceName} not configured`);
        const health = await client.getHealth();
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              issueCount: health.length,
              issues: health.map(h => ({
                source: h.source,
                type: h.type,
                message: h.message,
                wikiUrl: h.wikiUrl,
              })),
              status: health.length === 0 ? 'healthy' : 'issues detected',
            }, null, 2),
          }],
        };
      }

      // Root folders
      case "sonarr_get_root_folders":
      case "radarr_get_root_folders":
      case "lidarr_get_root_folders": {
        const serviceName = name.split('_')[0] as keyof typeof clients;
        const client = clients[serviceName];
        if (!client) throw new Error(`${serviceName} not configured`);
        const folders = await client.getRootFoldersDetailed();
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              count: folders.length,
              folders: folders.map(f => ({
                id: f.id,
                path: f.path,
                accessible: f.accessible,
                freeSpace: formatBytes(f.freeSpace),
                freeSpaceBytes: f.freeSpace,
                unmappedFolders: f.unmappedFolders?.length || 0,
              })),
            }, null, 2),
          }],
        };
      }

      // Download clients
      case "sonarr_get_download_clients":
      case "radarr_get_download_clients":
      case "lidarr_get_download_clients": {
        const serviceName = name.split('_')[0] as keyof typeof clients;
        const client = clients[serviceName];
        if (!client) throw new Error(`${serviceName} not configured`);
        const downloadClients = await client.getDownloadClients();
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              count: downloadClients.length,
              clients: downloadClients.map(c => ({
                id: c.id,
                name: c.name,
                implementation: c.implementationName,
                protocol: c.protocol,
                enabled: c.enable,
                priority: c.priority,
                removeCompletedDownloads: c.removeCompletedDownloads,
                removeFailedDownloads: c.removeFailedDownloads,
                tags: c.tags,
              })),
            }, null, 2),
          }],
        };
      }

      // Naming config
      case "sonarr_get_naming":
      case "radarr_get_naming":
      case "lidarr_get_naming": {
        const serviceName = name.split('_')[0] as keyof typeof clients;
        const client = clients[serviceName];
        if (!client) throw new Error(`${serviceName} not configured`);
        const naming = await client.getNamingConfig();
        return {
          content: [{
            type: "text",
            text: JSON.stringify(naming, null, 2),
          }],
        };
      }

      // Tags
      case "sonarr_get_tags":
      case "radarr_get_tags":
      case "lidarr_get_tags": {
        const serviceName = name.split('_')[0] as keyof typeof clients;
        const client = clients[serviceName];
        if (!client) throw new Error(`${serviceName} not configured`);
        const tags = await client.getTags();
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              count: tags.length,
              tags: tags.map(t => ({ id: t.id, label: t.label })),
            }, null, 2),
          }],
        };
      }

      // Comprehensive setup review
      case "sonarr_review_setup":
      case "radarr_review_setup":
      case "lidarr_review_setup": {
        const serviceName = name.split('_')[0] as keyof typeof clients;
        const client = clients[serviceName];
        if (!client) throw new Error(`${serviceName} not configured`);

        // Gather all configuration data
        const [status, health, qualityProfiles, qualityDefinitions, downloadClients, naming, mediaManagement, rootFolders, tags, indexers] = await Promise.all([
          client.getStatus(),
          client.getHealth(),
          client.getQualityProfiles(),
          client.getQualityDefinitions(),
          client.getDownloadClients(),
          client.getNamingConfig(),
          client.getMediaManagement(),
          client.getRootFoldersDetailed(),
          client.getTags(),
          client.getIndexers(),
        ]);

        // For Lidarr, also get metadata profiles
        let metadataProfiles = null;
        if (serviceName === 'lidarr' && clients.lidarr) {
          metadataProfiles = await clients.lidarr.getMetadataProfiles();
        }

        const review = {
          service: serviceName,
          version: status.version,
          appName: status.appName,
          platform: {
            os: status.osName,
            isDocker: status.isDocker,
          },
          health: {
            issueCount: health.length,
            issues: health,
          },
          storage: {
            rootFolders: rootFolders.map(f => ({
              path: f.path,
              accessible: f.accessible,
              freeSpace: formatBytes(f.freeSpace),
              freeSpaceBytes: f.freeSpace,
              unmappedFolderCount: f.unmappedFolders?.length || 0,
            })),
          },
          qualityProfiles: qualityProfiles.map(p => ({
            id: p.id,
            name: p.name,
            upgradeAllowed: p.upgradeAllowed,
            cutoff: p.cutoff,
            allowedQualities: p.items
              .filter(i => i.allowed)
              .map(i => i.quality?.name || i.name || (i.items?.map(q => q.quality.name).join(', ')))
              .filter(Boolean),
            customFormatsWithScores: p.formatItems?.filter(f => f.score !== 0).length || 0,
            minFormatScore: p.minFormatScore,
          })),
          qualityDefinitions: qualityDefinitions.map(d => ({
            quality: d.quality.name,
            minSize: d.minSize + ' MB/min',
            maxSize: d.maxSize === 0 ? 'unlimited' : d.maxSize + ' MB/min',
            preferredSize: d.preferredSize + ' MB/min',
          })),
          downloadClients: downloadClients.map(c => ({
            name: c.name,
            type: c.implementationName,
            protocol: c.protocol,
            enabled: c.enable,
            priority: c.priority,
          })),
          indexers: indexers.map(i => ({
            name: i.name,
            protocol: i.protocol,
            enableRss: i.enableRss,
            enableAutomaticSearch: i.enableAutomaticSearch,
            enableInteractiveSearch: i.enableInteractiveSearch,
            priority: i.priority,
          })),
          naming: naming,
          mediaManagement: {
            recycleBin: mediaManagement.recycleBin || 'not set',
            recycleBinCleanupDays: mediaManagement.recycleBinCleanupDays,
            downloadPropersAndRepacks: mediaManagement.downloadPropersAndRepacks,
            deleteEmptyFolders: mediaManagement.deleteEmptyFolders,
            copyUsingHardlinks: mediaManagement.copyUsingHardlinks,
            importExtraFiles: mediaManagement.importExtraFiles,
            extraFileExtensions: mediaManagement.extraFileExtensions,
          },
          tags: tags.map(t => t.label),
          ...(metadataProfiles && { metadataProfiles }),
        };

        return {
          content: [{
            type: "text",
            text: JSON.stringify(review, null, 2),
          }],
        };
      }

      // Sonarr handlers
      case "sonarr_get_series": {
        if (!clients.sonarr) throw new Error("Sonarr not configured");
        const { limit = 25, offset = 0, search } = args as {
          limit?: number;
          offset?: number;
          search?: string;
        };
        const normalizedLimit = Math.max(1, Math.min(limit, 100));
        const normalizedOffset = Math.max(0, offset);
        const filter = search?.trim().toLowerCase();

        const allSeries = await clients.sonarr.getSeries();
        const filteredSeries = filter
          ? allSeries.filter(s => s.title.toLowerCase().includes(filter))
          : allSeries;
        const pagedSeries = filteredSeries.slice(normalizedOffset, normalizedOffset + normalizedLimit);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              total: allSeries.length,
              filteredCount: filteredSeries.length,
              returned: pagedSeries.length,
              offset: normalizedOffset,
              limit: normalizedLimit,
              hasMore: normalizedOffset + normalizedLimit < filteredSeries.length,
              nextOffset: normalizedOffset + normalizedLimit < filteredSeries.length
                ? normalizedOffset + normalizedLimit
                : null,
              search: search ?? null,
              series: pagedSeries.map(s => ({
                id: s.id,
                title: s.title,
                year: s.year,
                status: s.status,
                network: s.network,
                seasons: s.statistics?.seasonCount,
                episodes: s.statistics?.episodeFileCount + '/' + s.statistics?.totalEpisodeCount,
                sizeOnDisk: formatBytes(s.statistics?.sizeOnDisk || 0),
                monitored: s.monitored,
              })),
            }, null, 2),
          }],
        };
      }

      case "sonarr_search": {
        if (!clients.sonarr) throw new Error("Sonarr not configured");
        const term = (args as { term: string }).term;
        const results = await clients.sonarr.searchSeries(term);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              count: results.length,
              results: results.slice(0, 10).map(r => ({
                title: r.title,
                year: r.year,
                tvdbId: r.tvdbId,
                overview: r.overview?.substring(0, 200) + (r.overview && r.overview.length > 200 ? '...' : ''),
              })),
            }, null, 2),
          }],
        };
      }

      case "sonarr_get_queue": {
        if (!clients.sonarr) throw new Error("Sonarr not configured");
        return jsonText(await getPaginatedQueue(clients.sonarr, args as { limit?: number; offset?: number }));
      }

      case "sonarr_delete_queue_item": {
        if (!clients.sonarr) throw new Error("Sonarr not configured");
        const { queueId, removeFromClient = true, blocklist = false, skipRedownload = false, changeCategory = false } = args as {
          queueId: number; removeFromClient?: boolean; blocklist?: boolean; skipRedownload?: boolean; changeCategory?: boolean;
        };
        await clients.sonarr.deleteQueueItem(queueId, { removeFromClient, blocklist, skipRedownload, changeCategory });
        return jsonText({
          success: true,
          message: `Removed queue item ${queueId}${blocklist ? ' and added to blocklist' : ''}`,
          queueId,
          removedFromClient: removeFromClient,
          blocklisted: blocklist,
          skipRedownload,
          changeCategory,
        });
      }

      case "sonarr_get_manual_import_candidates": {
        if (!clients.sonarr) throw new Error("Sonarr not configured");
        const a = (args ?? {}) as ManualImportToolArgs;
        if (typeof a.downloadId !== "string" || a.downloadId.trim() === "") {
          throw new Error("downloadId is required (from sonarr_get_queue). Candidates are discovered from the tracked download, never from a caller-supplied path.");
        }
        assertSonarrSeasonNumber(a.seasonNumber, "seasonNumber");
        assertPositiveEntityId(a.seriesId, "seriesId");
        const candidates = await clients.sonarr.getManualImportCandidates({
          downloadId: a.downloadId.trim(),
          seriesId: a.seriesId,
          seasonNumber: a.seasonNumber,
          filterExistingFiles: a.filterExistingFiles,
        });
        return jsonText({
          verifyBeforeActing: SONARR_VERIFY_DIRECTIVE,
          downloadId: a.downloadId.trim(),
          count: candidates.length,
          candidates: candidates.map(compactSonarrCandidate),
          notes: [
            "candidateId is the native manual-import resource id; pass it to sonarr_preview_manual_import / sonarr_execute_manual_import.",
            "Paths are shown for diagnosis only — the import tools resolve paths from native candidates and never accept caller-supplied paths.",
            "See verifyBeforeActing above: the mapping is a proposal, not ground truth — verify it against sonarr_get_episodes.",
            "If a candidate has rejections, decide via preview whether overriding them (allowRejected=true on that item in execute) is appropriate.",
          ],
        });
      }

      case "sonarr_preview_manual_import": {
        if (!clients.sonarr) throw new Error("Sonarr not configured");
        return await runPreviewTool("sonarr-manual-import-preview", "sonarr", clients.sonarr, args, previewSonarrManualImport);
      }

      case "sonarr_execute_manual_import": {
        if (!clients.sonarr) throw new Error("Sonarr not configured");
        return await executeSonarrManualImport(clients.sonarr, args);
      }

      case "sonarr_get_calendar": {
        if (!clients.sonarr) throw new Error("Sonarr not configured");
        const days = (args as { days?: number })?.days || 7;
        const start = new Date().toISOString().split('T')[0];
        const end = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const calendar = await clients.sonarr.getCalendar(start, end);
        return {
          content: [{ type: "text", text: JSON.stringify(calendar, null, 2) }],
        };
      }

      case "sonarr_get_episodes": {
        if (!clients.sonarr) throw new Error("Sonarr not configured");
        const { seriesId, seasonNumber } = args as { seriesId: number; seasonNumber?: number };
        const episodes = await clients.sonarr.getEpisodes(seriesId, seasonNumber);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              count: episodes.length,
              episodes: episodes.map(e => ({
                id: e.id,
                seasonNumber: e.seasonNumber,
                episodeNumber: e.episodeNumber,
                title: e.title,
                airDate: e.airDate,
                hasFile: e.hasFile,
                monitored: e.monitored,
              })),
            }, null, 2),
          }],
        };
      }

      case "sonarr_search_missing": {
        if (!clients.sonarr) throw new Error("Sonarr not configured");
        const seriesId = (args as { seriesId: number }).seriesId;
        const result = await clients.sonarr.searchMissing(seriesId);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `Search triggered for missing episodes`,
              commandId: result.id,
            }, null, 2),
          }],
        };
      }

      case "sonarr_search_episode": {
        if (!clients.sonarr) throw new Error("Sonarr not configured");
        const episodeIds = (args as { episodeIds: number[] }).episodeIds;
        const result = await clients.sonarr.searchEpisode(episodeIds);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `Search triggered for ${episodeIds.length} episode(s)`,
              commandId: result.id,
            }, null, 2),
          }],
        };
      }

      case "sonarr_refresh_series": {
        if (!clients.sonarr) throw new Error("Sonarr not configured");
        const seriesId = (args as { seriesId: number }).seriesId;
        const series = await clients.sonarr.getSeriesById(seriesId);
        const result = await clients.sonarr.refreshSeries(seriesId);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `Refresh triggered for series`,
              series: {
                id: series.id,
                title: series.title,
                year: series.year,
              },
              commandId: result.id,
            }, null, 2),
          }],
        };
      }

      case "sonarr_add_series": {
        if (!clients.sonarr) throw new Error("Sonarr not configured");
        const { tvdbId, title, qualityProfileId, rootFolderPath, monitored, seasonFolder, tags } = args as {
          tvdbId: number; title: string; qualityProfileId: number; rootFolderPath: string;
          monitored?: boolean; seasonFolder?: boolean; tags?: number[];
        };
        const added = await clients.sonarr.addSeries({
          tvdbId, title, qualityProfileId, rootFolderPath, monitored, seasonFolder, tags: tags ?? [],
        });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `Added "${added.title}" (${added.year}) to Sonarr`,
              id: added.id,
              path: added.path,
              monitored: added.monitored,
            }, null, 2),
          }],
        };
      }

      // Radarr handlers
      case "radarr_get_movies": {
        if (!clients.radarr) throw new Error("Radarr not configured");
        const { limit = 25, offset = 0, search } = args as {
          limit?: number;
          offset?: number;
          search?: string;
        };
        const normalizedLimit = Math.max(1, Math.min(limit, 100));
        const normalizedOffset = Math.max(0, offset);
        const filter = search?.trim().toLowerCase();

        const allMovies = await clients.radarr.getMovies();
        const filteredMovies = filter
          ? allMovies.filter(m => m.title.toLowerCase().includes(filter))
          : allMovies;
        const pagedMovies = filteredMovies.slice(normalizedOffset, normalizedOffset + normalizedLimit);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              total: allMovies.length,
              filteredCount: filteredMovies.length,
              returned: pagedMovies.length,
              offset: normalizedOffset,
              limit: normalizedLimit,
              hasMore: normalizedOffset + normalizedLimit < filteredMovies.length,
              nextOffset: normalizedOffset + normalizedLimit < filteredMovies.length
                ? normalizedOffset + normalizedLimit
                : null,
              search: search ?? null,
              movies: pagedMovies.map(m => ({
                id: m.id,
                title: m.title,
                year: m.year,
                status: m.status,
                hasFile: m.hasFile,
                sizeOnDisk: formatBytes(m.sizeOnDisk),
                monitored: m.monitored,
                studio: m.studio,
                qualityProfileId: m.qualityProfileId,
                ...(m.movieFile ? {
                  quality: m.movieFile.quality?.quality?.name ?? null,
                  resolution: m.movieFile.mediaInfo?.resolution ?? null,
                  videoCodec: m.movieFile.mediaInfo?.videoCodec ?? null,
                  videoDynamicRange: m.movieFile.mediaInfo?.videoDynamicRange ?? null,
                  audioCodec: m.movieFile.mediaInfo?.audioCodec ?? null,
                  audioChannels: m.movieFile.mediaInfo?.audioChannels ?? null,
                } : {}),
                ratings: Object.fromEntries(
                  Object.entries(m.ratings || {})
                    .filter(([, v]) => v && v.value > 0)
                    .map(([k, v]) => [k, v.value])
                ),
              })),
            }, null, 2),
          }],
        };
      }

      case "radarr_search": {
        if (!clients.radarr) throw new Error("Radarr not configured");
        const term = (args as { term: string }).term;
        const results = await clients.radarr.searchMovies(term);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              count: results.length,
              results: results.slice(0, 10).map(r => ({
                title: r.title,
                year: r.year,
                tmdbId: r.tmdbId,
                imdbId: r.imdbId,
                overview: r.overview?.substring(0, 200) + (r.overview && r.overview.length > 200 ? '...' : ''),
              })),
            }, null, 2),
          }],
        };
      }

      case "radarr_get_queue": {
        if (!clients.radarr) throw new Error("Radarr not configured");
        return jsonText(await getPaginatedQueue(clients.radarr, args as { limit?: number; offset?: number }));
      }

      case "radarr_get_calendar": {
        if (!clients.radarr) throw new Error("Radarr not configured");
        const days = (args as { days?: number })?.days || 30;
        const start = new Date().toISOString().split('T')[0];
        const end = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const calendar = await clients.radarr.getCalendar(start, end);
        return {
          content: [{ type: "text", text: JSON.stringify(calendar, null, 2) }],
        };
      }

      case "radarr_search_movie": {
        if (!clients.radarr) throw new Error("Radarr not configured");
        const movieId = (args as { movieId: number }).movieId;
        const result = await clients.radarr.searchMovie(movieId);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `Search triggered for movie`,
              commandId: result.id,
            }, null, 2),
          }],
        };
      }

      case "radarr_refresh_movie": {
        if (!clients.radarr) throw new Error("Radarr not configured");
        const movieId = (args as { movieId: number }).movieId;
        const movie = await clients.radarr.getMovieById(movieId);
        const result = await clients.radarr.refreshMovie(movieId);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `Refresh triggered for movie`,
              movie: {
                id: movie.id,
                title: movie.title,
                year: movie.year,
              },
              commandId: result.id,
            }, null, 2),
          }],
        };
      }

      case "radarr_add_movie": {
        if (!clients.radarr) throw new Error("Radarr not configured");
        const { tmdbId, title, qualityProfileId, rootFolderPath, monitored, minimumAvailability, tags } = args as {
          tmdbId: number; title: string; qualityProfileId: number; rootFolderPath: string;
          monitored?: boolean; minimumAvailability?: string; tags?: number[];
        };
        const added = await clients.radarr.addMovie({
          tmdbId, title, qualityProfileId, rootFolderPath, monitored, minimumAvailability, tags: tags ?? [],
        });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `Added "${added.title}" (${added.year}) to Radarr`,
              id: added.id,
              path: added.path,
              monitored: added.monitored,
            }, null, 2),
          }],
        };
      }

      case "radarr_update_movie": {
        if (!clients.radarr) throw new Error("Radarr not configured");
        const { movieId, qualityProfileId, monitored, minimumAvailability, tags, path } = args as {
          movieId: number; qualityProfileId?: number; monitored?: boolean;
          minimumAvailability?: string; tags?: number[]; path?: string;
        };
        // Fetch the full movie object first
        const movie = await clients.radarr.getMovieById(movieId);
        // Apply updates
        if (qualityProfileId !== undefined) movie.qualityProfileId = qualityProfileId;
        if (monitored !== undefined) movie.monitored = monitored;
        if (minimumAvailability !== undefined) movie.minimumAvailability = minimumAvailability;
        if (tags !== undefined) movie.tags = tags;
        if (path !== undefined) movie.path = path;
        const updated = await clients.radarr.updateMovie(movie);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `Updated "${updated.title}" (${updated.year})`,
              movie: {
                id: updated.id,
                title: updated.title,
                year: updated.year,
                qualityProfileId: updated.qualityProfileId,
                monitored: updated.monitored,
                minimumAvailability: updated.minimumAvailability,
                tags: updated.tags,
                path: updated.path,
              },
            }, null, 2),
          }],
        };
      }

      case "radarr_delete_queue_item": {
        if (!clients.radarr) throw new Error("Radarr not configured");
        const { queueId, removeFromClient = true, blocklist = false, skipRedownload = false, changeCategory = false } = args as {
          queueId: number; removeFromClient?: boolean; blocklist?: boolean; skipRedownload?: boolean; changeCategory?: boolean;
        };
        await clients.radarr.deleteQueueItem(queueId, { removeFromClient, blocklist, skipRedownload, changeCategory });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `Removed queue item ${queueId}${blocklist ? ' and added to blocklist' : ''}`,
              queueId,
              removedFromClient: removeFromClient,
              blocklisted: blocklist,
              skipRedownload,
              changeCategory,
            }, null, 2),
          }],
        };
      }

      case "radarr_get_manual_import_candidates": {
        if (!clients.radarr) throw new Error("Radarr not configured");
        const a = (args ?? {}) as ManualImportToolArgs;
        if (typeof a.downloadId !== "string" || a.downloadId.trim() === "") {
          throw new Error("downloadId is required (from radarr_get_queue). Candidates are discovered from the tracked download, never from a caller-supplied path.");
        }
        assertPositiveEntityId(a.movieId, "movieId");
        const candidates = await clients.radarr.getManualImportCandidates({
          downloadId: a.downloadId.trim(),
          movieId: a.movieId,
          filterExistingFiles: a.filterExistingFiles,
        });
        return jsonText({
          verifyBeforeActing: RADARR_VERIFY_DIRECTIVE,
          downloadId: a.downloadId.trim(),
          count: candidates.length,
          candidates: candidates.map(compactRadarrCandidate),
          notes: [
            "candidateId is the native manual-import resource id; pass it to radarr_preview_manual_import / radarr_execute_manual_import.",
            "Paths are shown for diagnosis only — the import tools resolve paths from native candidates and never accept caller-supplied paths.",
            "If a candidate has rejections, decide via preview whether overriding them (allowRejected=true on that item in execute) is appropriate.",
          ],
        });
      }

      case "radarr_preview_manual_import": {
        if (!clients.radarr) throw new Error("Radarr not configured");
        return await runPreviewTool("radarr-manual-import-preview", "radarr", clients.radarr, args, previewRadarrManualImport);
      }

      case "radarr_execute_manual_import": {
        if (!clients.radarr) throw new Error("Radarr not configured");
        return await executeRadarrManualImport(clients.radarr, args);
      }

      case "radarr_search_movies": {
        if (!clients.radarr) throw new Error("Radarr not configured");
        const { movieIds } = args as { movieIds: number[] };
        if (!movieIds || movieIds.length === 0) throw new Error("movieIds array is required and must not be empty");
        const result = await clients.radarr.searchMoviesBulk(movieIds);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `Search triggered for ${movieIds.length} movie(s)`,
              commandId: result.id,
              movieIds,
            }, null, 2),
          }],
        };
      }

      // Lidarr handlers
      case "lidarr_get_artists": {
        if (!clients.lidarr) throw new Error("Lidarr not configured");
        const artists = await clients.lidarr.getArtists();
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              count: artists.length,
              artists: artists.map(a => ({
                id: a.id,
                artistName: a.artistName,
                status: a.status,
                albums: a.statistics?.albumCount,
                tracks: a.statistics?.trackFileCount + '/' + a.statistics?.totalTrackCount,
                sizeOnDisk: formatBytes(a.statistics?.sizeOnDisk || 0),
                monitored: a.monitored,
              })),
            }, null, 2),
          }],
        };
      }

      case "lidarr_search": {
        if (!clients.lidarr) throw new Error("Lidarr not configured");
        const a = args as { term?: string; query?: string; artist?: string; name?: string };
        const term = a.term ?? a.query ?? a.artist ?? a.name;
        if (!term) throw new Error("term required (artist name)");
        const results = await clients.lidarr.searchArtists(term);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              count: results.length,
              results: results.slice(0, 10).map(r => ({
                artistName: r.artistName ?? r.title,
                disambiguation: r.disambiguation,
                foreignArtistId: r.foreignArtistId,
                overview: r.overview ? (r.overview.substring(0, 200) + (r.overview.length > 200 ? '...' : '')) : undefined,
              })),
            }, null, 2),
          }],
        };
      }

      case "lidarr_get_queue": {
        if (!clients.lidarr) throw new Error("Lidarr not configured");
        return jsonText(await getPaginatedQueue(clients.lidarr, args as { limit?: number; offset?: number }));
      }

      case "lidarr_delete_queue_item": {
        if (!clients.lidarr) throw new Error("Lidarr not configured");
        const { queueId, removeFromClient = true, blocklist = false, skipRedownload = false, changeCategory = false } = args as {
          queueId: number; removeFromClient?: boolean; blocklist?: boolean; skipRedownload?: boolean; changeCategory?: boolean;
        };
        await clients.lidarr.deleteQueueItem(queueId, { removeFromClient, blocklist, skipRedownload, changeCategory });
        return jsonText({
          success: true,
          message: `Removed queue item ${queueId}${blocklist ? ' and added to blocklist' : ''}`,
          queueId,
          removedFromClient: removeFromClient,
          blocklisted: blocklist,
          skipRedownload,
          changeCategory,
        });
      }

      case "lidarr_get_manual_import_candidates": {
        if (!clients.lidarr) throw new Error("Lidarr not configured");
        const a = (args ?? {}) as ManualImportToolArgs;
        if (typeof a.downloadId !== "string" || a.downloadId.trim() === "") {
          throw new Error("downloadId is required (from lidarr_get_queue). Candidates are discovered from the tracked download, never from a caller-supplied path.");
        }
        assertPositiveEntityId(a.artistId, "artistId");
        const candidates = await clients.lidarr.getManualImportCandidates({
          downloadId: a.downloadId.trim(),
          artistId: a.artistId,
          filterExistingFiles: a.filterExistingFiles,
          replaceExistingFiles: a.replaceExistingFiles ?? false,
        });
        return jsonText({
          verifyBeforeActing: LIDARR_VERIFY_DIRECTIVE,
          downloadId: a.downloadId.trim(),
          count: candidates.length,
          candidates: candidates.map(compactLidarrCandidate),
          notes: [
            "candidateId is the native manual-import resource id; pass it to lidarr_preview_manual_import / lidarr_execute_manual_import.",
            "Paths are shown for diagnosis only — the import tools resolve paths from native candidates and never accept caller-supplied paths.",
            "Lidarr recomputes the track mapping server-side during preview; the preview result is authoritative for what execute will import.",
            "If a candidate has rejections, decide via preview whether overriding them (allowRejected=true on that item in execute) is appropriate.",
          ],
        });
      }

      case "lidarr_preview_manual_import": {
        if (!clients.lidarr) throw new Error("Lidarr not configured");
        return await runPreviewTool("lidarr-manual-import-preview", "lidarr", clients.lidarr, args, previewLidarrManualImport);
      }

      case "lidarr_execute_manual_import": {
        if (!clients.lidarr) throw new Error("Lidarr not configured");
        return await executeLidarrManualImport(clients.lidarr, args);
      }

      case "lidarr_get_albums": {
        if (!clients.lidarr) throw new Error("Lidarr not configured");
        const artistId = (args as { artistId: number }).artistId;
        const albums = await clients.lidarr.getAlbums(artistId);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              count: albums.length,
              albums: albums.map(a => ({
                id: a.id,
                title: a.title,
                releaseDate: a.releaseDate,
                albumType: a.albumType,
                monitored: a.monitored,
                tracks: a.statistics ? `${a.statistics.trackFileCount}/${a.statistics.totalTrackCount}` : 'unknown',
                sizeOnDisk: formatBytes(a.statistics?.sizeOnDisk || 0),
                percentComplete: a.statistics?.percentOfTracks || 0,
                grabbed: a.grabbed,
              })),
            }, null, 2),
          }],
        };
      }

      case "lidarr_search_album": {
        if (!clients.lidarr) throw new Error("Lidarr not configured");
        const albumId = (args as { albumId: number }).albumId;
        const result = await clients.lidarr.searchAlbum(albumId);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `Search triggered for album`,
              commandId: result.id,
            }, null, 2),
          }],
        };
      }

      case "lidarr_search_missing": {
        if (!clients.lidarr) throw new Error("Lidarr not configured");
        const artistId = (args as { artistId: number }).artistId;
        const result = await clients.lidarr.searchMissingAlbums(artistId);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `Search triggered for missing albums`,
              commandId: result.id,
            }, null, 2),
          }],
        };
      }

      case "lidarr_get_calendar": {
        if (!clients.lidarr) throw new Error("Lidarr not configured");
        const days = (args as { days?: number })?.days || 30;
        const start = new Date().toISOString().split('T')[0];
        const end = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const calendar = await clients.lidarr.getCalendar(start, end);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              count: calendar.length,
              albums: calendar.map(a => ({
                id: a.id,
                title: a.title,
                artistId: a.artistId,
                releaseDate: a.releaseDate,
                albumType: a.albumType,
                monitored: a.monitored,
              })),
            }, null, 2),
          }],
        };
      }

      case "lidarr_add_artist": {
        if (!clients.lidarr) throw new Error("Lidarr not configured");
        const { foreignArtistId, artistName, qualityProfileId, metadataProfileId, rootFolderPath, monitored, tags } = args as {
          foreignArtistId: string; artistName: string; qualityProfileId: number;
          metadataProfileId: number; rootFolderPath: string; monitored?: boolean; tags?: number[];
        };
        const added = await clients.lidarr.addArtist({
          foreignArtistId, artistName, qualityProfileId, metadataProfileId, rootFolderPath, monitored, tags: tags ?? [],
        });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `Added "${added.artistName}" to Lidarr`,
              id: added.id,
              path: added.path,
              monitored: added.monitored,
            }, null, 2),
          }],
        };
      }

      case "lidarr_get_root_folders": {
        if (!clients.lidarr) throw new Error("Lidarr not configured");
        const folders = await clients.lidarr.getRootFolders();
        return {
          content: [{
            type: "text",
            text: JSON.stringify(folders, null, 2),
          }],
        };
      }

      case "lidarr_get_quality_profiles": {
        if (!clients.lidarr) throw new Error("Lidarr not configured");
        const profiles = await clients.lidarr.getQualityProfiles();
        return {
          content: [{
            type: "text",
            text: JSON.stringify(profiles.map(p => ({ id: p.id, name: p.name })), null, 2),
          }],
        };
      }

      case "lidarr_get_metadata_profiles": {
        if (!clients.lidarr) throw new Error("Lidarr not configured");
        const profiles = await clients.lidarr.getMetadataProfiles();
        return {
          content: [{
            type: "text",
            text: JSON.stringify(profiles.map(p => ({ id: p.id, name: p.name })), null, 2),
          }],
        };
      }

      // Prowlarr handlers
      case "prowlarr_get_indexers": {
        if (!clients.prowlarr) throw new Error("Prowlarr not configured");
        const indexers = await clients.prowlarr.getIndexers();
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              count: indexers.length,
              indexers: indexers.map(i => ({
                id: i.id,
                name: i.name,
                protocol: i.protocol,
                enableRss: i.enableRss,
                enableAutomaticSearch: i.enableAutomaticSearch,
                enableInteractiveSearch: i.enableInteractiveSearch,
                priority: i.priority,
              })),
            }, null, 2),
          }],
        };
      }

      case "prowlarr_search": {
        if (!clients.prowlarr) throw new Error("Prowlarr not configured");
        const query = (args as { query: string }).query;
        const results = await clients.prowlarr.search(query);
        return {
          content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
        };
      }

      case "prowlarr_test_indexers": {
        if (!clients.prowlarr) throw new Error("Prowlarr not configured");
        const results = await clients.prowlarr.testAllIndexers();
        const indexers = await clients.prowlarr.getIndexers();
        const indexerMap = new Map(indexers.map(i => [i.id, i.name]));
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              count: results.length,
              indexers: results.map(r => ({
                id: r.id,
                name: indexerMap.get(r.id) || 'Unknown',
                isValid: r.isValid,
                errors: r.validationFailures.map(f => f.errorMessage),
              })),
              healthy: results.filter(r => r.isValid).length,
              failed: results.filter(r => !r.isValid).length,
            }, null, 2),
          }],
        };
      }

      case "prowlarr_get_stats": {
        if (!clients.prowlarr) throw new Error("Prowlarr not configured");
        const stats = await clients.prowlarr.getIndexerStats();
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              count: stats.indexers.length,
              indexers: stats.indexers.map(s => ({
                name: s.indexerName,
                queries: s.numberOfQueries,
                grabs: s.numberOfGrabs,
                failedQueries: s.numberOfFailedQueries,
                failedGrabs: s.numberOfFailedGrabs,
                avgResponseTime: s.averageResponseTime + 'ms',
              })),
              totals: {
                queries: stats.indexers.reduce((sum, s) => sum + s.numberOfQueries, 0),
                grabs: stats.indexers.reduce((sum, s) => sum + s.numberOfGrabs, 0),
                failedQueries: stats.indexers.reduce((sum, s) => sum + s.numberOfFailedQueries, 0),
                failedGrabs: stats.indexers.reduce((sum, s) => sum + s.numberOfFailedGrabs, 0),
              },
            }, null, 2),
          }],
        };
      }

      // Cross-service search
      case "arr_search_all": {
        const term = (args as { term: string }).term;
        const results: Record<string, unknown> = {};

        if (clients.sonarr) {
          try {
            const sonarrResults = await clients.sonarr.searchSeries(term);
            results.sonarr = { count: sonarrResults.length, results: sonarrResults.slice(0, 5) };
          } catch (e) {
            results.sonarr = { error: e instanceof Error ? e.message : String(e) };
          }
        }

        if (clients.radarr) {
          try {
            const radarrResults = await clients.radarr.searchMovies(term);
            results.radarr = { count: radarrResults.length, results: radarrResults.slice(0, 5) };
          } catch (e) {
            results.radarr = { error: e instanceof Error ? e.message : String(e) };
          }
        }

        if (clients.lidarr) {
          try {
            const lidarrResults = await clients.lidarr.searchArtists(term);
            results.lidarr = { count: lidarrResults.length, results: lidarrResults.slice(0, 5) };
          } catch (e) {
            results.lidarr = { error: e instanceof Error ? e.message : String(e) };
          }
        }

        return {
          content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
        };
      }

      // TRaSH Guides handlers
      case "trash_list_profiles": {
        const service = (args as { service: TrashService }).service;
        const profiles = await trashClient.listProfiles(service);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              service,
              count: profiles.length,
              profiles: profiles.map(p => ({
                name: p.name,
                description: p.description?.replace(/<br>/g, ' ') || 'No description',
              })),
              usage: "Use trash_get_profile to see full details for a specific profile",
            }, null, 2),
          }],
        };
      }

      case "trash_get_profile": {
        const { service, profile: profileName } = args as { service: TrashService; profile: string };
        const profile = await trashClient.getProfile(service, profileName);
        if (!profile) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                error: `Profile '${profileName}' not found for ${service}`,
                hint: "Use trash_list_profiles to see available profiles",
              }, null, 2),
            }],
            isError: true,
          };
        }
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              name: profile.name,
              description: profile.trash_description?.replace(/<br>/g, '\n'),
              trash_id: profile.trash_id,
              upgradeAllowed: profile.upgradeAllowed,
              cutoff: profile.cutoff,
              minFormatScore: profile.minFormatScore,
              cutoffFormatScore: profile.cutoffFormatScore,
              language: profile.language,
              qualities: profile.items.map(i => ({
                name: i.name,
                allowed: i.allowed,
                items: i.items,
              })),
              customFormats: Object.entries(profile.formatItems || {}).map(([name, trashId]) => ({
                name,
                trash_id: trashId,
              })),
            }, null, 2),
          }],
        };
      }

      case "trash_list_custom_formats": {
        const { service, category } = args as { service: TrashService; category?: string };
        const formats = await trashClient.listCustomFormats(service, category);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              service,
              category: category || 'all',
              count: formats.length,
              formats: formats.slice(0, 50).map(f => ({
                name: f.name,
                categories: f.categories,
                defaultScore: f.defaultScore,
              })),
              note: formats.length > 50 ? `Showing first 50 of ${formats.length}. Use category filter to narrow results.` : undefined,
              availableCategories: ['hdr', 'audio', 'resolution', 'source', 'streaming', 'anime', 'unwanted', 'release', 'language'],
            }, null, 2),
          }],
        };
      }

      case "trash_get_naming": {
        const { service, mediaServer } = args as { service: TrashService; mediaServer: string };
        const naming = await trashClient.getNaming(service);
        if (!naming) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ error: `Could not fetch naming conventions for ${service}` }, null, 2),
            }],
            isError: true,
          };
        }

        // Map media server to naming key
        const serverMap: Record<string, { folder: string; file: string }> = {
          plex: { folder: 'plex-imdb', file: 'plex-imdb' },
          emby: { folder: 'emby-imdb', file: 'emby-imdb' },
          jellyfin: { folder: 'jellyfin-imdb', file: 'jellyfin-imdb' },
          standard: { folder: 'default', file: 'standard' },
        };

        const keys = serverMap[mediaServer] || serverMap.standard;

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              service,
              mediaServer,
              recommended: {
                folder: naming.folder[keys.folder] || naming.folder.default,
                file: naming.file[keys.file] || naming.file.standard,
                ...(naming.season && { season: naming.season[keys.folder] || naming.season.default }),
                ...(naming.series && { series: naming.series[keys.folder] || naming.series.default }),
              },
              allFolderOptions: Object.keys(naming.folder),
              allFileOptions: Object.keys(naming.file),
            }, null, 2),
          }],
        };
      }

      case "trash_get_quality_sizes": {
        const { service, type } = args as { service: TrashService; type?: string };
        const sizes = await trashClient.getQualitySizes(service, type);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              service,
              type: type || 'all',
              profiles: sizes.map(s => ({
                type: s.type,
                qualities: s.qualities.map(q => ({
                  quality: q.quality,
                  min: q.min + ' MB/min',
                  preferred: q.preferred === 1999 ? 'unlimited' : q.preferred + ' MB/min',
                  max: q.max === 2000 ? 'unlimited' : q.max + ' MB/min',
                })),
              })),
            }, null, 2),
          }],
        };
      }

      case "trash_compare_profile": {
        const { service, profileId, trashProfile } = args as {
          service: TrashService;
          profileId: number;
          trashProfile: string;
        };

        // Get client
        const client = service === 'radarr' ? clients.radarr : clients.sonarr;
        if (!client) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ error: `${service} not configured. Cannot compare profiles.` }, null, 2),
            }],
            isError: true,
          };
        }

        // Fetch both profiles
        const [userProfiles, trashProfileData] = await Promise.all([
          client.getQualityProfiles(),
          trashClient.getProfile(service, trashProfile),
        ]);

        const userProfile = userProfiles.find(p => p.id === profileId);
        if (!userProfile) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                error: `Profile ID ${profileId} not found`,
                availableProfiles: userProfiles.map(p => ({ id: p.id, name: p.name })),
              }, null, 2),
            }],
            isError: true,
          };
        }

        if (!trashProfileData) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                error: `TRaSH profile '${trashProfile}' not found`,
                hint: "Use trash_list_profiles to see available profiles",
              }, null, 2),
            }],
            isError: true,
          };
        }

        // Compare qualities
        const userQualities = new Set<string>(
          userProfile.items
            .filter(i => i.allowed)
            .map(i => i.quality?.name || i.name)
            .filter((n): n is string => n !== undefined)
        );
        const trashQualities = new Set<string>(
          trashProfileData.items
            .filter(i => i.allowed)
            .map(i => i.name)
        );

        const qualityComparison = {
          matching: [...userQualities].filter(q => trashQualities.has(q)),
          missingFromYours: [...trashQualities].filter(q => !userQualities.has(q)),
          extraInYours: [...userQualities].filter(q => !trashQualities.has(q)),
        };

        // Compare custom formats
        const userCFNames = new Set(
          (userProfile.formatItems || [])
            .filter(f => f.score !== 0)
            .map(f => f.name)
        );
        const trashCFNames = new Set(Object.keys(trashProfileData.formatItems || {}));

        const cfComparison = {
          matching: [...userCFNames].filter(cf => trashCFNames.has(cf)),
          missingFromYours: [...trashCFNames].filter(cf => !userCFNames.has(cf)),
          extraInYours: [...userCFNames].filter(cf => !trashCFNames.has(cf)),
        };

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              yourProfile: {
                name: userProfile.name,
                id: userProfile.id,
                upgradeAllowed: userProfile.upgradeAllowed,
                cutoff: userProfile.cutoff,
              },
              trashProfile: {
                name: trashProfileData.name,
                upgradeAllowed: trashProfileData.upgradeAllowed,
                cutoff: trashProfileData.cutoff,
              },
              qualityComparison,
              customFormatComparison: cfComparison,
              recommendations: [
                ...(qualityComparison.missingFromYours.length > 0
                  ? [`Enable these qualities: ${qualityComparison.missingFromYours.join(', ')}`]
                  : []),
                ...(cfComparison.missingFromYours.length > 0
                  ? [`Add these custom formats: ${cfComparison.missingFromYours.slice(0, 5).join(', ')}${cfComparison.missingFromYours.length > 5 ? ` and ${cfComparison.missingFromYours.length - 5} more` : ''}`]
                  : []),
                ...(userProfile.upgradeAllowed !== trashProfileData.upgradeAllowed
                  ? [`Set upgradeAllowed to ${trashProfileData.upgradeAllowed}`]
                  : []),
              ],
            }, null, 2),
          }],
        };
      }

      case "trash_compare_naming": {
        const { service, mediaServer } = args as { service: TrashService; mediaServer: string };

        // Get client
        const client = service === 'radarr' ? clients.radarr : clients.sonarr;
        if (!client) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ error: `${service} not configured. Cannot compare naming.` }, null, 2),
            }],
            isError: true,
          };
        }

        // Fetch both
        const [userNaming, trashNaming] = await Promise.all([
          client.getNamingConfig(),
          trashClient.getNaming(service),
        ]);

        if (!trashNaming) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ error: `Could not fetch TRaSH naming for ${service}` }, null, 2),
            }],
            isError: true,
          };
        }

        // Map media server to naming key
        const serverMap: Record<string, { folder: string; file: string }> = {
          plex: { folder: 'plex-imdb', file: 'plex-imdb' },
          emby: { folder: 'emby-imdb', file: 'emby-imdb' },
          jellyfin: { folder: 'jellyfin-imdb', file: 'jellyfin-imdb' },
          standard: { folder: 'default', file: 'standard' },
        };

        const keys = serverMap[mediaServer] || serverMap.standard;
        const recommendedFolder = trashNaming.folder[keys.folder] || trashNaming.folder.default;
        const recommendedFile = trashNaming.file[keys.file] || trashNaming.file.standard;

        // Extract user's current naming (field names vary by service)
        const namingRecord = userNaming as unknown as Record<string, unknown>;
        const userFolder = namingRecord.movieFolderFormat ||
          namingRecord.seriesFolderFormat ||
          namingRecord.standardMovieFormat;
        const userFile = namingRecord.standardMovieFormat ||
          namingRecord.standardEpisodeFormat;

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              mediaServer,
              yourNaming: {
                folder: userFolder,
                file: userFile,
              },
              trashRecommended: {
                folder: recommendedFolder,
                file: recommendedFile,
              },
              folderMatch: userFolder === recommendedFolder,
              fileMatch: userFile === recommendedFile,
              recommendations: [
                ...(userFolder !== recommendedFolder ? [`Update folder format to: ${recommendedFolder}`] : []),
                ...(userFile !== recommendedFile ? [`Update file format to: ${recommendedFile}`] : []),
              ],
            }, null, 2),
          }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${errorMessage}` }],
      isError: true,
    };
  }
});
}

// Helper function to format bytes
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function startHttpServer() {
  const httpServer = createServer(async (req, res) => {
    if (!req.url) {
      res.statusCode = 400;
      res.end("Missing URL");
      return;
    }

    const requestUrl = new URL(req.url, `http://${req.headers.host || `${HTTP_HOST}:${HTTP_PORT}`}`);

    if (requestUrl.pathname === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        version: SERVER_VERSION,
        transport: "http",
        configuredServices: configuredServices.map((service) => service.name),
      }));
      return;
    }

    if (requestUrl.pathname !== HTTP_PATH) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }

    // Stateless HTTP: a fresh server + transport per request, with no session
    // id issued (sessionIdGenerator: undefined). This lets MCP clients that do
    // not echo the Mcp-Session-Id header back — e.g. Claude Code — work. Using a
    // new server per request means requests are no longer serialized through a
    // single shared server, so a long-lived GET (SSE) stream can stay open
    // without blocking other requests. The previous shared-server + serialized
    // queue deadlocked the moment a streamable client (e.g. a gateway/proxy)
    // opened its GET stream — that request never completes, so every later
    // request hung behind it.
    const requestServer = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      void transport.close();
      void requestServer.close();
    });
    try {
      await requestServer.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(error instanceof Error ? error.message : String(error));
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(HTTP_PORT, HTTP_HOST, () => resolve());
  });

  console.error(`*arr MCP server running over HTTP at http://${HTTP_HOST}:${HTTP_PORT}${HTTP_PATH}`);
}

// Start the server
async function main() {
  if (TRANSPORT_MODE === "http") {
    await startHttpServer();
    return;
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`*arr MCP server running over stdio - configured services: ${configuredServices.map(s => s.name).join(', ') || 'none (TRaSH-only mode)'}`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
