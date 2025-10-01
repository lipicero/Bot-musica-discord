/**
 * @file preload.js
 * @description Sistema inteligente de precarga de canciones
 * Precarga recursos de audio en segundo plano para reproducción sin latencia
 */

const { ENABLE_PRELOAD, PRELOAD_AHEAD, DEBUG_AUDIO, YT_DOWNLOAD_TIMEOUT } = require('../config/constants');
const { preloadCache } = require('./cache');
const { getEnhancedMetadata } = require('./metadata');
const logger = require('../utils/logger');

// =================== FUNCIONES DE PRECARGA ===================

/**
 * Precarga las siguientes canciones de una cola
 * Inteligente: detecta modo shuffle y precarga en consecuencia
 * @param {string} guildId - ID del servidor
 * @param {object} queue - Cola de reproducción
 * @param {Function} createResourceFn - Función para crear recursos de audio
 */
async function preloadNextSongs(guildId, queue, createResourceFn) {
  if (!ENABLE_PRELOAD) {
    if (DEBUG_AUDIO) logger.debug('[preload] Precarga deshabilitada');
    return;
  }
  
  try {
    if (!queue || !queue.songs || queue.songs.length < 2) {
      if (DEBUG_AUDIO) logger.debug('[preload] Cola insuficiente para precarga');
      return;
    }

    let songsToPreload = [];
    
    // Estrategia de selección según modo
    if (queue.shuffleMode && queue.songs.length > 1) {
      // Modo shuffle: precargar canciones aleatorias
      songsToPreload = selectShuffleSongs(queue.songs, PRELOAD_AHEAD);
      logger.debug(`[preload] 🔀 Modo shuffle: ${songsToPreload.length} canciones aleatorias`);
    } else {
      // Modo normal: precargar siguientes canciones en orden
      songsToPreload = queue.songs.slice(1, 1 + PRELOAD_AHEAD);
      logger.debug(`[preload] 📝 Modo normal: ${songsToPreload.length} canciones en orden`);
    }
    
    // Precargar cada canción con prioridad
    for (const [index, song] of songsToPreload.entries()) {
      // Saltar si ya está precargada
      if (preloadCache.has(guildId, song.url)) {
        if (DEBUG_AUDIO) logger.debug(`[preload] Ya precargada: ${song.title}`);
        continue;
      }
      
      // Limitar tamaño total del cache
      if (preloadCache.size >= preloadCache.maxSize * 2) {
        preloadCache.cleanup();
      }

      // Prioridad: 1 = siguiente canción (más importante)
      const priority = index + 1;
      
      // Precargar en segundo plano sin bloquear
      preloadSongInBackground(
        guildId,
        song,
        priority,
        queue.volume ?? 1.0,
        {
          bassGainDb: queue.bassGainDb,
          bassFreq: queue.bassFreq,
          bassWidth: queue.bassWidth
        },
        createResourceFn
      );
    }
  } catch (error) {
    logger.warn('[preload] Error en precarga automática', {
      guildId,
      error: error.message
    });
  }
}

/**
 * Selecciona canciones aleatorias para precarga en modo shuffle
 * @param {object[]} songs - Array de canciones
 * @param {number} count - Cantidad a seleccionar
 * @returns {object[]} - Canciones seleccionadas
 */
function selectShuffleSongs(songs, count) {
  const remaining = songs.slice(1); // Excluir la canción actual
  const numToSelect = Math.min(count, remaining.length);
  
  // Crear copia y mezclar aleatoriamente (Fisher-Yates)
  const shuffled = [...remaining];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  
  return shuffled.slice(0, numToSelect);
}

/**
 * Precarga una canción individual en segundo plano
 * @param {string} guildId - ID del servidor
 * @param {object} song - Información de la canción
 * @param {number} priority - Prioridad (1 = mayor)
 * @param {number} volume - Volumen
 * @param {object} filters - Filtros de audio (bass, etc.)
 * @param {Function} createResourceFn - Función para crear recurso
 */
