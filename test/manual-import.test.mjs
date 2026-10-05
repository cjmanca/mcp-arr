import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";

// ---------------------------------------------------------------------------
// Manual-import orchestration tests.
//
// Boots the real MCP server (HTTP transport) against three stub *arr apps
// (Sonarr/Radarr share the /api/v3 namespace, so each service gets its own
// stub with its own request log). The stubs mimic the native manual-import
// endpoints:
//   GET  /api/{v3|v1}/manualimport   -> candidate list scoped to downloadId
//   POST /api/{v3|v1}/manualimport   -> reprocess/update, echoing the request
//                                        items with server-recalculated fields
//                                        (Lidarr recomputes tracks server-side)
//   POST /api/{v3|v1}/command        -> { id } for the ManualImport command
// ---------------------------------------------------------------------------

const SONARR_DOWNLOAD_ID = "abc123";
const LIDARR_DOWNLOAD_ID = "dl-5";

const QUALITY = { quality: { id: 9, name: "WEBDL-1080p", source: "web", resolution: 1080 }, revision: { version: 1, real: 0 } };
const LANGUAGES = [{ id: 3, name: "English" }];

const SONARR_CANDIDATE = {
  id: 123,
  path: "/downloads/complete/The.Good.Fight/The.Good.Fight.S06E03.1080p.mkv",
  relativePath: "The.Good.Fight.S06E03.1080p.mkv",
  folderName: "The.Good.Fight.S06",
  name: "The.Good.Fight.S06E03.1080p",
  size: 123456789,
  series: { id: 47, title: "The Good Fight" },
  seasonNumber: 6,
  episodes: [{ id: 9001, seriesId: 47, seasonNumber: 6, episodeNumber: 3, title: "The End of Football" }],
  episodeFileId: null,
  releaseGroup: "NTb",
  quality: QUALITY,
  languages: LANGUAGES,
  qualityWeight: 60,
  downloadId: SONARR_DOWNLOAD_ID,
  customFormats: [{ id: 1, name: "NTb", score: 10 }],
  customFormatScore: 10,
  indexerFlags: 0,
  releaseType: "episode",
  rejections: [{ reason: "Unable to determine if file is a sample", type: "temporary" }],
};

const SONARR_CANDIDATE_2 = {
  ...SONARR_CANDIDATE,
  id: 124,
  path: "/downloads/complete/The.Good.Fight/The.Good.Fight.S06E04.1080p.mkv",
  name: "The.Good.Fight.S06E04.1080p",
  episodes: [{ id: 9002, seriesId: 47, seasonNumber: 6, episodeNumber: 4, title: "The End of Football II" }],
  rejections: [],
};

// Native episode data the MCP layer validates caller-supplied episodeIds
// against: GET /api/v3/episode?seriesId=&seasonNumber= — the exact query the
// native episode picker issues. Keyed "seriesId:seasonNumber".
//   series 47 "The Good Fight": season 6 → 9001/9002, season 0 (specials) → 62640
//   series 88 "A Different Series": season 1 → 9100
const SONARR_EPISODE_CATALOG = {
  "47:6": [
    { id: 9001, seriesId: 47, seasonNumber: 6, episodeNumber: 3, title: "The End of Football", hasFile: false, episodeFileId: null },
    { id: 9002, seriesId: 47, seasonNumber: 6, episodeNumber: 4, title: "The End of Football II", hasFile: false, episodeFileId: null },
  ],
  "47:0": [
    { id: 62640, seriesId: 47, seasonNumber: 0, episodeNumber: 1, title: "The Haunting of MoDean's II", hasFile: false, episodeFileId: null },
  ],
  "88:1": [
    { id: 9100, seriesId: 88, seasonNumber: 1, episodeNumber: 1, title: "Pilot", hasFile: false, episodeFileId: null },
  ],
  // Series 90 is the Letterkenny worked example (see the regression test at the
  // end of this file): season 4 has six real episodes with titles unrelated to
  // the special's name, and the special itself lives in season 0.
  "90:4": [
    { id: 9201, seriesId: 90, seasonNumber: 4, episodeNumber: 1, title: "A K Smelly Christmas", hasFile: true, episodeFileId: 701 },
    { id: 9202, seriesId: 90, seasonNumber: 4, episodeNumber: 2, title: "Best Before", hasFile: true, episodeFileId: 702 },
    { id: 9203, seriesId: 90, seasonNumber: 4, episodeNumber: 3, title: "Tis the Season", hasFile: true, episodeFileId: 703 },
    { id: 9204, seriesId: 90, seasonNumber: 4, episodeNumber: 4, title: "Garnet Rings", hasFile: true, episodeFileId: 704 },
    { id: 9205, seriesId: 90, seasonNumber: 4, episodeNumber: 5, title: "The D's", hasFile: true, episodeFileId: 705 },
    { id: 9206, seriesId: 90, seasonNumber: 4, episodeNumber: 6, title: "The Shit Paradox 2", hasFile: true, episodeFileId: 706 },
  ],
  "90:0": [
    { id: 9300, seriesId: 90, seasonNumber: 0, episodeNumber: 1, title: "The Haunting of MoDean's II", hasFile: true, episodeFileId: 700 },
  ],
};

// GET /api/v3/series/{id} — the source of an overridden series' REAL title.
const SONARR_SERIES = {
  47: { id: 47, title: "The Good Fight", seriesType: "standard" },
  88: { id: 88, title: "A Different Series", seriesType: "standard" },
  90: { id: 90, title: "Letterkenny", seriesType: "standard" },
};

// GET /api/v3/movie/{id} — the source of an overridden movie's REAL title.
const RADARR_MOVIES = {
  11: { id: 11, title: "Some Movie", year: 2026 },
  12: { id: 12, title: "Second Movie", year: 2027 },
};

const RADARR_CANDIDATE = {
  id: 222,
  path: "/downloads/complete/Some.Movie/Some.Movie.2026.1080p.mkv",
  relativePath: "Some.Movie.2026.1080p.mkv",
  folderName: "Some.Movie.2026",
  name: "Some.Movie.2026.1080p",
  size: 500,
  movie: { id: 11, title: "Some Movie", year: 2026 },
  movieFileId: null,
  releaseGroup: "SM",
  quality: QUALITY,
  languages: LANGUAGES,
  qualityWeight: 60,
  downloadId: "dl-11",
  customFormats: [],
  customFormatScore: 0,
  indexerFlags: 0,
  rejections: [],
};

const LIDARR_CANDIDATE = {
  id: 333,
  path: "/downloads/complete/Some.Artist/Some.Artist - Some Album/01 - Track One.flac",
  name: "01 - Track One",
  size: 700,
  artist: { id: 5, artistName: "Some Artist" },
  album: { id: 9, title: "Some Album" },
  albumReleaseId: 77,
  tracks: [{ id: 501, title: "Track One", trackNumber: 1, position: 1, mediumNumber: 1 }],
  quality: QUALITY,
  releaseGroup: "GROUP",
  qualityWeight: 60,
  downloadId: LIDARR_DOWNLOAD_ID,
  indexerFlags: 0,
  rejections: [],
  additionalFile: false,
  replaceExistingFiles: false,
  disableReleaseSwitching: false,
};

// Native library data the MCP layer validates explicit overrides against:
//   GET /api/v1/album/{id}   → the album's REAL artistId (album→artist check)
//   GET /api/v1/release?albumId= → the album's releases (release→album check)
// Album 9 (artist 5): releases 77 (tracks 501,502) and 78 (track 503).
// Album 10 (artist 5): release 79 (track 601). Album 11 (artist 6): release 80.
// These library albums carry a KNOWN zero file count: the non-release-switch
// tests exercise mapping/passthrough on a fresh album (a legitimate first
// import), not on an unknown-file-state album, which the release-switch guard
// now fails closed on. Release-switch tests use INCIDENT_ALBUM via incidentOpts.
const LIDARR_ARTISTS = {
  5: { id: 5, artistName: "Some Artist" },
  6: { id: 6, artistName: "Other Artist" },
};
const LIDARR_ALBUMS = {
  9: { id: 9, title: "Some Album", artistId: 5, statistics: { trackFileCount: 0, trackCount: 3, totalTrackCount: 3, sizeOnDisk: 0, percentOfTracks: 0 }, releases: [{ id: 77, albumId: 9 }, { id: 78, albumId: 9 }] },
  10: { id: 10, title: "Other Album", artistId: 5, statistics: { trackFileCount: 0, trackCount: 1, totalTrackCount: 1, sizeOnDisk: 0, percentOfTracks: 0 }, releases: [{ id: 79, albumId: 10 }] },
  11: { id: 11, title: "Foreign Album", artistId: 6, statistics: { trackFileCount: 0, trackCount: 1, totalTrackCount: 1, sizeOnDisk: 0, percentOfTracks: 0 }, releases: [{ id: 80, albumId: 11 }] },
};

// --- release-switch incident fixture (Adele "21": 17-track deluxe → 11-track standard) --
//
// Reproduces the real incident the safety guard prevents. Album 9 has a
// currently-monitored 17-track release (100, all with files) and an
// unmonitored 11-track release (200). The 11 standard tracks share their
// MusicBrainz recording ids (rec-1..rec-11) with the first 11 deluxe tracks;
// the deluxe release has 6 recordings (rec-12..rec-17) the standard lacks.
// Importing the 11 standard files as release 200 would silently switch the
// album's monitored edition — the exact destructive outcome the guard blocks.
const INCIDENT_ALBUM = {
  id: 9,
  title: "21",
  artistId: 5,
  anyReleaseOk: true,
  statistics: { trackFileCount: 17, trackCount: 17, totalTrackCount: 17, sizeOnDisk: 0, percentOfTracks: 100 },
  releases: [
    { id: 100, albumId: 9, foreignReleaseId: "REL-100", title: "Deluxe Edition", status: "Official", duration: 0, trackCount: 17, monitored: true },
    { id: 200, albumId: 9, foreignReleaseId: "REL-200", title: "Standard Edition", status: "Official", duration: 0, trackCount: 11, monitored: false },
  ],
};
const INCIDENT_RELEASE_CATALOG = {
  100: Array.from({ length: 17 }, (_, i) => ({ id: 1001 + i, foreignRecordingId: `rec-${i + 1}`, trackFileId: 9001 + i, hasFile: true })),
  200: Array.from({ length: 11 }, (_, i) => ({ id: 2001 + i, foreignRecordingId: `rec-${i + 1}`, trackFileId: null, hasFile: false })),
};
const INCIDENT_CANDIDATES = Array.from({ length: 11 }, (_, i) => ({
  id: 400 + i,
  path: `/downloads/complete/Adele/21 (Standard)/${String(i + 1).padStart(2, "0")} - Track ${i + 1}.flac`,
  name: `0${i + 1} - Track ${i + 1}`,
  size: 700,
  artist: { id: 5, artistName: "Adele" },
  album: { id: 9, title: "21" },
  albumReleaseId: 200,
  tracks: [{ id: 2001 + i, title: `Track ${i + 1}`, trackNumber: i + 1, position: i + 1, mediumNumber: 1, foreignRecordingId: `rec-${i + 1}` }],
  quality: QUALITY,
  releaseGroup: "GROUP",
  qualityWeight: 60,
  downloadId: LIDARR_DOWNLOAD_ID,
  indexerFlags: 0,
  rejections: [{ reason: "Album match is not close enough", type: "permanent" }],
  additionalFile: false,
  replaceExistingFiles: false,
  disableReleaseSwitching: false,
}));
const INCIDENT_CANDIDATE_TRACKS = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [400 + i, [2001 + i]]));
const incidentOpts = (extra = {}) => ({
  lidarrAlbums: { 9: INCIDENT_ALBUM },
  lidarrReleaseTrackCatalog: INCIDENT_RELEASE_CATALOG,
  lidarrCandidates: INCIDENT_CANDIDATES,
  lidarrCandidateTracks: INCIDENT_CANDIDATE_TRACKS,
  ...extra,
});

// --- stub *arr apps -------------------------------------------------------

function safeJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function startStub(routes, dynamic = []) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const entry = {
      method: req.method,
      path: url.pathname,
      params: Object.fromEntries(url.searchParams),
      body: raw ? safeJson(raw) : null,
    };
    requests.push(entry);
    const route = routes[`${req.method} ${url.pathname}`]
      ?? dynamic.find((d) => d.method === req.method && d.pattern.test(url.pathname))?.handler;
    if (!route) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `unrouted ${req.method} ${url.pathname}` }));
      return;
    }
    const result = route(entry);
    res.writeHead(result.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(result.json ?? {}));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, requests, base: `http://127.0.0.1:${server.address().port}` }),
    );
  });
}

// Sonarr reprocess: mirrors ManualImportService.ReprocessItem (v5-develop) —
//   episodeIds present  → _episodeService.GetEpisodes(episodeIds), a GLOBAL
//                         lookup by id paired with the supplied seriesId. Sonarr
//                         does NOT check that the episodes belong to the series.
//   no episodeIds, season → ImportRejection(NoEpisodes, "Episodes not selected")
//   neither             → ProcessFile: re-parse the path against the series.
// The response echoes the request items with recalculated fields and
// episodeIds cleared, exactly the shape the MCP layer consumes.
function catalogEpisode(catalog, id) {
  for (const list of Object.values(catalog)) {
    const found = list.find((e) => e.id === id);
    if (found) return found;
  }
  return null;
}

function parseSeasonEpisode(text) {
  const m = /[Ss](\d{1,2})[Ee](\d{1,3})/.exec(text ?? "");
  return m ? { seasonNumber: Number(m[1]), episodeNumber: Number(m[2]) } : null;
}

function sonarrReprocess(items, opts) {
  // Sonarr computes qualityWeight/customFormatScore server-side from the
  // release during reprocess; the stub echoes the discovery candidate's
  // values (the reprocess payload does not carry them).
  const byId = Object.fromEntries((opts.sonarrCandidates ?? [SONARR_CANDIDATE]).map((c) => [c.id, c]));
  const catalog = opts.sonarrEpisodeCatalog ?? SONARR_EPISODE_CATALOG;

  return items.map((item) => {
    const episodeIds = item.episodeIds ?? [];
    let episodes;
    let nativeRejections = [];

    if (episodeIds.length > 0) {
      episodes = episodeIds.map((id) => catalogEpisode(catalog, id) ?? {
        id,
        seriesId: item.seriesId,
        seasonNumber: item.seasonNumber ?? 0,
        episodeNumber: 3,
        title: `Episode ${id}`,
        hasFile: false,
        episodeFileId: null,
      });
    } else if (item.seasonNumber !== null && item.seasonNumber !== undefined) {
      episodes = [];
      nativeRejections = [{ reason: "Episodes not selected", type: "permanent" }];
    } else {
      const parsed = parseSeasonEpisode(item.name ?? item.path);
      const season = parsed ? catalog[`${item.seriesId}:${parsed.seasonNumber}`] ?? [] : [];
      episodes = parsed ? season.filter((e) => e.episodeNumber === parsed.episodeNumber) : [];
      nativeRejections = episodes.length === 0
        ? [{ reason: "Unable to parse episode info from path", type: "permanent" }]
        : [];
    }

    return {
      ...item,
      episodes,
      seasonNumber: episodes.length > 0 ? episodes[0].seasonNumber : (item.seasonNumber ?? null),
      rejections: [...nativeRejections, ...(opts.reprocessRejections ?? [])],
      customFormats: byId[item.id]?.customFormats ?? [],
      customFormatScore: byId[item.id]?.customFormatScore ?? 0,
      qualityWeight: byId[item.id]?.qualityWeight ?? 0,
      episodeIds: null,
    };
  });
}

function radarrReprocess(items, opts) {
  return items.map((item) => ({
    ...item,
    // Real Radarr resolves item.Movie from the supplied MovieId
    // (ReprocessItems: processedItem.Movie.ToResource(0)). The
    // radarrReprocessNoMovie option models a response WITHOUT the movie
    // object — the defensive case where the MCP layer must resolve the
    // effective movie itself, never reuse the candidate's title.
    movie: item.movieId > 0 && !opts.radarrReprocessNoMovie
      ? { id: item.movieId, title: `Movie ${item.movieId}`, year: 2026 }
      : null,
    rejections: opts.reprocessRejections ?? [],
    customFormats: [],
    customFormatScore: 0,
  }));
}

// Lidarr UpdateItems: the native ManualImportUpdateResource has NO trackIds
// field — the backend re-runs the import decision with the artist/album/release
// overrides and RECOMPUTES tracks server-side. Track selection is validated
// against the selected album RELEASE's track list (GET /track?albumReleaseId=
// → GetTracksByRelease), mirroring the native Interactive Import selector.
// Album 9 has release 77 (tracks 501, 502) and release 78 (track 503).
function lidarrReleaseTracks(opts) {
  return opts.lidarrReleaseTracks ?? { 77: [501, 502], 78: [503], 79: [601], 80: [701] };
}

// Full track objects for a release. When opts.lidarrReleaseTrackCatalog supplies
// rich tracks (with foreignRecordingId / trackFileId / hasFile) for a release,
// use them verbatim; otherwise synthesize minimal ones from the id list, exactly
// as before. The release-switch analysis needs foreignRecordingId (cross-edition
// identity) and trackFileId/hasFile (existing-file state), so the incident
// fixtures supply a catalog.
function lidarrTracksForRelease(releaseId, opts) {
  const catalog = opts.lidarrReleaseTrackCatalog;
  if (catalog && catalog[releaseId]) {
    return catalog[releaseId].map((t) => ({
      artistId: 5,
      albumId: 9,
      albumReleaseId: releaseId,
      title: `Track ${t.id}`,
      trackNumber: 1,
      position: 1,
      mediumNumber: 1,
      ...t,
    }));
  }
  return (lidarrReleaseTracks(opts)[releaseId] ?? []).map((id) => ({
    id,
    artistId: 5,
    albumId: 9,
    albumReleaseId: releaseId,
    title: `Track ${id}`,
    trackNumber: 1,
    position: 1,
    mediumNumber: 1,
  }));
}

function lidarrTrackResourcesForRelease(releaseId, opts) {
  return lidarrTracksForRelease(releaseId, opts);
}

// Resolve a track id to its full object (used for the server-side recomputed
// tracks in lidarrUpdate, so they carry foreignRecordingId when a catalog is set).
function lidarrTrackById(id, opts) {
  const catalog = opts.lidarrReleaseTrackCatalog ?? {};
  for (const list of Object.values(catalog)) {
    const found = list.find((t) => t.id === id);
    if (found) {
      return { artistId: 5, albumId: 9, title: `Track ${id}`, trackNumber: 1, position: 1, mediumNumber: 1, ...found };
    }
  }
  return { id, artistId: 5, albumId: 9, title: `Track ${id}`, trackNumber: 1, position: 1, mediumNumber: 1 };
}

function lidarrUpdate(items, opts) {
  // The update response's tracks are Lidarr's server-side recomputation.
  // opts.lidarrRecomputedTracks can inject a recomputed set that differs from
  // the release's track query (the native mapping/release-list inconsistency
  // the MCP layer must surface, not authorize).
  const artists = opts.lidarrArtists ?? LIDARR_ARTISTS;
  const albums = opts.lidarrAlbums ?? LIDARR_ALBUMS;
  // Per-candidate recomputation (opts.lidarrCandidateTracks) models a multi-file
  // release where each file maps to its own single track; otherwise the stub
  // recomputes the whole release's track list for every item.
  const recomputedFor = (item, releaseId) =>
    opts.lidarrCandidateTracks?.[item.id]
    ?? (opts.lidarrRecomputedTracks ?? lidarrReleaseTracks(opts))[releaseId]
    ?? lidarrReleaseTracks(opts)[releaseId]
    ?? [];
  return items.map((item) => {
    // Native precedence (CandidateService.GetDbCandidatesFromTags): a forced
    // release wins; with only an album forced, the backend picks a release of
    // that album; with neither, it re-identifies from the files (the stub
    // models "no identification" as null).
    const album = item.albumId ? albums[item.albumId] ?? null : null;
    let releaseId = item.albumReleaseId ?? 0;
    if (!releaseId && album) releaseId = album.releases?.[0]?.id ?? 0;
    const artist = item.artistId ? artists[item.artistId] ?? { id: item.artistId, artistName: `Artist ${item.artistId}` } : null;
    return {
      id: item.id,
      path: item.path,
      name: item.name,
      size: 700,
      artist: artist ? { id: artist.id, artistName: artist.artistName } : null,
      album: album ? { id: album.id, title: album.title } : null,
      albumReleaseId: releaseId,
      tracks: recomputedFor(item, releaseId).map((id) => ({
        ...lidarrTrackById(id, opts),
        albumReleaseId: releaseId,
        albumId: album?.id ?? 0,
        artistId: album?.artistId ?? 5,
      })),
      quality: item.quality,
      releaseGroup: item.releaseGroup,
      qualityWeight: 60,
      downloadId: item.downloadId,
      indexerFlags: item.indexerFlags,
      rejections: opts.reprocessRejections ?? [],
      additionalFile: item.additionalFile ?? false,
      replaceExistingFiles: item.replaceExistingFiles ?? false,
      disableReleaseSwitching: item.disableReleaseSwitching ?? false,
    };
  });
}

function buildRoutes(opts) {
  const sonarr = {
    "GET /api/v3/manualimport": (e) => ({
      json: e.params.downloadId === SONARR_DOWNLOAD_ID ? (opts.sonarrCandidates ?? [SONARR_CANDIDATE]) : [],
    }),
    "POST /api/v3/manualimport": (e) => ({ json: sonarrReprocess(e.body, opts) }),
    "POST /api/v3/command": () => ({ json: { id: opts.commandId ?? 987, name: "ManualImport", status: "queued" } }),
    // Query-aware: GET /api/v3/episode?seriesId=&seasonNumber= returns that
    // season's episodes, like the native endpoint the episode picker uses.
    "GET /api/v3/episode": (e) => ({
      json: opts.sonarrEpisodesWithFiles
        ?? (opts.sonarrEpisodeCatalog ?? SONARR_EPISODE_CATALOG)[`${e.params.seriesId}:${e.params.seasonNumber}`]
        ?? [],
    }),
    "GET /api/v3/episodefile": () => ({ json: opts.sonarrEpisodeFilesList ?? [] }),
    "GET /api/v3/queue": () => ({ json: opts.sonarrQueue ?? { records: [], totalRecords: 0 } }),
    "GET /api/v3/qualityprofile": () => ({ json: opts.sonarrQualityProfiles ?? [] }),
  };
  // GET /api/v3/series/{id} — the real title of an overridden series.
  const sonarrDynamic = [
    {
      method: "GET",
      pattern: /^\/api\/v3\/series\/\d+$/,
      handler: (e) => {
        const id = Number(e.path.split("/").pop());
        const series = (opts.sonarrSeries ?? SONARR_SERIES)[id];
        return series ? { json: series } : { status: 404, json: { message: `series ${id} not found` } };
      },
    },
  ];
  const radarr = {
    "GET /api/v3/manualimport": (e) => ({
      json: e.params.downloadId === "dl-11" ? (opts.radarrCandidates ?? [RADARR_CANDIDATE]) : [],
    }),
    "POST /api/v3/manualimport": (e) => ({ json: radarrReprocess(e.body, opts) }),
    "POST /api/v3/command": () => ({ json: { id: opts.radarrCommandId ?? 777, name: "ManualImport", status: "queued" } }),
    "GET /api/v3/queue": () => ({ json: { records: [], totalRecords: 0 } }),
  };
  // GET /api/v3/movie/{id} — the real title of an overridden movie.
  const radarrDynamic = [
    {
      method: "GET",
      pattern: /^\/api\/v3\/movie\/\d+$/,
      handler: (e) => {
        const id = Number(e.path.split("/").pop());
        const movie = (opts.radarrMovies ?? RADARR_MOVIES)[id];
        return movie ? { json: movie } : { status: 404, json: { message: `movie ${id} not found` } };
      },
    },
  ];
  const lidarr = {
    "GET /api/v1/manualimport": (e) => ({
      json: e.params.downloadId === LIDARR_DOWNLOAD_ID ? (opts.lidarrCandidates ?? [LIDARR_CANDIDATE]) : [],
    }),
    "POST /api/v1/manualimport": (e) => ({ json: lidarrUpdate(e.body, opts) }),
    "POST /api/v1/command": () => ({ json: { id: opts.lidarrCommandId ?? 654, name: "ManualImport", status: "queued" } }),
    "GET /api/v1/track": (e) => ({ json: lidarrTrackResourcesForRelease(Number(e.params.albumReleaseId), opts) }),
    "GET /api/v1/album": (e) => ({
      json: Object.values(opts.lidarrAlbums ?? LIDARR_ALBUMS).filter((a) => !e.params.artistId || a.artistId === Number(e.params.artistId)),
    }),
    "GET /api/v1/queue": () => ({ json: { records: [], totalRecords: 0 } }),
  };
  // GET /api/v1/album/{id} — the native source for BOTH relationship checks:
  // the album's REAL artistId (album→artist) and its embedded releases
  // (release→album). GET /api/v1/release?albumId= is the indexer release-SEARCH
  // endpoint (guid/quality/age), NOT the album's own releases — the MCP must
  // not use it for validation.
  const lidarrDynamic = [
    {
      method: "GET",
      pattern: /^\/api\/v1\/album\/\d+$/,
      handler: (e) => {
        const id = Number(e.path.split("/").pop());
        if (opts.lidarrAlbumLookupError) {
          return { status: opts.lidarrAlbumLookupError, json: { message: `album ${id} lookup failed` } };
        }
        const album = (opts.lidarrAlbums ?? LIDARR_ALBUMS)[id];
        return album ? { json: album } : { status: 404, json: { message: `album ${id} not found` } };
      },
    },
  ];
  return { sonarr, radarr, radarrDynamic, lidarr, sonarrDynamic, lidarrDynamic };
}

