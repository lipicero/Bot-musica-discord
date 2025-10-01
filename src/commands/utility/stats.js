/**
 * @file commands/utility/stats.js
 * @description Comando para mostrar estadísticas del bot
 */

const logger = require('../../utils/logger');
const { formatBytes } = require('../../utils/formatters');

/**
 * Calcula el uptime del bot en formato legible
 * @param {number} ms - Milisegundos de uptime
 * @returns {string}
 */
function formatUptime(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

module.exports = {
  name: 'stats',
  description: 'Muestra estadísticas del bot',
  category: 'utility',
  
  /**
   * Ejecuta el comando
   * @param {object} interaction - Interacción de Discord
   * @param {object} client - Cliente de Discord
   * @param {Map} queues - Mapa de colas activas
   */
  async execute(interaction, client, { queues }) {
    try {
      await interaction.deferReply();
      
      const mem = process.memoryUsage();
      const guilds = client.guilds?.cache?.size || 0;
      const connections = [...queues.values()].filter(q => q.connection).length;
      const totalSongs = [...queues.values()].reduce((acc, q) => acc + (q.songs?.length || 0), 0);
      
      const uptime = formatUptime(process.uptime() * 1000);
      
      const stats = [
        `⏱️ **Uptime:** ${uptime}`,
        `💾 **RAM:** ${formatBytes(mem.rss)} (rss) · ${formatBytes(mem.heapUsed)} (heap)`,
        `🏠 **Servidores:** ${guilds}`,
        `🔊 **Conexiones activas:** ${connections}`,
        `🎵 **Canciones en cola:** ${totalSongs}`,
        `📊 **Latencia WS:** ${client.ws.ping}ms`
      ].join('\n');
      
      await interaction.editReply(stats);
      
      logger.command(`Stats solicitado por ${interaction.user.tag}`, {
        guilds,
        connections,
        totalSongs
      });
    } catch (error) {
      logger.error('[stats] Error ejecutando comando', {
        error: error.message,
        user: interaction.user.tag
      });
      
      const errorMsg = '❌ Error al obtener estadísticas';
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
