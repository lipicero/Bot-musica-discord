/**
 * @file queue.js
 * @description Gestión de colas de reproducción por servidor
 * Maneja la cola de canciones, modos de reproducción (loop, shuffle), y estado
 */

const { createAudioPlayer, NoSubscriberBehavior, AudioPlayerStatus } = require('@discordjs/voice');
const { getVoiceConnection } = require('@discordjs/voice');
const { MAX_QUEUE_LENGTH, DEBUG_AUDIO } = require('../config/constants');
const { getGuildState } = require('../services/state');
const logger = require('../utils/logger');

// =================== MAPA GLOBAL DE COLAS ===================
const queues = new Map();

// Referencia a playNext (se configurará desde index.js)
let playNextFn = null;
let globalContext = null;

/**
 * Configura la función playNext y el contexto global
 * @param {Function} fn - Función playNext
 * @param {object} ctx - Contexto global
 */
function setPlayNextFunction(fn, ctx) {
  playNextFn = fn;
  globalContext = ctx;
  logger.debug('[queue] Función playNext configurada');
}

// =================== FUNCIONES DE COLA ===================

/**
 * Obtiene o crea la cola de un servidor
 * @param {string} guildId - ID del servidor
 * @param {object} globalState - Estado global del bot
 * @param {object} eventHandlers - Handlers de eventos del player
 * @returns {object} - Cola del servidor
 */
