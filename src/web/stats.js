/**
 * @file web/stats.js
 * @description Sistema de estadísticas web en tiempo real
 */

const logger = require('../utils/logger');

/**
 * Clase para gestionar estadísticas web
 */
class WebStats {
  constructor() {
    this.startTime = Date.now();
    this.totalCommands = 0;
    this.totalSongs = 0;
    this.uniqueUsers = new Set();
    this.guildStats = new Map();
    this.topSongs = new Map();
    this.recentActivity = [];
    this.io = null; // Socket.io instance
    this.queues = null; // Reference to queues
    this.METADATA_CACHE = null;
    this.PRELOAD_CACHE = null;
    this.USER_STATS = null;
  }

  /**
   * Configura referencias necesarias
   */
  configure(io, queues, METADATA_CACHE, PRELOAD_CACHE, USER_STATS) {
    this.io = io;
    this.queues = queues;
    this.METADATA_CACHE = METADATA_CACHE;
    this.PRELOAD_CACHE = PRELOAD_CACHE;
    this.USER_STATS = USER_STATS;
  }

  /**
   * Actualiza estadísticas según la acción
   * @param {string} action - Tipo de acción ('command_used', 'song_played')
   * @param {object} data - Datos de la acción
   */
  update(action, data = {}) {
    const timestamp = Date.now();
    
    switch (action) {
      case 'command_used':
        this.totalCommands++;
        if (data.userId) this.uniqueUsers.add(data.userId);
        if (data.guildId) {
          const guildStat = this.guildStats.get(data.guildId) || { 
            name: data.guildName || 'Unknown', 
            commands: 0, 
            songs: 0 
          };
          guildStat.commands++;
          this.guildStats.set(data.guildId, guildStat);
        }
        break;
        
      case 'song_played':
        this.totalSongs++;
        if (data.userId) this.uniqueUsers.add(data.userId);
        if (data.title) {
          const count = this.topSongs.get(data.title) || 0;
          this.topSongs.set(data.title, count + 1);
        }
        if (data.guildId) {
          const guildStat = this.guildStats.get(data.guildId) || { 
            name: data.guildName || 'Unknown', 
            commands: 0, 
            songs: 0 
          };
          guildStat.songs++;
          this.guildStats.set(data.guildId, guildStat);
        }
        break;
    }
    
    // Agregar a actividad reciente
    this.recentActivity.unshift({
      action,
      data,
      timestamp
    });
    
    // Limitar actividad reciente a 100 elementos
    if (this.recentActivity.length > 100) {
      this.recentActivity = this.recentActivity.slice(0, 100);
    }
    
    // Emitir actualización en tiempo real si Socket.io está configurado
    if (this.io) {
      this.io.emit('stats_update', this.getStats());
    }
  }

  /**
   * Obtiene estadísticas formateadas para el dashboard
   * @returns {object}
   */
  getStats() {
    const now = Date.now();
    const uptime = now - this.startTime;
    
    // Top 10 canciones más reproducidas
    const topSongsArray = Array.from(this.topSongs.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([title, count]) => ({ title, count }));
      
    // Estadísticas por servidor
    const guildsArray = Array.from(this.guildStats.entries())
      .map(([id, stats]) => ({ id, ...stats }));
    
    // Calcular conexiones activas y cola total
    let activeConnections = 0;
    let totalQueued = 0;
    
    if (this.queues) {
      activeConnections = [...this.queues.values()].filter(q => q.connection).length;
      totalQueued = [...this.queues.values()].reduce((total, q) => total + (q.songs?.length || 0), 0);
    }
    
    return {
      uptime: Math.floor(uptime / 1000),
      totalCommands: this.totalCommands,
      totalSongs: this.totalSongs,
      uniqueUsers: this.uniqueUsers.size,
      activeConnections,
      totalQueued,
      topSongs: topSongsArray,
      guilds: guildsArray,
      recentActivity: this.recentActivity.slice(0, 20),
      memoryUsage: process.memoryUsage(),
      cacheStats: {
        metadata: this.METADATA_CACHE?.size || 0,
        preload: this.PRELOAD_CACHE?.size || 0,
        userStats: this.USER_STATS?.size || 0
      }
    };
  }

  /**
   * Emite actualización forzada de estadísticas
   */
  emitUpdate() {
    if (this.io) {
      this.io.emit('stats_update', this.getStats());
    }
  }
}

// Exportar instancia singleton
const webStatsInstance = new WebStats();

module.exports = webStatsInstance;
