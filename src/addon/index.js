const { addonBuilder } = require('stremio-addon-sdk');
const axios = require('axios');
const { log, logWarn, logError } = require('../utils/logger');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Base URL of the Torrentio service.
const TORRENTIO_BASE =
  process.env.TORRENTIO_BASE || 'https://torrentio.strem.fun';

// Path segment before `/stream/...` (quality filter etc.).
const TORRENTIO_PATH_PREFIX =
  process.env.TORRENTIO_PATH_PREFIX ||
  'qualityfilter=threed,480p,scr,cam,unknown';

// Base URL of the TorrServer instance.
// Used as a fallback when no explicit `torrserver` is provided via query/config.
const TORRSERVER_URL =
  process.env.TORRSERVER_URL || 'http://127.0.0.1:8090';

// Timeout for requests to Torrentio (in milliseconds).
const TORRENTIO_TIMEOUT_MS =
  Number(process.env.TORRENTIO_TIMEOUT_MS) || 25000;

// ---------------------------------------------------------------------------
// Addon manifest
// ---------------------------------------------------------------------------

const builder = new addonBuilder({
  id: 'org.stremio.moisa.addon',
  version: '1.1.1',
  name: 'Moisa',
  description:
    'Simple addon: fetches torrents from Torrentio and redirects playback to a local TorrServer instance.',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: []
});

// ---------------------------------------------------------------------------
// Torrentio integration
// ---------------------------------------------------------------------------

/**
 * Fetch stream candidates from Torrentio for a given item.
 *
 * The quality/path filter can be overridden per request via
 * `torrentioPathPrefix` so users can customize from the config page.
 */
async function fetchTorrentioStreams({ type, id, torrentioPathPrefix }) {
  const prefix = torrentioPathPrefix || TORRENTIO_PATH_PREFIX;
  const url = `${TORRENTIO_BASE}/${prefix}/stream/${type}/${id}.json`;

  log('fetchTorrentioStreams request', { type, id, url });

  const { data } = await axios.get(url, {
    timeout: TORRENTIO_TIMEOUT_MS
  });

  if (!data || !Array.isArray(data.streams)) {
    logWarn('Torrentio responded without a streams array', {
      type,
      id
    });
    return [];
  }

  log('fetchTorrentioStreams response', {
    type,
    id,
    count: data.streams.length
  });

  return data.streams;
}

// ---------------------------------------------------------------------------
// Play proxy helpers
// ---------------------------------------------------------------------------

/**
 * Build a URL that points back to this addon, which will then resolve the
 * correct TorrServer file and redirect to it via `/play`.
 */
function buildPlayProxyUrl({
  selfBase,
  infoHash,
  type,
  id,
  season,
  episode,
  torrServerBase,
  filename,
  fileIndex
}) {
  if (!selfBase || !infoHash) return null;

  const base = selfBase.replace(/\/+$/, '');
  const params = new URLSearchParams();

  params.set('infoHash', infoHash);
  params.set('type', type);
  params.set('id', id);

  if (torrServerBase) params.set('torrserver', torrServerBase);
  if (filename) params.set('filename', filename);
  if (season !== undefined && season !== null) {
    params.set('season', String(season));
  }
  if (episode !== undefined && episode !== null) {
    params.set('episode', String(episode));
  }
  if (fileIndex !== undefined && fileIndex !== null) {
    params.set('fileIndex', String(fileIndex));
  }

  return `${base}/play?${params.toString()}`;
}

/**
 * Build a single Stremio stream entry from a Torrentio candidate.
 * This does not talk to TorrServer yet – it only constructs a `/play` URL
 * that the HTTP handler will later translate to a direct TorrServer URL.
 */
async function buildStremioStreamFromCandidate({
  candidate,
  index,
  type,
  id,
  torrServerBase,
  selfBase,
  season,
  episode
}) {
  if (!candidate.infoHash) {
    logWarn('Skipping candidate without infoHash', { type, id, index });
    return null;
  }

  if (!selfBase) {
    logWarn('No addon base URL available; cannot build play proxy URL', {
      type,
      id,
      index
    });
    return null;
  }

  const filename =
    (candidate.behaviorHints && candidate.behaviorHints.filename) || '';

  // Torrentio usually provides fileIdx which matches the internal index of
  // the file within the torrent. We pass this through to `/play` and later
  // into TorrServer.
  const fileIndex =
    typeof candidate.fileIdx === 'number'
      ? candidate.fileIdx
      : Number.isInteger(Number(candidate.fileIdx))
        ? Number(candidate.fileIdx)
        : undefined;

  const title = candidate.title || filename || candidate.name || 'Moisa stream';

  const name = candidate.name || (filename ? `Moisa • ${filename}` : 'Moisa');

  const streamUrl = buildPlayProxyUrl({
    selfBase,
    infoHash: candidate.infoHash,
    type,
    id,
    season,
    episode,
    torrServerBase,
    filename,
    fileIndex
  });

  if (!streamUrl) {
    logWarn('Failed to build play proxy URL for candidate', {
      type,
      id,
      index
    });
    return null;
  }

  return {
    name,
    title,
    url: streamUrl
  };
}

