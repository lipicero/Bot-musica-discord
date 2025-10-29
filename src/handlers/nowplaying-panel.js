/**
 * @file handlers/nowplaying-panel.js
 * @description Panel Now Playing con embed y botones interactivos
 */

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { AudioPlayerStatus } = require('@discordjs/voice');
const { formatDuration, buildProgressBar } = require('../utils/formatters');
const logger = require('../utils/logger');

function buildControlsComponents(q) {
  const isPaused = q.player.state.status === AudioPlayerStatus.Paused || q.isPausedByUser;
  const s = q.songs?.[0];
  const canShuffle = (q.songs?.length || 0) > 2;
  const hasSong = !!s;
  const canSeek = hasSong && s?.durationSec && s.durationSec > 30; // Solo para canciones con duración > 30s
  const volPercent = Math.round((q.volume ?? 1) * 100);
  const volDownDisabled = volPercent <= 0;
  const volUpDisabled = volPercent >= 200;
  
  // Fila 1: transporte básico y modos
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(isPaused ? 'music_resume' : 'music_pause')
      .setEmoji(isPaused ? '▶️' : '⏸️')
      .setLabel(isPaused ? 'Reanudar' : 'Pausar')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!hasSong),
    new ButtonBuilder()
      .setCustomId('music_skip')
      .setEmoji('⏭️')
      .setLabel('Siguiente')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasSong),
    new ButtonBuilder()
      .setCustomId('music_stop')
      .setEmoji('🛑')
      .setLabel('Detener')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('music_loop')
      .setEmoji('🔁')
      .setLabel('Bucle')
      .setStyle(q.loop ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('music_shuffle')
      .setEmoji('🔀')
      .setLabel('Aleatorio')
      .setStyle(q.shuffleMode ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(!canShuffle)
  );
  
  // Fila 2: controles de navegación y volumen
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('music_replay')
      .setEmoji('🔄')
      .setLabel('Reiniciar')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasSong),
    new ButtonBuilder()
      .setCustomId('music_rewind')
      .setEmoji('⏪')
      .setLabel('-10s')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!canSeek),
    new ButtonBuilder()
      .setCustomId('music_forward')
      .setEmoji('⏩')
      .setLabel('+10s')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!canSeek),
    new ButtonBuilder()
      .setCustomId('music_vol_down')
      .setEmoji('🔉')
      .setLabel('Vol -')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(volDownDisabled),
    new ButtonBuilder()
      .setCustomId('music_vol_up')
      .setEmoji('🔊')
      .setLabel('Vol +')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(volUpDisabled)
  );
  
  // Fila 3: utilidades y enlaces
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('music_save')
      .setEmoji('⭐')
      .setLabel('Guardar')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasSong),
    new ButtonBuilder()
      .setCustomId('music_queue')
      .setEmoji('📜')
      .setLabel('Cola')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!(q.songs?.length > 0))
  );
  
  if (s?.url) {
    row3.addComponents(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setURL(s.url)
        .setEmoji('🌐')
        .setLabel('Abrir')
    );
  }
  
  return [row1, row2, row3];
}

