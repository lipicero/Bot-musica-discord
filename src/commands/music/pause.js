/**
 * @file commands/music/pause.js
 * @description Comando para pausar la reproducción
 */

const logger = require('../../utils/logger');

module.exports = {
  name: 'pause',
  description: 'Pausa la reproducción actual',
  category: 'music',
  
  /**
   * Ejecuta el comando
   * @param {object} interaction - Interacción de Discord
   * @param {object} client - Cliente de Discord
   * @param {object} context - Contexto con queues, renderNowPlaying, etc.
   */
  async execute(interaction, client, { queues, stopNowPlayingTicker, renderNowPlaying, formatQueueMessage }) {
    try {
      await interaction.deferReply();
      
      const guild = interaction.guild;
      const q = queues.get(guild.id);
      
      if (!q) {
        return interaction.editReply('❌ No hay nada en reproducción.');
      }
      
      q.player.pause();
      
      try {
        stopNowPlayingTicker(guild.id);
      } catch {}
      
      const queueText = formatQueueMessage(q);
      await interaction.editReply(`⏸️ Pausado.\n\nCola actual:\n${queueText}`);
      await renderNowPlaying(guild.id).catch(() => {});
      
      logger.command(`Pause ejecutado por ${interaction.user.tag}`, {
        guildId: guild.id
      });
    } catch (error) {
      logger.error('[pause] Error ejecutando comando', {
        error: error.message,
        user: interaction.user.tag
      });
      
      const errorMsg = '❌ Error al pausar la reproducción';
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
