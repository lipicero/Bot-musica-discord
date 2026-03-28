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
const { execFile } = require('child_process');
const { promisify } = require('util');
const YTDlpWrap = require('yt-dlp-wrap').default;
const logger = require('./logger');
const { getYtDlpBinaryPath } = require('../services/playlist');

const execFileAsync = promisify(execFile);
const YT_DLP_TIMEOUT_MS = Number(process.env.YT_DLP_TIMEOUT_MS || 120000); // Aumentado a 120 segundos
const STREAM_TIMEOUT_MS = Number(process.env.YT_DLP_STREAM_TIMEOUT_MS || 45000); // Aumentado a 45 segundos
let ytDlpInstance = null;
let ytDlpBinaryPath = null;
let cachedCookiePath = null;
let cachedCookieMtime = 0;

function getYtDlpInstance() {
  if (ytDlpInstance) return ytDlpInstance;

  try {
    const binaryPath = getYtDlpBinaryPath();
    ytDlpBinaryPath = binaryPath;
    ytDlpInstance = binaryPath ? new YTDlpWrap(binaryPath) : new YTDlpWrap();
    return ytDlpInstance;
  } catch (error) {
    logger.warn('[yt-dlp] No se pudo inicializar yt-dlp', { error: error.message });
    return null;
  }
}

function ensureNetscapeCookieFile() {
  try {
    // Primero verificar si existe cookies.txt en formato Netscape
    const cookieTxtPath = path.join(process.cwd(), 'cookies.txt');
    if (fs.existsSync(cookieTxtPath)) {
      const stat = fs.statSync(cookieTxtPath);
      // Cachear la ruta para no verificar en cada llamada
      if (cachedCookiePath === cookieTxtPath && cachedCookieMtime === stat.mtimeMs) {
        return cachedCookiePath;
      }
      cachedCookiePath = cookieTxtPath;
      cachedCookieMtime = stat.mtimeMs;
      logger.debug('[yt-dlp] Usando cookies.txt existente');
      return cachedCookiePath;
    }
    
    // Fallback: buscar cookies.json y convertirlo
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

/**
 * Obtiene solo la URL del stream (RÁPIDO)
 */
async function getStreamUrlFast(url) {
  // Inicializar para obtener el binario path
  getYtDlpInstance();
  
  if (!ytDlpBinaryPath) {
    logger.debug('[yt-dlp] No hay ruta de binario configurada');
    return null;
  }

  // Cliente Android no requiere cookies ni signature solving
  const args = [
    '--get-url',  // Solo devolver URL, no metadata
    '--no-warnings',
    '--no-check-certificate',
    '--ignore-config',
    '--no-playlist',
    '--skip-download',
    '--no-cache-dir',
    '--extractor-retries', '3',
    '-f', 'bestaudio',  // Usar formato simple que siempre funciona
    '--socket-timeout', '30',  // Aumentar para conexiones lentas
    '--extractor-args', 'youtube:player_client=android'  // Cliente Android sin signature solving
  ];

  // No usar cookies con cliente Android (no las soporta)
  
  args.push(url);

  try {
    // Usar execFile directamente con timeout
    const { stdout, stderr } = await execFileAsync(ytDlpBinaryPath, args, {
      timeout: 90000, // 90 segundos para dar suficiente tiempo
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer
      windowsHide: true
    });
    
    const output = stdout.trim();
    
    // Registrar stderr solo si hay algo importante (ignorar warnings menores)
    if (stderr && stderr.length > 0) {
      logger.debug('[yt-dlp] stderr output', { stderr: stderr.substring(0, 200) });
    }
    
    // Validar que la salida parece una URL
    if (output && (output.startsWith('http://') || output.startsWith('https://'))) {
      logger.debug('[yt-dlp] URL obtenida exitosamente', { urlLength: output.length });
      return output;
    }
    
    logger.debug('[yt-dlp] Salida no es una URL válida', { output: output.substring(0, 100) });
    return null;
  } catch (error) {
    // No registrar como warning, solo debug, porque el fallback se encargará
    logger.debug('[yt-dlp] getStreamUrlFast falló, continuará con fallback', { 
      error: error.message,
      code: error.code,
      signal: error.signal
    });
    return null;
  }
}

async function execYtDlpJson(url) {
  const ytDlp = getYtDlpInstance();
  if (!ytDlp) return null;

  // Cliente Android no requiere cookies
  const args = [
    '--dump-single-json',
    '--no-warnings',
    '--no-check-certificate',
    '--ignore-config',
    '--no-playlist',
    '--skip-download', // No descargar, solo obtener metadata
    '--no-cache-dir',
    '--extractor-retries', '1',  // Reducido a 1 para velocidad máxima
    '--fragment-retries', '1',
    '--abort-on-error',  // Fallar rápido
    '-f', 'bestaudio',  // Formato simple
    '--socket-timeout', '10',
    '--extractor-args', 'youtube:player_client=android'  // Cliente Android sin signature solving
  ];

  // No usar cookies con cliente Android

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

      logger.debug('[yt-dlp] Solicitando stream', {
        hostname: urlObj.hostname,
        protocol: urlObj.protocol
      });

      const request = lib.request({
        protocol: urlObj.protocol,
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: `${urlObj.pathname}${urlObj.search}`,
        headers: headers || {},
        method: 'GET'
      }, (response) => {
        const status = response.statusCode || 0;
        logger.debug('[yt-dlp] Respuesta HTTP recibida', {
          status,
          contentLength: response.headers['content-length'],
          contentType: response.headers['content-type']
        });

        if (status >= 200 && status < 300 && response.readable) {
          // Agregar listeners para detectar cierre prematuro
          response.on('error', (err) => {
            logger.error('[yt-dlp] Error en stream de respuesta', { error: err.message });
          });
          
          response.on('end', () => {
            logger.debug('[yt-dlp] Stream finalizado normalmente');
          });
          
          response.on('close', () => {
            logger.debug('[yt-dlp] Stream cerrado');
          });

          resolve(response);
        } else {
          const error = new Error(`yt-dlp stream HTTP ${status}`);
          response.resume();
          reject(error);
        }
      });

      request.setTimeout(STREAM_TIMEOUT_MS, () => {
        logger.warn('[yt-dlp] Timeout al solicitar stream', { timeout: STREAM_TIMEOUT_MS });
        request.destroy(new Error('yt-dlp stream timeout'));
      });

      request.on('error', (err) => {
        logger.error('[yt-dlp] Error en request', { error: err.message });
        reject(err);
      });
      
      request.end();
    } catch (error) {
      logger.error('[yt-dlp] Error creando request', { error: error.message });
      reject(error);
    }
  });
}

