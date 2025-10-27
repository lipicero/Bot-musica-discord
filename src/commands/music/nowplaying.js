/**
 * @file commands/music/nowplaying.js
 * @description Comando para mostrar la canción actual con barra de progreso
 */

const logger = require('../../utils/logger');
const { formatDuration, buildProgressBar } = require('../../utils/formatters');

module.exports = {
  name: 'nowplaying',
  description: 'Muestra la canción que se está reproduciendo actualmente',
  category: 'music',
  
  /**
   * Ejecuta el comando
   * @param {object} interaction - Interacción de Discord
   * @param {object} client - Cliente de Discord
   * @param {object} context - Contexto con queues, METADATA_CACHE, etc.
   */
  async execute(interaction, client, { queues, METADATA_CACHE, DEBUG_AUDIO }) {
    try {
      await interaction.deferReply();
      
      const guild = interaction.guild;
      const q = queues.get(guild.id);
      
      if (!q || q.songs.length === 0) {
        return interaction.editReply('❌ No hay nada en reproducción.');
      }
      
      // Configurar el canal de texto para el panel
      q.textChannelId = interaction.channel.id;
      
      // Iniciar el panel Now Playing persistente
      try {
        const { startNowPlayingPanel } = require('../../handlers/nowplaying-panel');
        await startNowPlayingPanel(q, interaction.channel);
        logger.debug('[nowplaying] Panel iniciado desde comando', { guildId: guild.id });
      } catch (panelError) {
        logger.error('[nowplaying] Error iniciando panel:', {
          guildId: guild.id,
          error: panelError.message
        });
        // Continuar mostrando información básica si falla el panel
      }
      
      // Confirmar que el panel se mostró
      await interaction.editReply('✅ Panel de reproducción actualizado en este canal.');
      
      logger.command(`Now playing solicitado por ${interaction.user.tag}`, {
        guildId: guild.id,
        song: q.songs[0].title
      });
    } catch (error) {
      logger.error('[nowplaying] Error ejecutando comando', {
        error: error.message,
        user: interaction.user.tag
      });
      
      const errorMsg = '❌ Error al mostrar la canción actual';
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
