/**
 * @file handlers/nowplaying-panel.js
 * @description Panel No      .set    ne      .set      .setLabel(`${volPercent}%`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(volUpDisabled),
    new ButtonBuilder()
      .setCustomId('music_loop')
      .setLabel(q.loop ? 'Loop ON' : 'Loop')
      .setStyle(q.loop ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('music_shuffle')
      .setLabel(q.shuffleMode ? 'Shuffle ON' : 'Shuffle')
      .setStyle(q.shuffleMode ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(!canShuffle)
  );
  
  // Fila 3: utilidadesButtonStyle.Secondary)
      .setDisabled(volUpDisabled),
    new ButtonBuilder()
      .setCustomId('music_loop')
      .setLabel(q.loop ? 'Loop ON' : 'Loop')
      .setStyle(q.loop ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('music_shuffle')
      .setLabel(q.shuffleMode ? 'Shuffle ON' : 'Shuffle')
      .setStyle(q.shuffleMode ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(!canShuffle)
  );r()
      .setCustomId('music_loop')
      .setLabel(q.loop ? 'Loop ON' : 'Loop')
      .setStyle(q.loop ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('music_shuffle')
      .setLabel(q.shuffleMode ? 'Shuffle ON' : 'Shuffle')
      .setStyle(q.shuffleMode ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(!canShuffle)lUpDisabled),
    new ButtonBuilder()
      .setCustomId('music_loop')
      .setLabel(q.loop ? 'ðŸ” Loop' : 'Loop')
      .setStyle(q.loop ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('music_shuffle')
      .setLabel(q.shuffleMode ? 'ðŸ”€ Shuffle' : 'Shuffle')
      .setStyle(q.shuffleMode ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(!canShuffle)n embed y botones interactivos
 */

const { 
  EmbedBuilder, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle 
} = require('discord.js');
const { AudioPlayerStatus } = require('@discordjs/voice');
const { formatDuration, buildProgressBar } = require('../utils/formatters');
const logger = require('../utils/logger');

/**
 * Construye los botones de control del reproductor
 * @param {object} q - Cola del servidor
 * @returns {Array<ActionRowBuilder>} Filas de botones
 */
function buildControlsComponents(q) {
  const isPaused = q.player.state.status === AudioPlayerStatus.Paused;
  const s = q.songs?.[0];
  const canShuffle = (q.songs?.length || 0) > 2;
  const hasSong = !!s;
  
  // Limitar volumen entre 0 y 200%
  const volPercent = Math.round((q.volume ?? 1) * 100);
  const volDownDisabled = volPercent <= 0;
  const volUpDisabled = volPercent >= 200;
  
  // Fila 1: controles principales de reproducciÃ³n
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('music_replay')
      .setEmoji('â®ï¸')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasSong),
    new ButtonBuilder()
      .setCustomId(isPaused ? 'music_resume' : 'music_pause')
      .setEmoji(isPaused ? 'â–¶ï¸' : 'â¸ï¸')
      .setStyle(isPaused ? ButtonStyle.Success : ButtonStyle.Primary)
      .setDisabled(!hasSong),
    new ButtonBuilder()
      .setCustomId('music_skip')
      .setEmoji('â­ï¸')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasSong),
    new ButtonBuilder()
      .setCustomId('music_stop')
      .setEmoji('â¹ï¸')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!hasSong)
  );
  
  // Fila 2: controles de volumen y modos
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('music_vol_down')
      .setEmoji('ðŸ”‰')
      .setLabel(`${volPercent}%`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(volDownDisabled),
    new ButtonBuilder()
      .setCustomId('music_vol_up')
      .setEmoji('ðŸ”Š')
      .setLabel(`${volPercent}%`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(volUpDisabled),
    new ButtonBuilder()
      .setCustomId('music_loop')
      .setEmoji('ï¿½')
      .setLabel(q.loop ? 'Loop ON' : 'Loop OFF')
      .setStyle(q.loop ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('music_shuffle')
      .setEmoji('ï¿½')
      .setLabel(q.shuffleMode ? 'Shuffle ON' : 'Shuffle OFF')
      .setStyle(q.shuffleMode ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(!canShuffle)
  );
  
  // Fila 3: utilidades
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('music_queue')
      .setEmoji('ðŸ“œ')
      .setLabel('Ver Cola')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('music_save')
      .setEmoji('ðŸ’¾')
      .setLabel('Guardar')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasSong)
  );
  
  // Agregar botÃ³n de YouTube si hay una canciÃ³n
  if (s?.url) {
    row3.addComponents(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setURL(s.url)
        .setEmoji('ðŸŽ¬')
        .setLabel('YouTube')
    );
  }
  
  return [row1, row2, row3];
}

