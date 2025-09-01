process.env.YTDL_NO_UPDATE = "1"; // desactiva chequeo de updates de ytdl-core
require("dotenv").config({ quiet: true });

// Intentar configurar ffmpeg estático para demux/transcode cuando sea necesario
try {
  const ffmpegPath = require('ffmpeg-static');
  if (ffmpegPath) {
    process.env.FFMPEG_PATH = ffmpegPath;
    console.log('[ffmpeg] ffmpeg-static configurado');
  }
} catch (_) {
  console.warn('[ffmpeg] ffmpeg-static no instalado; se intentará sin FFmpeg');
}
const DEBUG_AUDIO = process.env.DEBUG_AUDIO === '1';
const MAX_PLAYLIST_ITEMS = Math.max(1, Math.min(100, Number(process.env.MAX_PLAYLIST_ITEMS || 25)));
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, PermissionsBitField, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { joinVoiceChannel, createAudioPlayer, createAudioResource, getVoiceConnection, AudioPlayerStatus, NoSubscriberBehavior, VoiceConnectionStatus, entersState, StreamType } = require("@discordjs/voice");
const playdl = require("play-dl");
const ytdl = require("@distube/ytdl-core");

// Config opcional de YouTube para play-dl (evita bloqueos/edad/consent)
try {
  const ytCookie = process.env.YT_COOKIE || process.env.YOUTUBE_COOKIE;
  if (ytCookie) {
    playdl.setToken({ youtube: { cookie: ytCookie } });
    console.log('[play-dl] cookie de YouTube configurada');
  }
} catch (e) {
  console.warn('[play-dl] No se pudo configurar cookie:', e?.message || e);
}

// Inicializamos el cliente de Discord
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates
  ]
});

// Cuando el bot está listo (v14: alias; en v15 sólo 'clientReady')
client.once('clientReady', async (c) => {
  console.log(`✅ Bot conectado como ${c.user.tag}`);
  // Registro rápido por cada servidor donde está el bot
  for (const guild of c.guilds.cache.values()) {
    await registerGuildCommands(guild);
  }
});

// ======================
// Slash Commands (por servidor, registro inmediato)
// ======================
const slashCommands = [
  {
    name: 'play',
    description: 'Reproduce audio desde YouTube (URL o búsqueda)',
    type: 1,
    options: [
      { name: 'query', description: 'URL o búsqueda', type: 3, required: true }
    ],
  },
  { name: 'skip', description: 'Saltar a la siguiente pista', type: 1 },
  { name: 'pause', description: 'Pausar la reproducción', type: 1 },
  { name: 'resume', description: 'Reanudar la reproducción', type: 1 },
  { name: 'queue', description: 'Mostrar la cola', type: 1 },
  { name: 'stop', description: 'Detener y salir del canal', type: 1 },
  { name: 'nowplaying', description: 'Mostrar la canción en reproducción', type: 1 },
  {
    name: 'volume',
    description: 'Ajusta el volumen (0-200%)',
    type: 1,
    options: [
      { name: 'level', description: 'Porcentaje de volumen (0-200)', type: 4, required: true, min_value: 0, max_value: 200 }
    ],
  },
];

// ======================
// Persistencia de volumen por servidor
// ======================
const VOLUME_FILE = path.resolve(__dirname, 'volumes.json');
function loadVolumes() {
  try {
    const txt = fs.readFileSync(VOLUME_FILE, 'utf8');
    const obj = JSON.parse(txt);
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}
function saveVolumes(vols) {
  try {
    fs.writeFileSync(VOLUME_FILE, JSON.stringify(vols, null, 2), 'utf8');
  } catch (e) {
    console.error('[volume:save:error]', e);
  }
}
const guildVolumes = loadVolumes(); // { [guildId]: number 0..2 }

function isKnownInteractionError(err) {
  return err && (err.code === 10062 || err.code === 40060);
}

async function safeRespond(interaction, data, opts = {}) {
  const { edit = false, ephemeral = false } = opts;
  try {
    if (edit || interaction.deferred || interaction.replied) {
      if (typeof data === 'string') return await interaction.editReply(data);
      return await interaction.editReply(data);
    } else {
      if (typeof data === 'string') {
        return await interaction.reply({ content: data, flags: ephemeral ? 64 : undefined });
      }
      if (ephemeral) data.flags = 64;
      return await interaction.reply(data);
    }
  } catch (e) {
    if (isKnownInteractionError(e)) return; // ignorar errores típicos de interacción
    console.error('[safeRespond:error]', e);
  }
}

async function safeDefer(interaction) {
  if (interaction.deferred || interaction.replied) return true;
  try {
    await interaction.deferReply();
    return true;
  } catch (e) {
    if (isKnownInteractionError(e)) return false;
    console.error('[safeDefer:error]', e);
    return false;
  }
}

async function registerGuildCommands(guild) {
  try {
    await guild.commands.set(slashCommands);
  } catch (e) {
    console.error('[registerGuildCommands:error]', e);
  }
}

client.on('guildCreate', async (guild) => {
  await registerGuildCommands(guild);
});

// Nota: ya registramos en 'clientReady'

// ======================
// Cola por servidor
// ======================
const queues = new Map(); // guildId -> { songs: Array<{url,title,durationSec,thumbnailUrl,requestedById}>, player, connection, textChannelId, nowPlayingMessageId, loop:boolean, volume:number, uiInterval?: NodeJS.Timer }

function getQueue(guildId) {
  let q = queues.get(guildId);
  if (!q) {
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    player.on("error", (err) => console.error("[player:error]", err));
    player.on(AudioPlayerStatus.Idle, () => {
      const qq = queues.get(guildId);
      if (!qq) return;
      // Si está en loop, vuelve a reproducir el mismo tema sin avanzar
      if (qq.loop && qq.songs.length > 0) {
        playNext(guildId).catch((e) => console.error("[playNext:error]", e));
        return;
      }
      qq.songs.shift();
      if (qq.songs.length > 0) {
        playNext(guildId).catch((e) => console.error("[playNext:error]", e));
  } else {
        const conn = getVoiceConnection(guildId);
        conn?.destroy();
        queues.delete(guildId);
        // intentar borrar/eliminar mensaje de Now Playing si existe
        clearNowPlaying(guildId).catch(() => {});
    // detener ticker de progreso
    try { const q = queues.get(guildId); if (q?.uiInterval) clearInterval(q.uiInterval); } catch {}
      }
    });
  const initialVol = Math.max(0, Math.min(2, Number(guildVolumes[guildId] ?? 1.0)));
  q = { songs: [], player, connection: null, textChannelId: null, nowPlayingMessageId: null, loop: false, volume: initialVol, uiInterval: null };
    queues.set(guildId, q);
  }
  return q;
}

async function ensureConnection(guild, voiceChannel) {
  const q = getQueue(guild.id);
  if (q.connection && q.connection.state.status !== VoiceConnectionStatus.Destroyed) return q.connection;

  const attemptJoin = async () => {
    const conn = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });
    conn.on('error', (err) => console.error('[voice:connection:error]', err));
    conn.subscribe(q.player);
    await entersState(conn, VoiceConnectionStatus.Ready, 30_000);
    return conn;
  };

  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      q.connection = await attemptJoin();
      return q.connection;
    } catch (e) {
      lastErr = e;
      console.error('[voice:connection:ready:timeout]', e?.message);
      try { q.connection?.destroy(); } catch {}
      q.connection = null;
      if (i < 2) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  const err = new Error('VOICE_CONNECT_TIMEOUT');
  err.cause = lastErr;
  throw err;
}