function getQueue(guildId, globalState = {}, eventHandlers = {}) {
  let q = queues.get(guildId);
  
  if (!q) {
    // Crear nuevo audio player
    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });
    
    // Obtener estado guardado del servidor
    const state = getGuildState(globalState, guildId);
    
    // =================== CONFIGURAR EVENT HANDLERS DEL PLAYER ===================
    
    // Handler de cambio de estado (para limpiar flags)
    player.on('stateChange', (oldState, newState) => {
      const qq = queues.get(guildId);
      if (!qq) return;
      
      // Limpiar bandera de reemplazo al entrar en Playing
      if (newState?.status === AudioPlayerStatus.Playing && qq.replacingResource) {
        qq.replacingResource = false;
      }
      
      // Logging en modo debug
      if (DEBUG_AUDIO) {
        const os = oldState?.status;
        const ns = newState?.status;
        const ms = qq.player?.state?.resource?.playbackDuration || 0;
        logger.debug(`[player] Estado: ${os} -> ${ns} (${Math.floor(ms / 1000)}s)`, { guildId });
      }
      
      // Handler personalizado si está disponible
      if (eventHandlers.onStateChange) {
        eventHandlers.onStateChange(guildId, oldState, newState, queues);
      }
    });
    
    // Handler de errores
    player.on('error', async (error) => {
      logger.error('[player] Error en reproducción', {
        guildId,
        error: error.message
      });
      
      const qq = queues.get(guildId);
      if (!qq || !qq.songs?.length) return;
      
      // Si es un error durante reemplazo, no avanzar
      if (qq.replacingResource) {
        qq.replacingResource = false;
        return;
      }
      
      // Saltar la canción que falló
      qq.songs.shift();
      
      if (qq.songs.length > 0 && playNextFn) {
        try {
          await playNextFn(guildId, queues, globalContext);
        } catch (err) {
          logger.error('[player] Error en cadena después de error:', {
            guildId,
            error: err.message
          });
        }
      } else {
        // No hay más canciones, desconectar
        try {
          const connection = getVoiceConnection(guildId);
          connection?.destroy();
          queues.delete(guildId);
          logger.audio('Desconectado tras error sin más canciones', { guildId });
        } catch {}
      }
      
      // Handler personalizado si está disponible
      if (eventHandlers.onError) {
        eventHandlers.onError(guildId, error, queues);
      }
    });
    
    // Handler de Idle (canción terminó)
    player.on(AudioPlayerStatus.Idle, () => {
      const qq = queues.get(guildId);
      if (!qq) return;
      
      // Si está reemplazando recurso (seek, cambio de volumen), ignorar
      if (qq.replacingResource) {
        qq.replacingResource = false;
        logger.debug('[player] Ignorando Idle por reemplazo de recurso', { guildId });
        return;
      }
      
      // Delay para evitar condiciones de carrera con seeks
      setTimeout(() => {
        const currentQueue = queues.get(guildId);
        if (!currentQueue) return;
        
        // Verificar de nuevo el flag de reemplazo
        if (currentQueue.replacingResource) {
          currentQueue.replacingResource = false;
          logger.debug('[player] Cancelando avance por operación pendiente', { guildId });
          return;
        }
        
        // Si está en loop, reproducir de nuevo sin avanzar
        if (currentQueue.loop && currentQueue.songs.length > 0) {
          if (playNextFn) {
            playNextFn(guildId, queues, globalContext).catch(err => {
              logger.error('[player] Error en reproducción loop:', {
                guildId,
                error: err.message
              });
            });
          }
          return;
        }
        
        // Avanzar cola
        if (currentQueue.songs.length > 1 && currentQueue.shuffleMode) {
          // Modo shuffle: seleccionar canción aleatoria
          const rest = currentQueue.songs.slice(1);
          const pick = Math.floor(Math.random() * rest.length);
          const next = rest[pick];
          const newRest = rest.filter(song => song !== next);
          
          currentQueue.songs = [next, ...newRest];
          logger.debug('[player] 🎲 Shuffle: siguiente canción seleccionada', { 
            guildId,
            title: next.title 
          });
        } else {
          // Modo normal: avanzar secuencialmente
          currentQueue.songs.shift();
        }
        
        // Reproducir siguiente o desconectar
        if (currentQueue.songs.length > 0 && playNextFn) {
          playNextFn(guildId, queues, globalContext).catch(err => {
            logger.error('[player] Error reproduciendo siguiente:', {
              guildId,
              error: err.message
            });
          });
        } else {
          // No hay más canciones, desconectar
          logger.audio('Cola vacía, desconectando...', { guildId });
          
          // Detener ticker de Now Playing
          try {
            const { stopNowPlayingTicker, deleteNowPlayingPanel } = require('./nowplaying-panel');
            if (globalContext?.nowPlayingTickers) {
              stopNowPlayingTicker(guildId, globalContext.nowPlayingTickers);
            }
            
            // Eliminar mensaje de Now Playing (async, sin await)
            if (globalContext?.nowPlayingMessages && currentQueue.textChannelId && globalContext.client) {
              globalContext.client.channels.fetch(currentQueue.textChannelId)
                .then(channel => {
                  if (channel) {
                    deleteNowPlayingPanel(guildId, channel, globalContext.nowPlayingMessages).catch(() => {});
                  }
                })
                .catch(() => {});
            }
          } catch (panelError) {
            logger.debug('[queue] Error limpiando panel:', { error: panelError.message });
          }
          
          try {
            const connection = getVoiceConnection(guildId);
            connection?.destroy();
            queues.delete(guildId);
          } catch (err) {
            logger.error('[player] Error al desconectar:', {
              guildId,
              error: err.message
            });
          }
        }
      }, 100); // Delay de 100ms
      
      // Handler personalizado si está disponible
      if (eventHandlers.onIdle) {
        eventHandlers.onIdle(guildId, queues);
      }
    });
    
    // Crear objeto de cola
    q = {
      songs: [],
      player,
      connection: null,
      textChannelId: null,
      nowPlayingMessageId: null,
      loop: state.loopMode || false,
      shuffleMode: state.shuffleMode || false,
      volume: state.volume || 1.0,
      bassGainDb: state.bassGainDb || 0,
      bassFreq: 100,
      bassWidth: 100,
      uiInterval: null,
      currentRetry: 0,
      connectingPromise: null,
      upgradeTimer: null,
      currentTrackToken: null,
      replacingResource: false,
      _directUrlCache: new Map(),
      _directUrlTimestamp: new Map(),
      _lastSeekTime: null,
      _lastSeekTimestamp: null,
    };
    
    queues.set(guildId, q);
    logger.audio(`Cola creada para servidor ${guildId}`, {
      volume: q.volume,
      bassGainDb: q.bassGainDb,
      shuffleMode: q.shuffleMode,
      loopMode: q.loop
    });
  }
  
  return q;
}

/**
 * Intenta encolar una canción
 * @param {object} queue - Cola del servidor
 * @param {object} song - Información de la canción
 * @returns {boolean} - true si se encoló, false si la cola está llena
 */
function tryEnqueue(queue, song) {
  if (!queue || !song) {
    logger.warn('[queue] tryEnqueue llamado con queue o song inválidos');
    return false;
  }
  
  if ((queue.songs?.length || 0) >= MAX_QUEUE_LENGTH) {
    logger.warn('[queue] Cola llena', {
      current: queue.songs.length,
      max: MAX_QUEUE_LENGTH
    });
    return false;
  }
  
  queue.songs.push(song);
  
  logger.audio(`Canción añadida a la cola: ${song.title}`, {
    position: queue.songs.length,
    queueSize: queue.songs.length
  });
  
  return true;
}

/**
 * Elimina una canción de la cola por índice
 * @param {object} queue - Cola del servidor
 * @param {number} index - Índice de la canción (0-based)
 * @returns {object|null} - Canción eliminada o null
 */
