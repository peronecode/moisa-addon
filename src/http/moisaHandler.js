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
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  // Handle HEAD requests (used by players to check file metadata)
  const isHeadRequest = req.method === 'HEAD';

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
  // Play proxy: /play?infoHash=... or /play/filename.mkv?infoHash=...
  // ---------------------------------------------------------------------------

  if (pathname === '/play' || pathname.startsWith('/play/')) {
    const cfg = decodeConfig(query);

    const infoHash = query.infoHash;
    const type = query.type;
    const id = query.id;
    
    // Extract filename from URL path or query parameter
    let filename = query.filename;
    if (pathname.startsWith('/play/') && pathname.length > 6) {
      const urlFilename = decodeURIComponent(pathname.substring(6)); // Remove '/play/'
      filename = urlFilename || filename;
    }
    const title = query.title;
    const fileIndex =
      query.fileIndex !== undefined ? parseInt(query.fileIndex, 10) : undefined;
    
    // Additional metadata for external players
    const videoSize = query.videoSize;
    const videoCodec = query.videoCodec;
    const audioCodec = query.audioCodec;

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
      fileIndex,
      title,
      videoSize,
      videoCodec,
      audioCodec
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

      // Check if we should proxy the stream or redirect
      const proxyEnabled = process.env.ENABLE_PROXY_MODE !== 'false';
      const forceProxy = req.url.includes('proxy=1');
      const forceRedirect = req.url.includes('proxy=0');
      
      const shouldProxy = !forceRedirect && (
        forceProxy || 
        (proxyEnabled && req.headers['user-agent'] && (
          req.headers['user-agent'].includes('VLC') || 
          req.headers['user-agent'].includes('MPV') ||
          req.headers['user-agent'].includes('Kodi') ||
          req.headers['user-agent'].includes('PotPlayer') ||
          req.headers['user-agent'].includes('MPC-') ||
          req.headers['user-agent'].includes('IINA') ||
          req.headers['user-agent'].includes('Infuse') ||
          req.headers['user-agent'].includes('FireCore') ||
          req.headers['user-agent'].includes('Apple TV') ||
          req.headers['user-agent'].includes('tvOS')
        ))
      );

      if (shouldProxy) {
        // Proxy the video stream while preserving metadata headers
        log('HTTP /play proxying stream', { directUrl });
        
        // Set metadata headers before proxying
        if (filename) {
          res.setHeader('X-Filename', encodeURIComponent(filename));
          // Also set Content-Disposition for better filename handling
          res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
        }
        if (title && title !== filename) {
          res.setHeader('X-Title', encodeURIComponent(title));
        }
        if (season !== undefined && !Number.isNaN(season)) {
          res.setHeader('X-Season', String(season));
        }
        if (episode !== undefined && !Number.isNaN(episode)) {
          res.setHeader('X-Episode', String(episode));
        }
        if (type) {
          res.setHeader('X-Content-Type', type);
        }
        if (infoHash) {
          res.setHeader('X-Info-Hash', infoHash);
        }
        if (videoSize) {
          res.setHeader('X-Video-Size', videoSize);
        }
        if (videoCodec) {
          res.setHeader('X-Video-Codec', videoCodec);
        }
        if (audioCodec) {
          res.setHeader('X-Audio-Codec', audioCodec);
        }

        // Proxy the video stream from TorrServer
        try {
          const axios = require('axios');
          
          // Prepare headers to forward to TorrServer
          const proxyHeaders = {
            'User-Agent': req.headers['user-agent'] || 'Moisa-Proxy/1.0'
          };
          
          // Forward Range header for seeking support
          if (req.headers.range) {
            proxyHeaders['Range'] = req.headers.range;
          }
          
          // Forward other relevant headers
          if (req.headers['accept-encoding']) {
            proxyHeaders['Accept-Encoding'] = req.headers['accept-encoding'];
          }

          const requestConfig = {
            method: isHeadRequest ? 'HEAD' : 'GET',
            url: directUrl,
            headers: proxyHeaders,
            responseType: isHeadRequest ? 'text' : 'stream',
            timeout: 30000, // 30 second timeout
            maxRedirects: 5
          };

          log('Proxying request to TorrServer', {
            method: requestConfig.method,
            url: directUrl,
            headers: proxyHeaders
          });

          const response = await axios(requestConfig);

          // Set response status
          res.statusCode = response.status;

          // Forward response headers from TorrServer, preserving our metadata headers
          const headersToSkip = ['transfer-encoding', 'connection', 'keep-alive'];
          Object.keys(response.headers).forEach(key => {
            const lowerKey = key.toLowerCase();
            if (!headersToSkip.includes(lowerKey)) {
              // Don't overwrite our custom metadata headers
              if (!lowerKey.startsWith('x-') || !res.getHeader(key)) {
                res.setHeader(key, response.headers[key]);
              }
            }
          });

          // Set additional headers for better player compatibility
          res.setHeader('Accept-Ranges', 'bytes');
          res.setHeader('Connection', 'close');
          
          // Additional headers for iOS/tvOS players like Infuse
          const userAgent = req.headers['user-agent'] || '';
          if (userAgent.includes('Infuse') || userAgent.includes('FireCore') || 
              userAgent.includes('Apple TV') || userAgent.includes('tvOS') || 
              userAgent.includes('iPhone') || userAgent.includes('iPad')) {
            
            // Infuse expects these for proper metadata handling
            res.setHeader('Cache-Control', 'no-cache');
            
            // Better MIME type detection for Infuse
            if (filename) {
              const ext = filename.toLowerCase();
              if (ext.includes('.mkv')) {
                res.setHeader('Content-Type', 'video/x-matroska');
              } else if (ext.includes('.mp4')) {
                res.setHeader('Content-Type', 'video/mp4');
              } else if (ext.includes('.avi')) {
                res.setHeader('Content-Type', 'video/x-msvideo');
              } else if (ext.includes('.mov')) {
                res.setHeader('Content-Type', 'video/quicktime');
              }
            }
            
            // Enhanced filename for Infuse's library scanning
            if (filename && season !== undefined && episode !== undefined) {
              const enhancedFilename = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')} - ${filename}`;
              res.setHeader('Content-Disposition', `inline; filename="${enhancedFilename}"`);
            }
          }

          if (isHeadRequest) {
            // For HEAD requests, just end without body
            res.end();
          } else {
            // For GET requests, pipe the video stream
            response.data.on('error', (streamError) => {
              logError('Stream error during proxy', {
                message: streamError.message,
                directUrl
              });
              if (!res.headersSent) {
                res.statusCode = 500;
                res.end();
              }
            });

            res.on('close', () => {
              // Clean up if client disconnects
              if (response.data.destroy) {
                response.data.destroy();
              }
            });

            response.data.pipe(res);
          }
          
        } catch (proxyError) {
          logError('Failed to proxy video stream', {
            message: proxyError.message,
            status: proxyError.response ? proxyError.response.status : 'unknown',
            directUrl
          });
          
          // Better error handling
          if (proxyError.code === 'ECONNREFUSED' || proxyError.code === 'ENOTFOUND') {
            res.statusCode = 502; // Bad Gateway
            res.end(JSON.stringify({ err: 'TorrServer unavailable' }));
          } else if (proxyError.response && proxyError.response.status) {
            res.statusCode = proxyError.response.status;
            res.end();
          } else {
            // Fallback to redirect if proxy fails
            res.statusCode = 302;
            res.setHeader('Location', directUrl);
            res.end();
          }
        }
        
      } else {
        // Standard redirect for regular Stremio players
        // Set metadata headers for external players that might parse them
        if (filename) {
          res.setHeader('X-Filename', encodeURIComponent(filename));
        }
        if (title && title !== filename) {
          res.setHeader('X-Title', encodeURIComponent(title));
        }
        if (season !== undefined && !Number.isNaN(season)) {
          res.setHeader('X-Season', String(season));
        }
        if (episode !== undefined && !Number.isNaN(episode)) {
          res.setHeader('X-Episode', String(episode));
        }
        if (type) {
          res.setHeader('X-Content-Type', type);
        }
        if (infoHash) {
          res.setHeader('X-Info-Hash', infoHash);
        }
        if (videoSize) {
          res.setHeader('X-Video-Size', videoSize);
        }
        if (videoCodec) {
          res.setHeader('X-Video-Codec', videoCodec);
        }
        if (audioCodec) {
          res.setHeader('X-Audio-Codec', audioCodec);
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
      }
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
  // Playlist endpoint: /playlist.m3u8?infoHash=... (for Infuse and similar players)
  // ---------------------------------------------------------------------------
  
  if ((pathname === '/playlist.m3u8' || pathname.endsWith('.m3u8')) && 
      process.env.ENABLE_M3U8_PLAYLISTS === 'true') {
    const infoHash = query.infoHash;
    const filename = query.filename || 'video.mkv';
    const title = query.title || filename;
    const season = query.season;
    const episode = query.episode;
    
    if (!infoHash) {
      res.statusCode = 400;
      res.end('Missing infoHash parameter');
      return;
    }

    // Build the play URL - ensure it doesn't create a circular reference
    const playQuery = { ...query };
    delete playQuery.playlist; // Remove any playlist parameter to avoid loops
    
    const playUrl = `${baseUrl}/play/${encodeURIComponent(filename)}?${new URLSearchParams(playQuery).toString()}`;

    // Create an M3U8 playlist with metadata
    let playlist = '#EXTM3U\n';
    playlist += '#EXT-X-VERSION:3\n';
    playlist += '#EXT-X-TARGETDURATION:3600\n';
    playlist += '#EXT-X-MEDIA-SEQUENCE:0\n';
    
    // Add metadata for Infuse
    if (season && episode) {
      playlist += `#EXTINF:-1,S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')} - ${title}\n`;
    } else {
      playlist += `#EXTINF:-1,${title}\n`;
    }
    
    playlist += `${playUrl}\n`;
    playlist += '#EXT-X-ENDLIST\n';

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache');
    res.statusCode = 200;
    res.end(playlist);
    return;
  }

  // ---------------------------------------------------------------------------
  // Fallback 404
  // ---------------------------------------------------------------------------

  res.statusCode = 404;
  res.end(JSON.stringify({ err: 'not found' }));
};


