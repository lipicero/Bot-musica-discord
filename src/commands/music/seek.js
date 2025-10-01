/**
 * @file commands/music/seek.js
 * @description Comando para saltar a un tiempo específico en la canción
 */

const logger = require('../../utils/logger');
const { formatDuration } = require('../../utils/formatters');
const { DEFAULT_BASS_FREQ, DEFAULT_BASS_WIDTH } = require('../../config/constants');

module.exports = {
  name: 'seek',
  description: 'Salta a un tiempo específico en la canción actual',
  category: 'music',
  
  /**
   * Ejecuta el comando
   * @param {object} interaction - Interacción de Discord
   * @param {object} client - Cliente de Discord
   * @param {object} context - Contexto con getQueue, createResourceFromUrl, etc.
   */
  async execute(interaction, client, { getQueue, createResourceFromUrl, renderNowPlaying }) {
    try {
      await interaction.deferReply();
      
      const guild = interaction.guild;
      const seconds = Math.max(0, interaction.options.getInteger("seconds", true));
      const q = getQueue(guild.id);
      
      if (!q || q.songs.length === 0) {
        return interaction.editReply('❌ No hay nada en reproducción.');
      }
      
      const current = q.songs[0];
      const total = Math.max(0, current.durationSec || 0);
      const target = total ? Math.min(seconds, total - 1) : seconds;
      
      try {
        q.replacingResource = true;
        
        const bassActive = (Number(q.bassGainDb) || 0) > 0;
        const res = await createResourceFromUrl(current.url, q.volume ?? 1.0, {
          forceFfmpeg: bassActive,
          bassGainDb: q.bassGainDb,
          bassFreq: DEFAULT_BASS_FREQ,
          bassWidth: DEFAULT_BASS_WIDTH,
          startAtSec: target,
        });
        
        q.player.play(res);
        
        await renderNowPlaying(guild.id).catch(() => {});
        
        const response = total
          ? `⏩ Seek a ${formatDuration(target)} / ${formatDuration(total)}`
          : `⏩ Seek a ${formatDuration(target)}`;
        
        await interaction.editReply(response);
        
        logger.command(`Seek a ${target}s por ${interaction.user.tag}`, {
          guildId: guild.id,
          targetSeconds: target,
          totalSeconds: total
        });
      } catch (e) {
        logger.error('[seek] Error al hacer seek', {
          error: e.message,
          user: interaction.user.tag
        });
        await interaction.editReply('❌ No se pudo hacer seek.');
      }
    } catch (error) {
      logger.error('[seek] Error ejecutando comando', {
        error: error.message,
        user: interaction.user.tag
      });
      
      const errorMsg = '❌ Error al ejecutar seek';
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