function removeSongAt(queue, index) {
  if (!queue || !queue.songs || index < 0 || index >= queue.songs.length) {
    return null;
  }
  
  const removed = queue.songs.splice(index, 1)[0];
  logger.audio(`Canción eliminada de posición ${index + 1}: ${removed?.title}`);
  
  return removed;
}

/**
 * Limpia toda la cola
 * @param {object} queue - Cola del servidor
 */
function clearQueue(queue) {
  if (!queue) return;
  
  const count = queue.songs.length;
  queue.songs = [];
  
  logger.audio(`Cola limpiada: ${count} canciones eliminadas`);
}

/**
 * Mezcla la cola (excepto la canción actual)
 * @param {object} queue - Cola del servidor
 */
function shuffleQueue(queue) {
  if (!queue || queue.songs.length <= 2) {
    return;
  }
  
  const current = queue.songs[0];
  const rest = queue.songs.slice(1);
  
  // Fisher-Yates shuffle
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  
  queue.songs = [current, ...rest];
  
  logger.audio(`Cola mezclada: ${rest.length} canciones`);
}

/**
 * Avanza a la siguiente canción (respetando shuffle y loop)
 * @param {object} queue - Cola del servidor
 * @param {string} guildId - ID del servidor
 * @param {Function} preloadCheck - Función para verificar si hay precarga
 * @returns {object|null} - Siguiente canción o null
 */
function advanceQueue(queue, guildId, preloadCheck = null) {
  if (!queue || queue.songs.length === 0) {
    return null;
  }
  
  // Si está en loop, mantener canción actual
  if (queue.loop) {
    logger.debug('[queue] Loop activo, manteniendo canción actual');
    return queue.songs[0];
  }
  
  // Si shuffle está activo y hay más de 2 canciones
  if (queue.shuffleMode && queue.songs.length > 1) {
    const rest = queue.songs.slice(1);
    let next = null;
    
    // OPTIMIZACIÓN: Priorizar canciones precargadas
    if (preloadCheck && typeof preloadCheck === 'function') {
      const preloadedSongs = rest.filter(song => preloadCheck(guildId, song.url));
      
      if (preloadedSongs.length > 0) {
        const pick = Math.floor(Math.random() * preloadedSongs.length);
        next = preloadedSongs[pick];
        logger.audio(`🎯 Seleccionada canción precargada (shuffle): ${next.title}`);
      }
    }
    
    // Si no hay precargadas, seleccionar aleatoriamente
    if (!next) {
      const pick = Math.floor(Math.random() * rest.length);
      next = rest[pick];
      logger.audio(`🎲 Seleccionada canción aleatoria (shuffle): ${next.title}`);
    }
    
    // Reorganizar cola
    const newRest = rest.filter(song => song !== next);
    queue.songs = [next, ...newRest];
  } else {
    // Modo normal: avanzar a la siguiente
    queue.songs.shift();
    
    if (queue.songs.length > 0) {
      logger.audio(`Avanzando a siguiente canción: ${queue.songs[0].title}`);
    }
  }
  
  return queue.songs[0] || null;
}

/**
 * Salta a una canción específica en la cola
 * @param {object} queue - Cola del servidor
 * @param {number} index - Índice de la canción (0-based)
 * @returns {boolean} - true si se pudo saltar
 */
function skipToIndex(queue, index) {
  if (!queue || !queue.songs || index < 0 || index >= queue.songs.length) {
    return false;
  }
  
  // Mover la canción deseada al frente
  const target = queue.songs.splice(index, 1)[0];
  queue.songs.unshift(target);
  
  logger.audio(`Saltando a canción ${index + 1}: ${target.title}`);
  
  return true;
}

/**
 * Alterna el modo loop
 * @param {object} queue - Cola del servidor
 * @returns {boolean} - Nuevo estado del loop
 */
function toggleLoop(queue) {
  if (!queue) return false;
  
  queue.loop = !queue.loop;
  logger.audio(`Loop ${queue.loop ? 'activado' : 'desactivado'}`);
  
  return queue.loop;
}

/**
 * Alterna el modo shuffle
 * @param {object} queue - Cola del servidor
 * @param {boolean} mixNow - Si true, mezcla la cola inmediatamente
 * @returns {boolean} - Nuevo estado del shuffle
 */
function toggleShuffle(queue, mixNow = false) {
  if (!queue) return false;
  
  queue.shuffleMode = !queue.shuffleMode;
  logger.audio(`Shuffle ${queue.shuffleMode ? 'activado' : 'desactivado'}`);
  
  // Mezclar cola si se activa y se solicita
  if (queue.shuffleMode && mixNow && queue.songs.length > 2) {
    shuffleQueue(queue);
  }
  
  return queue.shuffleMode;
}