async function createResourceFromUrl(url, volume = 1.0) {
  // Canonicalizar URL de YouTube para mayor compatibilidad
  url = canonicalizeYouTubeUrl(url);
  if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    throw new Error('INVALID_STREAM_URL');
  }
  // Para YouTube: priorizar ytdl-core y evitar warnings de play-dl
  if (isYouTubeUrl(url)) {
    try {
      const id = extractYouTubeId(url) || url;
      const info = await ytdl.getInfo(id);
      const fmt = selectWebmOpusFormat(info.formats);
      if (fmt) {
        const stream = ytdl.downloadFromInfo(info, { format: fmt, highWaterMark: 1 << 25 });
        const resource = createAudioResource(stream, { inputType: StreamType.WebmOpus, inlineVolume: true });
        if (resource.volume) resource.volume.setVolumeLogarithmic(Math.max(0, Math.min(2, volume)));
        return resource;
      }
      // Si no hay WebM/Opus, usar audioonly y dejar que ffmpeg demux/transcode (requiere ffmpeg-static)
      const fallbackStream = ytdl.downloadFromInfo(info, {
        quality: 'highestaudio',
        filter: 'audioonly',
        highWaterMark: 1 << 25,
      });
      const resource = createAudioResource(fallbackStream, { inputType: StreamType.Arbitrary, inlineVolume: true });
      if (resource.volume) resource.volume.setVolumeLogarithmic(Math.max(0, Math.min(2, volume)));
      return resource;
    } catch (eYtdl) {
      if (DEBUG_AUDIO) console.warn('[createResource:ytdl:fallback]', eYtdl?.message || eYtdl, 'url:', url);
      // Fallback a play-dl si ytdl falla
      try {
        const info = await playdl.video_info(url);
        const s = await playdl.stream_from_info(info, { discordPlayerCompatibility: true });
        const inputType = typeof s.type === 'number' ? s.type : StreamType.WebmOpus;
        const resource = createAudioResource(s.stream, { inputType, inlineVolume: true });
        if (resource.volume) resource.volume.setVolumeLogarithmic(Math.max(0, Math.min(2, volume)));
        return resource;
      } catch (ePlay) {
        if (DEBUG_AUDIO && (ePlay?.message !== 'Invalid URL')) console.warn('[createResource:playdl:fallback-A]', ePlay?.message || ePlay, 'url:', url);
        try {
          const s2 = await playdl.stream(url, { discordPlayerCompatibility: true });
          const inputType2 = typeof s2.type === 'number' ? s2.type : StreamType.WebmOpus;
          const resource2 = createAudioResource(s2.stream, { inputType: inputType2, inlineVolume: true });
          if (resource2.volume) resource2.volume.setVolumeLogarithmic(Math.max(0, Math.min(2, volume)));
          return resource2;
        } catch (ePlayB) {
          if (DEBUG_AUDIO && (ePlayB?.message !== 'Invalid URL')) console.warn('[createResource:playdl:fallback-B]', ePlayB?.message || ePlayB, 'url:', url);
        }
      }
    }
  } else {
    // No YouTube: usar play-dl primero (Soundcloud, etc.)
    try {
      const info = await playdl.video_info(url);
      const s = await playdl.stream_from_info(info, { discordPlayerCompatibility: true });
      const inputType = typeof s.type === 'number' ? s.type : StreamType.WebmOpus;
      const resource = createAudioResource(s.stream, { inputType, inlineVolume: true });
      if (resource.volume) resource.volume.setVolumeLogarithmic(Math.max(0, Math.min(2, volume)));
      return resource;
    } catch (ePlay) {
      if (DEBUG_AUDIO) console.warn('[createResource:playdl:fallback-A]', ePlay?.message || ePlay, 'url:', url);
      try {
        const s2 = await playdl.stream(url, { discordPlayerCompatibility: true });
        const inputType2 = typeof s2.type === 'number' ? s2.type : StreamType.WebmOpus;
        const resource2 = createAudioResource(s2.stream, { inputType: inputType2, inlineVolume: true });
        if (resource2.volume) resource2.volume.setVolumeLogarithmic(Math.max(0, Math.min(2, volume)));
        return resource2;
      } catch (ePlayB) {
        if (DEBUG_AUDIO) console.warn('[createResource:playdl:fallback-B]', ePlayB?.message || ePlayB, 'url:', url);
      }
    }
  }

  // Si todo falla
  const err = new Error('UNPLAYABLE_URL');
  err.url = url;
  throw err;
}

