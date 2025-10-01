/**
 * @file commands/music/clear.js
 * @description Comando para limpiar la cola (mantiene canción actual)
 */

const logger = require('../../utils/logger');

module.exports = {
  name: 'clear',
  description: 'Limpia la cola de reproducción (mantiene la canción actual)',
  category: 'music',
  
  /**
   * Ejecuta el comando
   * @param {object} interaction - Interacción de Discord
   * @param {object} client - Cliente de Discord
   * @param {object} context - Contexto con queues, renderNowPlaying, formatQueueMessage
   */
  async execute(interaction, client, { queues, renderNowPlaying, formatQueueMessage }) {
    try {
      await interaction.deferReply();
      
      const guild = interaction.guild;
      const q = queues.get(guild.id);
      
      if (!q || q.songs.length === 0) {
        return interaction.editReply('❌ La cola está vacía.');
      }
      
      // Mantener solo la canción actual
      if (q.songs.length > 1) {
        q.songs = [q.songs[0]];
      }
      
      const queueText = formatQueueMessage(q);
      await renderNowPlaying(guild.id).catch(() => {});
      
      await interaction.editReply(
        `🧹 Cola limpiada (se mantiene la canción actual).\n\nCola actual:\n${queueText}`
      );
      
      logger.command(`Clear ejecutado por ${interaction.user.tag}`, {
        guildId: guild.id
      });
    } catch (error) {
      logger.error('[clear] Error ejecutando comando', {
        error: error.message,
        user: interaction.user.tag
      });
      
      const errorMsg = '❌ Error al limpiar la cola';
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