/**
 * Resolve a single play request into a direct TorrServer URL.
 * Called only when the user actually starts playback.
 */
async function resolvePlayUrl({
  torrServerBase,
  type,
  id,
  infoHash,
  season,
  episode,
  filename,
  fileIndex
}) {
  if (!torrServerBase || !infoHash) {
    return null;
  }

  const base = torrServerBase.replace(/\/+$/, '');
  const safeName = encodeURIComponent(
    (filename && String(filename)) || 'video'
  );

  // TorrServer `/stream` expects a 1-based file index within the torrent.
  //
  // Torrentio's `fileIdx` is often reliable for series episodes (multi-file
  // torrents), but can be incorrect for some movie torrents (where we usually
  // want the main video file).
  let index = 0;
  if (type === 'movie') {
    index = 1;
  } else if (
    fileIndex !== undefined &&
    fileIndex !== null &&
    !Number.isNaN(Number(fileIndex))
  ) {
    // Torrentio's fileIdx is 0-based; TorrServer expects 1-based.
    index = Number(fileIndex) + 1;
  }

  const directUrl = `${base}/stream/${safeName}?link=${encodeURIComponent(
    infoHash
  )}&index=${index}&play`;

  log('resolvePlayUrl (no TorrServer stat/preload)', {
    type,
    id,
    infoHash,
    season,
    episode,
    requestedFileIndex: fileIndex,
    resolvedIndex: index,
    torrServerBase,
    directUrl
  });

  return directUrl;
}

// ---------------------------------------------------------------------------
// Stremio stream handler
// ---------------------------------------------------------------------------

builder.defineStreamHandler(async ({ type, id, extra }) => {
  try {
    // Determine TorrServer base URL:
    // 1) prefer explicit override from `extra` (?torrserver=... via config)
    // 2) fall back to explicit environment variable TORRSERVER_URL (or localhost default)
    const torrServerBase =
      (extra && extra.torrserver) || TORRSERVER_URL || null;

    if (!torrServerBase) {
      logWarn('No TorrServer base URL configured', { type, id, extra });
      return { streams: [] };
    }

    // Determine the base URL of this addon (used for proxy /play URLs).
    // Prefer an explicit environment override (e.g. SELF_BASE_URL=https://moisa.fun/api/moisa)
    // and only fall back to the value forwarded from the HTTP layer.
    const selfBase =
      process.env.SELF_BASE_URL || (extra && extra._base) || null;

    log('Resolved bases for stream handler', {
      type,
      id,
      torrServerBase,
      selfBase
    });

    // 1. Ask Torrentio for available torrents. Allow override of the
    //    quality/path prefix via extra.torrentioPathPrefix (from config).
    const streams = await fetchTorrentioStreams({
      type,
      id,
      torrentioPathPrefix: extra && extra.torrentioPathPrefix
    });

    if (!streams.length) {
      logWarn('No streams returned from Torrentio', { type, id });
      return { streams: [] };
    }

    // 2. Extract season/episode info for series (from id and/or extra).
    let season;
    let episode;

    if (type === 'series') {
      const idParts = String(id).split(':');
      if (idParts.length >= 3) {
        const maybeSeason = parseInt(idParts[idParts.length - 2], 10);
        const maybeEpisode = parseInt(idParts[idParts.length - 1], 10);
        if (!Number.isNaN(maybeSeason)) season = maybeSeason;
        if (!Number.isNaN(maybeEpisode)) episode = maybeEpisode;
      }

      if (extra) {
        if (season === undefined && extra.season) {
          const s = parseInt(extra.season, 10);
          if (!Number.isNaN(s)) season = s;
        }
        if (episode === undefined && extra.episode) {
          const e = parseInt(extra.episode, 10);
          if (!Number.isNaN(e)) episode = e;
        }
      }
    }

    // 3. Build multiple stream options, one per Torrentio candidate.
    const stremioStreams = (
      await Promise.all(
        streams
          // Limit to a reasonable number to avoid cluttering the UI.
          .slice(0, 25)
          .map((candidate, index) =>
            buildStremioStreamFromCandidate({
              candidate,
              index,
              type,
              id,
              torrServerBase,
              selfBase,
              season,
              episode
            })
          )
      )
    ).filter(Boolean);

    if (!stremioStreams.length) {
      logWarn('No valid candidates after building proxy URLs', { type, id });
      return { streams: [] };
    }

    return { streams: stremioStreams };
  } catch (err) {
    logError('Stream handler error', {
      message: err.message || String(err),
      stack: err.stack
    });
    return { streams: [] };
  }
});

const addonInterface = builder.getInterface();

// Expose a helper for the HTTP layer to resolve /play requests.
addonInterface.resolvePlayUrl = resolvePlayUrl;

module.exports = addonInterface;
