/**
 * @file commands/music/queue.js
 * @description Comando para mostrar la cola de reproducción
 */

const logger = require('../../utils/logger');
const { formatDuration } = require('../../utils/formatters');

module.exports = {
  name: 'queue',
  description: 'Muestra la cola de reproducción actual',
  category: 'music',
  
  /**
   * Ejecuta el comando
   * @param {object} interaction - Interacción de Discord
   * @param {object} client - Cliente de Discord
   * @param {object} context - Contexto con queues
   */
  async execute(interaction, client, { queues }) {
    try {
      await interaction.deferReply();
      
      const guild = interaction.guild;
      const q = queues.get(guild.id);
      
      if (!q || q.songs.length === 0) {
        return interaction.editReply('❌ La cola está vacía.');
      }
      
      const elapsed = Math.floor(
        (q.player.state?.resource?.playbackDuration || 0) / 1000
      );
      
      const lines = q.songs.slice(0, 10).map((s, i) => {
        const dur = s.durationSec ? ` [${formatDuration(s.durationSec)}]` : "";
        
        if (i === 0) {
          const left = s.durationSec
            ? ` (${formatDuration(elapsed)} / ${formatDuration(s.durationSec)})`
            : "";
          return `▶️ ${s.title}${dur}${left}`;
        }
        
        return `${i + 1}. ${s.title}${dur}`;
      });
      
      if (q.songs.length > 10) {
        lines.push(`\n...y ${q.songs.length - 10} más`);
      }
      
      await interaction.editReply(lines.join("\n"));
      
      logger.command(`Queue mostrada por ${interaction.user.tag}`, {
        guildId: guild.id,
        totalSongs: q.songs.length
      });
    } catch (error) {
      logger.error('[queue] Error ejecutando comando', {
        error: error.message,
        user: interaction.user.tag
      });
      
      const errorMsg = '❌ Error al mostrar la cola';
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
