/**
 * @file utils/yt-dlp.js
 * @description Utilidades para integrar yt-dlp como fuente de audio de respaldo.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { Readable } = require('stream');
const { StreamType, createAudioResource } = require('@discordjs/voice');
const YTDlpWrap = require('yt-dlp-wrap').default;
const logger = require('./logger');
const { getYtDlpBinaryPath } = require('../services/playlist');

const YT_DLP_TIMEOUT_MS = Number(process.env.YT_DLP_TIMEOUT_MS || 90000);
const STREAM_TIMEOUT_MS = Number(process.env.YT_DLP_STREAM_TIMEOUT_MS || 45000);
let ytDlpInstance = null;
let cachedCookiePath = null;
let cachedCookieMtime = 0;

function getYtDlpInstance() {
  if (ytDlpInstance) return ytDlpInstance;

  try {
    const binaryPath = getYtDlpBinaryPath();
    ytDlpInstance = binaryPath ? new YTDlpWrap(binaryPath) : new YTDlpWrap();
    return ytDlpInstance;
  } catch (error) {
    logger.warn('[yt-dlp] No se pudo inicializar yt-dlp', { error: error.message });
    return null;
  }
}

function ensureNetscapeCookieFile() {
  try {
    const cookieJsonPath = path.join(process.cwd(), 'cookies.json');
    if (!fs.existsSync(cookieJsonPath)) {
      cachedCookiePath = null;
      cachedCookieMtime = 0;
      return null;
    }

    const stat = fs.statSync(cookieJsonPath);
    if (cachedCookiePath && cachedCookieMtime === stat.mtimeMs && fs.existsSync(cachedCookiePath)) {
      return cachedCookiePath;
    }

    const cookieData = JSON.parse(fs.readFileSync(cookieJsonPath, 'utf8'));
    if (!Array.isArray(cookieData) || cookieData.length === 0) {
      return null;
    }

    const lines = ['# Netscape HTTP Cookie File'];

    for (const cookie of cookieData) {
      if (!cookie || !cookie.name || typeof cookie.value === 'undefined') continue;

      const domain = cookie.domain || '.youtube.com';
      const hostOnly = cookie.hostOnly === true ? 'FALSE' : 'TRUE';
      const pathValue = cookie.path || '/';
      const secure = cookie.secure ? 'TRUE' : 'FALSE';
      const expiry = Number.isFinite(cookie.expirationDate) ? Math.floor(cookie.expirationDate) : 0;
      lines.push([
        domain,
        hostOnly,
        pathValue,
        secure,
        expiry,
        cookie.name,
        cookie.value
      ].join('\t'));
    }

    const tempPath = path.join(os.tmpdir(), `bot-discord-yt-${process.pid}.cookies`);
    fs.writeFileSync(tempPath, lines.join(os.EOL));

    cachedCookiePath = tempPath;
    cachedCookieMtime = stat.mtimeMs;
    return cachedCookiePath;
  } catch (error) {
    logger.warn('[yt-dlp] No se pudo generar archivo de cookies Netscape', { error: error.message });
    return null;
  }
}

async function execYtDlpJson(url) {
  const ytDlp = getYtDlpInstance();
  if (!ytDlp) return null;

  const cookiePath = ensureNetscapeCookieFile();
  const args = [
    '--dump-single-json',
    '--no-warnings',
    '--no-check-certificate',
    '--ignore-config',
    '--no-playlist',
    '-f', 'bestaudio[ext=webm][acodec=opus]/bestaudio/best',
    '--socket-timeout', String(Math.floor(STREAM_TIMEOUT_MS / 1000)),
  ];

  if (cookiePath) {
    args.push('--cookies', cookiePath);
  }

  args.push(url);

  try {
    let killedByTimeout = false;
    const promise = ytDlp.execPromise(args);
    const timeout = setTimeout(() => {
      killedByTimeout = true;
      try {
        promise.ytDlpProcess?.kill('SIGKILL');
      } catch {}
    }, YT_DLP_TIMEOUT_MS);

    try {
      const output = (await promise).trim();
      if (!output) {
        throw new Error('yt-dlp returned empty response');
      }
      return JSON.parse(output);
    } catch (error) {
      if (killedByTimeout) {
        throw new Error('yt-dlp timeout');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

  } catch (error) {
    logger.warn('[yt-dlp] Error ejecutando yt-dlp', { error: error.message });
    return null;
  }
}

function normalizeInfo(info) {
  if (!info) return null;

  const base = info.requested_downloads && info.requested_downloads[0]
    ? info.requested_downloads[0]
    : info;

  const headers = { ...(info.http_headers || {}), ...(base.http_headers || {}) };

  return {
    url: base.url || info.url,
    ext: (base.ext || info.ext || '').toLowerCase(),
    acodec: (base.acodec || info.acodec || '').toLowerCase(),
    abr: base.abr || info.abr,
    headers
  };
}

function inferStreamType(info) {
  if (!info) return StreamType.Arbitrary;

  if (info.ext === 'webm' && info.acodec.includes('opus')) {
    return StreamType.WebmOpus;
  }

  if (info.ext === 'opus' || info.acodec === 'opus') {
    return StreamType.WebmOpus;
  }

  if (info.ext === 'ogg' || info.acodec.includes('vorbis')) {
    return StreamType.OggOpus;
  }

  return StreamType.Arbitrary;
}

function requestStream(streamUrl, headers) {
  return new Promise((resolve, reject) => {
    try {
      const urlObj = new URL(streamUrl);
      const isHttps = urlObj.protocol === 'https:';
      const lib = isHttps ? https : http;

      const request = lib.request({
        protocol: urlObj.protocol,
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: `${urlObj.pathname}${urlObj.search}`,
        headers: headers || {},
        method: 'GET'
      }, (response) => {
        const status = response.statusCode || 0;
        if (status >= 200 && status < 300 && response.readable) {
          resolve(response);
        } else {
          const error = new Error(`yt-dlp stream HTTP ${status}`);
          response.resume();
          reject(error);
        }
      });

      request.setTimeout(STREAM_TIMEOUT_MS, () => {
        request.destroy(new Error('yt-dlp stream timeout'));
      });

      request.on('error', reject);
      request.end();
    } catch (error) {
      reject(error);
    }
  });
}

async function createAudioResourceWithYtDlp(url, volume = 1.0) {
  const info = await execYtDlpJson(url);
  const normalized = normalizeInfo(info);

  if (!normalized || !normalized.url) {
    throw new Error('yt-dlp no devolvió una URL válida');
  }

  const stream = await requestStream(normalized.url, normalized.headers);
  const inputType = inferStreamType(normalized);

  const resource = createAudioResource(stream, {
    inputType,
    inlineVolume: true
  });

  if (resource.volume) {
    resource.volume.setVolumeLogarithmic(Math.max(0, Math.min(2, volume)));
  }

  resource.metadata = {
    source: 'yt-dlp',
    abr: normalized.abr || null
  };

  return resource;
}

module.exports = {
  createAudioResourceWithYtDlp
};
