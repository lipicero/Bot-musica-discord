// Configuración centralizada del bot
// Este archivo contiene todas las constantes de configuración derivadas de variables de entorno

require('dotenv').config({ quiet: true });

// Desactivar chequeo de updates de ytdl-core
process.env.YTDL_NO_UPDATE = "1";

// =================== AUDIO QUALITY ===================
const PREFER_WEBM_OPUS = process.env.PREFER_WEBM_OPUS === "1";
const FORCE_BEST_AUDIO = process.env.FORCE_BEST_AUDIO === "1";
const AUDIO_BUFFER_SIZE = Math.max(16, Math.min(128, Number(process.env.AUDIO_BUFFER_SIZE || 64)));
const FFMPEG_OPTIMIZE_AUDIO = process.env.FFMPEG_OPTIMIZE_AUDIO !== "0";
const HIGH_WATER_MARK = 1 << (AUDIO_BUFFER_SIZE > 64 ? 27 : 26);
const OPUS_BITRATE = Number(process.env.OPUS_BITRATE || 160);

// =================== PERFORMANCE ===================
const ENABLE_PRELOAD = process.env.ENABLE_PRELOAD !== "0";
const PRELOAD_AHEAD = Math.max(1, Math.min(5, Number(process.env.PRELOAD_AHEAD || 1)));
const YT_PARALLEL_DOWNLOADS = Math.max(1, Math.min(5, Number(process.env.YT_PARALLEL_DOWNLOADS || 2)));
const YT_DOWNLOAD_TIMEOUT = Math.max(30, Math.min(120, Number(process.env.YT_DOWNLOAD_TIMEOUT || 60))) * 1000;
const YT_AGGRESSIVE_CACHE = process.env.YT_AGGRESSIVE_CACHE === "1";

// =================== CACHE ===================
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 horas
const MAX_CACHE_SIZE = 1000;
const MAX_PRELOAD_SIZE = 3;

// =================== LIMITS ===================
const MAX_PLAYLIST_ITEMS = Math.max(1, Math.min(100, Number(process.env.MAX_PLAYLIST_ITEMS || 25)));
const MAX_QUEUE_LENGTH = Math.max(1, Math.min(500, Number(process.env.MAX_QUEUE_LENGTH || 200)));

// =================== AUDIO EFFECTS ===================
const DEFAULT_BASS_FREQ = Number(process.env.BASS_FREQ || 110); // Hz
const DEFAULT_BASS_WIDTH = Number(process.env.BASS_WIDTH || 0.8);
const SEEK_STEP_SECONDS = Math.max(5, Math.min(30, Number(process.env.SEEK_STEP_SECONDS || 10)));

// =================== BEHAVIOR ===================
const REQUIRE_SAME_VC = String(process.env.REQUIRE_SAME_VC || "1") === "1";
const PIN_PANEL = String(process.env.PIN_PANEL || "1") === "1";
const EPHEMERAL_SLASH = String(process.env.EPHEMERAL_SLASH || "1") === "1";
const IDLE_TIMEOUT_MINUTES = Math.max(0, Number(process.env.IDLE_TIMEOUT_MINUTES || 10));

// =================== PLATFORM SPECIFIC ===================
const FFMPEG_DIRECT_URL = (() => {
  if (process.env.FFMPEG_DIRECT_URL != null) return String(process.env.FFMPEG_DIRECT_URL) === "1";
  return process.platform !== "win32";
})();

// =================== DEBUG ===================
const DEBUG_AUDIO = process.env.DEBUG_AUDIO === "1";
const DEBUG_DISCORD = process.env.DEBUG_DISCORD === "1";

// =================== WEB SERVER ===================
const WEB_PORT = Number(process.env.WEB_PORT || 3000);
const HEALTH_PORT = Number(process.env.HEALTH_PORT || 8080);

// =================== DISCORD ===================
const COMMANDS_SCOPE = String(process.env.COMMANDS_SCOPE || "global").toLowerCase();
const DEV_GUILD_ID = process.env.DEV_GUILD_ID ? String(process.env.DEV_GUILD_ID) : null;

module.exports = {
  // Audio Quality
  PREFER_WEBM_OPUS,
  FORCE_BEST_AUDIO,
  AUDIO_BUFFER_SIZE,
  FFMPEG_OPTIMIZE_AUDIO,
  HIGH_WATER_MARK,
  OPUS_BITRATE,
  
  // Performance
  ENABLE_PRELOAD,
  PRELOAD_AHEAD,
  YT_PARALLEL_DOWNLOADS,
  YT_DOWNLOAD_TIMEOUT,
  YT_AGGRESSIVE_CACHE,
  
  // Cache
  CACHE_TTL,
  MAX_CACHE_SIZE,
  MAX_PRELOAD_SIZE,
  
  // Limits
  MAX_PLAYLIST_ITEMS,
  MAX_QUEUE_LENGTH,
  
  // Audio Effects
  DEFAULT_BASS_FREQ,
  DEFAULT_BASS_WIDTH,
  SEEK_STEP_SECONDS,
  
  // Behavior
  REQUIRE_SAME_VC,
  PIN_PANEL,
  EPHEMERAL_SLASH,
  IDLE_TIMEOUT_MINUTES,
  
  // Platform
  FFMPEG_DIRECT_URL,
  
  // Debug
  DEBUG_AUDIO,
  DEBUG_DISCORD,
  
  // Web
  WEB_PORT,
  HEALTH_PORT,
  
  // Discord
  COMMANDS_SCOPE,
  DEV_GUILD_ID,
};

// Log configuration if DEBUG_AUDIO is enabled
if (DEBUG_AUDIO) {
  console.log('[config] Audio Configuration:');
  console.log(`  PREFER_WEBM_OPUS: ${PREFER_WEBM_OPUS}`);
  console.log(`  FORCE_BEST_AUDIO: ${FORCE_BEST_AUDIO}`);
  console.log(`  AUDIO_BUFFER_SIZE: ${AUDIO_BUFFER_SIZE}MB`);
  console.log(`  HIGH_WATER_MARK: ${HIGH_WATER_MARK}`);
  console.log(`  FFMPEG_OPTIMIZE_AUDIO: ${FFMPEG_OPTIMIZE_AUDIO}`);
  console.log(`  OPUS_BITRATE: ${OPUS_BITRATE}kbps`);
  console.log(`  ENABLE_PRELOAD: ${ENABLE_PRELOAD}`);
  console.log(`  PRELOAD_AHEAD: ${PRELOAD_AHEAD} canciones`);
  console.log(`  YT_PARALLEL_DOWNLOADS: ${YT_PARALLEL_DOWNLOADS} conexiones`);
  console.log(`  YT_DOWNLOAD_TIMEOUT: ${YT_DOWNLOAD_TIMEOUT/1000}s`);
}
