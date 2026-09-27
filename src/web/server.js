/**
 * @file web/server.js
 * @description Servidor web con Express y Socket.io para dashboard
 *
 * En Render Web Service debe escuchar en 0.0.0.0:$PORT desde el arranque
 * (antes de que Discord esté ready). Un solo HTTP sirve dashboard + /health.
 */

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const logger = require('../utils/logger');
const { registerApiRoutes } = require('./routes/api');
const webStats = require('./stats');

/**
 * Crea y configura el servidor web
 * @param {object} dependencies - Dependencias necesarias (client, queues, etc.)
 * @returns {object} - { app, server, io, startWebServer, startHealthServer }
 */
function createWebServer(dependencies) {
  const { client, queues, METADATA_CACHE, PRELOAD_CACHE, USER_STATS } = dependencies;

  // Render inyecta PORT; localmente caemos a WEB_PORT
  const HTTP_PORT = Number(process.env.PORT || process.env.WEB_PORT || 3001);
  const HTTP_HOST = '0.0.0.0';
  const WEB_PASSWORD = process.env.WEB_PASSWORD || 'admin123';
  let httpServerStarted = false;

  // Crear aplicación Express
  const app = express();
  const server = http.createServer(app);

  // Configurar Socket.io
  const io = socketIo(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST']
    }
  });

  // Configurar webStats con referencias necesarias
  webStats.configure(io, queues, METADATA_CACHE, PRELOAD_CACHE, USER_STATS);

  // Middleware de seguridad
  app.use(helmet({
    contentSecurityPolicy: false, // Permitir scripts inline para Chart.js
  }));
  app.use(cors());
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '../../web')));

  // Health check: liviano y disponible antes del login de Discord
  app.get('/health', (req, res) => {
    res.status(200).type('text/plain').send('ok');
  });

  // Registrar rutas API
  registerApiRoutes(app, {
    client,
    queues,
    getStatsForWeb: () => webStats.getStats(),
    WEB_PASSWORD
  });

  // Ruta principal - Dashboard
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../../web', 'index.html'));
  });

  // WebSocket para tiempo real
  io.on('connection', (socket) => {
    logger.bot('[web] Cliente conectado al dashboard');

    // Enviar estadísticas iniciales
    socket.emit('stats_update', webStats.getStats());

    socket.on('disconnect', () => {
      logger.bot('[web] Cliente desconectado del dashboard');
    });
  });

  /**
   * Inicia el único servidor HTTP en 0.0.0.0:$PORT
   */
  function startWebServer() {
    if (httpServerStarted) return;
    httpServerStarted = true;

    try {
      server.listen(HTTP_PORT, HTTP_HOST, () => {
        logger.bot(`[WEB] Escuchando en http://${HTTP_HOST}:${HTTP_PORT} (health: /health)`);
      });
      server.on('error', (error) => {
        logger.error(`[web] Error al escuchar en ${HTTP_HOST}:${HTTP_PORT}:`, {
          error: error.message,
          stack: error.stack
        });
        process.exit(1);
      });
    } catch (error) {
      logger.error('[web] Error al iniciar servidor:', {
        error: error.message,
        stack: error.stack
      });
      process.exit(1);
    }
  }

  /**
   * Compat: antes había un health server aparte en PORT.
   * Ahora /health vive en el mismo HTTP; esta función solo asegura el listen.
   */
  function startHealthServer() {
    startWebServer();
  }

  return {
    app,
    server,
    io,
    startWebServer,
    startHealthServer,
    webStats
  };
}

module.exports = {
  createWebServer
};