async function resolvePlayableUrl(input) {
  let url = input.replace(/^<(.+)>$/, "$1").trim();
  // Normalizar YouTube Music, youtu.be y shorts a watch?v=
  if (/^https?:\/\/(music\.)?youtube\.com\//i.test(url) || /^https?:\/\/youtu\.be\//i.test(url)) {
    url = canonicalizeYouTubeUrl(url);
  }
  const v = await playdl.validate(url);
  if (!v) {
    // Fallback: búsqueda por texto en YouTube
    try {
      const results = await playdl.search(url, { limit: 1, source: { youtube: 'video' } });
      const first = results?.[0];
      if (first?.url) return first.url;
    } catch {}
    return null;
  }
  if (v === 'yt_playlist') {
    const pl = await playdl.playlist_info(url, { incomplete: true });
    await pl.fetch();
    const first = pl.videos?.[0];
    if (!first) return null;
    return first.url || first.video_url || (first.id ? `https://www.youtube.com/watch?v=${first.id}` : null);
  }
  return canonicalizeYouTubeUrl(url);
}

async function fetchTitle(url) {
  try {
    const info = await playdl.video_info(canonicalizeYouTubeUrl(url));
    return info?.video_details?.title || url;
  } catch {
    return url;
  }
}

async function fetchMetadata(url) {
  const normalized = canonicalizeYouTubeUrl(url);
  // Intentar con play-dl
  try {
    const info = await playdl.video_info(normalized);
    const title = info?.video_details?.title || normalized;
    const dur = Number(info?.video_details?.durationInSec || info?.video_details?.durationInMs / 1000 || 0) || 0;
    const thumb = info?.video_details?.thumbnails?.[0]?.url || deriveYouTubeThumb(normalized);
    return { title, durationSec: dur > 0 ? Math.floor(dur) : 0, thumbnailUrl: thumb };
  } catch {}
  // Fallback con ytdl-core
  try {
    const id = extractYouTubeId(normalized) || normalized;
    const info = await ytdl.getInfo(id);
    const title = info?.videoDetails?.title || normalized;
    const dur = Number(info?.videoDetails?.lengthSeconds || 0) || 0;
    const thumb = (info?.videoDetails?.thumbnails || [])[0]?.url || deriveYouTubeThumb(normalized);
    return { title, durationSec: dur > 0 ? Math.floor(dur) : 0, thumbnailUrl: thumb };
  } catch {}
  return { title: normalized, durationSec: 0, thumbnailUrl: deriveYouTubeThumb(normalized) };
}

function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function buildProgressBar(totalSec, elapsedSec, size = 20) {
  totalSec = Math.max(1, Number(totalSec) || 1);
  elapsedSec = Math.max(0, Math.min(totalSec, Number(elapsedSec) || 0));
  const ratio = elapsedSec / totalSec;
  const filled = Math.max(0, Math.min(size, Math.round(ratio * size)));
  const bar = '▰'.repeat(Math.max(0, filled - 1)) + (filled > 0 ? '🔘' : '') + '▱'.repeat(Math.max(0, size - filled));
  return bar;
}

// Render de cola (queue) para reuso en respuestas
function formatQueueMessage(q, limit = 10) {
  if (!q || !Array.isArray(q.songs) || q.songs.length === 0) return 'La cola está vacía.';
  const elapsed = Math.floor((q.player?.state?.resource?.playbackDuration || 0) / 1000);
  const lines = q.songs.slice(0, limit).map((s, i) => {
    const dur = s.durationSec ? ` [${formatDuration(s.durationSec)}]` : '';
    if (i === 0) {
      const left = s.durationSec ? ` (${formatDuration(elapsed)} / ${formatDuration(s.durationSec)})` : '';
      return `▶️ ${s.title}${dur}${left}`;
    }
    return `${i + 1}. ${s.title}${dur}`;
  });
  if (q.songs.length > limit) lines.push(`... y ${q.songs.length - limit} más`);
  return lines.join('\n');
}

