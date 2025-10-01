/**
 * @file state.js
 * @description Servicio de persistencia de estado del bot
 * Guarda y carga configuraciones por servidor (volumen, bass, shuffle, etc.)
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

// =================== RUTAS DE ARCHIVOS ===================
const STATE_DIR = process.cwd();
const STATE_FILE = path.join(STATE_DIR, 'state.json');

// Archivos legacy (para compatibilidad)
const VOLUMES_FILE = path.join(STATE_DIR, 'volumes.json');
const BASS_FILE = path.join(STATE_DIR, 'bass.json');
const SHUFFLE_FILE = path.join(STATE_DIR, 'shuffle.json');

// =================== VALORES POR DEFECTO ===================
const DEFAULT_STATE = {
  volume: 1.0,
  bassGainDb: 0,
  shuffleMode: false,
  loopMode: false,
};

// =================== FUNCIONES DE CARGA ===================

/**
 * Carga el estado completo desde state.json
 * @returns {object} - Estado de todos los servidores
 */
function loadState() {
  let state = {};
  
  try {
    if (fs.existsSync(STATE_FILE)) {
      const content = fs.readFileSync(STATE_FILE, 'utf8');
      const parsed = JSON.parse(content);
      
      if (parsed && typeof parsed === 'object') {
        state = parsed;
        logger.bot(`Estado cargado: ${Object.keys(state).length} servidores`);
      }
    } else {
      logger.bot('No existe state.json, creando nuevo estado');
    }
  } catch (error) {
    logger.error('[state] Error cargando state.json', {
      error: error.message
    });
  }
  
  // Migrar desde archivos legacy si existen
  state = migrateLegacyFiles(state);
  
  return state;
}

/**
 * Migra datos desde archivos legacy (volumes.json, bass.json, shuffle.json)
 * @param {object} currentState - Estado actual
 * @returns {object} - Estado migrado
 */
function migrateLegacyFiles(currentState) {
  let state = { ...currentState };
  let migrated = false;
  
  // Migrar volumes.json
  try {
    if (fs.existsSync(VOLUMES_FILE)) {
      const volumes = JSON.parse(fs.readFileSync(VOLUMES_FILE, 'utf8')) || {};
      
      for (const [guildId, volume] of Object.entries(volumes)) {
        state[guildId] = state[guildId] || {};
        
        if (typeof state[guildId].volume !== 'number') {
          const vol = Math.max(0, Math.min(2, Number(volume) || 1));
          state[guildId].volume = vol;
          migrated = true;
        }
      }
      
      if (migrated) {
        logger.bot('Migrado volumes.json → state.json');
      }
    }
  } catch (error) {
    logger.warn('[state] Error migrando volumes.json', {
      error: error.message
    });
  }
  
  // Migrar bass.json
  try {
    if (fs.existsSync(BASS_FILE)) {
      const bassSettings = JSON.parse(fs.readFileSync(BASS_FILE, 'utf8')) || {};
      
      for (const [guildId, bass] of Object.entries(bassSettings)) {
        state[guildId] = state[guildId] || {};
        
        if (typeof state[guildId].bassGainDb !== 'number') {
          const bassVal = Math.max(0, Math.min(24, Number(bass) || 0));
          state[guildId].bassGainDb = bassVal;
          migrated = true;
        }
      }
      
      if (migrated) {
        logger.bot('Migrado bass.json → state.json');
      }
    }
  } catch (error) {
    logger.warn('[state] Error migrando bass.json', {
      error: error.message
    });
  }
  
  // Migrar shuffle.json
  try {
    if (fs.existsSync(SHUFFLE_FILE)) {
      const shuffleSettings = JSON.parse(fs.readFileSync(SHUFFLE_FILE, 'utf8')) || {};
      
      for (const [guildId, shuffle] of Object.entries(shuffleSettings)) {
        state[guildId] = state[guildId] || {};
        
        if (typeof state[guildId].shuffleMode !== 'boolean') {
          state[guildId].shuffleMode = Boolean(shuffle);
          migrated = true;
        }
      }
      
      if (migrated) {
        logger.bot('Migrado shuffle.json → state.json');
      }
    }
  } catch (error) {
    logger.warn('[state] Error migrando shuffle.json', {
      error: error.message
    });
  }
  
  // Guardar estado migrado si hubo cambios
  if (migrated) {
    saveState(state);
    logger.bot('Migración completada, archivos legacy pueden eliminarse');
  }
  
  return state;
}

