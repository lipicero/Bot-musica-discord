/**
 * @file handlers/player.js
 * @description Gestión de reproducción de canciones
 * Maneja la lógica de reproducción, inicio de canciones y precarga
 */

const { AudioPlayerStatus } = require('@discordjs/voice');
const { getVoiceConnection } = require('@discordjs/voice');
const ytdl = require('@distube/ytdl-core');
const { createAudioResource, StreamType } = require('@discordjs/voice');
const { DEBUG_AUDIO, ENABLE_PRELOAD, PRELOAD_AHEAD } = require('../config/constants');
const logger = require('../utils/logger');
const { preloadNextSongs } = require('../services/preload');
const { createYtDlpAudioResource } = require('../utils/yt-dlp');
const { buildYtdlRequestOptions, selectWebmOpusFormat } = require('../utils/ytdl-helpers');


/**
 * Crea un recurso de audio desde ytdlInfo
 * @param {object} ytdlInfo - Información de ytdl
 * @param {number} volume - Volumen (0-2)
 * @returns {object|null} - Recurso de audio o null
 */
function createResourceFromYtdlInfo(ytdlInfo, volume = 1.0) {
  try {
    if (!ytdlInfo || !ytdlInfo.formats) return null;
    
    // Buscar mejor formato de audio
    const audioFormats = ytdl.filterFormats(ytdlInfo.formats, 'audioonly');
    if (!audioFormats || audioFormats.length === 0) return null;
    
    // Ordenar por calidad de audio
    audioFormats.sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0));
    const bestFormat = audioFormats[0];
    
    if (!bestFormat || !bestFormat.url) return null;
    
    const resource = createAudioResource(bestFormat.url, {
      inputType: StreamType.Arbitrary,
      inlineVolume: true
    });
    
    if (resource.volume) {
      resource.volume.setVolumeLogarithmic(Math.max(0, Math.min(2, volume)));
    }
    
    return resource;
  } catch (error) {
    logger.warn('[player] Error creando recurso desde ytdlInfo:', { error: error.message });
    return null;
  }
}

/**
 * Reproduce la siguiente canción en la cola
 * @param {string} guildId - ID del servidor
 * @param {Map} queues - Mapa de colas
 * @param {object} context - Contexto global con caches y servicios
 * @returns {Promise<void>}
 */
