/**
 * @file utils/youtube.js
 * @description Utilidades para manejo de URLs de YouTube
 */

/**
 * Verifica si una URL es de YouTube
 * @param {string} input - URL a verificar
 * @returns {boolean}
 */
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

/**
 * Normaliza URLs de YouTube a formato estándar
 * @param {string} input - URL a normalizar
 * @returns {string} URL normalizada
 */
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

/**
 * Extrae el ID de video de una URL de YouTube
 * @param {string} input - URL de YouTube
 * @returns {string|null} ID del video o null
 */
function extractYouTubeId(input) {
  try {
    const u = new URL(input);
    
    // youtube.com/watch?v=ID
    if (/(^|\.)youtube\.com$/i.test(u.hostname)) {
      const v = u.searchParams.get("v");
      if (v) return v;
    }
    
    // youtu.be/ID
    if (/^youtu\.be$/i.test(u.hostname)) {
      const id = u.pathname.replace(/^\//, "").split(/[/?&]/)[0];
      if (id) return id;
    }
    
    // youtube.com/shorts/ID
    if (/(^|\.)youtube\.com$/i.test(u.hostname) && u.pathname.startsWith("/shorts/")) {
      const id = u.pathname.split("/")[2];
      if (id) return id;
    }
    
    return null;
  } catch {
    return null;
  }
}

/**
 * Deriva la URL del thumbnail de YouTube desde un video ID o URL
 * @param {string} urlOrId - URL o ID del video
 * @returns {string|null} URL del thumbnail
 */
function deriveYouTubeThumb(urlOrId) {
  try {
    const id = extractYouTubeId(urlOrId) || urlOrId;
    if (!id) return null;
    return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
  } catch {
    return null;
  }
}

module.exports = {
  isYouTubeUrl,
  canonicalizeYouTubeUrl,
  extractYouTubeId,
  deriveYouTubeThumb
};
