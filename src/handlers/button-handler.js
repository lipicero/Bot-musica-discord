/**
 * @file handlers/button-handler.js
 * @description Manejo de interacciones de botones del panel Now Playing
 */

const { AudioPlayerStatus } = require('@discordjs/voice');
const { getVoiceConnection, joinVoiceChannel } = require('@discordjs/voice');
const { EmbedBuilder } = require('discord.js');
const logger = require('../utils/logger');
const { REQUIRE_SAME_VC } = require('../config/constants');
const { updateNowPlayingPanel } = require('./nowplaying-panel');

/**
 * Maneja las interacciones de botones de música
 * @param {object} interaction - Interacción de Discord
 * @param {object} context - Contexto global
 * @returns {Promise<void>}
 */
async function handleMusicButton(interaction, context) {
  const { queues, nowPlayingMessages, playNext } = context;
  const guildId = interaction.guild.id;
  const q = queues.get(guildId);
  
  // Verificar que el usuario esté en un canal de voz
  const member = interaction.member;
  const voiceChannel = member?.voice?.channel;
  
  if (REQUIRE_SAME_VC && !voiceChannel) {
    return interaction.reply({
      content: '❌ Debes estar en un canal de voz para usar los controles.',
      ephemeral: true
    });
  }
  
  // Verificar que el bot esté en el mismo canal (si REQUIRE_SAME_VC está activo)
  if (REQUIRE_SAME_VC && q) {
    const botVoiceChannel = interaction.guild.members.me?.voice?.channel;
    if (botVoiceChannel && botVoiceChannel.id !== voiceChannel?.id) {
      return interaction.reply({
        content: '❌ Debes estar en el mismo canal de voz que el bot.',
        ephemeral: true
      });
    }
  }
  
  const customId = interaction.customId;
  
  try {
    switch (customId) {
      case 'music_replay':
        await handleReplay(interaction, q, playNext, guildId);
        break;
        
      case 'music_pause':
        await handlePause(interaction, q);
        break;
        
      case 'music_resume':
        await handleResume(interaction, q);
        break;
        
      case 'music_skip':
        await handleSkip(interaction, q, playNext, guildId);
        break;
        
      case 'music_stop':
        await handleStop(interaction, q, queues, guildId);
        break;
        
      case 'music_loop':
        await handleLoop(interaction, q, context);
        break;
        
      case 'music_vol_down':
        await handleVolumeDown(interaction, q, context);
        break;
        
      case 'music_vol_up':
        await handleVolumeUp(interaction, q, context);
        break;
        
      case 'music_shuffle':
        await handleShuffle(interaction, q);
        break;
        
      case 'music_save':
        await handleSave(interaction, q);
        break;
        
      case 'music_queue':
        await handleShowQueue(interaction, q);
        break;
        
      case 'music_rewind':
        await handleRewind(interaction, q);
        break;
        
      case 'music_forward':
        await handleForward(interaction, q);
        break;
        
      default:
        await interaction.reply({
          content: '❌ Acción desconocida.',
          ephemeral: true
        });
    }
    
    // Actualizar panel después de cualquier cambio
    if (q && interaction.channel) {
      await updateNowPlayingPanel(q, interaction.channel, nowPlayingMessages);
    }
    
  } catch (error) {
    logger.error('Error en handleMusicButton:', {
      customId,
      error: error.message,
      stack: error.stack
    });
    
    const errorMsg = { content: '❌ Error procesando la acción.', ephemeral: true };
    
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply(errorMsg).catch(() => {});
    } else {
      await interaction.editReply(errorMsg).catch(() => {});
    }
  }
}

/**
 * Reiniciar la canción actual
 */
async function handleReplay(interaction, q, playNext, guildId) {
  if (!q || q.songs.length === 0) {
    return interaction.reply({ content: '❌ No hay nada reproduciendo.', ephemeral: true });
  }
  
  // Responder primero para evitar que la interacción expire
  await interaction.deferUpdate();
  
  // Luego reiniciar la reproducción
  await playNext(guildId);
}

/**
 * Pausar reproducción
 */
async function handlePause(interaction, q) {
  if (!q || q.songs.length === 0) {
    return interaction.reply({ content: '❌ No hay nada reproduciendo.', ephemeral: true });
  }
  
  if (q.player.state.status === AudioPlayerStatus.Paused) {
    return interaction.reply({ content: '⏸️ Ya está pausado.', ephemeral: true });
  }
  
  q.player.pause();
  q.isPausedByUser = true; // Marcar que el usuario pausó manualmente
  await interaction.deferUpdate();
}

