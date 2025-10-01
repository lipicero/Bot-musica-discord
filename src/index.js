/**
 * @file src/index.js
 * @description Punto de entrada principal del bot - Coordina la inicialización de todos los módulos
 */

// =================== MANEJADORES DE ERRORES GLOBALES ===================
const fs = require('fs');
const path = require('path');

// Crear directorio de logs si no existe
const logsDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const logPath = path.join(logsDir, 'bot.err.log');

process.on('uncaughtException', (err) => {
  fs.appendFileSync(logPath, `\n[uncaughtException] ${new Date().toISOString()} - ${err.stack || err}`);
  console.error('[uncaughtException]', err);
  // NO salir del proceso para mantener el bot activo
});

process.on('unhandledRejection', (reason, promise) => {
  fs.appendFileSync(logPath, `\n[unhandledRejection] ${new Date().toISOString()} - ${reason}`);
  console.error('[unhandledRejection]', reason);
  // NO salir del proceso para mantener el bot activo
});

process.on('warning', (warning) => {
  if (warning.name === 'MaxListenersExceededWarning') {
    console.warn('[process:warning:listeners]', warning.message);
  } else {
    console.warn('[process:warning]', warning.name, warning.message);
  }
});

// =================== CONFIGURACIÓN INICIAL ===================
process.env.YTDL_NO_UPDATE = "1";
require("dotenv").config({ quiet: true });

// Configurar ffmpeg-static si está disponible
try {
  const ffmpegPath = require("ffmpeg-static");
  if (ffmpegPath) {
    process.env.FFMPEG_PATH = ffmpegPath;
    console.log("[ffmpeg] ffmpeg-static configurado");
  }
} catch (_) {
  console.warn("[ffmpeg] ffmpeg-static no instalado; se intentará sin FFmpeg");
}

// =================== IMPORTAR MÓDULOS ===================
const logger = require('./utils/logger');
const { 
  DEBUG_AUDIO, 
  REQUIRE_SAME_VC,
  IDLE_TIMEOUT_MINUTES 
} = require('./config/constants');

const { Client, GatewayIntentBits } = require('discord.js');
const { loadCommands } = require('./commands');
const { createWebServer } = require('./web/server');
const webStats = require('./web/stats');

// Importar handlers
const { setPlayNextFunction, getQueuesMap } = require('./handlers/queue');
const { playNext } = require('./handlers/player');

// =================== INICIALIZACIÓN ===================
logger.bot('🤖 Iniciando bot de música...');

// Cargar comandos
logger.bot('Cargando comandos...');
const commands = loadCommands();
logger.bot(`✓ ${commands.size} comandos cargados`);

// =================== CLIENTE DISCORD ===================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
  ws: {
    properties: {
      browser: "Discord Client",
    },
  },
  rest: {
    timeout: 30000,
    retries: 3,
  },
  closeTimeout: 5000,
  waitGuildTimeout: 15000,
  shardCount: 1,
  shards: [0],
  presence: {
    status: 'online',
    activities: [{
      name: '🎵 música | /play',
      type: 2 // LISTENING
    }]
  }
});

// =================== ESTADO GLOBAL ===================
// Usar el mapa de colas del handler para asegurar consistencia
const queues = getQueuesMap();

// Timeouts y trackers
const idleTimeouts = new Map(); // Timeouts de inactividad
const nowPlayingMessages = new Map(); // Mensajes de "Now Playing"
const nowPlayingTickers = new Map(); // Intervalos de actualización

// Caches (se inicializarán desde services/)
const { MetadataCache, PreloadCache } = require('./services/cache');
const METADATA_CACHE = new MetadataCache();
const PRELOAD_CACHE = new PreloadCache();
const USER_STATS = new Map();

// Estado persistente (volumen, loop, bass por servidor)
const stateService = require('./services/state');
const guildState = stateService.loadState();

logger.bot('✓ Estado inicializado');

