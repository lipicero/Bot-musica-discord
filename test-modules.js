/**
 * @file test-modules.js
 * @description Script de testing para validar todos los módulos creados
 * Ejecutar con: node test-modules.js
 */

const path = require('path');
const fs = require('fs');

console.log('🧪 Iniciando testing de módulos...\n');

let passedTests = 0;
let failedTests = 0;
const errors = [];

/**
 * Test helper
 */
function test(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
    passedTests++;
  } catch (error) {
    console.error(`❌ ${name}`);
    console.error(`   Error: ${error.message}`);
    failedTests++;
    errors.push({ test: name, error: error.message });
  }
}

// =================== TEST 1: ESTRUCTURA DE ARCHIVOS ===================
console.log('📁 Test 1: Estructura de archivos');
console.log('─────────────────────────────────────');

const expectedFiles = [
  'src/config/constants.js',
  'src/config/env.js',
  'src/utils/logger.js',
  'src/utils/formatters.js',
  'src/utils/validators.js',
  'src/services/cache.js',
  'src/services/metadata.js',
  'src/services/preload.js',
  'src/services/state.js',
  'src/handlers/queue.js',
  'src/handlers/voice.js',
];

expectedFiles.forEach(file => {
  test(`Archivo existe: ${file}`, () => {
    const filePath = path.join(__dirname, file);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Archivo no encontrado: ${filePath}`);
    }
  });
});

console.log('');

// =================== TEST 2: IMPORTS ===================
console.log('📦 Test 2: Imports (require sin errores)');
console.log('─────────────────────────────────────');

let constants, env, logger, formatters, validators;
let cache, metadata, preload, state;
let queue, voice;

test('Import: config/constants.js', () => {
  constants = require('./src/config/constants');
  if (!constants.DEBUG_AUDIO === undefined) throw new Error('DEBUG_AUDIO no exportado');
  if (!constants.MAX_QUEUE_LENGTH) throw new Error('MAX_QUEUE_LENGTH no exportado');
});

test('Import: config/env.js', () => {
  env = require('./src/config/env');
  if (typeof env.getEnv !== 'function') throw new Error('getEnv no exportado');
});

test('Import: utils/logger.js', () => {
  logger = require('./src/utils/logger');
  if (typeof logger.info !== 'function') throw new Error('logger.info no exportado');
  if (typeof logger.audio !== 'function') throw new Error('logger.audio no exportado');
});

test('Import: utils/formatters.js', () => {
  formatters = require('./src/utils/formatters');
  if (typeof formatters.formatDuration !== 'function') throw new Error('formatDuration no exportado');
  if (typeof formatters.formatBytes !== 'function') throw new Error('formatBytes no exportado');
});

test('Import: utils/validators.js', () => {
  validators = require('./src/utils/validators');
  if (typeof validators.isYouTubeUrl !== 'function') throw new Error('isYouTubeUrl no exportado');
  if (typeof validators.sanitizeInput !== 'function') throw new Error('sanitizeInput no exportado');
});

test('Import: services/cache.js', () => {
  cache = require('./src/services/cache');
  if (!cache.metadataCache) throw new Error('metadataCache no exportado');
  if (!cache.preloadCache) throw new Error('preloadCache no exportado');
});

test('Import: services/metadata.js', () => {
  metadata = require('./src/services/metadata');
  if (typeof metadata.getEnhancedMetadata !== 'function') throw new Error('getEnhancedMetadata no exportado');
});

test('Import: services/preload.js', () => {
  preload = require('./src/services/preload');
  if (typeof preload.preloadNextSongs !== 'function') throw new Error('preloadNextSongs no exportado');
});

test('Import: services/state.js', () => {
  state = require('./src/services/state');
  if (typeof state.loadState !== 'function') throw new Error('loadState no exportado');
  if (typeof state.saveState !== 'function') throw new Error('saveState no exportado');
});

test('Import: handlers/queue.js', () => {
  queue = require('./src/handlers/queue');
  if (typeof queue.getQueue !== 'function') throw new Error('getQueue no exportado');
  if (typeof queue.tryEnqueue !== 'function') throw new Error('tryEnqueue no exportado');
});

test('Import: handlers/voice.js', () => {
  voice = require('./src/handlers/voice');
  if (typeof voice.ensureConnection !== 'function') throw new Error('ensureConnection no exportado');
  if (typeof voice.disconnectVoice !== 'function') throw new Error('disconnectVoice no exportado');
});

console.log('');

// =================== TEST 3: FUNCIONALIDAD BÁSICA ===================
console.log('⚙️  Test 3: Funcionalidad básica');
console.log('─────────────────────────────────────');

test('Formatters: formatDuration', () => {
  const result = formatters.formatDuration(125);
  if (result !== '2:05') throw new Error(`Esperado "2:05", obtenido "${result}"`);
});

test('Formatters: formatBytes', () => {
  const result = formatters.formatBytes(1024 * 1024);
  if (!result.includes('MB')) throw new Error(`Esperado "MB", obtenido "${result}"`);
});

test('Formatters: buildProgressBar', () => {
  const result = formatters.buildProgressBar(50, 100, 10);
  if (result.length === 0) throw new Error('Progress bar vacío');
});

test('Validators: isYouTubeUrl', () => {
  const valid = validators.isYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  const invalid = validators.isYouTubeUrl('https://google.com');
  if (!valid) throw new Error('URL válida marcada como inválida');
  if (invalid) throw new Error('URL inválida marcada como válida');
});

test('Validators: extractYouTubeId', () => {
  const id = validators.extractYouTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  if (id !== 'dQw4w9WgXcQ') throw new Error(`Esperado "dQw4w9WgXcQ", obtenido "${id}"`);
});

test('Validators: validateVolume', () => {
  const vol = validators.validateVolume(1.5);
  if (vol !== 1.5) throw new Error(`Esperado 1.5, obtenido ${vol}`);
  
  const tooHigh = validators.validateVolume(5);
  if (tooHigh !== 2) throw new Error(`Volumen no limitado a 2`);
  
  const tooLow = validators.validateVolume(-1);
  if (tooLow !== 0) throw new Error(`Volumen no limitado a 0`);
});

test('Validators: sanitizeInput', () => {
  const clean = validators.sanitizeInput('<script>alert("xss")</script>Hello');
  if (clean.includes('<script>')) throw new Error('Input no sanitizado correctamente');
});

test('Cache: metadataCache set/get', () => {
  cache.metadataCache.set('test-url', { title: 'Test Song' });
  const cached = cache.metadataCache.get('test-url');
  if (!cached || cached.title !== 'Test Song') {
    throw new Error('Cache no funciona correctamente');
  }
});

test('Cache: metadataCache has', () => {
  const exists = cache.metadataCache.has('test-url');
  if (!exists) throw new Error('Cache.has no funciona');
});

test('Cache: metadataCache stats', () => {
  const stats = cache.metadataCache.getStats();
  if (!stats.hits) throw new Error('Stats no tienen hits');
  if (!stats.hitRate) throw new Error('Stats no tienen hitRate');
});

test('Cache: preloadCache generateKey', () => {
  const { PreloadCache } = cache;
  const key = PreloadCache.generateKey('guild123', 'url456');
  if (key !== 'guild123_url456') throw new Error(`Key incorrecta: ${key}`);
});

test('State: loadState', () => {
  const globalState = state.loadState();
  if (typeof globalState !== 'object') throw new Error('loadState no retorna objeto');
});

test('State: getGuildState', () => {
  const globalState = {};
  const guildState = state.getGuildState(globalState, 'test-guild');
  if (!guildState.volume) throw new Error('guildState no tiene volume por defecto');
  if (guildState.volume !== 1.0) throw new Error('Volumen por defecto no es 1.0');
});

test('Queue: getQueue básico', () => {
  const testQueue = queue.getQueue('test-guild-123', {});
  if (!testQueue) throw new Error('getQueue retorna null');
  if (!testQueue.player) throw new Error('Queue no tiene player');
  if (!testQueue.songs) throw new Error('Queue no tiene songs array');
});

test('Queue: tryEnqueue', () => {
  const testQueue = queue.getQueue('test-guild-456', {});
  const song = { title: 'Test Song', url: 'https://test.com' };
  const success = queue.tryEnqueue(testQueue, song);
  if (!success) throw new Error('tryEnqueue falló');
  if (testQueue.songs.length !== 1) throw new Error('Canción no añadida');
});

test('Queue: getQueueStats', () => {
  const testQueue = queue.getQueue('test-guild-789', {});
  const stats = queue.getQueueStats(testQueue);
  if (typeof stats.songs !== 'number') throw new Error('Stats.songs no es número');
  if (typeof stats.loop !== 'boolean') throw new Error('Stats.loop no es boolean');
});

test('Queue: toggleLoop', () => {
  const testQueue = queue.getQueue('test-guild-loop', {});
  const initialLoop = testQueue.loop;
  const newLoop = queue.toggleLoop(testQueue);
  if (newLoop === initialLoop) throw new Error('Loop no cambió');
});

test('Queue: setVolume', () => {
  const testQueue = queue.getQueue('test-guild-vol', {});
  const vol = queue.setVolume(testQueue, 1.5);
  if (vol !== 1.5) throw new Error(`Volumen no configurado correctamente: ${vol}`);
  if (testQueue.volume !== 1.5) throw new Error('Volume no actualizado en queue');
});

test('Queue: setBass', () => {
  const testQueue = queue.getQueue('test-guild-bass', {});
  const bass = queue.setBass(testQueue, 12);
  if (bass !== 12) throw new Error(`Bass no configurado correctamente: ${bass}`);
  if (testQueue.bassGainDb !== 12) throw new Error('Bass no actualizado en queue');
});

test('Voice: sameVoiceChannelRequired (sin bot)', () => {
  // Debe retornar false o true dependiendo de REQUIRE_SAME_VC
  // Sin conexión activa, debe manejar el caso sin errores
  const result = voice.sameVoiceChannelRequired({ id: 'test' }, { voice: {} });
  if (typeof result !== 'boolean') throw new Error('No retorna boolean');
});

test('Voice: isConnected', () => {
  const connected = voice.isConnected('test-guild-not-connected');
  if (typeof connected !== 'boolean') throw new Error('isConnected no retorna boolean');
});

test('Voice: getVoiceChannelInfo (sin conexión)', () => {
  const info = voice.getVoiceChannelInfo('test-guild-no-voice');
  // Debe retornar null si no hay conexión
  if (info !== null && typeof info !== 'object') {
    throw new Error('getVoiceChannelInfo no retorna null u objeto');
  }
});

console.log('');

// =================== TEST 4: LOGGER ===================
console.log('📝 Test 4: Logger (Winston)');
console.log('─────────────────────────────────────');

test('Logger: info', () => {
  logger.info('Test info message');
  // Si no lanza error, está bien
});

test('Logger: error', () => {
  logger.error('Test error message', { test: true });
  // Si no lanza error, está bien
});

test('Logger: audio', () => {
  logger.audio('Test audio log');
});

test('Logger: voice', () => {
  logger.voice('Test voice log');
});

test('Logger: bot', () => {
  logger.bot('Test bot log');
});

test('Logger: command', () => {
  logger.command('Test command log');
});

console.log('');

// =================== TEST 5: CONSTANTS ===================
console.log('🔧 Test 5: Constants (valores esperados)');
console.log('─────────────────────────────────────');

test('Constants: DEBUG_AUDIO es boolean', () => {
  if (typeof constants.DEBUG_AUDIO !== 'boolean') {
    throw new Error(`DEBUG_AUDIO no es boolean: ${typeof constants.DEBUG_AUDIO}`);
  }
});

test('Constants: MAX_QUEUE_LENGTH > 0', () => {
  if (constants.MAX_QUEUE_LENGTH <= 0) {
    throw new Error(`MAX_QUEUE_LENGTH inválido: ${constants.MAX_QUEUE_LENGTH}`);
  }
});

test('Constants: CACHE_TTL > 0', () => {
  if (constants.CACHE_TTL <= 0) {
    throw new Error(`CACHE_TTL inválido: ${constants.CACHE_TTL}`);
  }
});

test('Constants: ENABLE_PRELOAD es boolean', () => {
  if (typeof constants.ENABLE_PRELOAD !== 'boolean') {
    throw new Error(`ENABLE_PRELOAD no es boolean: ${typeof constants.ENABLE_PRELOAD}`);
  }
});

test('Constants: DEFAULT_VOLUME en rango', () => {
  if (constants.DEFAULT_VOLUME < 0 || constants.DEFAULT_VOLUME > 2) {
    throw new Error(`DEFAULT_VOLUME fuera de rango: ${constants.DEFAULT_VOLUME}`);
  }
});

console.log('');

// =================== RESUMEN ===================
console.log('═════════════════════════════════════');
console.log('📊 RESUMEN DE TESTING');
console.log('═════════════════════════════════════');
console.log(`✅ Tests pasados: ${passedTests}`);
console.log(`❌ Tests fallidos: ${failedTests}`);
console.log(`📈 Tasa de éxito: ${((passedTests / (passedTests + failedTests)) * 100).toFixed(1)}%`);
console.log('');

if (failedTests > 0) {
  console.log('❌ ERRORES DETECTADOS:');
  console.log('─────────────────────────────────────');
  errors.forEach(({ test, error }, i) => {
    console.log(`${i + 1}. ${test}`);
    console.log(`   ${error}`);
  });
  console.log('');
  process.exit(1);
} else {
  console.log('🎉 ¡TODOS LOS TESTS PASARON!');
  console.log('');
  console.log('✨ Los módulos están funcionando correctamente:');
  console.log('   • Config (constants, env)');
  console.log('   • Utils (logger, formatters, validators)');
  console.log('   • Services (cache, metadata, preload, state)');
  console.log('   • Handlers (queue, voice)');
  console.log('');
  console.log('✅ Listo para continuar con la modularización!');
  console.log('');
  process.exit(0);
}