function buildNowPlayingEmbed(q) {
  const s = q.songs?.[0];
  if (!s) {
    return new EmbedBuilder()
      .setColor('#FF0000')
      .setTitle('⏹️ Sin reproducción')
      .setDescription('No hay canciones en la cola');
  }

  // Validar que el player existe
  if (!q.player?.state) {
    logger.warn('[nowplaying] Player state no disponible');
    return new EmbedBuilder()
      .setColor('#FF0000')
      .setTitle('⏹️ Error de reproducción')
      .setDescription('Estado del reproductor no disponible');
  }

  const isPaused = q.player.state.status === AudioPlayerStatus.Paused || q.isPausedByUser;
  const embedColor = 0x5865f2;
  const totalSeconds = s.durationSec || 0; // Definir totalSeconds aquí
  
  logger.debug(`[nowplaying] Estado del player: ${q.player.state.status}, isPaused: ${isPaused}, isPausedByUser: ${q.isPausedByUser}, pausedAtTime: ${q.pausedAtTime}, lastPlaybackStart: ${q.lastPlaybackStart}`, { guildId: q.guildId });
  
  // Calcular tiempo de reproducción de manera más confiable
  let currentSeconds = 0;
  
  if (isPaused) {
    // Si está pausado, usar el tiempo guardado al pausar
    if (q.pausedAtTime !== undefined) {
      currentSeconds = q.pausedAtTime;
      logger.debug(`[nowplaying] Usando pausedAtTime: ${currentSeconds}s`, { guildId: q.guildId });
    } else if (q.lastPlaybackStart) {
      // Fallback: calcular tiempo hasta el momento de pausa (no debería pasar normalmente)
      currentSeconds = Math.floor((Date.now() - q.lastPlaybackStart) / 1000);
      logger.warn(`[nowplaying] pausedAtTime no definido durante pausa, calculando tiempo: ${currentSeconds}s`, { guildId: q.guildId });
    } else if (q.player.state.resource?.playbackDuration) {
      currentSeconds = Math.floor(q.player.state.resource.playbackDuration / 1000);
      logger.debug(`[nowplaying] Usando playbackDuration en pausa: ${currentSeconds}s`, { guildId: q.guildId });
    }
  } else {
    // Si no está pausado, calcular tiempo transcurrido desde el inicio
    if (q.lastPlaybackStart) {
      currentSeconds = Math.floor((Date.now() - q.lastPlaybackStart) / 1000);
      logger.debug(`[nowplaying] Calculando tiempo transcurrido: ${currentSeconds}s desde ${new Date(q.lastPlaybackStart).toISOString()}`, { guildId: q.guildId });
    } else if (q.player.state.resource?.playbackDuration) {
      // Fallback al método anterior
      currentSeconds = Math.floor(q.player.state.resource.playbackDuration / 1000);
      logger.debug(`[nowplaying] Usando playbackDuration: ${currentSeconds}s`, { guildId: q.guildId });
    }
  }
  
  // Asegurar que no exceda la duración total
  if (totalSeconds > 0 && currentSeconds > totalSeconds) {
    currentSeconds = totalSeconds;
  }
  
  // Construir el embed con campos
  const embed = new EmbedBuilder()
    .setColor(embedColor)
    .setTitle(isPaused ? '⏸️ Pausado' : '🎶 Reproduciendo ahora')
    .addFields(
      {
        name: '🎵 Canción:',
        value: s ? `[${s.title}](${s.url})` : '—',
        inline: false,
      },
      {
        name: '👤 Agregado por:',
        value: s.requestedById ? `<@${s.requestedById}>` : s.requestedByTag || '—',
        inline: true,
      },
      {
        name: '⏱️ Duración:',
        value: totalSeconds ? formatDuration(totalSeconds) : '🔴 EN VIVO',
        inline: true,
      },
      {
        name: '🎧 Salida:',
        value: s.format?.audioQuality || s.format?.quality || '192kbps Opus',
        inline: true,
      }
    );

  // Agregar próximas canciones en cola si hay más de una
  if (q.songs.length > 1) {
    const nextSongs = q.songs.slice(1, 4).map((song, i) => 
      `${i + 1}. ${song.title.length > 30 ? song.title.substring(0, 30) + '...' : song.title}`
    ).join('\n');
    
    const remaining = q.songs.length - 1;
    const queueText = remaining > 3 
      ? `${nextSongs}\n... y ${remaining - 3} más canciones`
      : nextSongs;
    
    embed.addFields({
      name: `📝 Próximas en cola (${remaining})`,
      value: queueText || '—',
      inline: false,
    });
  }

  // Agregar barra de progreso en la descripción
  if (totalSeconds > 0) {
    try {
      const progressBar = buildProgressBar(totalSeconds, currentSeconds, 24, 'spotify');
      embed.setDescription(`${progressBar}\n${formatDuration(currentSeconds)} / ${formatDuration(totalSeconds)}`);
    } catch (progressError) {
      logger.warn('[nowplaying] Error creando barra de progreso:', progressError.message);
      embed.setDescription(`${formatDuration(currentSeconds)} / ${formatDuration(totalSeconds)}`);
    }
  } else {
    embed.setDescription('🔴 **TRANSMISIÓN EN VIVO** - Sin barra de progreso');
  }

  // Footer con controles
  const volPercent = Math.round((q.volume ?? 1) * 100);
  const bassGainDb = q.bassGainDb || 0;
  embed.setFooter({
    text: `🎛️ Controles debajo · Vol: ${volPercent}% · Repetir: ${q.loop ? '🔁' : '❌'} · Aleatorio: ${q.shuffleMode ? '🔀' : '❌'} · Bass: ${bassGainDb > 0 ? `+${bassGainDb}dB` : '❌'}`,
  });

  // Thumbnail de alta calidad
  if (s.thumbnailUrl) {
    let bestThumbnail = s.thumbnailUrl;
    // Para YouTube, intentar obtener maxresdefault (1280x720)
    if (s.thumbnailUrl.includes('youtube.com') || s.thumbnailUrl.includes('ytimg.com')) {
      const videoId = s.url?.match(/(?:v=|\/)([\w-]{11})/)?.[1];
      if (videoId) {
        bestThumbnail = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
      }
    }
    embed.setThumbnail(bestThumbnail);
  }
  
  return embed;
}

