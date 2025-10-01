/**
 * @file commands/music/nowplaying.js
 * @description Comando para mostrar la canción actual con barra de progreso
 */

const logger = require('../../utils/logger');
const { formatDuration, buildProgressBar } = require('../../utils/formatters');

module.exports = {
  name: 'nowplaying',
  description: 'Muestra la canción que se está reproduciendo actualmente',
  category: 'music',
  
  /**
   * Ejecuta el comando
   * @param {object} interaction - Interacción de Discord
   * @param {object} client - Cliente de Discord
   * @param {object} context - Contexto con queues, METADATA_CACHE, etc.
   */
  async execute(interaction, client, { queues, METADATA_CACHE, DEBUG_AUDIO }) {
    try {
      await interaction.deferReply();
      
      const guild = interaction.guild;
      const q = queues.get(guild.id);
      
      if (!q || q.songs.length === 0) {
        return interaction.editReply('❌ No hay nada en reproducción.');
      }
      
      const s = q.songs[0];
      const metadata = METADATA_CACHE.get(s.url) || {};
      const elapsed = Math.floor(
        (q.player.state?.resource?.playbackDuration || 0) / 1000
      );
      const total = s.durationSec || 0;
      
      // Construir header con información
      let header = total
        ? `🎶 **${s.title}**\n⏱️ ${formatDuration(elapsed)} / ${formatDuration(total)} • 🔊 ${Math.round((q.volume ?? 1) * 100)}%`
        : `🎶 **${s.title}**\n🔴 TRANSMISIÓN EN VIVO • 🔊 ${Math.round((q.volume ?? 1) * 100)}%`;
      
      // Agregar calidad si está disponible
      if (metadata.quality) {
        header += ` • 🎧 ${metadata.quality}`;
      } else {
        // Intentar obtener del estado del reproductor
        const playerResource = q.player.state?.resource;
        if (playerResource?.metadata?.quality) {
          header += ` • 🎧 ${playerResource.metadata.quality}`;
        } else {
          // Mostrar calidad estimada
          const qualityFallback = s.quality || 'Calidad no detectada';
          header += ` • 🎧 ${qualityFallback}`;
        }
      }
      
      // Debug: información del cache
      if (DEBUG_AUDIO) {
        console.log(`[nowplaying:debug] URL: ${s.url}`);
        console.log(`[nowplaying:debug] Metadata en cache:`, metadata);
        console.log(`[nowplaying:debug] Quality:`, metadata.quality);
      }
      
      // Agregar barra de progreso si no es livestream
      const bar = total ? `\n${buildProgressBar(total, elapsed)}` : "";
      
      await interaction.editReply(header + bar);
      
      logger.command(`Now playing solicitado por ${interaction.user.tag}`, {
        guildId: guild.id,
        song: s.title
      });
    } catch (error) {
      logger.error('[nowplaying] Error ejecutando comando', {
        error: error.message,
        user: interaction.user.tag
      });
      
      const errorMsg = '❌ Error al mostrar la canción actual';
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