/**
 * Reanudar reproducción
 */
async function handleResume(interaction, q) {
  if (!q || q.songs.length === 0) {
    return interaction.reply({ content: '❌ No hay nada reproduciendo.', ephemeral: true });
  }
  
  if (q.player.state.status !== AudioPlayerStatus.Paused) {
    return interaction.reply({ content: '▶️ Ya está reproduciendo.', ephemeral: true });
  }
  
  q.player.unpause();
  q.isPausedByUser = false; // Limpiar el flag al reanudar
  await interaction.deferUpdate();
}

/**
 * Saltar a la siguiente canción
 */
async function handleSkip(interaction, q, playNext, guildId) {
  if (!q || q.songs.length === 0) {
    return interaction.reply({ content: '❌ No hay nada reproduciendo.', ephemeral: true });
  }
  
  // Responder primero para evitar que la interacción expire
  await interaction.deferUpdate();
  
  const skippedTitle = q.songs[0]?.title || 'canción';
  
  // Si está en modo loop, desactivarlo temporalmente
  const wasLooping = q.loop;
  if (wasLooping) {
    q.loop = false;
  }
  
  // Remover la canción actual
  q.songs.shift();
  
  // Limpiar el flag de pausa al saltar
  q.isPausedByUser = false;
  
  // Si hay más canciones, reproducir la siguiente
  if (q.songs.length > 0) {
    await playNext(guildId);
  } else {
    q.player.stop();
  }
  
  // Restaurar loop si estaba activo
  if (wasLooping) {
    q.loop = true;
  }
}

/**
 * Detener reproducción y desconectar
 */
async function handleStop(interaction, q, queues, guildId) {
  if (!q) {
    return interaction.reply({ content: '❌ No hay nada reproduciendo.', ephemeral: true });
  }
  
  try {
    // Responder primero
    await interaction.deferUpdate();
    
    // Limpiar el flag de pausa al detener
    q.isPausedByUser = false;
    
    q.player.stop();
    const conn = getVoiceConnection(guildId);
    if (conn) {
      conn.destroy();
    }
    queues.delete(guildId);
  } catch (error) {
    logger.error('Error en handleStop:', { error: error.message });
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ Error al detener.', ephemeral: true });
    }
  }
}

/**
 * Toggle de bucle
 */
async function handleLoop(interaction, q, context) {
  if (!q || q.songs.length === 0) {
    return interaction.reply({ content: '❌ No hay nada reproduciendo.', ephemeral: true });
  }
  
  q.loop = !q.loop;
  
  // Guardar estado
  const stateService = require('../services/state');
  stateService.saveGuildState(context.guildState, interaction.guild.id, {
    volume: q.volume,
    loop: q.loop,
    bass: q.bass || 'off'
  });
  
  await interaction.deferUpdate();
}

/**
 * Bajar volumen
 */
async function handleVolumeDown(interaction, q, context) {
  if (!q) {
    return interaction.reply({ content: '❌ No hay cola activa.', ephemeral: true });
  }
  
  const current = Math.round((q.volume ?? 1) * 100);
  const newVol = Math.max(0, current - 10);
  q.volume = newVol / 100;
  
  if (q.player.state.resource?.volume) {
    q.player.state.resource.volume.setVolumeLogarithmic(q.volume);
  }
  
  // Guardar estado
  const stateService = require('../services/state');
  stateService.saveGuildState(context.guildState, interaction.guild.id, {
    volume: q.volume,
    loop: q.loop,
    bass: q.bass || 'off'
  });
  
  await interaction.deferUpdate();
}

/**
 * Subir volumen
 */
async function handleVolumeUp(interaction, q, context) {
  if (!q) {
    return interaction.reply({ content: '❌ No hay cola activa.', ephemeral: true });
  }
  
  const current = Math.round((q.volume ?? 1) * 100);
  const newVol = Math.min(200, current + 10);
  q.volume = newVol / 100;
  
  if (q.player.state.resource?.volume) {
    q.player.state.resource.volume.setVolumeLogarithmic(q.volume);
  }
  
  // Guardar estado
  const stateService = require('../services/state');
  stateService.saveGuildState(context.guildState, interaction.guild.id, {
    volume: q.volume,
    loop: q.loop,
    bass: q.bass || 'off'
  });
  
  await interaction.deferUpdate();
}

/**
 * Toggle de modo aleatorio
 */