// =================== CONTEXTO GLOBAL PARA COMANDOS ===================
// Este objeto contiene todo lo que los comandos necesitan acceder
const globalContext = {
  // Cliente Discord
  client,
  
  // Estado
  queues,
  idleTimeouts,
  nowPlayingMessages,
  nowPlayingTickers,
  guildState,
  
  // Funciones de estado
  saveState: (state) => stateService.saveState(state || guildState),
  
  // Caches
  METADATA_CACHE,
  PRELOAD_CACHE,
  USER_STATS,
  
  // Función de reproducción
  playNext: (guildId) => playNext(guildId, queues, globalContext),
  
  // Servicios (se cargarán dinámicamente cuando se necesiten)
  // Los comandos pueden require() directamente los handlers y services que necesiten
  
  // Funciones auxiliares (placeholder - los comandos usan los handlers directamente)
  formatQueueMessage: (q, limit = 10) => {
    const { formatters } = require('./utils/formatters');
    if (!q || !Array.isArray(q.songs) || q.songs.length === 0) {
      return "La cola está vacía.";
    }
    
    const elapsed = Math.floor((q.player?.state?.resource?.playbackDuration || 0) / 1000);
    const lines = q.songs.slice(0, limit).map((s, i) => {
      const dur = s.durationSec ? ` [${formatters.formatDuration(s.durationSec)}]` : "";
      if (i === 0) {
        const left = s.durationSec 
          ? ` (${formatters.formatDuration(elapsed)} / ${formatters.formatDuration(s.durationSec)})`
          : "";
        return `▶️ ${s.title}${dur}${left}`;
      }
      return `${i + 1}. ${s.title}${dur}`;
    });
    
    if (q.songs.length > limit) {
      lines.push(`... y ${q.songs.length - limit} más`);
    }
    
    return lines.join("\n");
  }
};

// =================== CONFIGURAR PLAYBACK HANDLER ===================
// Vincular la función playNext con el handler de cola
setPlayNextFunction((guildId) => playNext(guildId, queues, globalContext), globalContext);
logger.bot('✓ Handler de reproducción configurado');

// =================== SERVIDOR WEB ===================
const { app, server, io, startWebServer, startHealthServer } = createWebServer({
  client,
  queues,
  METADATA_CACHE,
  PRELOAD_CACHE,
  USER_STATS
});

logger.bot('✓ Servidor web configurado');

// =================== EVENT HANDLERS DEL BOT ===================

// Ready event
client.once("clientReady", async (c) => {
  logger.bot(`✅ Conectado como ${c.user?.tag || c.user?.id}`);
  
  // Registrar comandos slash (pasar el cliente ready)
  try {
    await registerSlashCommands(c);
    logger.bot('✓ Comandos slash registrados');
  } catch (error) {
    logger.error('Error registrando comandos slash:', { error: error.message });
  }
  
  // Iniciar servidor web
  try {
    startWebServer();
  } catch (error) {
    logger.error('Error iniciando servidor web:', { error: error.message });
  }
  
  // Iniciar health server para Render
  try {
    startHealthServer();
  } catch (error) {
    logger.error('Error iniciando health server:', { error: error.message });
  }
  
  // Iniciar sistema de health check interno
  startHealthCheckSystem();
});

// Error handlers
client.on("error", (error) => {
  logger.error('[client:error]', { error: error.message, stack: error.stack });
  fs.appendFileSync(logPath, `\n[client:error] ${new Date().toISOString()} - ${error.stack || error}`);
});

client.on("warn", (info) => {
  logger.warn('[client:warn]', { info });
});

client.on("shardError", (error, shardId) => {
  logger.error(`[shard:${shardId}:error]`, { error: error.message });
  fs.appendFileSync(logPath, `\n[shard:${shardId}:error] ${new Date().toISOString()} - ${error.stack || error}`);
});

client.on("shardDisconnect", (event, shardId) => {
  logger.warn(`[shard:${shardId}:disconnect]`, { code: event?.code, reason: event?.reason });
});

client.on("shardReconnecting", (shardId) => {
  logger.bot(`[shard:${shardId}:reconnecting]`);
});

client.on("shardResume", (shardId, replayedEvents) => {
  logger.bot(`[shard:${shardId}:resume] Reproduciendo ${replayedEvents} eventos`);
});

client.on("shardReady", (shardId) => {
  logger.bot(`[shard:${shardId}:ready]`);
});

// Debug (opcional)
if (process.env.DEBUG_DISCORD === "1") {
  client.on("debug", (info) => {
    if (info.includes("heartbeat") || info.includes("READY") || 
        info.includes("RESUMED") || info.includes("Session")) {
      logger.bot(`[client:debug] ${info}`);
    }
  });
}