async function startNowPlayingPanel(q, textChannel) {
  logger.debug('[nowplaying] Iniciando panel - songs:', q.songs?.length || 0, 'player status:', q.player?.state?.status);
  
  try {
    const embed = buildNowPlayingEmbed(q);
    if (!embed) {
      logger.error('[nowplaying] buildNowPlayingEmbed retornó null/undefined');
      return;
    }
    
    const components = buildControlsComponents(q);
    
    // Si ya existe un panel válido, solo actualizar en lugar de crear uno nuevo
    if (q.nowPlayingMessage) {
      try {
        await q.nowPlayingMessage.edit({ embeds: [embed], components: components });
        logger.debug('[nowplaying] Panel actualizado (reutilizado)');
        return;
      } catch (error) {
        // Si falla (mensaje eliminado), continuar para crear uno nuevo
        if (error.code === 10008 || error.code === 50001) {
          logger.debug('[nowplaying] Mensaje eliminado, creando nuevo panel');
          await stopNowPlayingPanel(q);
        } else {
          throw error;
        }
      }
    }
    
    // Crear nuevo panel
    const message = await textChannel.send({ embeds: [embed], components: components });
    
    q.nowPlayingMessage = message;
    q.nowPlayingChannel = textChannel;
    logger.debug('[nowplaying] Panel iniciado');
    
    if (q.nowPlayingInterval) clearInterval(q.nowPlayingInterval);
    
    // Función recursiva para actualización constante
    const scheduleUpdate = () => {
      q.nowPlayingInterval = setTimeout(async () => {
        await updateNowPlayingPanel(q);
        // Programar la siguiente actualización solo después de completar esta
        if (q.nowPlayingMessage && q.nowPlayingInterval) {
          scheduleUpdate();
        }
      }, 2000);
    };
    
    scheduleUpdate();
  } catch (error) {
    logger.error('[nowplaying] Error al iniciar panel:', {
      message: error.message,
      stack: error.stack,
      code: error.code
    });
  }
}

async function updateNowPlayingPanel(q) {
  if (!q.nowPlayingMessage) return;
  
  const startTime = Date.now();
  
  try {
    const embed = buildNowPlayingEmbed(q);
    const components = buildControlsComponents(q);
    await q.nowPlayingMessage.edit({ embeds: [embed], components: components });
    
    const duration = Date.now() - startTime;
    if (duration > 500) { // Log si toma más de 500ms
      logger.warn(`[nowplaying] Actualización lenta: ${duration}ms`);
    }
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error(`[nowplaying] Error al actualizar panel (${duration}ms):`, error.message);
    
    if (error.code === 10008 || error.code === 50001) {
      logger.debug('[nowplaying] Mensaje eliminado, deteniendo panel');
      await stopNowPlayingPanel(q);
    } else {
      // Para otros errores, no detener el intervalo, solo loguear
      logger.error('[nowplaying] Continuando intervalo a pesar del error');
    }
  }
}

async function stopNowPlayingPanel(q) {
  try {
    if (q.nowPlayingInterval) {
      clearTimeout(q.nowPlayingInterval);
      q.nowPlayingInterval = null;
    }
    
    if (q.nowPlayingMessage) {
      try {
        await q.nowPlayingMessage.delete();
      } catch (err) {
        if (err.code !== 10008 && err.code !== 50001) {
          logger.error('[nowplaying] Error al eliminar mensaje:', err.message);
        }
      }
      q.nowPlayingMessage = null;
    }
    
    q.nowPlayingChannel = null;
    logger.debug('[nowplaying] Panel detenido');
  } catch (error) {
    logger.error('[nowplaying] Error al detener panel:', error.message);
  }
}

module.exports = {
  startNowPlayingPanel,
  updateNowPlayingPanel,
  stopNowPlayingPanel,
  buildNowPlayingEmbed,
  buildControlsComponents
};
