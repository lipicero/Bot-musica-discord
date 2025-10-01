/**
 * @file commands/music/loop.js
 * @description Comando para activar/desactivar el bucle
 */

const logger = require('../../utils/logger');

module.exports = {
  name: 'loop',
  description: 'Activa o desactiva el modo de bucle',
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
      const mode = String(interaction.options.getString("mode", true)).toLowerCase();
      const q = getQueue(guild.id);
      
      if (!q || q.songs.length === 0) {
        return interaction.editReply('❌ No hay nada en reproducción.');
      }
      
      // Ajustar modo de bucle
      if (mode === "on") q.loop = true;
      else if (mode === "off") q.loop = false;
      else q.loop = !q.loop; // toggle
      
      // Persistir estado
      guildState[guild.id] = guildState[guild.id] || {};
      guildState[guild.id].loop = q.loop;
      saveState(guildState);
      
      await renderNowPlaying(guild.id).catch(() => {});
      await interaction.editReply(`🔁 Bucle: ${q.loop ? "ON" : "OFF"}`);
      
      logger.command(`Loop ${q.loop ? 'activado' : 'desactivado'} por ${interaction.user.tag}`, {
        guildId: guild.id
      });
    } catch (error) {
      logger.error('[loop] Error ejecutando comando', {
        error: error.message,
        user: interaction.user.tag
      });
      
      const errorMsg = '❌ Error al cambiar el modo de bucle';
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