async function preloadSongInBackground(guildId, song, priority, volume, filters, createResourceFn) {
  try {
    logger.audio(`Precargando (p${priority}): ${song.title}`);
    
    // 1. Obtener metadatos primero (rápido)
    const metadata = await getEnhancedMetadata(song.url);
    
    // 2. Crear recurso de audio con timeout
    const resource = await Promise.race([
      createResourceFn(song.url, volume, filters),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Timeout en precarga')), YT_DOWNLOAD_TIMEOUT)
      )
    ]);

    // 3. Guardar en cache
    preloadCache.set(guildId, song.url, resource, metadata, song, priority);
    
    const duration = Math.floor(metadata.duration || 0);
    logger.audio(`✅ Precargada: ${song.title} (${duration}s, p${priority})`);

  } catch (error) {
    logger.warn(`[preload] Error precargando ${song.title}`, {
      error: error.message,
      priority
    });
  }
}

/**
 * Obtiene un recurso precargado si está disponible
 * @param {string} guildId - ID del servidor
 * @param {string} url - URL de la canción
 * @returns {object|null} - Recurso de audio o null
 */
function getPreloadedResource(guildId, url) {
  const resource = preloadCache.get(guildId, url, true); // consume = true
  
  if (resource) {
    logger.audio('✅ Usando recurso precargado');
    return resource;
  }
  
  if (DEBUG_AUDIO) logger.debug('[preload] No hay recurso precargado disponible');
  return null;
}

/**
 * Limpia recursos precargados de un servidor específico
 * @param {string} guildId - ID del servidor
 */
function clearGuildPreloads(guildId) {
  const cleared = preloadCache.clearGuild(guildId);
  if (cleared > 0) {
    logger.audio(`Precargas limpiadas para servidor ${guildId}: ${cleared} recursos`);
  }
}

/**
 * Precarga múltiples canciones de una playlist
 * Útil para playlists grandes, precarga los primeros N elementos
 * @param {string} guildId - ID del servidor
 * @param {object[]} songs - Array de canciones
 * @param {number} volume - Volumen
 * @param {object} filters - Filtros de audio
 * @param {Function} createResourceFn - Función para crear recursos
 * @param {number} maxPreload - Máximo a precargar (default: PRELOAD_AHEAD)
 */
async function preloadPlaylist(guildId, songs, volume, filters, createResourceFn, maxPreload = PRELOAD_AHEAD) {
  if (!ENABLE_PRELOAD || !songs || songs.length === 0) return;
  
  try {
    const songsToPreload = songs.slice(0, Math.min(maxPreload, songs.length));
    
    logger.audio(`Precargando playlist: ${songsToPreload.length} canciones`);
    
    for (const [index, song] of songsToPreload.entries()) {
      // Precargar con prioridad decreciente
      const priority = index + 1;
      
      // Evitar sobrecargar, precargar de a una con pequeño delay
      if (index > 0) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      
      preloadSongInBackground(guildId, song, priority, volume, filters, createResourceFn);
    }
  } catch (error) {
    logger.warn('[preload] Error en precarga de playlist', {
      guildId,
      error: error.message
    });
  }
}

/**
 * Precarga la siguiente canción específica (modo manual)
 * @param {string} guildId - ID del servidor
 * @param {object} song - Canción a precargar
 * @param {number} volume - Volumen
 * @param {object} filters - Filtros de audio
 * @param {Function} createResourceFn - Función para crear recurso
 */
async function preloadNextSong(guildId, song, volume, filters, createResourceFn) {
  if (!ENABLE_PRELOAD || !song) return;
  
  try {
    // Verificar si ya está precargada
    if (preloadCache.has(guildId, song.url)) {
      logger.debug('[preload] Canción ya precargada');
      return;
    }
    
    await preloadSongInBackground(guildId, song, 1, volume, filters, createResourceFn);
  } catch (error) {
    logger.warn('[preload] Error en precarga manual', {
      guildId,
      song: song.title,
      error: error.message
    });
  }
}

/**
 * Verifica si una canción está precargada
 * @param {string} guildId - ID del servidor
 * @param {string} url - URL de la canción
 * @returns {boolean}
 */
function isPreloaded(guildId, url) {
  return preloadCache.has(guildId, url);
}

/**
 * Obtiene estadísticas de precarga
 * @returns {object} - Estadísticas
 */
function getPreloadStats() {
  return preloadCache.getStats();
}

// =================== EXPORTS ===================
module.exports = {
  preloadNextSongs,
  preloadNextSong,
  preloadPlaylist,
  preloadSongInBackground,
  getPreloadedResource,
  clearGuildPreloads,
  isPreloaded,
  getPreloadStats,
  selectShuffleSongs
};
