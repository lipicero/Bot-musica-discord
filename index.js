process.on('uncaughtException', (err) => {
  const fs = require('fs');
  const logPath = require('path').join(__dirname, 'logs', 'bot.err.log');
  fs.appendFileSync(logPath, `\n[uncaughtException] ${err.stack || err}`);
  console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', (reason, promise) => {
  const fs = require('fs');
  const logPath = require('path').join(__dirname, 'logs', 'bot.err.log');
  fs.appendFileSync(logPath, `\n[unhandledRejection] ${reason}`);
  console.error('[unhandledRejection]', reason);
});
process.env.YTDL_NO_UPDATE = "1"; // desactiva chequeo de updates de ytdl-core
require("dotenv").config({ quiet: true });
const logger = require('./src/utils/logger');

// Intentar configurar ffmpeg estático para demux/transcode cuando sea necesario
try {
  const ffmpegPath = require("ffmpeg-static");
  if (ffmpegPath) {
    process.env.FFMPEG_PATH = ffmpegPath;
    logger.info("[ffmpeg] ffmpeg-static configurado");
  }
} catch (_) {
  logger.warn("[ffmpeg] ffmpeg-static no instalado; se intentará sin FFmpeg");
}
const DEBUG_AUDIO = process.env.DEBUG_AUDIO === "1";

// =================== CONFIGURACIÓN AVANZADA DE CALIDAD ===================
const PREFER_WEBM_OPUS = process.env.PREFER_WEBM_OPUS === "1";
const FORCE_BEST_AUDIO = process.env.FORCE_BEST_AUDIO === "1";
const AUDIO_BUFFER_SIZE = Math.max(16, Math.min(64, Number(process.env.AUDIO_BUFFER_SIZE || 32)));
const FFMPEG_OPTIMIZE_AUDIO = process.env.FFMPEG_OPTIMIZE_AUDIO === "1";
const HIGH_WATER_MARK = 1 << (AUDIO_BUFFER_SIZE > 32 ? 26 : 25); // Buffer más grande para mejor calidad

// =================== CONFIGURACIÓN DE VELOCIDAD ===================
const ENABLE_PRELOAD = process.env.ENABLE_PRELOAD !== "0"; // Habilitado por defecto
const PRELOAD_AHEAD = Math.max(1, Math.min(5, Number(process.env.PRELOAD_AHEAD || 2)));
const YT_PARALLEL_DOWNLOADS = Math.max(1, Math.min(5, Number(process.env.YT_PARALLEL_DOWNLOADS || 3)));
const YT_DOWNLOAD_TIMEOUT = Math.max(30, Math.min(120, Number(process.env.YT_DOWNLOAD_TIMEOUT || 60))) * 1000;
const YT_AGGRESSIVE_CACHE = process.env.YT_AGGRESSIVE_CACHE === "1";

if (DEBUG_AUDIO) {
  logger.info(`[config] PREFER_WEBM_OPUS: ${PREFER_WEBM_OPUS}`);
  logger.info(`[config] FORCE_BEST_AUDIO: ${FORCE_BEST_AUDIO}`);
  logger.info(`[config] AUDIO_BUFFER_SIZE: ${AUDIO_BUFFER_SIZE}MB`);
  logger.info(`[config] HIGH_WATER_MARK: ${HIGH_WATER_MARK}`);
  logger.info(`[config] FFMPEG_OPTIMIZE_AUDIO: ${FFMPEG_OPTIMIZE_AUDIO}`);
  logger.info(`[config] OPUS_BITRATE: ${process.env.OPUS_BITRATE || 160}kbps`);
  logger.info(`[config] ENABLE_PRELOAD: ${ENABLE_PRELOAD}`);
  logger.info(`[config] PRELOAD_AHEAD: ${PRELOAD_AHEAD} canciones`);
  logger.info(`[config] YT_PARALLEL_DOWNLOADS: ${YT_PARALLEL_DOWNLOADS} conexiones`);
  logger.info(`[config] YT_DOWNLOAD_TIMEOUT: ${YT_DOWNLOAD_TIMEOUT/1000}s`);
}

// Cache global para optimizaciones
let G_YTDLP_PATH_CACHE = null; // memo para getYtDlpBinaryPath()
const G_COOKIE_CACHE = { path: null, lastHash: null, wrote: false }; // memo para ensureYtDlpCookiesFileFromEnv()
let G_YTDLP_SUPPORTS_NO_SLEEP = undefined; // cache de soporte para --no-sleep-requests

// =================== SISTEMA DE CACHE AVANZADO ===================
const METADATA_CACHE = new Map(); // Cache de metadatos {url: {title, duration, thumbnail, quality, etc}}
const PRELOAD_CACHE = new Map(); // Cache de recursos precargados {url: audioResource}
const USER_STATS = new Map(); // Estadísticas por usuario {userId: {listenTime, songsPlayed, favorites}}
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 horas para cache de metadatos
const MAX_CACHE_SIZE = 1000; // Máximo de elementos en cache
const MAX_PRELOAD_SIZE = 3; // Máximo de canciones precargadas por servidor
const MAX_PLAYLIST_ITEMS = Math.max(
  1,
  Math.min(100, Number(process.env.MAX_PLAYLIST_ITEMS || 25))
);
const MAX_QUEUE_LENGTH = Math.max(
  1,
  Math.min(500, Number(process.env.MAX_QUEUE_LENGTH || 200))
);
// Bass boost (por defecto desactivado). Puedes ajustar frecuencia/ancho por env
const DEFAULT_BASS_FREQ = Number(process.env.BASS_FREQ || 110); // Hz
const DEFAULT_BASS_WIDTH = Number(process.env.BASS_WIDTH || 0.8); // ancho/slope
const SEEK_STEP_SECONDS = Math.max(5, Math.min(30, Number(process.env.SEEK_STEP_SECONDS || 10))); // Paso de seek configurable
const REQUIRE_SAME_VC = String(process.env.REQUIRE_SAME_VC || "1") === "1";
// UI: fijar panel y respuestas efímeras por defecto
const PIN_PANEL = String(process.env.PIN_PANEL || "1") === "1"; // fija el mensaje del panel si es posible
const EPHEMERAL_SLASH = String(process.env.EPHEMERAL_SLASH || "1") === "1"; // hace respuestas de slash efímeras
// Timeout de inactividad: tiempo en minutos antes de desconectarse cuando no hay música (0 = nunca desconectar)
const IDLE_TIMEOUT_MINUTES = Math.max(0, Number(process.env.IDLE_TIMEOUT_MINUTES || 10));
// Streaming: usar URL directa en ffmpeg (true) o pipe estable (false). Por defecto: false en Windows, true en otros.
const FFMPEG_DIRECT_URL = (() => {
  if (process.env.FFMPEG_DIRECT_URL != null) return String(process.env.FFMPEG_DIRECT_URL) === "1";
  return process.platform !== "win32"; // Windows: usar pipe por defecto para evitar errores TLS (-138)
})();
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  Client,
  GatewayIntentBits,
  PermissionsBitField,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  getVoiceConnection,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  entersState,
  StreamType,
} = require("@discordjs/voice");
const playdl = require("play-dl");
const ytdl = require("@distube/ytdl-core");
let ytdlp = null;
try {
  ytdlp = require("yt-dlp-exec");
} catch {}
const { spawn, spawnSync } = require("child_process");

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
    process.env.YTDLP_BINARY
  ].filter(Boolean);

  for (const candidate of candidates) {
    const trimmed = candidate.trim().replace(/^"|"$/g, '').replace(/^'|'$/g, '');
    if (!trimmed) continue;
    const resolved = fs.existsSync(trimmed) ? trimmed : null;
    if (resolved) {
      return resolved;
    }
    // Si no existe físicamente, devolver el valor para que el spawn intente resolverlo
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}

function cleanupOldLogs() {
  const logsDir = path.join(__dirname, 'logs');
  if (!fs.existsSync(logsDir)) return;

  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000; // 24 horas

  fs.readdir(logsDir, (err, files) => {
    if (err) {
      console.error('[cleanup] Error leyendo logs:', err);
      return;
    }

    files.forEach(file => {
      const filePath = path.join(logsDir, file);
      fs.stat(filePath, (err, stats) => {
        if (err) return;
        if (now - stats.mtime.getTime() > maxAge) {
          fs.unlink(filePath, err => {
            if (err) console.error('[cleanup] Error borrando log:', file, err);
            else console.log('[cleanup] Log borrado:', file);
          });
        }
      });
    });
  });
}

// =================== SERVIDOR WEB PARA DASHBOARD ===================
const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");
const helmet = require("helmet");

// ======================
// Cliente Discord e Intents (slash-only)
// ======================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// ======================
// Persistencia unificada por servidor (state.json)
// Estructura: { [guildId]: { volume: number (0..2), loop: boolean, bassGainDb: number } }
// Migra desde volumes.json y bass.json si existen.
// ======================
function loadState() {
  const cwd = process.cwd();
  const statePath = path.join(cwd, "state.json");
  let state = {};
  try {
    if (fs.existsSync(statePath)) {
      const j = JSON.parse(fs.readFileSync(statePath, "utf8"));
      if (j && typeof j === "object") state = j;
    }
  } catch {}
  // Migrar desde archivos antiguos si faltan datos
  try {
    const volPath = path.join(cwd, "volumes.json");
    if (fs.existsSync(volPath)) {
      const vols = JSON.parse(fs.readFileSync(volPath, "utf8")) || {};
      for (const [gid, vol] of Object.entries(vols)) {
        state[gid] = state[gid] || {};
        if (typeof state[gid].volume !== "number") {
          state[gid].volume = Math.max(0, Math.min(2, Number(vol) || 1));
        }
      }
    }
  } catch {}
  try {
    const bassPath = path.join(cwd, "bass.json");
    if (fs.existsSync(bassPath)) {
      const bass = JSON.parse(fs.readFileSync(bassPath, "utf8")) || {};
      for (const [gid, g] of Object.entries(bass)) {
        const val = Math.max(0, Math.min(24, Number(g) || 0));
        state[gid] = state[gid] || {};
        if (typeof state[gid].bassGainDb !== "number") {
          state[gid].bassGainDb = val;
        }
      }
    }
  } catch {}
  return state;
}
function saveState(obj) {
  try {
    const p = path.join(process.cwd(), "state.json");
    fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
  } catch (e) {
    console.warn("[state:save:error]", e?.message || e);
  }
  // Opcional: mantener archivos antiguos en sync por compatibilidad
  try {
    const vols = {};
    const bass = {};
    const shuffle = {};
    for (const [gid, st] of Object.entries(obj || {})) {
      if (typeof st.volume === "number") vols[gid] = st.volume;
      if (typeof st.bassGainDb === "number") bass[gid] = st.bassGainDb;
      if (typeof st.shuffleMode === "boolean") shuffle[gid] = st.shuffleMode;
    }
    fs.writeFileSync(path.join(process.cwd(), "volumes.json"), JSON.stringify(vols, null, 2), "utf8");
    fs.writeFileSync(path.join(process.cwd(), "bass.json"), JSON.stringify(bass, null, 2), "utf8");
    fs.writeFileSync(path.join(process.cwd(), "shuffle.json"), JSON.stringify(shuffle, null, 2), "utf8");
  } catch {}
}
const guildState = loadState();

// =================== SISTEMA DE TIMEOUT PARA IDLE ===================
const idleTimeouts = new Map(); // {guildId: timeoutId} - para manejar timeouts de desconexión

// Función para limpiar timeout de idle
function clearIdleTimeout(guildId) {
  const timeoutId = idleTimeouts.get(guildId);
  if (timeoutId) {
    clearTimeout(timeoutId);
    idleTimeouts.delete(guildId);
  }
}

// Función para configurar timeout de idle
function setIdleTimeout(guildId) {
  // Limpiar timeout existente
  clearIdleTimeout(guildId);
  
  // Solo configurar timeout si está habilitado
  if (IDLE_TIMEOUT_MINUTES <= 0) return;
  
  const timeoutMs = IDLE_TIMEOUT_MINUTES * 60 * 1000;
  console.log(`[idle] Configurando timeout de ${IDLE_TIMEOUT_MINUTES} minutos para servidor ${guildId}`);
  
  const timeoutId = setTimeout(() => {
    console.log(`[idle] Timeout de inactividad alcanzado para servidor ${guildId}, desconectando...`);
    try {
      const connection = getVoiceConnection(guildId);
      if (connection) {
        connection.destroy();
        queues.delete(guildId);
        cleanupMemory(guildId);
        clearNowPlaying(guildId).catch(() => {});
        stopNowPlayingTicker(guildId).catch(() => {});
      }
    } catch (error) {
      console.error(`[idle] Error al desconectar por timeout:`, error?.message);
    }
    // Limpiar el timeout del mapa
    idleTimeouts.delete(guildId);
  }, timeoutMs);
  
  idleTimeouts.set(guildId, timeoutId);
}

// =================== FUNCIONES DE CACHE Y OPTIMIZACIÓN ===================
function cleanupExpiredCache() {
  const now = Date.now();
  for (const [key, data] of METADATA_CACHE.entries()) {
    if (now - data.timestamp > CACHE_TTL) {
      METADATA_CACHE.delete(key);
    }
  }
  // Limitar tamaño del cache
  if (METADATA_CACHE.size > MAX_CACHE_SIZE) {
    const entries = Array.from(METADATA_CACHE.entries());
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
    for (let i = 0; i < entries.length - MAX_CACHE_SIZE; i++) {
      METADATA_CACHE.delete(entries[i][0]);
    }
  }
}

function getCachedMetadata(url) {
  const cached = METADATA_CACHE.get(url);
  if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
    return cached.data;
  }
  return null;
}

function setCachedMetadata(url, metadata) {
  METADATA_CACHE.set(url, {
    data: metadata,
    timestamp: Date.now()
  });
  // Cleanup periódico cada 100 inserciones
  if (METADATA_CACHE.size % 100 === 0) {
    cleanupExpiredCache();
  }
}

// ================== FUNCIÓN PARA ACTUALIZAR CALIDAD EN TIEMPO REAL ==================
function updateMetadataQuality(url, format) {
  try {
    const cached = METADATA_CACHE.get(url);
    if (cached && format) {
      let qualityInfo = cached.quality || "Unknown";
      
      // Obtener información de calidad del formato seleccionado
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
      
      // Actualizar cache con la nueva información
      cached.quality = qualityInfo;
      METADATA_CACHE.set(url, cached);
      
      if (DEBUG_AUDIO) console.log(`[metadata] Actualizada calidad para ${url}: ${qualityInfo}`);
    }
  } catch (error) {
    console.warn(`[metadata] Error actualizando calidad:`, error?.message);
  }
}

function getHighQualityThumbnail(basicInfo) {
  try {
    const thumbnails = basicInfo?.videoDetails?.thumbnails || basicInfo?.thumbnails;
    if (!thumbnails || !Array.isArray(thumbnails)) return null;
    
    // Buscar la mejor calidad disponible
    const sorted = thumbnails.sort((a, b) => (b.width * b.height) - (a.width * a.height));
    return sorted[0]?.url || null;
  } catch {
    return null;
  }
}

function formatDurationDisplay(seconds) {
  if (!seconds || seconds === 0) return "🔴 LIVE";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Función para obtener metadatos con cache
async function getEnhancedMetadata(url) {
  try {
    // Intentar obtener del cache primero
    const cached = getCachedMetadata(url);
    if (cached) {
      return cached;
    }

    let basicInfo = null;
    let title = "Desconocido";
    let duration = 0;
    let thumbnail = null;
    let quality = "desconocida";
    let views = null;

    // Intentar obtener info con yt-dlp primero (más confiable)
    if (ytdlp) {
      try {
        const info = await ytdlp(url, {
          dumpSingleJson: true,
          noPlaylist: true,
          noCheckCertificates: true,
          preferFreeFormats: true,
          youtubeSkipDashManifest: true,
          listFormats: false, // Para obtener información de formato
        });
        
        if (info) {
          title = info.title || title;
          duration = Math.floor(info.duration || 0);
          thumbnail = getHighQualityThumbnail(info) || info.thumbnail;
          views = info.view_count;
          
          // MEJORAR DETECCIÓN DE CALIDAD CON YT-DLP
          let qualityDetected = false;
          
          // 1. Intentar obtener desde formatos disponibles (más preciso)
          if (info.formats && Array.isArray(info.formats)) {
            // Buscar el mejor formato de audio
            const audioFormats = info.formats.filter(f => 
              f.acodec && f.acodec !== 'none' && !f.vcodec || f.vcodec === 'none'
            ).sort((a, b) => (b.abr || 0) - (a.abr || 0));
            
            if (audioFormats.length > 0) {
              const bestAudio = audioFormats[0];
              if (bestAudio.abr) {
                quality = `${bestAudio.abr}kbps`;
                qualityDetected = true;
                if (DEBUG_AUDIO) console.log(`[metadata:yt-dlp] Calidad desde formato audio: ${quality} (codec: ${bestAudio.acodec})`);
              } else if (bestAudio.tbr) {
                quality = `${bestAudio.tbr}kbps`;
                qualityDetected = true;
                if (DEBUG_AUDIO) console.log(`[metadata:yt-dlp] Calidad desde total bitrate: ${quality}`);
              }
            }
          }
          
          // 2. Fallback a propiedades directas
          if (!qualityDetected) {
            if (info.abr) {
              quality = `${info.abr}kbps`;
              qualityDetected = true;
              if (DEBUG_AUDIO) console.log(`[metadata:yt-dlp] Calidad desde ABR directo: ${quality}`);
            } else if (info.tbr) {
              quality = `${info.tbr}kbps`;
              qualityDetected = true;
              if (DEBUG_AUDIO) console.log(`[metadata:yt-dlp] Calidad desde TBR: ${quality}`);
            }
          }
          
          // 3. Información cualitativa si no hay bitrate
          if (!qualityDetected) {
            if (info.format_note) {
              quality = info.format_note;
              qualityDetected = true;
              if (DEBUG_AUDIO) console.log(`[metadata:yt-dlp] Calidad cualitativa: ${quality}`);
            } else if (info.acodec && info.acodec !== 'none') {
              quality = info.acodec;
              qualityDetected = true;
              if (DEBUG_AUDIO) console.log(`[metadata:yt-dlp] Calidad desde codec: ${quality}`);
            }
          }
          
          if (!qualityDetected) {
            quality = "128kbps (estimado)";
            if (DEBUG_AUDIO) console.log(`[metadata:yt-dlp] No se pudo determinar calidad, usando estimado`);
          }
        }
      } catch (ytdlpErr) {
        console.warn("[metadata:yt-dlp] Fallback to ytdl-core:", ytdlpErr?.message);
      }
    }

    // Fallback a ytdl-core si yt-dlp falla o no obtuvimos calidad
    if ((!basicInfo && title === "Desconocido") || quality === "desconocida") {
      try {
        basicInfo = await ytdl.getBasicInfo(url);
        if (basicInfo?.videoDetails) {
          if (title === "Desconocido") {
            title = basicInfo.videoDetails.title || title;
            duration = parseInt(basicInfo.videoDetails.lengthSeconds) || duration;
            thumbnail = getHighQualityThumbnail(basicInfo) || thumbnail;
            views = parseInt(basicInfo.videoDetails.viewCount) || views;
          }
          
          // Intentar obtener calidad de audio mejorado
          if (quality === "desconocida" || quality === "128kbps (estimado)") {
            try {
              let qualityFound = false;
              
              // Obtener todos los formatos de audio disponibles
              if (basicInfo.formats && Array.isArray(basicInfo.formats)) {
                const audioFormats = basicInfo.formats
                  .filter(format => format.hasAudio && (!format.hasVideo || format.audioOnly))
                  .sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0));
                
                if (audioFormats.length > 0) {
                  const bestFormat = audioFormats[0];
                  if (bestFormat.audioBitrate) {
                    quality = `${bestFormat.audioBitrate}kbps`;
                    qualityFound = true;
                    if (DEBUG_AUDIO) console.log(`[metadata:ytdl-core] Calidad desde formato: ${quality} (${bestFormat.audioCodec || 'unknown codec'})`);
                  } else if (bestFormat.audioQuality) {
                    quality = bestFormat.audioQuality;
                    qualityFound = true;
                    if (DEBUG_AUDIO) console.log(`[metadata:ytdl-core] Calidad cualitativa: ${quality}`);
                  } else if (bestFormat.itag) {
                    // Mapear itags conocidos a calidades
                    const itagQualityMap = {
                      140: '128kbps', // m4a 128kbps
                      141: '256kbps', // m4a 256kbps  
                      171: '128kbps', // webm 128kbps
                      249: '50kbps',  // webm opus 50kbps
                      250: '70kbps',  // webm opus 70kbps
                      251: '160kbps', // webm opus 160kbps
                    };
                    if (itagQualityMap[bestFormat.itag]) {
                      quality = itagQualityMap[bestFormat.itag];
                      qualityFound = true;
                      if (DEBUG_AUDIO) console.log(`[metadata:ytdl-core] Calidad desde itag ${bestFormat.itag}: ${quality}`);
                    }
                  }
                }
              }
              
              if (!qualityFound) {
                quality = "128kbps (estimado)";
                if (DEBUG_AUDIO) console.log(`[metadata:ytdl-core] No se pudo determinar calidad, usando estimado`);
              }
              
            } catch (formatErr) {
              if (DEBUG_AUDIO) console.warn(`[metadata:ytdl-core] Error obteniendo formato:`, formatErr?.message);
              quality = "128kbps (estimado)";
            }
          }
        }
      } catch (ytdlErr) {
        console.warn("[metadata:ytdl-core]", ytdlErr?.message);
        if (quality === "desconocida") {
          quality = "128kbps (estimado)";
        }
      }
    }

    // Asegurar que siempre tengamos una calidad
    if (quality === "desconocida") {
      quality = "128kbps (estimado)";
    }

    const metadata = {
      title,
      duration,
      thumbnail,
      quality,
      views,
      url,
      durationDisplay: formatDurationDisplay(duration)
    };

    // Debug: mostrar metadatos finales
    if (DEBUG_AUDIO) {
      console.log(`[metadata:final] URL: ${url}`);
      console.log(`[metadata:final] Quality: ${quality}`);
      console.log(`[metadata:final] Complete metadata:`, metadata);
    }

    // Guardar en cache
    setCachedMetadata(url, metadata);
    return metadata;

  } catch (error) {
    console.error("[metadata:error]", error?.message || error);
    return {
      title: "Error al cargar",
      duration: 0,
      thumbnail: null,
      quality: "Unknown",
      views: null,
      url,
      durationDisplay: "0:00"
    };
  }
}

// =================== SISTEMA DE PRECARGA OPTIMIZADO ===================
async function preloadNextSong(guildId) {
  if (!ENABLE_PRELOAD) return;
  
  try {
    const q = queues.get(guildId);
    if (!q || !q.songs || q.songs.length < 2) return;

    let songsToPreload = [];
    
    if (q.shuffleMode && q.songs.length > 1) {
      // Modo shuffle: precargar canciones aleatorias de las restantes
      const remainingSongs = q.songs.slice(1);
      const numToPreload = Math.min(PRELOAD_AHEAD, remainingSongs.length);
      
      // Crear una copia y seleccionar aleatoriamente
      const shuffledRemaining = [...remainingSongs];
      for (let i = shuffledRemaining.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffledRemaining[i], shuffledRemaining[j]] = [shuffledRemaining[j], shuffledRemaining[i]];
      }
      
      songsToPreload = shuffledRemaining.slice(0, numToPreload);
      if (DEBUG_AUDIO) console.log(`[preload] 🔀 Modo shuffle: precargando ${songsToPreload.length} canciones aleatorias`);
    } else {
      // Modo normal: precargar siguientes canciones en orden
      songsToPreload = q.songs.slice(1, 1 + PRELOAD_AHEAD);
      if (DEBUG_AUDIO) console.log(`[preload] 📝 Modo normal: precargando ${songsToPreload.length} canciones en orden`);
    }
    
    for (const [index, song] of songsToPreload.entries()) {
      const cacheKey = `${guildId}_${song.url}`;
      
      // Saltar si ya está precargada
      if (PRELOAD_CACHE.has(cacheKey)) continue;
      
      // Limitar cantidad de precarga total por memoria
      if (PRELOAD_CACHE.size >= MAX_PRELOAD_SIZE * 2) {
        // Limpiar cache más viejo
        cleanupPreloadCache();
      }

      // Precargar en paralelo con prioridad (siguiente canción = más prioridad)
      const priority = index + 1;
      preloadSongInBackground(guildId, song, priority);
    }
  } catch (error) {
    console.warn(`[preload] Error en precarga automática:`, error?.message);
  }
}

