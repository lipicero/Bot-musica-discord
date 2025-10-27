/**
 * @file voice.js
 * @description Gestión de conexiones de voz
 * Maneja conexión, reconexión, y estado de las conexiones de voz
 */

const {
  joinVoiceChannel,
  getVoiceConnection,
  VoiceConnectionStatus,
  entersState
} = require('@discordjs/voice');
const { DEBUG_AUDIO, REQUIRE_SAME_VC } = require('../config/constants');
const logger = require('../utils/logger');

// =================== GESTIÓN DE CONEXIONES ===================

/**
 * Verifica si un usuario está en el mismo canal de voz que el bot
 * @param {object} guild - Servidor de Discord
 * @param {object} member - Miembro del servidor
 * @returns {boolean}
 */
function sameVoiceChannelRequired(guild, member) {
  if (!REQUIRE_SAME_VC) return true;
  
  try {
    const connection = getVoiceConnection(guild.id);
    const botChannelId = connection?.joinConfig?.channelId;
    const userChannelId = member?.voice?.channelId;
    
    if (!botChannelId || !userChannelId) return false;
    return botChannelId === userChannelId;
  } catch (error) {
    logger.warn('[voice] Error verificando canal de voz', {
      guildId: guild.id,
      error: error.message
    });
    return false;
  }
}

/**
 * Asegura una conexión de voz válida
 * @param {string} guildId - ID del servidor
 * @param {object} guild - Servidor de Discord
 * @param {object} voiceChannel - Canal de voz
 * @param {object} queue - Cola del servidor
 * @returns {Promise<object>} - Conexión de voz
 */
async function ensureConnection(guildId, guild, voiceChannel, queue) {
  // Verificar si ya existe una conexión válida
  if (
    queue.connection &&
    queue.connection.state.status !== VoiceConnectionStatus.Destroyed
  ) {
    logger.debug('[voice] Usando conexión existente', { guildId });
    return queue.connection;
  }

  // Si ya hay un intento de conexión en progreso, esperar
  if (queue.connectingPromise) {
    logger.debug('[voice] Esperando conexión en progreso', { guildId });
    return queue.connectingPromise;
  }

  // Función para intentar unirse al canal
  const attemptJoin = async () => {
    logger.voice(`Intentando unirse a canal ${voiceChannel.id}`, { guildId });
    
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });
    
    // Configurar event handlers
    setupConnectionHandlers(connection, guildId, queue);
    
    // Suscribir el player a la conexión
    connection.subscribe(queue.player);
    
    // Esperar hasta que esté listo (45 segundos)
    await entersState(connection, VoiceConnectionStatus.Ready, 45_000);
    
    logger.voice('Conexión establecida y lista', { guildId });
    return connection;
  };

  // Intentar conectar con reintentos
  queue.connectingPromise = (async () => {
    let lastError;
    
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        queue.connection = await attemptJoin();
        return queue.connection;
      } catch (error) {
        lastError = error;
        logger.warn(`[voice] Intento ${attempt + 1}/5 falló`, {
          guildId,
          error: error.message
        });
        
        // Limpiar conexión fallida
        try {
          queue.connection?.destroy();
        } catch {}
        queue.connection = null;
        
        // Esperar antes de reintentar (excepto en el último intento)
        if (attempt < 4) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }
    
    // Todos los intentos fallaron
    const error = new Error('VOICE_CONNECT_TIMEOUT');
    error.cause = lastError;
    throw error;
  })();

  try {
    const connection = await queue.connectingPromise;
    return connection;
  } finally {
    queue.connectingPromise = null;
  }
}

/**
 * Configura los event handlers de una conexión de voz
 * @param {object} connection - Conexión de voz
 * @param {string} guildId - ID del servidor
 * @param {object} queue - Cola del servidor
 */
