/**
 * @file handlers/nowplaying-panel.js
 * @description Panel Now Playing con embed y botones interactivos
 */

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { AudioPlayerStatus } = require('@discordjs/voice');
const { formatDuration, buildProgressBar } = require('../utils/formatters');
const logger = require('../utils/logger');

function buildControlsComponents(q) {
  const isPaused = q.player.state.status === AudioPlayerStatus.Paused;
  const s = q.songs?.[0];
  const canShuffle = (q.songs?.length || 0) > 2;
  const hasSong = !!s;
  const canSeek = hasSong && s?.durationSec && s.durationSec > 30; // Solo para canciones con duración > 30s
  const volPercent = Math.round((q.volume ?? 1) * 100);
  const volDownDisabled = volPercent <= 0;
  const volUpDisabled = volPercent >= 200;
  
  // Fila 1: transporte básico
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('music_replay')
      .setEmoji('🔄')
      .setLabel('Reiniciar')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasSong),
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
      .setStyle(q.loop ? ButtonStyle.Success : ButtonStyle.Secondary)
  );
  
  // Fila 2: controles de navegación y volumen
  const row2 = new ActionRowBuilder().addComponents(
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
      .setDisabled(volUpDisabled),
    new ButtonBuilder()
      .setCustomId('music_shuffle')
      .setEmoji('🔀')
      .setLabel('Aleatorio')
      .setStyle(q.shuffleMode ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(!canShuffle)
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

  const isPaused = q.player.state.status === AudioPlayerStatus.Paused;
  const embedColor = 0x5865f2;
  const currentTime = q.player.state.resource?.playbackDuration || 0;
  const currentSeconds = Math.floor(currentTime / 1000);
  const totalSeconds = s.durationSec || 0;
  
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
  if (totalSeconds) {
    const progressBar = buildProgressBar(totalSeconds, currentSeconds, 24, 'spotify');
    embed.setDescription(`${progressBar}\n${formatDuration(currentSeconds)} / ${formatDuration(totalSeconds)}`);
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
  try {
    // Si ya existe un panel válido, solo actualizar en lugar de crear uno nuevo
    if (q.nowPlayingMessage) {
      try {
        const embed = buildNowPlayingEmbed(q);
        const components = buildControlsComponents(q);
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
    const embed = buildNowPlayingEmbed(q);
    const components = buildControlsComponents(q);
    const message = await textChannel.send({ embeds: [embed], components: components });
    
    q.nowPlayingMessage = message;
    q.nowPlayingChannel = textChannel;
    logger.debug('[nowplaying] Panel iniciado');
    
    if (q.nowPlayingInterval) clearInterval(q.nowPlayingInterval);
    q.nowPlayingInterval = setInterval(async () => { await updateNowPlayingPanel(q); }, 2000);
  } catch (error) {
    logger.error('[nowplaying] Error al iniciar panel:', error.message);
  }
}

async function updateNowPlayingPanel(q) {
  if (!q.nowPlayingMessage) return;
  
  try {
    const embed = buildNowPlayingEmbed(q);
    const components = buildControlsComponents(q);
    await q.nowPlayingMessage.edit({ embeds: [embed], components: components });
  } catch (error) {
    if (error.code === 10008 || error.code === 50001) {
      logger.debug('[nowplaying] Mensaje eliminado, deteniendo panel');
      await stopNowPlayingPanel(q);
    } else {
      logger.error('[nowplaying] Error al actualizar panel:', error.message);
    }
  }
}

async function stopNowPlayingPanel(q) {
  try {
    if (q.nowPlayingInterval) {
      clearInterval(q.nowPlayingInterval);
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