// --- MCP harness ----------------------------------------------------------

async function waitForHealth(port) {
  const deadline = Date.now() + 5000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`HTTP server did not become healthy: ${lastError}`);
}

function postMcp(port, payload) {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(payload),
  });
}

async function mcpEnvelope(response) {
  const text = await response.text();
  if (/^text\/event-stream/.test(response.headers.get("content-type") || "")) {
    const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
    assert.ok(dataLine, `SSE response missing data line: ${text}`);
    return JSON.parse(dataLine.slice("data: ".length));
  }
  return JSON.parse(text);
}

async function callTool(port, name, args) {
  const response = await postMcp(port, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name, arguments: args },
  });
  assert.equal(response.status, 200);
  const body = await mcpEnvelope(response);
  assert.equal(body.error, undefined, `tools/call ${name} must not return a JSON-RPC error: ${JSON.stringify(body.error)}`);
  const text = body.result.content[0].text;
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    /* error strings are not JSON */
  }
  return { isError: body.result.isError === true, payload, text };
}

// Boots the MCP server against three stub apps; `fn` receives the MCP port
// and the per-service request logs.
async function withServers(opts, fn) {
  const port = String(34000 + Math.floor(Math.random() * 1000));
  const routes = buildRoutes(opts);
  const sonarrStub = await startStub(routes.sonarr, routes.sonarrDynamic);
  const radarrStub = await startStub(routes.radarr, routes.radarrDynamic);
  const lidarrStub = await startStub(routes.lidarr, routes.lidarrDynamic);

  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      MCP_TRANSPORT: "http",
      HOST: "127.0.0.1",
      PORT: port,
      SONARR_URL: sonarrStub.base,
      SONARR_API_KEY: "sonarr-key",
      RADARR_URL: radarrStub.base,
      RADARR_API_KEY: "radarr-key",
      LIDARR_URL: lidarrStub.base,
      LIDARR_API_KEY: "lidarr-key",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  try {
    await waitForHealth(port);
    const initResponse = await postMcp(port, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "mcp-arr-test", version: "0.0.0" },
      },
    });
    assert.equal(initResponse.status, 200);
    await fn(port, {
      sonarr: sonarrStub.requests,
      radarr: radarrStub.requests,
      lidarr: lidarrStub.requests,
    });
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit").catch(() => {});
    sonarrStub.server.close();
    radarrStub.server.close();
    lidarrStub.server.close();
  }
}

function requestsTo(log, method, path) {
  return log.filter((r) => r.method === method && r.path === path);
}

// --- 1/2. candidate discovery --------------------------------------------

test("sonarr_get_manual_import_candidates: native GET /api/v3/manualimport scoped to downloadId", async () => {
  await withServers({}, async (port, logs) => {
    const result = await callTool(port, "sonarr_get_manual_import_candidates", { downloadId: SONARR_DOWNLOAD_ID });
    assert.equal(result.isError, false, result.text);

    const gets = requestsTo(logs.sonarr, "GET", "/api/v3/manualimport");
    assert.equal(gets.length, 1, "discovery must use the native manualimport endpoint");
    assert.equal(gets[0].params.downloadId, SONARR_DOWNLOAD_ID, "discovery must be constrained to downloadId");
    assert.ok(!("path" in gets[0].params) && !("folder" in gets[0].params), "no caller-supplied path/folder is sent");

    assert.equal(result.payload.count, 1);
    assert.ok(Array.isArray(result.payload.verifyBeforeActing) && result.payload.verifyBeforeActing.length >= 2, "discovery leads with the verify-before-acting directive");
    assert.match(
      JSON.stringify(result.payload.verifyBeforeActing),
      /parse PROPOSAL/i,
      "directive states the mapping is a proposal, not verified fact",
    );
    assert.doesNotMatch(
      JSON.stringify(result.payload.verifyBeforeActing),
      /is the verification key|trust the mapping|almost NEVER a correctly mapped/i,
      "directive must not encode single-incident heuristics as universal rules",
    );
    const c = result.payload.candidates[0];
    assert.equal(c.candidateId, 123, "candidateId is the native resource id");
    assert.equal(c.path, SONARR_CANDIDATE.path, "path is returned for display only");
    assert.deepEqual(c.series, { id: 47, title: "The Good Fight" }, "compact series identity");
    assert.deepEqual(c.episodes, [{ id: 9001, seasonNumber: 6, episodeNumber: 3, title: "The End of Football" }]);
    assert.deepEqual(c.rejections, [{ reason: "Unable to determine if file is a sample", type: "temporary" }], "rejections kept structured");
    assert.deepEqual(c.quality, QUALITY);
    assert.deepEqual(c.languages, LANGUAGES);
    assert.equal(c.releaseType, "episode");
  });
});

test("radarr/lidarr discovery: correct native endpoints and params", async () => {
  await withServers({}, async (port, logs) => {
    const radarr = await callTool(port, "radarr_get_manual_import_candidates", { downloadId: "dl-11", movieId: 11 });
    assert.equal(radarr.isError, false, radarr.text);
    const rGets = requestsTo(logs.radarr, "GET", "/api/v3/manualimport");
    assert.equal(rGets[0].params.downloadId, "dl-11");
    assert.equal(rGets[0].params.movieId, "11", "movie hint passed to native endpoint");
    assert.equal(radarr.payload.candidates[0].movie.id, 11);

    const lidarr = await callTool(port, "lidarr_get_manual_import_candidates", { downloadId: LIDARR_DOWNLOAD_ID, artistId: 5 });
    assert.equal(lidarr.isError, false, lidarr.text);
    const lGets = requestsTo(logs.lidarr, "GET", "/api/v1/manualimport");
    assert.equal(lGets.length, 1);
    assert.equal(lGets[0].params.downloadId, LIDARR_DOWNLOAD_ID);
    assert.equal(lGets[0].params.artistId, "5");
    assert.equal(lGets[0].params.replaceExistingFiles, "false", "discovery defaults to the safer non-destructive mode");
    const c = lidarr.payload.candidates[0];
    assert.deepEqual(c.artist, { id: 5, artistName: "Some Artist" });
    assert.deepEqual(c.album, { id: 9, title: "Some Album" });
    assert.equal(c.albumReleaseId, 77);
    assert.equal(c.tracks[0].id, 501);
  });
});

test("discovery for an untracked downloadId yields zero candidates; preview/execute refuse", async () => {
  await withServers({}, async (port) => {
    const get = await callTool(port, "sonarr_get_manual_import_candidates", { downloadId: "not-tracked" });
    assert.equal(get.isError, false);
    assert.equal(get.payload.count, 0);

    const preview = await callTool(port, "sonarr_preview_manual_import", {
      downloadId: "not-tracked",
      items: [{ candidateId: 123 }],
    });
    assert.equal(preview.isError, true);
    assert.match(preview.text, /no manual-import candidates/i);

    const exec = await callTool(port, "sonarr_execute_manual_import", {
      downloadId: "not-tracked",
      items: [{ candidateId: 123 }],
    });
    assert.equal(exec.isError, true);
    assert.match(exec.text, /no manual-import candidates/i);
  });
});

// --- 5/8. preview merges overrides and never imports ----------------------

test("sonarr_preview_manual_import: merges overrides onto fresh candidate values, never sends a command", async () => {
  await withServers({ reprocessRejections: [{ reason: "Unable to determine if file is a sample", type: "temporary" }] }, async (port, logs) => {
    const result = await callTool(port, "sonarr_preview_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 123, seriesId: 47, seasonNumber: 6, episodeIds: [9001] }],
    });
    assert.equal(result.isError, false, result.text);

    const posts = requestsTo(logs.sonarr, "POST", "/api/v3/manualimport");
    assert.equal(posts.length, 1, "preview must reprocess through the native endpoint");
    const sent = posts[0].body[0];
    assert.equal(sent.id, 123);
    assert.equal(sent.path, SONARR_CANDIDATE.path, "path comes from the native candidate");
    assert.equal(sent.seriesId, 47, "override merged");
    assert.equal(sent.seasonNumber, 6, "override merged");
    assert.deepEqual(sent.episodeIds, [9001], "override merged");
    assert.deepEqual(sent.quality, QUALITY, "quality preserved from candidate, not required from caller");
    assert.deepEqual(sent.languages, LANGUAGES, "languages preserved from candidate");
    assert.equal(sent.releaseGroup, "NTb", "release group preserved when not overridden");
    assert.equal(sent.releaseType, "episode", "release type preserved from candidate");
    assert.equal(sent.downloadId, SONARR_DOWNLOAD_ID);

    assert.equal(requestsTo(logs.sonarr, "POST", "/api/v3/command").length, 0, "preview must never send a ManualImport command");

    assert.ok(Array.isArray(result.payload.verifyBeforeActing), "preview leads with the verify-before-acting directive");
    assert.match(JSON.stringify(result.payload.verifyBeforeActing), /NOT verified facts/i, "directive tells agents to verify the mapping, not trust it");

    const item = result.payload.items[0];
    assert.equal(item.candidateId, 123);
    assert.equal(item.seasonNumber, 6);
    assert.equal(item.episodes[0].id, 9001);
    assert.deepEqual(item.rejections, [{ reason: "Unable to determine if file is a sample", type: "temporary" }]);
    assert.equal(item.mappingValid, true);
    assert.equal(item.canExecuteWithoutOverride, false, "remaining rejections mean execute needs allowRejected");
  });
});

test("preview with overrides on an unmapped candidate: mapping becomes valid after reprocess", async () => {
  const unmapped = { ...SONARR_CANDIDATE, id: 125, series: null, seasonNumber: null, episodes: [], rejections: [{ reason: "Invalid release", type: "permanent" }] };
  await withServers({ sonarrCandidates: [unmapped], reprocessRejections: [{ reason: "Invalid release", type: "permanent" }] }, async (port) => {
    const result = await callTool(port, "sonarr_preview_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 125, seriesId: 47, seasonNumber: 6, episodeIds: [9001] }],
    });
    assert.equal(result.isError, false, result.text);
    const item = result.payload.items[0];
    assert.equal(item.series.id, 47);
    assert.equal(item.episodes[0].id, 9001);
    assert.equal(item.mappingValid, true);
    assert.equal(item.canExecuteWithoutOverride, false, "stub reprocess echoes the scripted rejection");
  });
});

test("preview refuses a candidateId that is not in the fresh native list", async () => {
  await withServers({}, async (port, logs) => {
    const result = await callTool(port, "sonarr_preview_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 999 }],
    });
    assert.equal(result.isError, true);
    assert.match(result.text, /candidateId 999/);
    assert.equal(requestsTo(logs.sonarr, "POST", "/api/v3/manualimport").length, 0, "unresolved candidate must not be reprocessed");
    assert.equal(requestsTo(logs.sonarr, "POST", "/api/v3/command").length, 0);
  });
});

// --- 3/4/9/12/13/15/16. execute orchestration -----------------------------

test("sonarr_execute_manual_import: fresh GET -> resolve -> reprocess -> command with explicit importMode=auto", async () => {
  await withServers({ reprocessRejections: [] }, async (port, logs) => {
    const result = await callTool(port, "sonarr_execute_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 123, seriesId: 47, seasonNumber: 6, episodeIds: [9001] }],
    });
    assert.equal(result.isError, false, result.text);

    // Order: discovery, episode-id validation, reprocess, command — reprocess
    // happens immediately before command submission, on every execute.
    const methods = logs.sonarr.map((r) => `${r.method} ${r.path}`);
    assert.deepEqual(methods, [
      "GET /api/v3/manualimport",
      "GET /api/v3/episode",
      "POST /api/v3/manualimport",
      "POST /api/v3/command",
    ]);
    const validation = requestsTo(logs.sonarr, "GET", "/api/v3/episode")[0];
    assert.equal(validation.params.seriesId, "47", "explicit episodeIds are validated against the effective series");
    assert.equal(validation.params.seasonNumber, "6", "…and the effective season");

    const command = requestsTo(logs.sonarr, "POST", "/api/v3/command")[0].body;
    assert.equal(command.name, "ManualImport");
    assert.equal(command.importMode, "auto", "importMode is always sent explicitly; default auto");
    const file = command.files[0];
    assert.equal(file.path, SONARR_CANDIDATE.path, "path comes from the native candidate");
    assert.equal(file.folderName, SONARR_CANDIDATE.folderName);
    assert.equal(file.seriesId, 47);
    assert.deepEqual(file.episodeIds, [9001]);
    assert.deepEqual(file.quality, QUALITY);
    assert.deepEqual(file.languages, LANGUAGES);
    assert.equal(file.releaseType, "episode");
    assert.equal(file.downloadId, SONARR_DOWNLOAD_ID);

    assert.equal(result.payload.commandId, 987, "returns the command id");
    assert.equal(result.payload.status, "queued", "acceptance is queued, not completed");
    assert.match(result.payload.message, /asynchronously/, "response describes async completion");
    assert.equal(requestsTo(logs.sonarr, "DELETE", "/api/v3/queue/123").length, 0, "no automatic queue deletion");
    assert.equal(logs.sonarr.filter((r) => r.method === "DELETE").length, 0, "no queue removal of any kind");
  });
});

test("execute never imports a caller-supplied path: extra path fields are ignored", async () => {
  await withServers({ reprocessRejections: [] }, async (port, logs) => {
    const result = await callTool(port, "sonarr_execute_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 123, path: "/some/arbitrary/evil.mkv", episodeIds: [9001] }],
    });
    assert.equal(result.isError, false, result.text);
    const command = requestsTo(logs.sonarr, "POST", "/api/v3/command")[0].body;
    assert.equal(command.files[0].path, SONARR_CANDIDATE.path, "only the native candidate path is imported");
    assert.ok(!command.files.some((f) => f.path.includes("evil")), "caller path must not reach the command");
  });
});

test("execute re-resolves candidateIds against the fresh list; stale ids fail before any command", async () => {
  await withServers({ reprocessRejections: [] }, async (port, logs) => {
    const result = await callTool(port, "sonarr_execute_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 999 }],
    });
    assert.equal(result.isError, true);
    assert.match(result.text, /candidateId 999/);
    assert.equal(requestsTo(logs.sonarr, "POST", "/api/v3/command").length, 0);
  });
});

test("execute honors an explicit importMode (copy)", async () => {
  await withServers({ reprocessRejections: [] }, async (port, logs) => {
    const result = await callTool(port, "sonarr_execute_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 123 }],
      importMode: "copy",
    });
    assert.equal(result.isError, false, result.text);
    const command = requestsTo(logs.sonarr, "POST", "/api/v3/command")[0].body;
    assert.equal(command.importMode, "copy");
  });
});

// --- 10/11. rejection gating ----------------------------------------------

test("remaining rejections block execute by default and are returned with guidance", async () => {
  await withServers({ reprocessRejections: [{ reason: "Unable to determine if file is a sample", type: "temporary" }] }, async (port, logs) => {
    // Stub candidate has no rejections at discovery; the reprocess response
    // (the authoritative decision) carries the sample-indeterminate rejection.
    const result = await callTool(port, "sonarr_execute_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 123 }],
    });
    assert.equal(result.isError, true, "rejections must block execution without opt-in");
    assert.equal(requestsTo(logs.sonarr, "POST", "/api/v3/command").length, 0, "blocked execute must not submit a command");
    assert.equal(result.payload.blocked[0].candidateId, 123);
    assert.deepEqual(result.payload.blocked[0].rejections, [
      { reason: "Unable to determine if file is a sample", type: "temporary" },
    ]);
    assert.match(JSON.stringify(result.payload.guidance), /allowRejected=true/);
  });
});

test("item-level allowRejected=true permits the manual override and reports overridden rejections", async () => {
  await withServers({ reprocessRejections: [{ reason: "Unable to determine if file is a sample", type: "temporary" }] }, async (port, logs) => {
    const result = await callTool(port, "sonarr_execute_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 123, allowRejected: true }],
    });
    assert.equal(result.isError, false, result.text);
    const command = requestsTo(logs.sonarr, "POST", "/api/v3/command")[0].body;
    assert.equal(command.files.length, 1);
    assert.equal(result.payload.overriddenRejections.length, 1);
    assert.equal(result.payload.overriddenRejections[0].rejections[0].reason, "Unable to determine if file is a sample");
  });
});

test("per-candidate rejection authorization: allowRejected=true on B does not authorize rejected A", async () => {
  await withServers(
    {
      sonarrCandidates: [SONARR_CANDIDATE, SONARR_CANDIDATE_2],
      reprocessRejections: [{ reason: "Unable to determine if file is a sample", type: "temporary" }],
    },
    async (port, logs) => {
      const result = await callTool(port, "sonarr_execute_manual_import", {
        downloadId: SONARR_DOWNLOAD_ID,
        items: [
          { candidateId: 123 }, // rejected, NOT authorized
          { candidateId: 124, allowRejected: true }, // rejected, authorized
        ],
      });
      assert.equal(result.isError, true, "a non-authorized rejected candidate must block the command");
      const blockedIds = result.payload.blocked.map((b) => b.candidateId);
      assert.deepEqual(blockedIds, [123], "only the non-authorized candidate is blocked; B's authorization must not leak to A");
      assert.equal(requestsTo(logs.sonarr, "POST", "/api/v3/command").length, 0, "no command while a blocked candidate remains");
    },
  );
});

test("per-candidate allowRejected=true on every rejected item permits the multi-file command", async () => {
  await withServers(
    {
      sonarrCandidates: [SONARR_CANDIDATE, SONARR_CANDIDATE_2],
      reprocessRejections: [{ reason: "Unable to determine if file is a sample", type: "temporary" }],
    },
    async (port, logs) => {
      const result = await callTool(port, "sonarr_execute_manual_import", {
        downloadId: SONARR_DOWNLOAD_ID,
        items: [
          { candidateId: 123, allowRejected: true },
          { candidateId: 124, allowRejected: true },
        ],
      });
      assert.equal(result.isError, false, result.text);
      const command = requestsTo(logs.sonarr, "POST", "/api/v3/command")[0].body;
      assert.equal(command.files.length, 2);
      assert.equal(result.payload.overriddenRejections.length, 2);
    },
  );
});

// --- native UI safeguards -------------------------------------------------

test("sonarr duplicate-episode safeguard: two files mapped to the same episode are refused", async () => {
  await withServers({ sonarrCandidates: [SONARR_CANDIDATE, SONARR_CANDIDATE_2], reprocessRejections: [] }, async (port, logs) => {
    const result = await callTool(port, "sonarr_execute_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [
        { candidateId: 123, episodeIds: [9001] },
        { candidateId: 124, episodeIds: [9001] },
      ],
    });
    assert.equal(result.isError, true);
    assert.match(result.text, /Episode 9001 is mapped to both/);
    assert.equal(requestsTo(logs.sonarr, "POST", "/api/v3/command").length, 0);
  });
});

test("sonarr execute refuses a candidate with no episode mapping", async () => {
  const unmapped = { ...SONARR_CANDIDATE, id: 126, series: null, seasonNumber: null, episodes: [] };
  await withServers({ sonarrCandidates: [unmapped], reprocessRejections: [] }, async (port, logs) => {
    const result = await callTool(port, "sonarr_execute_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 126 }],
    });
    assert.equal(result.isError, true);
    assert.match(result.text, /no valid series mapping|no episode mapping/);
    assert.equal(requestsTo(logs.sonarr, "POST", "/api/v3/command").length, 0);
  });
});

// --- 6. Radarr -------------------------------------------------------------

test("radarr_execute_manual_import: movie override merged, native command shape, importMode explicit", async () => {
  await withServers({}, async (port, logs) => {
    const preview = await callTool(port, "radarr_preview_manual_import", {
      downloadId: "dl-11",
      items: [{ candidateId: 222, movieId: 11 }],
    });
    assert.equal(preview.isError, false, preview.text);
    assert.equal(requestsTo(logs.radarr, "POST", "/api/v3/command").length, 0, "preview never imports");
    assert.equal(preview.payload.items[0].movie.id, 11);
    assert.equal(preview.payload.items[0].canExecuteWithoutOverride, true);

    const result = await callTool(port, "radarr_execute_manual_import", {
      downloadId: "dl-11",
      items: [{ candidateId: 222, movieId: 11 }],
    });
    assert.equal(result.isError, false, result.text);

    const methods = logs.radarr.map((r) => `${r.method} ${r.path}`);
    assert.deepEqual(methods.slice(-3), [
      "GET /api/v3/manualimport",
      "POST /api/v3/manualimport",
      "POST /api/v3/command",
    ]);

    const command = requestsTo(logs.radarr, "POST", "/api/v3/command")[0].body;
    assert.equal(command.name, "ManualImport");
    assert.equal(command.importMode, "auto");
    const file = command.files[0];
    assert.equal(file.path, RADARR_CANDIDATE.path);
    assert.equal(file.folderName, RADARR_CANDIDATE.folderName);
    assert.equal(file.movieId, 11);
    assert.deepEqual(file.quality, QUALITY);
    assert.deepEqual(file.languages, LANGUAGES);
    assert.equal(file.releaseGroup, "SM", "release group preserved from the reprocessed candidate");
    assert.equal(result.payload.commandId, 777);
    assert.equal(result.payload.status, "queued");
  });
});

test("radarr execute refuses an unmapped candidate before command submission", async () => {
  const unmapped = { ...RADARR_CANDIDATE, id: 223, movie: null };
  await withServers({ radarrCandidates: [unmapped] }, async (port, logs) => {
    const result = await callTool(port, "radarr_execute_manual_import", {
      downloadId: "dl-11",
      items: [{ candidateId: 223 }],
    });
    assert.equal(result.isError, true);
    assert.match(result.text, /no valid movie mapping/);
    assert.equal(requestsTo(logs.radarr, "POST", "/api/v3/command").length, 0);
  });
});

test("radarr preview reports the EFFECTIVE movie, never the candidate's stale title under an overridden id", async () => {
  // The reprocess response carries no movie object (the defensive shape);
  // the MCP layer must resolve the effective movie from GET /api/v3/movie/{id}.
  await withServers({ radarrReprocessNoMovie: true }, async (port, logs) => {
    const preview = await callTool(port, "radarr_preview_manual_import", {
      downloadId: "dl-11",
      items: [{ candidateId: 222, movieId: 12 }],
    });
    assert.equal(preview.isError, false, preview.text);
    const item = preview.payload.items[0];
    assert.deepEqual(item.movie, { id: 12, title: "Second Movie", year: 2027 });
    assert.notEqual(item.movie.title, "Some Movie", "the stale Movie 11 title must never pair with Movie 12's id");
    assert.equal(requestsTo(logs.radarr, "GET", "/api/v3/movie/12").length, 1, "the effective movie is fetched from the native endpoint");

    // An unmodified candidate keeps its embedded movie — no extra lookup.
    const plain = await callTool(port, "radarr_preview_manual_import", {
      downloadId: "dl-11",
      items: [{ candidateId: 222 }],
    });
    assert.deepEqual(plain.payload.items[0].movie, { id: 11, title: "Some Movie", year: 2026 });
    assert.equal(requestsTo(logs.radarr, "GET", "/api/v3/movie/11").length, 0, "no lookup when the id is unchanged");
  });
});