async function preloadSongInBackground(guildId, song, priority = 1) {
  const cacheKey = `${guildId}_${song.url}`;
  
  try {
    if (DEBUG_AUDIO) console.log(`[preload] Iniciando precarga (prioridad ${priority}): ${song.title}`);
    
    // Obtener metadatos primero (rápido)
    const metadata = await getEnhancedMetadata(song.url);
    
    // Crear recurso con timeout ajustable
    const q = queues.get(guildId);
    const resource = await Promise.race([
      createResourceFromUrl(song.url, q?.volume ?? 1.0, {
        bassGainDb: q?.bassGainDb,
        bassFreq: DEFAULT_BASS_FREQ,
        bassWidth: DEFAULT_BASS_WIDTH,
      }),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Timeout en precarga')), YT_DOWNLOAD_TIMEOUT)
      )
    ]);

    // Guardar en cache con información adicional
    PRELOAD_CACHE.set(cacheKey, {
      resource,
      metadata,
      timestamp: Date.now(),
      guildId,
      priority,
      song
    });

    if (DEBUG_AUDIO) console.log(`[preload] ✅ Precargada: ${song.title} (${Math.floor(metadata.duration || 0)}s)`);

    // Limpiar cache automáticamente (10 minutos para prioridad 1, 5 para otros)
    const cacheTime = priority === 1 ? 600000 : 300000;
    setTimeout(() => {
      PRELOAD_CACHE.delete(cacheKey);
      if (DEBUG_AUDIO) console.log(`[preload] 🗑️ Limpiada precarga expirada: ${song.title}`);
    }, cacheTime);

  } catch (error) {
    if (DEBUG_AUDIO) console.warn(`[preload] ❌ Error precargando ${song.title}:`, error?.message);
  }
}

function getPreloadedResource(guildId, url) {
  const key = `${guildId}_${url}`;
  const cached = PRELOAD_CACHE.get(key);
  if (cached && (Date.now() - cached.timestamp < 600000)) { // 10 min TTL extendido
    PRELOAD_CACHE.delete(key); // Usar una sola vez
    if (DEBUG_AUDIO) console.log(`[preload] ✅ Usando recurso precargado: ${cached.song?.title || 'desconocido'}`);
    return cached.resource;
  }
  return null;
}

function cleanupPreloadCache() {
  try {
    const now = Date.now();
    let cleaned = 0;
    
    // Limpiar por antigüedad y prioridad
    const entries = Array.from(PRELOAD_CACHE.entries());
    
    // Ordenar por antigüedad y prioridad (mantener prioridad 1 más tiempo)
    entries.sort(([,a], [,b]) => {
      if (a.priority !== b.priority) return b.priority - a.priority; // Prioridad más alta primero
      return a.timestamp - b.timestamp; // Más viejo primero
    });
    
    // Limpiar los más viejos si hay demasiados
    while (PRELOAD_CACHE.size > MAX_PRELOAD_SIZE && entries.length > 0) {
      const [key, data] = entries.shift();
      const age = now - data.timestamp;
      const maxAge = data.priority === 1 ? 600000 : 300000; // 10min vs 5min
      
      if (age > maxAge || PRELOAD_CACHE.size > MAX_PRELOAD_SIZE * 1.5) {
        PRELOAD_CACHE.delete(key);
        cleaned++;
        if (DEBUG_AUDIO) console.log(`[preload] 🧹 Limpiada precarga antigua: ${data.song?.title || 'desconocido'}`);
      }
    }
    
    if (cleaned > 0 && DEBUG_AUDIO) {
      console.log(`[preload] Limpiadas ${cleaned} precargas. Cache actual: ${PRELOAD_CACHE.size}`);
    }
    
    return cleaned;
  } catch (error) {
    console.warn("[preload:cleanup:error]", error?.message);
    return 0;
  }
}

function cleanupMemory(guildId = null) {
  try {
    // Limpiar preload cache expirado
    const now = Date.now();
    for (const [key, data] of PRELOAD_CACHE.entries()) {
      if (now - data.timestamp > 300000) { // 5 minutos
        PRELOAD_CACHE.delete(key);
      }
    }

    // Limpiar cache específico de un servidor si se especifica
    if (guildId) {
      for (const [key] of PRELOAD_CACHE.entries()) {
        if (key.startsWith(guildId)) {
          PRELOAD_CACHE.delete(key);
        }
      }
    }

    // Force garbage collection si está disponible
    if (global.gc) {
      global.gc();
    }
  } catch (error) {
    console.warn("[cleanup:error]", error?.message);
  }
}

// =================== ESTADÍSTICAS DE USUARIO ===================
function updateUserStats(userId, guildId, action, data = {}) {
  try {
    const key = `${guildId}_${userId}`;
    if (!USER_STATS.has(key)) {
      USER_STATS.set(key, {
        userId,
        guildId,
        songsPlayed: 0,
        totalListenTime: 0,
        favorites: [],
        lastActivity: Date.now(),
        sessionStart: Date.now()
      });
    }

    const stats = USER_STATS.get(key);
    
    switch (action) {
      case 'song_played':
        stats.songsPlayed++;
        stats.lastActivity = Date.now();
        break;
      case 'listen_time':
        stats.totalListenTime += data.seconds || 0;
        stats.lastActivity = Date.now();
        break;
      case 'favorite':
        if (!stats.favorites.includes(data.url)) {
          stats.favorites.push(data.url);
        }
        break;
      case 'session_start':
        stats.sessionStart = Date.now();
        break;
    }

    // Limitar cantidad de usuarios en memoria
    if (USER_STATS.size > 500) { // Límite para evitar memory leak
      const entries = Array.from(USER_STATS.entries());
      entries.sort((a, b) => a[1].lastActivity - b[1].lastActivity);
      for (let i = 0; i < 100; i++) { // Eliminar los 100 menos activos
        USER_STATS.delete(entries[i][0]);
      }
    }

  } catch (error) {
    console.warn("[user-stats:error]", error?.message);
  }
}

function getUserStats(userId, guildId) {
  const key = `${guildId}_${userId}`;
  return USER_STATS.get(key) || {
    songsPlayed: 0,
    totalListenTime: 0,
    favorites: [],
    lastActivity: 0
  };
}

// Limpieza automática cada 10 minutos
setInterval(() => {
  cleanupExpiredCache();
  cleanupMemory();
}, 600000);

// =================== CONFIGURACIÓN SERVIDOR WEB ===================
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// En Render Web Service, PORT es obligatorio y debe ser el único puerto público.
// Localmente usamos WEB_PORT (default 3001).
const HTTP_PORT = Number(process.env.PORT || process.env.WEB_PORT || 3001);
const HTTP_HOST = "0.0.0.0";
const WEB_PASSWORD = process.env.WEB_PASSWORD || "admin123";
let httpServerStarted = false;

// Middleware de seguridad
app.use(helmet({
  contentSecurityPolicy: false, // Permitir scripts inline para Chart.js
}));
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'web')));

// Variables para estadísticas web
let webStats = {
  startTime: Date.now(),
  totalCommands: 0,
  totalSongs: 0,
  uniqueUsers: new Set(),
  guildStats: new Map(),
  topSongs: new Map(),
  recentActivity: []
};

function updateWebStats(action, data = {}) {
  const timestamp = Date.now();
  
  switch (action) {
    case 'command_used':
      webStats.totalCommands++;
      webStats.uniqueUsers.add(data.userId);
      if (data.guildId) {
        const guildStat = webStats.guildStats.get(data.guildId) || { 
          name: data.guildName || 'Unknown', 
          commands: 0, 
          songs: 0 
        };
        guildStat.commands++;
        webStats.guildStats.set(data.guildId, guildStat);
      }
      break;
      
    case 'song_played':
      webStats.totalSongs++;
      webStats.uniqueUsers.add(data.userId);
      if (data.title) {
        const count = webStats.topSongs.get(data.title) || 0;
        webStats.topSongs.set(data.title, count + 1);
      }
      if (data.guildId) {
        const guildStat = webStats.guildStats.get(data.guildId) || { 
          name: data.guildName || 'Unknown', 
          commands: 0, 
          songs: 0 
        };
        guildStat.songs++;
        webStats.guildStats.set(data.guildId, guildStat);
      }
      break;
  }
  
  // Agregar a actividad reciente
  webStats.recentActivity.unshift({
    action,
    data,
    timestamp
  });
  
  // Limitar actividad reciente a 100 elementos
  if (webStats.recentActivity.length > 100) {
    webStats.recentActivity = webStats.recentActivity.slice(0, 100);
  }
  
  // Emitir actualización en tiempo real
  io.emit('stats_update', getStatsForWeb());
}

function getStatsForWeb() {
  const now = Date.now();
  const uptime = now - webStats.startTime;
  
  // Top 10 canciones más reproducidas
  const topSongsArray = Array.from(webStats.topSongs.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([title, count]) => ({ title, count }));
    
  // Estadísticas por servidor
  const guildsArray = Array.from(webStats.guildStats.entries())
    .map(([id, stats]) => ({ id, ...stats }));
  
  return {
    uptime: Math.floor(uptime / 1000),
    totalCommands: webStats.totalCommands,
    totalSongs: webStats.totalSongs,
    uniqueUsers: webStats.uniqueUsers.size,
    activeConnections: [...queues.values()].filter(q => q.connection).length,
    totalQueued: [...queues.values()].reduce((total, q) => total + (q.songs?.length || 0), 0),
    topSongs: topSongsArray,
    guilds: guildsArray,
    recentActivity: webStats.recentActivity.slice(0, 20),
    memoryUsage: process.memoryUsage(),
    cacheStats: {
      metadata: METADATA_CACHE.size,
      preload: PRELOAD_CACHE.size,
      userStats: USER_STATS.size
    }
  };
}

// =================== INTEGRACIÓN SPOTIFY ===================
function isSpotifyUrl(url) {
  return url.includes('spotify.com/') && (url.includes('/track/') || url.includes('/album/') || url.includes('/playlist/'));
}

function extractSpotifyId(url) {
  const match = url.match(/\/track\/([a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}

async function getSpotifyTrackInfo(trackId) {
  try {
    // Esta función simularía el uso de la API de Spotify
    // Por ahora, extraemos la información básica de la URL
    console.log(`[spotify] Procesando track ID: ${trackId}`);
    return null; // Placeholder - necesitaría implementación completa de Spotify API
  } catch (error) {
    console.warn('[spotify:error]', error?.message);
    return null;
  }
}

async function searchYouTubeForSpotifyTrack(spotifyUrl) {
  try {
    // Extraer información básica del URL de Spotify
    const urlParts = spotifyUrl.split('/');
    const trackIndex = urlParts.findIndex(part => part === 'track');
    
    if (trackIndex === -1) {
      throw new Error('No es un enlace de track de Spotify');
    }
    
    // Por ahora, instruir al usuario sobre cómo convertir manualmente
    // En una implementación completa, esto usaría Spotify API + búsqueda de YouTube
    return {
      error: true,
      message: "🎵 **Enlace de Spotify detectado**\n\nPor ahora, copia el nombre de la canción y artista de Spotify y búscalo manualmente en YouTube.\n\n💡 **Próximamente:** Integración automática Spotify → YouTube"
    };
  } catch (error) {
    return {
      error: true,
      message: "❌ No se pudo procesar el enlace de Spotify"
    };
  }
}

// ======================
// Cola por servidor
// ======================
const queues = new Map();

function getQueue(guildId) {
  let q = queues.get(guildId);
  if (!q) {
    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });
    // Limpiar bandera de reemplazo al entrar en Playing
    player.on("stateChange", (oldState, newState) => {
      const qq = queues.get(guildId);
      if (!qq) return;
      if (newState?.status === AudioPlayerStatus.Playing && qq.replacingResource) {
        qq.replacingResource = false;
      }
    });
    if (DEBUG_AUDIO) {
      player.on("stateChange", (oldState, newState) => {
        try {
          const os = oldState?.status;
          const ns = newState?.status;
          const ms = q?.player?.state?.resource?.playbackDuration || 0;
          console.log(
            `[player] state ${os} -> ${ns} (${Math.floor(ms / 1000)}s)`
          );
        } catch {}
      });
    }
    player.on("error", async (err) => {
      console.error("[player:error]", err?.message || err);
      const qq = queues.get(guildId);
      if (!qq || !qq.songs?.length) return;
      if (qq.replacingResource) {
        // Error durante un reemplazo: no avanzar cola
        qq.replacingResource = false;
        return;
      }
      // Saltar la pista que falló
      qq.songs.shift();
      if (qq.songs.length > 0) {
        try { await playNext(guildId); } catch {}
      } else {
        try { getVoiceConnection(guildId)?.destroy(); } catch {}
        queues.delete(guildId);
        try { await clearNowPlaying(guildId); } catch {}
        try { stopNowPlayingTicker(guildId); } catch {}
      }
    });
    player.on(AudioPlayerStatus.Idle, () => {
      const qq = queues.get(guildId);
      if (!qq) return;
      
      if (qq.replacingResource) {
        // Idle disparado por un swap rápido (seek, cambio de volumen, etc.): ignorar y limpiar flag
        qq.replacingResource = false;
        if (DEBUG_AUDIO) console.log(`[idle] Ignorando Idle por reemplazo de recurso en guild ${guildId}`);
        return;
      }
      
      // Verificar si realmente deberíamos avanzar - añadir un pequeño delay para evitar
      // que seeks fallidos disparen inmediatamente el avance de canción
      setTimeout(() => {
        const currentQueue = queues.get(guildId);
        if (!currentQueue) return;
        
        // Si todavía está marcado como reemplazando recurso, no avanzar
        if (currentQueue.replacingResource) {
          currentQueue.replacingResource = false;
          if (DEBUG_AUDIO) console.log(`[idle] Cancelando avance por operación de reemplazo pendiente`);
          return;
        }
        
        // Si está en loop, vuelve a reproducir sin avanzar
        if (currentQueue.loop && currentQueue.songs.length > 0) {
          playNext(guildId).catch((e) => console.error("[playNext:error]", e));
          return;
        }
        
        // Avanzar cola (aleatorio si shuffleMode ON)
        if (currentQueue.songs.length > 1 && currentQueue.shuffleMode) {
          const rest = currentQueue.songs.slice(1);
          
          // OPTIMIZACIÓN SHUFFLE + PRECARGA: Priorizar canciones precargadas
          let next = null;
          const preloadedSongs = [];
          
          // Buscar canciones precargadas entre las restantes
          for (const song of rest) {
            const cacheKey = `${guildId}_${song.url}`;
            if (PRELOAD_CACHE.has(cacheKey)) {
              const cached = PRELOAD_CACHE.get(cacheKey);
              if (cached && (Date.now() - cached.timestamp < 600000)) {
                preloadedSongs.push(song);
              }
            }
          }
          
          // Si hay canciones precargadas, usar una de ellas (aleatoria entre las precargadas)
          if (preloadedSongs.length > 0) {
            const pick = Math.floor(Math.random() * preloadedSongs.length);
            next = preloadedSongs[pick];
            if (DEBUG_AUDIO) console.log(`[shuffle] 🎯 Seleccionada canción precargada: ${next.title}`);
          } else {
            // No hay precargadas, seleccionar aleatoriamente como antes
            const pick = Math.floor(Math.random() * rest.length);
            next = rest[pick];
            if (DEBUG_AUDIO) console.log(`[shuffle] 🎲 Seleccionada canción aleatoria: ${next.title}`);
          }
          
          const newRest = rest.filter(song => song !== next);
          currentQueue.songs = [next, ...newRest];
        } else {
          currentQueue.songs.shift();
        }
        
        if (currentQueue.songs.length > 0) {
          // Limpiar timeout de idle si hay más canciones para reproducir
          clearIdleTimeout(guildId);
          playNext(guildId).catch((e) => console.error("[playNext:error]", e));
        } else {
          // No hay más canciones en la cola
          if (IDLE_TIMEOUT_MINUTES > 0) {
            console.log(`[idle] Cola vacía en servidor ${guildId}, configurando timeout de ${IDLE_TIMEOUT_MINUTES} minutos antes de desconectar`);
            setIdleTimeout(guildId);
            // Actualizar el panel para mostrar que está en modo idle
            renderNowPlaying(guildId).catch(() => {});
          } else {
            // Comportamiento original: desconectar inmediatamente
            const conn = getVoiceConnection(guildId);
            conn?.destroy();
            queues.delete(guildId);
            // Limpiar memoria y cache cuando se termine la cola
            cleanupMemory(guildId);
            clearNowPlaying(guildId).catch(() => {});
            try { stopNowPlayingTicker(guildId); } catch {}
          }
        }
      }, 100); // Delay de 100ms para evitar condiciones de carrera
    });
  const initialVol = Math.max(0, Math.min(2, Number(guildState[guildId]?.volume ?? 1.0)));
    q = {
      songs: [],
      player,
      connection: null,
      textChannelId: null,
      nowPlayingMessageId: null,
  loop: Boolean(guildState[guildId]?.loop || false),
  shuffleMode: Boolean(guildState[guildId]?.shuffleMode || false),
      volume: initialVol,
      uiInterval: null,
      currentRetry: 0,
      connectingPromise: null,
      upgradeTimer: null,
  currentTrackToken: null,
  // Bass: ganancia en dB (0 = OFF)
  bassGainDb: Math.max(0, Math.min(24, Number(guildState[guildId]?.bassGainDb ?? 0))),
  // Flag interno para reemplazo de recurso sin avanzar cola
  replacingResource: false,
    };
    queues.set(guildId, q);
  }
  return q;
}

// ======================
// Utilidades de respuesta para interacciones
// ======================
async function safeRespond(interaction, data, opts = {}) {
  try {
    if (opts.edit) {
      return await interaction.editReply(data);
    }
    return await interaction.reply(data);
  } catch (e) {
    try {
      if (interaction.deferred || interaction.replied) {
        return await interaction.editReply(data);
      }
      return await interaction.reply(data);
    } catch {}
  }
}

async function safeDefer(interaction) {
  try {
    if (interaction.deferred || interaction.replied) return true;
  // Hacer que las respuestas de slash sean efímeras (no empujan el chat)
  // Nota: usar flags en lugar de 'ephemeral' (deprecado)
  const flags = EPHEMERAL_SLASH ? (1 << 6) : undefined;
  await interaction.deferReply(flags != null ? { flags } : {});
    return true;
  } catch {
    return false;
  }
}

function tryEnqueue(q, song) {
  if (!q || !song) return false;
  if ((q.songs?.length || 0) >= MAX_QUEUE_LENGTH) return false;
  
  // Si esta es la primera canción que se agrega (o la cola estaba vacía), 
  // limpiar cualquier timeout de idle que pudiera estar configurado
  if (q.songs.length === 0) {
    // Obtener el guildId de la cola - necesitamos encontrarlo en el mapa de queues
    for (const [guildId, queue] of queues.entries()) {
      if (queue === q) {
        clearIdleTimeout(guildId);
        break;
      }
    }
  }
  
  q.songs.push(song);
  
  // 🚀 PRECARGA AUTOMÁTICA: Ahora se activa cuando la descarga actual termine (no inmediatamente)
  
  return true;
}

function sameVoiceChannelRequiredPass(guild, member) {
  if (!REQUIRE_SAME_VC) return true;
  try {
    const meConn = getVoiceConnection(guild.id);
    const botChannelId = meConn?.joinConfig?.channelId;
  const userChannelId = member?.voice?.channelId;
    if (!botChannelId || !userChannelId) return false;
    return botChannelId === userChannelId;
  } catch {
    return false;
  }
}

async function ensureConnection(guild, voiceChannel) {
  const q = getQueue(guild.id);
  if (
    q.connection &&
    q.connection.state.status !== VoiceConnectionStatus.Destroyed
  )
    return q.connection;

  if (q.connectingPromise) {
    return q.connectingPromise;
  }

  const attemptJoin = async () => {
    if (DEBUG_AUDIO)
      console.log(`[voice] intentando unirse a ${voiceChannel?.id}`);
    const conn = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });
    conn.on("error", (err) => console.error("[voice:connection:error]", err));
    // Reconexión básica si Discord mueve el canal o hay blips de red
    conn.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(conn, VoiceConnectionStatus.Signalling, 5_000),
          entersState(conn, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        // Se recuperó solo
      } catch {
        try {
          conn.destroy();
        } catch {}
      }
    });
    // Fix keepAlive UDP leak y evitar fugas de listeners
    const networkingStateChangeHandler = (oldNet, newNet) => {
      const udp = Reflect.get(newNet, "udp");
      if (udp && udp.keepAliveInterval) {
        try {
          clearInterval(udp.keepAliveInterval);
        } catch {}
        udp.keepAliveInterval = null;
      }
    };
    conn.on("stateChange", (oldState, newState) => {
      const oldNetworking = Reflect.get(oldState, "networking");
      const newNetworking = Reflect.get(newState, "networking");
      // Remover handler anterior usando la misma referencia almacenada
      const prev = Reflect.get(conn, "_networkingHandler");
      if (oldNetworking && prev) {
        oldNetworking.off?.("stateChange", prev);
      }
      if (newNetworking) {
        // Subir el límite para evitar warnings en entornos ruidosos
        newNetworking.setMaxListeners?.(20);
        newNetworking.on?.("stateChange", networkingStateChangeHandler);
        Reflect.set(conn, "_networkingHandler", networkingStateChangeHandler);
      }
    });
    conn.subscribe(q.player);
    await entersState(conn, VoiceConnectionStatus.Ready, 45_000);
    if (DEBUG_AUDIO)
      console.log(`[voice] conectado y listo en guild ${guild.id}`);
    return conn;
  };

  q.connectingPromise = (async () => {
    let lastErr;
    for (let i = 0; i < 5; i++) {
      try {
        q.connection = await attemptJoin();
        return q.connection;
      } catch (e) {
        lastErr = e;
        console.error("[voice:connection:ready:timeout]", e?.message);
        try {
          q.connection?.destroy();
        } catch {}
        q.connection = null;
        if (i < 4) await new Promise((r) => setTimeout(r, 3000));
      }
    }
    const err = new Error("VOICE_CONNECT_TIMEOUT");
    err.cause = lastErr;
    throw err;
  })();

  try {
    const conn = await q.connectingPromise;
    return conn;
  } finally {
    q.connectingPromise = null;
  }
}