// =================== FUNCIONES DE GUARDADO ===================

/**
 * Guarda el estado completo a disco
 * También mantiene archivos legacy para compatibilidad
 * @param {object} state - Estado de todos los servidores
 */
function saveState(state) {
  try {
    // Guardar state.json principal
    const content = JSON.stringify(state, null, 2);
    fs.writeFileSync(STATE_FILE, content, 'utf8');
    
    if (process.env.DEBUG_STATE === '1') {
      logger.debug('[state] Estado guardado', {
        servers: Object.keys(state).length
      });
    }
  } catch (error) {
    logger.error('[state] Error guardando state.json', {
      error: error.message
    });
  }
  
  // Mantener archivos legacy en sync (opcional, para compatibilidad)
  try {
    saveLegacyFiles(state);
  } catch (error) {
    logger.warn('[state] Error guardando archivos legacy', {
      error: error.message
    });
  }
}

/**
 * Guarda archivos legacy para compatibilidad
 * @param {object} state - Estado completo
 */
function saveLegacyFiles(state) {
  const volumes = {};
  const bassSettings = {};
  const shuffleSettings = {};
  
  for (const [guildId, guildState] of Object.entries(state || {})) {
    if (typeof guildState.volume === 'number') {
      volumes[guildId] = guildState.volume;
    }
    if (typeof guildState.bassGainDb === 'number') {
      bassSettings[guildId] = guildState.bassGainDb;
    }
    if (typeof guildState.shuffleMode === 'boolean') {
      shuffleSettings[guildId] = guildState.shuffleMode;
    }
  }
  
  fs.writeFileSync(VOLUMES_FILE, JSON.stringify(volumes, null, 2), 'utf8');
  fs.writeFileSync(BASS_FILE, JSON.stringify(bassSettings, null, 2), 'utf8');
  fs.writeFileSync(SHUFFLE_FILE, JSON.stringify(shuffleSettings, null, 2), 'utf8');
}

// =================== FUNCIONES DE ACCESO ===================

/**
 * Obtiene el estado de un servidor específico
 * @param {object} globalState - Estado global
 * @param {string} guildId - ID del servidor
 * @returns {object} - Estado del servidor con valores por defecto
 */
function getGuildState(globalState, guildId) {
  if (!globalState[guildId]) {
    globalState[guildId] = { ...DEFAULT_STATE };
  }
  
  // Asegurar que tenga todos los valores por defecto
  return {
    ...DEFAULT_STATE,
    ...globalState[guildId]
  };
}

/**
 * Actualiza el volumen de un servidor
 * @param {object} globalState - Estado global
 * @param {string} guildId - ID del servidor
 * @param {number} volume - Volumen (0-2)
 */
function setVolume(globalState, guildId, volume) {
  const vol = Math.max(0, Math.min(2, Number(volume) || 1));
  
  if (!globalState[guildId]) {
    globalState[guildId] = { ...DEFAULT_STATE };
  }
  
  globalState[guildId].volume = vol;
  saveState(globalState);
  
  logger.debug(`[state] Volumen actualizado para ${guildId}: ${(vol * 100).toFixed(0)}%`);
}

/**
 * Actualiza el bass de un servidor
 * @param {object} globalState - Estado global
 * @param {string} guildId - ID del servidor
 * @param {number} bassGainDb - Ganancia de bass (0-24 dB)
 */
function setBass(globalState, guildId, bassGainDb) {
  const bass = Math.max(0, Math.min(24, Number(bassGainDb) || 0));
  
  if (!globalState[guildId]) {
    globalState[guildId] = { ...DEFAULT_STATE };
  }
  
  globalState[guildId].bassGainDb = bass;
  saveState(globalState);
  
  logger.debug(`[state] Bass actualizado para ${guildId}: ${bass}dB`);
}