// =================== INTERACTION CREATE (COMANDOS Y BOTONES) ===================
client.on("interactionCreate", async (interaction) => {
  // Manejar comandos slash
  if (interaction.isChatInputCommand()) {
    const command = commands.get(interaction.commandName);
    
    if (!command) {
      logger.warn(`Comando no encontrado: ${interaction.commandName}`);
      return interaction.reply({
        content: '❌ Comando no encontrado.',
        ephemeral: true
      }).catch(() => {});
    }
    
    logger.command(`Ejecutando comando: ${interaction.commandName}`, {
      user: interaction.user?.tag,
      guild: interaction.guild?.name
    });
    
    try {
      // Ejecutar comando con contexto completo
      await command.execute(interaction, client, globalContext);
    } catch (error) {
      logger.error(`Error ejecutando comando ${interaction.commandName}:`, error);
      
      const errorMsg = {
        content: '❌ Hubo un error al ejecutar este comando.',
        ephemeral: true
      };
      
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(errorMsg).catch(() => {});
      } else {
        await interaction.reply(errorMsg).catch(() => {});
      }
    }
  }
  
  // Manejar botones del panel Now Playing
  if (interaction.isButton()) {
    const customId = interaction.customId;
    
    // Solo manejar botones de música
    if (!customId.startsWith('music_')) {
      return;
    }
    
    logger.command('Botón presionado', {
      customId,
      user: interaction.user?.tag,
      guild: interaction.guild?.name
    });
    
    try {
      // Cargar handler de botones
      const buttonHandler = require('./handlers/button-handler');
      await buttonHandler.handleMusicButton(interaction, globalContext);
    } catch (error) {
      logger.error('Error manejando botón:', {
        customId,
        error: error.message
      });
      
      const errorMsg = { content: '❌ Error procesando el botón', ephemeral: true };
      
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply(errorMsg).catch(() => {});
      } else {
        await interaction.editReply(errorMsg).catch(() => {});
      }
    }
  }
});

// =================== FUNCIONES AUXILIARES ===================

/**
 * Registra comandos slash en Discord
 * @param {object} readyClient - Cliente de Discord ya conectado
 */
async function registerSlashCommands(readyClient) {
  const { REST } = require('@discordjs/rest');
  const { Routes } = require('discord-api-types/v10');
  
  const commandsData = [
    {
      name: "play",
      description: "Reproducir por URL o playlist (YouTube o Spotify)",
      options: [
        {
          name: "query",
          description: "URL a reproducir (o playlist de YouTube o Spotify)",
          type: 3,
          required: true,
        },
      ],
    },
    { name: "skip", description: "Saltar la canción actual" },
    { name: "pause", description: "Pausar reproducción" },
    { name: "resume", description: "Reanudar reproducción" },
    { name: "queue", description: "Mostrar la cola" },
    {
      name: "loop",
      description: "Controlar el bucle de la canción actual",
      options: [
        {
          name: "mode",
          description: "Seleccioná el modo",
          type: 3,
          required: true,
          choices: [
            { name: "TOGGLE", value: "toggle" },
            { name: "ON", value: "on" },
            { name: "OFF", value: "off" },
          ],
        },
      ],
    },
    {
      name: "remove",
      description: "Eliminar un elemento de la cola por índice",
      options: [
        {
          name: "index",
          description: "Índice en la cola (1..n)",
          type: 4,
          required: true,
        },
      ],
    },
    { name: "clear", description: "Limpiar la cola (mantiene la actual)" },
    { name: "nowplaying", description: "Mostrar lo que suena" },
    { name: "info", description: "Información técnica detallada de la canción actual" },
    { name: "stop", description: "Detener y desconectar" },
    {
      name: "volume",
      description: "Ajustar volumen (0-200)",
      options: [
        {
          name: "level",
          description: "Nivel de volumen en % (0-200)",
          type: 4,
          required: true,
        },
      ],
    },
    {
      name: "bass",
      description: "Refuerzo de bajos (OFF/LOW/MED/HIGH/EXTREME)",
      options: [
        {
          name: "preset",
          description: "Nivel de bass",
          type: 3,
          required: true,
          choices: [
            { name: "OFF", value: "off" },
            { name: "LOW", value: "low" },
            { name: "MED", value: "med" },
            { name: "HIGH", value: "high" },
            { name: "EXTREME", value: "extreme" },
          ],
        },
      ],
    },
    { name: "shuffle", description: "Activar/desactivar modo aleatorio" },
    {
      name: "seek",
      description: "Saltar a un tiempo específico",
      options: [
        {
          name: "seconds",
          description: "Segundos desde el inicio",
          type: 4,
          required: true,
        },
      ],
    },
    { name: "ping", description: "Ver latencia del bot" },
    { name: "stats", description: "Estadísticas del bot" },
  ];

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  try {
    logger.bot('Registrando comandos slash...');
    
    const clientId = readyClient?.user?.id || client.user?.id;
    if (!clientId) {
      throw new Error('Client ID no disponible');
    }
    
    await rest.put(
      Routes.applicationCommands(clientId),
      { body: commandsData }
    );
    
    logger.bot(`✓ ${commandsData.length} comandos registrados globalmente`);
  } catch (error) {
    logger.error('Error registrando comandos:', { error: error.message });
    throw error;
  }
}