// Función optimizada para crear recursos desde URL directa (para seek rápido)
async function createOptimizedResourceFromDirectUrl(directUrl, startAtSec = 0, volume = 1.0, options = {}) {
  const {
    bassGainDb = 0,
    bassFreq = DEFAULT_BASS_FREQ,
    bassWidth = DEFAULT_BASS_WIDTH,
  } = options || {};
  
  if (DEBUG_AUDIO) console.log(`[optimized-seek] ⚡ Creando recurso optimizado desde ${startAtSec}s`);
  
  const ffmpegPath = process.env.FFMPEG_PATH || require("ffmpeg-static");
  if (!ffmpegPath) throw new Error("FFMPEG_REQUIRED");
  
  const opusTargetKbps = Math.max(64, Math.min(256, Number(process.env.OPUS_BITRATE || 160)));
  const ffArgs = [
    "-hide_banner",
    "-loglevel", "warning",
    "-nostdin",
    "-reconnect", "1",
    "-reconnect_streamed", "1", 
    "-reconnect_delay_max", "3",
    "-rw_timeout", "10000000", // 10s timeout
    "-http_persistent", "0",
    "-seekable", "1"
  ];
  
  // Seek optimizado: usar input seek para máxima velocidad
  if (startAtSec > 0) {
    ffArgs.push("-ss", String(startAtSec));
  }
  
  // Headers para evitar 403/400
  const userAgent = process.env.YTDL_USER_AGENT || 
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
  const acceptLang = process.env.YTDL_ACCEPT_LANGUAGE || "es-ES,es;q=0.9,en;q=0.8";
  
  const hdrs = [`User-Agent: ${userAgent}`, `Accept-Language: ${acceptLang}`];
  ffArgs.push("-headers", hdrs.join("\r\n") + "\r\n");
  
  ffArgs.push("-i", directUrl);
  ffArgs.push("-vn", "-sn", "-dn");
  
  // Filtro de bajos si se configuró
  if (bassGainDb > 0) {
    const g = Math.max(1, Math.min(24, Math.round(bassGainDb)));
    const f = Math.max(20, Math.min(250, Math.round(bassFreq)));
    const w = Math.max(0.1, Math.min(5, Number(bassWidth)));
    ffArgs.push("-af", `bass=g=${g}:f=${f}:w=${w}`);
  }
  
  ffArgs.push(
    "-ac", "2",
    "-ar", "48000", 
    "-c:a", "libopus",
    "-b:a", `${opusTargetKbps}k`,
    "-vbr", "on",
    "-compression_level", "10",
    "-application", "audio",
    "-frame_duration", "20",
    "-f", "ogg",
    "pipe:1"
  );
  
  const ff = spawn(ffmpegPath, ffArgs, { stdio: ["ignore", "pipe", "pipe"] });
  
  // Manejo de errores simplificado
  const ignoreErr = (label) => (err) => {
    if (!err) return;
    const code = err?.code || "";
    if (code === "EPIPE" || code === "ECONNRESET") {
      if (DEBUG_AUDIO) console.warn(`[${label}] ${code} (ignorado)`);
      return;
    }
    if (DEBUG_AUDIO) console.warn(`[${label}]`, err?.message || err);
  };
  
  ff.on("error", ignoreErr("ffmpeg-opt:proc"));
  ff.stdout.on("error", ignoreErr("ffmpeg-opt:stdout"));
  if (ff.stderr && DEBUG_AUDIO) {
    ff.stderr.on("data", (d) => {
      const msg = String(d).trim();
      if (msg && !msg.includes("time=") && !msg.includes("size=")) {
        console.warn(`[ffmpeg-opt] ${msg}`);
      }
    });
  }
  
  const cleanup = () => {
    try { ff.kill("SIGKILL"); } catch {}
  };
  ff.stdout.on("close", cleanup);
  ff.stdout.on("end", cleanup);
  
  const resource = createAudioResource(ff.stdout, { 
    inputType: StreamType.OggOpus, 
    inlineVolume: true 
  });
  
  if (resource.volume) {
    resource.volume.setVolumeLogarithmic(Math.max(0, Math.min(2, volume)));
  }
  
  if (DEBUG_AUDIO) console.log(`[optimized-seek] ✅ Recurso creado con seek a ${startAtSec}s`);
  return resource;
}

async function createResourceFromUrl(url, volume = 1.0, options = {}) {
  const {
    preferPlayDl = false,
    forceFfmpeg = false,
    bassGainDb = 0,
    bassFreq = DEFAULT_BASS_FREQ,
    bassWidth = DEFAULT_BASS_WIDTH,
  startAtSec = 0,
  } = options || {};
  
  // 🚀 MODO VELOCIDAD: Optimizaciones para inicio más rápido
  const speedPriority = String(process.env.FIRST_SONG_SPEED_PRIORITY || "0") === "1";
  const ultraFastStart = String(process.env.FAST_START_ULTRA || "0") === "1";
  const allowFallback = String(process.env.ALLOW_FALLBACK_QUALITY || "0") === "1";
  
  if (speedPriority || ultraFastStart) {
    if (DEBUG_AUDIO) console.log(`[createResourceFromUrl] 🚀 Modo velocidad activado para: ${url.substring(0, 50)}...`);
  }
  
  // Canonicalizar URL de YouTube para mayor compatibilidad
  url = canonicalizeYouTubeUrl(url);
  if (!url || typeof url !== "string" || !/^https?:\/\//i.test(url)) {
    throw new Error("INVALID_STREAM_URL");
  }
  const ytCookie = getYouTubeCookieHeaderFromEnv();
  const ytCookiesArr = ytCookie ? parseCookieHeaderToArray(ytCookie) : null;
  const userAgent =
    process.env.YTDL_USER_AGENT ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
  const acceptLang =
    process.env.YTDL_ACCEPT_LANGUAGE || "es-ES,es;q=0.9,en;q=0.8";
  const baseReqOpts = {
    headers: {
      "user-agent": userAgent,
      "accept-language": acceptLang,
      ...(ytCookie ? { cookie: ytCookie } : {}),
    },
  };
  // Si necesitamos FFmpeg (por bass o forzado), priorizar ruta yt-dlp + ffmpeg
  const needFfmpeg = forceFfmpeg || (Number(bassGainDb) || 0) > 0;
  if (needFfmpeg) {
    const hasBin = !!getYtDlpBinaryPath() || !!ytdlp;
    if (hasBin) {
      if (DEBUG_AUDIO) console.log(`[createResource] forzando ffmpeg (bass=${bassGainDb}dB)`);
      return await createResourceFromYtDlp(
        url,
        volume,
  { userAgent, acceptLang, cookie: ytCookie },
  { bassGainDb, bassFreq, bassWidth, startAtSec }
      );
    }
  }

  // Para YouTube
  if (isYouTubeUrl(url)) {
    // Resolver ID una sola vez para reutilizar en fallbacks
    const id = extractYouTubeId(url) || url;
    const forcePlayDl = String(process.env.YT_FORCE_PLAYDL || "0") === "1";
    // Por defecto usar yt-dlp (play-dl suele recibir 429 en IPs de datacenter como Render)
    const forceYtDlp =
      !forcePlayDl && String(process.env.YT_FORCE_YTDLP || "1") === "1";
    
    // 🚀 MODO VELOCIDAD: Usar el extractor más rápido (generalmente ytdl-core)
    if ((speedPriority || ultraFastStart) && !forceYtDlp && !needFfmpeg) {
      if (DEBUG_AUDIO) console.log(`[createResource] ⚡ Intentando ytdl-core para máxima velocidad`);
      try {
        return await createResourceFromYtdlCore(id, volume, baseReqOpts);
      } catch (e) {
        if (DEBUG_AUDIO) console.log(`[createResource] ⚡ ytdl-core falló, fallback a yt-dlp:`, e?.message);
        if (allowFallback) {
          // Continúa con yt-dlp como fallback
        } else {
          throw e;
        }
      }
    }
    
    // Si se fuerza yt-dlp, usarlo directo
    if (forceYtDlp) {
      const hasBin = !!getYtDlpBinaryPath() || !!ytdlp;
      if (hasBin) {
        if (DEBUG_AUDIO)
          console.log(`[createResource] usando yt-dlp (forzado)`);
        return await createResourceFromYtDlp(
          url,
          volume,
          {
            userAgent,
            acceptLang,
            cookie: ytCookie,
          }
        );
      } else {
        if (DEBUG_AUDIO)
          console.warn(
            `[createResource] YT_FORCE_YTDLP=1 pero no hay yt-dlp instalado; usando play-dl`
          );
        // Intentar play-dl de inmediato y evitar ytdl-core cuando se fuerza yt-dlp
        try {
          const info = await playdl.video_info(url);
          const s = await playdl.stream_from_info(info, {
            discordPlayerCompatibility: true,
          });
          const inputType =
            typeof s.type === "number" ? s.type : StreamType.WebmOpus;
          const resource = createAudioResource(s.stream, {
            inputType,
            inlineVolume: true,
          });
          if (resource.volume)
            resource.volume.setVolumeLogarithmic(
              Math.max(0, Math.min(2, volume))
            );
          return resource;
        } catch (eForceNoBin) {
          if (DEBUG_AUDIO)
            console.warn(
              `[createResource] play-dl falló sin yt-dlp:`,
              eForceNoBin?.message || eForceNoBin
            );
        }
      }
    }
    // Si se solicita o está forzado, intentamos primero con play-dl para evitar 403 de firmas/cookies
    if (!forceYtDlp && (preferPlayDl || forcePlayDl)) {
      try {
        if (DEBUG_AUDIO)
          console.log(`[createResource] usando play-dl (prefer/force)`);
        const info = await playdl.video_info(url);
        const s = await playdl.stream_from_info(info, {
          discordPlayerCompatibility: true,
        });
        const inputType =
          typeof s.type === "number" ? s.type : StreamType.WebmOpus;
        const resource = createAudioResource(s.stream, {
          inputType,
          inlineVolume: true,
        });
        if (resource.volume)
          resource.volume.setVolumeLogarithmic(
            Math.max(0, Math.min(2, volume))
          );
        if (DEBUG_AUDIO)
          console.log("[createResource] using play-dl (prefer/force)");
        return resource;
      } catch (ePlayPrefer) {
        const msg = String(ePlayPrefer?.message || ePlayPrefer || "");
        if (DEBUG_AUDIO)
          console.warn("[createResource:playdl:prefer]", msg, "url:", url);
        // Si el error es 'Invalid URL' o desafío de login/consent, PERMITIR fallback a ytdl aunque esté forzado
        const allowFallback =
          /Invalid URL/i.test(msg) || /Sign in to confirm/i.test(msg);
        if (!allowFallback && forcePlayDl) {
          // Error distinto: respetar el forzado
          throw ePlayPrefer;
        }
        // Si allowFallback o no está forzado, continuamos al branch ytdl
      }
    }
    // En caso contrario, priorizar ytdl-core (a menos que se fuerce yt-dlp)
    try {
      if (DEBUG_AUDIO) console.log(`[createResource] ⚡ intentando ytdl-core getInfo (modo velocidad: ${speedPriority || ultraFastStart})`);
      const info = await ytdl.getInfo(id, buildYtdlRequestOptions(id));
      const fmt = selectWebmOpusFormat(info.formats);
      if (fmt) {
        if (DEBUG_AUDIO) console.log(`[createResource] ⚡ ytdl formato webm/opus encontrado`);
        
        // Actualizar calidad en metadatos con el formato real seleccionado
        updateMetadataQuality(url, fmt);
        
        const stream = ytdl.downloadFromInfo(info, {
          format: fmt,
          highWaterMark: ultraFastStart ? (1 << 20) : HIGH_WATER_MARK, // Buffer más pequeño en modo ultra rápido
          ...buildYtdlRequestOptions(info?.videoDetails?.video_url || id),
        });
        const resource = createAudioResource(stream, {
          inputType: StreamType.WebmOpus,
          inlineVolume: true,
        });
        if (resource.volume)
          resource.volume.setVolumeLogarithmic(
            Math.max(0, Math.min(2, volume))
          );
        if (DEBUG_AUDIO) console.log(`[createResource] ⚡ ¡Éxito con ytdl-core WebM/Opus!`);
        return resource;
      }
      // Si no hay WebM/Opus, usar audioonly y dejar que ffmpeg demux/transcode (requiere ffmpeg-static)
      if (DEBUG_AUDIO) console.log(`[createResource] ⚡ ytdl fallback audioonly`);
      
      // Obtener formato de alta calidad y actualizar metadatos
      const fallbackFormat = ytdl.chooseFormat(info.formats, { quality: "highestaudio", filter: "audioonly" });
      if (fallbackFormat) {
        updateMetadataQuality(url, fallbackFormat);
      }
      
      const fallbackStream = ytdl.downloadFromInfo(info, {
        quality: "highestaudio",
        filter: "audioonly",
        highWaterMark: ultraFastStart ? (1 << 20) : (1 << 25), // Buffer más pequeño en modo ultra rápido
        ...buildYtdlRequestOptions(info?.videoDetails?.video_url || id),
      });
      const resource = createAudioResource(fallbackStream, {
        inputType: StreamType.Arbitrary,
        inlineVolume: true,
      });
      if (resource.volume)
        resource.volume.setVolumeLogarithmic(Math.max(0, Math.min(2, volume)));
      return resource;
    } catch (eYtdl) {
      if (DEBUG_AUDIO)
        console.warn(
          "[createResource:ytdl:fallback] ⚠️ ytdl-core falló, intentando yt-dlp:",
          eYtdl?.message || eYtdl,
          "url:",
          url.substring(0, 50)
        );
      // En modo velocidad, solo intentar yt-dlp si es crítico, sino fallar rápido
      if ((speedPriority || ultraFastStart) && !allowFallback) {
        if (DEBUG_AUDIO) console.log("[createResource] ⚡ Modo velocidad: fallando rápido sin yt-dlp");
        throw new Error(`ytdl-core falló en modo velocidad: ${eYtdl?.message}`);
      }
      
      // Intentar yt-dlp si está disponible o forzado
      try {
        if (ytdlp) {
          if (DEBUG_AUDIO) console.log("[createResource] 🔄 Fallback a yt-dlp...");
          const r = await createResourceFromYtDlp(
            url,
            volume,
            {
              userAgent,
              acceptLang,
              cookie: ytCookie,
            }
          );
          return r;
        }
      } catch (eYtdlpA) {
        if (DEBUG_AUDIO)
          console.warn(
            "[createResource:ytdlp:fallback-A]",
            eYtdlpA?.message || eYtdlpA
          );
      }
      // Segundo intento: getBasicInfo y formato directo
      try {
        if (DEBUG_AUDIO) console.log(`[createResource] ytdl getBasicInfo`);
        const basic = await ytdl.getBasicInfo(id, buildYtdlRequestOptions(id));
        const fmt2 =
          selectWebmOpusFormat(basic.formats) ||
          ytdl.chooseFormat(basic.formats, {
            quality: "highestaudio",
            filter: "audioonly",
          });
        if (fmt2) {
          if (DEBUG_AUDIO)
            console.log(`[createResource] ytdl chooseFormat directo`);
          const stream2 = ytdl(id, {
            format: fmt2,
            highWaterMark: 1 << 25,
            ...buildYtdlRequestOptions(id),
          });
          const res2 = createAudioResource(stream2, {
            inputType: /webm/i.test(fmt2.mimeType || fmt2.container)
              ? StreamType.WebmOpus
              : StreamType.Arbitrary,
            inlineVolume: true,
          });
          if (res2.volume)
            res2.volume.setVolumeLogarithmic(Math.max(0, Math.min(2, volume)));
          return res2;
        }
      } catch (eBasic) {
        if (DEBUG_AUDIO)
          console.warn(
            "[createResource:ytdl:basic-fallback]",
            eBasic?.message || eBasic,
            "url:",
            url
          );
      }
      // Fallback a play-dl si ytdl falla
      try {
        if (DEBUG_AUDIO) console.log(`[createResource] fallback play-dl A`);
        const info = await playdl.video_info(url);
        const s = await playdl.stream_from_info(info, {
          discordPlayerCompatibility: true,
        });
        const inputType =
          typeof s.type === "number" ? s.type : StreamType.WebmOpus;
        const resource = createAudioResource(s.stream, {
          inputType,
          inlineVolume: true,
        });
        if (resource.volume)
          resource.volume.setVolumeLogarithmic(
            Math.max(0, Math.min(2, volume))
          );
        return resource;
      } catch (ePlay) {
        if (DEBUG_AUDIO && ePlay?.message !== "Invalid URL")
          console.warn(
            "[createResource:playdl:fallback-A]",
            ePlay?.message || ePlay,
            "url:",
            url
          );
        try {
          if (DEBUG_AUDIO) console.log(`[createResource] fallback play-dl B`);
          const s2 = await playdl.stream(url, {
            discordPlayerCompatibility: true,
          });
          const inputType2 =
            typeof s2.type === "number" ? s2.type : StreamType.WebmOpus;
          const resource2 = createAudioResource(s2.stream, {
            inputType: inputType2,
            inlineVolume: true,
          });
          if (resource2.volume)
            resource2.volume.setVolumeLogarithmic(
              Math.max(0, Math.min(2, volume))
            );
          return resource2;
        } catch (ePlayB) {
          if (DEBUG_AUDIO && ePlayB?.message !== "Invalid URL")
            console.warn(
              "[createResource:playdl:fallback-B]",
              ePlayB?.message || ePlayB,
              "url:",
              url
            );
          // Último intento con yt-dlp
          try {
            if (ytdlp) {
              if (DEBUG_AUDIO)
                console.log(`[createResource] fallback yt-dlp B`);
              const r2 = await createResourceFromYtDlp(url, volume, {
                userAgent,
                acceptLang,
                cookie: ytCookie,
              });
              return r2;
            }
          } catch (eYtdlpB) {
            if (DEBUG_AUDIO)
              console.warn(
                "[createResource:ytdlp:fallback-B]",
                eYtdlpB?.message || eYtdlpB
              );
          }
        }
      }
    }
  } else {
    // No YouTube: usar play-dl primero (Soundcloud, etc.)
    try {
      if (DEBUG_AUDIO) console.log(`[createResource] no-YouTube con play-dl`);
      const info = await playdl.video_info(url);
      const s = await playdl.stream_from_info(info, {
        discordPlayerCompatibility: true,
      });
      const inputType =
        typeof s.type === "number" ? s.type : StreamType.WebmOpus;
      const resource = createAudioResource(s.stream, {
        inputType,
        inlineVolume: true,
      });
      if (resource.volume)
        resource.volume.setVolumeLogarithmic(Math.max(0, Math.min(2, volume)));
      return resource;
    } catch (ePlay) {
      if (DEBUG_AUDIO)
        console.warn(
          "[createResource:playdl:fallback-A]",
          ePlay?.message || ePlay,
          "url:",
          url
        );
      try {
        if (DEBUG_AUDIO)
          console.log(`[createResource] no-YouTube fallback play-dl B`);
        const s2 = await playdl.stream(url, {
          discordPlayerCompatibility: true,
        });
        const inputType2 =
          typeof s2.type === "number" ? s2.type : StreamType.WebmOpus;
        const resource2 = createAudioResource(s2.stream, {
          inputType: inputType2,
          inlineVolume: true,
        });
        if (resource2.volume)
          resource2.volume.setVolumeLogarithmic(
            Math.max(0, Math.min(2, volume))
          );
        return resource2;
      } catch (ePlayB) {
        if (DEBUG_AUDIO)
          console.warn(
            "[createResource:playdl:fallback-B]",
            ePlayB?.message || ePlayB,
            "url:",
            url
          );
      }
    }
  }

  // Si todo falla
  const err = new Error("UNPLAYABLE_URL");
  err.url = url;
  throw err;
}