/**
 * Construye el embed de Now Playing
 * @param {object} q - Cola del servidor
 * @returns {EmbedBuilder} Embed del reproductor
 */
function buildNowPlayingEmbed(q) {
  const s = q.songs?.[0];
  const elapsed = Math.floor(
    (q.player?.state?.resource?.playbackDuration || 0) / 1000
  );
  const total = s?.durationSec || 0;
  const isPaused = q.player?.state?.status === AudioPlayerStatus.Paused;
  
  // Colores segÃºn estado
  const embedColor = isPaused ? 0xfaa61a : 0x1db954; // Amarillo si pausado, verde Spotify si reproduciendo
  
  const embed = new EmbedBuilder()
    .setColor(embedColor);
  
  if (s) {
    // TÃ­tulo dinÃ¡mico con estado
    const statusEmoji = isPaused ? 'â¸ï¸' : 'ðŸŽµ';
    const statusText = isPaused ? 'En Pausa' : 'Reproduciendo Ahora';
    
    // Crear descripciÃ³n elegante
    const descParts = [];
    
    // TÃ­tulo de la canciÃ³n con enlace
    if (s.url) {
      descParts.push(`## ${statusEmoji} [${s.title}](${s.url})`);
    } else {
      descParts.push(`## ${statusEmoji} ${s.title}`);
    }
    
    descParts.push(''); // LÃ­nea en blanco
    
    // Barra de progreso si no es livestream
    if (total) {
      const bar = buildProgressBar(total, elapsed, 24, 'spotify');
      descParts.push(bar);
      
      // Tiempo con formato mejorado
      const timeStr = `\`${formatDuration(elapsed)}\` â”â”â”â”â”â”â”â”â”â” \`${formatDuration(total)}\``;
      descParts.push(timeStr);
    } else {
      descParts.push('ðŸ”´ **TRANSMISIÃ“N EN VIVO**');
    }
    
    descParts.push(''); // LÃ­nea en blanco
    
    // InformaciÃ³n en formato de campos inline
    const volPercent = Math.round((q.volume ?? 1) * 100);
    const volBar = getVolumeBar(volPercent);
    
    const infoParts = [];
    
    // Volumen con barra visual
    infoParts.push(`ðŸ”Š **Volumen:** ${volBar} \`${volPercent}%\``);
    
    // Estado de reproducciÃ³n
    const statusParts = [];
    if (q.loop) statusParts.push('ðŸ” Loop');
    if (q.shuffleMode) statusParts.push('ðŸ”€ Shuffle');
    if (statusParts.length > 0) {
      infoParts.push(`**Modo:** ${statusParts.join(' â€¢ ')}`);
    }
    
    // Cola
    if (q.songs.length > 1) {
      infoParts.push(`ðŸ“œ **En Cola:** ${q.songs.length - 1} canciÃ³n${q.songs.length - 1 !== 1 ? 'es' : ''}`);
    }
    
    if (infoParts.length > 0) {
      descParts.push(infoParts.join('\n'));
    }
    
    embed.setDescription(descParts.join('\n'));
    
    // Imagen grande de la canciÃ³n
    if (s.thumbnail) {
      // Intentar obtener thumbnail de mÃ¡xima calidad
      let thumbnailUrl = s.thumbnail;
      
      // Si es thumbnail de YouTube, intentar obtener maxresdefault
      if (thumbnailUrl.includes('i.ytimg.com')) {
        const videoId = s.url?.match(/[?&]v=([^&]+)/)?.[1];
        if (videoId) {
          thumbnailUrl = `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
        }
      }
      
      embed.setImage(thumbnailUrl);
    }
    
    // Footer mejorado con timestamp
    if (s.requestedBy) {
      embed.setFooter({
        text: `Solicitado por ${s.requestedBy}`,
        iconURL: s.requestedByAvatar || undefined
      });
      embed.setTimestamp();
    }
  } else {
    embed.setDescription('ðŸ’¤ No hay nada en reproducciÃ³n actualmente.');
  }
  
  return embed;
}

/**
 * Crea una barra visual de volumen
 * @param {number} percent - Porcentaje de volumen (0-200)
 * @returns {string} Barra visual
 */
function getVolumeBar(percent) {
  const maxBars = 10;
  const filled = Math.round((Math.min(percent, 200) / 200) * maxBars);
  const empty = maxBars - filled;
  
  const filledBar = 'â–ˆ'.repeat(filled);
  const emptyBar = 'â–‘'.repeat(empty);
  
  return `${filledBar}${emptyBar}`;
}

/**
 * Actualiza el panel Now Playing en el canal
 * @param {object} q - Cola del servidor
 * @param {object} channel - Canal de texto
 * @param {Map} nowPlayingMessages - Mapa de mensajes de Now Playing
 * @returns {Promise<void>}
 */
async function updateNowPlayingPanel(q, channel, nowPlayingMessages) {
  try {
    if (!channel || !channel.isTextBased()) return;
    
    const guildId = channel.guild.id;
    const embed = buildNowPlayingEmbed(q);
    const components = buildControlsComponents(q);
    
    // Verificar si ya existe un mensaje de Now Playing
    const existingMsgId = nowPlayingMessages.get(guildId);
    
    if (existingMsgId) {
      try {
        // Intentar actualizar el mensaje existente
        const msg = await channel.messages.fetch(existingMsgId);
        await msg.edit({ embeds: [embed], components });
        return;
      } catch (error) {
        // Si falla, crear uno nuevo
        nowPlayingMessages.delete(guildId);
      }
    }
    
    // Crear nuevo mensaje
    const msg = await channel.send({ embeds: [embed], components });
    nowPlayingMessages.set(guildId, msg.id);
    
    logger.debug('[nowplaying-panel] Panel creado/actualizado', { guildId });
  } catch (error) {
    logger.error('[nowplaying-panel] Error actualizando panel:', {
      error: error.message,
      guildId: channel?.guild?.id
    });
  }
}

/**
 * Inicia el ticker de actualizaciÃ³n automÃ¡tica del panel
 * @param {string} guildId - ID del servidor
 * @param {object} q - Cola del servidor
 * @param {object} channel - Canal de texto
 * @param {Map} nowPlayingMessages - Mapa de mensajes
 * @param {Map} nowPlayingTickers - Mapa de intervalos
 * @returns {void}
 */
function startNowPlayingTicker(guildId, q, channel, nowPlayingMessages, nowPlayingTickers) {
  // Limpiar ticker anterior si existe
  stopNowPlayingTicker(guildId, nowPlayingTickers);
  
  // Actualizar inmediatamente
  updateNowPlayingPanel(q, channel, nowPlayingMessages).catch(err => {
    logger.warn('[nowplaying-panel] Error en actualizaciÃ³n inicial:', { 
      guildId, 
      error: err.message 
    });
  });
  
  // Actualizar cada 5 segundos
  const interval = setInterval(() => {
    if (!q.songs || q.songs.length === 0) {
      stopNowPlayingTicker(guildId, nowPlayingTickers);
      return;
    }
    
    updateNowPlayingPanel(q, channel, nowPlayingMessages).catch(err => {
      logger.warn('[nowplaying-panel] Error en actualizaciÃ³n ticker:', { 
        guildId, 
        error: err.message 
      });
    });
  }, 5000);
  
  nowPlayingTickers.set(guildId, interval);
  logger.debug('[nowplaying-panel] Ticker iniciado', { guildId });
}

/**
 * Detiene el ticker de actualizaciÃ³n
 * @param {string} guildId - ID del servidor
 * @param {Map} nowPlayingTickers - Mapa de intervalos
 * @returns {void}
 */
function stopNowPlayingTicker(guildId, nowPlayingTickers) {
  const ticker = nowPlayingTickers.get(guildId);
  if (ticker) {
    clearInterval(ticker);
    nowPlayingTickers.delete(guildId);
    logger.debug('[nowplaying-panel] Ticker detenido', { guildId });
  }
}

/**
 * Elimina el mensaje de Now Playing
 * @param {string} guildId - ID del servidor
 * @param {object} channel - Canal de texto
 * @param {Map} nowPlayingMessages - Mapa de mensajes
 * @returns {Promise<void>}
 */
async function deleteNowPlayingPanel(guildId, channel, nowPlayingMessages) {
  const msgId = nowPlayingMessages.get(guildId);
  if (!msgId) return;
  
  try {
    const msg = await channel.messages.fetch(msgId);
    await msg.delete();
    nowPlayingMessages.delete(guildId);
    logger.debug('[nowplaying-panel] Panel eliminado', { guildId });
  } catch (error) {
    // Silenciar errores (mensaje ya fue eliminado)
    nowPlayingMessages.delete(guildId);
  }
}

module.exports = {
  buildControlsComponents,
  buildNowPlayingEmbed,
  updateNowPlayingPanel,
  startNowPlayingTicker,
  stopNowPlayingTicker,
  deleteNowPlayingPanel
};