async function playNext(guildId, queues, context = {}) {
  const q = queues.get(guildId);
  if (!q || !q.songs || q.songs.length === 0) {
    logger.debug('[player] No hay canciones en la cola', { guildId });
    return;
  }
  
  const current = q.songs[0];
  current._ytDlpAttempts = 0;
  
  // Limpiar el flag de pausa al iniciar o reiniciar cualquier canción
  q.isPausedByUser = false;
  logger.debug('[player] Iniciando reproducción, limpiando isPausedByUser', { guildId });
  
  // Actualizar la canción actual
  q.currentSongUrl = current.url;
  q.playbackOffset = 0; // Resetear offset para nueva canción
  
  delete q.pausedAtTime; // Limpiar tiempo pausado para nueva canción
  
  logger.audio(`Iniciando reproducción: ${current.title}`, { guildId });
  
  let resource = null;
  let obtainedFrom = 'none';

  // Intentar usar recurso precargado primero
  const preloadKey = `${guildId}_${current.url}`;
  const preloadCache = context.PRELOAD_CACHE;
  
  if (preloadCache && preloadCache.has(preloadKey)) {
    const cached = preloadCache.get(preloadKey);
    if (cached && cached.resource) {
      resource = cached.resource;
      preloadCache.delete(preloadKey);
      obtainedFrom = 'preload';
      current.obtainedFrom = 'preload';
      logger.audio('[player] ⚡ Usando recurso precargado', { guildId });
    }
  }

  // Si no hay precargado, intentar crear recurso nuevo
  if (!resource) {
    try {
      const result = await createResourceFromUrl(current.url, q.volume ?? 1.0);
      resource = result.resource;
      obtainedFrom = result.obtainedFrom;
      current.obtainedFrom = obtainedFrom;
      current.ytdlInfo = result.info;

      // Actualizar calidad si es posible
      if (result.info) {
        const { extractQualityFromYtDlp, extractQualityFromYtdlCore } = require('../services/metadata');
        if (obtainedFrom === 'yt-dlp') {
          current.quality = extractQualityFromYtDlp(result.info) || current.quality;
        } else if (obtainedFrom === 'ytdl-core') {
          current.quality = extractQualityFromYtdlCore(result.info) || current.quality;
        } else if (obtainedFrom === 'play-dl' && result.info.format?.abr) {
          current.quality = `${result.info.format.abr}kbps`;
        }
      }
    } catch (error) {
      logger.error('[player] Error crítico al crear recurso:', { guildId, error: error.message });
      throw error;
    }
  }
  
  // Verificar que el recurso es válido
  if (!resource) {
    throw new Error('No se pudo crear recurso de audio válido');
  }
  
  // Agregar manejo de errores al recurso de audio
  if (resource && resource.playStream) {
    resource.playStream.on('error', (streamError) => {
      logger.error('[player] Error en stream de audio', {
        guildId,
        error: streamError.message,
        stack: streamError.stack
      });
    });
  }
  
  // Agregar manejo de errores al volumen si existe
  if (resource && resource.volume) {
    resource.volume.on('error', (volumeError) => {
      logger.error('[player] Error en transformador de volumen', {
        guildId,
        error: volumeError.message
      });
    });
  }
  
  // IMPORTANTE: Establecer flag ANTES de reproducir para evitar saltos automáticos
  // Este flag previene que el evento Idle avance la cola si el recurso termina prematuramente
  q.replacingResource = true;
  
  // Reproducir el recurso
  q.player.play(resource);
  // No establecer lastPlaybackStart aquí, esperar a que el player confirme que está reproduciendo
  logger.audio(`▶️ Iniciando reproducción: ${current.title} (Fuente: ${obtainedFrom})`, { guildId });
  
  // Limpiar el flag después de que el reproductor confirme que está reproduciendo
  // Esperamos un poco más de tiempo para asegurar que el stream está estable
  setTimeout(() => {
    const currentQ = queues.get(guildId);
    if (currentQ && currentQ.player?.state?.status === AudioPlayerStatus.Playing) {
      currentQ.replacingResource = false;
      // Registrar siempre el tiempo de inicio cuando realmente está reproduciendo
      currentQ.lastPlaybackStart = Date.now();
      logger.audio(`▶️ Reproducción confirmada: ${current.title}`, { guildId });
      logger.debug('[player] Flag replacingResource limpiado - reproducción confirmada', { guildId });
    }
  }, 500); // 0.5 segundos para dar tiempo al stream de estabilizarse
  
  // Iniciar/actualizar panel Now Playing
  try {
    const { startNowPlayingPanel } = require('./nowplaying-panel');
    const { client } = context;
    
    if (client && q.textChannelId) {
      const channel = await client.channels.fetch(q.textChannelId).catch(() => null);
      if (channel?.isTextBased?.()) {
        await startNowPlayingPanel(q, channel);
        logger.debug('[player] Panel Now Playing iniciado', { guildId });
      }
    }
  } catch (panelError) {
    logger.warn('[player] Error iniciando panel Now Playing:', {
      guildId,
      error: panelError.message
    });
  }
  
  // Precargar siguiente canción si está habilitado
  if (ENABLE_PRELOAD && q.songs.length > 1) {
    setTimeout(() => {
      preloadNextInQueue(guildId, q, context).catch(err => {
        logger.warn('[player] Error en precarga:', { 
          guildId, 
          error: err.message 
        });
      });
    }, 3000); // Esperar 3 segundos antes de precargar
  }
  
  // Actualizar estadísticas si están disponibles
  if (context.USER_STATS && current.requestedById) {
    const key = `${guildId}_${current.requestedById}`;
    const stats = context.USER_STATS.get(key) || {
      userId: current.requestedById,
      guildId: guildId,
      songsPlayed: 0,
      listenTime: 0,
      lastActivity: Date.now()
    };
    
    stats.songsPlayed++;
    stats.lastActivity = Date.now();
    context.USER_STATS.set(key, stats);
  }
  
}