async function getDirectUrlFromYtDlp(targetUrl, headers = {}, opts = {}) {
  const binPath = getYtDlpBinaryPath();
  const addHeader = [];
  if (headers?.userAgent) addHeader.push(`User-Agent: ${headers.userAgent}`);
  if (headers?.acceptLang)
    addHeader.push(`Accept-Language: ${headers.acceptLang}`);
  // No pasar cookies por header: yt-dlp depreca esto y además YouTube lo bloquea.
  // Usaremos archivo de cookies Netscape vía --cookies si está disponible.
  const cookieFile = ensureYtDlpCookiesFileFromEnv();
  const formats = Array.isArray(opts.formats) && opts.formats.length
    ? opts.formats
    : [
        "bestaudio[acodec=opus]/bestaudio/best",
        "251",
        "bestaudio/best",
      ];
  let lastErr = null;
  for (const fmt of formats) {
    try {
      // Ejecutar -g por formato
      const url = await new Promise((resolve, reject) => {
        if (binPath) {
          const args = ["-g", "-f", fmt, "--no-playlist"];
          if (cookieFile) {
            args.push("--cookies", cookieFile);
          }
          for (const h of addHeader) args.push("--add-header", h);
          args.push(targetUrl);
          const proc = spawn(binPath, args, { stdio: ["ignore", "pipe", "pipe"] });
          let out = "";
          let err = "";
          proc.stdout.on("data", (d) => { out += d.toString(); });
          proc.stderr.on("data", (d) => { err += d.toString(); });
          proc.on("close", (code) => {
            if (code === 0) {
              const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
              if (lines.length) return resolve(lines[0]);
              return reject(new Error("YTDLP_NO_URL"));
            }
            if (DEBUG_AUDIO && err) console.warn(`[yt-dlp] ${err.trim()}`);
            reject(new Error(`YTDLP_EXIT_${code}`));
          });
          proc.on("error", reject);
        } else if (ytdlp && ytdlp.raw) {
          const proc = ytdlp.raw(targetUrl, {
            g: true,
            format: fmt,
            noPlaylist: true,
            addHeader,
            ...(cookieFile ? { cookies: cookieFile } : {}),
          });
          let out = "";
          let err = "";
          proc.stdout.on("data", (d) => { out += d.toString(); });
          proc.stderr.on("data", (d) => { err += d.toString(); });
          proc.on("close", (code) => {
            if (code === 0) {
              const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
              if (lines.length) return resolve(lines[0]);
              return reject(new Error("YTDLP_NO_URL"));
            }
            if (DEBUG_AUDIO && err) console.warn(`[yt-dlp] ${err.trim()}`);
            reject(new Error(`YTDLP_EXIT_${code}`));
          });
          proc.on("error", reject);
        } else {
          reject(new Error("YTDLP_NOT_AVAILABLE"));
        }
      });
      if (url) return url;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("YTDLP_NO_URL");
}

async function createResourceFromYtDlp(url, volume = 1.0, headers = {}) {
  // transcodeOptions opcional en headers._transcodeOptions para compatibilidad
  let transcodeOptions = headers && headers._transcodeOptions ? headers._transcodeOptions : undefined;
  if (!transcodeOptions && arguments.length >= 4) {
    // Soportar firma extendida createResourceFromYtDlp(url, volume, headers, transcodeOptions)
    transcodeOptions = arguments[3];
  }
  if (DEBUG_AUDIO) console.log(`[yt-dlp] invocando yt-dlp para ${url}`);
  const binPath = getYtDlpBinaryPath();
  if (!binPath && !(ytdlp && ytdlp.raw)) throw new Error("YTDLP_NOT_AVAILABLE");

  const ffmpegPath = process.env.FFMPEG_PATH || require("ffmpeg-static");
  if (!ffmpegPath) throw new Error("FFMPEG_REQUIRED");

  // Opción: intentar obtener directamente un stream opus del origen (sin re-encode)
  const preferDirectOpus = (process.platform !== "win32") && String(process.env.YT_DLP_DIRECT_OPUS || "0") === "1";
  const bassGainDb = Number(transcodeOptions?.bassGainDb || 0) || 0;
  const bassFreq = Number(transcodeOptions?.bassFreq || DEFAULT_BASS_FREQ);
  const bassWidth = Number(transcodeOptions?.bassWidth || DEFAULT_BASS_WIDTH);
  const startAtSec = Math.max(0, Number(transcodeOptions?.startAtSec || 0) || 0);
  if (preferDirectOpus && bassGainDb <= 0) {
    try {
      const f = "bestaudio[acodec=opus]"; // intentaremos obtener el mejor audio en opus (webm normalmente)
      const cookieFile = ensureYtDlpCookiesFileFromEnv();
      const commonArgs = ["--no-playlist", "-f", f, "-o", "-"];
      if (headers?.userAgent) commonArgs.push("--user-agent", headers.userAgent);
      if (headers?.acceptLang) commonArgs.push("--add-header", `Accept-Language: ${headers.acceptLang}`);
      if (String(process.env.YT_FORCE_IPV4 || "0") === "1") commonArgs.push("--force-ipv4");
      if (cookieFile) commonArgs.push("--cookies", cookieFile);

      const yProc = binPath
        ? spawn(binPath, [...commonArgs, url], { stdio: ["ignore", "pipe", "pipe"] })
        : ytdlp.raw(url, {
            noPlaylist: true,
            f,
            o: "-",
            ...(headers?.userAgent ? { userAgent: headers.userAgent } : {}),
            ...(headers?.acceptLang ? { addHeader: [`Accept-Language: ${headers.acceptLang}`] } : {}),
            ...(cookieFile ? { cookies: cookieFile } : {}),
            ...(String(process.env.YT_FORCE_IPV4 || "0") === "1" ? { forceIpv4: true } : {}),
          });

      if (DEBUG_AUDIO) {
        yProc.stderr?.on("data", (d) => console.warn(`[yt-dlp] ${String(d).trim()}`));
      }
      // Entregamos directamente WebM Opus
      const out = yProc.stdout;
      const ignoreErr = (label) => (err) => {
        if (!err) return;
        const code = err?.code || "";
        if (code === "EPIPE" || code === "ECONNRESET") {
          if (DEBUG_AUDIO) console.warn(`[${label}] ${code} (ignorada)`);
          return;
        }
        console.warn(`[${label}]`, err?.message || err);
      };
      yProc.on?.("error", ignoreErr("yt-dlp:proc"));
      yProc.stdout?.on("error", ignoreErr("yt-dlp:stdout"));
      yProc.stdin?.on?.("error", ignoreErr("yt-dlp:stdin"));

      const cleanup = () => {
        try { yProc.kill?.("SIGKILL"); } catch {}
      };
      out.on("close", cleanup);
      out.on("end", cleanup);
      out.on("error", ignoreErr("yt-dlp:out"));

      const resource = createAudioResource(out, { inputType: StreamType.WebmOpus, inlineVolume: true });
      if (resource.volume)
        resource.volume.setVolumeLogarithmic(Math.max(0, Math.min(2, volume)));
      return resource;
    } catch (e) {
      if (DEBUG_AUDIO) console.warn("[yt-dlp] direct opus falló, reintento con ffmpeg:", e?.message || e);
      // caemos al camino de ffmpeg más abajo
    }
  }

  // Preparar encabezados y cookie para yt-dlp (no para ffmpeg)
  const args = ["--no-playlist", "-f", "bestaudio/best", "-o", "-"];
  
  // 🚀 OPTIMIZACIONES DE VELOCIDAD
  if (YT_PARALLEL_DOWNLOADS > 1) {
    args.push("--concurrent-fragments", YT_PARALLEL_DOWNLOADS.toString());
  }
  
  // Timeout de socket más largo para conexiones lentas
  args.push("--socket-timeout", Math.floor(YT_DOWNLOAD_TIMEOUT / 1000).toString());
  
  // Reintentos para mejor estabilidad
  const ytRetries = process.env.YT_RETRIES || "3";
  const retryDelay = process.env.YT_RETRY_SLEEP || "2";
  args.push("--retries", ytRetries);
  args.push("--fragment-retries", "5");
  args.push("--retry-sleep", `fragment:${retryDelay}`);
  
  // 🛡️ CONFIGURACIONES ANTI-BLOQUEO
  // Usar user agent personalizado si está definido
  if (process.env.YT_USER_AGENT) {
    args.push("--user-agent", process.env.YT_USER_AGENT);
  }
  
  // 🚀 CONFIGURACIONES ANTI-SLEEP MÁS AGRESIVAS
  const forceNoSleep = String(process.env.YT_DLP_FORCE_NO_SLEEP || "0") === "1";
  const ignoreSleep = String(process.env.YT_DLP_IGNORE_SLEEP || "0") === "1";
  
  if (forceNoSleep || ignoreSleep) {
    args.push("--sleep-interval", "0");
    args.push("--max-sleep-interval", "0");
    args.push("--sleep-subtitles", "0");
    args.push("--retry-sleep", "linear:0");
    if (DEBUG_AUDIO) console.log(`[yt-dlp] 💥 Forzando eliminación total de delays`);
  }
  
  // Reducir límite de velocidad para evitar detección
  args.push("--limit-rate", "2M");
  
  // Simular browser más realista
  args.push("--add-header", "Accept:text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
  args.push("--add-header", "Accept-Language:es-ES,es;q=0.9,en;q=0.8");
  args.push("--add-header", "Sec-Fetch-Dest:document");
  args.push("--add-header", "Sec-Fetch-Mode:navigate");
  
  // Cache más agresivo si está habilitado
  if (YT_AGGRESSIVE_CACHE) {
    args.push("--cache-dir", "./temp/yt-cache");
  }
  
  // Opcionales para mitigar captcha en YouTube
  const extractorArgsEnv = (process.env.YT_YTDLP_EXTRACTOR_ARGS || "").trim();
  const ytClient = (process.env.YT_YTDLP_CLIENT || "").trim().toLowerCase(); // p.ej.: android | tvhtml5 | web | ios | mweb
  const strictClient = String(process.env.YT_YTDLP_STRICT_CLIENT || "0") === "1";
  const forceIpv4 = String(process.env.YT_FORCE_IPV4 || "0") === "1";

  if (headers?.userAgent) {
    args.push("--user-agent", headers.userAgent);
  }
  if (headers?.acceptLang) {
    args.push("--add-header", `Accept-Language: ${headers.acceptLang}`);
  }
  if (forceIpv4) {
    args.push("--force-ipv4");
    if (DEBUG_AUDIO) console.log(`[yt-dlp] forzando IPv4`);
  }
  const cookieFile = ensureYtDlpCookiesFileFromEnv();
  if (cookieFile) {
    args.push("--cookies", cookieFile);
  }
  // Elegir extractor-args (player_client) según cookies y configuración
  let effectiveClient = ytClient;
  if (!extractorArgsEnv) {
    if (!effectiveClient) {
      // Sin cookies: usar android (más estable) 
      // Con cookies: usar android_embedded (menos bloqueado)
      effectiveClient = cookieFile ? "android_embedded" : "android";
    }
    if (cookieFile && effectiveClient === "android" && !strictClient) {
      // Sin cookies: mantener android para evitar warnings de "yt initial data"
      // Con cookies: usar android_embedded que es más estable
      effectiveClient = "android_embedded";
      if (DEBUG_AUDIO)
        console.log(
          `[yt-dlp] cambiando player_client=android -> android_embedded (cookies presentes)`
        );
    }
    
    // 🛡️ CONFIGURACIÓN ANTI-WARNING: Evitar "unable to extract yt initial data"
    if (effectiveClient) {
      args.push("--extractor-args", `youtube:player_client=${effectiveClient}`);
      // Agregar configuración para evitar API fallbacks que causan warnings
      if (effectiveClient.includes('android')) {
        args.push("--extractor-args", "youtube:player_skip=webpage,configs");
      }
      if (DEBUG_AUDIO)
        console.log(`[yt-dlp] usando player_client=${effectiveClient}`);
    }
  } else {
    args.push("--extractor-args", extractorArgsEnv);
    if (DEBUG_AUDIO) console.log(`[yt-dlp] extractor-args (env): ${extractorArgsEnv}`);
  }
  args.push(url);

  // Preferir: obtener URL directa SOLO si vamos a usarla (evita una invocación extra de yt-dlp en Windows)
  let directUrl = null;
  if (FFMPEG_DIRECT_URL) {
    try {
      directUrl = await getDirectUrlFromYtDlp(url, headers, {
        formats: [
          "bestaudio[acodec=opus]/bestaudio/best",
          "251",
          "bestaudio/best",
        ],
      });
    } catch (e) {
      if (DEBUG_AUDIO)
        console.warn("[yt-dlp] no se obtuvo URL directa:", e?.message || e);
    }
  }

  // ffmpeg para transcodificar a ogg/opus (desde URL directa o pipe como fallback)
  const opusTargetKbps = Math.max(64, Math.min(256, Number(process.env.OPUS_BITRATE || 160)));
  const ffArgs = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-nostdin",
  ];
  // Política: en Windows evitamos input directo por estabilidad a menos que FFMPEG_DIRECT_URL=1
  const useDirect = !!directUrl && (!!FFMPEG_DIRECT_URL);
  if (useDirect) {
    // Cabeceras para acceso (User-Agent y Accept-Language). Evitar Cookie para reducir 400.
    const hdrs = [];
    if (headers?.userAgent) hdrs.push(`User-Agent: ${headers.userAgent}`);
    if (headers?.acceptLang) hdrs.push(`Accept-Language: ${headers.acceptLang}`);
    if (hdrs.length) ffArgs.push("-headers", hdrs.join("\r\n") + "\r\n");
    // Reintentos para fuentes HTTP
    ffArgs.push("-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5");
    // Timeouts y no persistencia para conexiones HTTP
    ffArgs.push("-rw_timeout", "15000000"); // 15s en microsegundos
    ffArgs.push("-http_persistent", "0");
    ffArgs.push("-seekable", "1");
    // Seek antes de -i si corresponde
    if (startAtSec > 0) {
      ffArgs.push("-ss", String(startAtSec));
    }
    ffArgs.push("-i", directUrl);
  } else {
    // Si no hay URL directa, evitamos usar yt-dlp -> stdout por inestabilidad en Windows.
    // En su lugar, obtenemos un stream desde ytdl-core y lo pasamos a ffmpeg.
    // Para el seek, -ss antes de -i para input seek.
    if (startAtSec > 0) {
      ffArgs.push("-ss", String(startAtSec));
    }
    ffArgs.push("-i", "pipe:0");
  }
  ffArgs.push(
    "-vn",
    "-sn",
    "-dn"
  );
  // Filtro de bajos si se configuró
  if (bassGainDb > 0) {
    const g = Math.max(1, Math.min(24, Math.round(bassGainDb)));
    const f = Math.max(20, Math.min(250, Math.round(bassFreq)));
    const w = Math.max(0.1, Math.min(5, Number(bassWidth)));
    ffArgs.push("-af", `bass=g=${g}:f=${f}:w=${w}`);
  }
  ffArgs.push(
    "-ac",
    "2",
    "-ar",
    "48000",
    "-c:a",
    "libopus",
    "-b:a",
    `${opusTargetKbps}k`,
    // Mejorar calidad: VBR activado y nivel de compresión alto
    "-vbr",
    "on",
    "-compression_level",
    "10",
    "-application",
    "audio",
    // 20ms es estándar; 60ms ahorra ancho de banda pero no mejora calidad
    "-frame_duration",
    "20",
    "-f",
    "ogg",
    "pipe:1",
  );
  const ff = spawn(ffmpegPath, ffArgs, { stdio: [useDirect ? "ignore" : "pipe", "pipe", "pipe"] });

  if (!useDirect) {
    // En modo yt-dlp, primero intentamos yt-dlp -> stdout -> ffmpeg (respeta cookies/IPv4)
    let piped = false;
    try {
      const cookieFile2 = ensureYtDlpCookiesFileFromEnv();
      const yArgs = ["--no-playlist", "-f", "bestaudio/best", "-o", "-"];
      if (headers?.userAgent) yArgs.push("--user-agent", headers.userAgent);
      if (headers?.acceptLang) yArgs.push("--add-header", `Accept-Language: ${headers.acceptLang}`);
      if (String(process.env.YT_FORCE_IPV4 || "0") === "1") yArgs.push("--force-ipv4");
      
      // 🚀 OPTIMIZACIONES DE VELOCIDAD PARA YT-DLP
      const fastMode = String(process.env.YT_DLP_FAST_MODE || "0") === "1";
      const noDlpSleep = String(process.env.YT_DLP_NO_SLEEP || "0") === "1";
      
      if (fastMode) {
        // Optimizaciones para máxima velocidad
        yArgs.push("--no-check-certificates"); // Evitar verificación SSL lenta
        yArgs.push("--no-cache-dir"); // No guardar cache en disco (más rápido para uso inmediato)
        yArgs.push("--geo-bypass"); // Intentar bypass geográfico
        if (DEBUG_AUDIO) console.log(`[yt-dlp] 🚀 Modo velocidad activado`);
      }
      
      if (noDlpSleep) {
        yArgs.push("--sleep-interval", "0"); // Sin delays entre requests
        yArgs.push("--max-sleep-interval", "0"); // Sin delays máximos
        if (DEBUG_AUDIO) console.log(`[yt-dlp] ⚡ Delays deshabilitados`);
      }
      
      // Agregar --no-sleep-requests solo si la versión de yt-dlp lo soporta
      if (String(process.env.YT_NO_SLEEP_REQUESTS || "0") === "1") {
        try {
          const supports = await ytDlpSupportsNoSleep();
          if (supports) yArgs.push("--no-sleep-requests");
        } catch {}
      }
      if (cookieFile2) yArgs.push("--cookies", cookieFile2);
      yArgs.push(url);
      const yProc = binPath
        ? spawn(binPath, yArgs, { stdio: ["ignore", "pipe", "pipe"] })
        : ytdlp.raw(url, {
            noPlaylist: true,
            f: "bestaudio/best",
            o: "-",
            ...(headers?.userAgent ? { userAgent: headers.userAgent } : {}),
            ...(headers?.acceptLang ? { addHeader: [`Accept-Language: ${headers.acceptLang}`] } : {}),
            ...(cookieFile2 ? { cookies: cookieFile2 } : {}),
            ...(String(process.env.YT_FORCE_IPV4 || "0") === "1" ? { forceIpv4: true } : {}),
            // 🚀 OPTIMIZACIONES DE VELOCIDAD
            ...(fastMode ? { 
              noCheckCertificates: true,
              noCacheDir: true,
              geoBypass: true 
            } : {}),
            ...(noDlpSleep ? { 
              sleepInterval: 0,
              maxSleepInterval: 0 
            } : {}),
            // Opción no-sleep solo si está soportada
            ...(await (async () => {
              if (String(process.env.YT_NO_SLEEP_REQUESTS || "0") !== "1") return {};
              try { if (await ytDlpSupportsNoSleep()) return { noSleepRequests: true }; } catch {}
              return {};
            })()),
          });
      if (DEBUG_AUDIO) yProc.stderr?.on("data", (d) => console.warn(`[yt-dlp] ${String(d).trim()}`));
      // Pipe a ffmpeg
      yProc.stdout.pipe(ff.stdin);
      piped = true;
      const ignoreErr = (label) => (err) => {
        if (!err) return;
        const code = err?.code || "";
        if (code === "EPIPE" || code === "ECONNRESET") {
          if (DEBUG_AUDIO) console.warn(`[${label}] ${code} (ignorada)`);
          return;
        }
        console.warn(`[${label}]`, err?.message || err);
      };
      yProc.on?.("error", ignoreErr("yt-dlp:proc"));
      yProc.stdout?.on("error", ignoreErr("yt-dlp:stdout"));
      yProc.stdin?.on?.("error", ignoreErr("yt-dlp:stdin"));
    } catch (e) {
      if (DEBUG_AUDIO) console.warn("[yt-dlp] pipe->ffmpeg falló, fallback ytdl-core:", e?.message || e);
    }
    if (!piped) {
      // Fallback: ytdl-core -> ffmpeg
      try {
        const id = extractYouTubeId(url) || url;
        const info = await ytdl.getInfo(id, buildYtdlRequestOptions(id));
        const fmt = selectWebmOpusFormat(info.formats) || ytdl.chooseFormat(info.formats, { quality: "highestaudio", filter: "audioonly" });
        const yStream = ytdl.downloadFromInfo(info, {
          format: fmt,
          highWaterMark: 1 << 25,
          ...buildYtdlRequestOptions(info?.videoDetails?.video_url || id),
        });
        yStream.pipe(ff.stdin);
        const ignoreErr = (label) => (err) => {
          if (!err) return;
          const code = err?.code || "";
          if (code === "EPIPE" || code === "ECONNRESET") {
            if (DEBUG_AUDIO) console.warn(`[${label}] ${code} (ignorada)`);
            return;
          }
          console.warn(`[${label}]`, err?.message || err);
        };
        yStream.on("error", ignoreErr("ytdl:stream"));
      } catch (e) {
        // Si esto falla, cerrar ffmpeg y propagar error para que el caller haga otro fallback.
        try { ff.stdin?.end?.(); } catch {}
        try { ff.kill("SIGKILL"); } catch {}
        throw e;
      }
    }
  }

  if (DEBUG_AUDIO) {
    ff.stderr?.on("data", (d) => console.warn(`[ffmpeg] ${String(d).trim()}`));
  }

  // Manejo de errores para ffmpeg
  const ignoreErr = (label) => (err) => {
    if (!err) return;
    const code = err?.code || "";
    if (code === "EPIPE" || code === "ECONNRESET") {
      if (DEBUG_AUDIO) console.warn(`[${label}] ${code} (ignorada)`);
      return; // suprimir
    }
    console.warn(`[${label}]`, err?.message || err);
  };
  ff.on("error", ignoreErr("ffmpeg:proc"));
  ff.stdout.on("error", ignoreErr("ffmpeg:stdout"));
  ff.stdin?.on?.("error", ignoreErr("ffmpeg:stdin"));

  // Crear recurso
  const out = ff.stdout;
  const cleanup = () => {
    try { ff.kill("SIGKILL"); } catch {}
  };
  out.on("close", cleanup);
  out.on("end", cleanup);
  out.on("error", ignoreErr("ffmpeg:out"));
  const resource = createAudioResource(out, {
    inputType: StreamType.OggOpus,
    inlineVolume: true,
  });
  // Asegurar limpieza si el recurso deja de usarse aguas arriba
  try {
    resource.playStream?.once?.("close", cleanup);
    resource.playStream?.on?.("error", ignoreErr("resource:playStream"));
  } catch {}
  if (resource.volume)
    resource.volume.setVolumeLogarithmic(Math.max(0, Math.min(2, volume)));
  return resource;
}

function getYtDlpBinaryPath() {
  if (G_YTDLP_PATH_CACHE && fs.existsSync(G_YTDLP_PATH_CACHE)) return G_YTDLP_PATH_CACHE;
  // 1) Variable de entorno explícita
  if (process.env.YT_DLP_PATH && fs.existsSync(process.env.YT_DLP_PATH)) {
    G_YTDLP_PATH_CACHE = process.env.YT_DLP_PATH;
    return G_YTDLP_PATH_CACHE;
  }
  // 2) Buscar en PATH con where/which
  try {
    if (process.platform === "win32") {
      const r = spawnSync("where", ["yt-dlp.exe"], { encoding: "utf8" });
      if (r.status === 0) {
        const line = String(r.stdout || "")
          .split(/\r?\n/)
          .find(Boolean);
        if (line && fs.existsSync(line.trim())) {
          G_YTDLP_PATH_CACHE = line.trim();
          return G_YTDLP_PATH_CACHE;
        }
      }
      const r2 = spawnSync("where", ["yt-dlp"], { encoding: "utf8" });
      if (r2.status === 0) {
        const line = String(r2.stdout || "")
          .split(/\r?\n/)
          .find(Boolean);
        if (line && fs.existsSync(line.trim())) {
          G_YTDLP_PATH_CACHE = line.trim();
          return G_YTDLP_PATH_CACHE;
        }
      }
    } else {
      const r = spawnSync("which", ["yt-dlp"], { encoding: "utf8" });
      if (r.status === 0) {
        const line = String(r.stdout || "")
          .split(/\r?\n/)
          .find(Boolean);
        if (line && fs.existsSync(line.trim())) {
          G_YTDLP_PATH_CACHE = line.trim();
          return G_YTDLP_PATH_CACHE;
        }
      }
    }
  } catch {}
  // 3) Rutas comunes en Windows
  if (process.platform === "win32") {
    const guesses = [
      "C:/Windows/yt-dlp.exe",
      "C:/Program Files/yt-dlp/yt-dlp.exe",
      "C:/Program Files (x86)/yt-dlp/yt-dlp.exe",
    ];
    for (const p of guesses) {
      try {
        if (fs.existsSync(p)) {
          G_YTDLP_PATH_CACHE = p;
          return G_YTDLP_PATH_CACHE;
        }
      } catch {}
    }
  }
  return null;
}

async function ytDlpSupportsNoSleep() {
  if (G_YTDLP_SUPPORTS_NO_SLEEP !== undefined) return G_YTDLP_SUPPORTS_NO_SLEEP;
  const bin = getYtDlpBinaryPath();
  if (!bin) {
    G_YTDLP_SUPPORTS_NO_SLEEP = false;
    return false;
  }
  try {
    const out = await new Promise((resolve) => {
      try {
        const p = spawn(bin, ["--help"], { stdio: ["ignore", "pipe", "pipe"] });
        let buf = "";
        p.stdout.on("data", (d) => (buf += String(d)));
        p.on("close", () => resolve(buf));
        p.on("error", () => resolve(""));
      } catch {
        resolve("");
      }
    });
    G_YTDLP_SUPPORTS_NO_SLEEP = /--no-sleep-requests/.test(String(out || ""));
    return G_YTDLP_SUPPORTS_NO_SLEEP;
  } catch {
    G_YTDLP_SUPPORTS_NO_SLEEP = false;
    return false;
  }
}

// Convierte "a=b; c=d" en [{name:'a',value:'b'}, {name:'c',value:'d'}]
function parseCookieHeaderToArray(header) {
  try {
    return String(header)
      .split(";")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((kv) => {
        const idx = kv.indexOf("=");
        if (idx === -1) return null;
        const name = kv.slice(0, idx).trim();
        const value = kv.slice(idx + 1).trim();
        if (!name) return null;
        return { name, value };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Lee cookie de YouTube desde variables de entorno en formato de header "a=b; c=d"
function getYouTubeCookieHeaderFromEnv() {
  try {
    // Prioridad: YT_COOKIE_B64 (base64 de header), YT_COOKIE/YOUTUBE_COOKIE (header plano), YT_COOKIE_FILE (si contiene header plano)
    if (process.env.YT_COOKIE_B64) {
      try {
        const raw = Buffer.from(String(process.env.YT_COOKIE_B64).trim(), "base64").toString("utf8");
        if (raw && raw.includes("=")) return raw.trim();
      } catch {}
    }
    if (process.env.YT_COOKIE) return String(process.env.YT_COOKIE).trim();
    if (process.env.YOUTUBE_COOKIE) return String(process.env.YOUTUBE_COOKIE).trim();
    if (process.env.YT_COOKIE_FILE) {
      try {
        const p = String(process.env.YT_COOKIE_FILE).trim();
        if (p && fs.existsSync(p)) {
          const txt = fs.readFileSync(p, "utf8");
          // Si es Netscape (tabs/cabecera) no sirve para header; retornamos null y se usará archivo para yt-dlp.
          const looksNetscape = /\t/.test(txt) || /Netscape HTTP Cookie File/i.test(txt);
          if (!looksNetscape && txt.includes("=")) return txt.trim();
        }
      } catch {}
    }
  } catch {}
  return null;
}

// Crea (si no existe) un archivo temporal de cookies en formato Netscape
// a partir de la variable de entorno YT_COOKIE/YOUTUBE_COOKIE.
// Devuelve la ruta al archivo o null si no hay cookie.
function ensureYtDlpCookiesFileFromEnv() {
  try {
    // Prioridad: YT_COOKIE_B64 > YT_COOKIE_FILE > YT_COOKIE/YOUTUBE_COOKIE
    let raw = null;
    if (process.env.YT_COOKIE_B64) {
      try {
        raw = Buffer.from(String(process.env.YT_COOKIE_B64).trim(), "base64").toString("utf8");
        if (DEBUG_AUDIO) console.log("[yt-dlp] usando YT_COOKIE_B64 (decodificada)");
      } catch (e) {
        if (DEBUG_AUDIO) console.warn("[yt-dlp] YT_COOKIE_B64 inválida:", e?.message || e);
      }
    }
    if (!raw && process.env.YT_COOKIE_FILE) {
      const p = String(process.env.YT_COOKIE_FILE).trim();
      try {
        if (p && fs.existsSync(p)) {
          raw = fs.readFileSync(p, "utf8");
          if (DEBUG_AUDIO) console.log(`[yt-dlp] usando YT_COOKIE_FILE: ${p}`);
        }
      } catch (e) {
        if (DEBUG_AUDIO) console.warn("[yt-dlp] No se pudo leer YT_COOKIE_FILE:", e?.message || e);
      }
    }
    if (!raw) raw = process.env.YT_COOKIE || process.env.YOUTUBE_COOKIE;
    if (!raw) return G_COOKIE_CACHE.path || null;
    const tmpPath = G_COOKIE_CACHE.path || path.join(os.tmpdir(), `yt_cookies_${process.pid}.txt`);

    let content = String(raw);
    // Si ya calculamos un hash de contenido y no cambió, reutilizamos archivo existente
    const hash = (() => {
      try { return require("crypto").createHash("sha1").update(content).digest("hex"); } catch { return null; }
    })();
    if (G_COOKIE_CACHE.lastHash && hash && hash === G_COOKIE_CACHE.lastHash && G_COOKIE_CACHE.path && fs.existsSync(G_COOKIE_CACHE.path)) {
      if (DEBUG_AUDIO) console.log(`[yt-dlp] usando cookie cache: ${G_COOKIE_CACHE.path}`);
      return G_COOKIE_CACHE.path;
    }
    // Si parece ya ser Netscape (tiene tabs o cabecera), lo usamos tal cual
    const looksNetscape = content.includes("\t") || /Netscape HTTP Cookie File/i.test(content);
    if (!looksNetscape) {
      // Convertimos desde header "a=b; c=d" al formato Netscape para dominios de YouTube
      const pairs = parseCookieHeaderToArray(content);
      const expires = Math.floor(Date.now() / 1000) + 3600 * 24 * 365; // +1 año
      const domains = [
        ".youtube.com",
        ".youtube-nocookie.com",
        ".google.com",
        ".googlevideo.com",
      ];
      const lines = [
        "# Netscape HTTP Cookie File",
        "# This file was generated automatically by the bot.",
      ];
      for (const { name, value } of pairs) {
        for (const domain of domains) {
          // Campos: domain, includeSubdomains, path, secure, expiration, name, value
          lines.push([
            domain,
            "TRUE",
            "/",
            // Marcar como Secure por defecto para mayor compatibilidad
            "TRUE",
            String(expires),
            name,
            value,
          ].join("\t"));
        }
      }
      content = lines.join("\n") + "\n";
    }
    // Validación básica (no imprime valores): ¿faltan cookies críticas?
    if (DEBUG_AUDIO) {
      try {
        const needByDomain = {
          ".google.com": [
            "SID",
            "HSID",
            "SSID",
            "SAPISID",
            "__Secure-1PSID",
            "__Secure-3PSID",
          ],
          ".youtube.com": [
            "VISITOR_INFO1_LIVE",
            "PREF",
          ],
        };
        const have = new Map(); // domain -> Set(names)
        for (const line of content.split(/\r?\n/)) {
          if (!line || line.startsWith("#")) continue;
          const parts = line.split("\t");
          if (parts.length < 7) continue;
          const domain = parts[0]?.trim();
          const name = parts[5]?.trim();
          if (!domain || !name) continue;
          if (!have.has(domain)) have.set(domain, new Set());
          have.get(domain).add(name);
        }
        const warns = [];
        for (const [dom, names] of Object.entries(needByDomain)) {
          const got = have.get(dom) || new Set();
          const missing = names.filter((n) => !got.has(n));
          if (missing.length) warns.push(`${dom}: ${missing.join(", ")}`);
        }
        if (warns.length) {
          console.warn(
            `[yt-dlp] Aviso: cookies Netscape parecen incompletas. Faltan claves críticas -> ${warns.join(" | ")}`
          );
        }
      } catch {}
    }
  // Escribir sólo si es nuevo o cambió
  fs.writeFileSync(tmpPath, content, { encoding: "utf8" });
  G_COOKIE_CACHE.path = tmpPath;
  G_COOKIE_CACHE.lastHash = hash;
  G_COOKIE_CACHE.wrote = true;
  if (DEBUG_AUDIO) console.log(`[yt-dlp] archivo de cookies ${G_COOKIE_CACHE.wrote ? "creado/actualizado" : "reutilizado"}: ${tmpPath}`);
  return G_COOKIE_CACHE.path;
  } catch (e) {
    if (DEBUG_AUDIO) console.warn("[yt-dlp] No se pudo crear archivo de cookies:", e?.message || e);
    return null;
  }
}

// Búsqueda deshabilitada: se requiere URL directa

async function fetchTitle(url) {
  try {
    if (String(process.env.YT_FORCE_YTDLP || "1") !== "1") {
      const info = await playdl.video_info(canonicalizeYouTubeUrl(url));
      return info?.video_details?.title || url;
    }
  } catch {}
  try {
    const meta = await fetchMetadata(url);
    return meta?.title || url;
  } catch {
    return url;
  }
}

async function fetchMetadata(url) {
  const normalized = canonicalizeYouTubeUrl(url);
  const skipPlayDl = String(process.env.YT_FORCE_YTDLP || "1") === "1";
  if (isYouTubeUrl(normalized)) {
    try {
      const id = extractYouTubeId(normalized) || normalized;
      const info = await ytdl.getBasicInfo(id);
      const title = info?.videoDetails?.title || normalized;
      const dur = Number(info?.videoDetails?.lengthSeconds || 0) || 0;
      const thumb =
        (info?.videoDetails?.thumbnails || [])[0]?.url ||
        deriveYouTubeThumb(normalized);
      return {
        title,
        durationSec: dur > 0 ? Math.floor(dur) : 0,
        thumbnailUrl: thumb,
      };
    } catch {}
  }
  if (!skipPlayDl) {
    try {
      const info = await playdl.video_info(normalized);
      const title = info?.video_details?.title || normalized;
      const dur =
        Number(
          info?.video_details?.durationInSec ||
            info?.video_details?.durationInMs / 1000 ||
            0
        ) || 0;
      const thumb =
        info?.video_details?.thumbnails?.[0]?.url ||
        deriveYouTubeThumb(normalized);
      return {
        title,
        durationSec: dur > 0 ? Math.floor(dur) : 0,
        thumbnailUrl: thumb,
      };
    } catch {}
  }
  return {
    title: normalized,
    durationSec: 0,
    thumbnailUrl: deriveYouTubeThumb(normalized),
  };
}

function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function formatBytes(n) {
  const units = ["B", "KB", "MB", "GB", "TB"]; let i = 0; let v = Math.max(0, Number(n)||0);
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${units[i]}`;
}

function getUptime() {
  const sec = Math.floor(process.uptime());
  return formatDuration(sec);
}

function buildProgressBar(totalSec, elapsedSec, size = 20) {
  totalSec = Math.max(1, Number(totalSec) || 1);
  elapsedSec = Math.max(0, Math.min(totalSec, Number(elapsedSec) || 0));
  
  const ratio = elapsedSec / totalSec;
  const filled = Math.max(0, Math.min(size, Math.round(ratio * size)));
  const pos = Math.max(0, Math.min(size - 1, Math.round(ratio * (size - 1))));
  
  // Barras más atractivas con diferentes estilos
  const styles = {
    modern: {
      filled: "━",
      empty: "─", 
      cursor: "🔘",
      brackets: ["┃", "┃"]
    },
    elegant: {
      filled: "▰",
      empty: "▱",
      cursor: "🎵", 
      brackets: ["[", "]"]
    },
    retro: {
      filled: "■",
      empty: "□",
      cursor: "►",
      brackets: ["┤", "├"]
    }
  };
  
  const style = styles.modern; // Puedes cambiarlo por environment variable
  
  const left = style.filled.repeat(pos);
  const right = style.empty.repeat(Math.max(0, size - pos - 1));
  const bar = `${style.brackets[0]}${left}${style.cursor}${right}${style.brackets[1]}`;
  
  const elapsedStr = formatDuration(elapsedSec);
  const totalStr = formatDuration(totalSec);
  const percentage = Math.round(ratio * 100);
  
  return `\`${elapsedStr}\` ${bar} \`${totalStr}\` **${percentage}%**`;
}

function isYouTubePlaylistUrl(url) {
  try {
    const u = new URL(String(url || ""));
    const host = u.hostname.replace(/^www\./, "");
    if (!/(^|\.)youtube\.com$|(^|\.)youtu\.be$|(^|\.)music\.youtube\.com$/i.test(host)) {
      return false;
    }
    const list = u.searchParams.get("list");
    if (!list) return false;
    // /playlist?list=... o watch?v=...&list=... (cola/playlist)
    if (u.pathname === "/playlist") return true;
    // Evitar listas de "Mix" / RD que a veces no son playlists reales; igual las tratamos como playlist
    return !u.searchParams.get("v") || list.startsWith("PL") || list.startsWith("OL") || list.startsWith("LL") || list.startsWith("UU") || list.startsWith("RD");
  } catch {
    return false;
  }
}

// Función para obtener playlist manteniendo el orden original
async function getPlaylistItemsOrdered(playlistUrl) {
  const results = [];
  let playlistInfo = null;
  const preferYtDlp = String(process.env.YT_FORCE_YTDLP || "1") === "1";

  const tryYtDlpPlaylist = async () => {
    if (DEBUG_AUDIO) console.log(`[playlist] Intentando yt-dlp...`);
    const ytdlpPath = getYtDlpBinaryPath();
    if (!ytdlpPath) return null;

    const args = [
      "--flat-playlist",
      "--print-json",
      "--no-warnings",
      `--playlist-end=${MAX_PLAYLIST_ITEMS}`,
      playlistUrl,
    ];

    // Pasar cookies a yt-dlp si están disponibles
    try {
      const cookieFile = ensureYtDlpCookiesFileFromEnv();
      if (cookieFile) args.splice(args.length - 1, 0, "--cookies", cookieFile);
    } catch {}

    return new Promise((resolve, reject) => {
      const proc = spawn(ytdlpPath, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data) => (stdout += data.toString()));
      proc.stderr.on("data", (data) => (stderr += data.toString()));

      proc.on("close", (code) => {
        if (code !== 0) {
          return reject(new Error(`yt-dlp failed: ${stderr}`));
        }

        try {
          const lines = stdout.trim().split("\n").filter((line) => line.trim());
          const items = [];
          let playlistTitle = "Playlist";

          for (let i = 0; i < lines.length && i < MAX_PLAYLIST_ITEMS; i++) {
            const json = JSON.parse(lines[i]);

            if (json._type === "playlist") {
              playlistTitle = json.title || playlistTitle;
              continue;
            }

            const url = json.url || (json.id ? `https://www.youtube.com/watch?v=${json.id}` : null);
            if (url && (json.title || json.id)) {
              items.push({
                url: canonicalizeYouTubeUrl(url),
                title: json.title || `Video ${i + 1}`,
                durationSec: json.duration ? Math.floor(json.duration) : 0,
                thumbnailUrl: deriveYouTubeThumb(url),
                originalIndex: items.length,
              });
            }
          }

          if (DEBUG_AUDIO) console.log(`[playlist] ✅ yt-dlp obtuvo ${items.length} videos`);
          resolve({ items, title: playlistTitle });
        } catch (parseError) {
          reject(parseError);
        }
      });

      setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch {}
        reject(new Error("yt-dlp timeout"));
      }, 30000);
    });
  };

  const tryPlayDlPlaylist = async () => {
    if (DEBUG_AUDIO) console.log(`[playlist] Obteniendo playlist con play-dl...`);
    playlistInfo = await playdl.playlist_info(playlistUrl, { incomplete: false });
    await playlistInfo.fetch();

    const videos = playlistInfo.videos || [];
    if (DEBUG_AUDIO) console.log(`[playlist] Encontrados ${videos.length} videos en play-dl`);

    for (let i = 0; i < Math.min(videos.length, MAX_PLAYLIST_ITEMS); i++) {
      const vid = videos[i];
      if (!vid) continue;

      const url = vid.url || vid.video_url || (vid.id ? `https://www.youtube.com/watch?v=${vid.id}` : null);
      if (!url) continue;

      const title = vid.title || vid.name || `Video ${i + 1}`;
      const duration = Number(vid.durationInSec || vid.durationInMs / 1000 || 0) || 0;

      results.push({
        url: canonicalizeYouTubeUrl(url),
        title,
        durationSec: duration ? Math.floor(duration) : 0,
        thumbnailUrl: deriveYouTubeThumb(url),
        originalIndex: i,
      });
    }

    if (results.length > 0) {
      if (DEBUG_AUDIO) console.log(`[playlist] ✅ Obtenidos ${results.length} videos con play-dl`);
      return { items: results, title: playlistInfo.title || "Playlist" };
    }
    return null;
  };

  // Preferir yt-dlp (evita 429 de play-dl en Render)
  if (preferYtDlp) {
    try {
      const fromYt = await tryYtDlpPlaylist();
      if (fromYt?.items?.length) return fromYt;
    } catch (e) {
      if (DEBUG_AUDIO) console.warn(`[playlist] Error con yt-dlp:`, e?.message);
    }
    try {
      const fromPlay = await tryPlayDlPlaylist();
      if (fromPlay) return fromPlay;
    } catch (e) {
      if (DEBUG_AUDIO) console.warn(`[playlist] Error con play-dl:`, e?.message);
    }
  } else {
    try {
      const fromPlay = await tryPlayDlPlaylist();
      if (fromPlay) return fromPlay;
    } catch (e) {
      if (DEBUG_AUDIO) console.warn(`[playlist] Error con play-dl:`, e?.message);
    }
    try {
      const fromYt = await tryYtDlpPlaylist();
      if (fromYt?.items?.length) return fromYt;
    } catch (e) {
      if (DEBUG_AUDIO) console.warn(`[playlist] Error con yt-dlp:`, e?.message);
    }
  }

  return {
    items: results,
    title: playlistInfo?.title || "Playlist",
  };
}

// Función para formatear información de calidad de audio
function formatAudioQuality(sourceQuality, showDetailed = false) {
  const opusTargetKbps = Math.max(64, Math.min(256, Number(process.env.OPUS_BITRATE || 160)));
  
  if (!sourceQuality || sourceQuality === "desconocida") {
    return showDetailed 
      ? `No detectada (original) → ${opusTargetKbps}kbps Opus (salida)`
      : `${opusTargetKbps}kbps Opus`;
  }
  
  return showDetailed
    ? `${sourceQuality} (original) → ${opusTargetKbps}kbps Opus (salida)`
    : `${sourceQuality} → ${opusTargetKbps}kbps Opus`;
}

// Función para calcular el tiempo real transcurrido incluyendo seeks
function getActualElapsedTime(q) {
  if (!q || !q.player?.state?.resource) return 0;
  
  const playbackDuration = Math.floor((q.player.state.resource.playbackDuration || 0) / 1000);
  
  // Si hay un seek reciente, ajustar el tiempo
  if (q._lastSeekTime !== undefined && q._lastSeekTimestamp) {
    const timeSinceSeek = Math.floor((Date.now() - q._lastSeekTimestamp) / 1000);
    return q._lastSeekTime + timeSinceSeek;
  }
  
  // Tiempo normal sin seeks
  return playbackDuration;
}

// Función mejorada para mostrar información detallada de la canción
function buildEnhancedSongInfo(song, elapsed = 0) {
  const metadata = getCachedMetadata(song.url) || {};
  
  let info = `🎵 **${song.title}**\n`;
  
  // Información adicional si está disponible
  if (metadata.views && metadata.views > 0) {
    const views = metadata.views > 1000000 
      ? `${(metadata.views / 1000000).toFixed(1)}M`
      : metadata.views > 1000 
        ? `${(metadata.views / 1000).toFixed(0)}K` 
        : metadata.views.toString();
    info += `👀 ${views} visualizaciones\n`;
  }
  
  if (metadata.quality) {
    info += `🎧 Calidad: ${formatAudioQuality(metadata.quality)}\n`;
  } else {
    info += `🎧 Salida: ${formatAudioQuality(null)}\n`;
  }
  
  // Barra de progreso si hay duración
  if (song.durationSec && song.durationSec > 0) {
    info += `\n${buildProgressBar(song.durationSec, elapsed)}\n`;
  } else {
    info += `\n🔴 **TRANSMISIÓN EN VIVO**\n`;
  }
  
  return info;
}

// Render de cola (queue) para reuso en respuestas
function formatQueueMessage(q, limit = 10) {
  if (!q || !Array.isArray(q.songs) || q.songs.length === 0)
    return "La cola está vacía.";
  const elapsed = Math.floor(
    (q.player?.state?.resource?.playbackDuration || 0) / 1000
  );
  const lines = q.songs.slice(0, limit).map((s, i) => {
    const dur = s.durationSec ? ` [${formatDuration(s.durationSec)}]` : "";
    if (i === 0) {
      const left = s.durationSec
        ? ` (${formatDuration(elapsed)} / ${formatDuration(s.durationSec)})`
        : "";
      return `▶️ ${s.title}${dur}${left}`;
    }
    return `${i + 1}. ${s.title}${dur}`;
  });
  if (q.songs.length > limit) lines.push(`... y ${q.songs.length - limit} más`);
  return lines.join("\n");
}

// ======================
// Registro de Slash Commands
// ======================
async function registerSlashCommands() {
  const commands = [
    {
      name: "play",
      description: "Reproducir por URL o playlist (YouTube o Spotify)",
      options: [
        {
          name: "query",
          description: "URL a reproducir (o playlist de YouTube o Spotify)",
          type: 3, // STRING
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
          type: 3, // STRING
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
          type: 4, // INTEGER
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
          type: 4, // INTEGER
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
          type: 3, // STRING
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
    { name: "ping", description: "Ping y latencia del bot" },
    { name: "stats", description: "Estadísticas del bot" },
    {
      name: "shuffle",
      description: "Alternar modo aleatorio para la cola",
    },
    {
      name: "seek",
      description: "Saltar a un segundo específico de la canción actual",
      options: [
        {
          name: "seconds",
          description: "Segundo al que quieres saltar (0..duración)",
          type: 4, // INTEGER
          required: true,
        },
      ],
    },
    {
      name: "mystats",
      description: "Ver tus estadísticas musicales personales",
    },
    {
      name: "reload",
      description: "Recargar metadatos de la canción actual",
    },
  ];

  const scope = String(process.env.COMMANDS_SCOPE || "global").toLowerCase();
  const devGuildId = process.env.DEV_GUILD_ID && String(process.env.DEV_GUILD_ID);
  try {
    if (scope === "guild") {
      // Limpiar global para evitar duplicados y registrar por guild
      try {
        await client.application.commands.set([]);
        console.log("[slash] Global limpiados (scope=guild)");
      } catch (e) {
        console.warn("[slash] No se pudieron limpiar global:", e?.message || e);
      }

      const targets = [];
      if (devGuildId) {
        const g = client.guilds.cache.get(devGuildId);
        if (g) targets.push(g);
        else console.warn(`[slash] DEV_GUILD_ID=${devGuildId} no está en caché`);
      } else {
        for (const g of client.guilds.cache.values()) targets.push(g);
      }
      for (const g of targets) {
        try {
          await g.commands.set(commands);
          console.log(`[slash] Registrados en guild ${g.id}`);
        } catch (e) {
          console.error(`[slash] Error registrando en guild ${g?.id}:`, e?.message || e);
        }
      }
    } else {
      // Limpiar comandos por guild para evitar duplicados y registrar global
      for (const g of client.guilds.cache.values()) {
        try { await g.commands.set([]); } catch {}
      }
      await client.application.commands.set(commands);
      console.log("[slash] Comandos registrados globalmente (scope=global)");
    }
  } catch (e) {
    console.error("[slash:register:error]", e?.message || e);
  }
}

// clientReady: evento recomendado ("ready" quedará deprecado en v15)
client.once("clientReady", async (c) => {
  console.log(`[bot] Conectado como ${c.user?.tag || c.user?.id}`);
  try { await registerSlashCommands(); } catch {}
  
});

function canonicalizeYouTubeUrl(input) {
  try {
    const u = new URL(input);
    // Normalizar YouTube Music playlists a YouTube web
    if (/(^|\.)music\.youtube\.com$/i.test(u.hostname)) {
      // playlist -> youtube.com/playlist?list=...
      const list = u.searchParams.get("list");
      if (u.pathname === "/playlist" && list) {
        return `https://www.youtube.com/playlist?list=${list}`;
      }
      // watch -> youtube.com/watch?v=... (mantener list si viene)
      const v = u.searchParams.get("v");
      if (u.pathname === "/watch" && v) {
        const listQ = u.searchParams.get("list");
        return listQ
          ? `https://www.youtube.com/watch?v=${v}&list=${listQ}`
          : `https://www.youtube.com/watch?v=${v}`;
      }
    }
    // youtu.be short links -> watch?v=
    if (/^youtu\.be$/i.test(u.hostname)) {
      const id = u.pathname.replace(/^\//, "").split(/[/?&]/)[0];
      return id ? `https://www.youtube.com/watch?v=${id}` : input;
    }
    // youtube shorts -> watch?v=
    if (
      /youtube\.com$/i.test(u.hostname) &&
      u.pathname.startsWith("/shorts/")
    ) {
      const id = u.pathname.split("/")[2];
      return id ? `https://www.youtube.com/watch?v=${id}` : input;
    }
    // youtube.com with v param -> normalize to watch?v=
  if (/youtube\.com$/i.test(u.hostname)) {
      const v = u.searchParams.get("v");
      if (v) return `https://www.youtube.com/watch?v=${v}`;
    }
    return input;
  } catch {
    return input;
  }
}

function isYouTubeUrl(input) {
  try {
    const u = new URL(input);
    return (
      /(^|\.)youtube\.com$/i.test(u.hostname) ||
      /^youtu\.be$/i.test(u.hostname) ||
      /(^|\.)music\.youtube\.com$/i.test(u.hostname)
    );
  } catch {
    return false;
  }
}

function extractYouTubeId(input) {
  try {
    const u = new URL(input);
    if (/^youtu\.be$/i.test(u.hostname)) {
      const id = u.pathname.replace(/^\//, "").split(/[/?&]/)[0];
      return id || null;
    }
    if (/youtube\.com$/i.test(u.hostname)) {
      if (u.pathname.startsWith("/shorts/")) {
        const id = u.pathname.split("/")[2];
        return id || null;
      }
      if (u.pathname === "/watch") {
        const v = u.searchParams.get("v");
        if (v) return v;
      }
      // Si es playlist URL, no tiene videoId
      if (u.pathname === "/playlist") return null;
    }
  } catch {}
  // Regex extra por si viene texto raro
  const m = String(input).match(/[?&]v=([a-zA-Z0-9_-]{6,})(?:&|$)/);
  if (m) return m[1];
  const n = String(input).match(/youtu\.be\/([a-zA-Z0-9_-]{6,})(?:[?&]|$)/);
  if (n) return n[1];
  return null;
}

function deriveYouTubeThumb(url) {
  const id = extractYouTubeId(url);
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : undefined;
}

function selectWebmOpusFormat(formats, preference = "highest") {
  if (!Array.isArray(formats)) return null;
  
  // Filtrar candidatos WebM/Opus
  let candidates = formats.filter((f) => {
    const a = (f.audioCodec || f.codecs || f.codec || "").toString();
    const container = (f.container || "").toString();
    const mime = (f.mimeType || "").toString();
    const isWebm = /webm/i.test(container) || /webm/i.test(mime);
    const isOpus = /opus/i.test(a) || /opus/i.test(mime);
    const hasAudio = f.hasAudio !== false || /audio\//i.test(mime);
    return hasAudio && isWebm && isOpus && f.url;
  });
  
  // Si FORCE_BEST_AUDIO está activado, incluir también otros formatos de alta calidad
  if (FORCE_BEST_AUDIO && candidates.length === 0) {
    candidates = formats.filter((f) => {
      const hasAudio = f.hasAudio !== false || /audio\//i.test(f.mimeType || "");
      const hasGoodBitrate = (f.audioBitrate || 0) >= 128;
      return hasAudio && hasGoodBitrate && f.url;
    });
    if (DEBUG_AUDIO) console.log(`[selectFormat] FORCE_BEST_AUDIO: encontrados ${candidates.length} formatos alternativos`);
  }
  
  if (candidates.length === 0) return null;
  
  // Ordenar por bitrate de audio
  candidates.sort((a, b) => (a.audioBitrate || 0) - (b.audioBitrate || 0));
  
  const selected = preference === "lowest" ? candidates[0] : candidates[candidates.length - 1];
  
  if (DEBUG_AUDIO) {
    console.log(`[selectFormat] Seleccionado: ${selected.audioCodec || 'unknown codec'}, ${selected.audioBitrate || 'unknown bitrate'}kbps`);
  }
  
  return selected;
}

// Construye opciones (cookies y headers) para llamadas de ytdl/miniget
function buildYtdlRequestOptions(videoIdOrUrl) {
  const ytCookie = process.env.YT_COOKIE || process.env.YOUTUBE_COOKIE;
  const userAgent =
    process.env.YTDL_USER_AGENT ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
  const acceptLang =
    process.env.YTDL_ACCEPT_LANGUAGE || "es-ES,es;q=0.9,en;q=0.8";
  let referer;
  try {
    if (videoIdOrUrl) {
      if (/^https?:\/\//i.test(String(videoIdOrUrl))) {
        const url = canonicalizeYouTubeUrl(String(videoIdOrUrl));
        if (isYouTubeUrl(url)) referer = url;
      } else if (/^[a-zA-Z0-9_-]{6,}$/.test(String(videoIdOrUrl))) {
        referer = `https://www.youtube.com/watch?v=${videoIdOrUrl}`;
      }
    }
  } catch {}
  const headers = {
    "user-agent": userAgent,
    "accept-language": acceptLang,
  };
  // Si no podemos construir el formato nuevo, dejamos el viejo en headers
  const cookiesArray = ytCookie ? parseCookieHeaderToArray(ytCookie) : null;
  if (!cookiesArray || cookiesArray.length === 0) {
    if (ytCookie) headers.cookie = ytCookie;
  }
  if (referer) headers.referer = referer;
  // Construir opciones en nuevo formato si hay cookies
  const opts = { requestOptions: { headers } };
  if (cookiesArray && cookiesArray.length) {
    opts.requestOptions.cookies = cookiesArray;
  }
  return opts;
}

// Crear recurso directamente desde info de ytdl (evita pedir info de nuevo)
function createResourceFromYtdlInfo(info, volume = 1.0) {
  try {
    const fmt = selectWebmOpusFormat(info.formats, "highest");
    if (fmt) {
      const vidRef =
        info?.videoDetails?.video_url ||
        (info?.videoDetails?.videoId
          ? `https://www.youtube.com/watch?v=${info.videoDetails.videoId}`
          : undefined);
      const ytdlOpts = {
        format: fmt,
        highWaterMark: 1 << 25,
        ...buildYtdlRequestOptions(vidRef),
      };
      const stream = ytdl.downloadFromInfo(info, ytdlOpts);
      const resource = createAudioResource(stream, {
        inputType: StreamType.WebmOpus,
        inlineVolume: true,
      });
      if (resource.volume)
        resource.volume.setVolumeLogarithmic(Math.max(0, Math.min(2, volume)));
      return resource;
    }
    const vidRef =
      info?.videoDetails?.video_url ||
      (info?.videoDetails?.videoId
        ? `https://www.youtube.com/watch?v=${info.videoDetails.videoId}`
        : undefined);
    const fallbackStream = ytdl.downloadFromInfo(info, {
      quality: "highestaudio",
      filter: "audioonly",
      highWaterMark: 1 << 25,
      ...buildYtdlRequestOptions(vidRef),
    });
    const resource = createAudioResource(fallbackStream, {
      inputType: StreamType.Arbitrary,
      inlineVolume: true,
    });
    if (resource.volume)
      resource.volume.setVolumeLogarithmic(Math.max(0, Math.min(2, volume)));
    return resource;
  } catch (e) {
    return null;
  }
}

function createFastStartResourceFromYtdlInfo(info, volume = 1.0) {
  try {
    const fmt = selectWebmOpusFormat(info.formats, "lowest");
    if (!fmt) return null;
    const vidRef =
      info?.videoDetails?.video_url ||
      (info?.videoDetails?.videoId
        ? `https://www.youtube.com/watch?v=${info.videoDetails.videoId}`
        : undefined);
    const stream = ytdl.downloadFromInfo(info, {
      format: fmt,
      highWaterMark: 1 << 22,
      dlChunkSize: 1 << 20,
      ...buildYtdlRequestOptions(vidRef),
    });
    const resource = createAudioResource(stream, {
      inputType: StreamType.WebmOpus,
      inlineVolume: true,
    });
    if (resource.volume)
      resource.volume.setVolumeLogarithmic(Math.max(0, Math.min(2, volume)));
    return resource;
  } catch {
    return null;
  }
}

// 🚀 SISTEMA DE PRECARGA INTELIGENTE
// Se activa cuando la descarga actual termine, no inmediatamente
function setupSmartPreload(resource, guildId) {
  if (!ENABLE_PRELOAD) return;
  
  const q = queues.get(guildId);
  if (!q || q.songs.length < 2) return;
  
  try {
    // Detectar cuando el stream readable termina de descargar
    let downloadComplete = false;
    let preloadStarted = false;
    
    const checkDownloadStatus = () => {
      if (preloadStarted) return;
      
      // Si el stream está en estado "readable" y no hay más datos llegando,
      // o si ha pasado suficiente tiempo, consideramos la descarga completa
      const now = Date.now();
      const startTime = resource.playbackDuration || now;
      const elapsedMs = now - startTime;
      
      // Activar precarga después de 3-5 segundos de reproducción activa
      if (elapsedMs > 3000 && !downloadComplete) {
        downloadComplete = true;
        preloadStarted = true;
        
        if (DEBUG_AUDIO) {
          console.log(`[smart-preload] 🚀 Activando precarga para guild ${guildId} después de ${Math.floor(elapsedMs/1000)}s`);
        }
        
        // Activar precarga con un pequeño delay para no competir
        setTimeout(() => {
          preloadNextSong(guildId);
        }, 1000);
      }
    };
    
    // Verificar estado cada 2 segundos
    const checkInterval = setInterval(checkDownloadStatus, 2000);
    
    // Limpiar interval cuando la canción termine o cambie
    const cleanup = () => {
      clearInterval(checkInterval);
    };
    
    // Limpiar cuando el player cambie de estado
    q.player.once('stateChange', cleanup);
    
    // Backup: activar precarga máximo después de 10 segundos
    setTimeout(() => {
      if (!preloadStarted) {
        preloadStarted = true;
        if (DEBUG_AUDIO) {
          console.log(`[smart-preload] ⏰ Activando precarga por timeout para guild ${guildId}`);
        }
        preloadNextSong(guildId);
      }
      cleanup();
    }, 10000);
    
  } catch (error) {
    if (DEBUG_AUDIO) {
      console.error('[smart-preload] Error configurando precarga:', error.message);
    }
  }
}

async function playNext(guildId) {
  const q = queues.get(guildId);
  if (!q || q.songs.length === 0) return;
  
  // Limpiar timeout de idle al empezar a reproducir una nueva canción
  clearIdleTimeout(guildId);
  
  const current = q.songs[0];
  try {
    // cancelar cualquier upgrade pendiente de pista anterior
    if (q.upgradeTimer) {
      try {
        clearTimeout(q.upgradeTimer);
      } catch {}
      q.upgradeTimer = null;
    }

    let resource = null;
    const fastStartEnabled = String(process.env.FAST_START || "1") === "1";
    const ultraFastStart = String(process.env.FAST_START_ULTRA || "0") === "1";
    
    // 🚀 CONFIGURACIÓN DE INICIO ULTRA RÁPIDO
    const baseDelay = ultraFastStart ? 800 : 2000; // Ultra rápido: 800ms, normal: 2000ms
    const fastDelayMs = Math.max(
      ultraFastStart ? 300 : 500, // Mínimo más bajo para ultra rápido
      Math.min(8000, Number(process.env.FAST_START_MS || baseDelay))
    );
    
    const longEnough = (current.durationSec || 0) >= 60;
    const forceYtDlp = String(process.env.YT_FORCE_YTDLP || "1") === "1";
    const speedPriority = String(process.env.FIRST_SONG_SPEED_PRIORITY || "0") === "1";

    const bassActive = (Number(q.bassGainDb) || 0) > 0;

    // 🚀 INTENTAR USAR RECURSO PRECARGADO PRIMERO (SIEMPRE LA OPCIÓN MÁS RÁPIDA)
    const preloadedResource = getPreloadedResource(guildId, current.url);
    if (preloadedResource && !bassActive) {
      console.log(`[playNext] ⚡ Usando recurso precargado para: ${current.title}`);
      resource = preloadedResource;
    }
    // 🚀 MODO VELOCIDAD: Priorizar inicio rápido sobre calidad perfecta
    else if (speedPriority || ultraFastStart) {
      // Si hay ytdlInfo, usar fast start siempre (incluso para canciones cortas)
      if (!forceYtDlp && !bassActive && current.ytdlInfo && fastStartEnabled) {
        resource = createFastStartResourceFromYtdlInfo(
          current.ytdlInfo,
          q.volume ?? 1.0
        ) || createResourceFromYtdlInfo(current.ytdlInfo, q.volume ?? 1.0);
        if (DEBUG_AUDIO && resource) console.log(`[playNext] ⚡ Fast start aplicado (prioridad velocidad)`);
      }
      // Fallback rápido con createResourceFromUrl optimizado
      if (!resource) {
        if (DEBUG_AUDIO) console.log(`[playNext] ⚡ Usando createResourceFromUrl con optimización de velocidad`);
      }
    }
    // Fallback al sistema original si no está en modo velocidad
    else if (!forceYtDlp && !bassActive && current.ytdlInfo && fastStartEnabled && longEnough) {
      resource =
        createFastStartResourceFromYtdlInfo(
          current.ytdlInfo,
          q.volume ?? 1.0
        ) || createResourceFromYtdlInfo(current.ytdlInfo, q.volume ?? 1.0);
    } else if (!forceYtDlp && !bassActive && current.ytdlInfo) {
      resource = createResourceFromYtdlInfo(current.ytdlInfo, q.volume ?? 1.0);
    }
    
    // Último recurso: createResourceFromUrl
    if (!resource) {
      resource = await createResourceFromUrl(current.url, q.volume ?? 1.0, {
        forceFfmpeg: bassActive,
        bassGainDb: q.bassGainDb,
        bassFreq: DEFAULT_BASS_FREQ,
        bassWidth: DEFAULT_BASS_WIDTH,
      });
    }

    q.player.play(resource);

    // 🚀 PRECARGA INTELIGENTE: Se activará cuando la descarga actual termine
    setupSmartPreload(resource, guildId);
    
    // 📊 ACTUALIZAR ESTADÍSTICAS DE USUARIO Y WEB
    const requestedBy = current.requestedById;
    if (requestedBy) {
      updateUserStats(requestedBy, guildId, 'song_played');
      updateUserStats(requestedBy, guildId, 'session_start');
      
      // Estadísticas web
      updateWebStats('song_played', {
        userId: requestedBy,
        guildId: guildId,
        title: current.title,
        url: current.url
      });
    }

    // Programar upgrade a mayor calidad si aplica
    if (current.ytdlInfo && fastStartEnabled && longEnough) {
      const token = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
      q.currentTrackToken = token;
      q.upgradeTimer = setTimeout(async () => {
        try {
          if (!queues.has(guildId)) return;
          const qq = queues.get(guildId);
          if (!qq || qq.currentTrackToken !== token) return;
          if (qq.player?.state?.status !== AudioPlayerStatus.Playing) return;
          const bestRes = (!bassActive) ? createResourceFromYtdlInfo(
            current.ytdlInfo,
            qq.volume ?? 1.0
          ) : null;
          if (!bestRes) return;
          qq.player.play(bestRes);
          if (DEBUG_AUDIO) console.log("[fast-start] upgraded to high quality");
        } catch {}
      }, fastDelayMs);
    }

    // Evitar duplicados: sólo actualizar si ya existe un panel asignado
    if (q.nowPlayingMessageId) {
      try {
        await renderNowPlaying(guildId);
      } catch (e) {
        if (DEBUG_AUDIO)
          console.warn("[renderNowPlaying:error]", e?.message || e);
      }
      try {
        startNowPlayingTicker(guildId);
      } catch {}
    }
  } catch (e) {
    console.error("[playNext:error]", e?.message || e, "url:", current?.url);
    // Fallback: reintentar vía createResource (yt-dlp por defecto; evita play-dl/429)
    try {
      const fallbackRes = await createResourceFromUrl(
        current.url,
        q.volume ?? 1.0,
        {}
      );
      q.player.play(fallbackRes);
      if (q.nowPlayingMessageId) {
        try {
          await renderNowPlaying(guildId);
        } catch {}
        try {
          startNowPlayingTicker(guildId);
        } catch {}
      }
      return;
    } catch (e2) {
      if (DEBUG_AUDIO)
        console.warn("[playNext:fallback-playdl:failed]", e2?.message || e2);
    }
    // Notificar y saltar esta pista
    try {
      if (q.textChannelId) {
        const ch = await client.channels
          .fetch(q.textChannelId)
          .catch(() => null);
        if (ch?.isTextBased?.()) {
          await ch
            .send(
              `⚠️ No se pudo reproducir: ${
                current?.title || current?.url || "pista"
              } — siguiente canción...`
            )
            .catch(() => {});
        }
      }
    } catch {}
    q.songs.shift();
    if (q.songs.length > 0) {
      playNext(guildId).catch((err) =>
        console.error("[playNext:chain:error]", err)
      );
    } else {
      const conn = getVoiceConnection(guildId);
      conn?.destroy();
      queues.delete(guildId);
      clearNowPlaying(guildId).catch(() => {});
      try {
        stopNowPlayingTicker(guildId);
      } catch {}
    }
  }
}

function startNowPlayingTicker(guildId) {
  const q = queues.get(guildId);
  if (!q) return;
  if (q.uiInterval) {
    try {
      clearInterval(q.uiInterval);
    } catch {}
  }
  q.uiInterval = setInterval(() => {
    const qq = queues.get(guildId);
    if (!qq) return stopNowPlayingTicker(guildId);
    if (!qq.nowPlayingMessageId || qq.songs.length === 0) return;
    // Solo refrescar cuando realmente está reproduciendo
    if (qq.player?.state?.status !== AudioPlayerStatus.Playing) return;
    renderNowPlaying(guildId).catch(() => {});
  }, 1_000);
}

function stopNowPlayingTicker(guildId) {
  const q = queues.get(guildId);
  if (!q || !q.uiInterval) return;
  try {
    clearInterval(q.uiInterval);
  } catch {}
  q.uiInterval = null;
}

// ===== UI: Now Playing Embed + Botones =====
function buildControlsComponents(q) {
  const isPaused = q.player.state.status === AudioPlayerStatus.Paused || q.isPausedByUser;
  const s = q.songs?.[0];
  const vol = Math.max(0, Math.min(2, q.volume ?? 1));
  const volDownDisabled = vol <= 0.01;
  const volUpDisabled = vol >= 1.99;
  const canShuffle = (q.songs?.length || 0) > 2;
  const hasSong = !!s;
  const canSeek = hasSong && s?.durationSec && s.durationSec > 30; // Solo para canciones con duración > 30s
  
  // Fila 1: transporte básico
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("music_replay")
      .setEmoji("🔄")
      .setLabel("Reiniciar")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasSong),
    new ButtonBuilder()
      .setCustomId(isPaused ? "music_resume" : "music_pause")
      .setEmoji(isPaused ? "▶️" : "⏸️")
      .setLabel(isPaused ? "Reanudar" : "Pausar")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!hasSong),
    new ButtonBuilder()
      .setCustomId("music_skip")
      .setEmoji("⏭️")
      .setLabel("Siguiente")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasSong),
    new ButtonBuilder()
      .setCustomId("music_stop")
      .setEmoji("🛑")
      .setLabel("Detener")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("music_loop")
      .setEmoji("🔁")
      .setLabel("Bucle")
      .setStyle(q.loop ? ButtonStyle.Success : ButtonStyle.Secondary)
  );
  
  // Fila 2: controles de navegación y volumen
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("music_seek_back")
      .setEmoji("⏪")
      .setLabel("-10s")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!canSeek),
    new ButtonBuilder()
      .setCustomId("music_seek_forward")
      .setEmoji("⏩")
      .setLabel("+10s")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!canSeek),
    new ButtonBuilder()
      .setCustomId("music_vol_down")
      .setEmoji("🔉")
      .setLabel("Vol -")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(volDownDisabled),
    new ButtonBuilder()
      .setCustomId("music_vol_up")
      .setEmoji("🔊")
      .setLabel("Vol +")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(volUpDisabled),
    new ButtonBuilder()
      .setCustomId("music_shuffle")
      .setEmoji("🔀")
      .setLabel("Aleatorio")
      .setStyle(q.shuffleMode ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(!canShuffle)
  );
  
  // Fila 3: utilidades y enlaces
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("music_save")
      .setEmoji("⭐")
      .setLabel("Guardar")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasSong),
    new ButtonBuilder()
      .setCustomId("music_queue")
      .setEmoji("📜")
      .setLabel("Cola")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!(q.songs?.length > 0))
  );
  
  if (s?.url) {
    row3.addComponents(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setURL(s.url)
        .setEmoji("🌐")
        .setLabel("Abrir")
    );
  }
  
  return [row1, row2, row3];
}

