/**
 * @file commands/music/play.js
 * @description Comando /play - Reproduce música desde YouTube o Spotify
 */

const { PermissionsBitField } = require('discord.js');
const playdl = require('play-dl');
const ytdl = require('@distube/ytdl-core');
const logger = require('../../utils/logger');
const { isSpotifyUrl, searchYouTubeForSpotifyTrack } = require('../../utils/spotify');
const { 
  isYouTubeUrl, 
  canonicalizeYouTubeUrl, 
  extractYouTubeId 
} = require('../../utils/youtube');
const { getPlaylistItemsOrdered } = require('../../services/playlist');
const { fetchMetadata } = require('../../services/metadata');
const { preloadNextSongs } = require('../../services/preload');
const { DEBUG_AUDIO, MAX_PLAYLIST_ITEMS } = require('../../config/constants');
const { getQueue, tryEnqueue } = require('../../handlers/queue');
const { ensureConnection } = require('../../handlers/voice');

module.exports = {
  name: 'play',
  description: 'Reproducir música desde YouTube o Spotify',
  category: 'music',
  options: [
    {
      name: 'query',
      description: 'URL de YouTube o Spotify (soporta playlists)',
      type: 3, // STRING
      required: true
    }
  ],

  async execute(interaction, client, context) {
    const { guild, member, channel } = interaction;
    const query = interaction.options.getString('query', true).trim();

    // Validar que el usuario esté en un canal de voz
    const userVoiceChannel = member?.voice?.channel;
    if (!userVoiceChannel) {
      return interaction.reply({
        content: '❌ Debés estar en un canal de voz para usar este comando.',
        ephemeral: true
      });
    }

    // Validar permisos del bot en el canal de voz
    const permissions = userVoiceChannel.permissionsFor(guild.members.me);
    if (!permissions.has(PermissionsBitField.Flags.Connect) || 
        !permissions.has(PermissionsBitField.Flags.Speak)) {
      return interaction.reply({
        content: '❌ No tengo permisos para conectarme o hablar en ese canal de voz.',
        ephemeral: true
      });
    }

    // Defer para operaciones largas
    await interaction.deferReply();

    try {
      // ========== DETECCIÓN DE SPOTIFY ==========
      if (isSpotifyUrl(query)) {
        const spotifyMsg = await searchYouTubeForSpotifyTrack(query);
        return interaction.editReply({ content: spotifyMsg });
      }

      // ========== NORMALIZACIÓN DE URL ==========
      let finalUrl = query;
      if (isYouTubeUrl(query)) {
        finalUrl = canonicalizeYouTubeUrl(query);
        if (DEBUG_AUDIO) logger.audio('[play] URL normalizada', { original: query, final: finalUrl });
      }

      // ========== DETECCIÓN DE TIPO ==========
      const validateResult = await playdl.validate(finalUrl);
      const isPlaylist = validateResult === 'yt_playlist' || finalUrl.includes('list=');
      
      if (DEBUG_AUDIO) {
        logger.audio('[play] Tipo detectado', { 
          url: finalUrl, 
          type: validateResult,
          isPlaylist 
        });
      }

      // ========== OBTENER COLA Y CONEXIÓN ==========
      const queue = getQueue(guild.id);
      
      // Paralelizar conexión de voz y obtención de metadata
      const connectionPromise = ensureConnection(guild.id, guild, userVoiceChannel, queue);
      
      // ========== PROCESAR PLAYLIST ==========
      if (isPlaylist) {
        const metadataPromise = getPlaylistItemsOrdered(finalUrl);
        
        // Esperar ambas operaciones
        const [connection, playlistData] = await Promise.all([
          connectionPromise,
          metadataPromise
        ]);

        if (!playlistData.items || playlistData.items.length === 0) {
          return interaction.editReply({
            content: '❌ No se pudieron obtener videos de la playlist.'
          });
        }

        const { items, title } = playlistData;
        const total = items.length;
        const limited = total > MAX_PLAYLIST_ITEMS;

        // Agregar todos los items a la cola
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const song = {
            title: item.title,
            url: item.url,
            durationSec: item.durationSec,
            thumbnail: item.thumbnailUrl,
            thumbnailUrl: item.thumbnailUrl,
            requestedById: member.id,
            requestedBy: member.user.tag,
            requestedByTag: member.user.tag,
            requestedByAvatar: member.user.displayAvatarURL(),
            ytdlInfo: null // Se obtendrá cuando se reproduzca
          };

          // Si es el primer item y la cola está vacía, obtener metadata completa
          if (i === 0 && queue.songs.length === 0) {
            try {
              const ytdlInfo = await ytdl.getInfo(item.url);
              song.ytdlInfo = ytdlInfo;
              if (DEBUG_AUDIO) logger.audio('[play] Metadata ytdl obtenida para primer item');
            } catch (e) {
              if (DEBUG_AUDIO) logger.warn(`[play] No se pudo obtener ytdl info: ${e.message}`);
              // Intentar con fetchMetadata
              try {
                const metadata = await fetchMetadata(item.url);
                if (metadata) {
                  song.title = metadata.title || song.title;
                  song.durationSec = metadata.durationSec || song.durationSec;
                  song.thumbnailUrl = metadata.thumbnailUrl || song.thumbnailUrl;
                }
              } catch {}
            }
          }

          tryEnqueue(queue, song);
        }

        // Mensaje de confirmación
        const limitMsg = limited 
          ? `\n⚠️ Limitado a ${MAX_PLAYLIST_ITEMS} items (máximo permitido).`
          : '';
        
        await interaction.editReply({
          content: `✅ Agregada playlist **${title}**\n📝 ${total} canciones${limitMsg}`
        });

        // Configurar canal de texto para mensajes
        if (!queue.textChannelId) {
          queue.textChannelId = channel.id;
        }

        // Si la cola estaba vacía antes de agregar la playlist, iniciar reproducción
        const wasEmpty = queue.songs.length === items.length;
        if (wasEmpty && context.playNext) {
          try {
            await context.playNext(guild.id);
            if (DEBUG_AUDIO) logger.audio('[play] Reproducción de playlist iniciada automáticamente', { guildId: guild.id });
          } catch (error) {
            logger.error('[play] Error al iniciar reproducción de playlist:', {
              guildId: guild.id,
              error: error.message
            });
            
            // Notificar al usuario del error
            await interaction.followUp({
              content: `⚠️ La playlist se agregó pero hubo un error al iniciar la reproducción: ${error.message}`,
              ephemeral: true
            }).catch(() => {});
          }
        }

        // Precargar siguiente canción si está habilitado
        if (queue.songs.length > 1) {
          // Nota: preloadNextSongs necesita createResourceFn, que se maneja en el handler de voice
          // Por ahora solo logueamos
          if (DEBUG_AUDIO) logger.audio('[play] Playlist agregada, precarga manejada por voice handler');
        }
        
        return;
      }

      // ========== PROCESAR VIDEO INDIVIDUAL ==========
      let metadata = null;
      let ytdlInfo = null;

      // Intentar obtener metadata con ytdl-core primero
      try {
        ytdlInfo = await ytdl.getInfo(finalUrl);
        metadata = {
          title: ytdlInfo.videoDetails.title,
          durationSec: parseInt(ytdlInfo.videoDetails.lengthSeconds) || 0,
          thumbnailUrl: ytdlInfo.videoDetails.thumbnails?.[0]?.url || null
        };
        if (DEBUG_AUDIO) logger.audio('[play] Metadata obtenida con ytdl-core');
      } catch (e) {
        if (DEBUG_AUDIO) logger.warn(`[play] ytdl-core falló: ${e.message}`);
        
        // Fallback a fetchMetadata
        try {
          metadata = await fetchMetadata(finalUrl);
          if (DEBUG_AUDIO && metadata) {
            logger.audio('[play] Metadata obtenida con fetchMetadata fallback');
          }
        } catch (e2) {
          if (DEBUG_AUDIO) logger.warn(`[play] fetchMetadata falló: ${e2.message}`);
        }
      }

      // Si no hay metadata, usar valores por defecto
      if (!metadata) {
        const videoId = extractYouTubeId(finalUrl);
        metadata = {
          title: `Video ${videoId || 'desconocido'}`,
          durationSec: 0,
          thumbnailUrl: null
        };
      }

      // Esperar conexión de voz
      await connectionPromise;

      // Crear objeto de canción
      const song = {
        title: metadata.title,
        url: finalUrl,
        durationSec: metadata.durationSec,
        thumbnail: metadata.thumbnailUrl,
        thumbnailUrl: metadata.thumbnailUrl,
        requestedById: member.id,
        requestedBy: member.user.tag,
        requestedByTag: member.user.tag,
        requestedByAvatar: member.user.displayAvatarURL(),
        ytdlInfo: ytdlInfo
      };

      // Agregar a la cola
      const wasEmpty = queue.songs.length === 0;
      tryEnqueue(queue, song);

      // Mensaje de confirmación
      const position = queue.songs.length;
      if (wasEmpty) {
        await interaction.editReply({
          content: `▶️ Reproduciendo: **${song.title}**`
        });
      } else {
        await interaction.editReply({
          content: `✅ Agregado a la cola: **${song.title}**\n📍 Posición: #${position}`
        });
      }

      // Configurar canal de texto
      if (!queue.textChannelId) {
        queue.textChannelId = channel.id;
      }

      // Si la cola estaba vacía, iniciar reproducción
      if (wasEmpty && context.playNext) {
        try {
          await context.playNext(guild.id);
          if (DEBUG_AUDIO) logger.audio('[play] Reproducción iniciada automáticamente', { guildId: guild.id });
        } catch (error) {
          logger.error('[play] Error al iniciar reproducción:', {
            guildId: guild.id,
            error: error.message
          });
          
          // Notificar al usuario del error
          await interaction.followUp({
            content: `⚠️ La canción se agregó a la cola pero hubo un error al iniciar la reproducción: ${error.message}`,
            ephemeral: true
          }).catch(() => {});
        }
      }

      // Precargar siguiente canción (manejado por voice handler)
      if (DEBUG_AUDIO && queue.songs.length > 1) {
        logger.audio('[play] Canción agregada, precarga manejada por voice handler');
      }

    } catch (error) {
      logger.error('Error ejecutando comando play:', error);
      
      const errorMsg = error.message || 'Error desconocido';
      const response = {
        content: `❌ Error al procesar la solicitud:\n\`\`\`${errorMsg}\`\`\``,
        ephemeral: true
      };

      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(response).catch(() => {});
      } else {
        await interaction.reply(response).catch(() => {});
      }
    }
  }
};
