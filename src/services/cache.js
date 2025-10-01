/**
 * @file cache.js
 * @description Sistema de cache LRU (Least Recently Used) para metadatos y recursos de audio
 * Optimizado para reducir llamadas a APIs externas y mejorar rendimiento
 */

const { DEBUG_AUDIO, CACHE_TTL, MAX_CACHE_SIZE, MAX_PRELOAD_SIZE } = require('../config/constants');
const logger = require('../utils/logger');

// =================== CACHE DE METADATOS (LRU con TTL) ===================
class MetadataCache {
  constructor(maxSize = MAX_CACHE_SIZE, ttl = CACHE_TTL) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.ttl = ttl;
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0,
      expirations: 0
    };
  }

  /**
   * Obtiene un valor del cache si existe y no ha expirado
   * @param {string} key - Clave del cache
   * @returns {object|null} - Datos cacheados o null
   */
  get(key) {
    const cached = this.cache.get(key);
    const now = Date.now();

    if (!cached) {
      this.stats.misses++;
      return null;
    }

    // Verificar expiración
    if (now - cached.timestamp > this.ttl) {
      this.cache.delete(key);
      this.stats.expirations++;
      this.stats.misses++;
      logger.debug(`[cache] Cache expirado para ${key}`);
      return null;
    }

    // Actualizar timestamp (LRU)
    cached.timestamp = now;
    cached.accessCount++;
    this.cache.delete(key);
    this.cache.set(key, cached);

    this.stats.hits++;
    return cached.data;
  }

  /**
   * Guarda un valor en el cache
   * @param {string} key - Clave del cache
   * @param {object} data - Datos a cachear
   */
  set(key, data) {
    const now = Date.now();

    // Si existe, actualizar
    if (this.cache.has(key)) {
      const existing = this.cache.get(key);
      this.cache.delete(key);
      this.cache.set(key, {
        data,
        timestamp: now,
        accessCount: existing.accessCount + 1
      });
      return;
    }

    // Limpiar cache si está lleno (LRU)
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
      this.stats.evictions++;
      logger.debug(`[cache] Evicción LRU: ${firstKey}`);
    }

    // Agregar nuevo elemento
    this.cache.set(key, {
      data,
      timestamp: now,
      accessCount: 1
    });
  }

  /**
   * Verifica si una clave existe y no ha expirado
   * @param {string} key - Clave a verificar
   * @returns {boolean}
   */
  has(key) {
    return this.get(key) !== null;
  }

  /**
   * Elimina una clave del cache
   * @param {string} key - Clave a eliminar
   */
  delete(key) {
    return this.cache.delete(key);
  }

  /**
   * Limpia entradas expiradas del cache
   * @returns {number} - Cantidad de entradas eliminadas
   */
  cleanup() {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, cached] of this.cache.entries()) {
      if (now - cached.timestamp > this.ttl) {
        this.cache.delete(key);
        cleaned++;
        this.stats.expirations++;
      }
    }

    logger.debug(`[cache] Limpieza: ${cleaned} entradas expiradas eliminadas`);
    return cleaned;
  }

  /**
   * Limpia todo el cache
   */
  clear() {
    const size = this.cache.size;
    this.cache.clear();
    logger.audio(`Cache limpiado: ${size} entradas eliminadas`);
  }

  /**
   * Obtiene el tamaño actual del cache
   * @returns {number}
   */
  get size() {
    return this.cache.size;
  }

  /**
   * Obtiene estadísticas del cache
   * @returns {object}
   */
  getStats() {
    const hitRate = this.stats.hits + this.stats.misses > 0
      ? (this.stats.hits / (this.stats.hits + this.stats.misses) * 100).toFixed(2)
      : 0;

    return {
      ...this.stats,
      hitRate: `${hitRate}%`,
      size: this.cache.size,
      maxSize: this.maxSize
    };
  }

  /**
   * Resetea estadísticas
   */
  resetStats() {
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0,
      expirations: 0
    };
  }
}