function setupConnectionHandlers(connection, guildId, queue) {
  // Handler de errores
  connection.on('error', (error) => {
    logger.error('[voice] Error en conexión', {
      guildId,
      error: error.message
    });
  });
  
  // Handler de desconexión con reconexión automática
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    logger.warn(`[voice] Desconectado, intentando reconectar`, { guildId });
    
    try {
      // Intento 1: Reconexión rápida (5 segundos)
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
      
      logger.voice('Reconexión rápida exitosa', { guildId });
    } catch {
      // Intento 2: Reconexión extendida (20 segundos)
      logger.warn(`[voice] Reconexión rápida falló, intentando extendida`, { guildId });
      
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 20_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 20_000),
        ]);
        
        logger.voice('Reconexión extendida exitosa', { guildId });
      } catch {
        // Todos los intentos fallaron
        logger.error(`[voice] Reconexión fallida completamente`, { guildId });
        
        try {
          connection.destroy();
          
          // Detener el player
          if (queue.player) {
            queue.player.stop(true);
          }
        } catch (error) {
          logger.error('[voice] Error al destruir conexión', {
            guildId,
            error: error.message
          });
        }
      }
    }
  });
  
  // Handlers de cambios de estado (para logging)
  connection.on(VoiceConnectionStatus.Connecting, () => {
    logger.debug('[voice] Estado: Conectando...', { guildId });
  });
  
  connection.on(VoiceConnectionStatus.Signalling, () => {
    logger.debug('[voice] Estado: Señalizando...', { guildId });
  });
  
  connection.on(VoiceConnectionStatus.Ready, () => {
    logger.voice('Estado: Listo y conectado', { guildId });
  });
  
  connection.on(VoiceConnectionStatus.Destroyed, () => {
    logger.debug('[voice] Estado: Destruido', { guildId });
  });
  
  // Fix para keepAlive UDP leak y prevención de fugas de listeners
  const networkingStateChangeHandler = (oldNet, newNet) => {
    const udp = Reflect.get(newNet, 'udp');
    if (udp && udp.keepAliveInterval) {
      try {
        clearInterval(udp.keepAliveInterval);
      } catch {}
      udp.keepAliveInterval = null;
    }
  };
  
  connection.on('stateChange', (oldState, newState) => {
    const oldNetworking = Reflect.get(oldState, 'networking');
    const newNetworking = Reflect.get(newState, 'networking');
    
    // Remover handler anterior
    const previousHandler = Reflect.get(connection, '_networkingHandler');
    if (oldNetworking && previousHandler) {
      oldNetworking.off?.('stateChange', previousHandler);
    }
    
    // Agregar nuevo handler
    if (newNetworking) {
      // Aumentar límite de listeners para evitar warnings
      newNetworking.setMaxListeners?.(20);
      newNetworking.on?.('stateChange', networkingStateChangeHandler);
      Reflect.set(connection, '_networkingHandler', networkingStateChangeHandler);
    }
  });
}

/**
 * Desconecta el bot de un canal de voz
 * @param {string} guildId - ID del servidor
 */
function disconnectVoice(guildId) {
  try {
    const connection = getVoiceConnection(guildId);
    
    if (connection) {
      connection.destroy();
      logger.voice('Desconectado del canal de voz', { guildId });
    }
  } catch (error) {
    logger.error('[voice] Error al desconectar', {
      guildId,
      error: error.message
    });
  }
}

/**
 * Verifica si el bot está conectado a un canal de voz
 * @param {string} guildId - ID del servidor
 * @returns {boolean}
 */
function isConnected(guildId) {
  try {
    const connection = getVoiceConnection(guildId);
    return !!(connection && connection.state.status !== VoiceConnectionStatus.Destroyed);
  } catch (error) {
    logger.debug('[voice] Error verificando conexión', { 
      guildId, 
      error: error?.message 
    });
    return false;
  }
}

/**
 * Obtiene información del canal de voz actual
 * @param {string} guildId - ID del servidor
 * @returns {object|null} - Información del canal o null
 */
function getVoiceChannelInfo(guildId) {
  try {
    const connection = getVoiceConnection(guildId);
    
    if (!connection) {
      return null;
    }
    
    return {
      channelId: connection.joinConfig?.channelId,
      guildId: connection.joinConfig?.guildId,
      status: connection.state.status,
      ping: connection.ping?.udp || null
    };
  } catch (error) {
    logger.warn('[voice] Error obteniendo info del canal', {
      guildId,
      error: error.message
    });
    return null;
  }
}

/**
 * Fuerza la reconexión del bot
 * @param {string} guildId - ID del servidor
 * @param {object} guild - Servidor de Discord
 * @param {object} voiceChannel - Canal de voz
 * @param {object} queue - Cola del servidor
 * @returns {Promise<object>} - Nueva conexión
 */
async function forceReconnect(guildId, guild, voiceChannel, queue) {
  logger.voice('Forzando reconexión', { guildId });
  
  // Destruir conexión actual
  try {
    const connection = getVoiceConnection(guildId);
    if (connection) {
      connection.destroy();
    }
  } catch (error) {
    logger.warn('[voice] Error destruyendo conexión anterior', {
      guildId,
      error: error.message
    });
  }
  
  // Limpiar referencias
  queue.connection = null;
  queue.connectingPromise = null;
  
  // Crear nueva conexión
  return ensureConnection(guildId, guild, voiceChannel, queue);
}

/**
 * Obtiene estadísticas de todas las conexiones de voz
 * @returns {object} - Estadísticas
 */
function getVoiceStats() {
  const connections = [];
  
  // Iterar sobre todas las conexiones activas
  // (Nota: @discordjs/voice no expone directamente un mapa de conexiones,
  // así que esto debe manejarse desde el caller que tiene acceso a las colas)
  
  return {
    total: connections.length,
    connections
  };
}

// =================== EXPORTS ===================
module.exports = {
  // Funciones principales
  ensureConnection,
  disconnectVoice,
  forceReconnect,
  
  // Utilidades
  sameVoiceChannelRequired,
  isConnected,
  getVoiceChannelInfo,
  getVoiceStats,
  
  // Acceso a funciones de @discordjs/voice
  getVoiceConnection,
  VoiceConnectionStatus
};