function canonicalizeYouTubeUrl(input) {
  try {
    const u = new URL(input);
    // youtu.be short links -> watch?v=
    if (/^youtu\.be$/i.test(u.hostname)) {
      const id = u.pathname.replace(/^\//, '').split(/[/?&]/)[0];
      return id ? `https://www.youtube.com/watch?v=${id}` : input;
    }
    // youtube shorts -> watch?v=
    if (/youtube\.com$/i.test(u.hostname) && u.pathname.startsWith('/shorts/')) {
      const id = u.pathname.split('/')[2];
      return id ? `https://www.youtube.com/watch?v=${id}` : input;
    }
    // youtube.com with v param -> normalize to watch?v=
    if (/youtube\.com$/i.test(u.hostname)) {
      const v = u.searchParams.get('v');
      if (v) return `https://www.youtube.com/watch?v=${v}`;
    }
    return input;
  } catch {
    return input;
  }
}

function isYouTubeUrl(input) {
  try {
    const u = new URL(input);
    return /(^|\.)youtube\.com$/i.test(u.hostname) || /^youtu\.be$/i.test(u.hostname) || /(^|\.)music\.youtube\.com$/i.test(u.hostname);
  } catch {
    return false;
  }
}

function extractYouTubeId(input) {
  try {
    const u = new URL(input);
    if (/^youtu\.be$/i.test(u.hostname)) {
      const id = u.pathname.replace(/^\//, '').split(/[/?&]/)[0];
      return id || null;
    }
    if (/youtube\.com$/i.test(u.hostname)) {
      if (u.pathname.startsWith('/shorts/')) {
        const id = u.pathname.split('/')[2];
        return id || null;
      }
      const v = u.searchParams.get('v');
      if (v) return v;
    }
  } catch {}
  // Regex extra por si viene texto raro
  const m = String(input).match(/[?&]v=([a-zA-Z0-9_-]{6,})(?:&|$)/);
  if (m) return m[1];
  const n = String(input).match(/youtu\.be\/([a-zA-Z0-9_-]{6,})(?:[?&]|$)/);
  if (n) return n[1];
  return null;
}

function deriveYouTubeThumb(url) {
  const id = extractYouTubeId(url);
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : undefined;
}

function selectWebmOpusFormat(formats) {
  if (!Array.isArray(formats)) return null;
  // Filtrar formatos con audio Opus y contenedor webm
  const candidates = formats.filter((f) => {
    const a = (f.audioCodec || f.codecs || f.codec || '').toString();
    const container = (f.container || '').toString();
    const mime = (f.mimeType || '').toString();
    const isWebm = /webm/i.test(container) || /webm/i.test(mime);
    const isOpus = /opus/i.test(a) || /opus/i.test(mime);
    const hasAudio = f.hasAudio !== false || /audio\//i.test(mime);
    return hasAudio && isWebm && isOpus && f.url;
  });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0));
  return candidates[0];
}

async function playNext(guildId) {
  const q = queues.get(guildId);
  if (!q || q.songs.length === 0) return;
  const current = q.songs[0];
  try {
    const resource = await createResourceFromUrl(current.url, q.volume ?? 1.0);
    q.player.play(resource);
    // Actualizar/crear el mensaje de Now Playing
    try { await renderNowPlaying(guildId); } catch (e) { if (DEBUG_AUDIO) console.warn('[renderNowPlaying:error]', e?.message || e); }
  // iniciar ticker para refrescar el progreso
  try { startNowPlayingTicker(guildId); } catch {}
  } catch (e) {
    console.error('[playNext:error]', e?.message || e);
    // Saltar esta pista y continuar con la siguiente
    q.songs.shift();
    if (q.songs.length > 0) {
      playNext(guildId).catch((err) => console.error('[playNext:chain:error]', err));
    } else {
      const conn = getVoiceConnection(guildId);
      conn?.destroy();
      queues.delete(guildId);
      clearNowPlaying(guildId).catch(() => {});
      try { stopNowPlayingTicker(guildId); } catch {}
    }
  }
}

function startNowPlayingTicker(guildId) {
  const q = queues.get(guildId);
  if (!q) return;
  if (q.uiInterval) { try { clearInterval(q.uiInterval); } catch {} }
  q.uiInterval = setInterval(() => {
    const qq = queues.get(guildId);
    if (!qq) return stopNowPlayingTicker(guildId);
  if (!qq.nowPlayingMessageId || qq.songs.length === 0) return;
  // Solo refrescar cuando realmente está reproduciendo
  if (qq.player?.state?.status !== AudioPlayerStatus.Playing) return;
    renderNowPlaying(guildId).catch(() => {});
  }, 3_000);
}

function stopNowPlayingTicker(guildId) {
  const q = queues.get(guildId);
  if (!q || !q.uiInterval) return;
  try { clearInterval(q.uiInterval); } catch {}
  q.uiInterval = null;
}

// ===== UI: Now Playing Embed + Botones =====
function buildControlsComponents(q) {
  const isPaused = q.player.state.status === AudioPlayerStatus.Paused;
  const s = q.songs?.[0];
  // Fila 1: transporte y loop
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('music_replay').setEmoji('⏮️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(isPaused ? 'music_resume' : 'music_pause').setEmoji(isPaused ? '▶️' : '⏸️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('music_skip').setEmoji('⏭️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('music_stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('music_loop').setEmoji('🔁').setStyle(q.loop ? ButtonStyle.Success : ButtonStyle.Secondary),
  );
  // Fila 2: volumen, shuffle, guardar y enlace
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('music_vol_down').setEmoji('�').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('music_vol_up').setEmoji('�').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('music_shuffle').setEmoji('🔀').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('music_save').setEmoji('💾').setStyle(ButtonStyle.Secondary),
  );
  if (s?.url) {
    row2.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(s.url).setEmoji('🔗').setLabel('Abrir'));
  }
  return [row1, row2];
}

function buildNowPlayingEmbed(q, guild) {
  const s = q.songs?.[0];
  const elapsed = Math.floor((q.player?.state?.resource?.playbackDuration || 0) / 1000);
  const total = s?.durationSec || 0;
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🎶 Reproduciendo ahora')
    .addFields(
      { name: 'Canción:', value: s ? `[${s.title}](${s.url})` : '—', inline: false },
      { name: 'Agregado por:', value: s?.requestedById ? `<@${s.requestedById}>` : guild?.members?.me?.toString() || '—', inline: true },
      { name: 'Duración:', value: total ? formatDuration(total) : '—', inline: true },
    )
    .setFooter({ text: `Controles debajo · Volumen: ${Math.round((q.volume ?? 1) * 100)}% · Loop: ${q.loop ? 'ON' : 'OFF'}` });
  if (total) {
    embed.setDescription(buildProgressBar(total, elapsed));
  }
  if (s?.thumbnailUrl) embed.setThumbnail(s.thumbnailUrl);
  return embed;
}