test("radarr preview returns null metadata rather than a stale title when the effective movie lookup fails", async () => {
  await withServers({ radarrReprocessNoMovie: true, radarrMovies: {} }, async (port) => {
    const preview = await callTool(port, "radarr_preview_manual_import", {
      downloadId: "dl-11",
      items: [{ candidateId: 222, movieId: 12 }],
    });
    assert.equal(preview.isError, false, "a failed title lookup must not abort the preview");
    const item = preview.payload.items[0];
    assert.equal(item.movie.id, 12, "the effective id is still reported");
    assert.equal(item.movie.title, null, "no stale title is substituted for a failed lookup");
    assert.equal(item.movie.year, null);
  });
});

// --- 7/14. Lidarr ----------------------------------------------------------

test("lidarr_preview_manual_import: update payload follows native UpdateItems semantics; tracks come from the server", async () => {
  await withServers({}, async (port, logs) => {
    const result = await callTool(port, "lidarr_preview_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: [{ candidateId: 333, artistId: 5, albumId: 9, albumReleaseId: 77, trackIds: [501] }],
    });
    assert.equal(result.isError, false, result.text);

    const posts = requestsTo(logs.lidarr, "POST", "/api/v1/manualimport");
    assert.equal(posts.length, 1, "preview uses the native update endpoint");
    const sent = posts[0].body[0];
    assert.equal(sent.id, 333);
    assert.equal(sent.path, LIDARR_CANDIDATE.path, "path from the native candidate");
    assert.equal(sent.artistId, 5, "artist override merged");
    assert.equal(sent.albumId, 9, "album override merged");
    assert.equal(sent.albumReleaseId, 77, "release override merged");
    assert.equal(sent.trackIds, undefined, "native ManualImportUpdateResource has no trackIds field — caller tracks are never sent to the update endpoint");
    assert.equal(sent.replaceExistingFiles, false, "defaults to the safer non-destructive mode");
    assert.equal(sent.disableReleaseSwitching, true, "an explicit albumReleaseId defaults disableReleaseSwitching to true (native UI: selecting a release sets it; persists as album.AnyReleaseOk=false)");
    assert.equal(sent.downloadId, LIDARR_DOWNLOAD_ID);

    assert.equal(requestsTo(logs.lidarr, "POST", "/api/v1/command").length, 0, "preview never imports");

    const item = result.payload.items[0];
    assert.equal(item.artist.id, 5);
    assert.equal(item.album.id, 9);
    assert.equal(item.albumReleaseId, 77);
    assert.equal(item.tracks[0].id, 501, "tracks are the server-recomputed result");
    assert.equal(item.mappingValid, true);
    assert.equal(item.canExecuteWithoutOverride, true);
  });
});

test("lidarr_execute_manual_import: command consumes reprocessed tracks with importMode + replaceExistingFiles explicit", async () => {
  await withServers({}, async (port, logs) => {
    const result = await callTool(port, "lidarr_execute_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: [{ candidateId: 333, artistId: 5, albumId: 9, albumReleaseId: 77, trackIds: [501] }],
    });
    assert.equal(result.isError, false, result.text);

    const methods = logs.lidarr.map((r) => `${r.method} ${r.path}`);
    assert.deepEqual(methods, [
      "GET /api/v1/manualimport",
      "GET /api/v1/album/9",
      "POST /api/v1/manualimport",
      "GET /api/v1/track",
      "POST /api/v1/command",
    ], "relationship validation (album→artist + release→album from the album's embedded releases) runs before the reprocess");

    const command = requestsTo(logs.lidarr, "POST", "/api/v1/command")[0].body;
    assert.equal(command.name, "ManualImport");
    assert.equal(command.importMode, "auto", "explicit importMode, default auto");
    assert.equal(command.replaceExistingFiles, false, "default matches the Interactive Import UI (non-destructive)");
    const file = command.files[0];
    assert.equal(file.path, LIDARR_CANDIDATE.path);
    assert.equal(file.artistId, 5);
    assert.equal(file.albumId, 9);
    assert.equal(file.albumReleaseId, 77);
    assert.deepEqual(file.trackIds, [501], "trackIds taken from the reprocessed response");
    assert.deepEqual(file.quality, QUALITY);
    assert.equal(file.downloadId, LIDARR_DOWNLOAD_ID);
    assert.equal(file.disableReleaseSwitching, true, "explicit release selection carries the native disableReleaseSwitching=true default into the command");

    assert.equal(result.payload.commandId, 654);
    assert.equal(result.payload.status, "queued");
    assert.equal(logs.lidarr.filter((r) => r.method === "DELETE").length, 0, "no automatic queue deletion");
  });
});

test("lidarr replaceExistingFiles=true is passed through to discovery, update, and command", async () => {
  await withServers({}, async (port, logs) => {
    const result = await callTool(port, "lidarr_execute_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: [{ candidateId: 333 }],
      replaceExistingFiles: true,
    });
    assert.equal(result.isError, false, result.text);
    const get = requestsTo(logs.lidarr, "GET", "/api/v1/manualimport")[0];
    assert.equal(get.params.replaceExistingFiles, "true");
    const update = requestsTo(logs.lidarr, "POST", "/api/v1/manualimport")[0].body[0];
    assert.equal(update.replaceExistingFiles, true);
    const command = requestsTo(logs.lidarr, "POST", "/api/v1/command")[0].body;
    assert.equal(command.replaceExistingFiles, true);
  });
});

test("lidarr rejections ({reason, type} shape, per native Rejection.cs) block execute by default; per-item allowRejected proceeds", async () => {
  await withServers({ reprocessRejections: [{ reason: "Not a quality upgrade for existing track file(s)", type: "permanent" }] }, async (port, logs) => {
    const blocked = await callTool(port, "lidarr_execute_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: [{ candidateId: 333 }],
    });
    assert.equal(blocked.isError, true);
    assert.deepEqual(blocked.payload.blocked[0].rejections, [{ reason: "Not a quality upgrade for existing track file(s)", type: "permanent" }]);
    assert.equal(requestsTo(logs.lidarr, "POST", "/api/v1/command").length, 0);

    const allowed = await callTool(port, "lidarr_execute_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: [{ candidateId: 333, allowRejected: true }],
    });
    assert.equal(allowed.isError, false, allowed.text);
    assert.equal(requestsTo(logs.lidarr, "POST", "/api/v1/command").length, 1);
    assert.equal(allowed.payload.overriddenRejections[0].rejections[0].reason, "Not a quality upgrade for existing track file(s)");
  });
});

test("lidarr empty rejections ({} — null reason + default type, as live Lidarr serializes) are preserved structurally", async () => {
  await withServers({ lidarrCandidates: [{ ...LIDARR_CANDIDATE, rejections: [{}, { reason: "Has missing tracks", type: "permanent" }] }] }, async (port) => {
    const result = await callTool(port, "lidarr_get_manual_import_candidates", { downloadId: LIDARR_DOWNLOAD_ID });
    assert.equal(result.isError, false, result.text);
    assert.deepEqual(result.payload.candidates[0].rejections, [
      { reason: null, type: null },
      { reason: "Has missing tracks", type: "permanent" },
    ]);
  });
});

test("lidarr duplicate-track safeguard: two files mapping the same track are refused", async () => {
  const second = { ...LIDARR_CANDIDATE, id: 334, path: "/downloads/complete/Some.Artist/Some.Artist - Some Album/01 - Track One copy.flac" };
  await withServers({ lidarrCandidates: [LIDARR_CANDIDATE, second] }, async (port, logs) => {
    const result = await callTool(port, "lidarr_execute_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: [
        { candidateId: 333, trackIds: [501] },
        { candidateId: 334, trackIds: [501] },
      ],
    });
    assert.equal(result.isError, true);
    assert.match(result.text, /Track 501 is mapped to both/);
    assert.equal(requestsTo(logs.lidarr, "POST", "/api/v1/command").length, 0);
  });
});

// --- upgrade assessment (existing-file quality comparison) ----------------

test("preview upgradeAssessment: no existing file -> no-existing-file", async () => {
  await withServers({}, async (port, logs) => {
    const result = await callTool(port, "sonarr_preview_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 123 }],
    });
    assert.equal(result.isError, false, result.text);
    const a = result.payload.items[0].upgradeAssessment;
    assert.equal(a.verdict, "no-existing-file");
    const gets = requestsTo(logs.sonarr, "GET", "/api/v3/episode");
    assert.equal(gets.length, 1, "assessment queries the native episode endpoint (the only shape mapping files to episodes)");
    assert.equal(gets[0].params.seasonNumber, "6", "queries the mapped season");
  });
});

test("preview upgradeAssessment: Sonarr's 'not an upgrade' rejection is authoritative -> not-an-upgrade", async () => {
  await withServers(
    {
      sonarrEpisodesWithFiles: [{ id: 9001, hasFile: true, episodeFileId: 1 }],
      sonarrEpisodeFilesList: [{ id: 1, quality: QUALITY, customFormatScore: 0 }],
      reprocessRejections: [{ reason: "Not an upgrade for existing episode file(s). Existing quality: WEBDL-1080p. New Quality HDTV-720p.", type: "permanent" }],
    },
    async (port) => {
      const result = await callTool(port, "sonarr_preview_manual_import", {
        downloadId: SONARR_DOWNLOAD_ID,
        items: [{ candidateId: 123 }],
      });
      assert.equal(result.isError, false, result.text);
      const a = result.payload.items[0].upgradeAssessment;
      assert.equal(a.verdict, "not-an-upgrade");
      assert.match(a.note, /Do not import/);
    },
  );
});

test("preview upgradeAssessment: existing file + no upgrade rejection -> no-upgrade-rejection with file data (equal CF — Letterkenny case)", async () => {
  // Candidate 123: CF 10. Existing file: CF 10 (equal) — Sonarr surfaces no warning.
  await withServers(
    { sonarrEpisodesWithFiles: [{ id: 9001, hasFile: true, episodeFileId: 1 }], sonarrEpisodeFilesList: [{ id: 1, quality: QUALITY, customFormatScore: 10, qualityCutoffNotMet: false }] },
    async (port) => {
      const result = await callTool(port, "sonarr_preview_manual_import", {
        downloadId: SONARR_DOWNLOAD_ID,
        items: [{ candidateId: 123 }],
      });
      assert.equal(result.isError, false, result.text);
      const a = result.payload.items[0].upgradeAssessment;
      assert.equal(a.verdict, "no-upgrade-rejection");
      assert.equal(a.existingFiles.length, 1);
      assert.equal(a.existingFiles[0].customFormatScore, 10);
      assert.equal(a.existingFiles[0].quality, "WEBDL-1080p");
      assert.match(a.note, /no native upgrade rejection/i);
    },
  );
});

test("preview upgradeAssessment: higher existing CF + 'Not a Custom Format upgrade' rejection -> not-an-upgrade (Link Click case)", async () => {
  await withServers(
    {
      sonarrEpisodesWithFiles: [{ id: 9001, hasFile: true, episodeFileId: 1 }],
      sonarrEpisodeFilesList: [{ id: 1, quality: QUALITY, customFormatScore: 100 }],
      reprocessRejections: [{ reason: "Not a Custom Format upgrade for existing episode file(s). New: [Bad Metadata] (-50) do not improve on Existing: [Original filesize, Proper] (10)", type: "permanent" }],
    },
    async (port) => {
      const result = await callTool(port, "sonarr_preview_manual_import", {
        downloadId: SONARR_DOWNLOAD_ID,
        items: [{ candidateId: 123 }],
      });
      assert.equal(result.isError, false, result.text);
      assert.equal(result.payload.items[0].upgradeAssessment.verdict, "not-an-upgrade");
    },
  );
});

test("preview upgradeAssessment: multi-episode special file is found via the episode resource", async () => {
  const specialCandidate = {
    ...SONARR_CANDIDATE,
    id: 129,
    seasonNumber: 0,
    episodes: [{ id: 62640, seasonNumber: 0, episodeNumber: 22, title: "The Haunting of MoDean's II" }],
  };
  await withServers(
    {
      sonarrCandidates: [specialCandidate],
      sonarrEpisodesWithFiles: [{ id: 62640, hasFile: true, episodeFileId: 55 }],
      sonarrEpisodeFilesList: [{ id: 55, quality: QUALITY, customFormatScore: 600 }],
    },
    async (port) => {
      const result = await callTool(port, "sonarr_preview_manual_import", {
        downloadId: SONARR_DOWNLOAD_ID,
        items: [{ candidateId: 129, seasonNumber: 0, episodeIds: [62640] }],
      });
      assert.equal(result.isError, false, result.text);
      const a = result.payload.items[0].upgradeAssessment;
      assert.equal(a.verdict, "no-upgrade-rejection", "special's existing file found; no upgrade rejection");
      assert.equal(a.existingFiles[0].episodeId, 62640);
      assert.equal(a.existingFiles[0].customFormatScore, 600);
    },
  );
});

// --- release+file custom-format provenance (season-pack upgrade assessment) --
//
// Sonarr's per-file manual-import CF evaluation uses only the file/import
// context, so a season pack whose release metadata (source, audio, …) lives
// only in the release name scores 0 per file and is rejected as "Not a Custom
// Format upgrade" even when the tracked release beats the existing file. The
// preview merges the tracked release's queue CF context with the file CF
// context (deduplicated by custom-format id, scored against the effective
// series' quality profile) to assess the pending candidate.

const PACK_CF_REJECTION = {
  reason: "Not a Custom Format upgrade for existing episode file(s). New: [] (0) do not improve on Existing: [BluRay] (1600)",
  type: "permanent",
};

function packCandidate(id, episodeId, episodeNumber, fileCFs = [], fileScore = 0) {
  return {
    id,
    path: `/downloads/pack/The.Good.Fight.S01E${episodeNumber}.mkv`,
    name: `The.Good.Fight.S01E${episodeNumber}`,
    series: { id: 47, title: "The Good Fight" },
    seasonNumber: 1,
    episodes: [{ id: episodeId, seriesId: 47, seasonNumber: 1, episodeNumber, title: `E${episodeNumber}` }],
    quality: QUALITY,
    languages: LANGUAGES,
    qualityWeight: 60,
    downloadId: SONARR_DOWNLOAD_ID,
    customFormats: fileCFs,
    customFormatScore: fileScore,
    releaseType: "seasonPack",
    indexerFlags: 0,
    rejections: [],
  };
}

function packQueue(customFormats, nativeScore) {
  return {
    records: [{
      id: 1,
      title: "[neoDESU] The Good Fight [Season 1] [BD 1080p AV1 OPUS AAC] [Dual Audio]",
      status: "completed",
      trackedDownloadStatus: "warning",
      trackedDownloadState: "importBlocked",
      statusMessages: [],
      downloadId: SONARR_DOWNLOAD_ID,
      seriesId: 47,
      seasonNumber: 1,
      customFormats,
      customFormatScore: nativeScore,
    }],
    totalRecords: 1,
  };
}

function packProfile(formatItems) {
  return [{ id: 14, name: "Anime", upgradeAllowed: true, cutoff: 0, items: [], minFormatScore: 0, cutoffFormatScore: 0, formatItems }];
}

const PACK_SERIES = { 47: { id: 47, title: "The Good Fight", qualityProfileId: 14 } };

function packEpisodes(eps) {
  return eps.map((e) => ({ id: e.id, seriesId: 47, seasonNumber: 1, episodeNumber: e.episodeNumber, title: `E${e.episodeNumber}`, hasFile: true, episodeFileId: e.fileId }));
}

// A. Live season-pack regression (the neoDESU reproduction).
test("preview upgradeAssessment: season pack with release-only CFs -> cf-upgrade-with-native-rejection", async () => {
  await withServers(
    {
      sonarrCandidates: [packCandidate(130, 9101, 1)],
      sonarrSeries: PACK_SERIES,
      sonarrQualityProfiles: packProfile([
        { format: 10, name: "BluRay", score: 1600 },
        { format: 11, name: "Dual Audio", score: 1600 },
      ]),
      sonarrQueue: packQueue([{ id: 10, name: "BluRay" }, { id: 11, name: "Dual Audio" }], 3200),
      sonarrEpisodesWithFiles: packEpisodes([{ id: 9101, episodeNumber: 1, fileId: 1 }]),
      sonarrEpisodeFilesList: [{ id: 1, quality: QUALITY, customFormatScore: 1600 }],
      reprocessRejections: [PACK_CF_REJECTION],
    },
    async (port) => {
      const result = await callTool(port, "sonarr_preview_manual_import", {
        downloadId: SONARR_DOWNLOAD_ID,
        items: [{ candidateId: 130 }],
      });
      assert.equal(result.isError, false, result.text);
      const a = result.payload.items[0].upgradeAssessment;
      const cf = a.customFormatAssessment;
      const total = cf.effectiveCandidate.contributors.reduce((s, c) => s + c.score, 0);
      assert.equal(total, 3200, "effective contributor total = release CF union (3200)");
      assert.equal(cf.comparison, "upgrade");
      assert.equal(a.verdict, "cf-upgrade-with-native-rejection");
      assert.equal(result.payload.items[0].canExecuteWithoutOverride, false, "the native rejection still requires allowRejected");
      assert.doesNotMatch(a.note, /do not import/i, "note must not say 'Do not import'");
      assert.doesNotMatch(JSON.stringify(result.payload.guidance), /blocklist this release|recommend blocklisting/i, "guidance must not recommend blocklisting");
      assert.match(JSON.stringify(result.payload.guidance), /NOT sufficient evidence to remove\/blocklist/i);
    },
  );
});

// B. Dedup: a contributor present at release and file level counts once.
test("preview CF merge: contributor at both release and file level is deduplicated by id", async () => {
  await withServers(
    {
      sonarrCandidates: [packCandidate(131, 9102, 2, [{ id: 11, name: "Dual Audio", score: 1600 }, { id: 12, name: "AV1", score: 400 }], 2000)],
      sonarrSeries: PACK_SERIES,
      sonarrQualityProfiles: packProfile([
        { format: 10, name: "BluRay", score: 1600 },
        { format: 11, name: "Dual Audio", score: 1600 },
        { format: 12, name: "AV1", score: 400 },
      ]),
      sonarrQueue: packQueue([{ id: 10, name: "BluRay" }, { id: 11, name: "Dual Audio" }], 3200),
      sonarrEpisodesWithFiles: packEpisodes([{ id: 9102, episodeNumber: 2, fileId: 2 }]),
      sonarrEpisodeFilesList: [{ id: 2, quality: QUALITY, customFormatScore: 1600 }],
      reprocessRejections: [PACK_CF_REJECTION],
    },
    async (port) => {
      const result = await callTool(port, "sonarr_preview_manual_import", {
        downloadId: SONARR_DOWNLOAD_ID,
        items: [{ candidateId: 131 }],
      });
      assert.equal(result.isError, false, result.text);
      const cf = result.payload.items[0].upgradeAssessment.customFormatAssessment;
      const byId = Object.fromEntries(cf.effectiveCandidate.contributors.map((c) => [c.id, c]));
      assert.deepEqual(byId[10].matchedAt, ["release"], "BluRay matched at release only");
      assert.deepEqual(byId[11].matchedAt, ["release", "file"], "Dual Audio matched at both levels");
      assert.deepEqual(byId[12].matchedAt, ["file"], "AV1 matched at file only");
      assert.equal(cf.effectiveCandidate.contributors.length, 3, "one canonical deduplicated contributor list");
      assert.equal(cf.effectiveCandidate.score, 3600, "Dual Audio counted once: 1600+1600+400 = 3600, not 5200");
      assert.equal(cf.scoreAttributionValid, true);
    },
  );
});

// C. Negative contributor present at both levels contributes once.
test("preview CF merge: negative contributor at both levels is counted once", async () => {
  await withServers(
    {
      sonarrCandidates: [packCandidate(132, 9103, 3, [{ id: 20, name: "Bad Metadata", score: -100 }], -100)],
      sonarrSeries: PACK_SERIES,
      sonarrQualityProfiles: packProfile([
        { format: 19, name: "BluRay", score: 1600 },
        { format: 20, name: "Bad Metadata", score: -100 },
      ]),
      sonarrQueue: packQueue([{ id: 19, name: "BluRay" }, { id: 20, name: "Bad Metadata" }], 1500),
      sonarrEpisodesWithFiles: packEpisodes([{ id: 9103, episodeNumber: 3, fileId: 3 }]),
      sonarrEpisodeFilesList: [{ id: 3, quality: QUALITY, customFormatScore: 1000 }],
      reprocessRejections: [PACK_CF_REJECTION],
    },
    async (port) => {
      const result = await callTool(port, "sonarr_preview_manual_import", {
        downloadId: SONARR_DOWNLOAD_ID,
        items: [{ candidateId: 132 }],
      });
      assert.equal(result.isError, false, result.text);
      const cf = result.payload.items[0].upgradeAssessment.customFormatAssessment;
      const neg = cf.effectiveCandidate.contributors.find((c) => c.id === 20);
      assert.deepEqual(neg.matchedAt, ["release", "file"]);
      assert.equal(cf.effectiveCandidate.contributors.filter((c) => c.id === 20).length, 1, "negative CF deduplicated once");
      assert.equal(cf.effectiveCandidate.score, 1500, "1600 + (-100) counted once = 1500");
      assert.equal(cf.scoreAttributionValid, true);
    },
  );
});

// D. Both contexts agree the candidate is worse -> not-an-upgrade.
test("preview upgradeAssessment: release+file evidence confirms a CF downgrade -> not-an-upgrade", async () => {
  await withServers(
    {
      sonarrCandidates: [packCandidate(133, 9104, 4)],
      sonarrSeries: PACK_SERIES,
      sonarrQualityProfiles: packProfile([{ format: 10, name: "BluRay", score: 1200 }]),
      sonarrQueue: packQueue([{ id: 10, name: "BluRay" }], 1200),
      sonarrEpisodesWithFiles: packEpisodes([{ id: 9104, episodeNumber: 4, fileId: 4 }]),
      sonarrEpisodeFilesList: [{ id: 4, quality: QUALITY, customFormatScore: 1600 }],
      reprocessRejections: [PACK_CF_REJECTION],
    },
    async (port) => {
      const result = await callTool(port, "sonarr_preview_manual_import", {
        downloadId: SONARR_DOWNLOAD_ID,
        items: [{ candidateId: 133 }],
      });
      assert.equal(result.isError, false, result.text);
      const a = result.payload.items[0].upgradeAssessment;
      assert.equal(a.customFormatAssessment.effectiveCandidate.score, 1200);
      assert.equal(a.customFormatAssessment.comparison, "downgrade");
      assert.equal(a.verdict, "not-an-upgrade");
    },
  );
});

// E. Normal single-file overlap: union does not change the score, no special verdict.
test("preview CF merge: release and file CF ids identical -> union unchanged, no special verdict", async () => {
  const single = {
    ...SONARR_CANDIDATE,
    id: 134,
    releaseType: "episode",
    customFormats: [{ id: 1, name: "NTb", score: 10 }],
    customFormatScore: 10,
  };
  await withServers(
    {
      sonarrCandidates: [single],
      sonarrSeries: { 47: { id: 47, title: "The Good Fight", qualityProfileId: 14 } },
      sonarrQualityProfiles: packProfile([{ format: 1, name: "NTb", score: 10 }]),
      sonarrQueue: packQueue([{ id: 1, name: "NTb" }], 10),
      sonarrEpisodesWithFiles: [{ id: 9001, seriesId: 47, seasonNumber: 6, episodeNumber: 3, title: "The End of Football", hasFile: true, episodeFileId: 1 }],
      sonarrEpisodeFilesList: [{ id: 1, quality: QUALITY, customFormatScore: 10 }],
    },
    async (port) => {
      const result = await callTool(port, "sonarr_preview_manual_import", {
        downloadId: SONARR_DOWNLOAD_ID,
        items: [{ candidateId: 134 }],
      });
      assert.equal(result.isError, false, result.text);
      const a = result.payload.items[0].upgradeAssessment;
      assert.equal(a.customFormatAssessment.effectiveCandidate.score, 10, "union of identical ids keeps the score at 10");
      assert.equal(a.customFormatAssessment.comparison, "neutral");
      assert.equal(a.verdict, "no-upgrade-rejection", "no native rejection -> the normal successful path, not a special verdict");
    },
  );
});

