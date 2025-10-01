/**
 * @file metadata.js
 * @description Servicio para obtener y procesar metadatos de canciones
 * Soporta YouTube (ytdl-core y yt-dlp) con cache automático
 */

const ytdl = require('@distube/ytdl-core');
const { DEBUG_AUDIO } = require('../config/constants');
const { metadataCache } = require('./cache');
const { formatDuration } = require('../utils/formatters');
const logger = require('../utils/logger');

// Importar yt-dlp si está disponible
let ytdlp = null;
try {
  const playDl = require('play-dl');
  if (playDl?.yt_validate === 'function') {
    ytdlp = playDl;
  }
} catch (err) {
  logger.warn('yt-dlp no disponible, usando solo ytdl-core');
}

// =================== MAPEO DE ITAGS ===================
const ITAG_QUALITY_MAP = {
  140: '128kbps',  // m4a 128kbps
  141: '256kbps',  // m4a 256kbps  
  171: '128kbps',  // webm 128kbps
  249: '50kbps',   // webm opus 50kbps
  250: '70kbps',   // webm opus 70kbps
  251: '160kbps',  // webm opus 160kbps
};

// =================== FUNCIONES DE EXTRACCIÓN ===================

/**
 * Obtiene la miniatura de mayor calidad disponible
 * @param {object} videoInfo - Información del video
 * @returns {string|null} - URL de la miniatura o null
 */
function getHighQualityThumbnail(videoInfo) {
  try {
    const thumbnails = videoInfo?.videoDetails?.thumbnails || videoInfo?.thumbnails;
    if (!thumbnails || !Array.isArray(thumbnails) || thumbnails.length === 0) {
      return null;
    }
    
    // Ordenar por resolución (ancho × alto) descendente
    const sorted = [...thumbnails].sort((a, b) => {
      const areaA = (a.width || 0) * (a.height || 0);
      const areaB = (b.width || 0) * (b.height || 0);
      return areaB - areaA;
    });
    
    return sorted[0]?.url || null;
  } catch (error) {
    logger.warn('Error obteniendo thumbnail', { error: error.message });
    return null;
  }
}

/**
 * Extrae información de calidad de audio desde yt-dlp
 * @param {object} info - Información de yt-dlp
 * @returns {string} - Calidad de audio
 */
