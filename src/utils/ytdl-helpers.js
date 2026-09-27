/**
 * @file ytdl-helpers.js  
 * @description Helpers para ytdl-core con configuraciones optimizadas
 */

const { StreamType } = require('@discordjs/voice');

// Cache de tokens Po para evitar regenerarlos constantemente
let poTokenCache = null;
let visitorDataCache = null;
let tokenCacheTime = 0;
const TOKEN_CACHE_DURATION = 30 * 60 * 1000; // 30 minutos

/**
 * Genera tokens Po y VISITOR_DATA para bypass de protección de YouTube
 * @returns {Promise<{poToken: string, visitorData: string}>}
 */
async function generatePoToken() {
  // Usar cache si es reciente
  if (poTokenCache && visitorDataCache && (Date.now() - tokenCacheTime) < TOKEN_CACHE_DURATION) {
    return { poToken: poTokenCache, visitorData: visitorDataCache };
  }

  try {
    const { generate } = require('youtube-po-token-generator');
    const result = await generate();
    
    poTokenCache = result.poToken;
    visitorDataCache = result.visitorData;
    tokenCacheTime = Date.now();
    
    const logger = require('./logger');
    logger.debug('[ytdl] ✓ Tokens Po generados', { 
      poToken: poTokenCache.substring(0, 20) + '...', 
      visitorData: visitorDataCache 
    });
    
    return { poToken: poTokenCache, visitorData: visitorDataCache };
  } catch (error) {
    const logger = require('./logger');
    logger.warn('[ytdl] No se pudieron generar tokens Po', { error: error.message });
    return { poToken: null, visitorData: null };
  }
}

/**
 * Construye opciones de request para ytdl con cookies y headers
 * @param {string} videoIdOrUrl - ID o URL del video
 * @returns {Promise<object>} - Opciones de request
 */
async function buildYtdlRequestOptions(videoIdOrUrl) {
  const fs = require('fs');
  const path = require('path');
  
  // Intentar obtener cookies de múltiples fuentes
  let ytCookie = null;
  
  // 1. Variables de entorno directas (formato header)
  ytCookie = process.env.YT_COOKIE || process.env.YOUTUBE_COOKIE;
  
  // 2. Archivo cookies.txt (formato Netscape)
  if (!ytCookie) {
    try {
      const cookieTxtPath = path.join(process.cwd(), 'cookies.txt');
      if (fs.existsSync(cookieTxtPath)) {
        const cookieContent = fs.readFileSync(cookieTxtPath, 'utf8');
        const cookieLines = cookieContent.split('\n').filter(line => {
          line = line.trim();
          return line && !line.startsWith('#') && !line.startsWith('\n');
        });
        
        // Parsear formato Netscape: domain flag path secure expiration name value
        const cookies = [];
        for (const line of cookieLines) {
          const parts = line.split('\t');
          if (parts.length >= 7) {
            cookies.push(`${parts[5]}=${parts[6]}`);
          }
        }
        
        if (cookies.length > 0) {
          ytCookie = cookies.join('; ');
          const logger = require('./logger');
          logger.debug('[ytdl] Cookies cargadas desde cookies.txt', { count: cookies.length });
        }
      }
    } catch (error) {
      const logger = require('./logger');
      logger.warn('[ytdl] Error cargando cookies.txt', { error: error.message });
    }
  }
  
  // 3. Archivo cookies.json (formato preferido para ytdl-core)
  if (!ytCookie) {
    try {
      const cookieJsonPath = path.join(process.cwd(), 'cookies.json');
      if (fs.existsSync(cookieJsonPath)) {
        const cookiesArray = JSON.parse(fs.readFileSync(cookieJsonPath, 'utf8'));
        // Convertir array de cookies a formato header
        ytCookie = cookiesArray
          .map(cookie => `${cookie.name}=${cookie.value}`)
          .join('; ');
        
        // Log para depuración (solo mostrar primeras cookies)
        const logger = require('./logger');
        const cookieNames = cookiesArray.map(c => c.name).join(', ');
        logger.debug('[ytdl] Cookies cargadas desde JSON', { count: cookiesArray.length, names: cookieNames });
      }
    } catch (error) {
      const logger = require('./logger');
      logger.error('[ytdl] Error cargando cookies.json', { error: error.message });
    }
  }
  
  // 3. Archivo de cookies (formato Netscape - cookies.txt) como fallback
  if (!ytCookie && process.env.YOUTUBE_COOKIES) {
    try {
      const cookiePath = process.env.YOUTUBE_COOKIES;
      if (fs.existsSync(cookiePath)) {
        const cookieContent = fs.readFileSync(cookiePath, 'utf8');
        // Convertir formato Netscape a header (extraer pares name=value)
        ytCookie = cookieContent
          .split('\n')
          .filter(line => line && !line.startsWith('#') && line.trim() !== '')
          .map(line => {
            const parts = line.split('\t');
            if (parts.length >= 7) {
              // Formato: domain flag path secure expiration name value
              const name = parts[5];
              const value = parts[6];
              return `${name}=${value}`;
            }
            return null;
          })
          .filter(Boolean)
          .join('; ');
      }
    } catch (error) {
      // Ignorar silenciosamente si el archivo no existe
    }
  }
  
  // User-Agents rotativos (los más recientes y confiables)
  const userAgents = [
    // Chrome 131 (Más reciente)
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    // Chrome 130
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    // Edge 131
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
    // Firefox 132
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0"
  ];
  
  // Usar el User-Agent configurado o rotar entre los disponibles
  const userAgent = process.env.YTDL_USER_AGENT || 
                   process.env.YT_USER_AGENT ||
                   userAgents[Math.floor(Math.random() * userAgents.length)];
                   
  const acceptLang = process.env.YTDL_ACCEPT_LANGUAGE || "es-ES,es;q=0.9,en;q=0.8";

  const headers = {
    "user-agent": userAgent,
    "accept-language": acceptLang,
    "sec-ch-ua": '"Chromium";v="131", "Not_A Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
  };

  // Agregar cookies si están disponibles
  if (ytCookie) {
    headers.cookie = ytCookie;
  }

  // Agregar referer si es URL
  if (videoIdOrUrl && /^https?:\/\//i.test(String(videoIdOrUrl))) {
    headers.referer = videoIdOrUrl;
  } else if (videoIdOrUrl && /^[a-zA-Z0-9_-]{6,}$/.test(String(videoIdOrUrl))) {
    headers.referer = `https://www.youtube.com/watch?v=${videoIdOrUrl}`;
  }

  // Generar tokens Po para bypass de protección
  const { poToken, visitorData } = await generatePoToken();
  
  const options = { 
    requestOptions: { headers } 
  };
  
  // Agregar tokens Po si están disponibles
  if (poToken && visitorData) {
    options.poToken = poToken;
    options.visitorData = visitorData;
  }

  return options;
}

