/**
 * @file web/routes/api.js
 * @description Rutas API REST para el dashboard web
 */

const { AudioPlayerStatus } = require('@discordjs/voice');
const logger = require('../../utils/logger');

/**
 * Middleware de autenticación simple
 */
function requireAuth(WEB_PASSWORD) {
  return (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${WEB_PASSWORD}`) {
      return res.status(401).json({ error: 'No autorizado' });
    }
    next();
  };
}

/**
 * Registra todas las rutas API
 * @param {object} app - Aplicación Express
 * @param {object} dependencies - Dependencias (client, queues, getStatsForWeb, etc.)
 */
function registerApiRoutes(app, { client, queues, getStatsForWeb, WEB_PASSWORD }) {
  
  // Login
  app.post('/api/login', (req, res) => {
    try {
      const { password } = req.body;
      if (password === WEB_PASSWORD) {
        res.json({ success: true, token: WEB_PASSWORD });
      } else {
        res.status(401).json({ success: false, error: 'Contraseña incorrecta' });
      }
    } catch (error) {
      logger.error('[api/login] Error:', { error: error.message });
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  });

  // Estadísticas generales
  app.get('/api/stats', (req, res) => {
    try {
      res.json(getStatsForWeb());
    } catch (error) {
      logger.error('[api/stats] Error:', { error: error.message });
      res.status(500).json({ error: 'Error al obtener estadísticas' });
    }
  });

  // Lista de servidores
  app.get('/api/guilds', (req, res) => {
    try {
      const guildsData = [];
      for (const [guildId, guild] of client.guilds.cache) {
        const queue = queues.get(guildId);
        guildsData.push({
          id: guildId,
          name: guild.name,
          memberCount: guild.memberCount,
          isConnected: !!queue?.connection,
          currentSong: queue?.songs?.[0]?.title || null,
          queueLength: queue?.songs?.length || 0
        });
      }
      res.json(guildsData);
    } catch (error) {
      logger.error('[api/guilds] Error:', { error: error.message });
      res.status(500).json({ error: 'Error al obtener servidores' });
    }
  });

  // Cola de un servidor específico
  app.get('/api/queue/:guildId', (req, res) => {
    try {
      const { guildId } = req.params;
      const queue = queues.get(guildId);
      
      if (!queue) {
        return res.status(404).json({ error: 'Servidor no encontrado o sin cola' });
      }
      
      res.json({
        guildId,
        songs: queue.songs.map((song, index) => ({
          position: index,
          title: song.title,
          url: song.url,
          duration: song.durationSec,
          requestedBy: song.requestedById,
          isCurrent: index === 0
        })),
        isPlaying: queue.player?.state?.status === AudioPlayerStatus.Playing,
        volume: Math.round((queue.volume || 1) * 100),
        loop: queue.loop,
        shuffle: queue.shuffleMode
      });
    } catch (error) {
      logger.error('[api/queue] Error:', { 
        error: error.message,
        guildId: req.params.guildId 
      });
      res.status(500).json({ error: 'Error al obtener cola' });
    }
  });

  logger.bot('Rutas API registradas');
}

module.exports = {
  registerApiRoutes,
  requireAuth
};
