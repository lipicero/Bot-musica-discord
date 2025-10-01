/**
 * @file utils/spotify.js
 * @description Utilidades para detección y manejo de URLs de Spotify
 */

/**
 * Verifica si una URL es de Spotify
 * @param {string} url - URL a verificar
 * @returns {boolean}
 */
function isSpotifyUrl(url) {
  return url.includes('spotify.com/') && 
         (url.includes('/track/') || url.includes('/album/') || url.includes('/playlist/'));
}

/**
 * Extrae el ID de un track de Spotify
 * @param {string} url - URL de Spotify
 * @returns {string|null} ID del track o null
 */
function extractSpotifyId(url) {
  const match = url.match(/\/track\/([a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}

/**
 * Busca en YouTube un track de Spotify
 * (Placeholder - requiere implementación completa con Spotify API)
 * @param {string} spotifyUrl - URL de Spotify
 * @returns {Promise<object>} Resultado de la búsqueda
 */
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
      message: "🎵 **Enlace de Spotify detectado**\n\n" +
               "Por ahora, copia el nombre de la canción y artista de Spotify " +
               "y búscalo manualmente en YouTube.\n\n" +
               "💡 **Próximamente:** Integración automática Spotify → YouTube"
    };
  } catch (error) {
    return {
      error: true,
      message: "❌ No se pudo procesar el enlace de Spotify"
    };
  }
}

module.exports = {
  isSpotifyUrl,
  extractSpotifyId,
  searchYouTubeForSpotifyTrack
};