// =================== CACHE DE PRECARGA (FIFO con prioridad) ===================
class PreloadCache {
  constructor(maxSize = MAX_PRELOAD_SIZE) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0
    };
  }

  /**
   * Genera clave de cache para precarga
   * @param {string} guildId - ID del servidor
   * @param {string} url - URL de la canción
   * @returns {string}
   */
  static generateKey(guildId, url) {
    return `${guildId}_${url}`;
  }

  /**
   * Obtiene un recurso precargado
   * @param {string} guildId - ID del servidor
   * @param {string} url - URL de la canción
   * @param {boolean} consume - Si true, elimina del cache después de obtener (default: true)
   * @returns {object|null}
   */
  get(guildId, url, consume = true) {
    const key = PreloadCache.generateKey(guildId, url);
    const cached = this.cache.get(key);

    if (!cached) {
      this.stats.misses++;
      return null;
    }

    // Verificar expiración (10 minutos)
    const now = Date.now();
    if (now - cached.timestamp > 600000) {
      this.cache.delete(key);
      this.stats.misses++;
      logger.debug(`[preload] Recurso expirado: ${cached.song?.title || 'desconocido'}`);
      return null;
    }

    this.stats.hits++;
    
    if (consume) {
      this.cache.delete(key);
      logger.audio(`Usando recurso precargado: ${cached.song?.title || 'desconocido'}`);
    }

    return cached.resource;
  }

  /**
   * Guarda un recurso en el cache de precarga
   * @param {string} guildId - ID del servidor
   * @param {string} url - URL de la canción
   * @param {object} resource - Recurso de audio
   * @param {object} metadata - Metadatos de la canción
   * @param {object} song - Información de la canción
   * @param {number} priority - Prioridad de la precarga (1 = mayor)
   */
  set(guildId, url, resource, metadata, song, priority = 1) {
    const key = PreloadCache.generateKey(guildId, url);

    // Limpiar si está lleno
    if (this.cache.size >= this.maxSize * 2) {
      this.cleanup();
    }

    this.cache.set(key, {
      resource,
      metadata,
      song,
      priority,
      guildId,
      timestamp: Date.now()
    });

    logger.audio(`Recurso precargado (p${priority}): ${song?.title || 'desconocido'}`);

    // Auto-limpieza después de TTL (10 min para p1, 5 min para otros)
    const ttl = priority === 1 ? 600000 : 300000;
    setTimeout(() => {
      if (this.cache.has(key)) {
        this.cache.delete(key);
        logger.debug(`[preload] Auto-limpieza: ${song?.title || 'desconocido'}`);
      }
    }, ttl);
  }

  /**
   * Verifica si un recurso está precargado
   * @param {string} guildId - ID del servidor
   * @param {string} url - URL de la canción
   * @returns {boolean}
   */
  has(guildId, url) {
    const key = PreloadCache.generateKey(guildId, url);
    return this.cache.has(key);
  }

  /**
   * Elimina un recurso del cache
   * @param {string} guildId - ID del servidor
   * @param {string} url - URL de la canción
   */
  delete(guildId, url) {
    const key = PreloadCache.generateKey(guildId, url);
    return this.cache.delete(key);
  }

  /**
   * Limpia recursos expirados o de baja prioridad
   * @returns {number} - Cantidad de entradas eliminadas
   */
  cleanup() {
    const now = Date.now();
    let cleaned = 0;

    // Ordenar por prioridad y antigüedad
    const entries = Array.from(this.cache.entries()).sort((a, b) => {
      // Menor prioridad primero (números más altos)
      if (a[1].priority !== b[1].priority) {
        return b[1].priority - a[1].priority;
      }
      // Más antiguo primero
      return a[1].timestamp - b[1].timestamp;
    });

    // Eliminar la mitad menos importante
    const toDelete = Math.floor(entries.length / 2);
    for (let i = 0; i < toDelete; i++) {
      this.cache.delete(entries[i][0]);
      cleaned++;
      this.stats.evictions++;
    }

    logger.debug(`[preload] Limpieza: ${cleaned} recursos eliminados`);
    return cleaned;
  }

  /**
   * Limpia todos los recursos de un servidor
   * @param {string} guildId - ID del servidor
   * @returns {number} - Cantidad de entradas eliminadas
   */
  clearGuild(guildId) {
    let cleaned = 0;
    for (const [key, value] of this.cache.entries()) {
      if (value.guildId === guildId) {
        this.cache.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.audio(`Cache de precarga limpiado para servidor ${guildId}: ${cleaned} recursos`);
    }
    return cleaned;
  }

  /**
   * Limpia todo el cache
   */
  clear() {
    const size = this.cache.size;
    this.cache.clear();
    logger.audio(`Cache de precarga limpiado: ${size} recursos eliminados`);
  }

  /**
   * Obtiene el tamaño actual del cache
   * @returns {number}
   */
  get size() {
    return this.cache.size;
  }

  /**
   * Obtiene estadísticas del cache
   * @returns {object}
   */
  getStats() {
    const hitRate = this.stats.hits + this.stats.misses > 0
      ? (this.stats.hits / (this.stats.hits + this.stats.misses) * 100).toFixed(2)
      : 0;

    return {
      ...this.stats,
      hitRate: `${hitRate}%`,
      size: this.cache.size,
      maxSize: this.maxSize
    };
  }
}

// =================== CACHE DE URLS DIRECTAS (temporal) ===================
class DirectUrlCache {
  constructor() {
    this.cache = new Map();
  }

  get(url) {
    return this.cache.get(url);
  }

  set(url, directUrl) {
    this.cache.set(url, directUrl);
    
    // Auto-limpieza después de 5 minutos
    setTimeout(() => {
      this.cache.delete(url);
    }, 300000);
  }

  has(url) {
    return this.cache.has(url);
  }

  delete(url) {
    return this.cache.delete(url);
  }

  clear() {
    this.cache.clear();
  }

  get size() {
    return this.cache.size;
  }
}

// =================== INSTANCIAS SINGLETON ===================
const metadataCache = new MetadataCache();
const preloadCache = new PreloadCache();

// =================== FUNCIONES DE UTILIDAD ===================

/**
 * Inicia limpieza periódica automática
 * @param {number} intervalMs - Intervalo en milisegundos (default: 5 minutos)
 */
function startPeriodicCleanup(intervalMs = 300000) {
  setInterval(() => {
    const metadataCleaned = metadataCache.cleanup();
    const preloadCleaned = preloadCache.cleanup();
    
    if (metadataCleaned > 0 || preloadCleaned > 0) {
      logger.debug(`[cache] Limpieza periódica: ${metadataCleaned} metadatos, ${preloadCleaned} precargas`);
    }
  }, intervalMs);

  logger.bot('Sistema de cache inicializado con limpieza automática cada 5 minutos');
}

/**
 * Obtiene estadísticas consolidadas de todos los caches
 * @returns {object}
 */
function getAllCacheStats() {
  return {
    metadata: metadataCache.getStats(),
    preload: preloadCache.getStats()
  };
}

/**
 * Limpia todos los caches
 */
function clearAllCaches() {
  metadataCache.clear();
  preloadCache.clear();
  logger.bot('Todos los caches han sido limpiados');
}

// =================== EXPORTS ===================
module.exports = {
  // Clases
  MetadataCache,
  PreloadCache,
  DirectUrlCache,
  
  // Instancias singleton
  metadataCache,
  preloadCache,
  
  // Utilidades
  startPeriodicCleanup,
  getAllCacheStats,
  clearAllCaches
};
