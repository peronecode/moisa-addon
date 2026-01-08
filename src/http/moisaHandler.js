const addonInterface = require('../addon');
const { log, logError } = require('../utils/logger');
const fs = require('fs');
const path = require('path');

/**
 * Decode a `config=<base64>` query parameter into a plain object.
 */
function decodeConfig(query) {
  if (!query || !query.config) return null;
  try {
    const json = Buffer.from(String(query.config), 'base64').toString('utf8');
    const cfg = JSON.parse(json);
    return cfg && typeof cfg === 'object' ? cfg : null;
  } catch {
    return null;
  }
}

/**
 * Main HTTP handler used both for local `server.js` and Vercel `api/moisa.js`.
 *
 * Routes:
 *   - GET /favicon.ico                     – 32x32 browser tab icon.
 *   - GET /assets/*                       – static assets (PNG/SVG/WebP icons, logos, etc.).
 *   - GET /manifest.json                  – Stremio addon manifest (includes `logo` field).
 *   - GET /stream/:type/:id.json          – Stremio stream resource.
 *   - GET /play?infoHash=...              – proxy that resolves to a direct TorrServer URL.
 *   - GET /config or /configure           – lightweight HTML config UI.
 */
module.exports = async (req, res) => {
  // Derive a full URL object from the incoming request.
  const baseProto =
    req.headers['x-forwarded-proto'] ||
    (req.connection && req.connection.encrypted)
      ? 'https'
      : 'http';
  const baseHost = req.headers.host || 'localhost';
  const fullUrl = new URL(req.url, `${baseProto}://${baseHost}`);
  const baseUrl = `${baseProto}://${baseHost}`;

  // Normalized path relative to the API root, e.g. "/manifest.json".
  const pathname = fullUrl.pathname.replace(/^\/api\/moisa/, '') || '/';
  const query = Object.fromEntries(fullUrl.searchParams.entries());

  // CORS – needed for Stremio Web.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept'
  );
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  // ---------------------------------------------------------------------------
  // Favicon: /favicon.ico -> 32x32 PNG icon used in the browser tab.
  // ---------------------------------------------------------------------------

  if (pathname === '/favicon.ico') {
    const faviconPath = path.join(
      __dirname,
      '..',
      '..',
      'assets',
      'moisa-addon-icon-32.png'
    );

    fs.stat(faviconPath, (err, stat) => {
      if (err || !stat.isFile()) {
        res.statusCode = 404;
        res.end('Not found');
        return;
      }

      res.setHeader('Content-Type', 'image/png');

      const stream = fs.createReadStream(faviconPath);
      stream.on('error', () => {
        res.statusCode = 500;
        res.end('Error reading favicon');
      });
      stream.pipe(res);
    });

    return;
  }

  // ---------------------------------------------------------------------------
  // Static assets: /assets/* – icons and other static files for the addon.
  // ---------------------------------------------------------------------------

  if (pathname.startsWith('/assets/')) {
    const assetRelPath = pathname.replace(/^\/assets\//, '');
    const assetPath = path.join(__dirname, '..', '..', 'assets', assetRelPath);

    fs.stat(assetPath, (err, stat) => {
      if (err || !stat.isFile()) {
        res.statusCode = 404;
        res.end('Not found');
        return;
      }

      const ext = path.extname(assetPath).toLowerCase();
      const mimeTypes = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.webp': 'image/webp'
      };

      res.setHeader(
        'Content-Type',
        mimeTypes[ext] || 'application/octet-stream'
      );

      const stream = fs.createReadStream(assetPath);
      stream.on('error', () => {
        res.statusCode = 500;
        res.end('Error reading asset');
      });
      stream.pipe(res);
    });

    return;
  }

  // ---------------------------------------------------------------------------
  // Configuration page – HTML UI used in the browser to generate the addon URL.
  // HTML is kept in a separate file (`configure.html`) to avoid inline markup.
  // ---------------------------------------------------------------------------

  if (pathname === '/config' || pathname === '/configure') {
    const htmlPath = path.join(__dirname, 'configure.html');
    fs.readFile(htmlPath, 'utf8', (err, content) => {
      if (err) {
        logError('Failed to read configure.html', {
          message: err.message || String(err),
          stack: err.stack
        });
        res.statusCode = 500;
        res.end('Internal server error');
        return;
      }

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.statusCode = 200;
      res.end(content);
    });
    return;
  }

  // ---------------------------------------------------------------------------
  // Manifest
  // ---------------------------------------------------------------------------

  if (pathname === '/' || pathname === '/manifest.json') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.statusCode = 200;
    const manifest = {
      ...addonInterface.manifest,
      // Use a single static 256x256 PNG icon for the addon logo.
      logo: `${baseUrl}/assets/moisa-addon-icon-256.png`
    };
    res.end(JSON.stringify(manifest));
    return;
  }

  // ---------------------------------------------------------------------------
  // Stream: /stream/:type/:id.json
  // ---------------------------------------------------------------------------

  if (pathname.startsWith('/stream/')) {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length < 3) {
      res.statusCode = 404;
      res.end(JSON.stringify({ err: 'not found' }));
      return;
    }

    const type = parts[1];
    const rawId = parts[2].replace(/\.json$/, '');
    const id = decodeURIComponent(rawId);

    const proto =
      req.headers['x-forwarded-proto'] || req.connection.encrypted
        ? 'https'
        : 'http';
    const host = req.headers.host;
    const baseUrl = `${proto}://${host}`;

    const cfg = decodeConfig(query);
    const extra = {
      ...(query || {}),
      ...(cfg && cfg.torrserver ? { torrserver: cfg.torrserver } : {}),
      ...(cfg && cfg.torrentioPathPrefix
        ? { torrentioPathPrefix: cfg.torrentioPathPrefix }
        : {}),
      _base: baseUrl
    };

    log('HTTP /stream', { type, id, extra });

    try {
      const response = await addonInterface.get('stream', type, id, extra);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.statusCode = 200;
      res.end(JSON.stringify(response));
    } catch (err) {
      logError('Moisa HTTP stream handler error', {
        message: err.message || String(err),
        stack: err.stack
      });
      res.statusCode = 500;
      res.end(JSON.stringify({ err: 'handler error' }));
    }
    return;
  }

  // ---------------------------------------------------------------------------
  // Play proxy: /play?infoHash=...
  // ---------------------------------------------------------------------------

  if (pathname === '/play') {
    const cfg = decodeConfig(query);

    const infoHash = query.infoHash;
    const type = query.type;
    const id = query.id;
    const filename = query.filename;
    const fileIndex =
      query.fileIndex !== undefined ? parseInt(query.fileIndex, 10) : undefined;

    if (!infoHash || !type || !id) {
      res.statusCode = 400;
      res.end(JSON.stringify({ err: 'missing required parameters' }));
      return;
    }

    // Keep precedence consistent with the /stream handler:
    // 1) explicit ?torrserver=... (set by the addon when building /play URLs)
    // 2) cfg.torrserver decoded from ?config=...
    // 3) TORRSERVER_URL from env
    // 4) localhost default
    const torrServerBase =
      query.torrserver ||
      (cfg && cfg.torrserver) ||
      process.env.TORRSERVER_URL ||
      'http://127.0.0.1:8090';

    const season =
      query.season !== undefined ? parseInt(query.season, 10) : undefined;
    const episode =
      query.episode !== undefined ? parseInt(query.episode, 10) : undefined;

    log('HTTP /play request', {
      type,
      id,
      infoHash,
      torrServerBase,
      season,
      episode,
      filename,
      fileIndex
    });

    try {
      const directUrl = await addonInterface.resolvePlayUrl({
        torrServerBase,
        type,
        id,
        infoHash,
        season: Number.isNaN(season) ? undefined : season,
        episode: Number.isNaN(episode) ? undefined : episode,
        filename,
        fileIndex: Number.isNaN(fileIndex) ? undefined : fileIndex
      });

      if (!directUrl) {
        res.statusCode = 404;
        res.end(JSON.stringify({ err: 'unable to resolve stream' }));
        return;
      }

      log('HTTP /play redirect', {
        type,
        id,
        infoHash,
        location: directUrl
      });

      res.statusCode = 302;
      res.setHeader('Location', directUrl);
      res.end();
    } catch (err) {
      logError('Moisa HTTP play proxy error', {
        message: err.message || String(err),
        stack: err.stack
      });
      res.statusCode = 500;
      res.end(JSON.stringify({ err: 'play handler error' }));
    }
    return;
  }

  // ---------------------------------------------------------------------------
  // Fallback 404
  // ---------------------------------------------------------------------------

  res.statusCode = 404;
  res.end(JSON.stringify({ err: 'not found' }));
};