/**
 * Actualiza el modo shuffle de un servidor
 * @param {object} globalState - Estado global
 * @param {string} guildId - ID del servidor
 * @param {boolean} enabled - Activar/desactivar shuffle
 */
function setShuffleMode(globalState, guildId, enabled) {
  if (!globalState[guildId]) {
    globalState[guildId] = { ...DEFAULT_STATE };
  }
  
  globalState[guildId].shuffleMode = Boolean(enabled);
  saveState(globalState);
  
  logger.debug(`[state] Shuffle ${enabled ? 'activado' : 'desactivado'} para ${guildId}`);
}

/**
 * Actualiza el modo loop de un servidor
 * @param {object} globalState - Estado global
 * @param {string} guildId - ID del servidor
 * @param {boolean} enabled - Activar/desactivar loop
 */
function setLoopMode(globalState, guildId, enabled) {
  if (!globalState[guildId]) {
    globalState[guildId] = { ...DEFAULT_STATE };
  }
  
  globalState[guildId].loopMode = Boolean(enabled);
  saveState(globalState);
  
  logger.debug(`[state] Loop ${enabled ? 'activado' : 'desactivado'} para ${guildId}`);
}

/**
 * Guarda múltiples propiedades del estado de un servidor
 * @param {object} globalState - Estado global
 * @param {string} guildId - ID del servidor
 * @param {object} stateData - Datos a guardar (volume, loop, bass, etc.)
 */
function saveGuildState(globalState, guildId, stateData) {
  if (!globalState[guildId]) {
    globalState[guildId] = { ...DEFAULT_STATE };
  }
  
  // Actualizar propiedades según los datos proporcionados
  if (typeof stateData.volume === 'number') {
    globalState[guildId].volume = Math.max(0, Math.min(2, stateData.volume));
  }
  
  if (typeof stateData.loop === 'boolean') {
    globalState[guildId].loopMode = stateData.loop;
  }
  
  if (typeof stateData.bass !== 'undefined') {
    // Convertir 'off' a 0, o usar el valor numérico
    const bassValue = stateData.bass === 'off' ? 0 : Number(stateData.bass) || 0;
    globalState[guildId].bassGainDb = Math.max(0, Math.min(24, bassValue));
  }
  
  if (typeof stateData.shuffleMode === 'boolean') {
    globalState[guildId].shuffleMode = stateData.shuffleMode;
  }
  
  saveState(globalState);
  
  logger.debug(`[state] Estado guardado para ${guildId}:`, stateData);
}

/**
 * Elimina el estado de un servidor
 * @param {object} globalState - Estado global
 * @param {string} guildId - ID del servidor
 */
function clearGuildState(globalState, guildId) {
  if (globalState[guildId]) {
    delete globalState[guildId];
    saveState(globalState);
    logger.bot(`Estado eliminado para servidor ${guildId}`);
  }
}

/**
 * Obtiene estadísticas del estado
 * @param {object} globalState - Estado global
 * @returns {object} - Estadísticas
 */
function getStateStats(globalState) {
  const servers = Object.keys(globalState).length;
  const avgVolume = Object.values(globalState)
    .map(s => s.volume || 1)
    .reduce((a, b) => a + b, 0) / (servers || 1);
  
  const withBass = Object.values(globalState)
    .filter(s => (s.bassGainDb || 0) > 0).length;
  
  const withShuffle = Object.values(globalState)
    .filter(s => s.shuffleMode).length;
  
  return {
    servers,
    avgVolume: avgVolume.toFixed(2),
    withBass,
    withShuffle
  };
}

// =================== EXPORTS ===================
module.exports = {
  loadState,
  saveState,
  saveGuildState,
  getGuildState,
  setVolume,
  setBass,
  setShuffleMode,
  setLoopMode,
  clearGuildState,
  getStateStats,
  DEFAULT_STATE
};