function buildNowPlayingEmbed(q, guild) {
  const s = q.songs?.[0];
  
  // Si no hay canciones, verificar si estamos en modo idle
  if (!s) {
    // Encontrar el guildId para verificar si hay timeout de idle activo
    let guildId = null;
    for (const [gId, queue] of queues.entries()) {
      if (queue === q) {
        guildId = gId;
        break;
      }
    }
    
    const hasIdleTimeout = guildId && idleTimeouts.has(guildId);
    
    const embed = new EmbedBuilder()
      .setColor(hasIdleTimeout ? 0xffa500 : 0x808080) // Naranja si en idle, gris si parado
      .setTitle(hasIdleTimeout ? "⏳ En espera" : "⏹️ Sin reproducción")
      .addFields({
        name: "🎵 Estado:",
        value: hasIdleTimeout 
          ? `Esperando nuevas canciones...\n⏰ Se desconectará en ${IDLE_TIMEOUT_MINUTES} minutos si no se agrega música.`
          : "No hay canciones en la cola",
        inline: false,
      });
      
    if (hasIdleTimeout) {
      embed.addFields({
        name: "💡 Consejo:",
        value: "Usa `/play` para agregar música y cancelar la desconexión automática",
        inline: false,
      });
    }
    
    embed.setFooter({
      text: `🎛️ Controles debajo · Vol: ${Math.round((q.volume ?? 1) * 100)}% · Repetir: ${q.loop ? "🔁" : "❌"} · Aleatorio: ${q.shuffleMode ? "🔀" : "❌"} · Bass: ${q.bassGainDb > 0 ? `+${q.bassGainDb}dB` : "❌"}`,
    });
    
    return embed;
  }
  
  const elapsed = Math.floor(
    (q.player?.state?.resource?.playbackDuration || 0) / 1000
  );
  const total = s?.durationSec || 0;
  
  // Obtener metadatos mejorados del cache
  const metadata = getCachedMetadata(s?.url) || {};
  const thumbnail = metadata.thumbnail || s?.thumbnailUrl;
  
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(
      (q.player?.state?.status === AudioPlayerStatus.Paused || q.isPausedByUser)
        ? "⏸️ Pausado"
        : "🎶 Reproduciendo ahora"
    )
    .addFields(
      {
        name: "🎵 Canción:",
        value: s ? `[${s.title}](${s.url})` : "—",
        inline: false,
      },
      {
        name: "👤 Agregado por:",
        value: s?.requestedById
          ? `<@${s.requestedById}>`
          : guild?.members?.me?.toString() || "—",
        inline: true,
      },
      {
        name: "⏱️ Duración:",
        value: total ? formatDuration(total) : "🔴 EN VIVO",
        inline: true,
      }
    );

  // Agregar información adicional si está disponible
  if (metadata.quality) {
    embed.addFields({
      name: "🎧 Calidad:",
      value: formatAudioQuality(metadata.quality),
      inline: true,
    });
  } else {
    embed.addFields({
      name: "🎧 Salida:",
      value: formatAudioQuality(null),
      inline: true,
    });
  }

  if (metadata.views && metadata.views > 0) {
    const views = metadata.views > 1000000 
      ? `${(metadata.views / 1000000).toFixed(1)}M`
      : metadata.views > 1000 
        ? `${(metadata.views / 1000).toFixed(0)}K` 
        : metadata.views.toString();
    embed.addFields({
      name: "👀 Visualizaciones:",
      value: views,
      inline: true,
    });
  }

  // Cola información si hay más canciones
  if (q.songs.length > 1) {
    const nextSongs = q.songs.slice(1, 4).map((song, i) => 
      `${i + 1}. ${song.title.length > 30 ? song.title.substring(0, 30) + '...' : song.title}`
    ).join('\n');
    
    const remaining = q.songs.length - 1;
    const queueText = remaining > 3 
      ? `${nextSongs}\n... y ${remaining - 3} más canciones`
      : nextSongs;
    
    embed.addFields({
      name: `📝 Próximas en cola (${remaining})`,
      value: queueText || "—",
      inline: false,
    });
  }

  embed.setFooter({
    text: `🎛️ Controles debajo · Vol: ${Math.round((q.volume ?? 1) * 100)}% · Repetir: ${q.loop ? "🔁" : "❌"} · Aleatorio: ${q.shuffleMode ? "🔀" : "❌"} · Bass: ${q.bassGainDb > 0 ? `+${q.bassGainDb}dB` : "❌"}`,
  });

  if (total) {
    embed.setDescription(buildProgressBar(total, elapsed));
  } else {
    embed.setDescription("🔴 **TRANSMISIÓN EN VIVO** - Sin barra de progreso");
  }

  // Usar thumbnail de alta calidad con fallbacks
  if (thumbnail) {
    // Intentar obtener la mejor calidad
    let bestThumbnail = thumbnail;
    if (thumbnail.includes('youtube.com') || thumbnail.includes('ytimg.com')) {
      // Para YouTube, intentar obtener maxresdefault (1280x720)
      const videoId = s?.url?.match(/(?:v=|\/)([\w-]{11})/)?.[1];
      if (videoId) {
        bestThumbnail = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
      }
    }
    embed.setThumbnail(bestThumbnail);
  }

  return embed;
}