/**
 * Sistema de health check interno
 */
function startHealthCheckSystem() {
  const { getVoiceConnection, VoiceConnectionStatus } = require('@discordjs/voice');
  
  setInterval(() => {
    try {
      if (!client.isReady()) {
        logger.warn('[healthcheck] ⚠️ Cliente NO está ready');
        return;
      }
      
      const wsStatus = client.ws.status;
      if (wsStatus !== 0) {
        logger.warn(`[healthcheck] ⚠️ WebSocket status: ${wsStatus}`);
      }
      
      let activeConnections = 0;
      let problematicConnections = 0;
      
      for (const [guildId, queue] of queues.entries()) {
        const conn = getVoiceConnection(guildId);
        if (conn) {
          activeConnections++;
          const state = conn.state.status;
          
          if (state === VoiceConnectionStatus.Disconnected || 
              state === VoiceConnectionStatus.Destroyed) {
            problematicConnections++;
            logger.warn(`[healthcheck] Conexión problemática en guild ${guildId}: ${state}`);
            
            if (state === VoiceConnectionStatus.Destroyed) {
              try {
                conn.destroy();
                queues.delete(guildId);
                logger.bot(`[healthcheck] ✓ Limpiada conexión destruida en guild ${guildId}`);
              } catch (e) {
                logger.error(`[healthcheck] Error limpiando guild ${guildId}:`, { error: e.message });
              }
            }
          }
        }
      }
      
      const mem = process.memoryUsage();
      const memMB = Math.round(mem.heapUsed / 1024 / 1024);
      
      if (activeConnections > 0 || problematicConnections > 0) {
        logger.bot(`[healthcheck] ✓ Bot activo | Guilds: ${client.guilds.cache.size} | ` +
                   `Voz: ${activeConnections} activas, ${problematicConnections} problemáticas | ` +
                   `Memoria: ${memMB}MB`);
      }
      
      if (memMB > 1024) {
        logger.warn(`[healthcheck] ⚠️ Uso de memoria alto: ${memMB}MB`);
        if (global.gc) {
          try {
            global.gc();
            logger.bot('[healthcheck] ✓ Garbage collection ejecutado');
          } catch (e) {
            logger.warn('[healthcheck] No se pudo ejecutar GC');
          }
        }
      }
      
    } catch (error) {
      logger.error('[healthcheck] Error:', { error: error.message });
    }
  }, 60000); // Cada 60 segundos
  
  logger.bot('[healthcheck] ✓ Sistema de monitoreo iniciado (cada 60s)');
}

// =================== GRACEFUL SHUTDOWN ===================
function gracefulShutdown(signal) {
  logger.bot(`[shutdown] Señal recibida: ${signal}`);
  
  try {
    const { getVoiceConnection } = require('@discordjs/voice');
    
    // Limpiar timeouts de idle
    for (const [guildId] of idleTimeouts) {
      clearTimeout(idleTimeouts.get(guildId));
      idleTimeouts.delete(guildId);
    }
    
    // Desconectar todas las conexiones de voz
    for (const [gid] of queues) {
      try {
        getVoiceConnection(gid)?.destroy();
      } catch {}
    }
  } catch {}
  
  try {
    client.destroy();
  } catch {}
  
  process.exit(0);
}

process.on("SIGTERM", () => {
  logger.bot('[shutdown] SIGTERM recibido');
  gracefulShutdown("SIGTERM");
  setTimeout(() => process.exit(0), 500);
});

process.on("SIGINT", () => {
  logger.bot('[shutdown] SIGINT recibido');
  gracefulShutdown("SIGINT");
  setTimeout(() => process.exit(0), 500);
});

// =================== INICIAR BOT ===================
logger.bot('🚀 Conectando a Discord...');

client.login(process.env.DISCORD_TOKEN)
  .then(() => {
    logger.bot('✓ Login exitoso');
  })
  .catch((error) => {
    logger.error('❌ Error al iniciar sesión:', { error: error.message });
    process.exit(1);
  });

// =================== EXPORTAR PARA USO EXTERNO ===================
module.exports = {
  client,
  queues,
  commands,
  METADATA_CACHE,
  PRELOAD_CACHE,
  USER_STATS,
  guildState,
  webStats
};