async function renderNowPlaying(guildId) {
  const q = queues.get(guildId);
  if (!q || !q.textChannelId) return;
  const channel = await client.channels.fetch(q.textChannelId).catch(() => null);
  if (!channel || !channel.isTextBased?.()) return;
  const embed = buildNowPlayingEmbed(q, channel.guild);
  const components = buildControlsComponents(q);
  if (q.nowPlayingMessageId) {
    try {
      const msg = await channel.messages.fetch(q.nowPlayingMessageId);
      await msg.edit({ embeds: [embed], components });
      return msg;
    } catch (_) {
      q.nowPlayingMessageId = null;
    }
  }
  const sent = await channel.send({ embeds: [embed], components });
  q.nowPlayingMessageId = sent.id;
  return sent;
}

async function clearNowPlaying(guildId) {
  const q = queues.get(guildId);
  if (!q || !q.textChannelId || !q.nowPlayingMessageId) return;
  const channel = await client.channels.fetch(q.textChannelId).catch(() => null);
  if (!channel || !channel.isTextBased?.()) return;
  await channel.messages.delete(q.nowPlayingMessageId).catch(() => {});
  q.nowPlayingMessageId = null;
}

// Comandos básicos
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  // !play <URL|búsqueda>
  if (message.content.startsWith("!play")) {
    const raw = message.content.slice("!play".length).trim();
    const candidate = raw || (message.content.match(/https?:\/\/\S+/)?.[0] ?? "");
    if (!candidate) return message.reply("📌 Usá: `!play <link>`");
    // Playlist YouTube: encolar múltiples items
    try {
      const vType = await playdl.validate(canonicalizeYouTubeUrl(candidate));
      if (vType === 'yt_playlist') {
        const voiceChannel = message.member.voice.channel;
        if (!voiceChannel) return message.reply("❌ Tenés que estar en un canal de voz.");
        const perms = voiceChannel.permissionsFor(message.client.user);
        if (!perms?.has(PermissionsBitField.Flags.Connect) || !perms?.has(PermissionsBitField.Flags.Speak)) {
          return message.reply("❌ No tengo permisos para unirme o hablar en ese canal.");
        }
        const q = getQueue(message.guild.id);
        q.textChannelId = message.channel.id;
        await ensureConnection(message.guild, voiceChannel);
        const pl = await playdl.playlist_info(candidate, { incomplete: true });
        await pl.fetch();
        const items = (pl.videos || []).slice(0, MAX_PLAYLIST_ITEMS);
        if (items.length === 0) return message.reply('❌ No pude leer la playlist.');
        for (const vid of items) {
          const url = vid.url || vid.video_url || (vid.id ? `https://www.youtube.com/watch?v=${vid.id}` : null);
          if (!url) continue;
          const title = vid.title || vid.name || url;
          const dur = Number(vid.durationInSec || vid.durationInMs / 1000 || 0) || 0;
          q.songs.push({ url: canonicalizeYouTubeUrl(url), title, durationSec: dur ? Math.floor(dur) : 0, thumbnailUrl: deriveYouTubeThumb(url), requestedById: message.author.id });
        }
  if (q.songs.length > 0 && q.player.state.status !== AudioPlayerStatus.Playing) {
          await playNext(message.guild.id);
        }
  const queueText = formatQueueMessage(q);
  return message.reply(`📚 Añadidos ${items.length} temas de la playlist "${pl.title || ''}" (máx ${MAX_PLAYLIST_ITEMS}).\n\nCola actual:\n${queueText}`);
      }
    } catch {}
    const finalUrl = await resolvePlayableUrl(candidate);
    if (!finalUrl) return message.reply("❌ Link inválido o no soportado.");

    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) return message.reply("❌ Tenés que estar en un canal de voz.");

    const perms = voiceChannel.permissionsFor(message.client.user);
    if (!perms?.has(PermissionsBitField.Flags.Connect) || !perms?.has(PermissionsBitField.Flags.Speak)) {
      return message.reply("❌ No tengo permisos para unirme o hablar en ese canal.");
    }

    try {
      const q = getQueue(message.guild.id);
      q.textChannelId = message.channel.id;
      await ensureConnection(message.guild, voiceChannel);
  const meta = await fetchMetadata(finalUrl);
  q.songs.push({ url: finalUrl, title: meta.title, durationSec: meta.durationSec || 0, thumbnailUrl: meta.thumbnailUrl, requestedById: message.author.id });
      let header;
      if (q.songs.length === 1) {
        await playNext(message.guild.id);
        header = `🎶 Reproduciendo: ${meta.title}${meta.durationSec ? ` [${formatDuration(meta.durationSec)}]` : ''}`;
      } else {
        header = `➕ Añadido a la cola: ${meta.title}${meta.durationSec ? ` [${formatDuration(meta.durationSec)}]` : ''} (pos. ${q.songs.length})`;
      }
      const queueText = formatQueueMessage(q);
  message.reply(`${header}\n\nCola actual:\n${queueText}`);
  // refrescar panel
  renderNowPlaying(message.guild.id).catch(() => {});
    } catch (err) {
      console.error("[play:error]", err);
      message.reply("⚠️ No se pudo reproducir el audio.");
    }
  }

  // !skip
  if (message.content === "!skip") {
    const q = queues.get(message.guild.id);
    if (!q || q.songs.length === 0) return message.reply("No hay nada en reproducción.");
    // Saltar ignorando loop
    q.loop = false;
    q.songs.shift();
    if (q.songs.length > 0) {
      await playNext(message.guild.id);
    } else {
      const connection = getVoiceConnection(message.guild.id);
      connection?.destroy();
      queues.delete(message.guild.id);
      clearNowPlaying(message.guild.id).catch(() => {});
    }
    const queueText = formatQueueMessage(q);
    return message.reply(`⏭️ Saltado.\n\nCola actual:\n${queueText}`);
  }

  // !pause
  if (message.content === "!pause") {
    const q = queues.get(message.guild.id);
    if (!q) return message.reply("No hay nada en reproducción.");
    q.player.pause();
  try { stopNowPlayingTicker(message.guild.id); } catch {}
    const queueText = formatQueueMessage(q);
  const r = await message.reply(`⏸️ Pausado.\n\nCola actual:\n${queueText}`);
  renderNowPlaying(message.guild.id).catch(() => {});
  return r;
  }

  // !resume
  if (message.content === "!resume") {
    const q = queues.get(message.guild.id);
    if (!q) return message.reply("No hay nada en reproducción.");
    q.player.unpause();
  try { startNowPlayingTicker(message.guild.id); } catch {}
    const queueText = formatQueueMessage(q);
  const r = await message.reply(`▶️ Reanudado.\n\nCola actual:\n${queueText}`);
  renderNowPlaying(message.guild.id).catch(() => {});
  return r;
  }

  // !queue
  if (message.content === "!queue") {
    const q = queues.get(message.guild.id);
    if (!q || q.songs.length === 0) return message.reply("La cola está vacía.");
    const elapsed = Math.floor((q.player.state?.resource?.playbackDuration || 0) / 1000);
    const lines = q.songs.slice(0, 10).map((s, i) => {
      const dur = s.durationSec ? ` [${formatDuration(s.durationSec)}]` : '';
      if (i === 0) {
        const left = s.durationSec ? ` (${formatDuration(elapsed)} / ${formatDuration(s.durationSec)})` : '';
        return `▶️ ${s.title}${dur}${left}`;
      }
      return `${i + 1}. ${s.title}${dur}`;
    });
    return message.reply(lines.join("\n"));
  }

  // !nowplaying | !np
  if (message.content === '!nowplaying' || message.content === '!np') {
    const q = queues.get(message.guild.id);
    if (!q || q.songs.length === 0) return message.reply('No hay nada en reproducción.');
    const s = q.songs[0];
    const elapsed = Math.floor((q.player.state?.resource?.playbackDuration || 0) / 1000);
    const total = s.durationSec || 0;
    const header = total
      ? `🎶 Ahora: ${s.title} [${formatDuration(elapsed)} / ${formatDuration(total)}] • Vol: ${Math.round((q.volume ?? 1) * 100)}%`
      : `🎶 Ahora: ${s.title} • Vol: ${Math.round((q.volume ?? 1) * 100)}%`;
    const bar = total ? `\n${buildProgressBar(total, elapsed)}` : '';
    return message.reply(header + bar);
  }

  // !stop
  if (message.content === "!stop") {
    const q = queues.get(message.guild.id);
    const connection = getVoiceConnection(message.guild.id);
  const queueText = q ? formatQueueMessage(q) : 'La cola está vacía.';
    if (q) q.songs = [];
    connection?.destroy();
    queues.delete(message.guild.id);
  const r = await message.reply(`⏹️ Música detenida y bot desconectado.\n\nCola final:\n${queueText}`);
  clearNowPlaying(message.guild.id).catch(() => {});
  try { stopNowPlayingTicker(message.guild.id); } catch {}
  return r;
  }

  // !volume <0-200>
  if (message.content.startsWith("!volume")) {
    const arg = message.content.split(/\s+/)[1];
    if (!arg || isNaN(parseInt(arg))) return message.reply("📌 Usá: `!volume <0-200>`. Ej: `!volume 100`");
    const pct = Math.max(0, Math.min(200, parseInt(arg)));
    const q = getQueue(message.guild.id);
    q.volume = pct / 100;
  guildVolumes[message.guild.id] = q.volume;
  saveVolumes(guildVolumes);
    const res = q.player.state?.resource;
    if (res?.volume?.setVolumeLogarithmic) res.volume.setVolumeLogarithmic(Math.max(0, Math.min(2, q.volume)));
  const r = await message.reply(`🔊 Volumen: ${pct}%`);
  renderNowPlaying(message.guild.id).catch(() => {});
  return r;
  }
});

