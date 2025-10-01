/**
 * @file commands/music/volume.js
 * @description Comando para ajustar el volumen (0-200%)
 */

const logger = require('../../utils/logger');

module.exports = {
  name: 'volume',
  description: 'Ajusta el volumen de reproducción (0-200%)',
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
      let level = interaction.options.getInteger("level", true);
      
      if (typeof level !== "number") level = 100;
      
      // Limitar entre 0-200%
      const pct = Math.max(0, Math.min(200, level));
      
      const q = getQueue(guild.id);
      q.volume = pct / 100;
      
      // Persistir estado
      guildState[guild.id] = guildState[guild.id] || {};
      guildState[guild.id].volume = q.volume;
      saveState(guildState);
      
      // Aplicar volumen al recurso actual
      const res = q.player.state?.resource;
      if (res?.volume?.setVolumeLogarithmic) {
        res.volume.setVolumeLogarithmic(Math.max(0, Math.min(2, q.volume)));
      }
      
      await renderNowPlaying(guild.id).catch(() => {});
      await interaction.editReply(`🔊 Volumen: ${pct}%`);
      
      logger.command(`Volumen ajustado por ${interaction.user.tag}`, {
        guildId: guild.id,
        volume: pct
      });
    } catch (error) {
      logger.error('[volume] Error ejecutando comando', {
        error: error.message,
        user: interaction.user.tag
      });
      
      const errorMsg = '❌ Error al ajustar el volumen';
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
