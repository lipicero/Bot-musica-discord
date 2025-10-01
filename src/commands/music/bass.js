/**
 * @file commands/music/bass.js
 * @description Comando para ajustar el bass boost
 */

const logger = require('../../utils/logger');
const { AudioPlayerStatus } = require('@discordjs/voice');
const { DEFAULT_BASS_FREQ, DEFAULT_BASS_WIDTH } = require('../../config/constants');

module.exports = {
  name: 'bass',
  description: 'Ajusta el nivel de bass boost',
  category: 'music',
  
  /**
   * Ejecuta el comando
   * @param {object} interaction - Interacción de Discord
   * @param {object} client - Cliente de Discord
   * @param {object} context - Contexto con getQueue, createResourceFromUrl, etc.
   */
  async execute(interaction, client, { getQueue, guildState, saveState, renderNowPlaying, createResourceFromUrl, DEBUG_AUDIO }) {
    try {
      await interaction.deferReply();
      
      const guild = interaction.guild;
      const preset = String(interaction.options.getString("preset", true)).toLowerCase();
      const q = getQueue(guild.id);
      
      // Mapear preset a ganancia en dB
      let gainDb = 0;
      if (preset === "low") gainDb = 2;
      else if (preset === "med") gainDb = 4;
      else if (preset === "high") gainDb = 8;
      else if (preset === "extreme") gainDb = 16;
      else gainDb = 0; // off
      
      q.bassGainDb = gainDb;
      
      // Persistir estado
      guildState[guild.id] = guildState[guild.id] || {};
      guildState[guild.id].bassGainDb = q.bassGainDb;
      saveState(guildState);
      
      // Aplicar al instante: reiniciar la pista actual con ffmpeg si hay algo sonando
      const current = q.songs?.[0];
      if (current && q.player?.state?.status === AudioPlayerStatus.Playing) {
        try {
          // Señalar reemplazo controlado para que no avance la cola
          q.replacingResource = true;
          
          const elapsedSec = Math.floor((q.player?.state?.resource?.playbackDuration || 0) / 1000);
          const res = await createResourceFromUrl(current.url, q.volume ?? 1.0, {
            forceFfmpeg: true,
            bassGainDb: q.bassGainDb,
            bassFreq: DEFAULT_BASS_FREQ,
            bassWidth: DEFAULT_BASS_WIDTH,
            startAtSec: elapsedSec,
          });
          
          q.player.play(res);
        } catch (e) {
          if (DEBUG_AUDIO) console.warn("[bass] reapply failed:", e?.message || e);
          q.replacingResource = false;
        }
      }
      
      await renderNowPlaying(guild.id).catch(() => {});
      
      const response = q.bassGainDb > 0
        ? `🎚️ Bass: ${preset.toUpperCase()} (+${q.bassGainDb} dB)`
        : "🎚️ Bass: OFF";
      
      await interaction.editReply(response);
      
      logger.command(`Bass ajustado a ${preset} por ${interaction.user.tag}`, {
        guildId: guild.id,
        gainDb
      });
    } catch (error) {
      logger.error('[bass] Error ejecutando comando', {
        error: error.message,
        user: interaction.user.tag
      });
      
      const errorMsg = '❌ Error al ajustar el bass';
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
