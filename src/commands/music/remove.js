/**
 * @file commands/music/remove.js
 * @description Comando para eliminar una canción de la cola por índice
 */

const logger = require('../../utils/logger');
const { getVoiceConnection } = require('@discordjs/voice');

module.exports = {
  name: 'remove',
  description: 'Elimina una canción de la cola por su índice',
  category: 'music',
  
  /**
   * Ejecuta el comando
   * @param {object} interaction - Interacción de Discord
   * @param {object} client - Cliente de Discord
   * @param {object} context - Contexto con queues, playNext, etc.
   */
  async execute(interaction, client, { queues, playNext, clearNowPlaying, renderNowPlaying, formatQueueMessage, guildState, saveState }) {
    try {
      await interaction.deferReply();
      
      const guild = interaction.guild;
      const q = queues.get(guild.id);
      
      if (!q || q.songs.length === 0) {
        return interaction.editReply('❌ La cola está vacía.');
      }
      
      const idx = interaction.options.getInteger("index", true);
      
      if (idx < 1 || idx > q.songs.length) {
        return interaction.editReply(
          `❌ Índice inválido. Rango: 1-${q.songs.length}.`
        );
      }
      
      // Si se elimina la canción actual (índice 1)
      if (idx === 1) {
        q.loop = false;
        guildState[guild.id] = guildState[guild.id] || {};
        guildState[guild.id].loopMode = q.loop;
        saveState(guildState);
        
        if (q.songs.length > 0) {
          // Si hay shuffle activo y más canciones, elegir aleatoria
          if (q.songs.length > 1 && q.shuffleMode) {
            const rest = q.songs.slice(1);
            const pick = Math.floor(Math.random() * rest.length);
            const next = rest[pick];
            const newRest = rest.filter((_, i) => i !== pick);
            q.songs = [next, ...newRest];
          } else {
            q.songs.shift();
          }
        }
        
        if (q.songs.length > 0) {
          await playNext(guild.id);
        } else {
          // No hay más canciones
          const connection = getVoiceConnection(guild.id);
          connection?.destroy();
          queues.delete(guild.id);
          await clearNowPlaying(guild.id).catch(() => {});
        }
      } else {
        // Eliminar canción específica de la cola
        q.songs.splice(idx - 1, 1);
      }
      
      const queueText = formatQueueMessage(q);
      await renderNowPlaying(guild.id).catch(() => {});
      
      await interaction.editReply(
        `🗑️ Eliminado el elemento ${idx}.\n\nCola actual:\n${queueText}`
      );
      
      logger.command(`Eliminada canción ${idx} por ${interaction.user.tag}`, {
        guildId: guild.id,
        remainingSongs: q.songs.length
      });
    } catch (error) {
      logger.error('[remove] Error ejecutando comando', {
        error: error.message,
        user: interaction.user.tag
      });
      
      const errorMsg = '❌ Error al eliminar la canción';
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
