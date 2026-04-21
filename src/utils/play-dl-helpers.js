/**
 * @file play-dl-helpers.js
 * @description Helper para play-dl (alternativa moderna a ytdl-core)
 */

const play = require('play-dl');
const { createAudioResource, StreamType } = require('@discordjs/voice');
const logger = require('./logger');

/**
 * Obtiene stream de audio usando play-dl
 * @param {string} url - URL del video de YouTube
 * @param {number} seekAt - Tiempo en segundos para iniciar (opcional)
 * @returns {Promise<{resource: AudioResource, info: object}>}
 */
async function getPlayDlStream(url, seekAt = 0) {
  try {
    logger.audio('[play-dl] Obteniendo información del video', { url, seekAt });
    
    // Obtener información del video
    const info = await play.video_info(url);
    const videoDetails = info.video_details;
    
    logger.audio('[play-dl] ✓ Información obtenida', {
      title: videoDetails.title,
      duration: videoDetails.durationInSec
    });
    
    // Crear stream de audio
    const stream = await play.stream(url.trim(), {
      quality: 2, // 0 = lowest, 1 = low, 2 = medium, 3 = high, 4 = highest
      seek: seekAt > 0 ? Number(seekAt) : undefined
    });
    
    // Crear recurso de audio
    const resource = createAudioResource(stream.stream, {
      inputType: stream.type,
      inlineVolume: true
    });
    
    logger.audio('[play-dl] ✓ Recurso de audio creado');
    
    return {
      resource,
      info: {
        title: videoDetails.title,
        url: videoDetails.url,
        duration: videoDetails.durationInSec,
        thumbnail: videoDetails.thumbnails[0]?.url,
        channel: videoDetails.channel?.name
      }
    };
    
  } catch (error) {
    logger.error('[play-dl] Error obteniendo stream', {
      url,
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
}

/**
 * Valida si una URL es de YouTube
 * @param {string} url - URL a validar
 * @returns {boolean}
 */
function isYouTubeUrl(url) {
  return play.yt_validate(url) === 'video';
}

/**
 * Obtiene información del video sin crear stream
 * @param {string} url - URL del video
 * @returns {Promise<object>}
 */
async function getVideoInfo(url) {
  try {
    const info = await play.video_info(url);
    const videoDetails = info.video_details;
    
    return {
      title: videoDetails.title,
      url: videoDetails.url,
      duration: videoDetails.durationInSec,
      thumbnail: videoDetails.thumbnails[0]?.url,
      channel: videoDetails.channel?.name
    };
  } catch (error) {
    logger.error('[play-dl] Error obteniendo información', {
      url,
      error: error.message
    });
    throw error;
  }
}

module.exports = {
  getPlayDlStream,
  isYouTubeUrl,
  getVideoInfo
};