// F. Season pack + CF rejection + no queue context -> ambiguous, no blocklist guidance.
test("preview upgradeAssessment: season pack CF rejection with no queue context -> cf-assessment-ambiguous", async () => {
  await withServers(
    {
      sonarrCandidates: [packCandidate(135, 9105, 5)],
      sonarrSeries: PACK_SERIES,
      sonarrQualityProfiles: packProfile([{ format: 10, name: "BluRay", score: 1600 }]),
      sonarrQueue: { records: [], totalRecords: 0 },
      sonarrEpisodesWithFiles: packEpisodes([{ id: 9105, episodeNumber: 5, fileId: 5 }]),
      sonarrEpisodeFilesList: [{ id: 5, quality: QUALITY, customFormatScore: 1600 }],
      reprocessRejections: [PACK_CF_REJECTION],
    },
    async (port) => {
      const result = await callTool(port, "sonarr_preview_manual_import", {
        downloadId: SONARR_DOWNLOAD_ID,
        items: [{ candidateId: 135 }],
      });
      assert.equal(result.isError, false, result.text);
      const a = result.payload.items[0].upgradeAssessment;
      assert.equal(a.verdict, "cf-assessment-ambiguous");
      assert.equal(a.releaseContext.available, false);
      assert.equal(a.releaseContext.reason, "queue-item-not-found");
      assert.doesNotMatch(a.note, /do not import/i, "no unconditional 'Do not import' when context is unavailable");
      assert.doesNotMatch(JSON.stringify(result.payload.guidance), /blocklist this release|recommend blocklisting/i);
    },
  );
});

// G. Quality/revision downgrade stays a hard refusal even with a higher CF score.
test("preview upgradeAssessment: native quality downgrade stays not-an-upgrade despite higher CF", async () => {
  await withServers(
    {
      sonarrCandidates: [packCandidate(136, 9106, 6)],
      sonarrSeries: PACK_SERIES,
      sonarrQualityProfiles: packProfile([{ format: 10, name: "BluRay", score: 1600 }]),
      sonarrQueue: packQueue([{ id: 10, name: "BluRay" }], 1600),
      sonarrEpisodesWithFiles: packEpisodes([{ id: 9106, episodeNumber: 6, fileId: 6 }]),
      sonarrEpisodeFilesList: [{ id: 6, quality: QUALITY, customFormatScore: 100 }],
      reprocessRejections: [{ reason: "Not an upgrade for existing episode file(s). Existing quality: WEBDL-1080p. New Quality HDTV-720p.", type: "permanent" }],
    },
    async (port) => {
      const result = await callTool(port, "sonarr_preview_manual_import", {
        downloadId: SONARR_DOWNLOAD_ID,
        items: [{ candidateId: 136 }],
      });
      assert.equal(result.isError, false, result.text);
      const a = result.payload.items[0].upgradeAssessment;
      assert.equal(a.customFormatAssessment.comparison, "upgrade", "CF evidence alone would say upgrade");
      assert.equal(a.verdict, "not-an-upgrade", "a quality/revision downgrade is a hard native rejection CF cannot override");
      assert.match(a.note, /quality\/revision/i);
    },
  );
});

// H. Attribution mismatch: native queue score != profile sum -> ambiguous, not a hard upgrade.
test("preview upgradeAssessment: native score / profile attribution mismatch -> cf-assessment-ambiguous", async () => {
  await withServers(
    {
      sonarrCandidates: [packCandidate(137, 9107, 7)],
      sonarrSeries: PACK_SERIES,
      // Profile says BluRay is 1600, but the queue reports a native total of 3200.
      sonarrQualityProfiles: packProfile([{ format: 10, name: "BluRay", score: 1600 }]),
      sonarrQueue: packQueue([{ id: 10, name: "BluRay" }], 3200),
      sonarrEpisodesWithFiles: packEpisodes([{ id: 9107, episodeNumber: 7, fileId: 7 }]),
      sonarrEpisodeFilesList: [{ id: 7, quality: QUALITY, customFormatScore: 1600 }],
      reprocessRejections: [PACK_CF_REJECTION],
    },
    async (port) => {
      const result = await callTool(port, "sonarr_preview_manual_import", {
        downloadId: SONARR_DOWNLOAD_ID,
        items: [{ candidateId: 137 }],
      });
      assert.equal(result.isError, false, result.text);
      const a = result.payload.items[0].upgradeAssessment;
      const cf = a.customFormatAssessment;
      assert.equal(cf.scoreAttributionValid, false, "native release total 3200 != profile-attributed sum 1600");
      assert.ok(cf.attributionProblems.length > 0, "mismatch is reported diagnostically");
      assert.equal(a.verdict, "cf-assessment-ambiguous", "an incompletely attributed score is never used for a hard upgrade verdict");
    },
  );
});

// I. Multi-file season pack reuses one queue lookup and one quality-profile fetch.
test("preview CF merge: 12-file season pack uses one queue lookup and one quality-profile fetch", async () => {
  const files = Array.from({ length: 12 }, (_, i) => packCandidate(200 + i, 9200 + i, i + 1));
  const episodesWithFiles = files.map((c, i) => ({ id: 9200 + i, seriesId: 47, seasonNumber: 1, episodeNumber: i + 1, title: `E${i + 1}`, hasFile: true, episodeFileId: 300 + i }));
  const filesList = files.map((_, i) => ({ id: 300 + i, quality: QUALITY, customFormatScore: 1600 }));
  await withServers(
    {
      sonarrCandidates: files,
      sonarrSeries: PACK_SERIES,
      sonarrQualityProfiles: packProfile([
        { format: 10, name: "BluRay", score: 1600 },
        { format: 11, name: "Dual Audio", score: 1600 },
      ]),
      sonarrQueue: packQueue([{ id: 10, name: "BluRay" }, { id: 11, name: "Dual Audio" }], 3200),
      sonarrEpisodesWithFiles: episodesWithFiles,
      sonarrEpisodeFilesList: filesList,
      reprocessRejections: [PACK_CF_REJECTION],
    },
    async (port, logs) => {
      const result = await callTool(port, "sonarr_preview_manual_import", {
        downloadId: SONARR_DOWNLOAD_ID,
        items: files.map((c) => ({ candidateId: c.id })),
      });
      assert.equal(result.isError, false, result.text);
      assert.equal(result.payload.count, 12);
      assert.equal(requestsTo(logs.sonarr, "GET", "/api/v3/queue").length, 1, "one queue-context lookup for the whole preview");
      assert.equal(requestsTo(logs.sonarr, "GET", "/api/v3/qualityprofile").length, 1, "one quality-profile fetch for the whole preview");
      for (const item of result.payload.items) {
        assert.equal(item.upgradeAssessment.verdict, "cf-upgrade-with-native-rejection", "every file reuses the tracked-release contributor context");
        assert.equal(item.upgradeAssessment.customFormatAssessment.effectiveCandidate.score, 3200);
      }
    },
  );
});

// sonarr_get_queue preserves the tracked release's native CF context.
test("sonarr_get_queue passes through customFormats/customFormatScore without recomputing", async () => {
  await withServers(
    { sonarrQueue: packQueue([{ id: 10, name: "BluRay" }, { id: 11, name: "Dual Audio" }], 3200) },
    async (port) => {
      const result = await callTool(port, "sonarr_get_queue", { limit: 10 });
      assert.equal(result.isError, false, result.text);
      const item = result.payload.items.find((i) => i.downloadId === SONARR_DOWNLOAD_ID);
      assert.deepEqual(item.customFormats, [{ id: 10, name: "BluRay" }, { id: 11, name: "Dual Audio" }]);
      assert.equal(item.customFormatScore, 3200, "native queue score passed through, not recomputed");
    },
  );
});

// --- rejection classification + symmetric CF comparison (follow-up) --------

const PACK_QUALITY_REJECTION = {
  reason: "Not an upgrade for existing episode file(s). Existing quality: WEBDL-1080p. New Quality HDTV-720p.",
  type: "permanent",
};
const PACK_REVISION_REJECTION = {
  reason: "Not a quality revision upgrade for existing episode file(s)",
  type: "permanent",
};
const PACK_ALREADY_IMPORTED_REJECTION = {
  reason: "Episode already imported",
  type: "permanent",
};

// A. Native revision rejection is recognized (it does NOT match /not an upgrade/).
test("preview upgradeAssessment: 'Not a quality revision upgrade' -> not-an-upgrade (not missed)", async () => {
  await withServers(
    {
      sonarrCandidates: [packCandidate(146, 9101, 1)],
      sonarrSeries: PACK_SERIES,
      sonarrQualityProfiles: packProfile([
        { format: 10, name: "BluRay", score: 1600 },
        { format: 11, name: "Dual Audio", score: 1600 },
      ]),
      sonarrQueue: packQueue([{ id: 10, name: "BluRay" }, { id: 11, name: "Dual Audio" }], 3200),
      sonarrEpisodesWithFiles: packEpisodes([{ id: 9101, episodeNumber: 1, fileId: 1 }]),
      sonarrEpisodeFilesList: [{ id: 1, quality: QUALITY, customFormatScore: 1600 }],
      reprocessRejections: [PACK_REVISION_REJECTION],
    },
    async (port) => {
      const result = await callTool(port, "sonarr_preview_manual_import", {
        downloadId: SONARR_DOWNLOAD_ID,
        items: [{ candidateId: 146 }],
      });
      assert.equal(result.isError, false, result.text);
      const a = result.payload.items[0].upgradeAssessment;
      assert.equal(a.customFormatAssessment.comparison, "upgrade", "CF evidence alone would say upgrade");
      assert.equal(a.verdict, "not-an-upgrade", "a revision rejection is a hard refusal CF cannot override");
      assert.match(a.note, /quality\/revision/i, "note names quality/revision grounds");
    },
  );
});

// B. Hard quality/revision rejection wins regardless of array order.
test("preview upgradeAssessment: hard rejection wins over a CF rejection in any order", async () => {
  const base = {
    sonarrCandidates: [packCandidate(147, 9101, 1)],
    sonarrSeries: PACK_SERIES,
    sonarrQualityProfiles: packProfile([
      { format: 10, name: "BluRay", score: 1600 },
      { format: 11, name: "Dual Audio", score: 1600 },
    ]),
    sonarrQueue: packQueue([{ id: 10, name: "BluRay" }, { id: 11, name: "Dual Audio" }], 3200),
    sonarrEpisodesWithFiles: packEpisodes([{ id: 9101, episodeNumber: 1, fileId: 1 }]),
    sonarrEpisodeFilesList: [{ id: 1, quality: QUALITY, customFormatScore: 1600 }],
  };
  const orders = [
    [PACK_CF_REJECTION, PACK_QUALITY_REJECTION],
    [PACK_QUALITY_REJECTION, PACK_CF_REJECTION],
    [PACK_CF_REJECTION, PACK_REVISION_REJECTION],
    [PACK_REVISION_REJECTION, PACK_CF_REJECTION],
  ];
  for (const reprocessRejections of orders) {
    await withServers({ ...base, reprocessRejections }, async (port) => {
      const result = await callTool(port, "sonarr_preview_manual_import", {
        downloadId: SONARR_DOWNLOAD_ID,
        items: [{ candidateId: 147 }],
      });
      assert.equal(result.isError, false, result.text);
      const a = result.payload.items[0].upgradeAssessment;
      assert.equal(a.customFormatAssessment.comparison, "upgrade", "CF evidence is favorable in every order");
      assert.equal(a.verdict, "not-an-upgrade", `hard rejection must win for order ${JSON.stringify(reprocessRejections.map((r) => r.reason.slice(0, 20)))}`);
    });
  }
});

// C. Already-imported is a hard rejection even alongside a CF rejection.
test("preview upgradeAssessment: already-imported rejection wins over a CF rejection in any order", async () => {
  const base = {
    sonarrCandidates: [packCandidate(148, 9101, 1)],
    sonarrSeries: PACK_SERIES,
    sonarrQualityProfiles: packProfile([
      { format: 10, name: "BluRay", score: 1600 },
      { format: 11, name: "Dual Audio", score: 1600 },
    ]),
    sonarrQueue: packQueue([{ id: 10, name: "BluRay" }, { id: 11, name: "Dual Audio" }], 3200),
    sonarrEpisodesWithFiles: packEpisodes([{ id: 9101, episodeNumber: 1, fileId: 1 }]),
    sonarrEpisodeFilesList: [{ id: 1, quality: QUALITY, customFormatScore: 1600 }],
  };
  for (const reprocessRejections of [[PACK_CF_REJECTION, PACK_ALREADY_IMPORTED_REJECTION], [PACK_ALREADY_IMPORTED_REJECTION, PACK_CF_REJECTION]]) {
    await withServers({ ...base, reprocessRejections }, async (port) => {
      const result = await callTool(port, "sonarr_preview_manual_import", {
        downloadId: SONARR_DOWNLOAD_ID,
        items: [{ candidateId: 148 }],
      });
      assert.equal(result.isError, false, result.text);
      assert.equal(result.payload.items[0].upgradeAssessment.verdict, "not-an-upgrade");
    });
  }
});

// D. Release-only negative CF with no native rejection -> inverse downgrade.
test("preview upgradeAssessment: release-only negative CF, no native rejection -> cf-downgrade-despite-native-acceptance", async () => {
  await withServers(
    {
      sonarrCandidates: [packCandidate(149, 9110, 10)],
      sonarrSeries: PACK_SERIES,
      sonarrQualityProfiles: packProfile([{ format: 30, name: "Bad Group", score: -1000 }]),
      sonarrQueue: packQueue([{ id: 30, name: "Bad Group" }], -1000),
      sonarrEpisodesWithFiles: packEpisodes([{ id: 9110, episodeNumber: 10, fileId: 10 }]),
      sonarrEpisodeFilesList: [{ id: 10, quality: QUALITY, customFormatScore: 0 }],
      reprocessRejections: [],
    },
    async (port) => {
      const result = await callTool(port, "sonarr_preview_manual_import", {
        downloadId: SONARR_DOWNLOAD_ID,
        items: [{ candidateId: 149 }],
      });
      assert.equal(result.isError, false, result.text);
      const a = result.payload.items[0].upgradeAssessment;
      assert.equal(a.customFormatAssessment.effectiveCandidate.score, -1000);
      assert.equal(a.customFormatAssessment.comparison, "downgrade");
      assert.equal(a.verdict, "cf-downgrade-despite-native-acceptance");
      assert.notEqual(a.verdict, "no-upgrade-rejection", "absence of a native rejection is not evidence of an upgrade");
    },
  );
});

// E. Negative CF present at release and file levels is deduplicated once.
test("preview CF merge: release+file negative CF deduplicated once, inverse downgrade", async () => {
  await withServers(
    {
      sonarrCandidates: [packCandidate(150, 9111, 11, [{ id: 30, name: "Bad Group", score: -1000 }], -1000)],
      sonarrSeries: PACK_SERIES,
      sonarrQualityProfiles: packProfile([{ format: 30, name: "Bad Group", score: -1000 }]),
      sonarrQueue: packQueue([{ id: 30, name: "Bad Group" }], -1000),
      sonarrEpisodesWithFiles: packEpisodes([{ id: 9111, episodeNumber: 11, fileId: 11 }]),
      sonarrEpisodeFilesList: [{ id: 11, quality: QUALITY, customFormatScore: 0 }],
      reprocessRejections: [],
    },
    async (port) => {
      const result = await callTool(port, "sonarr_preview_manual_import", {
        downloadId: SONARR_DOWNLOAD_ID,
        items: [{ candidateId: 150 }],
      });
      assert.equal(result.isError, false, result.text);
      const cf = result.payload.items[0].upgradeAssessment.customFormatAssessment;
      const neg = cf.effectiveCandidate.contributors.filter((c) => c.id === 30);
      assert.equal(neg.length, 1, "negative CF deduplicated to one contributor");
      assert.deepEqual(neg[0].matchedAt, ["release", "file"]);
      assert.equal(cf.effectiveCandidate.score, -1000, "counted once, not -2000");
      assert.equal(result.payload.items[0].upgradeAssessment.verdict, "cf-downgrade-despite-native-acceptance");
    },
  );
});

// F. No native rejection + effective upgrade stays on the normal accepted path.
test("preview upgradeAssessment: no native rejection + effective upgrade -> no-upgrade-rejection", async () => {
  await withServers(
    {
      sonarrCandidates: [packCandidate(151, 9112, 12)],
      sonarrSeries: PACK_SERIES,
      sonarrQualityProfiles: packProfile([
        { format: 10, name: "BluRay", score: 1600 },
        { format: 11, name: "Dual Audio", score: 1600 },
      ]),
      sonarrQueue: packQueue([{ id: 10, name: "BluRay" }, { id: 11, name: "Dual Audio" }], 3200),
      sonarrEpisodesWithFiles: packEpisodes([{ id: 9112, episodeNumber: 12, fileId: 12 }]),
      sonarrEpisodeFilesList: [{ id: 12, quality: QUALITY, customFormatScore: 1600 }],
      reprocessRejections: [],
    },
    async (port) => {
      const result = await callTool(port, "sonarr_preview_manual_import", {
        downloadId: SONARR_DOWNLOAD_ID,
        items: [{ candidateId: 151 }],
      });
      assert.equal(result.isError, false, result.text);
      const a = result.payload.items[0].upgradeAssessment;
      assert.equal(a.customFormatAssessment.comparison, "upgrade");
      assert.equal(a.verdict, "no-upgrade-rejection", "no conflict -> the normal accepted path, no special verdict");
    },
  );
});

// G. No native rejection + neutral stays accepted/neutral.
test("preview upgradeAssessment: no native rejection + neutral CF -> no-upgrade-rejection", async () => {
  await withServers(
    {
      sonarrCandidates: [packCandidate(152, 9113, 13)],
      sonarrSeries: PACK_SERIES,
      sonarrQualityProfiles: packProfile([{ format: 10, name: "BluRay", score: 1600 }]),
      sonarrQueue: packQueue([{ id: 10, name: "BluRay" }], 1600),
      sonarrEpisodesWithFiles: packEpisodes([{ id: 9113, episodeNumber: 13, fileId: 13 }]),
      sonarrEpisodeFilesList: [{ id: 13, quality: QUALITY, customFormatScore: 1600 }],
      reprocessRejections: [],
    },
    async (port) => {
      const result = await callTool(port, "sonarr_preview_manual_import", {
        downloadId: SONARR_DOWNLOAD_ID,
        items: [{ candidateId: 152 }],
      });
      assert.equal(result.isError, false, result.text);
      const a = result.payload.items[0].upgradeAssessment;
      assert.equal(a.customFormatAssessment.comparison, "neutral");
      assert.equal(a.verdict, "no-upgrade-rejection");
    },
  );
});

// H. No native rejection + mixed existing targets -> ambiguous.
test("preview upgradeAssessment: no native rejection + mixed existing targets -> cf-assessment-ambiguous", async () => {
  const multi = {
    ...packCandidate(153, 9101, 1),
    episodes: [
      { id: 9101, seriesId: 47, seasonNumber: 1, episodeNumber: 1, title: "E1" },
      { id: 9102, seriesId: 47, seasonNumber: 1, episodeNumber: 2, title: "E2" },
    ],
  };
  await withServers(
    {
      sonarrCandidates: [multi],
      sonarrSeries: PACK_SERIES,
      sonarrQualityProfiles: packProfile([{ format: 10, name: "BluRay", score: 1600 }]),
      sonarrQueue: packQueue([{ id: 10, name: "BluRay" }], 1600),
      sonarrEpisodesWithFiles: packEpisodes([
        { id: 9101, episodeNumber: 1, fileId: 1 },
        { id: 9102, episodeNumber: 2, fileId: 2 },
      ]),
      sonarrEpisodeFilesList: [
        { id: 1, quality: QUALITY, customFormatScore: 1000 },
        { id: 2, quality: QUALITY, customFormatScore: 2000 },
      ],
      reprocessRejections: [],
    },
    async (port) => {
      const result = await callTool(port, "sonarr_preview_manual_import", {
        downloadId: SONARR_DOWNLOAD_ID,
        items: [{ candidateId: 153 }],
      });
      assert.equal(result.isError, false, result.text);
      const a = result.payload.items[0].upgradeAssessment;
      assert.equal(a.customFormatAssessment.comparison, "mixed");
      assert.equal(a.verdict, "cf-assessment-ambiguous", "some files upgrade, others downgrade — not a blanket accept");
    },
  );
});

// I. Attribution mismatch with no native rejection stays conservative.
test("preview upgradeAssessment: attribution mismatch + no native rejection -> cf-assessment-ambiguous", async () => {
  await withServers(
    {
      sonarrCandidates: [packCandidate(154, 9115, 15)],
      sonarrSeries: PACK_SERIES,
      // Profile says BluRay is 1600, queue reports a native total of 3200.
      sonarrQualityProfiles: packProfile([{ format: 10, name: "BluRay", score: 1600 }]),
      sonarrQueue: packQueue([{ id: 10, name: "BluRay" }], 3200),
      sonarrEpisodesWithFiles: packEpisodes([{ id: 9115, episodeNumber: 15, fileId: 15 }]),
      sonarrEpisodeFilesList: [{ id: 15, quality: QUALITY, customFormatScore: 1600 }],
      reprocessRejections: [],
    },
    async (port) => {
      const result = await callTool(port, "sonarr_preview_manual_import", {
        downloadId: SONARR_DOWNLOAD_ID,
        items: [{ candidateId: 154 }],
      });
      assert.equal(result.isError, false, result.text);
      const a = result.payload.items[0].upgradeAssessment;
      assert.equal(a.customFormatAssessment.scoreAttributionValid, false);
      assert.equal(a.verdict, "cf-assessment-ambiguous", "unusable provenance is not converted into an acceptance");
      assert.notEqual(a.verdict, "no-upgrade-rejection", "no native rejection does not prove equal-to-or-better here");
      assert.notEqual(a.verdict, "cf-downgrade-despite-native-acceptance", "an invalid attribution never infers a downgrade");
      assert.doesNotMatch(a.note, /the new file is equal to or better/i, "note must not make the categorical acceptance claim");
    },
  );
});

// --- provenance-relevant-but-unusable -> ambiguous (no false acceptance) ----

// A. Invalid attribution + no native rejection -> ambiguous (not "equal to or better").
test("preview upgradeAssessment: native/profile attribution mismatch, no rejection -> cf-assessment-ambiguous", async () => {
  await withServers(
    {
      sonarrCandidates: [packCandidate(160, 9116, 16)],
      sonarrSeries: PACK_SERIES,
      // Queue native total -1000 does not reconcile with the profile score -500.
      sonarrQualityProfiles: packProfile([{ format: 10, name: "Bad Group", score: -500 }]),
      sonarrQueue: packQueue([{ id: 10, name: "Bad Group" }], -1000),
      sonarrEpisodesWithFiles: packEpisodes([{ id: 9116, episodeNumber: 16, fileId: 16 }]),
      sonarrEpisodeFilesList: [{ id: 16, quality: QUALITY, customFormatScore: 0 }],
      reprocessRejections: [],
    },
    async (port) => {
      const result = await callTool(port, "sonarr_preview_manual_import", {
        downloadId: SONARR_DOWNLOAD_ID,
        items: [{ candidateId: 160 }],
      });
      assert.equal(result.isError, false, result.text);
      const a = result.payload.items[0].upgradeAssessment;
      assert.equal(a.customFormatAssessment.scoreAttributionValid, false);
      assert.equal(a.verdict, "cf-assessment-ambiguous");
      assert.notEqual(a.verdict, "no-upgrade-rejection", "unusable provenance must not be accepted as equal-to-or-better");
      assert.doesNotMatch(a.note, /the new file is equal to or better/i, "note must not make the categorical acceptance claim");
    },
  );
});

