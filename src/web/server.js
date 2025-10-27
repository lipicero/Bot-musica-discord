/**
 * @file web/server.js
 * @description Servidor web con Express y Socket.io para dashboard
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
 * @returns {object} - { app, server, io, startWebServer }
 */
function createWebServer(dependencies) {
  const { client, queues, METADATA_CACHE, PRELOAD_CACHE, USER_STATS } = dependencies;
  
  const WEB_PORT = Number(process.env.WEB_PORT || 3001);
  const WEB_PASSWORD = process.env.WEB_PASSWORD || "admin123";

  // Crear aplicación Express
  const app = express();
  const server = http.createServer(app);
  
  // Configurar Socket.io
  const io = socketIo(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
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
   * Inicia el servidor web
   */
  function startWebServer() {
    try {
      server.listen(WEB_PORT, () => {
        logger.bot(`[WEB] Dashboard disponible en: http://localhost:${WEB_PORT}`);
      });
    } catch (error) {
      logger.error('[web] Error al iniciar servidor:', {
        error: error.message,
        stack: error.stack
      });
    }
  }

  /**
   * Crea servidor de health check para Render
   */
  function startHealthServer() {
    const port = Number(process.env.PORT || 0);
    if (!port) return; // No estamos en un Web Service
    
    const healthHttp = require('http');
    const healthServer = healthHttp.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    });
    
    healthServer.listen(port, () => {
      logger.bot(`[http] Health server escuchando en :${port}`);
    });
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