function extractQualityFromYtDlp(info) {
  try {
    // 1. Intentar desde formatos de audio puros
    if (info.formats && Array.isArray(info.formats)) {
      const audioFormats = info.formats
        .filter(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'))
        .sort((a, b) => (b.abr || 0) - (a.abr || 0));
      
      if (audioFormats.length > 0) {
        const best = audioFormats[0];
        if (best.abr) {
          if (DEBUG_AUDIO) logger.debug(`[yt-dlp] Calidad desde ABR: ${best.abr}kbps (${best.acodec})`);
          return `${best.abr}kbps`;
        }
        if (best.tbr) {
          if (DEBUG_AUDIO) logger.debug(`[yt-dlp] Calidad desde TBR: ${best.tbr}kbps`);
          return `${best.tbr}kbps`;
        }
      }
    }
    
    // 2. Propiedades directas
    if (info.abr) {
      if (DEBUG_AUDIO) logger.debug(`[yt-dlp] Calidad desde ABR directo: ${info.abr}kbps`);
      return `${info.abr}kbps`;
    }
    if (info.tbr) {
      if (DEBUG_AUDIO) logger.debug(`[yt-dlp] Calidad desde TBR directo: ${info.tbr}kbps`);
      return `${info.tbr}kbps`;
    }
    
    // 3. Información cualitativa
    if (info.format_note) {
      if (DEBUG_AUDIO) logger.debug(`[yt-dlp] Calidad cualitativa: ${info.format_note}`);
      return info.format_note;
    }
    if (info.acodec && info.acodec !== 'none') {
      if (DEBUG_AUDIO) logger.debug(`[yt-dlp] Calidad desde codec: ${info.acodec}`);
      return info.acodec;
    }
    
  } catch (error) {
    logger.warn('[yt-dlp] Error extrayendo calidad', { error: error.message });
  }
  
  return null;
}

/**
 * Extrae información de calidad de audio desde ytdl-core
 * @param {object} basicInfo - Información básica de ytdl-core
 * @returns {string} - Calidad de audio
 */
function extractQualityFromYtdlCore(basicInfo) {
  try {
    if (!basicInfo.formats || !Array.isArray(basicInfo.formats)) {
      return null;
    }
    
    // Filtrar formatos de audio y ordenar por bitrate
    const audioFormats = basicInfo.formats
      .filter(format => format.hasAudio && (!format.hasVideo || format.audioOnly))
      .sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0));
    
    if (audioFormats.length === 0) {
      return null;
    }
    
    const bestFormat = audioFormats[0];
    
    // 1. Bitrate directo
    if (bestFormat.audioBitrate) {
      if (DEBUG_AUDIO) {
        logger.debug(`[ytdl-core] Calidad: ${bestFormat.audioBitrate}kbps (${bestFormat.audioCodec || 'unknown'})`);
      }
      return `${bestFormat.audioBitrate}kbps`;
    }
    
    // 2. Calidad cualitativa
    if (bestFormat.audioQuality) {
      if (DEBUG_AUDIO) logger.debug(`[ytdl-core] Calidad cualitativa: ${bestFormat.audioQuality}`);
      return bestFormat.audioQuality;
    }
    
    // 3. Mapeo de itag
    if (bestFormat.itag && ITAG_QUALITY_MAP[bestFormat.itag]) {
      const quality = ITAG_QUALITY_MAP[bestFormat.itag];
      if (DEBUG_AUDIO) logger.debug(`[ytdl-core] Calidad desde itag ${bestFormat.itag}: ${quality}`);
      return quality;
    }
    
  } catch (error) {
    logger.warn('[ytdl-core] Error extrayendo calidad', { error: error.message });
  }
  
  return null;
}

// =================== FUNCIÓN PRINCIPAL ===================

/**
 * Obtiene metadatos enriquecidos de una URL de YouTube
 * Usa cache automáticamente para evitar consultas repetidas
 * @param {string} url - URL de YouTube
 * @returns {Promise<object>} - Metadatos de la canción
 */
async function getEnhancedMetadata(url) {
  try {
    // 1. Verificar cache
    const cached = metadataCache.get(url);
    if (cached) {
      if (DEBUG_AUDIO) logger.debug(`[metadata] Cache hit para ${url}`);
      return cached;
    }

    // 2. Inicializar valores por defecto
    let title = "Desconocido";
    let duration = 0;
    let thumbnail = null;
    let quality = null;
    let views = null;

    // 3. Intentar con yt-dlp primero (más confiable)
    if (ytdlp) {
      try {
        const info = await ytdlp(url, {
          dumpSingleJson: true,
          noPlaylist: true,
          noCheckCertificates: true,
          preferFreeFormats: true,
          youtubeSkipDashManifest: true,
        });
        
        if (info) {
          title = info.title || title;
          duration = Math.floor(info.duration || 0);
          thumbnail = getHighQualityThumbnail(info) || info.thumbnail;
          views = info.view_count;
          quality = extractQualityFromYtDlp(info);
          
          if (DEBUG_AUDIO) {
            logger.debug('[yt-dlp] Metadatos obtenidos', {
              title,
              duration,
              quality,
              views
            });
          }
        }
      } catch (ytdlpErr) {
        logger.warn('[yt-dlp] Error, usando fallback a ytdl-core', {
          error: ytdlpErr.message
        });
      }
    }

    // 4. Fallback a ytdl-core si yt-dlp falla o falta información
    if (title === "Desconocido" || !quality) {
      try {
        const basicInfo = await ytdl.getBasicInfo(url);
        
        if (basicInfo?.videoDetails) {
          // Solo sobrescribir valores que faltan
          if (title === "Desconocido") {
            title = basicInfo.videoDetails.title || title;
            duration = parseInt(basicInfo.videoDetails.lengthSeconds) || duration;
            thumbnail = getHighQualityThumbnail(basicInfo) || thumbnail;
            views = parseInt(basicInfo.videoDetails.viewCount) || views;
          }
          
          // Intentar obtener calidad si falta
          if (!quality) {
            quality = extractQualityFromYtdlCore(basicInfo);
          }
          
          if (DEBUG_AUDIO) {
            logger.debug('[ytdl-core] Metadatos obtenidos/complementados', {
              title,
              duration,
              quality,
              views
            });
          }
        }
      } catch (ytdlErr) {
        logger.warn('[ytdl-core] Error obteniendo metadatos', {
          error: ytdlErr.message
        });
      }
    }

    // 5. Valores por defecto finales
    if (!quality) {
      quality = "128kbps (estimado)";
      if (DEBUG_AUDIO) logger.debug('[metadata] Usando calidad estimada por defecto');
    }

    // 6. Construir objeto de metadatos
    const metadata = {
      title,
      duration,
      thumbnail,
      quality,
      views,
      url,
      durationDisplay: formatDuration(duration)
    };

    // 7. Guardar en cache
    metadataCache.set(url, metadata);
    
    logger.audio(`Metadatos obtenidos: ${title} (${metadata.durationDisplay})`, {
      quality,
      cached: false
    });

    return metadata;

  } catch (error) {
    logger.error('[metadata] Error crítico obteniendo metadatos', {
      url,
      error: error.message
    });
    
    // Retornar objeto de error
    return {
      title: "Error al cargar",
      duration: 0,
      thumbnail: null,
      quality: "Unknown",
      views: null,
      url,
      durationDisplay: "0:00",
      error: true
    };
  }
}