// B. Quality profile cannot be resolved -> ambiguous.
test("preview upgradeAssessment: release context present but quality profile unresolvable -> cf-assessment-ambiguous", async () => {
  await withServers(
    {
      sonarrCandidates: [packCandidate(161, 9117, 17)],
      sonarrSeries: { 47: { id: 47, title: "The Good Fight", qualityProfileId: 99 } },
      sonarrQualityProfiles: [],
      sonarrQueue: packQueue([{ id: 10, name: "BluRay" }], 1600),
      sonarrEpisodesWithFiles: packEpisodes([{ id: 9117, episodeNumber: 17, fileId: 17 }]),
      sonarrEpisodeFilesList: [{ id: 17, quality: QUALITY, customFormatScore: 0 }],
      reprocessRejections: [],
    },
    async (port) => {
      const result = await callTool(port, "sonarr_preview_manual_import", {
        downloadId: SONARR_DOWNLOAD_ID,
        items: [{ candidateId: 161 }],
      });
      assert.equal(result.isError, false, result.text);
      const a = result.payload.items[0].upgradeAssessment;
      assert.equal(a.verdict, "cf-assessment-ambiguous", "the release CFs cannot be scored without the profile");
      assert.notEqual(a.verdict, "no-upgrade-rejection");
    },
  );
});

// C. Effective-series mismatch -> ambiguous, reason reported.
test("preview upgradeAssessment: remap to a different series with release context -> cf-assessment-ambiguous", async () => {
  await withServers(
    {
      sonarrCandidates: [packCandidate(162, 9100, 1)],
      sonarrSeries: {
        47: { id: 47, title: "The Good Fight", qualityProfileId: 14 },
        88: { id: 88, title: "A Different Series", qualityProfileId: 14 },
      },
      sonarrEpisodeCatalog: {
        "88:1": [{ id: 9100, seriesId: 88, seasonNumber: 1, episodeNumber: 1, title: "Pilot", hasFile: true, episodeFileId: 18 }],
      },
      sonarrQualityProfiles: packProfile([{ format: 10, name: "BluRay", score: 1600 }]),
      sonarrQueue: packQueue([{ id: 10, name: "BluRay" }], 1600),
      sonarrEpisodesWithFiles: [{ id: 9100, seriesId: 88, seasonNumber: 1, episodeNumber: 1, title: "Pilot", hasFile: true, episodeFileId: 18 }],
      sonarrEpisodeFilesList: [{ id: 18, quality: QUALITY, customFormatScore: 0 }],
      reprocessRejections: [],
    },
    async (port) => {
      const result = await callTool(port, "sonarr_preview_manual_import", {
        downloadId: SONARR_DOWNLOAD_ID,
        items: [{ candidateId: 162, seriesId: 88, seasonNumber: 1, episodeIds: [9100] }],
      });
      assert.equal(result.isError, false, result.text);
      const a = result.payload.items[0].upgradeAssessment;
      assert.equal(a.verdict, "cf-assessment-ambiguous", "the tracked release's CFs belong to series 47, not the remapped series 88");
      assert.equal(a.releaseContext.reason, "effective-series-mismatch");
      assert.notEqual(a.verdict, "no-upgrade-rejection");
    },
  );
});

// D. Season pack + no queue context + no native rejection -> ambiguous.
test("preview upgradeAssessment: season pack, no queue context, no rejection -> cf-assessment-ambiguous", async () => {
  await withServers(
    {
      sonarrCandidates: [packCandidate(163, 9119, 19)],
      sonarrSeries: PACK_SERIES,
      sonarrQualityProfiles: packProfile([{ format: 10, name: "BluRay", score: 1600 }]),
      sonarrQueue: { records: [], totalRecords: 0 },
      sonarrEpisodesWithFiles: packEpisodes([{ id: 9119, episodeNumber: 19, fileId: 19 }]),
      sonarrEpisodeFilesList: [{ id: 19, quality: QUALITY, customFormatScore: 0 }],
      reprocessRejections: [],
    },
    async (port) => {
      const result = await callTool(port, "sonarr_preview_manual_import", {
        downloadId: SONARR_DOWNLOAD_ID,
        items: [{ candidateId: 163 }],
      });
      assert.equal(result.isError, false, result.text);
      const a = result.payload.items[0].upgradeAssessment;
      assert.equal(a.verdict, "cf-assessment-ambiguous", "season-pack release metadata is expected but unavailable");
      assert.notEqual(a.verdict, "no-upgrade-rejection");
    },
  );
});

// E. Ordinary single-file + no queue context + no rejection -> native fallback preserved.
test("preview upgradeAssessment: ordinary single-file, no queue context, no rejection -> no-upgrade-rejection", async () => {
  await withServers(
    {
      sonarrEpisodesWithFiles: [{ id: 9001, seriesId: 47, seasonNumber: 6, episodeNumber: 3, title: "The End of Football", hasFile: true, episodeFileId: 1 }],
      sonarrEpisodeFilesList: [{ id: 1, quality: QUALITY, customFormatScore: 10 }],
    },
    async (port) => {
      const result = await callTool(port, "sonarr_preview_manual_import", {
        downloadId: SONARR_DOWNLOAD_ID,
        items: [{ candidateId: 123 }],
      });
      assert.equal(result.isError, false, result.text);
      const a = result.payload.items[0].upgradeAssessment;
      assert.equal(a.releaseContext.available, false);
      assert.equal(a.verdict, "no-upgrade-rejection", "no evidence of provenance divergence for an ordinary file — preserve native behavior");
    },
  );
});

// --- 1. Sonarr/Radarr missing mapping: mappingRequired, never seriesId=0 --
test("sonarr preview of an unmapped candidate: mappingRequired, no native reprocess request", async () => {
  const unmapped = { ...SONARR_CANDIDATE, id: 127, series: null, seasonNumber: null, episodes: [] };
  await withServers({ sonarrCandidates: [unmapped] }, async (port, logs) => {
    const result = await callTool(port, "sonarr_preview_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 127 }],
    });
    assert.equal(result.isError, false, result.text);
    const item = result.payload.items[0];
    assert.equal(item.canPreview, false);
    assert.equal(item.mappingRequired, true);
    assert.deepEqual(item.missing, ["seriesId"]);
    assert.equal(requestsTo(logs.sonarr, "POST", "/api/v3/manualimport").length, 0, "unmapped candidate must not be POSTed to /manualimport");
    assert.equal(requestsTo(logs.sonarr, "POST", "/api/v3/command").length, 0);
  });
});

test("sonarr execute of an unmapped candidate: refuses before any native request", async () => {
  const unmapped = { ...SONARR_CANDIDATE, id: 127, series: null, seasonNumber: null, episodes: [] };
  await withServers({ sonarrCandidates: [unmapped] }, async (port, logs) => {
    const result = await callTool(port, "sonarr_execute_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 127 }],
    });
    assert.equal(result.isError, true);
    assert.deepEqual(result.payload.mappingRequired[0].missing, ["seriesId"]);
    assert.equal(requestsTo(logs.sonarr, "POST", "/api/v3/manualimport").length, 0, "no reprocess with a fabricated 0 seriesId");
    assert.equal(requestsTo(logs.sonarr, "POST", "/api/v3/command").length, 0);
  });
});

test("sonarr preview mixes mapped and unmapped candidates: only mapped items are reprocessed", async () => {
  const unmapped = { ...SONARR_CANDIDATE, id: 128, series: null, seasonNumber: null, episodes: [] };
  await withServers({ sonarrCandidates: [SONARR_CANDIDATE, unmapped], reprocessRejections: [] }, async (port, logs) => {
    const result = await callTool(port, "sonarr_preview_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 123 }, { candidateId: 128 }],
    });
    assert.equal(result.isError, false, result.text);
    const posts = requestsTo(logs.sonarr, "POST", "/api/v3/manualimport");
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].body.map((i) => i.id), [123], "only the mapped candidate is sent to the native endpoint");
    assert.ok(posts[0].body.every((i) => i.seriesId > 0), "no 0 seriesId in the payload");
    const byId = Object.fromEntries(result.payload.items.map((i) => [i.candidateId, i]));
    assert.equal(byId[123].canPreview, true);
    assert.equal(byId[128].mappingRequired, true);
  });
});

test("radarr preview/execute of an unmapped candidate: mappingRequired, no native reprocess", async () => {
  const unmapped = { ...RADARR_CANDIDATE, id: 224, movie: null };
  await withServers({ radarrCandidates: [unmapped] }, async (port, logs) => {
    const preview = await callTool(port, "radarr_preview_manual_import", {
      downloadId: "dl-11",
      items: [{ candidateId: 224 }],
    });
    assert.equal(preview.isError, false, preview.text);
    assert.equal(preview.payload.items[0].canPreview, false);
    assert.deepEqual(preview.payload.items[0].missing, ["movieId"]);
    assert.equal(requestsTo(logs.radarr, "POST", "/api/v3/manualimport").length, 0);

    const exec = await callTool(port, "radarr_execute_manual_import", {
      downloadId: "dl-11",
      items: [{ candidateId: 224 }],
    });
    assert.equal(exec.isError, true);
    assert.deepEqual(exec.payload.mappingRequired[0].missing, ["movieId"]);
    assert.equal(requestsTo(logs.radarr, "POST", "/api/v3/manualimport").length, 0, "no 0 movieId reprocess");
    assert.equal(requestsTo(logs.radarr, "POST", "/api/v3/command").length, 0);
  });
});

test("a 0 seriesId/movieId override is refused at parse time", async () => {
  await withServers({}, async (port, logs) => {
    const s = await callTool(port, "sonarr_preview_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 123, seriesId: 0 }],
    });
    assert.equal(s.isError, true);
    assert.match(s.text, /positive integer/);

    const r = await callTool(port, "radarr_execute_manual_import", {
      downloadId: "dl-11",
      items: [{ candidateId: 222, movieId: 0 }],
    });
    assert.equal(r.isError, true);
    assert.match(r.text, /positive integer/);
    assert.equal(requestsTo(logs.sonarr, "POST", "/api/v3/manualimport").length, 0);
    assert.equal(requestsTo(logs.radarr, "POST", "/api/v3/manualimport").length, 0);
  });
});

// --- 2. Lidarr explicit track overrides survive reprocessing ---------------

test("lidarr explicit trackIds override is validated against the selected release and preserved into the command", async () => {
  // Lidarr maps the file to Track 501; the caller corrects it to Track 502,
  // a track of the SAME selected release (77).
  await withServers({ lidarrReleaseTracks: { 77: [501, 502], 78: [503] } }, async (port, logs) => {
    const preview = await callTool(port, "lidarr_preview_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: [{ candidateId: 333, artistId: 5, albumId: 9, albumReleaseId: 77, trackIds: [502] }],
    });
    assert.equal(preview.isError, false, preview.text);
    const item = preview.payload.items[0];
    assert.equal(item.tracksSource, "caller-override");
    assert.deepEqual(item.tracks.map((t) => t.id), [502], "preview shows the corrected track, not Lidarr's recomputed 501");

    const result = await callTool(port, "lidarr_execute_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: [{ candidateId: 333, artistId: 5, albumId: 9, albumReleaseId: 77, trackIds: [502] }],
    });
    assert.equal(result.isError, false, result.text);
    const command = requestsTo(logs.lidarr, "POST", "/api/v1/command")[0].body;
    assert.deepEqual(command.files[0].trackIds, [502], "the validated override reaches the native ManualImport command unchanged");
    const update = requestsTo(logs.lidarr, "POST", "/api/v1/manualimport")[0].body[0];
    assert.equal(update.trackIds, undefined, "tracks are not smuggled through the update endpoint");
    const trackGets = requestsTo(logs.lidarr, "GET", "/api/v1/track");
    assert.equal(trackGets.length, 2, "override validated against the release track list in preview and again in execute");
    assert.equal(trackGets[0].params.albumReleaseId, "77", "validation queries the selected album release, not the album");
  });
});

test("lidarr trackIds from a DIFFERENT release of the same album are refused before any command", async () => {
  // Track 503 belongs to album 9's release 78; the selected release is 77.
  await withServers({ lidarrReleaseTracks: { 77: [501, 502], 78: [503] } }, async (port, logs) => {
    const result = await callTool(port, "lidarr_execute_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: [{ candidateId: 333, artistId: 5, albumId: 9, albumReleaseId: 77, trackIds: [503] }],
    });
    assert.equal(result.isError, true);
    assert.match(result.text, /not tracks of album release 77/);
    assert.equal(requestsTo(logs.lidarr, "POST", "/api/v1/command").length, 0);
  });
});

test("lidarr trackIds from an unrelated album are refused before any command", async () => {
  await withServers({ lidarrReleaseTracks: { 77: [501, 502], 78: [503] } }, async (port, logs) => {
    const result = await callTool(port, "lidarr_execute_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: [{ candidateId: 333, artistId: 5, albumId: 9, albumReleaseId: 77, trackIds: [999] }],
    });
    assert.equal(result.isError, true);
    assert.match(result.text, /not tracks of album release 77/);
    assert.equal(requestsTo(logs.lidarr, "POST", "/api/v1/command").length, 0);
  });
});

test("lidarr surfaces (does not authorize) candidate tracks outside the selected release's track query", async () => {
  // Release 77's track list is [501]; Lidarr's recomputed mapping includes
  // 502, which the release query does not contain. A valid override [501]
  // proceeds, and the inconsistency is reported — 502 is NOT added to the
  // caller allowlist.
  await withServers(
    { lidarrReleaseTracks: { 77: [501], 78: [503] }, lidarrRecomputedTracks: { 77: [501, 502] } },
    async (port, logs) => {
      const preview = await callTool(port, "lidarr_preview_manual_import", {
        downloadId: LIDARR_DOWNLOAD_ID,
        items: [{ candidateId: 333, artistId: 5, albumId: 9, albumReleaseId: 77, trackIds: [501] }],
      });
      assert.equal(preview.isError, false, preview.text);
      assert.deepEqual(preview.payload.items[0].releaseTrackMismatch, [502], "candidate track outside the release query is surfaced");
      assert.match(JSON.stringify(preview.payload.notes), /Inconsistency surfaced/);

      // The surfaced track is not an authorization target: overriding to 502
      // is refused even though Lidarr's recomputed mapping contains it.
      const bad = await callTool(port, "lidarr_execute_manual_import", {
        downloadId: LIDARR_DOWNLOAD_ID,
        items: [{ candidateId: 333, artistId: 5, albumId: 9, albumReleaseId: 77, trackIds: [502] }],
      });
      assert.equal(bad.isError, true);
      assert.match(bad.text, /not tracks of album release 77/);
      assert.equal(requestsTo(logs.lidarr, "POST", "/api/v1/command").length, 0);
    },
  );
});

test("lidarr without trackIds uses Lidarr's recomputed mapping (tracksSource=lidarr-recomputed)", async () => {
  await withServers({ lidarrReleaseTracks: { 77: [501, 502], 78: [503] } }, async (port, logs) => {
    const preview = await callTool(port, "lidarr_preview_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: [{ candidateId: 333 }],
    });
    assert.equal(preview.isError, false, preview.text);
    assert.equal(preview.payload.items[0].tracksSource, "lidarr-recomputed");
    assert.deepEqual(preview.payload.items[0].tracks.map((t) => t.id), [501, 502], "server-recomputed release tracks shown as-is");
  });
});

// --- 4. candidate id ambiguity ---------------------------------------------

test("ambiguous candidateId (hash collision: two current candidates share an id) is refused", async () => {
  const twin = { ...SONARR_CANDIDATE, path: "/downloads/complete/The.Good.Fight/The.Good.Fight.S06E05.1080p.mkv", name: "The.Good.Fight.S06E05.1080p" };
  await withServers({ sonarrCandidates: [SONARR_CANDIDATE, twin] }, async (port, logs) => {
    const preview = await callTool(port, "sonarr_preview_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 123 }],
    });
    assert.equal(preview.isError, true);
    assert.match(preview.text, /matches 2 current manual-import candidates/);
    assert.equal(requestsTo(logs.sonarr, "POST", "/api/v3/manualimport").length, 0, "ambiguous id must not be reprocessed");

    const exec = await callTool(port, "sonarr_execute_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 123 }],
    });
    assert.equal(exec.isError, true);
    assert.match(exec.text, /matches 2 current manual-import candidates/);
    assert.equal(requestsTo(logs.sonarr, "POST", "/api/v3/command").length, 0);
  });
});

// --- 17. Sonarr mapping hierarchy: series → season → episodes -------------
//
// Native Interactive Import clears dependents when a parent is reselected
// (InteractiveImportRow.tsx: onSeriesSelect → { seasonNumber: undefined,
// episodes: [] }; onSeasonSelect → { episodes: [] }). It must do so because
// Sonarr's reprocess resolves episode ids GLOBALLY and pairs them with the
// supplied seriesId with no ownership check (ManualImportService.ReprocessItem:
// `_episodeService.GetEpisodes(episodeIds)`), so an inherited child mapping
// across a parent change would be imported, not rejected.

test("seriesId override clears the inherited seasonNumber and episodes", async () => {
  await withServers({ reprocessRejections: [] }, async (port, logs) => {
    const preview = await callTool(port, "sonarr_preview_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 123, seriesId: 88 }],
    });
    assert.equal(preview.isError, false, preview.text);
    const item = preview.payload.items[0];

    assert.equal(item.series.id, 88);
    assert.deepEqual(item.episodes, [], "Series A's episode 9001 must not be carried into Series B");
    assert.equal(item.mappingOverridesApplied.seriesChanged, true);
    assert.equal(item.mappingOverridesApplied.clearedSeasonNumber, true);
    assert.equal(item.mappingOverridesApplied.clearedEpisodeIds, true);
    assert.equal(item.episodesRequired, true, "preview reports that episodes must be selected");
    assert.equal(item.mappingValid, false);
    assert.equal(item.canExecuteWithoutOverride, false);

    const reprocess = requestsTo(logs.sonarr, "POST", "/api/v3/manualimport")[0];
    assert.equal(reprocess.body[0].seriesId, 88);
    assert.equal(reprocess.body[0].seasonNumber, null, "the inherited season is cleared, not reused");
    assert.deepEqual(reprocess.body[0].episodeIds, [], "the inherited episodes are cleared, not reused");

    const exec = await callTool(port, "sonarr_execute_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 123, seriesId: 88 }],
    });
    assert.equal(exec.isError, true, "an incomplete mapping must not be importable");
    assert.match(exec.text, /no episode mapping after reprocessing/);
    assert.equal(requestsTo(logs.sonarr, "POST", "/api/v3/command").length, 0, "no command for an incomplete mapping");
  });
});

test("seasonNumber override clears the inherited episodes", async () => {
  await withServers({ reprocessRejections: [] }, async (port, logs) => {
    const preview = await callTool(port, "sonarr_preview_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 123, seasonNumber: 0 }],
    });
    assert.equal(preview.isError, false, preview.text);
    const item = preview.payload.items[0];

    assert.equal(item.mappingOverridesApplied.seasonChanged, true);
    assert.equal(item.mappingOverridesApplied.clearedSeasonNumber, false, "the season was supplied explicitly, so it is kept");
    assert.equal(item.mappingOverridesApplied.clearedEpisodeIds, true);
    assert.deepEqual(item.episodes, [], "season 6's episode 9001 must not be inherited into season 0");
    assert.equal(item.episodesRequired, true);

    const reprocess = requestsTo(logs.sonarr, "POST", "/api/v3/manualimport")[0];
    assert.equal(reprocess.body[0].seasonNumber, 0);
    assert.deepEqual(reprocess.body[0].episodeIds, []);

    const exec = await callTool(port, "sonarr_execute_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 123, seasonNumber: 0 }],
    });
    assert.equal(exec.isError, true);
    assert.match(exec.text, /no episode mapping after reprocessing/);
    assert.equal(requestsTo(logs.sonarr, "POST", "/api/v3/command").length, 0);
  });
});

test("cross-series episodeIds are refused before any reprocess or command", async () => {
  await withServers({ reprocessRejections: [] }, async (port, logs) => {
    // 9001 belongs to series 47 season 6; the effective target is series 88 season 1.
    const exec = await callTool(port, "sonarr_execute_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 123, seriesId: 88, seasonNumber: 1, episodeIds: [9001] }],
    });
    assert.equal(exec.isError, true, exec.text);
    assert.match(exec.text, /not episodes of the effective series\/season/);
    const refusal = JSON.parse(exec.text);
    assert.deepEqual(refusal.invalidSelections[0].unknownEpisodeIds, [9001]);
    assert.equal(refusal.invalidSelections[0].effectiveSeriesId, 88);
    assert.equal(refusal.invalidSelections[0].effectiveSeasonNumber, 1);
    assert.equal(requestsTo(logs.sonarr, "POST", "/api/v3/manualimport").length, 0, "refused before reprocess");
    assert.equal(requestsTo(logs.sonarr, "POST", "/api/v3/command").length, 0, "refused before command");

    // Preview surfaces the same finding without failing.
    const preview = await callTool(port, "sonarr_preview_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 123, seriesId: 88, seasonNumber: 1, episodeIds: [9001] }],
    });
    assert.equal(preview.isError, false, "preview stays non-destructive and reports the problem");
    const item = preview.payload.items[0];
    assert.equal(item.episodeValidation.ok, false);
    assert.deepEqual(item.episodeValidation.unknownEpisodeIds, [9001]);
    assert.equal(item.canExecuteWithoutOverride, false);
  });
});

test("cross-season episodeIds are refused before any reprocess or command", async () => {
  await withServers({ reprocessRejections: [] }, async (port, logs) => {
    // Series is right, season is wrong: 9001 is a season-6 episode, target is season 0.
    const exec = await callTool(port, "sonarr_execute_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 123, seriesId: 47, seasonNumber: 0, episodeIds: [9001] }],
    });
    assert.equal(exec.isError, true, exec.text);
    const refusal = JSON.parse(exec.text);
    assert.deepEqual(refusal.invalidSelections[0].unknownEpisodeIds, [9001]);
    assert.equal(refusal.invalidSelections[0].effectiveSeasonNumber, 0);
    assert.match(refusal.invalidSelections[0].reason, /seasonNumber=0/);
    assert.equal(requestsTo(logs.sonarr, "POST", "/api/v3/command").length, 0);
  });
});

test("a series override clears the inherited season, so episodeIds have no effective season to validate against", async () => {
  await withServers({ reprocessRejections: [] }, async (port, logs) => {
    const preview = await callTool(port, "sonarr_preview_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 123, seriesId: 88, episodeIds: [9100] }],
    });
    assert.equal(preview.isError, false, preview.text);
    const item = preview.payload.items[0];
    assert.equal(item.mappingOverridesApplied.seriesChanged, true);
    assert.equal(item.mappingOverridesApplied.clearedSeasonNumber, true, "the inherited season 6 was cleared by the series change");
    assert.equal(item.episodeValidation.ok, false, "with no effective season the selection cannot be validated");

    const exec = await callTool(port, "sonarr_execute_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 123, seriesId: 88, episodeIds: [9100] }],
    });
    assert.equal(exec.isError, true, exec.text);
    assert.match(exec.text, /valid effective seasonNumber/);
    assert.equal(requestsTo(logs.sonarr, "POST", "/api/v3/command").length, 0);
  });
});

test("valid remap: corrected series + season + episodes previews and executes", async () => {
  await withServers({ reprocessRejections: [] }, async (port, logs) => {
    const items = [{ candidateId: 123, seriesId: 88, seasonNumber: 1, episodeIds: [9100] }];

    const preview = await callTool(port, "sonarr_preview_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items,
    });
    assert.equal(preview.isError, false, preview.text);
    const item = preview.payload.items[0];
    assert.equal(item.series.id, 88);
    assert.equal(item.series.title, "A Different Series", "the EFFECTIVE series' real title");
    assert.equal(item.seasonNumber, 1);
    assert.deepEqual(item.episodes.map((e) => e.id), [9100]);
    assert.equal(item.episodeValidation.ok, true);
    assert.equal(item.mappingValid, true);
    assert.equal(item.episodesRequired, false);

    const exec = await callTool(port, "sonarr_execute_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items,
    });
    assert.equal(exec.isError, false, exec.text);
    const command = requestsTo(logs.sonarr, "POST", "/api/v3/command")[0].body;
    assert.equal(command.files[0].seriesId, 88);
    assert.deepEqual(command.files[0].episodeIds, [9100], "the corrected selection is what imports");
    assert.equal(command.files[0].path, SONARR_CANDIDATE.path, "path still comes from the native candidate");
    assert.equal(exec.payload.status, "queued");
  });
});

