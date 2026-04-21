/**
 * @file utils/yt-dlp.js
 * @description Utilidades para integrar yt-dlp como fuente de audio de respaldo.
 */

const { StreamType, createAudioResource } = require('@discordjs/voice');
const { YtDlp } = require('ytdlp-nodejs');
const logger = require('./logger');


const YT_DLP_TIMEOUT_MS = Number(process.env.YT_DLP_TIMEOUT_MS || 120000); // Aumentado a 120 segundos
const STREAM_TIMEOUT_MS = Number(process.env.YT_DLP_STREAM_TIMEOUT_MS || 45000); // Aumentado a 45 segundos
let ytDlpInstance = null;

function getYtDlpInstance() {
  if (ytDlpInstance) return ytDlpInstance;

  try {
    const fs = require('fs');
    // Intentar encontrar el binario de forma robusta
    let binaryPath = process.env.YT_DLP_PATH || 'yt-dlp';
    
    // Si la ruta configurada no existe, intentar fallbacks
    if (binaryPath !== 'yt-dlp' && !fs.existsSync(binaryPath)) {
      const fallbacks = [
        'C:\\Users\\matia\\Downloads\\yt-dlp.exe',
        'D:\\yt-dlp.exe',
        'yt-dlp'
      ];
      for (const fb of fallbacks) {
        if (fb === 'yt-dlp' || fs.existsSync(fb)) {
          binaryPath = fb;
          break;
        }
      }
    }

    const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
    
    ytDlpInstance = new YtDlp({ 
      binaryPath,
      ffmpegPath 
    });
    return ytDlpInstance;
  } catch (error) {
    logger.warn('[yt-dlp] No se pudo inicializar yt-dlp', { error: error.message });
    return null;
  }
}

/**
 * Obtiene solo la URL del stream (RÁPIDO)
 */
async function getStreamUrlFast(url) {
  const ytDlp = getYtDlpInstance();
  if (!ytDlp) return null;

  const args = [
    '--get-url',
    '--no-warnings',
    '--no-check-certificate',
    '--ignore-config',
    '--no-playlist',
    '--skip-download',
    '--no-cache-dir',
    '--extractor-retries', '3',
    '-f', 'bestaudio',
    '--socket-timeout', '30',
    '--extractor-args', 'youtube:player_client=android'
  ];

  try {
    const result = await ytDlp.execBuilder(url)
      .addArgs(...args)
      .exec();
    
    const output = result.stdout.trim();
    
    if (result.stderr && result.stderr.length > 0) {
      logger.debug('[yt-dlp] stderr output', { stderr: result.stderr.substring(0, 200) });
    }
    
    if (output && (output.startsWith('http://') || output.startsWith('https://'))) {
      logger.debug('[yt-dlp] URL obtenida exitosamente', { urlLength: output.length });
      return output;
    }
    
    logger.debug('[yt-dlp] Salida no es una URL válida', { output: output.substring(0, 100) });
    return null;
  } catch (error) {
    logger.debug('[yt-dlp] getStreamUrlFast falló, continuará con fallback', { 
      error: error.message,
      code: error.code,
      signal: error.signal
    });
    return null;
  }
}

async function execYtDlpJson(url) {
  const ytDlp = getYtDlpInstance();
  if (!ytDlp) return null;

  // Cliente Android no requiere cookies
  const args = [
    '--dump-single-json',
    '--no-warnings',
    '--no-check-certificate',
    '--ignore-config',
    '--no-playlist',
    '--skip-download', // No descargar, solo obtener metadata
    '--no-cache-dir',
    '--extractor-retries', '1',  // Reducido a 1 para velocidad máxima
    '--fragment-retries', '1',
    '--abort-on-error',  // Fallar rápido
    '--socket-timeout', '10',
    '--extractor-args', 'youtube:player_client=android'  // Cliente Android sin signature solving
  ];

  try {
    const result = await ytDlp.execBuilder(url)
      .addArgs(...args)
      .exec();
    return JSON.parse(result.stdout);
  } catch (error) {
    logger.warn('[yt-dlp] Error ejecutando yt-dlp (JSON)', { error: error.message });
    return null;
  }
}

async function createYtDlpAudioResource(url, volume = 1.0, seekAt = 0) {
  logger.info('[yt-dlp] Obteniendo stream con ytdlp-nodejs...', { url, seekAt });
  const ytDlp = getYtDlpInstance();
  if (!ytDlp) {
    throw new Error('yt-dlp client no inicializado');
  }

  const options = {
    noWarnings: true,
    noCheckCertificates: true,
    ignoreConfig: true,
    noPlaylist: true,
    noCacheDir: true,
    extractorRetries: 3,
    socketTimeout: 30,
    format: 'bestaudio/best',
    extractorArgs: { youtube: ['player_client=android'] }
  };
  
  if (seekAt > 0) {
    options.postprocessorArgs = ['-ss', Number(seekAt).toString()];
  }

  try {
    // En ytdlp-nodejs v3.x, se usa .stream(url, options).getStream()
    const stream = ytDlp.stream(url, options).getStream();

    const resource = createAudioResource(stream, {
      inputType: StreamType.Arbitrary, // ytdlp-nodejs handles format detection
      inlineVolume: true
    });

    if (resource.volume) {
      resource.volume.setVolumeLogarithmic(Math.max(0, Math.min(2, volume)));
    }

    resource.metadata = { source: 'yt-dlp-stream' };

    stream.on('error', (err) => {
      logger.error('[yt-dlp] Error en stream de yt-dlp', { error: err.message, url });
    });

    logger.info('[yt-dlp] ✓ Recurso de audio creado con ytdlp-nodejs');
    return { resource, info: null }; // info can be fetched separately if needed
  } catch (error) {
    logger.error('[yt-dlp] Error creando recurso de audio con ytdlp-nodejs', { error: error.message, url });
    throw error;
  }
}



/**
 * Obtiene metadatos de un video usando yt-dlp
 * @param {string} url - URL del video
 * @returns {Promise<object|null>} - Información del video o null
 */
async function getVideoInfoWithYtDlp(url) {
  try {
    const info = await execYtDlpJson(url);
    if (!info) return null;
    
    // Extraer información relevante
    return {
      title: info.title || 'Video sin título',
      author: info.uploader || info.channel || 'Canal desconocido',
      duration: info.duration || 0,
      thumbnail: info.thumbnail || info.thumbnails?.[0]?.url || null,
      url: url,
      videoId: info.id || null,
      isLive: info.is_live || false,
      viewCount: info.view_count || 0,
      uploadDate: info.upload_date || null,
      description: info.description || null,
      // Información de audio
      abr: info.abr || null,
      acodec: info.acodec || null,
      ext: info.ext || null
    };
  } catch (error) {
    logger.warn('[yt-dlp] Error obteniendo info del video', { error: error.message });
    return null;
  }
}

module.exports = {
  createYtDlpAudioResource, // Renamed and updated
  getVideoInfoWithYtDlp,
  getStreamUrlFast // still needed for quick checks, but updated internally
};