async function createAudioResourceWithYtDlp(url, volume = 1.0) {
  logger.info('[yt-dlp] Obteniendo URL del stream...', { url });
  
  // Inicializar para obtener el binario path
  getYtDlpInstance();
  
  if (!ytDlpBinaryPath) {
    throw new Error('yt-dlp binary no encontrado');
  }

  // Cliente Android no requiere cookies
  
  // Usar yt-dlp para descargar directamente y hacer stream
  const args = [
    '--no-warnings',
    '--no-check-certificate',
    '--ignore-config',
    '--no-playlist',
    '-f', 'bestaudio/best',  // Mejor audio disponible
    '-o', '-',  // Output a stdout
    '--extractor-args', 'youtube:player_client=android'  // Cliente Android sin signature solving
  ];

  // No usar cookies con cliente Android
  
  args.push(url);

  try {
    const { spawn } = require('child_process');
    const process = spawn(ytDlpBinaryPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    let hasData = false;
    const timeout = setTimeout(() => {
      if (!hasData) {
        process.kill();
      }
    }, 30000); // 30 segundos para empezar

    process.stdout.once('data', () => {
      hasData = true;
      clearTimeout(timeout);
    });

    process.stderr.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('ERROR')) {
        logger.warn('[yt-dlp] stderr:', { msg: msg.substring(0, 200) });
      }
    });

    const resource = createAudioResource(process.stdout, {
      inputType: StreamType.Arbitrary,
      inlineVolume: true
    });

    if (resource.volume) {
      resource.volume.setVolumeLogarithmic(Math.max(0, Math.min(2, volume)));
    }

    resource.metadata = { source: 'yt-dlp-stream' };
    
    if (resource.playStream) {
      resource.playStream.on('error', (err) => {
        logger.error('[yt-dlp] Error en playStream', { error: err.message });
      });
    }

    logger.info('[yt-dlp] ✓ Recurso creado con streaming directo');
    return resource;
  } catch (error) {
    logger.error('[yt-dlp] Error creando recurso', { error: error.message });
    throw error;
  }
}

/**
 * Obtiene metadatos de un video usando yt-dlp
 * @param {string} url - URL del video
 * @returns {Promise<object|null>} - Información del video o null
 */
async function getVideoInfoWithYtDlp(url) {
  try {
    const info = await execYtDlpJson(url);
    if (!info) return null;
    
    // Extraer información relevante
    return {
      title: info.title || 'Video sin título',
      author: info.uploader || info.channel || 'Canal desconocido',
      duration: info.duration || 0,
      thumbnail: info.thumbnail || info.thumbnails?.[0]?.url || null,
      url: url,
      videoId: info.id || null,
      isLive: info.is_live || false,
      viewCount: info.view_count || 0,
      uploadDate: info.upload_date || null,
      description: info.description || null,
      // Información de audio
      abr: info.abr || null,
      acodec: info.acodec || null,
      ext: info.ext || null
    };
  } catch (error) {
    logger.warn('[yt-dlp] Error obteniendo info del video', { error: error.message });
    return null;
  }
}

module.exports = {
  createAudioResourceWithYtDlp,
  getVideoInfoWithYtDlp,
  execYtDlpJson
};
