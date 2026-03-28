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
const { 
  buildYtdlRequestOptions, 
  selectWebmOpusFormat, 
  getStreamType 
} = require('../utils/ytdl-helpers');
const { createAudioResourceWithYtDlp } = require('../utils/yt-dlp');

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
  
  // Limpiar el flag de pausa solo si estamos iniciando una canción diferente
  // (no cuando se reinicia la misma canción desde resume)
  const wasSameSong = q.currentSongUrl === current.url;
  if (!wasSameSong) {
    q.isPausedByUser = false;
    logger.debug('[player] Nueva canción detectada, limpiando isPausedByUser', { guildId });
  } else {
    logger.debug('[player] Misma canción reiniciada, manteniendo isPausedByUser', { guildId, isPausedByUser: q.isPausedByUser });
  }
  
  // Actualizar la canción actual
  q.currentSongUrl = current.url;
  
  delete q.pausedAtTime; // Limpiar tiempo pausado para nueva canción
  
  logger.audio(`Iniciando reproducción: ${current.title}`, { guildId });
  
  try {
    let resource = null;
    
    // Intentar usar recurso precargado primero
    const preloadKey = `${guildId}_${current.url}`;
    const preloadCache = context.PRELOAD_CACHE;
    
    if (preloadCache && preloadCache.has(preloadKey)) {
      const cached = preloadCache.get(preloadKey);
      if (cached && cached.resource) {
        resource = cached.resource;
        preloadCache.delete(preloadKey);
        logger.audio('[player] ⚡ Usando recurso precargado', { guildId });
      }
    }
    
    // Si no hay precargado, crear recurso nuevo
    if (!resource) {
      // MÉTODO PRINCIPAL: play-dl (mejor soporte para YouTube sin cookies)
      try {
        const { getPlayDlStream } = require('../utils/play-dl-helpers');
        
        logger.audio('[player] Obteniendo stream con play-dl', { 
          guildId, 
          url: current.url 
        });
        
        const { resource: playDlResource, info } = await getPlayDlStream(current.url);
        resource = playDlResource;
        
        // Aplicar volumen configurado
        if (resource.volume) {
          resource.volume.setVolumeLogarithmic(Math.max(0, Math.min(2, q.volume ?? 1.0)));
        }
        
        // Guardar info en current
        current.ytdlInfo = info;
        logger.audio('[player] ✓ Recurso creado con play-dl', { 
          guildId,
          title: info.title
        });
        
      } catch (playDlError) {
        logger.error('[player] play-dl falló, intentando ytdl-core', {
          guildId,
          error: playDlError.message
        });
        
        // FALLBACK: ytdl-core
        try {
          logger.audio('[player] Obteniendo información con ytdl-core', { 
            guildId, 
            url: current.url 
          });
          
          const requestOptions = await buildYtdlRequestOptions(current.url);
          const info = await ytdl.getInfo(current.url, requestOptions);
          
          // Preparar opciones completas para download (incluir poToken y visitorData)
          const downloadOptions = {
            highWaterMark: 1 << 22,
            dlChunkSize: 0,
            requestOptions: requestOptions.requestOptions
          };
          
          // Agregar tokens Po si están disponibles
          if (requestOptions.poToken) {
            downloadOptions.poToken = requestOptions.poToken;
          }
          if (requestOptions.visitorData) {
            downloadOptions.visitorData = requestOptions.visitorData;
          }
          
          // Intentar primero con formato WebM/Opus (mejor calidad, sin re-encode)
          const webmFormat = selectWebmOpusFormat(info.formats);
          
          if (webmFormat) {
            logger.audio('[player] ✓ Formato WebM/Opus encontrado', { guildId });
            
            const stream = ytdl.downloadFromInfo(info, {
              format: webmFormat,
              ...downloadOptions
            });
            
            resource = createAudioResource(stream, {
              inputType: StreamType.WebmOpus,
              inlineVolume: true
            });
          } else {
            logger.audio('[player] Usando formato audioonly (fallback)', { guildId });
            
            const stream = ytdl.downloadFromInfo(info, {
              quality: 'highestaudio',
              filter: 'audioonly',
              ...downloadOptions
            });
            
            resource = createAudioResource(stream, {
              inputType: StreamType.Arbitrary,
              inlineVolume: true
            });
          }
          
          if (resource.volume) {
            resource.volume.setVolumeLogarithmic(Math.max(0, Math.min(2, q.volume ?? 1.0)));
          }
          
          current.ytdlInfo = info;
          logger.audio('[player] ✓ Recurso creado con ytdl-core', { guildId });
          
        } catch (ytdlError) {
          logger.error('[player] ytdl-core también falló', {
            guildId,
            error: ytdlError.message
          });
          throw new Error(`No se pudo obtener el stream: ${ytdlError.message}`);
        }
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
    logger.audio(`▶️ Iniciando reproducción: ${current.title}`, { guildId });
    
    // Limpiar el flag después de que el reproductor confirme que está reproduciendo
    // Esperamos un poco más de tiempo para asegurar que el stream está estable
    setTimeout(() => {
      const currentQ = queues.get(guildId);
      if (currentQ && currentQ.player?.state?.status === AudioPlayerStatus.Playing) {
        currentQ.replacingResource = false;
        // Solo ahora registrar el tiempo de inicio cuando realmente está reproduciendo
        if (!currentQ.lastPlaybackStart) {
          currentQ.lastPlaybackStart = Date.now();
          logger.audio(`▶️ Reproducción confirmada: ${current.title}`, { guildId });
        }
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
    
  } catch (error) {
    logger.error('[player] Error reproduciendo canción:', {
      guildId,
      error: error.message,
      stack: error.stack,
      title: current?.title,
      url: current?.url
    });
    
    // Notificar error en el canal de texto
    try {
      if (q.textChannelId && context.client) {
        const channel = await context.client.channels.fetch(q.textChannelId).catch(() => null);
        if (channel?.isTextBased?.()) {
          await channel.send(
            `⚠️ No se pudo reproducir: **${current?.title || 'pista desconocida'}** — saltando...`
          ).catch(() => {});
        }
      }
    } catch {}
    
    // Saltar a la siguiente canción
    q.songs.shift();
    if (q.songs.length > 0) {
      setTimeout(() => {
        playNext(guildId, queues, context).catch(err => {
          logger.error('[player] Error en cadena de reproducción:', {
            guildId,
            error: err.message
          });
        });
      }, 500);
    } else {
      // No hay más canciones, desconectar
      try {
        const connection = getVoiceConnection(guildId);
        if (connection) {
          connection.destroy();
        }
        queues.delete(guildId);
        logger.audio('Cola vacía, desconectado del canal de voz', { guildId });
      } catch (cleanupError) {
        logger.error('[player] Error en limpieza:', {
          guildId,
          error: cleanupError.message
        });
      }
    }
  }
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
    
    try {
      // Obtener información de ytdl con cookies y tokens
      const requestOptions = await buildYtdlRequestOptions(song.url);
      const ytdlInfo = await ytdl.getInfo(song.url, requestOptions);
      
      // Preparar opciones completas para download
      const downloadOptions = {
        filter: 'audioonly',
        quality: 'highestaudio',
        highWaterMark: 1 << 22,
        requestOptions: requestOptions.requestOptions
      };
      
      // Agregar tokens Po si están disponibles
      if (requestOptions.poToken) {
        downloadOptions.poToken = requestOptions.poToken;
      }
      if (requestOptions.visitorData) {
        downloadOptions.visitorData = requestOptions.visitorData;
      }
      
      const stream = ytdl.downloadFromInfo(ytdlInfo, downloadOptions);
      
      const resource = createAudioResource(stream, {
        inputType: StreamType.Arbitrary,
        inlineVolume: true
      });
      
      if (resource.volume) {
        resource.volume.setVolumeLogarithmic(queue.volume ?? 1.0);
      }
      
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
      
    } catch (error) {
      logger.warn('[player] Error precargando canción:', {
        guildId,
        title: song.title,
        error: error.message
      });
    }
  }
}

module.exports = {
  playNext,
  createResourceFromYtdlInfo
};