// ======================
// Interacciones de Slash Commands
// ======================
client.on('interactionCreate', async (interaction) => {
  // Botones de control
  if (interaction.isButton()) {
    const { guild, user } = interaction;
    const q = guild ? queues.get(guild.id) : null;
    if (!q) {
      try { await interaction.reply({ content: 'No hay nada en reproducción.', ephemeral: true }); } catch {}
      return;
    }
    const id = interaction.customId;
    try { await interaction.deferUpdate(); } catch {}
    if (id === 'music_pause') {
      q.player.pause();
  try { stopNowPlayingTicker(guild.id); } catch {}
      await renderNowPlaying(guild.id).catch(() => {});
      return;
    }
    if (id === 'music_resume') {
      q.player.unpause();
  try { startNowPlayingTicker(guild.id); } catch {}
      await renderNowPlaying(guild.id).catch(() => {});
      return;
    }
    if (id === 'music_skip') {
      // Saltar ignorando loop
      if (q.songs.length > 0) q.songs.shift();
      if (q.songs.length > 0) {
        await playNext(guild.id);
      } else {
        const connection = getVoiceConnection(guild.id);
        connection?.destroy();
        queues.delete(guild.id);
        clearNowPlaying(guild.id).catch(() => {});
      }
      return;
    }
    if (id === 'music_stop') {
      const connection = getVoiceConnection(guild.id);
      if (q) q.songs = [];
      connection?.destroy();
      queues.delete(guild.id);
      clearNowPlaying(guild.id).catch(() => {});
  stopNowPlayingTicker(guild.id);
      return;
    }
    if (id === 'music_loop') {
      q.loop = !q.loop;
      await renderNowPlaying(guild.id).catch(() => {});
      return;
    }
    if (id === 'music_shuffle') {
      if (q.songs.length > 2) {
        const head = q.songs[0];
        const rest = q.songs.slice(1);
        for (let i = rest.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [rest[i], rest[j]] = [rest[j], rest[i]];
        }
        q.songs = [head, ...rest];
      }
      await renderNowPlaying(guild.id).catch(() => {});
      return;
    }
    if (id === 'music_replay') {
      // Reiniciar pista actual sin modificar la cola
      const song = q.songs[0];
      if (song) {
        try {
          const resource = await createResourceFromUrl(song.url, q.volume ?? 1.0);
          q.player.play(resource);
          await renderNowPlaying(guild.id).catch(() => {});
        } catch {}
      }
      return;
    }
    if (id === 'music_vol_down' || id === 'music_vol_up') {
      const delta = id === 'music_vol_up' ? 0.1 : -0.1;
      q.volume = Math.max(0, Math.min(2, (q.volume ?? 1) + delta));
      guildVolumes[guild.id] = q.volume; saveVolumes(guildVolumes);
      const res = q.player.state?.resource; if (res?.volume?.setVolumeLogarithmic) res.volume.setVolumeLogarithmic(q.volume);
      await renderNowPlaying(guild.id).catch(() => {});
      return;
    }
    if (id === 'music_save') {
      const s = q.songs?.[0];
      if (s) {
        try {
          const dm = await user.createDM();
          await dm.send({ embeds: [new EmbedBuilder().setColor(0x57F287).setTitle('Guardado').setDescription(`[${s.title}](${s.url})`).addFields(
            { name: 'Servidor', value: guild.name, inline: true },
            { name: 'Duración', value: s.durationSec ? formatDuration(s.durationSec) : '—', inline: true },
          )] });
        } catch {}
      }
      return;
    }
    return;
  }
  if (!interaction.isChatInputCommand()) return;
  const { commandName, guild, member } = interaction;
  if (!guild) {
    await safeRespond(interaction, 'Este comando sólo funciona en servidores.', { ephemeral: true });
    return;
  }

  try {
    if (commandName === 'play') {
      const query = interaction.options.getString('query', true);
      const ok = await safeDefer(interaction);
      if (!ok) return;
      // Playlist en /play
      try {
        const vType = await playdl.validate(canonicalizeYouTubeUrl(query));
        if (vType === 'yt_playlist') {
          const voiceChannel = member.voice?.channel;
          if (!voiceChannel) return safeRespond(interaction, '❌ Tenés que estar en un canal de voz.', { edit: true });
          const perms = voiceChannel.permissionsFor(interaction.client.user);
          if (!perms?.has(PermissionsBitField.Flags.Connect) || !perms?.has(PermissionsBitField.Flags.Speak)) {
            return safeRespond(interaction, '❌ No tengo permisos para unirme o hablar en ese canal.', { edit: true });
          }
          const q = getQueue(guild.id);
          q.textChannelId = interaction.channelId;
          try { await ensureConnection(guild, voiceChannel); } catch (e) { return safeRespond(interaction, '❌ No pude conectarme al canal de voz.', { edit: true }); }
          const pl = await playdl.playlist_info(query, { incomplete: true });
          await pl.fetch();
          const items = (pl.videos || []).slice(0, MAX_PLAYLIST_ITEMS);
          if (items.length === 0) return safeRespond(interaction, '❌ No pude leer la playlist.', { edit: true });
          for (const vid of items) {
            const url = vid.url || vid.video_url || (vid.id ? `https://www.youtube.com/watch?v=${vid.id}` : null);
            if (!url) continue;
            const title = vid.title || vid.name || url;
            const dur = Number(vid.durationInSec || vid.durationInMs / 1000 || 0) || 0;
            q.songs.push({ url: canonicalizeYouTubeUrl(url), title, durationSec: dur ? Math.floor(dur) : 0, thumbnailUrl: deriveYouTubeThumb(url), requestedById: member?.user?.id });
          }
          if (q.songs.length > 0 && q.player.state.status !== AudioPlayerStatus.Playing) {
            await playNext(guild.id);
          }
          const queueText = formatQueueMessage(q);
          return safeRespond(interaction, `📚 Añadidos ${items.length} temas de la playlist "${pl.title || ''}" (máx ${MAX_PLAYLIST_ITEMS}).\n\nCola actual:\n${queueText}`, { edit: true });
        }
      } catch {}

      const finalUrl = await resolvePlayableUrl(query);
      if (!finalUrl) return safeRespond(interaction, '❌ Link inválido o no soportado.', { edit: true });

      const voiceChannel = member.voice?.channel;
      if (!voiceChannel) return safeRespond(interaction, '❌ Tenés que estar en un canal de voz.', { edit: true });
      const perms = voiceChannel.permissionsFor(interaction.client.user);
      if (!perms?.has(PermissionsBitField.Flags.Connect) || !perms?.has(PermissionsBitField.Flags.Speak)) {
        return safeRespond(interaction, '❌ No tengo permisos para unirme o hablar en ese canal.', { edit: true });
      }

      const q = getQueue(guild.id);
      q.textChannelId = interaction.channelId;
      try {
        await ensureConnection(guild, voiceChannel);
      } catch (e) {
        return safeRespond(interaction, '❌ No pude conectarme al canal de voz. Revisá permisos o la región del servidor e intentá de nuevo.', { edit: true });
      }
  const meta = await fetchMetadata(finalUrl);
  q.songs.push({ url: finalUrl, title: meta.title, durationSec: meta.durationSec || 0, requestedById: member?.user?.id });
      let header;
      if (q.songs.length === 1) {
        await playNext(guild.id);
        header = `🎶 Reproduciendo: ${meta.title}${meta.durationSec ? ` [${formatDuration(meta.durationSec)}]` : ''}`;
      } else {
        header = `➕ Añadido a la cola: ${meta.title}${meta.durationSec ? ` [${formatDuration(meta.durationSec)}]` : ''} (pos. ${q.songs.length})`;
      }
      const queueText = formatQueueMessage(q);
  const r = await safeRespond(interaction, `${header}\n\nCola actual:\n${queueText}`, { edit: true });
  try { await renderNowPlaying(guild.id); } catch {}
  return r;
    }

    if (commandName === 'skip') {
      const ok = await safeDefer(interaction);
      if (!ok) return;
      const q = queues.get(guild.id);
      if (!q || q.songs.length === 0) return safeRespond(interaction, 'No hay nada en reproducción.', { edit: true });
      q.loop = false;
      q.songs.shift();
      if (q.songs.length > 0) {
        await playNext(guild.id);
      } else {
        const connection = getVoiceConnection(guild.id);
        connection?.destroy();
        queues.delete(guild.id);
        clearNowPlaying(guild.id).catch(() => {});
      }
      const queueText = formatQueueMessage(q);
      await safeRespond(interaction, `⏭️ Saltado.\n\nCola actual:\n${queueText}`, { edit: true });
      await renderNowPlaying(guild.id).catch(() => {});
      return;
    }

    if (commandName === 'pause') {
  const ok = await safeDefer(interaction);
  if (!ok) return;
  const q = queues.get(guild.id);
  if (!q) return safeRespond(interaction, 'No hay nada en reproducción.', { edit: true });
  q.player.pause();
  try { stopNowPlayingTicker(guild.id); } catch {}
  const queueText = formatQueueMessage(q);
  await safeRespond(interaction, `⏸️ Pausado.\n\nCola actual:\n${queueText}`, { edit: true });
  await renderNowPlaying(guild.id).catch(() => {});
  return;
    }

    if (commandName === 'resume') {
  const ok = await safeDefer(interaction);
  if (!ok) return;
  const q = queues.get(guild.id);
  if (!q) return safeRespond(interaction, 'No hay nada en reproducción.', { edit: true });
  q.player.unpause();
  try { startNowPlayingTicker(guild.id); } catch {}
  const queueText = formatQueueMessage(q);
  await safeRespond(interaction, `▶️ Reanudado.\n\nCola actual:\n${queueText}`, { edit: true });
  await renderNowPlaying(guild.id).catch(() => {});
  return;
    }

    if (commandName === 'queue') {
      const ok = await safeDefer(interaction);
      if (!ok) return;
      const q = queues.get(guild.id);
      if (!q || q.songs.length === 0) return safeRespond(interaction, 'La cola está vacía.', { edit: true });
      const elapsed = Math.floor((q.player.state?.resource?.playbackDuration || 0) / 1000);
      const lines = q.songs.slice(0, 10).map((s, i) => {
        const dur = s.durationSec ? ` [${formatDuration(s.durationSec)}]` : '';
        if (i === 0) {
          const left = s.durationSec ? ` (${formatDuration(elapsed)} / ${formatDuration(s.durationSec)})` : '';
          return `▶️ ${s.title}${dur}${left}`;
        }
        return `${i + 1}. ${s.title}${dur}`;
      });
      return safeRespond(interaction, lines.join('\n'), { edit: true });
    }

    if (commandName === 'nowplaying') {
      const ok = await safeDefer(interaction);
      if (!ok) return;
      const q = queues.get(guild.id);
      if (!q || q.songs.length === 0) return safeRespond(interaction, 'No hay nada en reproducción.', { edit: true });
      const s = q.songs[0];
      const elapsed = Math.floor((q.player.state?.resource?.playbackDuration || 0) / 1000);
      const total = s.durationSec || 0;
      const header = total
        ? `🎶 Ahora: ${s.title} [${formatDuration(elapsed)} / ${formatDuration(total)}] • Vol: ${Math.round((q.volume ?? 1) * 100)}%`
        : `🎶 Ahora: ${s.title} • Vol: ${Math.round((q.volume ?? 1) * 100)}%`;
      const bar = total ? `\n${buildProgressBar(total, elapsed)}` : '';
      return safeRespond(interaction, header + bar, { edit: true });
    }

    if (commandName === 'stop') {
  const ok = await safeDefer(interaction);
  if (!ok) return;
  const q = queues.get(guild.id);
  const connection = getVoiceConnection(guild.id);
  const queueText = q ? formatQueueMessage(q) : 'La cola está vacía.';
  if (q) q.songs = [];
  connection?.destroy();
  queues.delete(guild.id);
  await clearNowPlaying(guild.id).catch(() => {});
  return safeRespond(interaction, `⏹️ Música detenida y bot desconectado.\n\nCola final:\n${queueText}`, { edit: true });
    }

    if (commandName === 'volume') {
      const ok = await safeDefer(interaction);
      if (!ok) return;
      let level = interaction.options.getInteger('level', true);
      if (typeof level !== 'number') level = 100;
      const pct = Math.max(0, Math.min(200, level));
      const q = getQueue(guild.id);
      q.volume = pct / 100;
  guildVolumes[guild.id] = q.volume;
  saveVolumes(guildVolumes);
  const res = q.player.state?.resource;
  if (res?.volume?.setVolumeLogarithmic) res.volume.setVolumeLogarithmic(Math.max(0, Math.min(2, q.volume)));
  await renderNowPlaying(guild.id).catch(() => {});
  return safeRespond(interaction, `🔊 Volumen: ${pct}%`, { edit: true });
    }
  } catch (e) {
    console.error('[interaction:error]', e);
    if (interaction.deferred || interaction.replied) {
      await safeRespond(interaction, '⚠️ Ocurrió un error.', { edit: true });
    } else {
      await safeRespond(interaction, '⚠️ Ocurrió un error.', { ephemeral: true });
    }
  }
});

// Iniciar el bot
client.login(process.env.DISCORD_TOKEN);
