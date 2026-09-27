/**
 * @file src/index.js
 * @description Punto de entrada principal del bot - Coordina la inicialización de todos los módulos
 */

// =================== MANEJADORES DE ERRORES GLOBALES ===================
// Importar el logger de Winston primero para manejar errores de forma segura
const logger = require('./utils/logger');

// Manejador de advertencias del proceso
process.on('warning', (warning) => {
  if (warning.name === 'MaxListenersExceededWarning') {
    logger.warn('[process:warning:listeners]', { message: warning.message });
  } else {
    logger.warn('[process:warning]', { name: warning.name, message: warning.message });
  }
});

// Manejador adicional para errores no capturados que Winston pueda no manejar
// especialmente errores de streams y eventos que pueden cerrar el proceso
process.on('uncaughtException', (error, origin) => {
  // Si es un error de Winston intentando escribir después de cerrar, solo logear en consola
  if (error.message && error.message.includes('write after end')) {
    console.error('[CRITICAL] Error de logging después de cerrar stream:', error.message);
    // NO terminar el proceso, solo continuar
    return;
  }
  
  // Para otros errores críticos, intentar logear
  try {
    logger.error('[CRITICAL] uncaughtException', {
      error: error.message,
      stack: error.stack,
      origin: origin
    });
  } catch (logError) {
    // Si falla el logger, al menos imprimir en consola
    console.error('[CRITICAL] uncaughtException:', error);
    console.error('Logger error:', logError);
  }
  
  // NO terminar el proceso para mantener el bot activo
  // Intentar recuperarse del error
});

// Manejador para promesas rechazadas no manejadas
process.on('unhandledRejection', (reason, promise) => {
  try {
    logger.error('[CRITICAL] unhandledRejection', {
      reason: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined
    });
  } catch (logError) {
    console.error('[CRITICAL] unhandledRejection:', reason);
    console.error('Logger error:', logError);
  }
});

// =================== CONFIGURACIÓN INICIAL ===================
process.env.YTDL_NO_UPDATE = "1";
require("dotenv").config({ quiet: true });

// Configurar ffmpeg: usar ffmpeg-static si está disponible
try {
  const fs = require('fs');
  const path = require('path');
  const ffmpeg = require('ffmpeg-static');
  
  // Ruta específica proporcionada por el usuario (WinGet)
  const wingetFfmpegPath = 'C:\\Users\\matia\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg.Essentials_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1-essentials_build\\bin\\ffmpeg.exe';
  const wingetBinDir = 'C:\\Users\\matia\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg.Essentials_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1-essentials_build\\bin';
  
  let finalFfmpegPath = 'ffmpeg';

  if (fs.existsSync(wingetFfmpegPath)) {
    finalFfmpegPath = wingetFfmpegPath;
    // Agregar el directorio al PATH para que otras librerías lo encuentren
    process.env.PATH = `${wingetBinDir}${path.delimiter}${process.env.PATH}`;
    logger.info(`[ffmpeg] Configurado usando ruta WinGet y agregado al PATH: ${wingetFfmpegPath}`);
  } else if (ffmpeg) {
    finalFfmpegPath = ffmpeg;
    const ffmpegDir = path.dirname(ffmpeg);
    process.env.PATH = `${ffmpegDir}${path.delimiter}${process.env.PATH}`;
    logger.info(`[ffmpeg] Configurado usando ffmpeg-static y agregado al PATH: ${ffmpeg}`);
  } else {
    logger.info("[ffmpeg] Configurado para usar ffmpeg del sistema (fallback)");
  }
  
  process.env.FFMPEG_PATH = finalFfmpegPath;
} catch (err) {
  process.env.FFMPEG_PATH = 'ffmpeg';
  logger.warn("[ffmpeg] Error cargando ffmpeg, usando fallback del sistema", { error: err.message });
}

// =================== IMPORTAR MÓDULOS ===================
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
const { playNext, createResourceFromUrl } = require('./handlers/player');
const { spawnSync } = require('child_process');

function getYtDlpBinaryPath() {
  try {
    const manualPath = resolveManualYtDlpPath();
    if (manualPath) {
      return manualPath;
    }

    // Intentar yt-dlp
    const testYtDlp = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['yt-dlp']);
    if (testYtDlp.status === 0) {
      const ytdlpPath = testYtDlp.stdout.toString().trim().split('\n')[0];
      return ytdlpPath || 'yt-dlp';
    }
    
    // Fallback a youtube-dl
    const testYtDl = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['youtube-dl']);
    if (testYtDl.status === 0) {
      const ytdlPath = testYtDl.stdout.toString().trim().split('\n')[0];
      return ytdlPath || 'youtube-dl';
    }
    
    return null;
  } catch {
    return null;
  }
}