/**
 * Selecciona el mejor formato WebM/Opus disponible
 * @param {Array} formats - Lista de formatos
 * @returns {object|null} - Formato seleccionado o null
 */
function selectWebmOpusFormat(formats) {
  if (!formats || !Array.isArray(formats)) return null;

  // Buscar formatos webm/opus de solo audio
  const webmOpusFormats = formats.filter(f => {
    const container = f.container || f.mimeType || '';
    const codec = f.audioCodec || f.acodec || '';
    const hasVideo = f.hasVideo || (f.videoCodec && f.videoCodec !== 'none');
    
    return (
      !hasVideo &&
      (/webm/i.test(container) || /webm/i.test(codec)) &&
      /opus/i.test(codec)
    );
  });

  if (webmOpusFormats.length === 0) return null;

  // Ordenar por calidad de audio (bitrate más alto)
  webmOpusFormats.sort((a, b) => {
    const bitrateA = a.audioBitrate || a.abr || 0;
    const bitrateB = b.audioBitrate || b.abr || 0;
    return bitrateB - bitrateA;
  });

  return webmOpusFormats[0];
}

/**
 * Determina el StreamType basado en el formato
 * @param {object} format - Formato de ytdl
 * @returns {StreamType} - Tipo de stream
 */
function getStreamType(format) {
  if (!format) return StreamType.Arbitrary;

  const container = format.container || format.mimeType || '';
  const codec = format.audioCodec || format.acodec || '';

  if (/webm/i.test(container) && /opus/i.test(codec)) {
    return StreamType.WebmOpus;
  }

  if (/ogg/i.test(container) && /opus/i.test(codec)) {
    return StreamType.OggOpus;
  }

  return StreamType.Arbitrary;
}

module.exports = {
  buildYtdlRequestOptions,
  selectWebmOpusFormat,
  getStreamType,
  generatePoToken
};
