/**
 * @file commands/utility/info.js
 * @description Comando para mostrar información técnica detallada de la canción y sistema
 */

const logger = require('../../utils/logger');
const { formatDuration } = require('../../utils/formatters');
const { 
  FORCE_BEST_AUDIO, 
  AUDIO_BUFFER_SIZE, 
  ENABLE_PRELOAD, 
  PRELOAD_AHEAD,
  YT_PARALLEL_DOWNLOADS,
  YT_DOWNLOAD_TIMEOUT,
  MAX_PRELOAD_SIZE
} = require('../../config/constants');

/**
 * Formatea información de calidad de audio
 * @param {string} quality - Calidad del audio
 * @param {boolean} detailed - Si mostrar detalles completos
 * @returns {string}
 */
function formatAudioQuality(quality, detailed = false) {
  if (!quality) return detailed ? 'No disponible' : 'N/A';
  if (detailed) {
    // Formato detallado con explicación
    if (quality.includes('tiny')) return `${quality} (48kbps)`;
    if (quality.includes('small')) return `${quality} (50kbps)`;
    if (quality.includes('medium')) return `${quality} (128kbps)`;
    if (quality.includes('high')) return `${quality} (192kbps)`;
    if (quality.includes('best')) return `${quality} (256kbps+)`;
    return quality;
  }
  return quality;
}

module.exports = {
  name: 'info',
  description: 'Muestra información técnica detallada de la canción actual y del sistema',
  category: 'utility',
  
  /**
   * Ejecuta el comando
   * @param {object} interaction - Interacción de Discord
   * @param {object} client - Cliente de Discord
   * @param {object} context - Contexto con queues, caches, etc.
   */
  async execute(interaction, client, { queues, METADATA_CACHE, PRELOAD_CACHE }) {
    try {
      await interaction.deferReply();
      
      const guild = interaction.guild;
      const q = queues.get(guild.id);
      
      if (!q || q.songs.length === 0) {
        return interaction.editReply('❌ No hay nada en reproducción.');
      }
      
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
      
      if (s.durationSec) {
        techInfo += `⏱️ **Duración:** ${formatDuration(s.durationSec)}\n`;
      }
      
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
          const title = song.title.length > 30 ? song.title.substring(0, 30) + '...' : song.title;
          preloadStatus += `${isPreloaded ? '✅' : '⏳'} ${i + 1}. ${title}\n`;
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
      
      await interaction.editReply(techInfo);
      
      logger.command(`Info solicitado por ${interaction.user.tag}`, {
        guildId: guild.id,
        song: s.title
      });
    } catch (error) {
      logger.error('[info] Error ejecutando comando', {
        error: error.message,
        user: interaction.user.tag
      });
      
      const errorMsg = '❌ Error al obtener información técnica';
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply(errorMsg);
        } else {
          await interaction.reply({ content: errorMsg, flags: 1 << 6 });
        }
      } catch {}
    }
  }
};
