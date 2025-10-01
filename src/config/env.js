// Gestión segura de variables de entorno
require('dotenv').config({ quiet: true });

class EnvironmentConfig {
  /**
   * Obtiene una variable de entorno
   * @param {string} key - Nombre de la variable
   * @param {*} defaultValue - Valor por defecto si no existe
   * @returns {string|undefined}
   */
  static get(key, defaultValue = undefined) {
    const value = process.env[key];
    return value !== undefined ? value : defaultValue;
  }

  /**
   * Obtiene una variable de entorno requerida
   * @param {string} key - Nombre de la variable
   * @throws {Error} Si la variable no está definida
   * @returns {string}
   */
  static getRequired(key) {
    const value = process.env[key];
    if (!value) {
      throw new Error(`Variable de entorno requerida ${key} no está definida`);
    }
    return value;
  }

  /**
   * Obtiene el token de Discord (requerido)
   * @returns {string}
   */
  static getToken() {
    return this.getRequired('DISCORD_TOKEN');
  }

  /**
   * Obtiene una versión segura del token para logs
   * @returns {string}
   */
  static getSafeToken() {
    const token = this.getToken();
    return token.substring(0, 10) + '...***';
  }

  /**
   * Obtiene la cookie de YouTube (opcional)
   * @returns {string|null}
   */
  static getYTCookie() {
    return this.get('YT_COOKIE', null);
  }

  /**
   * Verifica si todas las variables requeridas están presentes
   * @returns {boolean}
   */
  static validateRequiredVars() {
    const required = ['DISCORD_TOKEN'];
    const missing = required.filter(key => !process.env[key]);
    
    if (missing.length > 0) {
      console.error('[env] Variables de entorno faltantes:', missing.join(', '));
      return false;
    }
    
    return true;
  }

  /**
   * Obtiene todas las configuraciones como objeto
   * @returns {Object}
   */
  static getAll() {
    return {
      discord: {
        token: this.getToken(),
        commandsScope: this.get('COMMANDS_SCOPE', 'global'),
        devGuildId: this.get('DEV_GUILD_ID', null)
      },
      youtube: {
        cookie: this.getYTCookie()
      },
      audio: {
        preferWebmOpus: this.get('PREFER_WEBM_OPUS') === '1',
        forceBestAudio: this.get('FORCE_BEST_AUDIO') === '1',
        bufferSize: Number(this.get('AUDIO_BUFFER_SIZE', '32')),
        optimizeAudio: this.get('FFMPEG_OPTIMIZE_AUDIO') === '1',
        opusBitrate: Number(this.get('OPUS_BITRATE', '160'))
      },
      performance: {
        enablePreload: this.get('ENABLE_PRELOAD') !== '0',
        preloadAhead: Number(this.get('PRELOAD_AHEAD', '2')),
        parallelDownloads: Number(this.get('YT_PARALLEL_DOWNLOADS', '3')),
        downloadTimeout: Number(this.get('YT_DOWNLOAD_TIMEOUT', '60')) * 1000
      },
      limits: {
        maxPlaylistItems: Number(this.get('MAX_PLAYLIST_ITEMS', '25')),
        maxQueueLength: Number(this.get('MAX_QUEUE_LENGTH', '200'))
      },
      behavior: {
        requireSameVC: this.get('REQUIRE_SAME_VC', '1') === '1',
        pinPanel: this.get('PIN_PANEL', '1') === '1',
        ephemeralSlash: this.get('EPHEMERAL_SLASH', '1') === '1',
        idleTimeoutMinutes: Number(this.get('IDLE_TIMEOUT_MINUTES', '10'))
      },
      debug: {
        audio: this.get('DEBUG_AUDIO') === '1',
        discord: this.get('DEBUG_DISCORD') === '1'
      },
      web: {
        port: Number(this.get('WEB_PORT', '3000')),
        healthPort: Number(this.get('HEALTH_PORT', '8080'))
      }
    };
  }
}

// Exportar clase y método helper común
module.exports = EnvironmentConfig;
module.exports.getEnv = EnvironmentConfig.get.bind(EnvironmentConfig);