async function handleShuffle(interaction, q) {
  if (!q || q.songs.length <= 2) {
    return interaction.reply({ 
      content: '❌ Necesitas al menos 3 canciones en la cola.', 
      ephemeral: true 
    });
  }
  
  q.shuffleMode = !q.shuffleMode;
  
  if (q.shuffleMode) {
    // Mezclar la cola (sin tocar la canción actual)
    const current = q.songs[0];
    const rest = q.songs.slice(1);
    
    // Fisher-Yates shuffle
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    
    q.songs = [current, ...rest];
  }
  
  await interaction.deferUpdate();
}

/**
 * Guardar canción actual por DM
 */
async function handleSave(interaction, q) {
  if (!q || q.songs.length === 0) {
    return interaction.reply({ content: '❌ No hay nada reproduciendo.', ephemeral: true });
  }
  
  const s = q.songs[0];
  
  try {
    const user = interaction.user;
    const dm = await user.createDM();
    
    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('💾 Canción guardada')
      .setDescription(`[${s.title}](${s.url})`)
      .setThumbnail(s.thumbnail || null)
      .setFooter({ text: `Guardado desde ${interaction.guild.name}` })
      .setTimestamp();
    
    await dm.send({ embeds: [embed] });
    await interaction.reply({ 
      content: '💾 Canción enviada por DM', 
      ephemeral: true 
    });
  } catch (error) {
    logger.error('Error enviando DM:', { error: error.message });
    await interaction.reply({ 
      content: '❌ No pude enviarte un DM. Verifica tus configuraciones de privacidad.', 
      ephemeral: true 
    });
  }
}

/**
 * Mostrar la cola
 */
async function handleShowQueue(interaction, q) {
  if (!q || q.songs.length === 0) {
    return interaction.reply({ content: '❌ La cola está vacía.', ephemeral: true });
  }
  
  const { formatDuration } = require('../utils/formatters');
  
  const lines = q.songs.slice(0, 10).map((s, i) => {
    const dur = s.durationSec ? ` [${formatDuration(s.durationSec)}]` : '';
    if (i === 0) {
      return `▶️ **${s.title}**${dur}`;
    }
    return `${i}. ${s.title}${dur}`;
  });
  
  if (q.songs.length > 10) {
    lines.push(`\n... y ${q.songs.length - 10} más`);
  }
  
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('📜 Cola de reproducción')
    .setDescription(lines.join('\n'))
    .setFooter({ text: `Total: ${q.songs.length} canción${q.songs.length !== 1 ? 'es' : ''}` });
  
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

/**
 * Retroceder 10 segundos
 */
async function handleRewind(interaction, q) {
  if (!q || q.songs.length === 0) {
    return interaction.reply({ content: '❌ No hay nada reproduciendo.', ephemeral: true });
  }
  
  const currentTime = Math.floor((q.player.state.resource?.playbackDuration || 0) / 1000);
  const newTime = Math.max(0, currentTime - 10);
  
  try {
    // Buscar el recurso actual y hacer seek si es posible
    const resource = q.player.state.resource;
    if (resource && resource.playStream && resource.playStream.seek) {
      resource.playStream.seek(newTime);
      await interaction.deferUpdate();
    } else {
      await interaction.reply({ 
        content: '❌ No se puede retroceder en esta canción.', 
        ephemeral: true 
      });
    }
  } catch (error) {
    logger.error('Error en rewind:', { error: error.message });
    await interaction.reply({ 
      content: '❌ Error al retroceder.', 
      ephemeral: true 
    });
  }
}

/**
 * Avanzar 10 segundos
 */
async function handleForward(interaction, q) {
  if (!q || q.songs.length === 0) {
    return interaction.reply({ content: '❌ No hay nada reproduciendo.', ephemeral: true });
  }
  
  const currentTime = Math.floor((q.player.state.resource?.playbackDuration || 0) / 1000);
  const totalTime = q.songs[0]?.durationSec || 0;
  const newTime = Math.min(totalTime, currentTime + 10);
  
  try {
    // Buscar el recurso actual y hacer seek si es posible
    const resource = q.player.state.resource;
    if (resource && resource.playStream && resource.playStream.seek) {
      resource.playStream.seek(newTime);
      await interaction.deferUpdate();
    } else {
      await interaction.reply({ 
        content: '❌ No se puede avanzar en esta canción.', 
        ephemeral: true 
      });
    }
  } catch (error) {
    logger.error('Error en forward:', { error: error.message });
    await interaction.reply({ 
      content: '❌ Error al avanzar.', 
      ephemeral: true 
    });
  }
}

module.exports = {
  handleMusicButton
};
