/**
 * @file commands/music/shuffle.js
 * @description Comando para activar/desactivar el modo aleatorio
 */

const logger = require('../../utils/logger');

module.exports = {
  name: 'shuffle',
  description: 'Activa o desactiva el modo aleatorio',
  category: 'music',
  
  /**
   * Ejecuta el comando
   * @param {object} interaction - Interacción de Discord
   * @param {object} client - Cliente de Discord
   * @param {object} context - Contexto con getQueue, saveState, etc.
   */
  async execute(interaction, client, { getQueue, guildState, saveState, renderNowPlaying }) {
    try {
      await interaction.deferReply();
      
      const guild = interaction.guild;
      const q = getQueue(guild.id);
      
      if (!q || q.songs.length === 0) {
        return interaction.editReply('❌ La cola está vacía.');
      }
      
      // Toggle shuffle mode
      q.shuffleMode = !q.shuffleMode;
      
      // Persistir estado
      guildState[guild.id] = guildState[guild.id] || {};
      guildState[guild.id].shuffleMode = q.shuffleMode;
      saveState(guildState);
      
      // Si se activa shuffle y hay más de 2 canciones, mezclar
      if (q.shuffleMode && q.songs.length > 2) {
        const head = q.songs[0]; // Mantener la canción actual
        const rest = q.songs.slice(1);
        
        // Fisher-Yates shuffle
        for (let i = rest.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [rest[i], rest[j]] = [rest[j], rest[i]];
        }
        
        q.songs = [head, ...rest];
      }
      
      await renderNowPlaying(guild.id).catch(() => {});
      await interaction.editReply(`🔀 Aleatorio: ${q.shuffleMode ? "ON" : "OFF"}`);
      
      logger.command(`Shuffle ${q.shuffleMode ? 'activado' : 'desactivado'} por ${interaction.user.tag}`, {
        guildId: guild.id,
        songsInQueue: q.songs.length
      });
    } catch (error) {
      logger.error('[shuffle] Error ejecutando comando', {
        error: error.message,
        user: interaction.user.tag
      });
      
      const errorMsg = '❌ Error al cambiar el modo aleatorio';
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