async function renderNowPlaying(guildId) {
  const q = queues.get(guildId);
  if (!q || !q.textChannelId) return;
  const channel = await client.channels
    .fetch(q.textChannelId)
    .catch(() => null);
  if (!channel || !channel.isTextBased?.()) return;
  const canEmbed = !!channel
    .permissionsFor?.(channel.guild?.members?.me)
    ?.has(PermissionsBitField.Flags.EmbedLinks);
  const embed = canEmbed ? buildNowPlayingEmbed(q, channel.guild) : null;
  const components = buildControlsComponents(q);
  const contentFallback = (() => {
    const s = q.songs?.[0];
    if (!s) {
      // Verificar si estamos en modo idle
      const hasIdleTimeout = idleTimeouts.has(guildId);
      if (hasIdleTimeout) {
        return `⏳ **En espera**\n\nEsperando nuevas canciones...\n⏰ Se desconectará en ${IDLE_TIMEOUT_MINUTES} minutos si no se agrega música.`;
      }
      return "⏹️ **Sin reproducción**\n\nNo hay canciones en la cola";
    }
    const elapsed = Math.floor(
      (q.player?.state?.resource?.playbackDuration || 0) / 1000
    );
    const total = s?.durationSec || 0;
    const line = total ? `${buildProgressBar(total, elapsed)}\n` : "";
    return `🎶 Now Playing\n${line}• ${s.title}${
      total ? ` [${formatDuration(total)}]` : ""
    }`;
  })();
  if (q.nowPlayingMessageId) {
    try {
      const msg = await channel.messages.fetch(q.nowPlayingMessageId);
      await msg.edit(
        canEmbed
          ? { content: "", embeds: [embed], components }
          : { content: contentFallback, components }
      );
      return msg;
    } catch (_) {
      q.nowPlayingMessageId = null;
    }
  }
  const sent = await channel.send(
    canEmbed
      ? { embeds: [embed], components }
      : { content: contentFallback, components }
  );
  q.nowPlayingMessageId = sent.id;
  // Intentar fijar (pin) el mensaje del panel para que sea fácil de encontrar
  if (PIN_PANEL) {
    try {
      const me = channel.guild?.members?.me;
      const canPin = channel.permissionsFor?.(me)?.has(PermissionsBitField.Flags.ManageMessages);
      if (canPin && !sent.pinned) {
        await sent.pin().catch(() => {});
      }
    } catch {}
  }
  return sent;
}