/**
 * Actualiza la calidad de un metadato en cache
 * Útil cuando se obtiene información adicional del formato seleccionado
 * @param {string} url - URL de la canción
 * @param {object} format - Formato de audio seleccionado
 */
function updateMetadataQuality(url, format) {
  try {
    const cached = metadataCache.get(url);
    if (!cached || !format) return;

    let qualityInfo = cached.quality || "Unknown";
    
    // Extraer calidad del formato
    if (format.audioBitrate) {
      qualityInfo = `${format.audioBitrate}kbps`;
    } else if (format.audioQuality) {
      qualityInfo = format.audioQuality;
    } else if (format.quality) {
      qualityInfo = format.quality;
    } else if (format.audioCodec || format.acodec) {
      const codec = format.audioCodec || format.acodec;
      qualityInfo = codec.includes('opus') ? 'Opus' : codec;
    }
    
    // Actualizar cache
    const updatedMetadata = {
      ...cached,
      quality: qualityInfo
    };
    
    metadataCache.set(url, updatedMetadata);
    
    if (DEBUG_AUDIO) {
      logger.debug(`[metadata] Calidad actualizada para ${url}: ${qualityInfo}`);
    }
  } catch (error) {
    logger.warn('[metadata] Error actualizando calidad', {
      url,
      error: error.message
    });
  }
}

/**
 * Obtiene metadatos de múltiples URLs en paralelo
 * @param {string[]} urls - Array de URLs
 * @param {number} concurrency - Cantidad de consultas simultáneas (default: 3)
 * @returns {Promise<object[]>} - Array de metadatos
 */
async function getBatchMetadata(urls, concurrency = 3) {
  const results = [];
  
  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(url => getEnhancedMetadata(url))
    );
    results.push(...batchResults);
  }
  
  return results;
}

/**
 * Precarga metadatos de una lista de canciones en segundo plano
 * No bloquea la ejecución, útil para colas/playlists
 * @param {string[]} urls - Array de URLs
 */
function preloadMetadata(urls) {
  setImmediate(async () => {
    try {
      await getBatchMetadata(urls, 2);
      logger.debug(`[metadata] Precarga completada: ${urls.length} canciones`);
    } catch (error) {
      logger.warn('[metadata] Error en precarga', { error: error.message });
    }
  });
}

// =================== EXPORTS ===================
module.exports = {
  getEnhancedMetadata,
  updateMetadataQuality,
  getBatchMetadata,
  preloadMetadata,
  getHighQualityThumbnail,
  extractQualityFromYtDlp,
  extractQualityFromYtdlCore
};
