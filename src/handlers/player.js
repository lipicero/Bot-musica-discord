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
      // ESTRATEGIA: Usar play-dl primero (más confiable sin cookies), luego ytdl-core
      try {
        logger.audio('[player] Usando play-dl', { guildId });
        
        const playdl = require('play-dl');
        
        // Canonicalizar URL para play-dl (convertir music.youtube.com, youtu.be, shorts a formato estándar)
        let playableUrl = current.url;
        try {
          const u = new URL(current.url);
          // YouTube Music -> YouTube estándar
          if (/(^|\.)music\.youtube\.com$/i.test(u.hostname)) {
            const v = u.searchParams.get('v');
            if (v) playableUrl = `https://www.youtube.com/watch?v=${v}`;
          }
          // youtu.be -> youtube.com/watch
          if (/^youtu\.be$/i.test(u.hostname)) {
            const id = u.pathname.replace(/^\//, '').split(/[/?&]/)[0];
            if (id) playableUrl = `https://www.youtube.com/watch?v=${id}`;
          }
          // YouTube shorts -> watch
          if (/youtube\.com$/i.test(u.hostname) && u.pathname.startsWith('/shorts/')) {
            const id = u.pathname.split('/')[2];
            if (id) playableUrl = `https://www.youtube.com/watch?v=${id}`;
          }
        } catch (urlError) {
          // Si falla el parsing, usar URL original
        }
        
        logger.debug('[player] URL canonicalizada', { guildId, original: current.url, playable: playableUrl });
        
        const info = await playdl.video_info(playableUrl);
        const stream = await playdl.stream_from_info(info, {
          discordPlayerCompatibility: true
        });
        
        const inputType = typeof stream.type === 'number' ? stream.type : StreamType.WebmOpus;
        
        resource = createAudioResource(stream.stream, {
          inputType,
          inlineVolume: true
        });
        
        if (resource.volume) {
          resource.volume.setVolumeLogarithmic(Math.max(0, Math.min(2, q.volume || 1.0)));
        }
        
        logger.audio('[player] ✓ Recurso creado con play-dl', { guildId });
        
      } catch (playdlError) {
        logger.error('[player] Error con play-dl, intentando ytdl-core', {
          guildId,
          error: playdlError.message
        });
        
        // Fallback a ytdl-core
      }
      
      // Si no se usó yt-dlp o falló, usar ytdl-core
      if (!resource) {
        try {
          logger.audio('[player] Obteniendo información con ytdl', { 
            guildId, 
            url: current.url 
          });
          
          // Usar la misma lógica que el código antiguo que funciona
          const requestOptions = await buildYtdlRequestOptions(current.url);
          const info = await ytdl.getInfo(current.url, requestOptions);
          
          // Intentar primero con formato WebM/Opus (mejor calidad, sin re-encode)
          const webmFormat = selectWebmOpusFormat(info.formats);
          
          if (webmFormat) {
            logger.audio('[player] ✓ Formato WebM/Opus encontrado', { guildId });
            
            const stream = ytdl.downloadFromInfo(info, {
              format: webmFormat,
              highWaterMark: 1 << 25, // 32MB buffer
              dlChunkSize: 0,
              ...requestOptions
            });
            
            resource = createAudioResource(stream, {
              inputType: StreamType.WebmOpus,
              inlineVolume: true
            });
          } else {
            // Fallback: audioonly con mejor calidad disponible
            logger.audio('[player] Usando formato audioonly (fallback)', { guildId });
            
            const stream = ytdl.downloadFromInfo(info, {
              quality: 'highestaudio',
              filter: 'audioonly',
              highWaterMark: 1 << 25,
              dlChunkSize: 0,
              ...requestOptions
            });
            
            resource = createAudioResource(stream, {
              inputType: StreamType.Arbitrary,
              inlineVolume: true
            });
          }
          
          if (resource.volume) {
            resource.volume.setVolumeLogarithmic(Math.max(0, Math.min(2, q.volume || 1.0)));
          }
          
          // Guardar ytdlInfo para futuras reproducciones
          current.ytdlInfo = info;
          
          logger.audio('[player] ✓ Recurso creado con ytdl', { guildId });
          
        } catch (ytdlError) {
          logger.error('[player] Error con ytdl-core', {
            guildId,
            error: ytdlError.message,
            stack: ytdlError.stack
          });
          
          // Intentar play-dl como último fallback
          try {
            logger.audio('[player] Intentando fallback con play-dl', { guildId });
            
            const playdl = require('play-dl');
            const validateResult = await playdl.yt_validate(current.url);
            
            if (validateResult && validateResult !== 'search') {
              const stream = await playdl.stream(current.url, { quality: 2 });
              
              resource = createAudioResource(stream.stream, {
                inputType: stream.type,
                inlineVolume: true
              });
              
              if (resource.volume) {
                resource.volume.setVolumeLogarithmic(Math.max(0, Math.min(2, q.volume || 1.0)));
              }
              
              logger.audio('[player] ✓ Recurso creado con play-dl (fallback)', { guildId });
            } else {
              throw new Error(`play-dl validación falló: ${validateResult}`);
            }
          } catch (playdlError) {
            try {
              logger.audio('[player] Intentando fallback final con yt-dlp', { guildId });
              resource = await createAudioResourceWithYtDlp(current.url, q.volume || 1.0);
              current.source = 'yt-dlp';
              logger.audio('[player] ✓ Recurso creado con yt-dlp', { guildId });
            } catch (ytdlpError) {
              logger.error('[player] Todos los métodos fallaron', {
                guildId,
                ytdlError: ytdlError.message,
                playdlError: playdlError.message,
                ytdlpError: ytdlpError.message
              });
              
              throw new Error(
                `No se pudo obtener el stream. ` +
                `Considera configurar cookies de YouTube. ` +
                `ytdl-core: ${ytdlError.message}, ` +
                `play-dl: ${playdlError.message}, ` +
                `yt-dlp: ${ytdlpError.message}`
              );
            }
          }
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
    
    // Reproducir el recurso
    q.player.play(resource);
    logger.audio(`▶️ Reproduciendo: ${current.title}`, { guildId });
    
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
      }, 5000); // Esperar 5 segundos antes de precargar
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
      }, 1000);
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
      // Obtener información de ytdl
      const ytdlInfo = await ytdl.getInfo(song.url);
      const stream = ytdl.downloadFromInfo(ytdlInfo, {
        filter: 'audioonly',
        quality: 'highestaudio',
        highWaterMark: 1 << 25
      });
      
      const resource = createAudioResource(stream, {
        inputType: StreamType.Arbitrary,
        inlineVolume: true
      });
      
      if (resource.volume) {
        resource.volume.setVolumeLogarithmic(queue.volume || 1.0);
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