/**
 * Crea un recurso de audio desde una URL con opciones
 * @param {string} url - URL de la canción
 * @param {number} volume - Volumen (0-2)
 * @param {object} options - Opciones adicionales (startAtSec, etc)
 * @returns {Promise<{resource: object, obtainedFrom: string, info: object|null}>}
 */
async function createResourceFromUrl(url, volume = 1.0, options = {}) {
  const { startAtSec = 0 } = options;
  const { HIGH_WATER_MARK } = require('../config/constants');
  let resource = null;
  let obtainedFrom = 'none';
  let info = null;

  // 1. Intentar con yt-dlp (yt-dlp-nodejs)
  try {
    const { resource: ytDlpResource, info: ytDlpInfo } = await createYtDlpAudioResource(url, volume, startAtSec);
    resource = ytDlpResource;
    obtainedFrom = 'yt-dlp';
    info = ytDlpInfo;
    logger.audio('[player] ✓ Recurso creado con yt-dlp', { url, startAtSec });
  } catch (ytDlpError) {
    logger.error('[player] yt-dlp falló, intentando play-dl', { url, error: ytDlpError.message });

    // 2. Fallback a play-dl
    try {
      const { getPlayDlStream } = require('../utils/play-dl-helpers');
      const { resource: playDlResource, info: playDlInfo } = await getPlayDlStream(url, startAtSec);
      resource = playDlResource;
      obtainedFrom = 'play-dl';
      info = playDlInfo;
      
      if (resource.volume) {
        resource.volume.setVolumeLogarithmic(Math.max(0, Math.min(2, volume)));
      }
      logger.audio('[player] ✓ Recurso creado con play-dl', { url, startAtSec });
    } catch (playDlError) {
      logger.error('[player] play-dl también falló, intentando @distube/ytdl-core', { url, error: playDlError.message });
      
      // 3. Último Fallback: @distube/ytdl-core
      try {
        const { buildYtdlRequestOptions, selectWebmOpusFormat } = require('../utils/ytdl-helpers');
        const requestOptions = await buildYtdlRequestOptions(url);
        const ytdlInfo = await ytdl.getInfo(url, requestOptions);
        info = ytdlInfo;

        const downloadOptions = {
          highWaterMark: HIGH_WATER_MARK,
          dlChunkSize: 0,
          requestOptions: requestOptions.requestOptions
        };
        
        if (requestOptions.poToken) downloadOptions.poToken = requestOptions.poToken;
        if (requestOptions.visitorData) downloadOptions.visitorData = requestOptions.visitorData;
        
        const webmFormat = selectWebmOpusFormat(ytdlInfo.formats);
        if (webmFormat) {
          const stream = ytdl.downloadFromInfo(ytdlInfo, { format: webmFormat, ...downloadOptions });
          resource = createAudioResource(stream, { inputType: StreamType.WebmOpus, inlineVolume: true });
        } else {
          const stream = ytdl.downloadFromInfo(ytdlInfo, { quality: 'highestaudio', filter: 'audioonly', ...downloadOptions });
          resource = createAudioResource(stream, { inputType: StreamType.Arbitrary, inlineVolume: true });
        }
        
        if (resource.volume) {
          resource.volume.setVolumeLogarithmic(Math.max(0, Math.min(2, volume)));
        }
        obtainedFrom = 'ytdl-core';
        logger.audio('[player] ✓ Recurso creado con @distube/ytdl-core', { url });
      } catch (ytdlError) {
        logger.error('[player] @distube/ytdl-core también falló', { url, error: ytdlError.message });
        throw new Error(`No se pudo obtener el stream de ninguna fuente: ${ytdlError.message}`);
      }
    }
  }

  return { resource, obtainedFrom, info };
}

