/**
 * @file commands/music/skip.js
 * @description Comando para saltar la canción actual
 */

const logger = require('../../utils/logger');
const { getVoiceConnection } = require('@discordjs/voice');

module.exports = {
  name: 'skip',
  description: 'Salta la canción actual',
  category: 'music',
  
  /**
   * Ejecuta el comando
   * @param {object} interaction - Interacción de Discord
   * @param {object} client - Cliente de Discord
   * @param {object} context - Contexto con queues, renderNowPlaying, etc.
   */
  async execute(interaction, client, { queues, playNext, renderNowPlaying, clearNowPlaying, formatQueueMessage }) {
    try {
      await interaction.deferReply();
      
      const guild = interaction.guild;
      const q = queues.get(guild.id);
      
      if (!q || q.songs.length === 0) {
        return interaction.editReply('❌ No hay nada en reproducción.');
      }
      
      // Desactivar loop y remover canción actual
      q.loop = false;
      q.songs.shift();
      
      if (q.songs.length > 0) {
        await playNext(guild.id);
      } else {
        // No hay más canciones, destruir conexión
        const connection = getVoiceConnection(guild.id);
        connection?.destroy();
        queues.delete(guild.id);
        await clearNowPlaying(guild.id).catch(() => {});
      }
      
      const queueText = formatQueueMessage(q);
      await interaction.editReply(`⏭️ Saltado.\n\nCola actual:\n${queueText}`);
      await renderNowPlaying(guild.id).catch(() => {});
      
      logger.command(`Skip ejecutado por ${interaction.user.tag}`, {
        guildId: guild.id,
        remainingSongs: q.songs.length
      });
    } catch (error) {
      logger.error('[skip] Error ejecutando comando', {
        error: error.message,
        stack: error.stack,
        user: interaction.user.tag
      });
      
      const errorMsg = '❌ Error al saltar la canción';
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