function resolveManualYtDlpPath() {
  const candidates = [
    process.env.YT_DLP_PATH,
    process.env.YTDLP_PATH,
    process.env.YTDLP_EXECUTABLE,
    process.env.YTDLP_BINARY,
    // Agregar ruta de descargas como fallback común en Windows
    process.platform === 'win32' ? `C:\\Users\\${process.env.USERNAME}\\Downloads\\yt-dlp.exe` : null,
    'C:\\Users\\matia\\Downloads\\yt-dlp.exe'
  ].filter(Boolean);

  for (const candidate of candidates) {
    const trimmed = candidate.trim().replace(/^"|"$/g, '').replace(/^'|'$/g, '');
    if (!trimmed) continue;
    const resolved = require('fs').existsSync(trimmed) ? trimmed : null;
    if (resolved) {
      return resolved;
    }
    // Si no tiene separadores de ruta, asumimos que es un comando global y dejamos que spawn lo intente
    if (!trimmed.includes('\\') && !trimmed.includes('/')) {
      return trimmed;
    }
  }
  return null;
}

// =================== INICIALIZACIÓN ===================
logger.bot('[BOT] Iniciando bot de música...');

// Cargar comandos
logger.bot('Cargando comandos...');
const commands = loadCommands();
logger.bot(`[OK] ${commands.size} comandos cargados`);

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

logger.bot('[OK] Estado inicializado');

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
  
  // Funciones de reproducción
  playNext: (guildId) => playNext(guildId, queues, globalContext),
  createResourceFromUrl: createResourceFromUrl,
  
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
logger.bot('[OK] Handler de reproducción configurado');

// =================== SERVIDOR WEB ===================
const { app, server, io, startWebServer } = createWebServer({
  client,
  queues,
  METADATA_CACHE,
  PRELOAD_CACHE,
  USER_STATS
});

logger.bot('[OK] Servidor web configurado');

// HTTP YA: Render exige 0.0.0.0:$PORT abierto antes del health check del deploy.
// No esperar a clientReady (Discord puede tardar y el deploy falla por "puertos").
try {
  startWebServer();
} catch (error) {
  logger.error('Error iniciando servidor web:', { error: error.message });
  process.exit(1);
}

// =================== EVENT HANDLERS DEL BOT ===================

// Ready event
client.once("clientReady", async (c) => {
  logger.bot(`[CONNECTED] Conectado como ${c.user?.tag || c.user?.id}`);
  
  // Registrar comandos slash (pasar el cliente ready)
  try {
    await registerSlashCommands(c);
    logger.bot('[OK] Comandos slash registrados');
  } catch (error) {
    logger.error('Error registrando comandos slash:', { error: error.message });
  }
  
  // Iniciar sistema de health check interno
  startHealthCheckSystem();
});

// Error handlers
client.on("error", (error) => {
  logger.error('[client:error]', { error: error.message, stack: error.stack });
});

client.on("warn", (info) => {
  logger.warn('[client:warn]', { info });
});

client.on("shardError", (error, shardId) => {
  logger.error(`[shard:${shardId}:error]`, { error: error.message, stack: error.stack });
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
    
    logger.bot(`[OK] ${commandsData.length} comandos registrados globalmente`);
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
                logger.bot(`[healthcheck] [OK] Limpiada conexión destruida en guild ${guildId}`);
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
        logger.bot(`[healthcheck] [OK] Bot activo | Guilds: ${client.guilds.cache.size} | ` +
                   `Voz: ${activeConnections} activas, ${problematicConnections} problemáticas | ` +
                   `Memoria: ${memMB}MB`);
      }
      
      if (memMB > 1024) {
        logger.warn(`[healthcheck] ⚠️ Uso de memoria alto: ${memMB}MB`);
        if (global.gc) {
          try {
            global.gc();
            logger.bot('[healthcheck] [OK] Garbage collection ejecutado');
          } catch (e) {
            logger.warn('[healthcheck] No se pudo ejecutar GC');
          }
        }
      }
      
    } catch (error) {
      logger.error('[healthcheck] Error:', { error: error.message });
    }
  }, 60000); // Cada 60 segundos
  
  logger.bot('[healthcheck] [OK] Sistema de monitoreo iniciado (cada 60s)');
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

logger.info("[yt-dlp] Verificando actualizaciones...");
const ytdlpPath = getYtDlpBinaryPath();
if (ytdlpPath) {
  logger.info(`[yt-dlp] Usando binario para actualización: ${ytdlpPath}`);
  try {
    const result = spawnSync(ytdlpPath, ["--update"], { encoding: "utf8" });
    if (result.status === 0) {
      const output = (result.stdout || "") + (result.stderr || "");
      if (output.includes("up to date")) {
        logger.info("[yt-dlp] Ya está actualizado.");
      } else if (output.includes("Updated")) {
        logger.info("[yt-dlp] Actualizado exitosamente.");
      } else {
        logger.info("[yt-dlp] Verificación completada.");
      }
    } else {
      logger.warn("[yt-dlp] Error al actualizar yt-dlp.");
    }
  } catch (error) {
    logger.warn("[yt-dlp] No se pudo ejecutar yt-dlp --update:", error.message);
  }
} else {
  logger.warn("[yt-dlp] No se encontró el binario de yt-dlp.");
}

// =================== INICIAR BOT ===================
logger.bot('[CONNECT] Conectando a Discord...');

client.login(process.env.DISCORD_TOKEN)
  .then(() => {
    logger.bot('[OK] Login exitoso');
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
