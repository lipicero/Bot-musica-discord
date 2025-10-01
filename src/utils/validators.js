// Funciones de validación y sanitización

/**
 * Valida si una cadena es una URL válida
 * @param {string} str - Cadena a validar
 * @returns {boolean}
 */
function isValidUrl(str) {
  try {
    new URL(str);
    return true;
  } catch {
    return false;
  }
}

/**
 * Valida si una URL es de YouTube
 * @param {string} url - URL a validar
 * @returns {boolean}
 */
function isYouTubeUrl(url) {
  if (!isValidUrl(url)) return false;
  try {
    const parsed = new URL(url);
    return /^(www\.)?(youtube\.com|youtu\.be|music\.youtube\.com)$/i.test(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Valida si una URL es de Spotify
 * @param {string} url - URL a validar
 * @returns {boolean}
 */
function isSpotifyUrl(url) {
  if (!isValidUrl(url)) return false;
  try {
    const parsed = new URL(url);
    return /^open\.spotify\.com$/i.test(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Valida si una URL es una playlist de YouTube
 * @param {string} url - URL a validar
 * @returns {boolean}
 */
function isYouTubePlaylist(url) {
  if (!isYouTubeUrl(url)) return false;
  try {
    const parsed = new URL(url);
    return parsed.searchParams.has('list') || parsed.pathname.includes('/playlist');
  } catch {
    return false;
  }
}

/**
 * Extrae el ID de video de YouTube de una URL
 * @param {string} url - URL de YouTube
 * @returns {string|null} ID del video o null
 */
function extractYouTubeId(url) {
  if (!isYouTubeUrl(url)) return null;
  
  try {
    const parsed = new URL(url);
    
    // youtube.com/watch?v=ID
    if (parsed.hostname.includes('youtube.com') && parsed.searchParams.has('v')) {
      return parsed.searchParams.get('v');
    }
    
    // youtu.be/ID
    if (parsed.hostname === 'youtu.be') {
      return parsed.pathname.substring(1).split(/[/?&]/)[0];
    }
    
    // youtube.com/shorts/ID
    if (parsed.pathname.startsWith('/shorts/')) {
      return parsed.pathname.split('/')[2];
    }
    
    return null;
  } catch {
    return null;
  }
}

/**
 * Canonicaliza una URL de YouTube a formato estándar
 * @param {string} url - URL a canonicalizar
 * @returns {string} URL canonicalizada
 */
function canonicalizeYouTubeUrl(url) {
  if (!isYouTubeUrl(url)) return url;
  
  try {
    const parsed = new URL(url);
    
    // YouTube Music playlist -> YouTube normal
    if (parsed.hostname.includes('music.youtube.com')) {
      const list = parsed.searchParams.get('list');
      if (parsed.pathname === '/playlist' && list) {
        return `https://www.youtube.com/playlist?list=${list}`;
      }
      
      const v = parsed.searchParams.get('v');
      if (parsed.pathname === '/watch' && v) {
        const listQ = parsed.searchParams.get('list');
        return listQ
          ? `https://www.youtube.com/watch?v=${v}&list=${listQ}`
          : `https://www.youtube.com/watch?v=${v}`;
      }
    }
    
    // youtu.be short links -> watch?v=
    if (parsed.hostname === 'youtu.be') {
      const id = parsed.pathname.replace(/^\//, '').split(/[/?&]/)[0];
      return id ? `https://www.youtube.com/watch?v=${id}` : url;
    }
    
    // YouTube shorts -> watch?v=
    if (parsed.hostname.includes('youtube.com') && parsed.pathname.startsWith('/shorts/')) {
      const id = parsed.pathname.split('/')[2];
      return id ? `https://www.youtube.com/watch?v=${id}` : url;
    }
    
    return url;
  } catch {
    return url;
  }
}

/**
 * Valida un nivel de volumen
 * @param {number} volume - Nivel de volumen (0-200)
 * @returns {number} Volumen validado
 * @throws {Error} Si el volumen es inválido
 */
/**
 * Valida un valor de volumen (0-200% o 0-2 multiplicador)
 * @param {number} volume - Volumen a validar
 * @param {boolean} asPercentage - Si true, valida como 0-200%, si false como 0-2
 * @returns {number} Volumen validado
 */
function validateVolume(volume, asPercentage = false) {
  const vol = Number(volume);
  if (isNaN(vol)) {
    throw new Error('El volumen debe ser un número');
  }
  
  if (asPercentage) {
    // Validar como porcentaje (0-200)
    if (vol < 0 || vol > 200) {
      throw new Error('El volumen debe estar entre 0 y 200');
    }
    return vol;
  } else {
    // Validar como multiplicador (0-2) y limitar
    return Math.max(0, Math.min(2, vol));
  }
}

/**
 * Valida un ID de Discord (guild, user, channel, etc.)
 * @param {string} id - ID a validar
 * @returns {boolean}
 */
function isValidDiscordId(id) {
  return /^\d{17,19}$/.test(String(id));
}

/**
 * Sanitiza una cadena para prevenir inyecciones
 * @param {string} input - Cadena a sanitizar
 * @returns {string} Cadena sanitizada
 */
function sanitizeInput(input) {
  if (typeof input !== 'string') return '';
  
  return input
    .trim()
    .replace(/[<>]/g, '') // Remover < y >
    .substring(0, 2000); // Limitar longitud
}

/**
 * Valida un preset de bass
 * @param {string} preset - Preset a validar
 * @returns {boolean}
 */
function isValidBassPreset(preset) {
  const validPresets = ['off', 'low', 'med', 'high', 'extreme'];
  return validPresets.includes(String(preset).toLowerCase());
}

/**
 * Valida un número entero dentro de un rango
 * @param {*} value - Valor a validar
 * @param {number} min - Valor mínimo
 * @param {number} max - Valor máximo
 * @returns {number} Número validado
 * @throws {Error} Si el valor es inválido
 */
function validateIntegerRange(value, min, max) {
  const num = Number(value);
  if (isNaN(num) || !Number.isInteger(num)) {
    throw new Error(`El valor debe ser un número entero`);
  }
  if (num < min || num > max) {
    throw new Error(`El valor debe estar entre ${min} y ${max}`);
  }
  return num;
}

/**
 * Valida y normaliza una query de búsqueda/URL
 * @param {string} query - Query a validar
 * @returns {Object} Resultado con tipo y query normalizada
 */
function validateAndNormalizeQuery(query) {
  if (!query || typeof query !== 'string') {
    return { valid: false, error: 'Query inválida' };
  }
  
  const trimmed = query.trim();
  
  if (trimmed.length === 0) {
    return { valid: false, error: 'Query vacía' };
  }
  
  // Verificar si es URL
  if (isValidUrl(trimmed)) {
    if (isYouTubeUrl(trimmed)) {
      return {
        valid: true,
        type: 'youtube',
        url: canonicalizeYouTubeUrl(trimmed),
        isPlaylist: isYouTubePlaylist(trimmed)
      };
    }
    
    if (isSpotifyUrl(trimmed)) {
      return {
        valid: true,
        type: 'spotify',
        url: trimmed
      };
    }
    
    return {
      valid: true,
      type: 'url',
      url: trimmed
    };
  }
  
  // Es texto de búsqueda
  return {
    valid: true,
    type: 'search',
    query: sanitizeInput(trimmed)
  };
}

/**
 * Valida permisos de un canal de voz
 * @param {Object} voiceChannel - Canal de voz
 * @param {Object} botMember - Miembro del bot
 * @returns {Object} Resultado de validación
 */
function validateVoicePermissions(voiceChannel, botMember) {
  if (!voiceChannel) {
    return { valid: false, error: 'Debes estar en un canal de voz' };
  }
  
  const permissions = voiceChannel.permissionsFor(botMember);
  
  if (!permissions) {
    return { valid: false, error: 'No se pudieron verificar permisos' };
  }
  
  const { PermissionsBitField } = require('discord.js');
  
  if (!permissions.has(PermissionsBitField.Flags.Connect)) {
    return { valid: false, error: 'No tengo permiso para conectarme a ese canal' };
  }
  
  if (!permissions.has(PermissionsBitField.Flags.Speak)) {
    return { valid: false, error: 'No tengo permiso para hablar en ese canal' };
  }
  
  return { valid: true };
}

module.exports = {
  isValidUrl,
  isYouTubeUrl,
  isSpotifyUrl,
  isYouTubePlaylist,
  extractYouTubeId,
  canonicalizeYouTubeUrl,
  validateVolume,
  isValidDiscordId,
  sanitizeInput,
  isValidBassPreset,
  validateIntegerRange,
  validateAndNormalizeQuery,
  validateVoicePermissions
};
