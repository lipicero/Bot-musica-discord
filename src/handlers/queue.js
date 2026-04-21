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
const { createAudioResourceWithYtDlp } = require('../utils/yt-dlp');

// =================== MAPA GLOBAL DE COLAS ===================
const queues = new Map();

// Timeout para desconexión cuando la cola está vacía
const emptyQueueTimeouts = new Map();
const EMPTY_QUEUE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutos

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
    
    // Si no se proporciona globalState, intentar obtenerlo del contexto global
    const effectiveGlobalState = (Object.keys(globalState).length === 0 && globalContext?.guildState) 
      ? globalContext.guildState 
      : globalState;
    
    // Obtener estado guardado del servidor
    const state = getGuildState(effectiveGlobalState, guildId);
    
    // =================== CONFIGURAR EVENT HANDLERS DEL PLAYER ===================
    
    // Handler de cambio de estado (para limpiar flags)
    player.on('stateChange', (oldState, newState) => {
      const qq = queues.get(guildId);
      if (!qq) return;
      
      // Limpiar bandera de reemplazo al entrar en Playing
      if (newState?.status === AudioPlayerStatus.Playing && qq.replacingResource) {
        qq.replacingResource = false;
      }
      
      // Resetear contador de errores 403 cuando una canción se reproduce exitosamente
      if (newState?.status === AudioPlayerStatus.Playing && qq.consecutive403Errors) {
        qq.consecutive403Errors = 0;
      }
      
      // Logging en modo debug
      if (DEBUG_AUDIO) {
        const os = oldState?.status;
        const ns = newState?.status;
        const ms = qq.player?.state?.resource?.playbackDuration || 0;
        logger.debug(`[player] Estado: ${os} -> ${ns} (${Math.floor(ms / 1000)}s)`, { guildId });
      }
      
      // Log especial cuando cambia de Paused a Idle
      if (oldState?.status === AudioPlayerStatus.Paused && newState?.status === AudioPlayerStatus.Idle) {
        logger.warn('[player] ⚠️ Cambió de Paused a Idle', {
          guildId,
          isPausedByUser: qq.isPausedByUser,
          playbackDuration: qq.player?.state?.resource?.playbackDuration || 0
        });
        
        // Si el usuario pausó manualmente y el stream se cerró, marcar que no debe avanzar
        if (qq.isPausedByUser) {
          qq.preventAutoAdvance = true;
          logger.warn('[player] Marcando para prevenir avance automático', { guildId });
        }
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
        error: error.message,
        errorName: error.name,
        errorCode: error.code,
        stack: error.stack
      });
      
      const qq = queues.get(guildId);
      if (!qq || !qq.songs?.length) return;
      
      // Detectar errores críticos de OpusScript o streams
      const isCriticalError = 
        error.message?.includes('offset is out of bounds') ||
        error.message?.includes('RangeError') ||
        error.name === 'RangeError';
      
      // Detectar error 403 de YouTube
      const isYouTube403 = 
        error.message?.includes('Status code: 403') ||
        error.message?.includes('403');
      
      if (isCriticalError) {
        logger.warn('[player] Error crítico detectado, intentando recuperación', { guildId });
      }
      
      if (isYouTube403) {
        logger.warn('[player] Error 403 de YouTube en una canción', { guildId });
        
        // Contador de errores 403 consecutivos
        if (!qq.consecutive403Errors) qq.consecutive403Errors = 0;
        qq.consecutive403Errors++;

        if (qq.songs?.length) {
          const currentSong = qq.songs[0];
          currentSong._ytDlpAttempts = currentSong._ytDlpAttempts || 0;

          if (currentSong._ytDlpAttempts < 1) {
            currentSong._ytDlpAttempts++;

            try {
              logger.warn('[player] Error 403 persistente, reintentando con yt-dlp', { guildId });
              const fallbackResource = await createAudioResourceWithYtDlp(currentSong.url, qq.volume ?? 1.0);
              qq.replacingResource = true;
              qq.player.play(fallbackResource);
              qq.consecutive403Errors = 0;
              logger.audio('[player] ▶️ Reproducción retomada con yt-dlp', { guildId });
              return;
            } catch (fallbackError) {
              logger.error('[player] Fallback yt-dlp falló', {
                guildId,
                error: fallbackError.message
              });
            }
          }
        }
        
        // Solo notificar después de 3 errores 403 consecutivos
        // (Algunos videos pueden estar bloqueados individualmente, no es problema de cookies)
        if (qq.consecutive403Errors >= 3) {
          logger.error('[player] Múltiples errores 403 consecutivos - Posible problema de cookies', { guildId, count: qq.consecutive403Errors });
          
          try {
            if (qq.textChannelId && globalContext?.client) {
              const channel = await globalContext.client.channels.fetch(qq.textChannelId).catch(() => null);
              if (channel?.isTextBased?.()) {
                await channel.send({
                  content: '⚠️ **YouTube está bloqueando múltiples solicitudes (Error 403)**\n' +
                    'Esto puede deberse a cookies expiradas o límites de YouTube.\n' +
                    'Saltando a la siguiente canción...\n\n' +
                    '💡 **Solución**: El administrador debe actualizar las cookies de YouTube.\n' +
                    'Ver documentación: `SOLUCION-DEFINITIVA-403.md`'
                }).catch(() => {});
              }
            }
          } catch (notifyError) {
            logger.debug('[player] No se pudo notificar errores 403', { guildId });
          }
          
          // Resetear contador después de notificar
          qq.consecutive403Errors = 0;
        }
      } else {
        // Si no es error 403, resetear contador
        if (qq.consecutive403Errors) qq.consecutive403Errors = 0;
      }
      
      // Si es un error durante reemplazo, no avanzar
      if (qq.replacingResource) {
        qq.replacingResource = false;
        return;
      }
      
      // Si el usuario pausó manualmente, no saltar automáticamente por errores
      // El stream se cerrará y el handler de Idle decidirá qué hacer
      if (qq.isPausedByUser) {
        logger.warn('[player] Error mientras pausado - esperando que el stream se cierre naturalmente', { 
          guildId,
          isPausedByUser: qq.isPausedByUser
        });
        return;
      }
      
      // Saltar la canción que falló
      const failedSong = qq.songs.shift();
      if (failedSong) {
        logger.warn('[player] Saltando canción con error', { 
          guildId, 
          song: failedSong.title 
        });
      }
      
      if (qq.songs.length > 0 && playNextFn) {
        try {
          // Pequeña pausa antes de intentar la siguiente canción
          if (isCriticalError) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
          await playNextFn(guildId, queues, globalContext);
        } catch (err) {
          logger.error('[player] Error en cadena después de error:', {
            guildId,
            error: err.message
          });
          // Si falla consecutivamente, desconectar
          try {
            const connection = getVoiceConnection(guildId);
            connection?.destroy();
            queues.delete(guildId);
            logger.warn('[player] Desconectado tras errores consecutivos', { guildId });
          } catch {}
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
        try {
          eventHandlers.onError(guildId, error, queues);
        } catch (handlerErr) {
          logger.error('[player] Error en handler personalizado', {
            guildId,
            error: handlerErr.message
          });
        }
      }
    });
    
    // Handler de Idle (canción terminó)
    player.on(AudioPlayerStatus.Idle, () => {
      const qq = queues.get(guildId);
      if (!qq) return;
      
      logger.warn('[player] Evento Idle disparado', { 
        guildId, 
        status: qq.player?.state?.status,
        isPausedByUser: qq.isPausedByUser,
        preventAutoAdvance: qq.preventAutoAdvance,
        songsLength: qq.songs?.length || 0
      });
      
      // Si está reemplazando recurso (seek, cambio de volumen, o nueva canción iniciando), ignorar
      if (qq.replacingResource) {
        qq.replacingResource = false;
        logger.debug('[player] Ignorando Idle por reemplazo de recurso', { guildId });
        return;
      }
      
      // Delay más largo para evitar condiciones de carrera con seeks y cambios de recurso
      // Algunas canciones pueden disparar Idle prematuramente si el stream es inestable
      setTimeout(() => {
        const currentQueue = queues.get(guildId);
        if (!currentQueue) return;
        
        // Verificar de nuevo el flag de reemplazo
        if (currentQueue.replacingResource) {
          currentQueue.replacingResource = false;
          logger.debug('[player] Cancelando avance por operación pendiente', { guildId });
          return;
        }
        
        // Verificar si el reproductor realmente está en Idle
        // A veces puede haber falsos positivos
        const currentStatus = currentQueue.player?.state?.status;
        if (currentStatus !== AudioPlayerStatus.Idle) {
          logger.debug('[player] Cancelando avance - el reproductor ya no está en Idle', { 
            guildId, 
            status: currentStatus 
          });
          return;
        }
        
        // Verificar si el usuario pausó manualmente
        // Cuando está pausado, después de ~45 segundos el stream se cierra y el estado cambia a Idle
        // No queremos avanzar a la siguiente canción en este caso
        logger.warn('[player] Verificando pausa antes del check - isPausedByUser:', currentQueue.isPausedByUser, 'preventAutoAdvance:', currentQueue.preventAutoAdvance, 'status:', currentStatus, { guildId });
        if (currentQueue.isPausedByUser || currentQueue.preventAutoAdvance) {
          logger.warn('[player] Cancelando avance - reproducción pausada por el usuario o marcado para prevenir avance', { guildId });
          
          // Limpiar el flag
          currentQueue.preventAutoAdvance = false;
          return;
        }
        
        // Verificar duración de reproducción
        const playbackDuration = currentQueue.player?.state?.resource?.playbackDuration || 0;
        const playedSeconds = Math.floor(playbackDuration / 1000);
        const currentSong = currentQueue.songs[0];
        
        // NOTA: El sistema de reintentos se ha DESACTIVADO porque causaba falsos positivos
        // @discordjs/voice reporta playbackDuration=0 incluso cuando el audio se reproduce correctamente
        // Esto sucede especialmente con yt-dlp streams que se descargan más rápido de lo que se reproducen
        
        // Log para diagnóstico
        if (playedSeconds < 5 && currentSong && currentSong.durationSec > 30) {
          logger.debug('[player] Duración reportada como baja, pero continuando normalmente', {
            guildId,
            playedSeconds,
            expectedDuration: currentSong.durationSec,
            title: currentSong.title
          });
        }
        
        logger.audio('[player] ✓ Canción completada', { 
          guildId, 
          title: currentSong?.title,
          playedSeconds 
        });
        
        // Resetear contador de reintentos si la canción se completó exitosamente
        if (currentSong && currentSong._retryCount) {
          delete currentSong._retryCount;
        }
        
        // Log de debug para verificar estado
        logger.debug('[player] Estado al terminar canción', {
          guildId,
          loopActive: currentQueue.loop,
          currentPlayCount: currentSong?._playCount || 0,
          songTitle: currentSong?.title,
          songsInQueue: currentQueue.songs.length
        });
        
        // Verificar si la canción debe repetirse
        let shouldRepeat = false;
        
        // SOLO si el loop está ACTIVO, verificar si debe repetirse
        if (currentQueue.loop && currentSong) {
          // Inicializar contador si no existe (primera vez que termina)
          if (!currentSong._playCount) {
            currentSong._playCount = 1;
          }
          
          // Verificar si debe repetirse (solo si se ha reproducido 1 vez)
          if (currentSong._playCount === 1) {
            shouldRepeat = true;
            currentSong._playCount = 2; // Marcar como segunda reproducción
            logger.audio('[player] 🔁 Loop ACTIVO: repitiendo canción (reproducción 2/2)', {
              guildId,
              title: currentSong.title
            });
          } else {
            // Ya se reprodujo 2 veces, avanzar
            logger.audio('[player] 🔁 Loop: canción completó 2 reproducciones, avanzando', {
              guildId,
              title: currentSong.title
            });
          }
        } else {
          // Loop DESACTIVADO - nunca repetir
          logger.debug('[player] Loop DESACTIVADO, avanzando a siguiente canción', {
            guildId
          });
        }
        
        // Si NO debe repetirse, eliminar la canción y avanzar
        if (!shouldRepeat) {
          // Resetear contador antes de eliminar/mover
          if (currentSong._playCount) {
            delete currentSong._playCount;
          }
          if (currentSong._retryCount) {
            delete currentSong._retryCount;
          }
          
          // Eliminar la canción actual
          currentQueue.songs.shift();
          logger.debug('[player] Canción eliminada de la cola', {
            guildId,
            title: currentSong?.title,
            remainingSongs: currentQueue.songs.length
          });
          
          // Avanzar cola según el modo shuffle
          if (currentQueue.shuffleMode && currentQueue.songs.length > 1) {
            // Modo shuffle: seleccionar siguiente aleatoria de las restantes
            const pick = Math.floor(Math.random() * currentQueue.songs.length);
            const next = currentQueue.songs[pick];
            const newRest = currentQueue.songs.filter(song => song !== next);
            
            currentQueue.songs = [next, ...newRest];
            logger.debug('[player] 🎲 Shuffle: siguiente canción seleccionada', { 
              guildId,
              title: next.title
            });
          }
          // Si no hay shuffle, la siguiente canción ya está en posición 0 después del shift()
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
          // No hay más canciones, programar desconexión después de 10 minutos
          logger.audio('Cola vacía, esperando 10 minutos antes de desconectar...', { guildId });
          
          // Limpiar timeout anterior si existe
          if (emptyQueueTimeouts.has(guildId)) {
            clearTimeout(emptyQueueTimeouts.get(guildId));
            emptyQueueTimeouts.delete(guildId);
          }
          
          // Programar desconexión
          const timeoutId = setTimeout(() => {
            logger.audio('Timeout de cola vacía alcanzado, desconectando...', { guildId });
            
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
              emptyQueueTimeouts.delete(guildId);
            } catch (err) {
              logger.error('[player] Error al desconectar:', {
                guildId,
                error: err.message
              });
            }
          }, EMPTY_QUEUE_TIMEOUT_MS);
          
          emptyQueueTimeouts.set(guildId, timeoutId);
        }
      }, 200); // Delay de 200ms (reducido desde 500ms)
      
      // Handler personalizado si está disponible
      if (eventHandlers.onIdle) {
        eventHandlers.onIdle(guildId, queues);
      }
    });
    
    // Crear objeto de cola
    q = {
      guildId: guildId, // Agregar guildId para referencia
      songs: [],
      player,
      connection: null,
      textChannelId: null,
      nowPlayingMessageId: null,
      loop: state.loopMode || false,
      shuffleMode: state.shuffleMode || false,
      volume: state.volume ?? 1.0,
      bassGainDb: state.bassGainDb ?? 0,
      bassFreq: 100,
      bassWidth: 100,
      uiInterval: null,
      currentRetry: 0,
      connectingPromise: null,
      upgradeTimer: null,
      currentTrackToken: null,
      replacingResource: false,
      isPausedByUser: false, // Flag para indicar si el usuario pausó manualmente
      currentSongUrl: null, // URL de la canción actualmente reproduciéndose
      _directUrlCache: new Map(),
      _directUrlTimestamp: new Map(),
      _lastSeekTime: null,
      _lastSeekTimestamp: null,
      playbackOffset: 0, // Offset de inicio en segundos (para seeks)
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
  
  // Cancelar timeout de cola vacía si existe
  const guildId = queue.guildId;
  if (guildId && emptyQueueTimeouts.has(guildId)) {
    clearTimeout(emptyQueueTimeouts.get(guildId));
    emptyQueueTimeouts.delete(guildId);
    logger.debug('[queue] Timeout de cola vacía cancelado - nueva canción agregada', { guildId });
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
  
  const currentSong = queue.songs[0];
  
  // Verificar si la canción debe repetirse (solo una vez con loop activo)
  let shouldRepeat = false;
  
  // SOLO si el loop está ACTIVO, verificar si debe repetirse
  if (queue.loop && currentSong) {
    // Inicializar contador si no existe (primera vez que termina)
    if (!currentSong._playCount) {
      currentSong._playCount = 1;
    }
    
    // Verificar si debe repetirse (solo si se ha reproducido 1 vez)
    if (currentSong._playCount === 1) {
      shouldRepeat = true;
      currentSong._playCount = 2; // Marcar como segunda reproducción
      logger.audio('[queue] 🔁 Loop ACTIVO: repitiendo canción (reproducción 2/2)', {
        guildId,
        title: currentSong.title
      });
    }
  } else {
    // Loop DESACTIVADO - nunca repetir
    logger.debug('[queue] Loop DESACTIVADO, avanzando normalmente', {
      guildId
    });
  }
  
  // Si NO debe repetirse, eliminar y avanzar
  if (!shouldRepeat) {
    // Resetear contadores
    if (currentSong._playCount) delete currentSong._playCount;
    if (currentSong._retryCount) delete currentSong._retryCount;
    
    // Eliminar la canción actual
    queue.songs.shift();
    
    // Si shuffle está activo y hay más de 1 canción restante
    if (queue.shuffleMode && queue.songs.length > 1) {
      let next = null;
      
      // OPTIMIZACIÓN: Priorizar canciones precargadas
      if (preloadCheck && typeof preloadCheck === 'function') {
        const preloadedSongs = queue.songs.filter(song => preloadCheck(guildId, song.url));
        
        if (preloadedSongs.length > 0) {
          const pick = Math.floor(Math.random() * preloadedSongs.length);
          next = preloadedSongs[pick];
          logger.audio(`🎯 Seleccionada canción precargada (shuffle): ${next.title}`);
        }
      }
      
      // Si no hay precargadas, seleccionar aleatoriamente
      if (!next) {
        const pick = Math.floor(Math.random() * queue.songs.length);
        next = queue.songs[pick];
        logger.audio(`🎲 Seleccionada canción aleatoria (shuffle): ${next.title}`);
      }
      
      // Reorganizar cola con la siguiente canción al frente
      const newRest = queue.songs.filter(song => song !== next);
      queue.songs = [next, ...newRest];
    } else if (queue.songs.length > 0) {
      // Modo normal: la siguiente canción ya está en posición 0 después del shift
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
    
    // Limpiar timeout de cola vacía
    if (emptyQueueTimeouts.has(guildId)) {
      clearTimeout(emptyQueueTimeouts.get(guildId));
      emptyQueueTimeouts.delete(guildId);
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

/**
 * Limpia el timeout de cola vacía para un servidor
 * @param {string} guildId - ID del servidor
 */
function clearEmptyQueueTimeout(guildId) {
  if (emptyQueueTimeouts.has(guildId)) {
    clearTimeout(emptyQueueTimeouts.get(guildId));
    emptyQueueTimeouts.delete(guildId);
    logger.debug('[queue] Timeout de cola vacía limpiado manualmente', { guildId });
  }
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
  getGlobalStats,
  
  // Utilidades
  clearEmptyQueueTimeout
};