// Garantiza que exista un único panel por servidor; si no existe, lo crea en el canal dado
async function ensurePanel(guildId, channelId) {
  const q = getQueue(guildId);
  // Si no hay canal configurado, usar el provisto
  if (!q.textChannelId) q.textChannelId = channelId;
  // Si no hay panel, crearlo en el canal indicado
  if (!q.nowPlayingMessageId) {
    q.textChannelId = channelId;
    try {
      await renderNowPlaying(guildId);
    } catch {}
  }
}

async function clearNowPlaying(guildId) {
  const q = queues.get(guildId);
  if (!q || !q.textChannelId || !q.nowPlayingMessageId) return;
  const channel = await client.channels
    .fetch(q.textChannelId)
    .catch(() => null);
  if (!channel || !channel.isTextBased?.()) return;
  try {
    const msg = await channel.messages.fetch(q.nowPlayingMessageId);
    await msg.delete().catch(() => {});
  } catch {}
  q.nowPlayingMessageId = null;
}

// (Eliminado) Handler de mensajes con prefijo "!" para dejar el bot sólo con Slash Commands

// ======================
// Interacciones de Slash Commands
// ======================
client.on("interactionCreate", async (interaction) => {
  // Botones de control
  if (interaction.isButton()) {
  const { guild, member } = interaction;
    const q = guild ? queues.get(guild.id) : null;
    if (!q) {
      try {
  await interaction.reply({ content: "No hay nada en reproducción.", flags: 1 << 6 });
      } catch {}
      return;
    }
  if (!sameVoiceChannelRequiredPass(guild, member)) {
      try {
  await interaction.reply({ content: "❌ Debés estar en el mismo canal de voz que el bot para usar los controles.", flags: 1 << 6 });
      } catch {}
      return;
    }
    const id = interaction.customId;
    // Para botones que editan el panel actual, usamos deferUpdate(); para los que sólo responden efímero (cola), respondemos directo.
    const deferForIds = new Set([
      "music_pause",
      "music_resume",
      "music_skip",
      "music_stop",
      "music_loop",
      "music_shuffle",
      "music_replay",
      "music_seek_back",
      "music_seek_forward",
      "music_vol_down",
      "music_vol_up",
      "music_save",
    ]);
    if (deferForIds.has(id)) {
      try { await interaction.deferUpdate(); } catch {}
    }
    if (id === "music_pause") {
      q.player.pause();
      try {
        stopNowPlayingTicker(guild.id);
      } catch {}
      await renderNowPlaying(guild.id).catch(() => {});
      return;
    }
    if (id === "music_resume") {
      q.player.unpause();
      try {
        startNowPlayingTicker(guild.id);
      } catch {}
      await renderNowPlaying(guild.id).catch(() => {});
      return;
    }
    if (id === "music_skip") {
      // Saltar ignorando loop
      if (q.songs.length > 0) {
        if (q.songs.length > 1 && q.shuffleMode) {
          const rest = q.songs.slice(1);
          const pick = Math.floor(Math.random() * rest.length);
          const next = rest[pick];
          const newRest = rest.filter((_, i) => i !== pick);
          q.songs = [next, ...newRest];
        } else {
          q.songs.shift();
        }
      }
      if (q.songs.length > 0) {
        await playNext(guild.id);
      } else {
        const connection = getVoiceConnection(guild.id);
        connection?.destroy();
        queues.delete(guild.id);
        clearNowPlaying(guild.id).catch(() => {});
      }
      return;
    }
    if (id === "music_stop") {
      const connection = getVoiceConnection(guild.id);
      if (q) q.songs = [];
      connection?.destroy();
      queues.delete(guild.id);
      clearIdleTimeout(guild.id); // Limpiar timeout de idle
      clearNowPlaying(guild.id).catch(() => {});
      stopNowPlayingTicker(guild.id);
      return;
    }
    if (id === "music_loop") {
      q.loop = !q.loop;
  guildState[guild.id] = guildState[guild.id] || {};
  guildState[guild.id].loop = q.loop;
  saveState(guildState);
      await renderNowPlaying(guild.id).catch(() => {});
      return;
    }
    if (id === "music_shuffle") {
      // Alternar modo aleatorio y persistir
      q.shuffleMode = !q.shuffleMode;
      guildState[guild.id] = guildState[guild.id] || {};
      guildState[guild.id].shuffleMode = q.shuffleMode;
      saveState(guildState);
      // Si se activó y hay más de 2 temas, mezclar la cola restante una vez
      if (q.shuffleMode && q.songs.length > 2) {
        const head = q.songs[0];
        const rest = q.songs.slice(1);
        for (let i = rest.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [rest[i], rest[j]] = [rest[j], rest[i]];
        }
        q.songs = [head, ...rest];
      }
      await renderNowPlaying(guild.id).catch(() => {});
      return;
    }
    
    // 🚀 OPTIMIZADO: HANDLERS PARA SALTO RÁPIDO CON CACHE Y MENOS RECREACIÓN
    if (id === "music_seek_back" || id === "music_seek_forward") {
      const current = q.songs?.[0];
      if (!current || !current.durationSec) return;
      
      const elapsed = getActualElapsedTime(q);
      const seekAmount = id === "music_seek_forward" ? SEEK_STEP_SECONDS : -SEEK_STEP_SECONDS;
      const newTime = Math.max(0, Math.min(current.durationSec - 5, elapsed + seekAmount));
      
      // Optimización: usar cache de URL directa si está disponible
      let cachedUrl = q._directUrlCache?.get(current.url);
      const cacheAge = q._directUrlCache?.has(current.url) ? 
        Date.now() - (q._directUrlTimestamp?.get(current.url) || 0) : Infinity;
      
      // Cache válido por 10 minutos
      if (!cachedUrl || cacheAge > 600000) {
        if (DEBUG_AUDIO) console.log(`[seek] Obteniendo nueva URL directa para seek optimizado`);
        try {
          cachedUrl = await getDirectUrlFromYtDlp(current.url, {
            userAgent: process.env.YTDL_USER_AGENT || 
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            acceptLang: process.env.YTDL_ACCEPT_LANGUAGE || "es-ES,es;q=0.9,en;q=0.8"
          }, {
            formats: ["bestaudio[acodec=opus]/bestaudio/best", "251", "bestaudio/best"]
          });
          
          // Inicializar cache si no existe
          if (!q._directUrlCache) q._directUrlCache = new Map();
          if (!q._directUrlTimestamp) q._directUrlTimestamp = new Map();
          
          q._directUrlCache.set(current.url, cachedUrl);
          q._directUrlTimestamp.set(current.url, Date.now());
        } catch (e) {
          if (DEBUG_AUDIO) console.warn(`[seek] No se pudo obtener URL directa, usando método tradicional:`, e?.message);
          cachedUrl = null;
        }
      }
      
      try {
        q.replacingResource = true;
        let res;
        
        if (cachedUrl) {
          // Método optimizado: crear recurso directamente desde URL con seek
          if (DEBUG_AUDIO) console.log(`[seek] ⚡ Usando URL directa cacheada para seek a ${newTime}s`);
          res = await createOptimizedResourceFromDirectUrl(cachedUrl, newTime, q.volume ?? 1.0, {
            bassGainDb: q.bassGainDb,
            bassFreq: DEFAULT_BASS_FREQ,
            bassWidth: DEFAULT_BASS_WIDTH,
          });
        } else {
          // Método tradicional como fallback
          res = await createResourceFromUrl(current.url, q.volume ?? 1.0, {
            forceFfmpeg: true,
            bassGainDb: q.bassGainDb,
            bassFreq: DEFAULT_BASS_FREQ,
            bassWidth: DEFAULT_BASS_WIDTH,
            startAtSec: newTime,
          });
        }
        
        // Solo reproducir si el recurso se creó exitosamente
        if (res && res.readable) {
          q.player.play(res);
          
          // Actualizar tiempo de seek para mostrar en la interfaz
          q._lastSeekTime = newTime;
          q._lastSeekTimestamp = Date.now();
          
          await renderNowPlaying(guild.id).catch(() => {});
        } else {
          console.warn(`[seek:error] Recurso no válido o no legible`);
          q.replacingResource = false;
          return;
        }
      } catch (e) {
        console.warn(`[seek:error]`, e?.message || e);
        q.replacingResource = false;
        // Si hay error en el seek, no avanzar a la siguiente canción
        return;
      }
      return;
    }
    
    if (id === "music_queue") {
      // Responder efímero con la cola formateada
      const text = formatQueueMessage(q, 20);
      try {
  await interaction.reply({ content: `📋 Cola actual:\n${text}` , flags: 1 << 6 });
      } catch (e) {
        // Si ya fue respondida, intentar editReply
        try { await interaction.editReply({ content: `📋 Cola actual:\n${text}` }); } catch {}
      }
      return;
    }
    if (id === "music_replay") {
      // Reiniciar pista actual sin modificar la cola
      const song = q.songs[0];
      if (song) {
        try {
          const bassActive = (Number(q.bassGainDb) || 0) > 0;
          q.replacingResource = true;
          const elapsedSec = Math.floor((q.player?.state?.resource?.playbackDuration || 0) / 1000);
          const resource = await createResourceFromUrl(song.url, q.volume ?? 1.0, {
            forceFfmpeg: bassActive,
            bassGainDb: q.bassGainDb,
            bassFreq: DEFAULT_BASS_FREQ,
            bassWidth: DEFAULT_BASS_WIDTH,
            startAtSec: elapsedSec,
          });
          q.player.play(resource);
          await renderNowPlaying(guild.id).catch(() => {});
        } catch {}
      }
      return;
    }
    if (id === "music_vol_down" || id === "music_vol_up") {
      const delta = id === "music_vol_up" ? 0.1 : -0.1;
      q.volume = Math.max(0, Math.min(2, (q.volume ?? 1) + delta));
  guildState[guild.id] = guildState[guild.id] || {};
  guildState[guild.id].volume = q.volume;
  saveState(guildState);
      const res = q.player.state?.resource;
      if (res?.volume?.setVolumeLogarithmic)
        res.volume.setVolumeLogarithmic(q.volume);
      await renderNowPlaying(guild.id).catch(() => {});
      return;
    }
    if (id === "music_save") {
      const s = q.songs?.[0];
      if (s) {
        // Agregar a estadísticas de favoritos
        updateUserStats(user.id, guild.id, 'favorite', { url: s.url });
        
        try {
          const dm = await user.createDM();
          await dm.send({
            embeds: [
              new EmbedBuilder()
                .setColor(0x57f287)
                .setTitle("⭐ Canción Guardada")
                .setDescription(`[${s.title}](${s.url})`)
                .addFields(
                  { name: "🏠 Servidor", value: guild.name, inline: true },
                  {
                    name: "⏱️ Duración",
                    value: s.durationSec ? formatDuration(s.durationSec) : "🔴 EN VIVO",
                    inline: true,
                  }
                )
                .setFooter({ 
                  text: "💡 Usa /mystats para ver todas tus estadísticas musicales" 
                }),
            ],
          });
          
          // Respuesta ephemeral confirmando la acción
          try {
            await interaction.reply({ 
              content: `⭐ ¡Guardado! Te envié "${s.title}" por mensaje privado.`, 
              flags: 1 << 6 
            });
          } catch {}
          
        } catch (dmError) {
          // Si falla el DM, mostrar respuesta ephemeral
          try {
            await interaction.reply({ 
              content: `⭐ ¡Canción agregada a tus favoritos! (No pude enviar DM)\n🎵 **${s.title}**`, 
              flags: 1 << 6 
            });
          } catch {}
        }
      }
      return;
    }
    return;
  }
  if (!interaction.isChatInputCommand()) return;
  const { commandName, guild, member } = interaction;
  if (!guild) {
  await safeRespond(interaction, { content: "Este comando sólo funciona en servidores.", flags: 1 << 6 });
    return;
  }

  try {
    // 📊 TRACKING DE ESTADÍSTICAS WEB
    updateWebStats('command_used', {
      userId: member.id,
      guildId: guild.id,
      guildName: guild.name,
      command: commandName
    });
    
    if (commandName === "play") {
      const query = interaction.options.getString("query", true);
      
      // 🎵 DETECCIÓN DE SPOTIFY
      if (isSpotifyUrl(query)) {
        const spotifyResult = await searchYouTubeForSpotifyTrack(query);
        return safeRespond(interaction, {
          content: spotifyResult.message,
          flags: 1 << 6 // ephemeral
        }, { edit: true });
      }
      
      const normalizedQuery = canonicalizeYouTubeUrl(query);
      const ok = await safeDefer(interaction);
      if (!ok) return;
      // Playlist en /play (detectar por URL; evita playdl.validate → 429)
      try {
        if (isYouTubePlaylistUrl(normalizedQuery)) {
          const voiceChannel = member.voice?.channel;
          if (!voiceChannel)
            return safeRespond(
              interaction,
              "❌ Tenés que estar en un canal de voz.",
              { edit: true }
            );
          const perms = voiceChannel.permissionsFor(interaction.client.user);
          if (
            !perms?.has(PermissionsBitField.Flags.Connect) ||
            !perms?.has(PermissionsBitField.Flags.Speak)
          ) {
            return safeRespond(
              interaction,
              "❌ No tengo permisos para unirme o hablar en ese canal.",
              { edit: true }
            );
          }
          const q = getQueue(guild.id);
          if (!q.textChannelId) q.textChannelId = interaction.channelId;
          try {
            await ensureConnection(guild, voiceChannel);
          } catch (e) {
            return safeRespond(
              interaction,
              "❌ No pude conectarme al canal de voz.",
              { edit: true }
            );
          }
          
          // 🎵 PROCESAMIENTO MEJORADO DE PLAYLIST CON ORDEN PRESERVADO
          if (DEBUG_AUDIO) console.log(`[playlist] Procesando playlist: ${normalizedQuery}`);
          const playlistData = await getPlaylistItemsOrdered(normalizedQuery);
          
          if (!playlistData.items || playlistData.items.length === 0) {
            return safeRespond(interaction, "❌ No pude leer la playlist o está vacía.", {
              edit: true,
            });
          }
          
          // Ordenar por índice original para asegurar el orden correcto
          const orderedItems = playlistData.items.sort((a, b) => 
            (a.originalIndex || 0) - (b.originalIndex || 0)
          );
          
          let added = 0;
          let skipped = 0;
          
          for (const item of orderedItems) {
            if ((q.songs?.length || 0) >= MAX_QUEUE_LENGTH) {
              skipped = orderedItems.length - added;
              break;
            }
            
            q.songs.push({
              url: item.url,
              title: item.title,
              durationSec: item.durationSec,
              thumbnailUrl: item.thumbnailUrl,
              requestedById: member?.user?.id,
            });
            added++;
          }
          
          if (DEBUG_AUDIO) {
            console.log(`[playlist] ✅ Añadidas ${added} canciones en orden original`);
          }
          if (
            q.songs.length > 0 &&
            q.player.state.status !== AudioPlayerStatus.Playing
          ) {
            await playNext(guild.id);
          }
          const queueText = formatQueueMessage(q);
          let responseMsg = `📚 Añadidas **${added}** canciones de la playlist "${playlistData.title}"`;
          
          if (skipped > 0) {
            responseMsg += ` (${skipped} omitidas por límite de cola: ${MAX_QUEUE_LENGTH})`;
          } else if (added < orderedItems.length) {
            responseMsg += ` (máx ${MAX_PLAYLIST_ITEMS})`;
          }
          
          responseMsg += `\n✅ **Orden original preservado**\n\nCola actual:\n${queueText}`;
          
          const resp = await safeRespond(interaction, responseMsg, { edit: true });
          // Asegurar un único panel
          await ensurePanel(guild.id, interaction.channelId);
          await renderNowPlaying(guild.id).catch(() => {});
          return resp;
        }
      } catch {}

      // Exigir URL directa
    const finalUrl = (() => {
        try {
      const u = new URL(normalizedQuery);
      return u.href;
        } catch { return null; }
      })();
      if (!finalUrl)
        return safeRespond(interaction, "❌ URL inválida.", { edit: true });

      const voiceChannel = member.voice?.channel;
      if (!voiceChannel)
        return safeRespond(
          interaction,
          "❌ Tenés que estar en un canal de voz.",
          { edit: true }
        );
      const perms = voiceChannel.permissionsFor(interaction.client.user);
      if (
        !perms?.has(PermissionsBitField.Flags.Connect) ||
        !perms?.has(PermissionsBitField.Flags.Speak)
      ) {
        return safeRespond(
          interaction,
          "❌ No tengo permisos para unirme o hablar en ese canal.",
          { edit: true }
        );
      }

  const q = getQueue(guild.id);
  if (!q.textChannelId) q.textChannelId = interaction.channelId;
      // Paralelizar conexión con fetch de info/metadata
      const connectP = ensureConnection(guild, voiceChannel).catch((e) => e);
      const ytCookie = process.env.YT_COOKIE || process.env.YOUTUBE_COOKIE;
      let songData = null;
      if (isYouTubeUrl(finalUrl)) {
        if (String(process.env.YT_FORCE_YTDLP || "1") === "1") {
          const meta = await fetchMetadata(finalUrl);
          songData = {
            url: finalUrl,
            title: meta.title,
            durationSec: meta.durationSec || 0,
            thumbnailUrl: meta.thumbnailUrl,
            requestedById: member?.user?.id,
          };
        } else {
          try {
            const id = extractYouTubeId(finalUrl) || finalUrl;
            const info = await ytdl.getInfo(id);
            const title = info?.videoDetails?.title || finalUrl;
            const dur = Number(info?.videoDetails?.lengthSeconds || 0) || 0;
            const thumb =
              (info?.videoDetails?.thumbnails || [])[0]?.url ||
              deriveYouTubeThumb(finalUrl);
            songData = {
              url: finalUrl,
              title,
              durationSec: dur ? Math.floor(dur) : 0,
              thumbnailUrl: thumb,
              requestedById: member?.user?.id,
              ytdlInfo: info,
            };
          } catch {
            const meta = await fetchMetadata(finalUrl);
            songData = {
              url: finalUrl,
              title: meta.title,
              durationSec: meta.durationSec || 0,
              thumbnailUrl: meta.thumbnailUrl,
              requestedById: member?.user?.id,
            };
          }
        }
      } else {
        const meta = await fetchMetadata(finalUrl);
        songData = {
          url: finalUrl,
          title: meta.title,
          durationSec: meta.durationSec || 0,
          thumbnailUrl: meta.thumbnailUrl,
          requestedById: member?.user?.id,
        };
      }
      const connRes = await connectP;
      if (connRes instanceof Error) {
        return safeRespond(
          interaction,
          "❌ No pude conectarme al canal de voz. Revisá permisos o la región del servidor e intentá de nuevo.",
          { edit: true }
        );
      }
      if (!tryEnqueue(q, songData)) {
        const queueText = formatQueueMessage(q);
        const r = await safeRespond(
          interaction,
          `⚠️ La cola está llena (máx ${MAX_QUEUE_LENGTH}).\n\nCola actual:\n${queueText}`,
          { edit: true }
        );
        await ensurePanel(guild.id, interaction.channelId);
        await renderNowPlaying(guild.id).catch(() => {});
        return r;
      }
      let header;
      if (q.songs.length === 1) {
        await playNext(guild.id);
        header = `🎶 Reproduciendo: ${songData.title}${
          songData.durationSec
            ? ` [${formatDuration(songData.durationSec)}]`
            : ""
        }`;
      } else {
        header = `➕ Añadido a la cola: ${songData.title}${
          songData.durationSec
            ? ` [${formatDuration(songData.durationSec)}]`
            : ""
        } (pos. ${q.songs.length})`;
      }
      const queueText = formatQueueMessage(q);
  const r = await safeRespond(
        interaction,
        `${header}\n\nCola actual:\n${queueText}`,
        { edit: true }
      );
  // Mantener un único panel por servidor
  await ensurePanel(guild.id, interaction.channelId);
  await renderNowPlaying(guild.id).catch(() => {});
      return r;
    }

    if (commandName === "ping") {
      const ok = await safeDefer(interaction);
      if (!ok) return;
      const ping = Math.max(0, client.ws.ping || 0);
      return safeRespond(interaction, `Pong! Latencia WS: ${ping}ms`, { edit: true });
    }

    if (commandName === "stats") {
      const ok = await safeDefer(interaction);
      if (!ok) return;
      const mem = process.memoryUsage();
      const guilds = client.guilds?.cache?.size || 0;
      const conns = [...queues.values()].filter(q => q.connection).length;
      const songs = [...queues.values()].reduce((a,q)=>a+(q.songs?.length||0),0);
      const txt = [
        `Uptime: ${getUptime()}`,
        `RAM: ${formatBytes(mem.rss)} rss · ${formatBytes(mem.heapUsed)} heap`,
        `Guilds: ${guilds} · Conexiones voz: ${conns} · En cola: ${songs}`,
        `Node: ${process.version}`,
      ].join("\n");
      return safeRespond(interaction, txt, { edit: true });
    }

    if (commandName === "mystats") {
      const ok = await safeDefer(interaction);
      if (!ok) return;
      
      const stats = getUserStats(member.id, guild.id);
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("🎵 Tus Estadísticas Musicales")
        .setThumbnail(member.displayAvatarURL())
        .addFields(
          {
            name: "🎧 Canciones reproducidas",
            value: stats.songsPlayed.toString(),
            inline: true
          },
          {
            name: "⏱️ Tiempo total de escucha",
            value: `${Math.floor(stats.totalListenTime / 60)} minutos`,
            inline: true
          },
          {
            name: "⭐ Canciones guardadas",
            value: stats.favorites.length.toString(),
            inline: true
          }
        )
        .setFooter({
          text: `Estadísticas desde tu primera actividad • ${guild.name}`,
        });
      
      return safeRespond(interaction, { embeds: [embed] }, { edit: true });
    }

    if (commandName === "reload") {
      const ok = await safeDefer(interaction);
      if (!ok) return;
      const q = queues.get(guild.id);
      if (!q || q.songs.length === 0)
        return safeRespond(interaction, "No hay nada en reproducción.", { edit: true });
      
      const s = q.songs[0];
      const url = s.url;
      
      // Limpiar cache existente para esta canción
      METADATA_CACHE.delete(url);
      PRELOAD_CACHE.delete(url);
      
      try {
        // Recargar metadatos
        await safeRespond(interaction, "🔄 Recargando metadatos...", { edit: true });
        const newMetadata = await getEnhancedMetadata(url);
        
        // Actualizar título si cambió
        s.title = newMetadata.title || s.title;
        
        let responseText = `✅ **Metadatos recargados**\n\n`;
        responseText += `📀 **Título:** ${s.title}\n`;
        
        if (newMetadata.quality) {
          responseText += `🎧 **Calidad:** ${formatAudioQuality(newMetadata.quality)}\n`;
        } else {
          responseText += `🎧 **Salida:** ${formatAudioQuality(null)}\n`;
        }
        if (newMetadata.views) {
          const views = newMetadata.views > 1000000 
            ? `${(newMetadata.views / 1000000).toFixed(1)}M`
            : newMetadata.views > 1000 
              ? `${(newMetadata.views / 1000).toFixed(0)}K` 
              : newMetadata.views.toString();
          responseText += `👀 **Visualizaciones:** ${views}\n`;
        }
        
        return safeRespond(interaction, responseText, { edit: true });
      } catch (error) {
        console.error("[reload] Error:", error);
        return safeRespond(interaction, "❌ Error al recargar metadatos: " + (error?.message || error), { edit: true });
      }
    }

    if (commandName === "shuffle") {
      const ok = await safeDefer(interaction);
      if (!ok) return;
      const q = getQueue(guild.id);
      if (!q || q.songs.length === 0) return safeRespond(interaction, "La cola está vacía.", { edit: true });
      q.shuffleMode = !q.shuffleMode;
      guildState[guild.id] = guildState[guild.id] || {};
      guildState[guild.id].shuffleMode = q.shuffleMode;
      saveState(guildState);
      if (q.shuffleMode && q.songs.length > 2) {
        const head = q.songs[0];
        const rest = q.songs.slice(1);
        for (let i = rest.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [rest[i], rest[j]] = [rest[j], rest[i]];
        }
        q.songs = [head, ...rest];
      }
      await renderNowPlaying(guild.id).catch(() => {});
      return safeRespond(interaction, `🔀 Aleatorio: ${q.shuffleMode ? "ON" : "OFF"}`, { edit: true });
    }

    if (commandName === "seek") {
      const ok = await safeDefer(interaction);
      if (!ok) return;
      const seconds = Math.max(0, interaction.options.getInteger("seconds", true));
      const q = getQueue(guild.id);
      if (!q || q.songs.length === 0) return safeRespond(interaction, "No hay nada en reproducción.", { edit: true });
      const current = q.songs[0];
      const total = Math.max(0, current.durationSec || 0);
      const target = total ? Math.min(seconds, total - 1) : seconds;
      try {
        q.replacingResource = true;
        const bassActive = (Number(q.bassGainDb) || 0) > 0;
        const res = await createResourceFromUrl(current.url, q.volume ?? 1.0, {
          forceFfmpeg: bassActive,
          bassGainDb: q.bassGainDb,
          bassFreq: DEFAULT_BASS_FREQ,
          bassWidth: DEFAULT_BASS_WIDTH,
          startAtSec: target,
        });
        q.player.play(res);
        await renderNowPlaying(guild.id).catch(() => {});
        return safeRespond(interaction, `⏩ Seek a ${formatDuration(target)}${total?` / ${formatDuration(total)}`:""}`, { edit: true });
      } catch (e) {
        return safeRespond(interaction, "No se pudo hacer seek.", { edit: true });
      }
    }

    if (commandName === "loop") {
      const ok = await safeDefer(interaction);
      if (!ok) return;
      const mode = String(interaction.options.getString("mode", true)).toLowerCase();
      const q = getQueue(guild.id);
      if (!q || q.songs.length === 0)
        return safeRespond(interaction, "No hay nada en reproducción.", { edit: true });
      if (mode === "on") q.loop = true;
      else if (mode === "off") q.loop = false;
      else q.loop = !q.loop; // toggle
      guildState[guild.id] = guildState[guild.id] || {};
      guildState[guild.id].loop = q.loop;
      saveState(guildState);
      await renderNowPlaying(guild.id).catch(() => {});
      return safeRespond(interaction, `🔁 Bucle: ${q.loop ? "ON" : "OFF"}`, { edit: true });
    }

    if (commandName === "skip") {
      const ok = await safeDefer(interaction);
      if (!ok) return;
      const q = queues.get(guild.id);
      if (!q || q.songs.length === 0)
        return safeRespond(interaction, "No hay nada en reproducción.", {
          edit: true,
        });
      q.loop = false;
      q.songs.shift();
      if (q.songs.length > 0) {
        await playNext(guild.id);
      } else {
        const connection = getVoiceConnection(guild.id);
        connection?.destroy();
        queues.delete(guild.id);
        clearNowPlaying(guild.id).catch(() => {});
      }
      const queueText = formatQueueMessage(q);
      await safeRespond(
        interaction,
        `⏭️ Saltado.\n\nCola actual:\n${queueText}`,
        { edit: true }
      );
      await renderNowPlaying(guild.id).catch(() => {});
      return;
    }

    if (commandName === "pause") {
      const ok = await safeDefer(interaction);
      if (!ok) return;
      const q = queues.get(guild.id);
      if (!q)
        return safeRespond(interaction, "No hay nada en reproducción.", {
          edit: true,
        });
      q.player.pause();
      try {
        stopNowPlayingTicker(guild.id);
      } catch {}
      const queueText = formatQueueMessage(q);
      await safeRespond(
        interaction,
        `⏸️ Pausado.\n\nCola actual:\n${queueText}`,
        { edit: true }
      );
      await renderNowPlaying(guild.id).catch(() => {});
      return;
    }

    if (commandName === "resume") {
      const ok = await safeDefer(interaction);
      if (!ok) return;
      const q = queues.get(guild.id);
      if (!q)
        return safeRespond(interaction, "No hay nada en reproducción.", {
          edit: true,
        });
      q.player.unpause();
      try {
        startNowPlayingTicker(guild.id);
      } catch {}
      const queueText = formatQueueMessage(q);
      await safeRespond(
        interaction,
        `▶️ Reanudado.\n\nCola actual:\n${queueText}`,
        { edit: true }
      );
      await renderNowPlaying(guild.id).catch(() => {});
      return;
    }

    if (commandName === "queue") {
      const ok = await safeDefer(interaction);
      if (!ok) return;
      const q = queues.get(guild.id);
      if (!q || q.songs.length === 0)
        return safeRespond(interaction, "La cola está vacía.", { edit: true });
      const elapsed = Math.floor(
        (q.player.state?.resource?.playbackDuration || 0) / 1000
      );
      const lines = q.songs.slice(0, 10).map((s, i) => {
        const dur = s.durationSec ? ` [${formatDuration(s.durationSec)}]` : "";
        if (i === 0) {
          const left = s.durationSec
            ? ` (${formatDuration(elapsed)} / ${formatDuration(s.durationSec)})`
            : "";
          return `▶️ ${s.title}${dur}${left}`;
        }
        return `${i + 1}. ${s.title}${dur}`;
      });
      return safeRespond(interaction, lines.join("\n"), { edit: true });
    }

    if (commandName === "remove") {
      const ok = await safeDefer(interaction);
      if (!ok) return;
      const q = queues.get(guild.id);
      if (!q || q.songs.length === 0)
        return safeRespond(interaction, "La cola está vacía.", { edit: true });
      const idx = interaction.options.getInteger("index", true);
      if (idx < 1 || idx > q.songs.length)
        return safeRespond(interaction, `Índice inválido. Rango: 1-${q.songs.length}.`, { edit: true });
      if (idx === 1) {
        q.loop = false;
  guildState[guild.id] = guildState[guild.id] || {};
  guildState[guild.id].loop = q.loop;
  saveState(guildState);
        if (q.songs.length > 0) {
          if (q.songs.length > 1 && q.shuffleMode) {
            const rest = q.songs.slice(1);
            const pick = Math.floor(Math.random() * rest.length);
            const next = rest[pick];
            const newRest = rest.filter((_, i) => i !== pick);
            q.songs = [next, ...newRest];
          } else {
            q.songs.shift();
          }
        }
        if (q.songs.length > 0) {
          await playNext(guild.id);
        } else {
          const connection = getVoiceConnection(guild.id);
          connection?.destroy();
          queues.delete(guild.id);
          await clearNowPlaying(guild.id).catch(() => {});
        }
      } else {
        q.songs.splice(idx - 1, 1);
      }
      const queueText = formatQueueMessage(q);
      await renderNowPlaying(guild.id).catch(() => {});
      return safeRespond(interaction, `🗑️ Eliminado el elemento ${idx}.\n\nCola actual:\n${queueText}`, { edit: true });
    }

    if (commandName === "clear") {
      const ok = await safeDefer(interaction);
      if (!ok) return;
      const q = queues.get(guild.id);
      if (!q || q.songs.length === 0)
        return safeRespond(interaction, "La cola está vacía.", { edit: true });
      if (q.songs.length > 1) q.songs = [q.songs[0]]; // mantener la actual
      const queueText = formatQueueMessage(q);
      await renderNowPlaying(guild.id).catch(() => {});
      return safeRespond(interaction, `🧹 Cola limpiada (se mantiene la canción actual).\n\nCola actual:\n${queueText}`, { edit: true });
    }
    if (commandName === "nowplaying") {
      const ok = await safeDefer(interaction);
      if (!ok) return;
      const q = queues.get(guild.id);
      if (!q || q.songs.length === 0)
        return safeRespond(interaction, "No hay nada en reproducción.", {
          edit: true,
        });
      const s = q.songs[0];
      const metadata = METADATA_CACHE.get(s.url) || {};
      const elapsed = Math.floor(
        (q.player.state?.resource?.playbackDuration || 0) / 1000
      );
      const total = s.durationSec || 0;
      
      let header = total
        ? `🎶 **${s.title}**\n⏱️ ${formatDuration(elapsed)} / ${formatDuration(total)} • 🔊 ${Math.round((q.volume ?? 1) * 100)}%`
        : `🎶 **${s.title}**\n🔴 TRANSMISIÓN EN VIVO • 🔊 ${Math.round((q.volume ?? 1) * 100)}%`;
      
      // Agregar calidad si está disponible
      if (metadata.quality) {
        header += ` • 🎧 ${metadata.quality}`;
      } else {
        // Si no hay calidad en cache, intentar obtenerla del estado del reproductor
        const playerResource = q.player.state?.resource;
        if (playerResource?.metadata?.quality) {
          header += ` • 🎧 ${playerResource.metadata.quality}`;
        } else {
          // Mostrar calidad estimada basada en el tipo de stream o información de la canción
          const qualityFallback = s.quality || 'Calidad no detectada';
          header += ` • 🎧 ${qualityFallback}`;
        }
      }
      
      // Debug: mostrar información del cache para diagnosticar
      if (DEBUG_AUDIO) {
        console.log(`[nowplaying:debug] URL: ${s.url}`);
        console.log(`[nowplaying:debug] Metadata en cache:`, metadata);
        console.log(`[nowplaying:debug] Quality:`, metadata.quality);
      }
      
      const bar = total ? `\n${buildProgressBar(total, elapsed)}` : "";
      return safeRespond(interaction, header + bar, { edit: true });
    }

    if (commandName === "info") {
      const ok = await safeDefer(interaction);
      if (!ok) return;
      const q = queues.get(guild.id);
      if (!q || q.songs.length === 0)
        return safeRespond(interaction, "No hay nada en reproducción.", { edit: true });
      
      const s = q.songs[0];
      const metadata = METADATA_CACHE.get(s.url) || {};
      const elapsed = Math.floor((q.player.state?.resource?.playbackDuration || 0) / 1000);
      
      // Información técnica detallada
      let techInfo = `🔧 **INFORMACIÓN TÉCNICA**\n\n`;
      techInfo += `📀 **Título:** ${s.title}\n`;
      techInfo += `🔗 **URL:** ${s.url}\n`;
      
      // Mostrar calidad con más detalle
      if (metadata.quality) {
        techInfo += `🎧 **Calidad:** ${formatAudioQuality(metadata.quality, true)}\n`;
      } else {
        // Intentar obtener del estado del reproductor o mostrar estimada
        const playerResource = q.player.state?.resource;
        if (playerResource?.metadata?.quality) {
          techInfo += `🎧 **Calidad:** ${formatAudioQuality(playerResource.metadata.quality, true)}\n`;
        } else {
          const qualityFallback = s.quality || null;
          techInfo += `🎧 **Calidad:** ${formatAudioQuality(qualityFallback, true)}\n`;
        }
      }
      
      if (metadata.views) {
        const views = metadata.views > 1000000 
          ? `${(metadata.views / 1000000).toFixed(1)}M`
          : metadata.views > 1000 
            ? `${(metadata.views / 1000).toFixed(0)}K` 
            : metadata.views.toString();
        techInfo += `👀 **Visualizaciones:** ${views}\n`;
      }
      if (s.durationSec) techInfo += `⏱️ **Duración:** ${formatDuration(s.durationSec)}\n`;
      techInfo += `🔊 **Volumen actual:** ${Math.round((q.volume ?? 1) * 100)}%\n`;
      techInfo += `⏯️ **Tiempo reproducido:** ${formatDuration(elapsed)}\n`;
      
      // Estado del reproductor
      const state = q.player.state;
      techInfo += `📊 **Estado:** ${state?.status || 'Desconocido'}\n`;
      
      // Cache status y precarga
      const inCache = METADATA_CACHE.has(s.url);
      const preloaded = PRELOAD_CACHE.has(`${guild.id}_${s.url}`);
      
      // Contar precargas de este servidor
      const guildPreloads = Array.from(PRELOAD_CACHE.keys())
        .filter(k => k.startsWith(`${guild.id}_`)).length;
      
      techInfo += `💾 **En cache:** ${inCache ? '✅' : '❌'}\n`;
      techInfo += `🚀 **Precargado:** ${preloaded ? '✅' : '❌'}\n`;
      techInfo += `📚 **Precargas activas:** ${guildPreloads}/${MAX_PRELOAD_SIZE}\n`;
      
      // Estado de precarga para siguientes canciones
      if (q.songs.length > 1) {
        const nextSongs = q.songs.slice(1, 1 + PRELOAD_AHEAD);
        let preloadStatus = "";
        nextSongs.forEach((song, i) => {
          const isPreloaded = PRELOAD_CACHE.has(`${guild.id}_${song.url}`);
          preloadStatus += `${isPreloaded ? '✅' : '⏳'} ${i + 1}. ${song.title.substring(0, 30)}...\n`;
        });
        if (preloadStatus) {
          techInfo += `\n🔮 **ESTADO DE PRECARGA**\n${preloadStatus}`;
        }
      }
      
      // Configuración de velocidad y calidad del bot
      techInfo += `\n⚙️ **CONFIGURACIÓN DE RENDIMIENTO**\n`;
      techInfo += `🎛️ **Bitrate Opus:** ${process.env.OPUS_BITRATE || 160}kbps\n`;
      techInfo += `🔗 **WebM/Opus directo:** ${process.env.YT_DLP_DIRECT_OPUS === '1' ? '✅' : '❌'}\n`;
      techInfo += `⚡ **Forzar mejor calidad:** ${FORCE_BEST_AUDIO ? '✅' : '❌'}\n`;
      techInfo += `📦 **Buffer de audio:** ${AUDIO_BUFFER_SIZE}MB\n`;
      techInfo += `🚀 **Precarga automática:** ${ENABLE_PRELOAD ? '✅' : '❌'}\n`;
      if (ENABLE_PRELOAD) {
        techInfo += `📈 **Precargar adelante:** ${PRELOAD_AHEAD} canciones\n`;
        techInfo += `🌐 **Conexiones paralelas:** ${YT_PARALLEL_DOWNLOADS}\n`;
        techInfo += `⏱️ **Timeout descarga:** ${YT_DOWNLOAD_TIMEOUT/1000}s\n`;
      }
      
      return safeRespond(interaction, techInfo, { edit: true });
    }

    if (commandName === "stop") {
      const ok = await safeDefer(interaction);
      if (!ok) return;
      const q = queues.get(guild.id);
      const connection = getVoiceConnection(guild.id);
      const queueText = q ? formatQueueMessage(q) : "La cola está vacía.";
      if (q) q.songs = [];
      connection?.destroy();
      queues.delete(guild.id);
      clearIdleTimeout(guild.id); // Limpiar timeout de idle
      await clearNowPlaying(guild.id).catch(() => {});
      return safeRespond(
        interaction,
        `⏹️ Música detenida y bot desconectado.\n\nCola final:\n${queueText}`,
        { edit: true }
      );
    }

    if (commandName === "volume") {
      const ok = await safeDefer(interaction);
      if (!ok) return;
      let level = interaction.options.getInteger("level", true);
      if (typeof level !== "number") level = 100;
      const pct = Math.max(0, Math.min(200, level));
      const q = getQueue(guild.id);
      q.volume = pct / 100;
  guildState[guild.id] = guildState[guild.id] || {};
  guildState[guild.id].volume = q.volume;
  saveState(guildState);
      const res = q.player.state?.resource;
      if (res?.volume?.setVolumeLogarithmic)
        res.volume.setVolumeLogarithmic(Math.max(0, Math.min(2, q.volume)));
      await renderNowPlaying(guild.id).catch(() => {});
      return safeRespond(interaction, `🔊 Volumen: ${pct}%`, { edit: true });
    }

    if (commandName === "bass") {
      const ok = await safeDefer(interaction);
      if (!ok) return;
      const preset = String(interaction.options.getString("preset", true)).toLowerCase();
      const q = getQueue(guild.id);
      let gainDb = 0;
      if (preset === "low") gainDb = 2;
      else if (preset === "med") gainDb = 4;
      else if (preset === "high") gainDb = 8;
      else if (preset === "extreme") gainDb = 16;
      else gainDb = 0; // off
      q.bassGainDb = gainDb;
  guildState[guild.id] = guildState[guild.id] || {};
  guildState[guild.id].bassGainDb = q.bassGainDb;
  saveState(guildState);
  // Aplicar al instante: reiniciar la pista actual con ffmpeg si hay algo sonando (conseek)
      const current = q.songs?.[0];
      if (current && q.player?.state?.status === AudioPlayerStatus.Playing) {
        try {
      // Señalar reemplazo controlado para que no avance la cola
      q.replacingResource = true;
          const elapsedSec = Math.floor((q.player?.state?.resource?.playbackDuration || 0) / 1000);
          const res = await createResourceFromUrl(current.url, q.volume ?? 1.0, {
            forceFfmpeg: true,
            bassGainDb: q.bassGainDb,
            bassFreq: DEFAULT_BASS_FREQ,
            bassWidth: DEFAULT_BASS_WIDTH,
            startAtSec: elapsedSec,
          });
          q.player.play(res);
        } catch (e) {
          if (DEBUG_AUDIO) console.warn("[bass] reapply failed:", e?.message || e);
      q.replacingResource = false;
        }
      }
      await renderNowPlaying(guild.id).catch(() => {});
      return safeRespond(
        interaction,
        q.bassGainDb > 0
          ? `🎚️ Bass: ${preset.toUpperCase()} (+${q.bassGainDb} dB)`
          : "🎚️ Bass: OFF",
        { edit: true }
      );
    }
  } catch (e) {
    console.error("[interaction:error]", e);
    if (interaction.deferred || interaction.replied) {
      await safeRespond(interaction, "⚠️ Ocurrió un error.", { edit: true });
    } else {
  await safeRespond(interaction, { content: "⚠️ Ocurrió un error.", flags: 1 << 6 });
    }
  }
});