test("preview reports the EFFECTIVE series title, never the original candidate's title under an overridden id", async () => {
  await withServers({ reprocessRejections: [] }, async (port, logs) => {
    const preview = await callTool(port, "sonarr_preview_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 123, seriesId: 88, seasonNumber: 1, episodeIds: [9100] }],
    });
    assert.equal(preview.isError, false, preview.text);
    const item = preview.payload.items[0];
    assert.deepEqual(item.series, { id: 88, title: "A Different Series" });
    assert.notEqual(item.series.title, "The Good Fight", "the stale Series A title must never pair with Series B's id");

    const seriesGets = requestsTo(logs.sonarr, "GET", "/api/v3/series/88");
    assert.equal(seriesGets.length, 1, "the effective series is fetched from the native endpoint");

    // An unmodified candidate keeps its own embedded series — no extra lookup.
    const plain = await callTool(port, "sonarr_preview_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 123 }],
    });
    assert.deepEqual(plain.payload.items[0].series, { id: 47, title: "The Good Fight" });
    assert.equal(requestsTo(logs.sonarr, "GET", "/api/v3/series/47").length, 0, "no lookup when the id is unchanged");
  });
});

test("preview returns title: null rather than stale metadata when the effective series lookup fails", async () => {
  await withServers({ reprocessRejections: [], sonarrSeries: {} }, async (port, logs) => {
    const preview = await callTool(port, "sonarr_preview_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 123, seriesId: 88, seasonNumber: 1, episodeIds: [9100] }],
    });
    assert.equal(preview.isError, false, "a failed title lookup must not abort the preview");
    const item = preview.payload.items[0];
    assert.equal(item.series.id, 88, "the effective id is still reported");
    assert.equal(item.series.title, null, "no stale title is substituted for a failed lookup");
  });
});

// --- 18. duplicate candidateId guard --------------------------------------

test("duplicate candidateId in one request is refused before any native request", async () => {
  await withServers({}, async (port, logs) => {
    const items = [{ candidateId: 123 }, { candidateId: 123 }];

    const preview = await callTool(port, "sonarr_preview_manual_import", { downloadId: SONARR_DOWNLOAD_ID, items });
    assert.equal(preview.isError, true);
    assert.match(preview.text, /duplicate candidateId 123/);
    assert.equal(logs.sonarr.length, 0, "refused at parse time — no discovery, reprocess, or command");

    const exec = await callTool(port, "sonarr_execute_manual_import", { downloadId: SONARR_DOWNLOAD_ID, items });
    assert.equal(exec.isError, true);
    assert.match(exec.text, /duplicate candidateId 123/);
    assert.equal(requestsTo(logs.sonarr, "POST", "/api/v3/command").length, 0);

    // Shared parsing: the guard applies to the other services too.
    const radarr = await callTool(port, "radarr_execute_manual_import", { downloadId: "dl-11", items: [{ candidateId: 222 }, { candidateId: 222 }] });
    assert.equal(radarr.isError, true);
    assert.match(radarr.text, /duplicate candidateId 222/);
    const lidarr = await callTool(port, "lidarr_execute_manual_import", { downloadId: LIDARR_DOWNLOAD_ID, items: [{ candidateId: 333 }, { candidateId: 333 }] });
    assert.equal(lidarr.isError, true);
    assert.match(lidarr.text, /duplicate candidateId 333/);
  });
});

// --- 19. Sonarr seasonNumber input validation -----------------------------

test("seasonNumber overrides must be non-negative integers, refused before any native request", async () => {
  await withServers({}, async (port, logs) => {
    for (const bad of [-1, -0.5, 1.5, 2.7]) {
      const preview = await callTool(port, "sonarr_preview_manual_import", {
        downloadId: SONARR_DOWNLOAD_ID,
        items: [{ candidateId: 123, seasonNumber: bad }],
      });
      assert.equal(preview.isError, true, `seasonNumber ${bad} must be refused`);
      assert.match(preview.text, /seasonNumber must be a non-negative integer/);

      const exec = await callTool(port, "sonarr_execute_manual_import", {
        downloadId: SONARR_DOWNLOAD_ID,
        items: [{ candidateId: 123, seasonNumber: bad }],
      });
      assert.equal(exec.isError, true, `seasonNumber ${bad} must be refused on execute`);
      assert.match(exec.text, /seasonNumber must be a non-negative integer/);
    }
    assert.equal(logs.sonarr.length, 0, "a refused season number must not produce any native request");
  });
});

test("seasonNumber discovery hint is validated before the native discovery request", async () => {
  await withServers({}, async (port, logs) => {
    for (const bad of [-1, 1.5]) {
      const refused = await callTool(port, "sonarr_get_manual_import_candidates", {
        downloadId: SONARR_DOWNLOAD_ID,
        seasonNumber: bad,
      });
      assert.equal(refused.isError, true, `seasonNumber ${bad} must be refused`);
      assert.match(refused.text, /seasonNumber must be a non-negative integer/);
    }
    assert.equal(requestsTo(logs.sonarr, "GET", "/api/v3/manualimport").length, 0, "no native discovery for a refused hint");

    const accepted = await callTool(port, "sonarr_get_manual_import_candidates", {
      downloadId: SONARR_DOWNLOAD_ID,
      seasonNumber: 6,
    });
    assert.equal(accepted.isError, false, accepted.text);
    assert.equal(requestsTo(logs.sonarr, "GET", "/api/v3/manualimport").length, 1);
  });
});

// --- 23. discovery entity hints: positive integers only, refused before any
//         native request (the item-level parser does not see these) ---------

test("discovery entity hints (seriesId/movieId/artistId) must be positive integers, refused before any native request", async () => {
  const cases = [
    { tool: "sonarr_get_manual_import_candidates", key: "seriesId", downloadId: SONARR_DOWNLOAD_ID, log: "sonarr", path: "/api/v3/manualimport" },
    { tool: "radarr_get_manual_import_candidates", key: "movieId", downloadId: "dl-11", log: "radarr", path: "/api/v3/manualimport" },
    { tool: "lidarr_get_manual_import_candidates", key: "artistId", downloadId: LIDARR_DOWNLOAD_ID, log: "lidarr", path: "/api/v1/manualimport" },
  ];
  await withServers({}, async (port, logs) => {
    for (const c of cases) {
      for (const bad of [0, -1, 1.5, "5", null, NaN]) {
        const refused = await callTool(port, c.tool, { downloadId: c.downloadId, [c.key]: bad });
        assert.equal(refused.isError, true, `${c.key}=${JSON.stringify(bad)} must be refused`);
        assert.match(refused.text, new RegExp(`${c.key} must be a positive integer`));
      }
      assert.equal(
        requestsTo(logs[c.log], "GET", c.path).length, 0,
        `a refused ${c.key} hint must produce zero native discovery requests`,
      );

      const accepted = await callTool(port, c.tool, { downloadId: c.downloadId, [c.key]: 5 });
      assert.equal(accepted.isError, false, accepted.text);

      // Omitted stays valid — 0 is never used to mean "unspecified".
      const omitted = await callTool(port, c.tool, { downloadId: c.downloadId });
      assert.equal(omitted.isError, false, omitted.text);
    }
    assert.equal(requestsTo(logs.sonarr, "GET", "/api/v3/manualimport").length, 2, "only the valid-hint and omitted calls reached Sonarr");
    assert.equal(requestsTo(logs.radarr, "GET", "/api/v3/manualimport").length, 2);
    assert.equal(requestsTo(logs.lidarr, "GET", "/api/v1/manualimport").length, 2);
  });
});

test("discovery hint schemas expose integer + minimum 1", async () => {
  await withServers({}, async (port) => {
    const response = await postMcp(port, { jsonrpc: "2.0", id: 9, method: "tools/list", params: {} });
    assert.equal(response.status, 200);
    const body = await mcpEnvelope(response);
    const tools = Object.fromEntries(body.result.tools.map((t) => [t.name, t]));
    const checks = [
      ["sonarr_get_manual_import_candidates", "seriesId"],
      ["radarr_get_manual_import_candidates", "movieId"],
      ["lidarr_get_manual_import_candidates", "artistId"],
    ];
    for (const [tool, field] of checks) {
      const schema = tools[tool].inputSchema.properties[field];
      assert.equal(schema.type, "integer", `${tool}.${field} must be typed integer`);
      assert.equal(schema.minimum, 1, `${tool}.${field} must declare minimum 1`);
    }
    // Sonarr's seasonNumber keeps its own >= 0 rule (0 is the Specials season).
    const season = tools["sonarr_get_manual_import_candidates"].inputSchema.properties.seasonNumber;
    assert.equal(season.type, "integer");
    assert.equal(season.minimum, 0, "seasonNumber is NOT constrained to >= 1 — 0 is a real season");
  });
});

test("seasonNumber 0 (Specials) and 6 are accepted", async () => {
  await withServers({ reprocessRejections: [] }, async (port) => {
    const specials = await callTool(port, "sonarr_preview_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 123, seasonNumber: 0, episodeIds: [62640] }],
    });
    assert.equal(specials.isError, false, "season 0 is the Specials season and must be accepted");
    assert.equal(specials.payload.items[0].seasonNumber, 0);
    assert.equal(specials.payload.items[0].episodeValidation.ok, true);

    const season6 = await callTool(port, "sonarr_preview_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 123, seasonNumber: 6, episodeIds: [9002] }],
    });
    assert.equal(season6.isError, false, season6.text);
    assert.equal(season6.payload.items[0].episodeValidation.ok, true);
  });
});

test("the Sonarr seasonNumber rule is not applied to Radarr or Lidarr requests", async () => {
  await withServers({}, async (port, logs) => {
    // seasonNumber is a Sonarr mapping field; Radarr/Lidarr ignore it, so a
    // value that Sonarr would refuse must not make their tools fail.
    const radarr = await callTool(port, "radarr_preview_manual_import", {
      downloadId: "dl-11",
      items: [{ candidateId: 222, seasonNumber: -1 }],
    });
    assert.equal(radarr.isError, false, radarr.text);

    const lidarr = await callTool(port, "lidarr_preview_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: [{ candidateId: 333, seasonNumber: 1.5 }],
    });
    assert.equal(lidarr.isError, false, lidarr.text);
  });
});

// --- 20. episodeIds validate against the EFFECTIVE season -----------------
//
// The rule is "a valid EFFECTIVE seasonNumber", not "an explicitly supplied
// seasonNumber". A season the candidate already carries, and that no parent
// override cleared, is the effective season: episodeIds alone validate against
// it and need no redundant seasonNumber.

test("episodeIds alone validate against the inherited effective season", async () => {
  await withServers({ reprocessRejections: [] }, async (port, logs) => {
    // Candidate is series 47 season 6; the caller sends only season-6 episodeIds.
    const items = [{ candidateId: 123, episodeIds: [9002] }];

    const preview = await callTool(port, "sonarr_preview_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items,
    });
    assert.equal(preview.isError, false, preview.text);
    const item = preview.payload.items[0];
    assert.equal(item.mappingOverridesApplied.seasonNumber, null, "no seasonNumber was supplied");
    assert.equal(item.mappingOverridesApplied.clearedSeasonNumber, false, "nothing cleared the inherited season");
    assert.equal(item.seasonNumber, 6, "the inherited season is the effective season");
    assert.equal(item.episodeValidation.checked, true, "the caller-supplied ids were validated");
    assert.equal(item.episodeValidation.ok, true, "validated against the inherited season, no refusal");
    assert.equal(item.mappingValid, true);

    const validationGet = requestsTo(logs.sonarr, "GET", "/api/v3/episode")[0];
    assert.equal(validationGet.params.seriesId, "47");
    assert.equal(validationGet.params.seasonNumber, "6", "validated against the inherited season's episode list");

    const exec = await callTool(port, "sonarr_execute_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items,
    });
    assert.equal(exec.isError, false, exec.text);
    const command = requestsTo(logs.sonarr, "POST", "/api/v3/command")[0].body;
    assert.deepEqual(command.files[0].episodeIds, [9002], "the selection imports without a redundant seasonNumber");
  });
});

test("episodeIds are refused only when no valid effective season exists", async () => {
  await withServers({ reprocessRejections: [] }, async (port, logs) => {
    // A series override clears the inherited season, so there is no effective
    // season to validate against — this is the case that requires seasonNumber.
    const exec = await callTool(port, "sonarr_execute_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 123, seriesId: 88, episodeIds: [9100] }],
    });
    assert.equal(exec.isError, true, exec.text);
    assert.match(exec.text, /valid effective seasonNumber/);
    assert.match(exec.text, /no effective season is available/);
    assert.equal(requestsTo(logs.sonarr, "POST", "/api/v3/command").length, 0);

    // Supplying the season the parent change cleared makes the same selection valid.
    const fixed = await callTool(port, "sonarr_execute_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 123, seriesId: 88, seasonNumber: 1, episodeIds: [9100] }],
    });
    assert.equal(fixed.isError, false, fixed.text);
    assert.deepEqual(
      requestsTo(logs.sonarr, "POST", "/api/v3/command")[0].body.files[0].episodeIds,
      [9100],
    );
  });
});

// --- 21. Worked example: a complete-looking proposal that is wrong ---------
//
// The Letterkenny case, kept here as a regression test rather than as runtime
// guidance injected into every response. Sonarr proposed
//   Letterkenny.S04.The.Haunting.of.MoDeans.II  →  S04E01–06
// six real season-4 episodes whose titles have nothing to do with the name's
// title, and reported a complete mapping. The correct target is the season-0
// special of that title. The point the directive preserves: the proposal is
// complete, not verified — titles and numbering are both evidence, and here
// they conflict, so the mapping is ambiguous and must be investigated.

test("worked example: a complete season-4 proposal, remapped to the season-0 special", async () => {
  const letterkenny = {
    ...SONARR_CANDIDATE,
    id: 130,
    path: "/downloads/complete/Letterkenny/Letterkenny.S04.The.Haunting.of.MoDeans.II.1080p.WEB-DL.mkv",
    name: "Letterkenny.S04.The.Haunting.of.MoDeans.II.1080p",
    folderName: "Letterkenny.S04",
    series: { id: 90, title: "Letterkenny" },
    seasonNumber: 4,
    episodes: SONARR_EPISODE_CATALOG["90:4"].map((e) => ({
      id: e.id, seriesId: 90, seasonNumber: 4, episodeNumber: e.episodeNumber, title: e.title,
    })),
    // Equal to the special's existing file (CF 600), matching the real case.
    customFormats: [{ id: 1, name: "NTb", score: 600 }],
    customFormatScore: 600,
    rejections: [],
  };
  const opts = {
    sonarrCandidates: [letterkenny],
    sonarrEpisodeFilesList: [
      { id: 700, quality: QUALITY, customFormatScore: 600 },
      ...SONARR_EPISODE_CATALOG["90:4"].map((e) => ({ id: e.episodeFileId, quality: QUALITY, customFormatScore: 600 })),
    ],
  };

  await withServers(opts, async (port, logs) => {
    // 1. The proposal looks complete — mappingValid: true — and the episode
    //    titles are the evidence an agent must weigh against the release name.
    const proposed = await callTool(port, "sonarr_preview_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 130 }],
    });
    assert.equal(proposed.isError, false, proposed.text);
    const proposal = proposed.payload.items[0];
    assert.equal(proposal.mappingValid, true, "a complete-looking proposal is exactly the trap");
    assert.deepEqual(proposal.episodes.map((e) => e.id), [9201, 9202, 9203, 9204, 9205, 9206]);
    assert.ok(
      proposal.episodes.every((e) => !/haunting/i.test(e.title ?? "")),
      "no detected episode title matches the release name's title — the conflicting evidence",
    );

    // 2. A season-only override must NOT silently keep the season-4 list:
    //    the season change clears the inherited episodes.
    const seasonOnly = await callTool(port, "sonarr_preview_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 130, seasonNumber: 0 }],
    });
    assert.equal(seasonOnly.isError, false, seasonOnly.text);
    const cleared = seasonOnly.payload.items[0];
    assert.deepEqual(cleared.episodes, [], "the season-4 selection is cleared, not carried into season 0");
    assert.equal(cleared.mappingOverridesApplied.clearedEpisodeIds, true);
    assert.equal(cleared.episodesRequired, true);
    assert.equal(cleared.mappingValid, false);

    const seasonOnlyExec = await callTool(port, "sonarr_execute_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 130, seasonNumber: 0 }],
    });
    assert.equal(seasonOnlyExec.isError, true, "the cleared selection cannot be imported");
    assert.equal(requestsTo(logs.sonarr, "POST", "/api/v3/command").length, 0);

    // 3. The full corrected selection imports the special, and the upgrade
    //    decision is evaluated against the special's existing file.
    const remapped = await callTool(port, "sonarr_preview_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 130, seasonNumber: 0, episodeIds: [9300] }],
    });
    assert.equal(remapped.isError, false, remapped.text);
    const target = remapped.payload.items[0];
    assert.equal(target.series.title, "Letterkenny");
    assert.equal(target.seasonNumber, 0);
    assert.deepEqual(target.episodes.map((e) => e.id), [9300]);
    assert.equal(target.episodeValidation.ok, true);
    assert.equal(target.mappingValid, true);
    assert.equal(target.upgradeAssessment.verdict, "no-upgrade-rejection", "the special already has a file; equal quality + equal CF is a neutral replacement");
    assert.equal(target.upgradeAssessment.existingFiles[0].episodeId, 9300);
  });
});

// --- 22. Lidarr mapping hierarchy: artist → album → release → tracks -------
//
// Native Interactive Import clears dependents when a parent is reselected
// (SelectArtistModalContentConnector → { album: undefined, albumReleaseId:
// undefined, tracks: [] }; SelectAlbumModalContentConnector → { albumReleaseId:
// undefined, tracks: [] }; SelectAlbumReleaseModalContentConnector → { tracks:
// [], disableReleaseSwitching: true }). It must, because the native reprocess
// maps supplied ids straight into IdentificationOverrides with precedence
// AlbumRelease > Album > Artist and no ownership check
// (ManualImportController.UpdateImportItems +
// CandidateService.GetDbCandidatesFromTags), so a stale child inherited across
// a parent change is imported, not rejected.

test("artist override clears the inherited album, release and tracks", async () => {
  await withServers({}, async (port, logs) => {
    const preview = await callTool(port, "lidarr_preview_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: [{ candidateId: 333, artistId: 6 }],
    });
    assert.equal(preview.isError, false, preview.text);
    const item = preview.payload.items[0];

    assert.equal(item.artist.id, 6, "the effective artist");
    assert.equal(item.artist.artistName, "Other Artist", "the new artist's real name, not the candidate's");
    assert.equal(item.album, null, "Artist A's Album 9 must not be carried into Artist B");
    assert.equal(item.albumReleaseId, 0, "the inherited release is cleared");
    assert.deepEqual(item.tracks, [], "the inherited track 501 is cleared");
    assert.equal(item.mappingOverridesApplied.artistChanged, true);
    assert.equal(item.mappingOverridesApplied.clearedAlbum, true);
    assert.equal(item.mappingOverridesApplied.clearedAlbumRelease, true);
    assert.equal(item.mappingValid, false);

    const reprocess = requestsTo(logs.lidarr, "POST", "/api/v1/manualimport")[0];
    assert.equal(reprocess.body[0].artistId, 6);
    assert.equal(reprocess.body[0].albumId, null, "the inherited album is cleared, not reused");
    assert.equal(reprocess.body[0].albumReleaseId, null, "the inherited release is cleared, not reused");

    const exec = await callTool(port, "lidarr_execute_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: [{ candidateId: 333, artistId: 6 }],
    });
    assert.equal(exec.isError, true, "an incomplete mapping must not be importable");
    assert.match(exec.text, /no valid album mapping after reprocessing/);
    assert.equal(requestsTo(logs.lidarr, "POST", "/api/v1/command").length, 0, "no command for an incomplete mapping");
  });
});

test("album override clears the inherited release and tracks; Lidarr recomputes them for the new album", async () => {
  await withServers({}, async (port, logs) => {
    const preview = await callTool(port, "lidarr_preview_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: [{ candidateId: 333, albumId: 10 }],
    });
    assert.equal(preview.isError, false, preview.text);
    const item = preview.payload.items[0];

    assert.equal(item.album.id, 10);
    assert.equal(item.album.title, "Other Album", "the effective album's real title");
    assert.equal(item.albumReleaseId, 79, "release 77 is cleared; Lidarr picks a release of album 10");
    assert.deepEqual(item.tracks.map((t) => t.id), [601], "release 77's track 501 is not inherited");
    assert.equal(item.tracksSource, "lidarr-recomputed");
    assert.equal(item.mappingOverridesApplied.albumChanged, true);
    assert.equal(item.mappingOverridesApplied.clearedAlbumRelease, true);
    assert.equal(item.mappingOverridesApplied.clearedAlbum, false, "the album was supplied explicitly, so it is kept");
    assert.equal(item.mappingValid, true);

    const reprocess = requestsTo(logs.lidarr, "POST", "/api/v1/manualimport")[0];
    assert.equal(reprocess.body[0].albumId, 10);
    assert.equal(reprocess.body[0].albumReleaseId, null, "the inherited release is cleared, not reused");

    const exec = await callTool(port, "lidarr_execute_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: [{ candidateId: 333, albumId: 10 }],
    });
    assert.equal(exec.isError, false, exec.text);
    const command = requestsTo(logs.lidarr, "POST", "/api/v1/command")[0].body;
    assert.equal(command.files[0].albumId, 10);
    assert.equal(command.files[0].albumReleaseId, 79, "the recomputed release imports, not the stale 77");
    assert.deepEqual(command.files[0].trackIds, [601], "the recomputed tracks import, not the stale 501");
  });
});

test("release override clears the inherited tracks; no explicit trackIds uses Lidarr's recomputed mapping", async () => {
  await withServers({}, async (port, logs) => {
    const preview = await callTool(port, "lidarr_preview_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: [{ candidateId: 333, albumReleaseId: 78 }],
    });
    assert.equal(preview.isError, false, preview.text);
    const item = preview.payload.items[0];

    assert.equal(item.albumReleaseId, 78);
    assert.deepEqual(item.tracks.map((t) => t.id), [503], "release 77's tracks are not inherited into release 78");
    assert.equal(item.tracksSource, "lidarr-recomputed");
    assert.equal(item.mappingOverridesApplied.releaseChanged, true);
    assert.equal(item.mappingOverridesApplied.disableReleaseSwitching, true, "native UI: an explicit release selection sets disableReleaseSwitching=true");
    assert.equal(item.mappingValid, true);

    const reprocess = requestsTo(logs.lidarr, "POST", "/api/v1/manualimport")[0];
    assert.equal(reprocess.body[0].albumReleaseId, 78);
    assert.equal(reprocess.body[0].disableReleaseSwitching, true);

    const exec = await callTool(port, "lidarr_execute_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: [{ candidateId: 333, albumReleaseId: 78 }],
    });
    assert.equal(exec.isError, false, exec.text);
    const command = requestsTo(logs.lidarr, "POST", "/api/v1/command")[0].body;
    assert.equal(command.files[0].albumReleaseId, 78);
    assert.deepEqual(command.files[0].trackIds, [503], "the recomputed release-78 tracks import");
    assert.equal(command.files[0].disableReleaseSwitching, true);
  });
});

test("disableReleaseSwitching=false is caller-controlled and overrides the explicit-release default", async () => {
  await withServers({}, async (port, logs) => {
    const exec = await callTool(port, "lidarr_execute_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: [{ candidateId: 333, albumReleaseId: 78, trackIds: [503], disableReleaseSwitching: false }],
    });
    assert.equal(exec.isError, false, exec.text);
    const command = requestsTo(logs.lidarr, "POST", "/api/v1/command")[0].body;
    assert.equal(command.files[0].disableReleaseSwitching, false, "an explicit false keeps the album's automatic release selection");
  });
});

