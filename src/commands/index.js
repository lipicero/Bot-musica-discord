/**
 * @file commands/index.js
 * @description Sistema de carga dinámica de comandos
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

/**
 * Colección de comandos cargados
 * @type {Map<string, object>}
 */
const commands = new Map();

/**
 * Carga todos los comandos desde las carpetas music/ y utility/
 * @returns {Map<string, object>} Mapa de comandos
 */
function loadCommands() {
  const commandsPath = __dirname;
  const categories = ['music', 'utility'];
  let loaded = 0;
  let failed = 0;
  
  logger.bot('Cargando comandos...');
  
  for (const category of categories) {
    const categoryPath = path.join(commandsPath, category);
    
    if (!fs.existsSync(categoryPath)) {
      logger.warn(`[loadCommands] Categoría no encontrada: ${category}`);
      continue;
    }
    
    const files = fs.readdirSync(categoryPath).filter(f => f.endsWith('.js'));
    
    for (const file of files) {
      try {
        const filePath = path.join(categoryPath, file);
        const command = require(filePath);
        
        // Validar estructura del comando
        if (!command.name || typeof command.execute !== 'function') {
          logger.warn(`[loadCommands] Comando inválido en ${file}: falta name o execute`);
          failed++;
          continue;
        }
        
        // Establecer categoría si no está definida
        if (!command.category) {
          command.category = category;
        }
        
        commands.set(command.name, command);
        loaded++;
        
        logger.bot(`Comando cargado: ${command.name} (${category})`);
      } catch (error) {
        logger.error(`[loadCommands] Error cargando ${file}:`, {
          error: error.message,
          stack: error.stack
        });
        failed++;
      }
    }
  }
  
  logger.bot(`Comandos cargados: ${loaded} exitosos, ${failed} fallidos`);
  
  return commands;
}

/**
 * Obtiene un comando por nombre
 * @param {string} name - Nombre del comando
 * @returns {object|undefined}
 */
function getCommand(name) {
  return commands.get(name);
}

/**
 * Obtiene todos los comandos
 * @returns {Map<string, object>}
 */
function getAllCommands() {
  return commands;
}

/**
 * Obtiene comandos por categoría
 * @param {string} category - Categoría (music, utility)
 * @returns {Array<object>}
 */
function getCommandsByCategory(category) {
  return [...commands.values()].filter(cmd => cmd.category === category);
}

/**
 * Recarga todos los comandos (útil para hot-reload)
 */
function reloadCommands() {
  // Limpiar caché de require
  commands.clear();
  
  const commandsPath = __dirname;
  const categories = ['music', 'utility'];
  
  for (const category of categories) {
    const categoryPath = path.join(commandsPath, category);
    
    if (!fs.existsSync(categoryPath)) continue;
    
    const files = fs.readdirSync(categoryPath).filter(f => f.endsWith('.js'));
    
    for (const file of files) {
      const filePath = path.join(categoryPath, file);
      delete require.cache[require.resolve(filePath)];
    }
  }
  
  return loadCommands();
}

module.exports = {
  loadCommands,
  getCommand,
  getAllCommands,
  getCommandsByCategory,
  reloadCommands,
  commands
};