/**
 * Precargar siguiente(s) canción(es) de la cola
 * @param {string} guildId - ID del servidor
 * @param {object} queue - Cola del servidor
 * @param {object} context - Contexto global
 */
async function preloadNextInQueue(guildId, queue, context) {
  if (!ENABLE_PRELOAD || !queue.songs || queue.songs.length < 2) {
    return;
  }
  
  const preloadCache = context.PRELOAD_CACHE;
  if (!preloadCache) return;
  
  // Obtener las siguientes canciones a precargar
  const songsToPreload = queue.songs.slice(1, 1 + PRELOAD_AHEAD);
  
  logger.audio(`[player] Precargando ${songsToPreload.length} canción(es)`, { guildId });
  
  for (const song of songsToPreload) {
    const cacheKey = `${guildId}_${song.url}`;
    
    // Si ya está precargada, saltar
    if (preloadCache.has(cacheKey)) {
      continue;
    }
    
    let resource = null;

    // 1. Intentar con yt-dlp (yt-dlp-nodejs)
    try {
      const { resource: ytDlpResource } = await createYtDlpAudioResource(song.url, queue.volume ?? 1.0);
      resource = ytDlpResource;
    } catch (ytDlpError) {
      logger.debug('[player] Precarga con yt-dlp falló, intentando play-dl', { guildId, error: ytDlpError.message });
      
      // 2. Fallback a play-dl
      try {
        const { getPlayDlStream } = require('../utils/play-dl-helpers');
        const { resource: playDlResource } = await getPlayDlStream(song.url);
        resource = playDlResource;
      } catch (playDlError) {
        logger.debug('[player] Precarga con play-dl falló, intentando @distube/ytdl-core', { guildId, error: playDlError.message });
        
        // 3. Último Fallback: @distube/ytdl-core
        try {
          const { buildYtdlRequestOptions, selectWebmOpusFormat } = require('../utils/ytdl-helpers');
          const requestOptions = await buildYtdlRequestOptions(song.url);
          const ytdlInfo = await ytdl.getInfo(song.url, requestOptions);
          
          const downloadOptions = {
            filter: 'audioonly',
            quality: 'highestaudio',
            highWaterMark: 1 << 22,
            requestOptions: requestOptions.requestOptions
          };
          
          if (requestOptions.poToken) {
            downloadOptions.poToken = requestOptions.poToken;
          }
          if (requestOptions.visitorData) {
            downloadOptions.visitorData = requestOptions.visitorData;
          }
          
          const webmFormat = selectWebmOpusFormat(ytdlInfo.formats);
          
          if (webmFormat) {
            resource = createAudioResource(ytdl.downloadFromInfo(ytdlInfo, { format: webmFormat, ...downloadOptions }), {
              inputType: StreamType.WebmOpus,
              inlineVolume: true
            });
          } else {
            resource = createAudioResource(ytdl.downloadFromInfo(ytdlInfo, { quality: 'highestaudio', filter: 'audioonly', ...downloadOptions }), {
              inputType: StreamType.Arbitrary,
              inlineVolume: true
            });
          }

          if (resource.volume) {
            resource.volume.setVolumeLogarithmic(queue.volume ?? 1.0);
          }

        } catch (error) {
          logger.warn('[player] Error precargando canción con @distube/ytdl-core:', {
            guildId,
            title: song.title,
            error: error.message
          });
          continue; // Saltar a la siguiente canción si falla la precarga
        }
      }
    }
    
    if (resource) {
      // Guardar en cache
      preloadCache.set(cacheKey, {
        resource,
        timestamp: Date.now(),
        guildId,
        song
      });
      
      logger.audio(`[player] ✓ Precargada: ${song.title}`, { guildId });
      
      // Limpiar después de 10 minutos
      setTimeout(() => {
        preloadCache.delete(cacheKey);
      }, 600000);
    }
  }
}

module.exports = {
  playNext,
  createResourceFromUrl,
  createResourceFromYtdlInfo
};