// Verificar actualización de yt-dlp
logger.info("[yt-dlp] Verificando actualizaciones...");
const ytdlpPath = getYtDlpBinaryPath();
if (ytdlpPath) {
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

// Limpiar logs antiguos
cleanupOldLogs();
setInterval(cleanupOldLogs, 24 * 60 * 60 * 1000);

// Iniciar el bot
client.login(process.env.DISCORD_TOKEN);

// =================== RUTAS API Y SERVIDOR WEB ===================
// Middleware de autenticación simple
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${WEB_PASSWORD}`) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  next();
}

// Health check para Render: debe responder YA, antes de que Discord esté listo
app.get('/health', (req, res) => {
  res.status(200).type('text/plain').send('ok');
});

// Rutas API
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === WEB_PASSWORD) {
    res.json({ success: true, token: WEB_PASSWORD });
  } else {
    res.status(401).json({ success: false, error: 'Contraseña incorrecta' });
  }
});

app.get('/api/stats', (req, res) => {
  res.json(getStatsForWeb());
});

app.get('/api/guilds', (req, res) => {
  const guildsData = [];
  for (const [guildId, guild] of client.guilds.cache) {
    const queue = queues.get(guildId);
    guildsData.push({
      id: guildId,
      name: guild.name,
      memberCount: guild.memberCount,
      isConnected: !!queue?.connection,
      currentSong: queue?.songs?.[0]?.title || null,
      queueLength: queue?.songs?.length || 0
    });
  }
  res.json(guildsData);
});

app.get('/api/queue/:guildId', (req, res) => {
  const { guildId } = req.params;
  const queue = queues.get(guildId);
  if (!queue) {
    return res.status(404).json({ error: 'Servidor no encontrado o sin cola' });
  }
  
  res.json({
    guildId,
    songs: queue.songs.map((song, index) => ({
      position: index,
      title: song.title,
      url: song.url,
      duration: song.durationSec,
      requestedBy: song.requestedById,
      isCurrent: index === 0
    })),
    isPlaying: queue.player?.state?.status === AudioPlayerStatus.Playing,
    volume: Math.round((queue.volume || 1) * 100),
    loop: queue.loop,
    shuffle: queue.shuffleMode
  });
});

// Ruta principal
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'web', 'index.html'));
});

// WebSocket para tiempo real
io.on('connection', (socket) => {
  console.log('[web] Cliente conectado al dashboard');
  
  // Enviar estadísticas iniciales
  socket.emit('stats_update', getStatsForWeb());
  
  socket.on('disconnect', () => {
    console.log('[web] Cliente desconectado del dashboard');
  });
});

// Un solo HTTP en 0.0.0.0:$PORT (Render) o WEB_PORT (local).
// Antes había dos servidores (dashboard :3001 + health en PORT) y el health
// a veces arrancaba tarde o sin bind público → deploy fallaba por puertos.
function startWebServer() {
  if (httpServerStarted) return;
  httpServerStarted = true;
  try {
    server.listen(HTTP_PORT, HTTP_HOST, () => {
      console.log(`[web] Escuchando en http://${HTTP_HOST}:${HTTP_PORT} (health: /health)`);
    });
    server.on('error', (error) => {
      console.error(`[web] Error al escuchar en ${HTTP_HOST}:${HTTP_PORT}:`, error.message);
      process.exit(1);
    });
  } catch (error) {
    console.error('[web] Error al iniciar servidor:', error.message);
    process.exit(1);
  }
}

startWebServer();

// Apagado limpio en plataformas que envían señales (Render)
function gracefulShutdown(signal) {
  console.log(`[shutdown] señal recibida: ${signal}`);
  try {
    // Limpiar todos los timeouts de idle
    for (const [guildId] of idleTimeouts) {
      clearIdleTimeout(guildId);
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
  console.log("[shutdown] SIGTERM recibido");
  gracefulShutdown("SIGTERM");
  setTimeout(() => process.exit(0), 500);
});
process.on("SIGINT", () => {
  console.log("[shutdown] SIGINT recibido");
  gracefulShutdown("SIGINT");
  setTimeout(() => process.exit(0), 500);
});
