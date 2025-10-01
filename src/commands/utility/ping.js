/**
 * @file commands/utility/ping.js
 * @description Comando para verificar la latencia del bot
 */

const logger = require('../../utils/logger');

module.exports = {
  name: 'ping',
  description: 'Muestra la latencia del bot',
  category: 'utility',
  
  /**
   * Ejecuta el comando
   * @param {object} interaction - Interacción de Discord
   * @param {object} client - Cliente de Discord
   */
  async execute(interaction, client) {
    try {
      // Defer respuesta
      await interaction.deferReply();
      
      const ping = Math.max(0, client.ws.ping || 0);
      
      await interaction.editReply(`🏓 Pong! Latencia WS: ${ping}ms`);
      
      logger.command(`Ping ejecutado por ${interaction.user.tag}`, {
        ping,
        guildId: interaction.guild?.id
      });
    } catch (error) {
      logger.error('[ping] Error ejecutando comando', {
        error: error.message,
        user: interaction.user.tag
      });
      
      const errorMsg = '❌ Error al ejecutar el comando ping';
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
