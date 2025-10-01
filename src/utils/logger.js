// Sistema de logging profesional con Winston
const winston = require('winston');
const path = require('path');
const fs = require('fs');

// Crear directorio de logs si no existe
const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Formato personalizado para console
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.colorize(),
  winston.format.printf(({ level, message, timestamp, ...meta }) => {
    let msg = `${timestamp} [${level}] ${message}`;
    if (Object.keys(meta).length > 0) {
      msg += ` ${JSON.stringify(meta)}`;
    }
    return msg;
  })
);

// Formato para archivos (JSON estructurado)
const fileFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

// Crear logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  transports: [
    // Console para desarrollo
    new winston.transports.Console({
      format: consoleFormat,
      level: 'debug'
    }),
    
    // Archivo para errores
    new winston.transports.File({
      filename: path.join(logsDir, 'bot.err.log'),
      level: 'error',
      format: fileFormat,
      maxsize: 5242880, // 5MB
      maxFiles: 5,
      tailable: true
    }),
    
    // Archivo para todos los logs
    new winston.transports.File({
      filename: path.join(logsDir, 'bot.out.log'),
      format: fileFormat,
      maxsize: 5242880, // 5MB
      maxFiles: 10,
      tailable: true
    })
  ],
  // Capturar uncaughtException y unhandledRejection
  exceptionHandlers: [
    new winston.transports.Console({
      format: consoleFormat,
      level: 'error'
    }),
    new winston.transports.File({
      filename: path.join(logsDir, 'exceptions.log'),
      format: fileFormat,
      maxsize: 5242880, // 5MB
      maxFiles: 3
    })
  ],
  rejectionHandlers: [
    new winston.transports.Console({
      format: consoleFormat,
      level: 'error'
    }),
    new winston.transports.File({
      filename: path.join(logsDir, 'rejections.log'),
      format: fileFormat,
      maxsize: 5242880, // 5MB
      maxFiles: 3
    })
  ],
  // NO salir del proceso cuando ocurran errores no capturados
  exitOnError: false
});

// Métodos de conveniencia con contexto
logger.audio = (message, meta = {}) => {
  logger.info(`[audio] ${message}`, meta);
};

logger.voice = (message, meta = {}) => {
  logger.info(`[voice] ${message}`, meta);
};

logger.command = (message, meta = {}) => {
  logger.info(`[command] ${message}`, meta);
};

logger.cache = (message, meta = {}) => {
  logger.debug(`[cache] ${message}`, meta);
};

logger.healthcheck = (message, meta = {}) => {
  logger.info(`[healthcheck] ${message}`, meta);
};

logger.cleanup = (message, meta = {}) => {
  logger.info(`[cleanup] ${message}`, meta);
};

logger.youtube = (message, meta = {}) => {
  logger.debug(`[youtube] ${message}`, meta);
};

logger.spotify = (message, meta = {}) => {
  logger.debug(`[spotify] ${message}`, meta);
};

logger.web = (message, meta = {}) => {
  logger.info(`[web] ${message}`, meta);
};

logger.bot = (message, meta = {}) => {
  logger.info(`[bot] ${message}`, meta);
};

logger.client = (message, meta = {}) => {
  logger.info(`[client] ${message}`, meta);
};

// Método para sanitizar información sensible
logger.sanitize = (obj) => {
  const sanitized = { ...obj };
  const sensitiveKeys = ['token', 'password', 'secret', 'cookie', 'authorization'];
  
  for (const key of Object.keys(sanitized)) {
    if (sensitiveKeys.some(sk => key.toLowerCase().includes(sk))) {
      sanitized[key] = '***REDACTED***';
    }
  }
  
  return sanitized;
};

module.exports = logger;
