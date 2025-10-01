/**
 * @file commands/music/stop.js
 * @description Comando para detener la música y desconectar el bot
 */

const logger = require('../../utils/logger');
const { getVoiceConnection } = require('@discordjs/voice');

module.exports = {
  name: 'stop',
  description: 'Detiene la música y desconecta el bot',
  category: 'music',
  
  /**
   * Ejecuta el comando
   * @param {object} interaction - Interacción de Discord
   * @param {object} client - Cliente de Discord
   * @param {object} context - Contexto con queues, etc.
   */
  async execute(interaction, client, context) {
    try {
      await interaction.deferReply();
      
      const { queues, idleTimeouts, nowPlayingMessages, nowPlayingTickers } = context;
      const guild = interaction.guild;
      const q = queues.get(guild.id);
      const connection = getVoiceConnection(guild.id);
      
      // Guardar información de la cola antes de limpiar
      const queueText = q && context.formatQueueMessage 
        ? context.formatQueueMessage(q) 
        : "La cola está vacía.";
      
      // Limpiar timeout de inactividad
      if (idleTimeouts?.has(guild.id)) {
        clearTimeout(idleTimeouts.get(guild.id));
        idleTimeouts.delete(guild.id);
      }
      
      // Detener ticker de Now Playing
      try {
        const { stopNowPlayingTicker, deleteNowPlayingPanel } = require('../../handlers/nowplaying-panel');
        if (nowPlayingTickers) {
          stopNowPlayingTicker(guild.id, nowPlayingTickers);
        }
        
        // Eliminar panel de Now Playing
        if (nowPlayingMessages && interaction.channel) {
          await deleteNowPlayingPanel(guild.id, interaction.channel, nowPlayingMessages);
        }
      } catch (panelError) {
        logger.debug('[stop] Error limpiando panel:', { error: panelError.message });
      }
      
      // Limpiar cola y desconectar
      if (q) {
        q.songs = [];
        q.player.stop();
      }
      
      if (connection) {
        connection.destroy();
      }
      
      queues.delete(guild.id);
      
      await interaction.editReply(
        `⏹️ Música detenida y bot desconectado.\n\nCola final:\n${queueText}`
      );
      
      logger.command(`Stop ejecutado por ${interaction.user.tag}`, {
        guildId: guild.id
      });
    } catch (error) {
      logger.error('[stop] Error ejecutando comando', {
        error: error.message,
        user: interaction.user.tag
      });
      
      const errorMsg = '❌ Error al detener la música';
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
