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
      q.isPausedByUser = true; // Marcar que el usuario pausó manualmente
      
      // Guardar el tiempo actual de reproducción para mostrarlo correctamente en el panel
      if (q.player.state.resource?.playbackDuration) {
        q.pausedAtTime = Math.floor(q.player.state.resource.playbackDuration / 1000);
      } else if (q.lastPlaybackStart) {
        q.pausedAtTime = Math.floor((Date.now() - q.lastPlaybackStart) / 1000);
      }
      
      logger.warn('[pause] Canción pausada - isPausedByUser configurado', {
        guildId: guild.id,
        status: q.player.state.status,
        isPausedByUser: q.isPausedByUser,
        pausedAtTime: q.pausedAtTime
      });
      
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