/**
 * Actualiza el volumen de la cola
 * @param {object} queue - Cola del servidor
 * @param {number} volume - Volumen (0-2)
 * @returns {number} - Volumen actualizado
 */
function setVolume(queue, volume) {
  if (!queue) return 1.0;
  
  const vol = Math.max(0, Math.min(2, Number(volume) || 1));
  queue.volume = vol;
  
  // Aplicar al recurso actual si existe
  const resource = queue.player?.state?.resource;
  if (resource?.volume?.setVolumeLogarithmic) {
    resource.volume.setVolumeLogarithmic(vol);
  }
  
  logger.audio(`Volumen actualizado: ${(vol * 100).toFixed(0)}%`);
  
  return vol;
}

/**
 * Actualiza el bass de la cola
 * @param {object} queue - Cola del servidor
 * @param {number} bassGainDb - Ganancia de bass en dB (0-24)
 * @returns {number} - Bass actualizado
 */
function setBass(queue, bassGainDb) {
  if (!queue) return 0;
  
  const bass = Math.max(0, Math.min(24, Number(bassGainDb) || 0));
  queue.bassGainDb = bass;
  
  logger.audio(`Bass actualizado: ${bass}dB`);
  
  return bass;
}

/**
 * Elimina una cola completamente
 * @param {string} guildId - ID del servidor
 */
function deleteQueue(guildId) {
  const queue = queues.get(guildId);
  
  if (queue) {
    // Limpiar timers
    if (queue.upgradeTimer) {
      clearTimeout(queue.upgradeTimer);
    }
    if (queue.uiInterval) {
      clearInterval(queue.uiInterval);
    }
    
    // Limpiar cache
    queue._directUrlCache?.clear();
    queue._directUrlTimestamp?.clear();
    
    queues.delete(guildId);
    logger.audio(`Cola eliminada para servidor ${guildId}`);
  }
}

/**
 * Verifica si existe una cola para un servidor
 * @param {string} guildId - ID del servidor
 * @returns {boolean}
 */
function hasQueue(guildId) {
  return queues.has(guildId);
}

/**
 * Obtiene estadísticas de una cola
 * @param {object} queue - Cola del servidor
 * @returns {object} - Estadísticas
 */
function getQueueStats(queue) {
  if (!queue) {
    return {
      songs: 0,
      totalDuration: 0,
      currentPosition: 0,
      loop: false,
      shuffle: false,
      volume: 1.0,
      bass: 0
    };
  }
  
  const totalDuration = queue.songs.reduce((acc, song) => {
    return acc + (song.durationSec || 0);
  }, 0);
  
  const currentDuration = queue.player?.state?.resource?.playbackDuration || 0;
  
  return {
    songs: queue.songs.length,
    totalDuration,
    currentPosition: Math.floor(currentDuration / 1000),
    loop: queue.loop,
    shuffle: queue.shuffleMode,
    volume: queue.volume,
    bass: queue.bassGainDb
  };
}

/**
 * Obtiene todas las colas activas
 * @returns {Map} - Mapa de colas
 */
function getAllQueues() {
  return queues;
}

/**
 * Obtiene el mapa de colas (para uso externo)
 * @returns {Map} - Mapa de colas
 */
function getQueuesMap() {
  return queues;
}

/**
 * Obtiene estadísticas globales de todas las colas
 * @returns {object} - Estadísticas globales
 */
function getGlobalStats() {
  const activeQueues = queues.size;
  let totalSongs = 0;
  let totalPlaying = 0;
  
  for (const queue of queues.values()) {
    totalSongs += queue.songs.length;
    if (queue.player?.state?.status === AudioPlayerStatus.Playing) {
      totalPlaying++;
    }
  }
  
  return {
    activeQueues,
    totalSongs,
    totalPlaying
  };
}

// =================== EXPORTS ===================
module.exports = {
  // Funciones principales
  getQueue,
  deleteQueue,
  hasQueue,
  getAllQueues,
  getQueuesMap,
  
  // Configuración de playNext
  setPlayNextFunction,
  
  // Operaciones de cola
  tryEnqueue,
  removeSongAt,
  clearQueue,
  shuffleQueue,
  advanceQueue,
  skipToIndex,
  
  // Modos de reproducción
  toggleLoop,
  toggleShuffle,
  
  // Configuración
  setVolume,
  setBass,
  
  // Estadísticas
  getQueueStats,
  getGlobalStats
};
