/**
 * @file services/playlist.js
 * @description Servicio para obtener y procesar playlists de YouTube
 */

const fs = require('fs');
const playdl = require('play-dl');
const { spawn } = require('child_process');
const logger = require('../utils/logger');
const { canonicalizeYouTubeUrl, deriveYouTubeThumb } = require('../utils/youtube');
const { MAX_PLAYLIST_ITEMS, DEBUG_AUDIO } = require('../config/constants');

/**
 * Obtiene la ruta del binario yt-dlp
 * @returns {string|null}
 */
function getYtDlpBinaryPath() {
  try {
    const manualPath = resolveManualYtDlpPath();
    if (manualPath) {
      return manualPath;
    }

    const { spawnSync } = require('child_process');
    
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
      if (process.platform === 'win32') {
        return resolved;
      }
      return resolved;
    }

    // Si no existe físicamente, devolver el valor para que el spawn intente resolverlo
    if (trimmed) {
      return trimmed;
    }
  }

  return null;
}

/**
 * Obtiene los items de una playlist de YouTube en orden
 * @param {string} playlistUrl - URL de la playlist
 * @returns {Promise<{items: Array, title: string}>}
 */
async function getPlaylistItemsOrdered(playlistUrl) {
  const results = [];
  let playlistInfo = null;
  
  try {
    // Método 1: Usar play-dl con carga completa
    if (DEBUG_AUDIO) logger.audio('[playlist] Obteniendo playlist con play-dl...', { url: playlistUrl });
    
    playlistInfo = await playdl.playlist_info(playlistUrl, { incomplete: false });
    await playlistInfo.fetch();
    
    // Obtener videos en orden con índice preservado
    const videos = playlistInfo.videos || [];
    if (DEBUG_AUDIO) logger.audio(`[playlist] Encontrados ${videos.length} videos en play-dl`);
    
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
        originalIndex: i // Preservar índice original
      });
    }
    
    if (results.length > 0) {
      if (DEBUG_AUDIO) logger.audio(`[playlist] ✅ Obtenidos ${results.length} videos con play-dl`);
      return { items: results, title: playlistInfo.title || "Playlist" };
    }
  } catch (e) {
    if (DEBUG_AUDIO) logger.warn(`[playlist] Error con play-dl: ${e.message}`);
  }
  
  // Método 2: Fallback con yt-dlp si play-dl falla
  try {
    if (DEBUG_AUDIO) logger.audio('[playlist] Intentando fallback con yt-dlp...');
    
    const ytdlpPath = getYtDlpBinaryPath();
    if (ytdlpPath) {
      const args = [
        '--flat-playlist',
        '--print-json',
        '--no-warnings',
        `--playlist-end=${MAX_PLAYLIST_ITEMS}`,
        playlistUrl
      ];
      
      return new Promise((resolve, reject) => {
        const proc = spawn(ytdlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        
        proc.stdout.on('data', (data) => stdout += data.toString());
        proc.stderr.on('data', (data) => stderr += data.toString());
        
        proc.on('close', (code) => {
          if (code !== 0) {
            return reject(new Error(`yt-dlp failed: ${stderr}`));
          }
          
          try {
            const lines = stdout.trim().split('\n').filter(line => line.trim());
            const items = [];
            let playlistTitle = "Playlist";
            
            for (let i = 0; i < lines.length && i < MAX_PLAYLIST_ITEMS; i++) {
              const line = lines[i];
              const json = JSON.parse(line);
              
              if (json._type === 'playlist') {
                playlistTitle = json.title || playlistTitle;
                continue;
              }
              
              if (json.url && json.title) {
                items.push({
                  url: canonicalizeYouTubeUrl(json.url),
                  title: json.title,
                  durationSec: json.duration ? Math.floor(json.duration) : 0,
                  thumbnailUrl: deriveYouTubeThumb(json.url),
                  originalIndex: i
                });
              }
            }
            
            if (DEBUG_AUDIO) logger.audio(`[playlist] ✅ Fallback yt-dlp obtuvo ${items.length} videos`);
            resolve({ items, title: playlistTitle });
          } catch (parseError) {
            reject(parseError);
          }
        });
        
        setTimeout(() => {
          proc.kill('SIGKILL');
          reject(new Error('yt-dlp timeout'));
        }, 30000);
      });
    }
  } catch (e) {
    if (DEBUG_AUDIO) logger.warn(`[playlist] Error con yt-dlp: ${e.message}`);
  }
  
  // Si ambos métodos fallan, devolver lo que tengamos de play-dl
  return { 
    items: results, 
    title: playlistInfo?.title || "Playlist" 
  };
}

module.exports = {
  getPlaylistItemsOrdered,
  getYtDlpBinaryPath
};
