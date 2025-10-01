// Funciones de formateo para el bot
const { EmbedBuilder } = require('discord.js');

/**
 * Formatea una duración en segundos a formato HH:MM:SS o MM:SS
 * @param {number} totalSeconds - Segundos totales
 * @returns {string} Duración formateada
 */
function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/**
 * Formatea bytes a una unidad legible
 * @param {number} n - Número de bytes
 * @returns {string} Tamaño formateado
 */
function formatBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Math.max(0, Number(n) || 0);
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i ? 1 : 0)} ${units[i]}`;
}

/**
 * Obtiene el uptime del proceso
 * @returns {string} Uptime formateado
 */
function getUptime() {
  const sec = Math.floor(process.uptime());
  return formatDuration(sec);
}

/**
 * Construye una barra de progreso visual
 * @param {number} totalSec - Duración total en segundos
 * @param {number} elapsedSec - Segundos transcurridos
 * @param {number} size - Tamaño de la barra
 * @param {string} style - Estilo de la barra (modern, elegant, retro)
 * @returns {string} Barra de progreso formateada
 */
function buildProgressBar(totalSec, elapsedSec, size = 20, style = 'modern') {
  totalSec = Math.max(1, Number(totalSec) || 1);
  elapsedSec = Math.max(0, Math.min(totalSec, Number(elapsedSec) || 0));
  
  const ratio = elapsedSec / totalSec;
  const filled = Math.max(0, Math.min(size, Math.round(ratio * size)));
  const pos = Math.max(0, Math.min(size - 1, Math.round(ratio * (size - 1))));
  
  const styles = {
    modern: {
      filled: '━',
      empty: '━',
      cursor: '�',
      brackets: ['', '']
    },
    elegant: {
      filled: '▰',
      empty: '▱',
      cursor: '🎵',
      brackets: ['', '']
    },
    retro: {
      filled: '■',
      empty: '□',
      cursor: '▶',
      brackets: ['[', ']']
    },
    spotify: {
      filled: '━',
      empty: '━',
      cursor: '⚪',
      brackets: ['', '']
    }
  };
  
  const s = styles[style] || styles.modern;
  let bar = '';
  
  // Crear barra con colores usando formato especial
  for (let i = 0; i < size; i++) {
    if (i === pos) {
      bar += s.cursor;
    } else if (i < filled) {
      bar += s.filled;
    } else {
      bar += s.empty;
    }
  }
  
  // Para estilo modern/spotify, colorear la parte llena
  if (style === 'modern' || style === 'spotify') {
    const filledPart = s.filled.repeat(filled);
    const emptyPart = s.empty.repeat(size - filled);
    bar = `${filledPart}${s.cursor}${emptyPart}`;
  }
  
  return bar;
}

/**
 * Formatea la calidad de audio para mostrar
 * @param {string} sourceQuality - Calidad del audio
 * @param {boolean} showDetailed - Mostrar información detallada
 * @returns {string} Calidad formateada
 */
function formatAudioQuality(sourceQuality, showDetailed = false) {
  if (!sourceQuality || sourceQuality === 'unknown') {
    return showDetailed ? 'Calidad desconocida' : '❓ Unknown';
  }
  
  const quality = String(sourceQuality).toLowerCase();
  
  // Mapeo de calidades a emojis y descripciones
  const qualityMap = {
    'high': { emoji: '🔊', desc: 'Alta calidad' },
    'medium': { emoji: '🔉', desc: 'Calidad media' },
    'low': { emoji: '🔈', desc: 'Calidad baja' },
    'best': { emoji: '💎', desc: 'Máxima calidad' },
    'opus': { emoji: '🎵', desc: 'Opus' },
    'webm': { emoji: '📦', desc: 'WebM' },
    'mp4': { emoji: '📹', desc: 'MP4' },
    'm4a': { emoji: '🎵', desc: 'M4A' }
  };
  
  // Buscar en el mapa
  for (const [key, value] of Object.entries(qualityMap)) {
    if (quality.includes(key)) {
      return showDetailed ? value.desc : `${value.emoji} ${sourceQuality}`;
    }
  }
  
  return showDetailed ? sourceQuality : `🎵 ${sourceQuality}`;
}

/**
 * Formatea un mensaje de cola de reproducción
 * @param {Object} queue - Objeto de cola
 * @param {number} limit - Límite de canciones a mostrar
 * @returns {string} Mensaje de cola formateado
 */
function formatQueueMessage(queue, limit = 10) {
  if (!queue || !queue.songs || queue.songs.length === 0) {
    return 'La cola está vacía.';
  }
  
  const songs = queue.songs.slice(0, limit);
  const lines = songs.map((song, index) => {
    const duration = song.durationSec ? ` [${formatDuration(song.durationSec)}]` : '';
    if (index === 0) {
      return `▶️ **${song.title}**${duration}`;
    }
    return `${index}. ${song.title}${duration}`;
  });
  
  if (queue.songs.length > limit) {
    lines.push(`... y ${queue.songs.length - limit} más`);
  }
  
  return lines.join('\n');
}

/**
 * Trunca un texto a una longitud máxima
 * @param {string} text - Texto a truncar
 * @param {number} maxLength - Longitud máxima
 * @returns {string} Texto truncado
 */
function truncate(text, maxLength = 100) {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

/**
 * Formatea un número con separadores de miles
 * @param {number} num - Número a formatear
 * @returns {string} Número formateado
 */
function formatNumber(num) {
  return new Intl.NumberFormat('es-ES').format(num);
}

/**
 * Formatea un porcentaje
 * @param {number} value - Valor (0-1 o 0-100)
 * @param {boolean} isDecimal - Si el valor es decimal (0-1)
 * @returns {string} Porcentaje formateado
 */
function formatPercentage(value, isDecimal = false) {
  const percent = isDecimal ? value * 100 : value;
  return `${Math.round(percent)}%`;
}

/**
 * Crea un embed básico con el estilo del bot
 * @param {Object} options - Opciones del embed
 * @returns {EmbedBuilder} Embed construido
 */
function createEmbed(options = {}) {
  const embed = new EmbedBuilder()
    .setColor(options.color || 0x5865F2)
    .setTimestamp();
  
  if (options.title) embed.setTitle(options.title);
  if (options.description) embed.setDescription(options.description);
  if (options.thumbnail) embed.setThumbnail(options.thumbnail);
  if (options.image) embed.setImage(options.image);
  if (options.author) embed.setAuthor(options.author);
  if (options.footer) embed.setFooter(options.footer);
  if (options.fields) {
    options.fields.forEach(field => embed.addFields(field));
  }
  
  return embed;
}

/**
 * Crea un embed de error
 * @param {string} message - Mensaje de error
 * @param {string} details - Detalles adicionales
 * @returns {EmbedBuilder} Embed de error
 */
function createErrorEmbed(message, details = null) {
  const embed = new EmbedBuilder()
    .setColor(0xED4245)
    .setTitle('❌ Error')
    .setDescription(message)
    .setTimestamp();
  
  if (details) {
    embed.addFields({ name: 'Detalles', value: details });
  }
  
  return embed;
}

/**
 * Crea un embed de éxito
 * @param {string} message - Mensaje de éxito
 * @returns {EmbedBuilder} Embed de éxito
 */
function createSuccessEmbed(message) {
  return new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle('✅ Éxito')
    .setDescription(message)
    .setTimestamp();
}

/**
 * Crea un embed de información
 * @param {string} title - Título
 * @param {string} description - Descripción
 * @returns {EmbedBuilder} Embed de información
 */
function createInfoEmbed(title, description) {
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(title)
    .setDescription(description)
    .setTimestamp();
}

module.exports = {
  formatDuration,
  formatBytes,
  getUptime,
  buildProgressBar,
  formatAudioQuality,
  formatQueueMessage,
  truncate,
  formatNumber,
  formatPercentage,
  createEmbed,
  createErrorEmbed,
  createSuccessEmbed,
  createInfoEmbed
};