test("relationship validation: artist B + album belonging to artist A is refused before any reprocess", async () => {
  await withServers({}, async (port, logs) => {
    // Album 9 belongs to artist 5; the effective artist is 6.
    const exec = await callTool(port, "lidarr_execute_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: [{ candidateId: 333, artistId: 6, albumId: 9, albumReleaseId: 77, trackIds: [501] }],
    });
    assert.equal(exec.isError, true, exec.text);
    const refusal = JSON.parse(exec.text);
    assert.match(JSON.stringify(refusal.invalidMappings[0].relationshipProblems), /belongs to artist 5, not the effective artist 6/);
    assert.equal(refusal.invalidMappings[0].effectiveArtistId, 6);
    assert.equal(requestsTo(logs.lidarr, "POST", "/api/v1/manualimport").length, 0, "refused before reprocess");
    assert.equal(requestsTo(logs.lidarr, "POST", "/api/v1/command").length, 0, "refused before command");

    // Preview surfaces the same finding without failing.
    const preview = await callTool(port, "lidarr_preview_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: [{ candidateId: 333, artistId: 6, albumId: 9, albumReleaseId: 77, trackIds: [501] }],
    });
    assert.equal(preview.isError, false, "preview stays non-destructive and reports the problem");
    const item = preview.payload.items[0];
    assert.equal(item.relationshipValidation.ok, false);
    assert.equal(item.mappingValid, false);
    assert.equal(item.canExecuteWithoutOverride, false);
  });
});

test("relationship validation: album B + release belonging to album A is refused before any reprocess", async () => {
  await withServers({}, async (port, logs) => {
    // Release 77 belongs to album 9; the effective album is 10.
    const exec = await callTool(port, "lidarr_execute_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: [{ candidateId: 333, albumId: 10, albumReleaseId: 77, trackIds: [501] }],
    });
    assert.equal(exec.isError, true, exec.text);
    const refusal = JSON.parse(exec.text);
    assert.match(JSON.stringify(refusal.invalidMappings[0].relationshipProblems), /album release 77 is not a release of album 10/);
    assert.equal(requestsTo(logs.lidarr, "POST", "/api/v1/manualimport").length, 0);
    assert.equal(requestsTo(logs.lidarr, "POST", "/api/v1/command").length, 0);
  });
});

test("child override under a cleared parent is a dependency violation, refused before any reprocess", async () => {
  await withServers({}, async (port, logs) => {
    // The artist change clears the album; a release supplied without the new
    // album has no parent to validate against.
    const exec = await callTool(port, "lidarr_execute_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: [{ candidateId: 333, artistId: 6, albumReleaseId: 80 }],
    });
    assert.equal(exec.isError, true, exec.text);
    const refusal = JSON.parse(exec.text);
    assert.match(JSON.stringify(refusal.invalidMappings[0].dependencyProblems), /albumReleaseId 80 supplied with no effective albumId/);
    assert.equal(requestsTo(logs.lidarr, "POST", "/api/v1/manualimport").length, 0, "refused before reprocess");

    // trackIds under a cleared release: same class.
    const trackExec = await callTool(port, "lidarr_execute_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: [{ candidateId: 333, artistId: 6, trackIds: [501] }],
    });
    assert.equal(trackExec.isError, true, trackExec.text);
    assert.match(JSON.parse(trackExec.text).invalidMappings[0].dependencyProblems.join(" "), /trackIds supplied with no effective albumReleaseId/);
    assert.equal(requestsTo(logs.lidarr, "POST", "/api/v1/manualimport").length, 0);
  });
});

test("full corrected remap into the new artist's album previews and executes with effective metadata", async () => {
  await withServers({}, async (port, logs) => {
    // Artist 6's album 11, release 80, track 701 — the complete selection.
    const items = [{ candidateId: 333, artistId: 6, albumId: 11, albumReleaseId: 80, trackIds: [701] }];

    const preview = await callTool(port, "lidarr_preview_manual_import", { downloadId: LIDARR_DOWNLOAD_ID, items });
    assert.equal(preview.isError, false, preview.text);
    const item = preview.payload.items[0];
    assert.deepEqual(item.artist, { id: 6, artistName: "Other Artist" }, "the effective artist, never the candidate's stale name");
    assert.deepEqual(item.album, { id: 11, title: "Foreign Album" }, "the effective album, never Album 9's title");
    assert.equal(item.albumReleaseId, 80);
    assert.deepEqual(item.tracks.map((t) => t.id), [701]);
    assert.equal(item.relationshipValidation.ok, true);
    assert.equal(item.mappingValid, true);

    const exec = await callTool(port, "lidarr_execute_manual_import", { downloadId: LIDARR_DOWNLOAD_ID, items });
    assert.equal(exec.isError, false, exec.text);
    const command = requestsTo(logs.lidarr, "POST", "/api/v1/command")[0].body;
    assert.equal(command.files[0].artistId, 6);
    assert.equal(command.files[0].albumId, 11);
    assert.equal(command.files[0].albumReleaseId, 80);
    assert.deepEqual(command.files[0].trackIds, [701], "the corrected selection is what imports");
    assert.equal(command.files[0].path, LIDARR_CANDIDATE.path, "path still comes from the native candidate");
  });
});

test("an unchanged candidate keeps its native mapping with no relationship lookups", async () => {
  await withServers({}, async (port, logs) => {
    const preview = await callTool(port, "lidarr_preview_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: [{ candidateId: 333 }],
    });
    assert.equal(preview.isError, false, preview.text);
    const item = preview.payload.items[0];
    assert.equal(item.relationshipValidation.checked, false, "inherited ids are coherent by construction — nothing to validate");
    assert.equal(item.mappingOverridesApplied.disableReleaseSwitching, false, "no explicit release selection, so no release-switching change");
    assert.equal(requestsTo(logs.lidarr, "GET", "/api/v1/release").length, 0, "no relationship-validation lookups for an unmodified candidate");
    assert.equal(logs.lidarr.filter((r) => r.method === "GET" && r.path.startsWith("/api/v1/album/")).length, 1, "the album is read once for release-switch analysis (its monitored release/edition), not for relationship validation");
  });
});

// --- 24. Lidarr preview validates BEFORE the native reprocess --------------
//
// A nonexistent explicit albumId/albumReleaseId makes native Lidarr throw
// inside GetAlbum/GetRelease during POST /manualimport, before the MCP can
// diagnose. Preview is diagnostic: such items are reported, not submitted.

test("preview of a nonexistent albumId: diagnostic entry, never POSTed to /manualimport", async () => {
  await withServers({}, async (port, logs) => {
    const preview = await callTool(port, "lidarr_preview_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: [{ candidateId: 333, albumId: 999999 }],
    });
    assert.equal(preview.isError, false, "preview stays a diagnostic operation");
    const item = preview.payload.items[0];
    assert.equal(item.canPreview, false);
    assert.equal(item.submittedToNativeReprocess, false);
    assert.equal(item.mappingValid, false);
    assert.equal(item.relationshipValidation.ok, false);
    assert.match(JSON.stringify(item.relationshipValidation.problems), /album 999999 could not be fetched/);
    assert.equal(item.album, null, "no fabricated album identity for a failed lookup");
    assert.equal(item.artist, null);

    const posts = requestsTo(logs.lidarr, "POST", "/api/v1/manualimport");
    assert.equal(posts.length, 0, "the invalid item must not be sent to the native reprocess");
    assert.equal(requestsTo(logs.lidarr, "POST", "/api/v1/command").length, 0);
  });
});

test("preview of a nonexistent albumReleaseId: diagnostic entry, never POSTed to /manualimport", async () => {
  await withServers({}, async (port, logs) => {
    // Album 9 exists; release 999999 is not one of its releases.
    const preview = await callTool(port, "lidarr_preview_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: [{ candidateId: 333, albumReleaseId: 999999 }],
    });
    assert.equal(preview.isError, false, preview.text);
    const item = preview.payload.items[0];
    assert.equal(item.canPreview, false);
    assert.equal(item.relationshipValidation.ok, false);
    assert.match(JSON.stringify(item.relationshipValidation.problems), /album release 999999 is not a release of album 9/);

    assert.equal(requestsTo(logs.lidarr, "POST", "/api/v1/manualimport").length, 0, "the invalid item must not be reprocessed");
    assert.equal(requestsTo(logs.lidarr, "POST", "/api/v1/command").length, 0);
  });
});

test("mixed preview: valid candidate reprocessed, invalid one reported diagnostically", async () => {
  const second = { ...LIDARR_CANDIDATE, id: 335, path: "/downloads/complete/Some.Artist/Some.Artist - Some Album/02 - Track Two.flac" };
  await withServers({ lidarrCandidates: [LIDARR_CANDIDATE, second] }, async (port, logs) => {
    const preview = await callTool(port, "lidarr_preview_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: [
        { candidateId: 333, albumId: 9, albumReleaseId: 77, trackIds: [501] }, // valid
        { candidateId: 335, albumId: 999999 },                                  // invalid
      ],
    });
    assert.equal(preview.isError, false, preview.text);
    assert.equal(preview.payload.count, 2, "both candidates are reported");

    const byId = Object.fromEntries(preview.payload.items.map((i) => [i.candidateId, i]));
    assert.equal(byId[333].canPreview, true, "the valid item gets a normal native preview");
    assert.equal(byId[333].mappingValid, true);
    assert.equal(byId[335].canPreview, false, "the invalid item is diagnostic, not submitted");
    assert.equal(byId[335].relationshipValidation.ok, false);

    const posts = requestsTo(logs.lidarr, "POST", "/api/v1/manualimport");
    assert.equal(posts.length, 1, "exactly one reprocess request");
    assert.deepEqual(posts[0].body.map((i) => i.id), [333], "only the valid candidate reaches the native endpoint");
    assert.equal(requestsTo(logs.lidarr, "POST", "/api/v1/command").length, 0, "preview never imports");
  });
});

test("mixed preview returns items in the caller's original order, not valid-then-invalid", async () => {
  const second = { ...LIDARR_CANDIDATE, id: 336, path: "/downloads/complete/Some.Artist/Some.Artist - Some Album/03 - Track Three.flac" };
  await withServers({ lidarrCandidates: [LIDARR_CANDIDATE, second] }, async (port) => {
    // Invalid first, valid second: the response must follow that order.
    const preview = await callTool(port, "lidarr_preview_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: [
        { candidateId: 336, albumId: 999999 },                              // invalid, listed first
        { candidateId: 333, albumId: 9, albumReleaseId: 77, trackIds: [501] }, // valid, listed second
      ],
    });
    assert.equal(preview.isError, false, preview.text);
    assert.deepEqual(
      preview.payload.items.map((i) => i.candidateId),
      [336, 333],
      "preview items follow the caller's item order",
    );
    assert.equal(preview.payload.items[0].canPreview, false);
    assert.equal(preview.payload.items[1].canPreview, true);
  });
});

test("preview reports an existing-but-incoherent mapping diagnostically without submitting it", async () => {
  await withServers({}, async (port, logs) => {
    // Artist 6 + album 9 (belongs to artist 5): both ids exist, the pairing
    // does not. Reported before reprocess, so nothing is submitted.
    const preview = await callTool(port, "lidarr_preview_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: [{ candidateId: 333, artistId: 6, albumId: 9, albumReleaseId: 77, trackIds: [501] }],
    });
    assert.equal(preview.isError, false, preview.text);
    const item = preview.payload.items[0];
    assert.equal(item.canPreview, false);
    assert.equal(item.relationshipValidation.ok, false);
    assert.match(JSON.stringify(item.relationshipValidation.problems), /belongs to artist 5, not the effective artist 6/);
    assert.equal(requestsTo(logs.lidarr, "POST", "/api/v1/manualimport").length, 0, "not submitted");
    assert.equal(requestsTo(logs.lidarr, "POST", "/api/v1/command").length, 0);
  });
});

// --- 20. queue functionality unaffected -----------------------------------

test("queue tools keep working alongside the manual-import tools", async () => {
  await withServers({}, async (port) => {
    const queue = await callTool(port, "sonarr_get_queue", {});
    assert.equal(queue.isError, false, queue.text);
    assert.ok(Array.isArray(queue.payload.items));

    const status = await callTool(port, "arr_status", {});
    assert.equal(status.isError, false, status.text);
  });
});

// --- Lidarr existing-file policy: schema semantics + filter propagation -----
//
// Native Lidarr Interactive Import mapping (verified against Lidarr source):
//   replaceExistingFiles=false → "Combine with existing files" (no album-wide delete)
//   replaceExistingFiles=true  → "Replace Existing Files" / "Existing files will be deleted"
//                                (Lidarr removes ALL existing track files for each
//                                 affected album before importing the selected files)
//   filterExistingFiles=true   → "Unmapped Files Only" (discovery visibility only)
//   filterExistingFiles=false  → "All Files"
// These tests guard against semantic inversion and against the discovery filter
// being conflated with the destructive replacement policy.

async function lidarrToolSchemas(port) {
  const response = await postMcp(port, { jsonrpc: "2.0", id: 42, method: "tools/list", params: {} });
  assert.equal(response.status, 200);
  const body = await mcpEnvelope(response);
  return Object.fromEntries(body.result.tools.map((t) => [t.name, t]));
}

test("lidarr execute schema documents replaceExistingFiles native semantics", async () => {
  await withServers({}, async (port) => {
    const tools = await lidarrToolSchemas(port);
    const desc = tools["lidarr_execute_manual_import"].inputSchema.properties.replaceExistingFiles.description;
    for (const phrase of [
      "false", "Combine with existing files",
      "true", "Replace Existing Files", "Existing files will be deleted",
      "all existing track files", "affected album",
      "partial selection", "import failure",
    ]) {
      assert.ok(desc.toLowerCase().includes(phrase.toLowerCase()), `replaceExistingFiles description must convey "${phrase}"`);
    }
    assert.ok(desc.toLowerCase().includes("copy"), "replaceExistingFiles description must warn that importMode=copy does not neutralize it");
  });
});

test("lidarr schemas document filterExistingFiles as a discovery-only filter, distinct from replacement", async () => {
  await withServers({}, async (port) => {
    const tools = await lidarrToolSchemas(port);
    for (const tool of [
      "lidarr_get_manual_import_candidates",
      "lidarr_preview_manual_import",
      "lidarr_execute_manual_import",
    ]) {
      const desc = tools[tool].inputSchema.properties.filterExistingFiles.description;
      for (const phrase of ["true", "Unmapped Files Only", "false", "All Files"]) {
        assert.ok(desc.toLowerCase().includes(phrase.toLowerCase()), `${tool}.filterExistingFiles must convey "${phrase}"`);
      }
      assert.match(desc, /does NOT delete/i, `${tool}.filterExistingFiles must state it does not delete/replace`);
      assert.match(desc, /replaceExistingFiles/, `${tool}.filterExistingFiles must point to replaceExistingFiles as the separate policy`);
    }
  });
});

test("lidarr preview schema exposes filterExistingFiles", async () => {
  await withServers({}, async (port) => {
    const tools = await lidarrToolSchemas(port);
    const prop = tools["lidarr_preview_manual_import"].inputSchema.properties.filterExistingFiles;
    assert.ok(prop, "preview must expose filterExistingFiles so discovery/preview share one visibility policy");
    assert.equal(prop.type, "boolean");
  });
});

test("lidarr filterExistingFiles=false propagates from discovery to preview discovery", async () => {
  await withServers({}, async (port, logs) => {
    const discovery = await callTool(port, "lidarr_get_manual_import_candidates", {
      downloadId: LIDARR_DOWNLOAD_ID,
      filterExistingFiles: false,
    });
    assert.equal(discovery.isError, false, discovery.text);
    assert.equal(discovery.payload.candidateFilterPolicy.filterExistingFiles, false);
    assert.equal(discovery.payload.candidateFilterPolicy.lidarrUiMode, "All Files");

    const preview = await callTool(port, "lidarr_preview_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: [{ candidateId: 333 }],
      filterExistingFiles: false,
    });
    assert.equal(preview.isError, false, preview.text);
    const previewGet = requestsTo(logs.lidarr, "GET", "/api/v1/manualimport").at(-1);
    assert.equal(previewGet.params.filterExistingFiles, "false", "preview re-fetches with the caller's discovery visibility policy");
  });
});

test("lidarr filterExistingFiles=false propagates to execute's fresh candidate discovery", async () => {
  await withServers({}, async (port, logs) => {
    const result = await callTool(port, "lidarr_execute_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: [{ candidateId: 333 }],
      filterExistingFiles: false,
    });
    assert.equal(result.isError, false, result.text);
    const get = requestsTo(logs.lidarr, "GET", "/api/v1/manualimport")[0];
    assert.equal(get.params.filterExistingFiles, "false", "execute's fresh discovery uses the caller-selected visibility policy");
    assert.equal(result.payload.candidateFilterPolicy.filterExistingFiles, false);
    assert.equal(result.payload.candidateFilterPolicy.lidarrUiMode, "All Files");
  });
});

test("lidarr safe defaults: omitted flags resolve to Unmapped Files Only + Combine with existing files", async () => {
  await withServers({}, async (port, logs) => {
    const preview = await callTool(port, "lidarr_preview_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: [{ candidateId: 333 }],
    });
    assert.equal(preview.isError, false, preview.text);
    assert.equal(preview.payload.candidateFilterPolicy.filterExistingFiles, true);
    assert.equal(preview.payload.candidateFilterPolicy.lidarrUiMode, "Unmapped Files Only");
    assert.equal(preview.payload.existingFilesPolicy.replaceExistingFiles, false);
    assert.equal(preview.payload.existingFilesPolicy.lidarrUiMode, "Combine with existing files");
    assert.equal(preview.payload.existingFilesPolicy.albumWidePreDelete, false);
    const get = requestsTo(logs.lidarr, "GET", "/api/v1/manualimport")[0];
    assert.equal(get.params.filterExistingFiles, "true", "default filter is sent explicitly");
    assert.equal(get.params.replaceExistingFiles, "false", "default replacement policy is Combine with existing files (no album-wide pre-delete)");
  });
});

test("lidarr preview reports the replacement policy without importing (album-wide delete scope)", async () => {
  await withServers({}, async (port, logs) => {
    const combine = await callTool(port, "lidarr_preview_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: [{ candidateId: 333 }],
      replaceExistingFiles: false,
    });
    assert.equal(combine.isError, false, combine.text);
    assert.equal(combine.payload.existingFilesPolicy.lidarrUiMode, "Combine with existing files");
    assert.equal(combine.payload.existingFilesPolicy.albumWidePreDelete, false);

    const replace = await callTool(port, "lidarr_preview_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: [{ candidateId: 333 }],
      replaceExistingFiles: true,
    });
    assert.equal(replace.isError, false, replace.text);
    assert.equal(replace.payload.existingFilesPolicy.replaceExistingFiles, true);
    assert.equal(replace.payload.existingFilesPolicy.lidarrUiMode, "Replace Existing Files");
    assert.equal(replace.payload.existingFilesPolicy.uiWarning, "Existing files will be deleted");
    assert.equal(replace.payload.existingFilesPolicy.albumWidePreDelete, true);
    assert.match(replace.payload.existingFilesPolicy.scope, /each affected album/i, "delete scope is album-wide, not per selected track");
    assert.match(replace.payload.existingFilesPolicy.warning, /partial selection|import failure/i, "warning names the partial-selection/import-failure risk");
    assert.equal(requestsTo(logs.lidarr, "POST", "/api/v1/command").length, 0, "preview never imports, even under the destructive policy");
  });
});

test("lidarr execute echoes the destructive policy and sends replaceExistingFiles exactly as selected", async () => {
  await withServers({}, async (port, logs) => {
    const result = await callTool(port, "lidarr_execute_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: [{ candidateId: 333 }],
      replaceExistingFiles: true,
    });
    assert.equal(result.isError, false, result.text);
    assert.equal(result.payload.existingFilesPolicy.replaceExistingFiles, true);
    assert.equal(result.payload.existingFilesPolicy.lidarrUiMode, "Replace Existing Files");
    assert.equal(result.payload.existingFilesPolicy.albumWidePreDelete, true);
    const command = requestsTo(logs.lidarr, "POST", "/api/v1/command")[0].body;
    assert.equal(command.replaceExistingFiles, true, "the native command receives the caller's explicit choice, never a safety rewrite");
  });
});

// --- release-switch safety guard (the Adele "21" incident) -----------------
//
// Native Lidarr ImportApprovedTracks.Import calls SetMonitored(newRelease) for
// the effective imported release, INDEPENDENT of replaceExistingFiles. So a
// ManualImport targeting a different albumReleaseId silently changes the
// album's monitored edition (17-track deluxe → 11-track standard) even with
// replaceExistingFiles=false. allowRejected, replaceExistingFiles and
// disableReleaseSwitching must NOT authorize that switch — it needs its own
// exact album/from/to authorization.

test("lidarr preview detects a cross-edition release switch (17-track deluxe → 11-track standard)", async () => {
  await withServers(incidentOpts(), async (port) => {
    const preview = await callTool(port, "lidarr_preview_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: INCIDENT_CANDIDATES.map((c) => ({ candidateId: c.id })),
    });
    assert.equal(preview.isError, false, preview.text);
    const impact = preview.payload.releaseSwitchImpact.find((i) => i.albumId === 9);
    assert.ok(impact, "releaseSwitchImpact present for album 9");
    assert.equal(impact.releaseWillChange, true);
    assert.equal(impact.currentRelease.id, 100);
    assert.equal(impact.currentRelease.trackCount, 17);
    assert.equal(impact.proposedRelease.id, 200);
    assert.equal(impact.proposedRelease.trackCount, 11);
    assert.equal(impact.sharedRecordingCount, 11);
    assert.equal(impact.currentOnlyRecordingCount, 6);
    assert.equal(impact.proposedOnlyRecordingCount, 0);
    assert.equal(impact.albumHasExistingFiles, true);
    assert.equal(impact.requiresAuthorization, true);
    assert.match(impact.warning, /not merely a quality upgrade/i);
    assert.match(impact.warning, /allowRejected does NOT authorize/i);
    assert.match(JSON.stringify(preview.payload.notes), /not merely a quality upgrade|release switch/i);
  });
});

test("lidarr preview suggests exact preserve-current-release remaps for the 11 shared recordings", async () => {
  await withServers(incidentOpts(), async (port) => {
    const preview = await callTool(port, "lidarr_preview_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: INCIDENT_CANDIDATES.map((c) => ({ candidateId: c.id })),
    });
    const impact = preview.payload.releaseSwitchImpact.find((i) => i.albumId === 9);
    assert.equal(impact.preserveCurrentRelease.possible, true);
    assert.equal(impact.preserveCurrentRelease.albumReleaseId, 100);
    assert.equal(impact.preserveCurrentRelease.itemOverrides.length, 11);
    for (let i = 0; i < 11; i++) {
      const ov = impact.preserveCurrentRelease.itemOverrides[i];
      assert.equal(ov.candidateId, 400 + i);
      assert.equal(ov.albumReleaseId, 100, "the suggestion targets the CURRENT monitored release, not 200");
      assert.deepEqual(ov.trackIds, [1001 + i], "the current-release-specific track id for recording rec-" + (i + 1));
      assert.equal(ov.disableReleaseSwitching, false);
    }
    const item = preview.payload.items.find((it) => it.candidateId === 400);
    assert.equal(item.currentReleaseEquivalent.available, true);
    assert.equal(item.currentReleaseEquivalent.albumReleaseId, 100);
    assert.deepEqual(item.currentReleaseEquivalent.trackIds, [1001]);
  });
});

test("lidarr execute hard-blocks an unapproved release switch even with allowRejected=true on every candidate", async () => {
  await withServers(incidentOpts(), async (port, logs) => {
    const result = await callTool(port, "lidarr_execute_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: INCIDENT_CANDIDATES.map((c) => ({ candidateId: c.id, allowRejected: true })),
      replaceExistingFiles: false,
      filterExistingFiles: false,
    });
    assert.equal(result.isError, true, "unapproved release switch must be blocked");
    assert.equal(requestsTo(logs.lidarr, "POST", "/api/v1/command").length, 0, "no command submitted");
    assert.equal(result.payload.error, "Release switch requires explicit authorization.");
    const impact = result.payload.releaseSwitchImpact.find((i) => i.albumId === 9);
    assert.equal(impact.currentRelease.trackCount, 17);
    assert.equal(impact.proposedRelease.trackCount, 11);
    assert.equal(impact.currentOnlyRecordingCount, 6);
  });
});

test("allowRejected=true on every candidate does not bypass the release-switch guard", async () => {
  await withServers(incidentOpts(), async (port, logs) => {
    const noAuth = await callTool(port, "lidarr_execute_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: INCIDENT_CANDIDATES.map((c) => ({ candidateId: c.id, allowRejected: true })),
    });
    assert.equal(noAuth.isError, true, "allowRejected authorizes rejections, not an edition change");
    assert.equal(requestsTo(logs.lidarr, "POST", "/api/v1/command").length, 0);
  });
});

test("replaceExistingFiles=true does not authorize a release switch", async () => {
  await withServers(incidentOpts(), async (port, logs) => {
    const result = await callTool(port, "lidarr_execute_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: INCIDENT_CANDIDATES.map((c) => ({ candidateId: c.id, allowRejected: true })),
      replaceExistingFiles: true,
    });
    assert.equal(result.isError, true, "the existing-file replacement policy is a separate axis from release switching");
    assert.equal(requestsTo(logs.lidarr, "POST", "/api/v1/command").length, 0);
  });
});

test("disableReleaseSwitching=true does not authorize a release switch", async () => {
  await withServers(incidentOpts(), async (port, logs) => {
    const result = await callTool(port, "lidarr_execute_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: INCIDENT_CANDIDATES.map((c) => ({ candidateId: c.id, allowRejected: true, disableReleaseSwitching: true })),
    });
    assert.equal(result.isError, true, "disableReleaseSwitching controls future auto-switching, not this import's SetMonitored");
    assert.equal(requestsTo(logs.lidarr, "POST", "/api/v1/command").length, 0);
  });
});

test("lidarr execute permits an exactly authorized release switch and keeps the intended release", async () => {
  await withServers(incidentOpts(), async (port, logs) => {
    const result = await callTool(port, "lidarr_execute_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: INCIDENT_CANDIDATES.map((c) => ({ candidateId: c.id, allowRejected: true })),
      releaseSwitchAuthorizations: [{ albumId: 9, fromAlbumReleaseId: 100, toAlbumReleaseId: 200 }],
    });
    assert.equal(result.isError, false, result.text);
    const command = requestsTo(logs.lidarr, "POST", "/api/v1/command")[0].body;
    assert.equal(command.files.length, 11);
    assert.ok(command.files.every((f) => f.albumReleaseId === 200), "the intended release 200 imports, no hidden rewrite");
  });
});

test("lidarr execute rejects a stale release-switch authorization when the current release changed", async () => {
  const staleAlbum = {
    ...INCIDENT_ALBUM,
    releases: [
      { id: 101, albumId: 9, foreignReleaseId: "REL-101", title: "Deluxe Remaster", status: "Official", duration: 0, trackCount: 17, monitored: true },
      { id: 200, albumId: 9, foreignReleaseId: "REL-200", title: "Standard Edition", status: "Official", duration: 0, trackCount: 11, monitored: false },
    ],
  };
  await withServers(incidentOpts({ lidarrAlbums: { 9: staleAlbum } }), async (port, logs) => {
    const result = await callTool(port, "lidarr_execute_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: INCIDENT_CANDIDATES.map((c) => ({ candidateId: c.id, allowRejected: true })),
      releaseSwitchAuthorizations: [{ albumId: 9, fromAlbumReleaseId: 100, toAlbumReleaseId: 200 }],
    });
    assert.equal(result.isError, true, "stale authorization (100→200) must not authorize a 101→200 switch");
    assert.equal(requestsTo(logs.lidarr, "POST", "/api/v1/command").length, 0);
  });
});

test("lidarr same-release partial upgrade is allowed without authorization", async () => {
  const sameReleaseCandidates = INCIDENT_CANDIDATES.map((c, i) => ({
    ...c,
    albumReleaseId: 100,
    tracks: [{ id: 1001 + i, title: `Track ${i + 1}`, trackNumber: i + 1, position: i + 1, mediumNumber: 1, foreignRecordingId: `rec-${i + 1}` }],
    rejections: [],
  }));
  const sameTracks = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [400 + i, [1001 + i]]));
  await withServers(incidentOpts({ lidarrCandidates: sameReleaseCandidates, lidarrCandidateTracks: sameTracks }), async (port, logs) => {
    const preview = await callTool(port, "lidarr_preview_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: sameReleaseCandidates.map((c) => ({ candidateId: c.id })),
    });
    const impact = preview.payload.releaseSwitchImpact.find((i) => i.albumId === 9);
    assert.equal(impact.releaseWillChange, false);
    assert.equal(impact.requiresAuthorization, false);

    const exec = await callTool(port, "lidarr_execute_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: sameReleaseCandidates.map((c) => ({ candidateId: c.id })),
    });
    assert.equal(exec.isError, false, exec.text);
    assert.equal(requestsTo(logs.lidarr, "POST", "/api/v1/command").length, 1);
  });
});

test("lidarr first import to an album with no files is allowed despite a release change", async () => {
  const noFilesAlbum = { ...INCIDENT_ALBUM, statistics: { trackFileCount: 0, trackCount: 17, totalTrackCount: 17, sizeOnDisk: 0, percentOfTracks: 0 } };
  await withServers(incidentOpts({ lidarrAlbums: { 9: noFilesAlbum } }), async (port, logs) => {
    const preview = await callTool(port, "lidarr_preview_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: INCIDENT_CANDIDATES.map((c) => ({ candidateId: c.id })),
    });
    const impact = preview.payload.releaseSwitchImpact.find((i) => i.albumId === 9);
    assert.equal(impact.releaseWillChange, true);
    assert.equal(impact.albumHasExistingFiles, false);
    assert.equal(impact.requiresAuthorization, false);

    const exec = await callTool(port, "lidarr_execute_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: INCIDENT_CANDIDATES.map((c) => ({ candidateId: c.id, allowRejected: true })),
    });
    assert.equal(exec.isError, false, exec.text);
    assert.equal(requestsTo(logs.lidarr, "POST", "/api/v1/command").length, 1);
  });
});

test("lidarr execute refuses when one album's candidates resolve to multiple releases", async () => {
  const mixed = [
    { ...INCIDENT_CANDIDATES[0], albumReleaseId: 100, tracks: [{ id: 1001, foreignRecordingId: "rec-1", title: "Track 1", trackNumber: 1, position: 1, mediumNumber: 1 }] },
    { ...INCIDENT_CANDIDATES[1], albumReleaseId: 200, tracks: [{ id: 2002, foreignRecordingId: "rec-2", title: "Track 2", trackNumber: 2, position: 2, mediumNumber: 1 }] },
  ];
  const mixedTracks = { 400: [1001], 401: [2002] };
  await withServers(incidentOpts({ lidarrCandidates: mixed, lidarrCandidateTracks: mixedTracks }), async (port, logs) => {
    const exec = await callTool(port, "lidarr_execute_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: mixed.map((c) => ({ candidateId: c.id, allowRejected: true })),
    });
    assert.equal(exec.isError, true, exec.text);
    assert.match(exec.text, /multiple album releases/i);
    assert.equal(requestsTo(logs.lidarr, "POST", "/api/v1/command").length, 0);
  });
});

test("lidarr execute refuses when the album's current monitored release is ambiguous", async () => {
  const noMonitored = {
    ...INCIDENT_ALBUM,
    releases: [
      { id: 100, albumId: 9, title: "Deluxe Edition", status: "Official", duration: 0, trackCount: 17, monitored: false },
      { id: 200, albumId: 9, title: "Standard Edition", status: "Official", duration: 0, trackCount: 11, monitored: false },
    ],
  };
  await withServers(incidentOpts({ lidarrAlbums: { 9: noMonitored } }), async (port, logs) => {
    const exec = await callTool(port, "lidarr_execute_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: INCIDENT_CANDIDATES.map((c) => ({ candidateId: c.id, allowRejected: true })),
    });
    assert.equal(exec.isError, true, exec.text);
    assert.match(exec.text, /monitored release|cannot be (assessed|evaluated)/i);
    assert.equal(requestsTo(logs.lidarr, "POST", "/api/v1/command").length, 0);
  });
});

test("releaseSwitchAuthorizations are validated at the boundary before any native request", async () => {
  await withServers(incidentOpts(), async (port, logs) => {
    const bad = [
      { albumId: 0, fromAlbumReleaseId: 100, toAlbumReleaseId: 200 },
      { albumId: 9, fromAlbumReleaseId: 0, toAlbumReleaseId: 200 },
      { albumId: 9, fromAlbumReleaseId: 100, toAlbumReleaseId: 0 },
      { albumId: 9, fromAlbumReleaseId: 100, toAlbumReleaseId: 100 },
      { albumId: 9, fromAlbumReleaseId: "100", toAlbumReleaseId: 200 },
      { albumId: 9, fromAlbumReleaseId: 100.5, toAlbumReleaseId: 200 },
      { albumId: 9, fromAlbumReleaseId: -1, toAlbumReleaseId: 200 },
    ];
    for (const auth of bad) {
      const result = await callTool(port, "lidarr_execute_manual_import", {
        downloadId: LIDARR_DOWNLOAD_ID,
        items: INCIDENT_CANDIDATES.map((c) => ({ candidateId: c.id, allowRejected: true })),
        releaseSwitchAuthorizations: [auth],
      });
      assert.equal(result.isError, true, `authorization ${JSON.stringify(auth)} must be refused`);
      assert.match(result.text, /releaseSwitchAuthorizations/i);
      assert.equal(logs.lidarr.length, 0, `malformed authorization ${JSON.stringify(auth)} must be refused before ANY native Lidarr request`);
    }
    // Duplicate albumId refused.
    const dup = await callTool(port, "lidarr_execute_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: INCIDENT_CANDIDATES.map((c) => ({ candidateId: c.id, allowRejected: true })),
      releaseSwitchAuthorizations: [
        { albumId: 9, fromAlbumReleaseId: 100, toAlbumReleaseId: 200 },
        { albumId: 9, fromAlbumReleaseId: 100, toAlbumReleaseId: 201 },
      ],
    });
    assert.equal(dup.isError, true, "duplicate albumId authorization must be refused");
    assert.match(dup.text, /releaseSwitchAuthorizations/i);
    assert.equal(logs.lidarr.length, 0, "refused authorizations produce no native Lidarr request at all");
  });
});

test("lidarr execute schema documents release-switch authorization independence", async () => {
  await withServers({}, async (port) => {
    const tools = await lidarrToolSchemas(port);
    const props = tools["lidarr_execute_manual_import"].inputSchema.properties;
    const allow = props.items.items.properties.allowRejected.description;
    assert.match(allow, /does NOT authorize.*release switch/i, "allowRejected must not authorize release switching");
    const replace = props.replaceExistingFiles.description;
    assert.match(replace, /does NOT authorize.*release switch/i, "replaceExistingFiles must not authorize release switching");
    assert.doesNotMatch(replace, /non-destructive/i, "replaceExistingFiles=false must not be described as non-destructive");
    const auth = props.releaseSwitchAuthorizations;
    assert.ok(auth, "releaseSwitchAuthorizations present in the execute schema");
    assert.match(auth.description, /album.*from.*to/i, "authorization is exact album/from/to authority");
  });
});

test("lidarr disableReleaseSwitching schema states it does not keep the current release for this import", async () => {
  await withServers({}, async (port) => {
    const tools = await lidarrToolSchemas(port);
    for (const tool of ["lidarr_preview_manual_import", "lidarr_execute_manual_import"]) {
      const desc = tools[tool].inputSchema.properties.items.items.properties.disableReleaseSwitching.description;
      assert.match(desc, /does NOT (prevent|keep)/i, "must clarify it does not prevent this import's release change");
    }
  });
});

test("lidarr_get_albums surfaces the monitored release and per-release track counts", async () => {
  await withServers(incidentOpts(), async (port) => {
    const result = await callTool(port, "lidarr_get_albums", { artistId: 5 });
    assert.equal(result.isError, false, result.text);
    const album = result.payload.albums.find((a) => a.id === 9);
    assert.equal(album.anyReleaseOk, true);
    assert.equal(album.monitoredRelease.id, 100);
    assert.equal(album.monitoredRelease.trackCount, 17);
    assert.equal(album.releases.length, 2);
    const deluxe = album.releases.find((r) => r.id === 100);
    const standard = album.releases.find((r) => r.id === 200);
    assert.equal(deluxe.monitored, true);
    assert.equal(deluxe.trackCount, 17);
    assert.equal(standard.monitored, false);
    assert.equal(standard.trackCount, 11);
    assert.equal(standard.foreignReleaseId, "REL-200");
  });
});

// --- release-switch safety fails closed when album state is unavailable -----
//
// The guard must never infer "safe first import" from a failed album lookup.
// An ordinary GET /album/{id} failure (500 / connection / malformed) is NOT
// "zero existing files" — it is an unknown safety state, so preview reports
// assessmentAvailable=false and execute refuses with no command. Request
// timeouts and operation aborts keep their existing typed behavior.

test("lidarr preview reports assessment unavailable when the album lookup fails (500)", async () => {
  await withServers(incidentOpts({ lidarrAlbumLookupError: 500 }), async (port, logs) => {
    const preview = await callTool(port, "lidarr_preview_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: INCIDENT_CANDIDATES.map((c) => ({ candidateId: c.id })),
    });
    assert.equal(preview.isError, false, "preview stays diagnostic (non-destructive)");
    const impact = preview.payload.releaseSwitchImpact.find((i) => i.albumId === 9);
    assert.equal(impact.assessmentAvailable, false, "unavailable album state is never treated as assessable");
    assert.equal(impact.requiresAuthorization, true);
    assert.equal(impact.currentRelease, null);
    assert.match(impact.warning, /could not be fetched|cannot be assessed/i);
    assert.equal(requestsTo(logs.lidarr, "POST", "/api/v1/command").length, 0);
  });
});

test("lidarr execute hard-refuses when the album state cannot be fetched (500)", async () => {
  await withServers(incidentOpts({ lidarrAlbumLookupError: 500 }), async (port, logs) => {
    const result = await callTool(port, "lidarr_execute_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: INCIDENT_CANDIDATES.map((c) => ({ candidateId: c.id, allowRejected: true })),
    });
    assert.equal(result.isError, true, "unverifiable album state must fail closed");
    assert.equal(requestsTo(logs.lidarr, "POST", "/api/v1/command").length, 0, "no command on unverifiable album state");
    assert.match(result.text, /cannot be assessed|could not be fetched|release switch/i);
  });
});

test("releaseSwitchAuthorizations cannot authorize execution when album state is unavailable", async () => {
  await withServers(incidentOpts({ lidarrAlbumLookupError: 500 }), async (port, logs) => {
    const result = await callTool(port, "lidarr_execute_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: INCIDENT_CANDIDATES.map((c) => ({ candidateId: c.id, allowRejected: true })),
      releaseSwitchAuthorizations: [{ albumId: 9, fromAlbumReleaseId: 100, toAlbumReleaseId: 200 }],
    });
    assert.equal(result.isError, true, "authorization cannot prove current==100 when the album lookup failed");
    assert.equal(requestsTo(logs.lidarr, "POST", "/api/v1/command").length, 0);
  });
});

test("lidarr treats missing album statistics as unknown existing-file state, not zero", async () => {
  const noStats = { ...INCIDENT_ALBUM, statistics: undefined };
  await withServers(incidentOpts({ lidarrAlbums: { 9: noStats } }), async (port, logs) => {
    const preview = await callTool(port, "lidarr_preview_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: INCIDENT_CANDIDATES.map((c) => ({ candidateId: c.id })),
    });
    const impact = preview.payload.releaseSwitchImpact.find((i) => i.albumId === 9);
    assert.equal(impact.assessmentAvailable, false, "missing statistics is unknown, not a safe first import");

    const exec = await callTool(port, "lidarr_execute_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: INCIDENT_CANDIDATES.map((c) => ({ candidateId: c.id, allowRejected: true })),
    });
    assert.equal(exec.isError, true, exec.text);
    assert.equal(requestsTo(logs.lidarr, "POST", "/api/v1/command").length, 0);
  });
});

test("lidarr known zero trackFileCount still allows a first-import release selection", async () => {
  const zero = { ...INCIDENT_ALBUM, statistics: { trackFileCount: 0, trackCount: 17, totalTrackCount: 17, sizeOnDisk: 0, percentOfTracks: 0 } };
  await withServers(incidentOpts({ lidarrAlbums: { 9: zero } }), async (port, logs) => {
    const preview = await callTool(port, "lidarr_preview_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: INCIDENT_CANDIDATES.map((c) => ({ candidateId: c.id })),
    });
    const impact = preview.payload.releaseSwitchImpact.find((i) => i.albumId === 9);
    assert.equal(impact.albumHasExistingFiles, false);
    assert.equal(impact.assessmentAvailable, true, "known zero is assessable, unlike missing statistics");
    assert.equal(impact.requiresAuthorization, false);

    const exec = await callTool(port, "lidarr_execute_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: INCIDENT_CANDIDATES.map((c) => ({ candidateId: c.id, allowRejected: true })),
    });
    assert.equal(exec.isError, false, exec.text);
    assert.equal(requestsTo(logs.lidarr, "POST", "/api/v1/command").length, 1);
  });
});

test("lidarr preserve-current-release is invalid when two candidates map to the same current track", async () => {
  // Release 200's tracks 2001 and 2002 both carry recording rec-1, so the two
  // incoming files resolve to the SAME current-release track (1001). The
  // preserve suggestion must refuse, not present a one-to-many remap as safe.
  const dupCatalog = {
    100: INCIDENT_RELEASE_CATALOG[100],
    200: INCIDENT_RELEASE_CATALOG[200].map((t) => (t.id === 2002 ? { ...t, foreignRecordingId: "rec-1" } : t)),
  };
  const dup = [INCIDENT_CANDIDATES[0], INCIDENT_CANDIDATES[1]];
  const dupTracks = { 400: [2001], 401: [2002] };
  await withServers(incidentOpts({ lidarrCandidates: dup, lidarrCandidateTracks: dupTracks, lidarrReleaseTrackCatalog: dupCatalog }), async (port) => {
    const preview = await callTool(port, "lidarr_preview_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: dup.map((c) => ({ candidateId: c.id })),
    });
    const impact = preview.payload.releaseSwitchImpact.find((i) => i.albumId === 9);
    assert.equal(impact.preserveCurrentRelease.possible, false, "two candidates cannot share one destination track");
    assert.match(JSON.stringify(impact.preserveCurrentRelease.problems), /more than one incoming candidate/i);
    assert.ok(!impact.preserveCurrentRelease.itemOverrides || impact.preserveCurrentRelease.itemOverrides.length === 0, "no usable overrides emitted");
  });
});

test("lidarr incident fixture still produces 11 unique safe remaps", async () => {
  await withServers(incidentOpts(), async (port) => {
    const preview = await callTool(port, "lidarr_preview_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: INCIDENT_CANDIDATES.map((c) => ({ candidateId: c.id })),
    });
    const impact = preview.payload.releaseSwitchImpact.find((i) => i.albumId === 9);
    assert.equal(impact.assessmentAvailable, true);
    assert.equal(impact.preserveCurrentRelease.possible, true);
    const overrides = impact.preserveCurrentRelease.itemOverrides;
    assert.equal(overrides.length, 11);
    const destIds = overrides.flatMap((o) => o.trackIds);
    assert.equal(new Set(destIds).size, 11, "11 unique destination current-release track ids");
  });
});

// --- missing statistics fails closed unless the proposed release is provably
// the album's single monitored release -------------------------------------
//
// trackFileCount = null is UNKNOWN existing-file state, not zero. The MCP may
// only proceed when it can positively prove the proposed release is already the
// album's one and only monitored release. 0 / 2+ monitored releases with unknown
// file state are unverifiable, so preview reports assessmentAvailable=false and
// execute refuses with no command. A known 0 (first import) stays allowed.

test("lidarr missing statistics + zero monitored releases fails closed", async () => {
  const noStatsNoMonitored = {
    ...INCIDENT_ALBUM,
    statistics: undefined,
    releases: [
      { id: 100, albumId: 9, title: "Deluxe Edition", trackCount: 17, monitored: false },
      { id: 200, albumId: 9, title: "Standard Edition", trackCount: 11, monitored: false },
    ],
  };
  await withServers(incidentOpts({ lidarrAlbums: { 9: noStatsNoMonitored } }), async (port, logs) => {
    const preview = await callTool(port, "lidarr_preview_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: INCIDENT_CANDIDATES.map((c) => ({ candidateId: c.id })),
    });
    const impact = preview.payload.releaseSwitchImpact.find((i) => i.albumId === 9);
    assert.equal(impact.assessmentAvailable, false, "unknown file state with no monitored release is not assessable");
    assert.equal(impact.requiresAuthorization, true);

    const exec = await callTool(port, "lidarr_execute_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: INCIDENT_CANDIDATES.map((c) => ({ candidateId: c.id, allowRejected: true })),
    });
    assert.equal(exec.isError, true, exec.text);
    assert.equal(requestsTo(logs.lidarr, "POST", "/api/v1/command").length, 0);
  });
});

test("lidarr missing statistics + multiple monitored releases fails closed", async () => {
  const noStatsMultiMonitored = {
    ...INCIDENT_ALBUM,
    statistics: undefined,
    releases: [
      { id: 100, albumId: 9, title: "Deluxe Edition", trackCount: 17, monitored: true },
      { id: 101, albumId: 9, title: "Deluxe Remaster", trackCount: 17, monitored: true },
      { id: 200, albumId: 9, title: "Standard Edition", trackCount: 11, monitored: false },
    ],
  };
  await withServers(incidentOpts({ lidarrAlbums: { 9: noStatsMultiMonitored } }), async (port, logs) => {
    const preview = await callTool(port, "lidarr_preview_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: INCIDENT_CANDIDATES.map((c) => ({ candidateId: c.id })),
    });
    const impact = preview.payload.releaseSwitchImpact.find((i) => i.albumId === 9);
    assert.equal(impact.assessmentAvailable, false, "unknown file state with multiple monitored releases is not assessable");
    assert.equal(impact.requiresAuthorization, true);

    const exec = await callTool(port, "lidarr_execute_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: INCIDENT_CANDIDATES.map((c) => ({ candidateId: c.id, allowRejected: true })),
    });
    assert.equal(exec.isError, true, exec.text);
    assert.equal(requestsTo(logs.lidarr, "POST", "/api/v1/command").length, 0);
  });
});

test("lidarr missing statistics + proposed release is the single monitored release stays allowed", async () => {
  const noStatsSameMonitored = {
    ...INCIDENT_ALBUM,
    statistics: undefined,
    releases: [
      { id: 100, albumId: 9, title: "Deluxe Edition", trackCount: 17, monitored: false },
      { id: 200, albumId: 9, title: "Standard Edition", trackCount: 11, monitored: true },
    ],
  };
  await withServers(incidentOpts({ lidarrAlbums: { 9: noStatsSameMonitored } }), async (port, logs) => {
    const preview = await callTool(port, "lidarr_preview_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: INCIDENT_CANDIDATES.map((c) => ({ candidateId: c.id })),
    });
    const impact = preview.payload.releaseSwitchImpact.find((i) => i.albumId === 9);
    assert.equal(impact.releaseWillChange, false, "importing the album's monitored release is not an edition switch");
    assert.equal(impact.assessmentAvailable, true, "the proposed release is provably the single monitored release");
    assert.equal(impact.requiresAuthorization, false);

    const exec = await callTool(port, "lidarr_execute_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: INCIDENT_CANDIDATES.map((c) => ({ candidateId: c.id, allowRejected: true })),
    });
    assert.equal(exec.isError, false, exec.text);
    assert.equal(requestsTo(logs.lidarr, "POST", "/api/v1/command").length, 1);
  });
});

test("releaseSwitchAuthorizations cannot bypass an unknown file state", async () => {
  const noStatsNoMonitored = {
    ...INCIDENT_ALBUM,
    statistics: undefined,
    releases: [
      { id: 100, albumId: 9, title: "Deluxe Edition", trackCount: 17, monitored: false },
      { id: 200, albumId: 9, title: "Standard Edition", trackCount: 11, monitored: false },
    ],
  };
  await withServers(incidentOpts({ lidarrAlbums: { 9: noStatsNoMonitored } }), async (port, logs) => {
    const exec = await callTool(port, "lidarr_execute_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: INCIDENT_CANDIDATES.map((c) => ({ candidateId: c.id, allowRejected: true })),
      releaseSwitchAuthorizations: [{ albumId: 9, fromAlbumReleaseId: 100, toAlbumReleaseId: 200 }],
    });
    assert.equal(exec.isError, true, "authorization expresses intent, not evidence — it cannot prove from=100 when the state is unknown");
    assert.equal(requestsTo(logs.lidarr, "POST", "/api/v1/command").length, 0);
  });
});
