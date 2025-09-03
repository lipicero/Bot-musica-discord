process.env.YTDL_NO_UPDATE = "1"; // desactiva chequeo de updates de ytdl-core
require("dotenv").config({ quiet: true });

// Intentar configurar ffmpeg estático para demux/transcode cuando sea necesario
try {
  const ffmpegPath = require("ffmpeg-static");
  if (ffmpegPath) {
    process.env.FFMPEG_PATH = ffmpegPath;
    console.log("[ffmpeg] ffmpeg-static configurado");
  }
} catch (_) {
  console.warn("[ffmpeg] ffmpeg-static no instalado; se intentará sin FFmpeg");
}
const DEBUG_AUDIO = process.env.DEBUG_AUDIO === "1";
const MAX_PLAYLIST_ITEMS = Math.max(
  1,
  Math.min(100, Number(process.env.MAX_PLAYLIST_ITEMS || 25))
);
const MAX_QUEUE_LENGTH = Math.max(
  1,
  Math.min(500, Number(process.env.MAX_QUEUE_LENGTH || 200))
);
const REQUIRE_SAME_VC = String(process.env.REQUIRE_SAME_VC || "1") === "1";
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  Client,
  GatewayIntentBits,
  PermissionsBitField,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  getVoiceConnection,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  entersState,
  StreamType,
} = require("@discordjs/voice");
const playdl = require("play-dl");
const ytdl = require("@distube/ytdl-core");
let ytdlp = null;
try {
  ytdlp = require("yt-dlp-exec");
} catch {}
const { spawn, spawnSync } = require("child_process");

// Helpers de cookies YouTube
function parseNetscapeCookieFileToHeader(content) {
  try {
    const lines = String(content).split(/\r?\n/);
    const parts = [];
    for (const line of lines) {
      const s = line.trim();
      if (!s || s.startsWith("#")) continue;
      const cols = s.split(/\t+/);
      if (cols.length < 7) continue;
      const name = cols[5];
      const value = cols[6];
      if (!name) continue;
      parts.push(`${name}=${value}`);
    }
    const uniq = Array.from(new Map(parts.map((p) => {
      const idx = p.indexOf("=");
      const k = idx === -1 ? p : p.slice(0, idx);
      return [k, p];
    })).values());
    return uniq.join("; ");
  } catch {
    return "";
  }
}

function getYouTubeCookieHeaderFromEnv() {
  try {
    // Prioridad: YT_COOKIE (header) > YT_COOKIE_B64 (netscape o header) > YT_COOKIE_FILE > YOUTUBE_COOKIE
    if (process.env.YT_COOKIE) return String(process.env.YT_COOKIE);
    let raw = null;
    if (process.env.YT_COOKIE_B64) {
      try {
        raw = Buffer.from(String(process.env.YT_COOKIE_B64).trim(), "base64").toString("utf8");
      } catch {}
      if (raw) {
        const looksNetscape = /\t/.test(raw) || /Netscape HTTP Cookie File/i.test(raw);
        return looksNetscape ? parseNetscapeCookieFileToHeader(raw) : raw;
      }
    }
    if (process.env.YT_COOKIE_FILE) {
      try {
        const p = String(process.env.YT_COOKIE_FILE).trim();
        if (p && fs.existsSync(p)) {
          const txt = fs.readFileSync(p, "utf8");
          const looksNetscape = /\t/.test(txt) || /Netscape HTTP Cookie File/i.test(txt);
          return looksNetscape ? parseNetscapeCookieFileToHeader(txt) : txt;
        }
      } catch {}
    }
    if (process.env.YOUTUBE_COOKIE) return String(process.env.YOUTUBE_COOKIE);
  } catch {}
  return "";
}

// Config opcional de YouTube para play-dl (evita bloqueos/edad/consent)
try {
  const ytCookieHdr = getYouTubeCookieHeaderFromEnv();
  if (ytCookieHdr) {
    playdl.setToken({ youtube: { cookie: ytCookieHdr } });
    console.log("[play-dl] cookie de YouTube configurada");
  }
} catch (e) {
  console.warn("[play-dl] No se pudo configurar cookie:", e?.message || e);
}

// Inicializamos el cliente de Discord
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// Evento recomendado en v14: 'clientReady' (evita warning de deprecación)
client.once("clientReady", async (c) => {
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
    name: "play",
    description: "Reproduce audio desde YouTube (URL o búsqueda)",
    type: 1,
    options: [
      { name: "query", description: "URL o búsqueda", type: 3, required: true },
    ],
  },
  { name: "skip", description: "Saltar a la siguiente pista", type: 1 },
  { name: "pause", description: "Pausar la reproducción", type: 1 },
  { name: "resume", description: "Reanudar la reproducción", type: 1 },
  { name: "queue", description: "Mostrar la cola", type: 1 },
  { name: "stop", description: "Detener y salir del canal", type: 1 },
  { name: "remove", description: "Remueve una canción de la cola por índice", type: 1, options: [ { name: "index", description: "Posición en la cola (1 = actual)", type: 4, required: true, min_value: 1 } ] },
  { name: "clear", description: "Limpia la cola (mantiene la canción actual)", type: 1 },
  {
    name: "nowplaying",
    description: "Mostrar la canción en reproducción",
    type: 1,
  },
  {
    name: "volume",
    description: "Ajusta el volumen (0-200%)",
    type: 1,
    options: [
      {
        name: "level",
        description: "Porcentaje de volumen (0-200)",
        type: 4,
        required: true,
        min_value: 0,
        max_value: 200,
      },
    ],
  },
];

// ======================
// Persistencia de volumen por servidor
// ======================
const VOLUME_FILE = path.resolve(__dirname, "volumes.json");
function loadVolumes() {
  try {
    const txt = fs.readFileSync(VOLUME_FILE, "utf8");
    const obj = JSON.parse(txt);
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}
function saveVolumes(vols) {
  try {
    fs.writeFileSync(VOLUME_FILE, JSON.stringify(vols, null, 2), "utf8");
  } catch (e) {
    console.error("[volume:save:error]", e);
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
      if (typeof data === "string") return await interaction.editReply(data);
      return await interaction.editReply(data);
    } else {
      if (typeof data === "string") {
        return await interaction.reply({
          content: data,
          flags: ephemeral ? 64 : undefined,
        });
      }
      if (ephemeral) data.flags = 64;
      return await interaction.reply(data);
    }
  } catch (e) {
    if (isKnownInteractionError(e)) return; // ignorar errores típicos de interacción
    console.error("[safeRespond:error]", e);
  }
}

async function safeDefer(interaction) {
  if (interaction.deferred || interaction.replied) return true;
  try {
    await interaction.deferReply();
    return true;
  } catch (e) {
    if (isKnownInteractionError(e)) return false;
    console.error("[safeDefer:error]", e);
    return false;
  }
}

async function registerGuildCommands(guild) {
  try {
    await guild.commands.set(slashCommands);
  } catch (e) {
    console.error("[registerGuildCommands:error]", e);
  }
}

client.on("guildCreate", async (guild) => {
  await registerGuildCommands(guild);
});

// Nota: ya registramos en 'clientReady'

// ======================
// Cola por servidor
// ======================
const queues = new Map(); // guildId -> { songs: Array<{url,title,durationSec,thumbnailUrl,requestedById,retries?:number, ytdlInfo?:any, videoId?:string}>, player, connection, textChannelId, nowPlayingMessageId, loop:boolean, volume:number, uiInterval?: NodeJS.Timer, currentRetry?:number, upgradeTimer?:NodeJS.Timer, currentTrackToken?:string }

function getQueue(guildId) {
  let q = queues.get(guildId);
  if (!q) {
    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });
    if (DEBUG_AUDIO) {
      player.on("stateChange", (oldState, newState) => {
        try {
          const os = oldState?.status;
          const ns = newState?.status;
          const ms = q?.player?.state?.resource?.playbackDuration || 0;
          console.log(
            `[player] state ${os} -> ${ns} (${Math.floor(ms / 1000)}s)`
          );
        } catch {}
      });
    }
    player.on("error", async (err) => {
      console.error("[player:error]", err);
      const qq = queues.get(guildId);
      if (!qq || !qq.songs.length) return;
      // Si es un 403 de miniget/ytdl, intentar re-crear el recurso con play-dl directamente
      const is403 = /\b403\b/.test(String(err?.message || ""));
      if (is403) {
        try {
          const current = qq.songs[0];
          if (current?.url) {
            const forceYtDlp = String(process.env.YT_FORCE_YTDLP || "0") === "1";
            if (forceYtDlp && ytdlp) {
              const res2 = await createResourceFromYtDlp(
                current.url,
                qq.volume ?? 1.0,
                {
                  userAgent:
                    process.env.YTDL_USER_AGENT ||
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                  acceptLang:
                    process.env.YTDL_ACCEPT_LANGUAGE ||
                    "es-ES,es;q=0.9,en;q=0.8",
                  cookie: process.env.YT_COOKIE || process.env.YOUTUBE_COOKIE,
                }
              );
              qq.player.play(res2);
              return;
            }
            // Primero intentar con play-dl
            const resource = await createResourceFromUrl(
              current.url,
              qq.volume ?? 1.0,
              { preferPlayDl: true }
            ).catch(() => null);
            if (resource) {
              qq.player.play(resource);
              return;
            }
            // Luego probar con yt-dlp si está disponible
            if (!forceYtDlp && ytdlp) {
              const res3 = await createResourceFromYtDlp(
                current.url,
                qq.volume ?? 1.0,
                {
                  userAgent:
                    process.env.YTDL_USER_AGENT ||
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                  acceptLang:
                    process.env.YTDL_ACCEPT_LANGUAGE ||
                    "es-ES,es;q=0.9,en;q=0.8",
                  cookie: process.env.YT_COOKIE || process.env.YOUTUBE_COOKIE,
                }
              );
              qq.player.play(res3);
              return;
            }
            qq.player.play(resource);
            return;
          }
        } catch (e403) {
          if (DEBUG_AUDIO)
            console.warn(
              "[player:error:403-fallback-failed]",
              e403?.message || e403
            );
        }
      }
      // Reintentar la pista actual hasta 2 veces, luego saltar
      qq.currentRetry = (qq.currentRetry || 0) + 1;
      if (qq.currentRetry <= 2) {
        try {
          await playNext(guildId);
        } catch (e) {
          console.error("[player:error:retry-failed]", e?.message || e);
        }
      } else {
        qq.currentRetry = 0;
        qq.songs.shift();
        if (qq.songs.length > 0) {
          try {
            await playNext(guildId);
          } catch (e) {
            console.error("[player:error:skip-next-failed]", e?.message || e);
          }
        } else {
          const conn = getVoiceConnection(guildId);
          conn?.destroy();
          queues.delete(guildId);
          clearNowPlaying(guildId).catch(() => {});
          try {
            stopNowPlayingTicker(guildId);
          } catch {}
        }
      }
    });
    player.on(AudioPlayerStatus.Idle, () => {
      const qq = queues.get(guildId);
      if (!qq) return;
      // limpiar upgrade timer si existe al finalizar pista
      if (qq.upgradeTimer) {
        try {
          clearTimeout(qq.upgradeTimer);
        } catch {}
        qq.upgradeTimer = null;
      }
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
        try {
          const q = queues.get(guildId);
          if (q?.uiInterval) clearInterval(q.uiInterval);
        } catch {}
      }
    });
    const initialVol = Math.max(
      0,
      Math.min(2, Number(guildVolumes[guildId] ?? 1.0))
    );
    q = {
      songs: [],
      player,
      connection: null,
      textChannelId: null,
      nowPlayingMessageId: null,
      loop: false,
      volume: initialVol,
      uiInterval: null,
      currentRetry: 0,
    };
    queues.set(guildId, q);
  }
  return q;
}

function tryEnqueue(q, song) {
  if (!q || !song) return false;
  if ((q.songs?.length || 0) >= MAX_QUEUE_LENGTH) return false;
  q.songs.push(song);
  return true;
}

function sameVoiceChannelRequiredPass(guild, user) {
  if (!REQUIRE_SAME_VC) return true;
  try {
    const meConn = getVoiceConnection(guild.id);
    const botChannelId = meConn?.joinConfig?.channelId;
    const member = guild.members.cache.get(user.id);
    const userChannelId = member?.voice?.channelId;
    if (!botChannelId || !userChannelId) return false;
    return botChannelId === userChannelId;
  } catch {
    return false;
  }
}

async function ensureConnection(guild, voiceChannel) {
  const q = getQueue(guild.id);
  if (
    q.connection &&
    q.connection.state.status !== VoiceConnectionStatus.Destroyed
  )
    return q.connection;

  if (q.connectingPromise) {
    return q.connectingPromise;
  }

  const attemptJoin = async () => {
    if (DEBUG_AUDIO)
      console.log(`[voice] intentando unirse a ${voiceChannel?.id}`);
    const conn = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });
    conn.on("error", (err) => console.error("[voice:connection:error]", err));
    // Reconexión básica si Discord mueve el canal o hay blips de red
    conn.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(conn, VoiceConnectionStatus.Signalling, 5_000),
          entersState(conn, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        // Se recuperó solo
      } catch {
        try {
          conn.destroy();
        } catch {}
      }
    });
    // Fix keepAlive UDP leak y evitar fugas de listeners
    const networkingStateChangeHandler = (oldNet, newNet) => {
      const udp = Reflect.get(newNet, "udp");
      if (udp && udp.keepAliveInterval) {
        try {
          clearInterval(udp.keepAliveInterval);
        } catch {}
        udp.keepAliveInterval = null;
      }
    };
    conn.on("stateChange", (oldState, newState) => {
      const oldNetworking = Reflect.get(oldState, "networking");
      const newNetworking = Reflect.get(newState, "networking");
      // Remover handler anterior usando la misma referencia almacenada
      const prev = Reflect.get(conn, "_networkingHandler");
      if (oldNetworking && prev) {
        oldNetworking.off?.("stateChange", prev);
      }
      if (newNetworking) {
        // Subir el límite para evitar warnings en entornos ruidosos
        newNetworking.setMaxListeners?.(20);
        newNetworking.on?.("stateChange", networkingStateChangeHandler);
        Reflect.set(conn, "_networkingHandler", networkingStateChangeHandler);
      }
    });
    conn.subscribe(q.player);
    await entersState(conn, VoiceConnectionStatus.Ready, 45_000);
    if (DEBUG_AUDIO)
      console.log(`[voice] conectado y listo en guild ${guild.id}`);
    return conn;
  };

  q.connectingPromise = (async () => {
    let lastErr;
    for (let i = 0; i < 5; i++) {
      try {
        q.connection = await attemptJoin();
        return q.connection;
      } catch (e) {
        lastErr = e;
        console.error("[voice:connection:ready:timeout]", e?.message);
        try {
          q.connection?.destroy();
        } catch {}
        q.connection = null;
        if (i < 4) await new Promise((r) => setTimeout(r, 3000));
      }
    }
    const err = new Error("VOICE_CONNECT_TIMEOUT");
    err.cause = lastErr;
    throw err;
  })();

  try {
    const conn = await q.connectingPromise;
    return conn;
  } finally {
    q.connectingPromise = null;
  }
}

async function createResourceFromUrl(url, volume = 1.0, options = {}) {
  const { preferPlayDl = false } = options || {};
  // Canonicalizar URL de YouTube para mayor compatibilidad
  url = canonicalizeYouTubeUrl(url);
  if (!url || typeof url !== "string" || !/^https?:\/\//i.test(url)) {
    throw new Error("INVALID_STREAM_URL");
  }
  const ytCookie = getYouTubeCookieHeaderFromEnv();
  const ytCookiesArr = ytCookie ? parseCookieHeaderToArray(ytCookie) : null;
  const userAgent =
    process.env.YTDL_USER_AGENT ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
  const acceptLang =
    process.env.YTDL_ACCEPT_LANGUAGE || "es-ES,es;q=0.9,en;q=0.8";
  const baseReqOpts = {
    headers: {
      "user-agent": userAgent,
      "accept-language": acceptLang,
      ...(ytCookie ? { cookie: ytCookie } : {}),
    },
  };
  // Para YouTube
  if (isYouTubeUrl(url)) {
    // Resolver ID una sola vez para reutilizar en fallbacks
    const id = extractYouTubeId(url) || url;
    const forcePlayDl = String(process.env.YT_FORCE_PLAYDL || "0") === "1";
    const forceYtDlp = String(process.env.YT_FORCE_YTDLP || "0") === "1";
    // Si se fuerza yt-dlp, usarlo directo
    if (forceYtDlp) {
      const hasBin = !!getYtDlpBinaryPath() || !!ytdlp;
      if (hasBin) {
        if (DEBUG_AUDIO)
          console.log(`[createResource] usando yt-dlp (forzado)`);
        return await createResourceFromYtDlp(url, volume, {
          userAgent,
          acceptLang,
          cookie: ytCookie,
        });
      } else {
        if (DEBUG_AUDIO)
          console.warn(
            `[createResource] YT_FORCE_YTDLP=1 pero no hay yt-dlp instalado; usando play-dl`
          );
        // Intentar play-dl de inmediato y evitar ytdl-core cuando se fuerza yt-dlp
        try {
          const info = await playdl.video_info(url);
          const s = await playdl.stream_from_info(info, {
            discordPlayerCompatibility: true,
          });
          const inputType =
            typeof s.type === "number" ? s.type : StreamType.WebmOpus;
          const resource = createAudioResource(s.stream, {
            inputType,
            inlineVolume: true,
          });
          if (resource.volume)
            resource.volume.setVolumeLogarithmic(
              Math.max(0, Math.min(2, volume))
            );
          return resource;
        } catch (eForceNoBin) {
          if (DEBUG_AUDIO)
            console.warn(
              `[createResource] play-dl falló sin yt-dlp:`,
              eForceNoBin?.message || eForceNoBin
            );
        }
      }
    }
    // Si se solicita o está forzado, intentamos primero con play-dl para evitar 403 de firmas/cookies
    if (!forceYtDlp && (preferPlayDl || forcePlayDl)) {
      try {
        if (DEBUG_AUDIO)
          console.log(`[createResource] usando play-dl (prefer/force)`);
        const info = await playdl.video_info(url);
        const s = await playdl.stream_from_info(info, {
          discordPlayerCompatibility: true,
        });
        const inputType =
          typeof s.type === "number" ? s.type : StreamType.WebmOpus;
        const resource = createAudioResource(s.stream, {
          inputType,
          inlineVolume: true,
        });
        if (resource.volume)
          resource.volume.setVolumeLogarithmic(
            Math.max(0, Math.min(2, volume))
          );
        if (DEBUG_AUDIO)
          console.log("[createResource] using play-dl (prefer/force)");
        return resource;
      } catch (ePlayPrefer) {
        const msg = String(ePlayPrefer?.message || ePlayPrefer || "");
        if (DEBUG_AUDIO)
          console.warn("[createResource:playdl:prefer]", msg, "url:", url);
        // Si el error es 'Invalid URL' o desafío de login/consent, PERMITIR fallback a ytdl aunque esté forzado
        const allowFallback =
          /Invalid URL/i.test(msg) || /Sign in to confirm/i.test(msg);
        if (!allowFallback && forcePlayDl) {
          // Error distinto: respetar el forzado
          throw ePlayPrefer;
        }
        // Si allowFallback o no está forzado, continuamos al branch ytdl
      }
    }
    // En caso contrario, priorizar ytdl-core (a menos que se fuerce yt-dlp)
    try {
      if (DEBUG_AUDIO) console.log(`[createResource] usando ytdl-core getInfo`);
      const info = await ytdl.getInfo(id, buildYtdlRequestOptions(id));
      const fmt = selectWebmOpusFormat(info.formats);
      if (fmt) {
        if (DEBUG_AUDIO) console.log(`[createResource] ytdl formato webm/opus`);
        const stream = ytdl.downloadFromInfo(info, {
          format: fmt,
          highWaterMark: 1 << 25,
          ...buildYtdlRequestOptions(info?.videoDetails?.video_url || id),
        });
        const resource = createAudioResource(stream, {
          inputType: StreamType.WebmOpus,
          inlineVolume: true,
        });
        if (resource.volume)
          resource.volume.setVolumeLogarithmic(
            Math.max(0, Math.min(2, volume))
          );
        return resource;
      }
      // Si no hay WebM/Opus, usar audioonly y dejar que ffmpeg demux/transcode (requiere ffmpeg-static)
      if (DEBUG_AUDIO) console.log(`[createResource] ytdl fallback audioonly`);
      const fallbackStream = ytdl.downloadFromInfo(info, {
        quality: "highestaudio",
        filter: "audioonly",
        highWaterMark: 1 << 25,
        ...buildYtdlRequestOptions(info?.videoDetails?.video_url || id),
      });
      const resource = createAudioResource(fallbackStream, {
        inputType: StreamType.Arbitrary,
        inlineVolume: true,
      });
      if (resource.volume)
        resource.volume.setVolumeLogarithmic(Math.max(0, Math.min(2, volume)));
      return resource;
    } catch (eYtdl) {
      if (DEBUG_AUDIO)
        console.warn(
          "[createResource:ytdl:fallback]",
          eYtdl?.message || eYtdl,
          "url:",
          url
        );
      // Intentar yt-dlp si está disponible o forzado
      try {
        if (ytdlp) {
          const r = await createResourceFromYtDlp(url, volume, {
            userAgent,
            acceptLang,
            cookie: ytCookie,
          });
          return r;
        }
      } catch (eYtdlpA) {
        if (DEBUG_AUDIO)
          console.warn(
            "[createResource:ytdlp:fallback-A]",
            eYtdlpA?.message || eYtdlpA
          );
      }
      // Segundo intento: getBasicInfo y formato directo
      try {
        if (DEBUG_AUDIO) console.log(`[createResource] ytdl getBasicInfo`);
        const basic = await ytdl.getBasicInfo(id, buildYtdlRequestOptions(id));
        const fmt2 =
          selectWebmOpusFormat(basic.formats) ||
          ytdl.chooseFormat(basic.formats, {
            quality: "highestaudio",
            filter: "audioonly",
          });
        if (fmt2) {
          if (DEBUG_AUDIO)
            console.log(`[createResource] ytdl chooseFormat directo`);
          const stream2 = ytdl(id, {
            format: fmt2,
            highWaterMark: 1 << 25,
            ...buildYtdlRequestOptions(id),
          });
          const res2 = createAudioResource(stream2, {
            inputType: /webm/i.test(fmt2.mimeType || fmt2.container)
              ? StreamType.WebmOpus
              : StreamType.Arbitrary,
            inlineVolume: true,
          });
          if (res2.volume)
            res2.volume.setVolumeLogarithmic(Math.max(0, Math.min(2, volume)));
          return res2;
        }
      } catch (eBasic) {
        if (DEBUG_AUDIO)
          console.warn(
            "[createResource:ytdl:basic-fallback]",
            eBasic?.message || eBasic,
            "url:",
            url
          );
      }
      // Fallback a play-dl si ytdl falla
      try {
        if (DEBUG_AUDIO) console.log(`[createResource] fallback play-dl A`);
        const info = await playdl.video_info(url);
        const s = await playdl.stream_from_info(info, {
          discordPlayerCompatibility: true,
        });
        const inputType =
          typeof s.type === "number" ? s.type : StreamType.WebmOpus;
        const resource = createAudioResource(s.stream, {
          inputType,
          inlineVolume: true,
        });
        if (resource.volume)
          resource.volume.setVolumeLogarithmic(
            Math.max(0, Math.min(2, volume))
          );
        return resource;
      } catch (ePlay) {
        if (DEBUG_AUDIO && ePlay?.message !== "Invalid URL")
          console.warn(
            "[createResource:playdl:fallback-A]",
            ePlay?.message || ePlay,
            "url:",
            url
          );
        try {
          if (DEBUG_AUDIO) console.log(`[createResource] fallback play-dl B`);
          const s2 = await playdl.stream(url, {
            discordPlayerCompatibility: true,
          });
          const inputType2 =
            typeof s2.type === "number" ? s2.type : StreamType.WebmOpus;
          const resource2 = createAudioResource(s2.stream, {
            inputType: inputType2,
            inlineVolume: true,
          });
          if (resource2.volume)
            resource2.volume.setVolumeLogarithmic(
              Math.max(0, Math.min(2, volume))
            );
          return resource2;
        } catch (ePlayB) {
          if (DEBUG_AUDIO && ePlayB?.message !== "Invalid URL")
            console.warn(
              "[createResource:playdl:fallback-B]",
              ePlayB?.message || ePlayB,
              "url:",
              url
            );
          // Último intento con yt-dlp
          try {
            if (ytdlp) {
              if (DEBUG_AUDIO)
                console.log(`[createResource] fallback yt-dlp B`);
              const r2 = await createResourceFromYtDlp(url, volume, {
                userAgent,
                acceptLang,
                cookie: ytCookie,
              });
              return r2;
            }
          } catch (eYtdlpB) {
            if (DEBUG_AUDIO)
              console.warn(
                "[createResource:ytdlp:fallback-B]",
                eYtdlpB?.message || eYtdlpB
              );
          }
        }
      }
    }
  } else {
    // No YouTube: usar play-dl primero (Soundcloud, etc.)
    try {
      if (DEBUG_AUDIO) console.log(`[createResource] no-YouTube con play-dl`);
      const info = await playdl.video_info(url);
      const s = await playdl.stream_from_info(info, {
        discordPlayerCompatibility: true,
      });
      const inputType =
        typeof s.type === "number" ? s.type : StreamType.WebmOpus;
      const resource = createAudioResource(s.stream, {
        inputType,
        inlineVolume: true,
      });
      if (resource.volume)
        resource.volume.setVolumeLogarithmic(Math.max(0, Math.min(2, volume)));
      return resource;
    } catch (ePlay) {
      if (DEBUG_AUDIO)
        console.warn(
          "[createResource:playdl:fallback-A]",
          ePlay?.message || ePlay,
          "url:",
          url
        );
      try {
        if (DEBUG_AUDIO)
          console.log(`[createResource] no-YouTube fallback play-dl B`);
        const s2 = await playdl.stream(url, {
          discordPlayerCompatibility: true,
        });
        const inputType2 =
          typeof s2.type === "number" ? s2.type : StreamType.WebmOpus;
        const resource2 = createAudioResource(s2.stream, {
          inputType: inputType2,
          inlineVolume: true,
        });
        if (resource2.volume)
          resource2.volume.setVolumeLogarithmic(
            Math.max(0, Math.min(2, volume))
          );
        return resource2;
      } catch (ePlayB) {
        if (DEBUG_AUDIO)
          console.warn(
            "[createResource:playdl:fallback-B]",
            ePlayB?.message || ePlayB,
            "url:",
            url
          );
      }
    }
  }

  // Si todo falla
  const err = new Error("UNPLAYABLE_URL");
  err.url = url;
  throw err;
}

async function getDirectUrlFromYtDlp(targetUrl, headers = {}) {
  const binPath = getYtDlpBinaryPath();
  const addHeader = [];
  if (headers?.userAgent) addHeader.push(`User-Agent: ${headers.userAgent}`);
  if (headers?.acceptLang)
    addHeader.push(`Accept-Language: ${headers.acceptLang}`);
  // No pasar cookies por header: yt-dlp depreca esto y además YouTube lo bloquea.
  // Usaremos archivo de cookies Netscape vía --cookies si está disponible.
  const cookieFile = ensureYtDlpCookiesFileFromEnv();
  return await new Promise((resolve, reject) => {
    if (binPath) {
      const args = ["-g", "-f", "bestaudio/best", "--no-playlist"];
      if (cookieFile) {
        args.push("--cookies", cookieFile);
      }
      for (const h of addHeader) args.push("--add-header", h);
      args.push(targetUrl);
      const proc = spawn(binPath, args, { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      proc.stdout.on("data", (d) => {
        out += d.toString();
      });
      proc.stderr.on("data", (d) => {
        err += d.toString();
      });
      proc.on("close", (code) => {
        if (code === 0) {
          const lines = out
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean);
          if (lines.length) return resolve(lines[0]);
          return reject(new Error("YTDLP_NO_URL"));
        }
        if (DEBUG_AUDIO && err) console.warn(`[yt-dlp] ${err.trim()}`);
        reject(new Error(`YTDLP_EXIT_${code}`));
      });
      proc.on("error", reject);
  } else if (ytdlp && ytdlp.raw) {
      const proc = ytdlp.raw(targetUrl, {
        g: true,
        format: "bestaudio/best",
        noPlaylist: true,
    addHeader,
    // Si existe archivo de cookies, pasarlo también aquí
    ...(cookieFile ? { cookies: cookieFile } : {}),
      });
      let out = "";
      let err = "";
      proc.stdout.on("data", (d) => {
        out += d.toString();
      });
      proc.stderr.on("data", (d) => {
        err += d.toString();
      });
      proc.on("close", (code) => {
        if (code === 0) {
          const lines = out
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean);
          if (lines.length) return resolve(lines[0]);
          return reject(new Error("YTDLP_NO_URL"));
        }
        if (DEBUG_AUDIO && err) console.warn(`[yt-dlp] ${err.trim()}`);
        reject(new Error(`YTDLP_EXIT_${code}`));
      });
      proc.on("error", reject);
    } else {
      reject(new Error("YTDLP_NOT_AVAILABLE"));
    }
  });
}

async function createResourceFromYtDlp(url, volume = 1.0, headers = {}) {
  if (DEBUG_AUDIO) console.log(`[yt-dlp] invocando yt-dlp para ${url}`);
  const binPath = getYtDlpBinaryPath();
  if (!binPath && !(ytdlp && ytdlp.raw)) throw new Error("YTDLP_NOT_AVAILABLE");

  const ffmpegPath = process.env.FFMPEG_PATH || require("ffmpeg-static");
  if (!ffmpegPath) throw new Error("FFMPEG_REQUIRED");

  // Opción: intentar obtener directamente un stream opus del origen (sin re-encode)
  const preferDirectOpus = String(process.env.YT_DLP_DIRECT_OPUS || "0") === "1";
  if (preferDirectOpus) {
    try {
      const f = "bestaudio[acodec=opus]"; // intentaremos obtener el mejor audio en opus (webm normalmente)
      const cookieFile = ensureYtDlpCookiesFileFromEnv();
      const commonArgs = ["--no-playlist", "-f", f, "-o", "-"];
      if (headers?.userAgent) commonArgs.push("--user-agent", headers.userAgent);
      if (headers?.acceptLang) commonArgs.push("--add-header", `Accept-Language: ${headers.acceptLang}`);
      if (String(process.env.YT_FORCE_IPV4 || "0") === "1") commonArgs.push("--force-ipv4");
      if (cookieFile) commonArgs.push("--cookies", cookieFile);

      const yProc = binPath
        ? spawn(binPath, [...commonArgs, url], { stdio: ["ignore", "pipe", "pipe"] })
        : ytdlp.raw(url, {
            noPlaylist: true,
            f,
            o: "-",
            ...(headers?.userAgent ? { userAgent: headers.userAgent } : {}),
            ...(headers?.acceptLang ? { addHeader: [`Accept-Language: ${headers.acceptLang}`] } : {}),
            ...(cookieFile ? { cookies: cookieFile } : {}),
            ...(String(process.env.YT_FORCE_IPV4 || "0") === "1" ? { forceIpv4: true } : {}),
          });

      if (DEBUG_AUDIO) {
        yProc.stderr?.on("data", (d) => console.warn(`[yt-dlp] ${String(d).trim()}`));
      }
      // Entregamos directamente WebM Opus
      const out = yProc.stdout;
      const ignoreErr = (label) => (err) => {
        if (!err) return;
        const code = err?.code || "";
        if (code === "EPIPE" || code === "ECONNRESET") {
          if (DEBUG_AUDIO) console.warn(`[${label}] ${code} (ignorada)`);
          return;
        }
        console.warn(`[${label}]`, err?.message || err);
      };
      yProc.on?.("error", ignoreErr("yt-dlp:proc"));
      yProc.stdout?.on("error", ignoreErr("yt-dlp:stdout"));
      yProc.stdin?.on?.("error", ignoreErr("yt-dlp:stdin"));

      const cleanup = () => {
        try { yProc.kill?.("SIGKILL"); } catch {}
      };
      out.on("close", cleanup);
      out.on("end", cleanup);
      out.on("error", ignoreErr("yt-dlp:out"));

      const resource = createAudioResource(out, { inputType: StreamType.WebmOpus, inlineVolume: true });
      if (resource.volume)
        resource.volume.setVolumeLogarithmic(Math.max(0, Math.min(2, volume)));
      return resource;
    } catch (e) {
      if (DEBUG_AUDIO) console.warn("[yt-dlp] direct opus falló, reintento con ffmpeg:", e?.message || e);
      // caemos al camino de ffmpeg más abajo
    }
  }

  // Preparar encabezados y cookie para yt-dlp (no para ffmpeg)
  const args = ["--no-playlist", "-f", "bestaudio/best", "-o", "-"];
  // Opcionales para mitigar captcha en YouTube
  const extractorArgsEnv = (process.env.YT_YTDLP_EXTRACTOR_ARGS || "").trim();
  const ytClient = (process.env.YT_YTDLP_CLIENT || "").trim().toLowerCase(); // p.ej.: android | tvhtml5 | web | ios | mweb
  const strictClient = String(process.env.YT_YTDLP_STRICT_CLIENT || "0") === "1";
  const forceIpv4 = String(process.env.YT_FORCE_IPV4 || "0") === "1";

  if (headers?.userAgent) {
    args.push("--user-agent", headers.userAgent);
  }
  if (headers?.acceptLang) {
    args.push("--add-header", `Accept-Language: ${headers.acceptLang}`);
  }
  if (forceIpv4) {
    args.push("--force-ipv4");
    if (DEBUG_AUDIO) console.log(`[yt-dlp] forzando IPv4`);
  }
  const cookieFile = ensureYtDlpCookiesFileFromEnv();
  if (cookieFile) {
    args.push("--cookies", cookieFile);
  }
  // Elegir extractor-args (player_client) según cookies y configuración
  let effectiveClient = ytClient;
  if (!extractorArgsEnv) {
    if (!effectiveClient) {
      effectiveClient = cookieFile ? "web" : "android";
    }
    if (cookieFile && effectiveClient === "android" && !strictClient) {
      effectiveClient = "web";
      if (DEBUG_AUDIO)
        console.log(
          `[yt-dlp] cambiando player_client=android -> web (cookies presentes)`
        );
    }
    if (effectiveClient) {
      args.push("--extractor-args", `youtube:player_client=${effectiveClient}`);
      if (DEBUG_AUDIO)
        console.log(`[yt-dlp] usando player_client=${effectiveClient}`);
    }
  } else {
    args.push("--extractor-args", extractorArgsEnv);
    if (DEBUG_AUDIO) console.log(`[yt-dlp] extractor-args (env): ${extractorArgsEnv}`);
  }
  args.push(url);

  // Lanzar yt-dlp (binario o wrapper)
  const yProc = binPath
    ? spawn(binPath, args, { stdio: ["ignore", "pipe", "pipe"] })
    : ytdlp.raw(args[args.length - 1], {
        o: "-",
        f: "bestaudio/best",
        noPlaylist: true,
        ...(headers?.userAgent ? { userAgent: headers.userAgent } : {}),
        ...(headers?.acceptLang
          ? { addHeader: [`Accept-Language: ${headers.acceptLang}`] }
          : {}),
        ...(cookieFile ? { cookies: cookieFile } : {}),
        ...(() => {
          if (extractorArgsEnv) return { extractorArgs: extractorArgsEnv };
          const clientForWrapper = (() => {
            if (!effectiveClient) return null;
            return `youtube:player_client=${effectiveClient}`;
          })();
          return clientForWrapper ? { extractorArgs: clientForWrapper } : {};
        })(),
        ...(forceIpv4 ? { forceIpv4: true } : {}),
      });

  // ffmpeg para transcodificar a ogg/opus por pipe
  const opusTargetKbps = Math.max(64, Math.min(256, Number(process.env.OPUS_BITRATE || 160)));
  const ffArgs = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-nostdin",
    "-i",
    "pipe:0",
    "-vn",
    "-sn",
    "-dn",
    "-ac",
    "2",
    "-ar",
    "48000",
    "-c:a",
    "libopus",
    "-b:a",
    `${opusTargetKbps}k`,
    // Mejorar calidad: VBR activado y nivel de compresión alto
    "-vbr",
    "on",
    "-compression_level",
    "10",
    "-application",
    "audio",
    // 20ms es estándar; 60ms ahorra ancho de banda pero no mejora calidad
    "-frame_duration",
    "20",
    "-f",
    "ogg",
    "pipe:1",
  ];
  const ff = spawn(ffmpegPath, ffArgs, { stdio: ["pipe", "pipe", "pipe"] });

  // Encadenar salida de yt-dlp a ffmpeg
  yProc.stdout?.pipe(ff.stdin);
  if (DEBUG_AUDIO) {
    yProc.stderr?.on("data", (d) => console.warn(`[yt-dlp] ${String(d).trim()}`));
    ff.stderr?.on("data", (d) => console.warn(`[ffmpeg] ${String(d).trim()}`));
  }

  // Manejo de errores de streams para evitar EPIPE/ECONNRESET no capturados
  const ignoreErr = (label) => (err) => {
    if (!err) return;
    const code = err?.code || "";
    if (code === "EPIPE" || code === "ECONNRESET") {
      if (DEBUG_AUDIO) console.warn(`[${label}] ${code} (ignorada)`);
      return; // suprimir
    }
    console.warn(`[${label}]`, err?.message || err);
  };
  yProc.on?.("error", ignoreErr("yt-dlp:proc"));
  yProc.stdout?.on("error", ignoreErr("yt-dlp:stdout"));
  yProc.stdin?.on?.("error", ignoreErr("yt-dlp:stdin"));
  ff.on("error", ignoreErr("ffmpeg:proc"));
  ff.stdout.on("error", ignoreErr("ffmpeg:stdout"));
  ff.stdin.on("error", ignoreErr("ffmpeg:stdin"));

  // Crear recurso
  const out = ff.stdout;
  const cleanup = () => {
    try {
      ff.kill("SIGKILL");
    } catch {}
    try {
      yProc.kill?.("SIGKILL");
    } catch {}
  };
  out.on("close", cleanup);
  out.on("end", cleanup);
  out.on("error", ignoreErr("ffmpeg:out"));
  const resource = createAudioResource(out, {
    inputType: StreamType.OggOpus,
    inlineVolume: true,
  });
  // Asegurar limpieza si el recurso deja de usarse aguas arriba
  try {
    resource.playStream?.once?.("close", cleanup);
    resource.playStream?.on?.("error", ignoreErr("resource:playStream"));
  } catch {}
  if (resource.volume)
    resource.volume.setVolumeLogarithmic(Math.max(0, Math.min(2, volume)));
  return resource;
}

function getYtDlpBinaryPath() {
  // 1) Variable de entorno explícita
  if (process.env.YT_DLP_PATH && fs.existsSync(process.env.YT_DLP_PATH)) {
    return process.env.YT_DLP_PATH;
  }
  // 2) Buscar en PATH con where/which
  try {
    if (process.platform === "win32") {
      const r = spawnSync("where", ["yt-dlp.exe"], { encoding: "utf8" });
      if (r.status === 0) {
        const line = String(r.stdout || "")
          .split(/\r?\n/)
          .find(Boolean);
        if (line && fs.existsSync(line.trim())) return line.trim();
      }
      const r2 = spawnSync("where", ["yt-dlp"], { encoding: "utf8" });
      if (r2.status === 0) {
        const line = String(r2.stdout || "")
          .split(/\r?\n/)
          .find(Boolean);
        if (line && fs.existsSync(line.trim())) return line.trim();
      }
    } else {
      const r = spawnSync("which", ["yt-dlp"], { encoding: "utf8" });
      if (r.status === 0) {
        const line = String(r.stdout || "")
          .split(/\r?\n/)
          .find(Boolean);
        if (line && fs.existsSync(line.trim())) return line.trim();
      }
    }
  } catch {}
  // 3) Rutas comunes en Windows
  if (process.platform === "win32") {
    const guesses = [
      "C:/Windows/yt-dlp.exe",
      "C:/Program Files/yt-dlp/yt-dlp.exe",
      "C:/Program Files (x86)/yt-dlp/yt-dlp.exe",
    ];
    for (const p of guesses) {
      try {
        if (fs.existsSync(p)) return p;
      } catch {}
    }
  }
  return null;
}

// Convierte "a=b; c=d" en [{name:'a',value:'b'}, {name:'c',value:'d'}]
function parseCookieHeaderToArray(header) {
  try {
    return String(header)
      .split(";")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((kv) => {
        const idx = kv.indexOf("=");
        if (idx === -1) return null;
        const name = kv.slice(0, idx).trim();
        const value = kv.slice(idx + 1).trim();
        if (!name) return null;
        return { name, value };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Crea (si no existe) un archivo temporal de cookies en formato Netscape
// a partir de la variable de entorno YT_COOKIE/YOUTUBE_COOKIE.
// Devuelve la ruta al archivo o null si no hay cookie.
function ensureYtDlpCookiesFileFromEnv() {
  try {
    // Prioridad: YT_COOKIE_B64 > YT_COOKIE_FILE > YT_COOKIE/YOUTUBE_COOKIE
    let raw = null;
    if (process.env.YT_COOKIE_B64) {
      try {
        raw = Buffer.from(String(process.env.YT_COOKIE_B64).trim(), "base64").toString("utf8");
        if (DEBUG_AUDIO) console.log("[yt-dlp] usando YT_COOKIE_B64 (decodificada)");
      } catch (e) {
        if (DEBUG_AUDIO) console.warn("[yt-dlp] YT_COOKIE_B64 inválida:", e?.message || e);
      }
    }
    if (!raw && process.env.YT_COOKIE_FILE) {
      const p = String(process.env.YT_COOKIE_FILE).trim();
      try {
        if (p && fs.existsSync(p)) {
          raw = fs.readFileSync(p, "utf8");
          if (DEBUG_AUDIO) console.log(`[yt-dlp] usando YT_COOKIE_FILE: ${p}`);
        }
      } catch (e) {
        if (DEBUG_AUDIO) console.warn("[yt-dlp] No se pudo leer YT_COOKIE_FILE:", e?.message || e);
      }
    }
    if (!raw) raw = process.env.YT_COOKIE || process.env.YOUTUBE_COOKIE;
    if (!raw) return null;
    const tmpPath = path.join(os.tmpdir(), `yt_cookies_${process.pid}.txt`);

  let content = String(raw);
    // Si parece ya ser Netscape (tiene tabs o cabecera), lo usamos tal cual
    const looksNetscape = content.includes("\t") || /Netscape HTTP Cookie File/i.test(content);
    if (!looksNetscape) {
      // Convertimos desde header "a=b; c=d" al formato Netscape para dominios de YouTube
      const pairs = parseCookieHeaderToArray(content);
      const expires = Math.floor(Date.now() / 1000) + 3600 * 24 * 365; // +1 año
      const domains = [
        ".youtube.com",
        ".youtube-nocookie.com",
        ".google.com",
        ".googlevideo.com",
      ];
      const lines = [
        "# Netscape HTTP Cookie File",
        "# This file was generated automatically by the bot.",
      ];
      for (const { name, value } of pairs) {
        for (const domain of domains) {
          // Campos: domain, includeSubdomains, path, secure, expiration, name, value
          lines.push([
            domain,
            "TRUE",
            "/",
            // Marcar como Secure por defecto para mayor compatibilidad
            "TRUE",
            String(expires),
            name,
            value,
          ].join("\t"));
        }
      }
      content = lines.join("\n") + "\n";
    }
    // Validación básica (no imprime valores): ¿faltan cookies críticas?
    if (DEBUG_AUDIO) {
      try {
        const needByDomain = {
          ".google.com": [
            "SID",
            "HSID",
            "SSID",
            "SAPISID",
            "__Secure-1PSID",
            "__Secure-3PSID",
          ],
          ".youtube.com": [
            "VISITOR_INFO1_LIVE",
            "PREF",
          ],
        };
        const have = new Map(); // domain -> Set(names)
        for (const line of content.split(/\r?\n/)) {
          if (!line || line.startsWith("#")) continue;
          const parts = line.split("\t");
          if (parts.length < 7) continue;
          const domain = parts[0]?.trim();
          const name = parts[5]?.trim();
          if (!domain || !name) continue;
          if (!have.has(domain)) have.set(domain, new Set());
          have.get(domain).add(name);
        }
        const warns = [];
        for (const [dom, names] of Object.entries(needByDomain)) {
          const got = have.get(dom) || new Set();
          const missing = names.filter((n) => !got.has(n));
          if (missing.length) warns.push(`${dom}: ${missing.join(", ")}`);
        }
        if (warns.length) {
          console.warn(
            `[yt-dlp] Aviso: cookies Netscape parecen incompletas. Faltan claves críticas -> ${warns.join(" | ")}`
          );
        }
      } catch {}
    }
  // Reescribir siempre para evitar cookies obsoletas si cambió el env
  fs.writeFileSync(tmpPath, content, { encoding: "utf8" });
    if (DEBUG_AUDIO) console.log(`[yt-dlp] archivo de cookies creado: ${tmpPath}`);
    return tmpPath;
  } catch (e) {
    if (DEBUG_AUDIO) console.warn("[yt-dlp] No se pudo crear archivo de cookies:", e?.message || e);
    return null;
  }
}

async function resolvePlayableUrl(input) {
  let url = input.replace(/^<(.+)>$/, "$1").trim();
  if (/^https?:\/\//i.test(url)) {
    if (isYouTubeUrl(url)) {
      return canonicalizeYouTubeUrl(url);
    }
    return url;
  }
  try {
    const results = await playdl.search(url, {
      limit: 1,
      source: { youtube: "video" },
    });
    const first = results?.[0];
    if (first?.url) return canonicalizeYouTubeUrl(first.url);
  } catch {}
  return null;
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
  if (isYouTubeUrl(normalized)) {
    try {
      const id = extractYouTubeId(normalized) || normalized;
      const info = await ytdl.getBasicInfo(id);
      const title = info?.videoDetails?.title || normalized;
      const dur = Number(info?.videoDetails?.lengthSeconds || 0) || 0;
      const thumb =
        (info?.videoDetails?.thumbnails || [])[0]?.url ||
        deriveYouTubeThumb(normalized);
      return {
        title,
        durationSec: dur > 0 ? Math.floor(dur) : 0,
        thumbnailUrl: thumb,
      };
    } catch {}
  }
  try {
    const info = await playdl.video_info(normalized);
    const title = info?.video_details?.title || normalized;
    const dur =
      Number(
        info?.video_details?.durationInSec ||
          info?.video_details?.durationInMs / 1000 ||
          0
      ) || 0;
    const thumb =
      info?.video_details?.thumbnails?.[0]?.url ||
      deriveYouTubeThumb(normalized);
    return {
      title,
      durationSec: dur > 0 ? Math.floor(dur) : 0,
      thumbnailUrl: thumb,
    };
  } catch {}
  return {
    title: normalized,
    durationSec: 0,
    thumbnailUrl: deriveYouTubeThumb(normalized),
  };
}

function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function buildProgressBar(totalSec, elapsedSec, size = 20) {
  totalSec = Math.max(1, Number(totalSec) || 1);
  elapsedSec = Math.max(0, Math.min(totalSec, Number(elapsedSec) || 0));
  const ratio = elapsedSec / totalSec;
  const filled = Math.max(0, Math.min(size, Math.round(ratio * size)));
  const pos = Math.max(0, Math.min(size - 1, Math.round(ratio * (size - 1))));
  const left = "█".repeat(pos);
  const right = "─".repeat(Math.max(0, size - pos - 1));
  const bar = `┃${left}🔘${right}┃`;
  return `${formatDuration(elapsedSec)} ${bar} ${formatDuration(totalSec)}`;
}

// Render de cola (queue) para reuso en respuestas
function formatQueueMessage(q, limit = 10) {
  if (!q || !Array.isArray(q.songs) || q.songs.length === 0)
    return "La cola está vacía.";
  const elapsed = Math.floor(
    (q.player?.state?.resource?.playbackDuration || 0) / 1000
  );
  const lines = q.songs.slice(0, limit).map((s, i) => {
    const dur = s.durationSec ? ` [${formatDuration(s.durationSec)}]` : "";
    if (i === 0) {
      const left = s.durationSec
        ? ` (${formatDuration(elapsed)} / ${formatDuration(s.durationSec)})`
        : "";
      return `▶️ ${s.title}${dur}${left}`;
    }
    return `${i + 1}. ${s.title}${dur}`;
  });
  if (q.songs.length > limit) lines.push(`... y ${q.songs.length - limit} más`);
  return lines.join("\n");
}

function canonicalizeYouTubeUrl(input) {
  try {
    const u = new URL(input);
    // youtu.be short links -> watch?v=
    if (/^youtu\.be$/i.test(u.hostname)) {
      const id = u.pathname.replace(/^\//, "").split(/[/?&]/)[0];
      return id ? `https://www.youtube.com/watch?v=${id}` : input;
    }
    // youtube shorts -> watch?v=
    if (
      /youtube\.com$/i.test(u.hostname) &&
      u.pathname.startsWith("/shorts/")
    ) {
      const id = u.pathname.split("/")[2];
      return id ? `https://www.youtube.com/watch?v=${id}` : input;
    }
    // youtube.com with v param -> normalize to watch?v=
    if (/youtube\.com$/i.test(u.hostname)) {
      const v = u.searchParams.get("v");
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
    return (
      /(^|\.)youtube\.com$/i.test(u.hostname) ||
      /^youtu\.be$/i.test(u.hostname) ||
      /(^|\.)music\.youtube\.com$/i.test(u.hostname)
    );
  } catch {
    return false;
  }
}

function extractYouTubeId(input) {
  try {
    const u = new URL(input);
    if (/^youtu\.be$/i.test(u.hostname)) {
      const id = u.pathname.replace(/^\//, "").split(/[/?&]/)[0];
      return id || null;
    }
    if (/youtube\.com$/i.test(u.hostname)) {
      if (u.pathname.startsWith("/shorts/")) {
        const id = u.pathname.split("/")[2];
        return id || null;
      }
      const v = u.searchParams.get("v");
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

function selectWebmOpusFormat(formats, preference = "highest") {
  if (!Array.isArray(formats)) return null;
  const candidates = formats.filter((f) => {
    const a = (f.audioCodec || f.codecs || f.codec || "").toString();
    const container = (f.container || "").toString();
    const mime = (f.mimeType || "").toString();
    const isWebm = /webm/i.test(container) || /webm/i.test(mime);
    const isOpus = /opus/i.test(a) || /opus/i.test(mime);
    const hasAudio = f.hasAudio !== false || /audio\//i.test(mime);
    return hasAudio && isWebm && isOpus && f.url;
  });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (a.audioBitrate || 0) - (b.audioBitrate || 0));
  return preference === "lowest"
    ? candidates[0]
    : candidates[candidates.length - 1];
}

// Construye opciones (cookies y headers) para llamadas de ytdl/miniget
function buildYtdlRequestOptions(videoIdOrUrl) {
  const ytCookie = process.env.YT_COOKIE || process.env.YOUTUBE_COOKIE;
  const userAgent =
    process.env.YTDL_USER_AGENT ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
  const acceptLang =
    process.env.YTDL_ACCEPT_LANGUAGE || "es-ES,es;q=0.9,en;q=0.8";
  let referer;
  try {
    if (videoIdOrUrl) {
      if (/^https?:\/\//i.test(String(videoIdOrUrl))) {
        const url = canonicalizeYouTubeUrl(String(videoIdOrUrl));
        if (isYouTubeUrl(url)) referer = url;
      } else if (/^[a-zA-Z0-9_-]{6,}$/.test(String(videoIdOrUrl))) {
        referer = `https://www.youtube.com/watch?v=${videoIdOrUrl}`;
      }
    }
  } catch {}
  const headers = {
    "user-agent": userAgent,
    "accept-language": acceptLang,
  };
  // Si no podemos construir el formato nuevo, dejamos el viejo en headers
  const cookiesArray = ytCookie ? parseCookieHeaderToArray(ytCookie) : null;
  if (!cookiesArray || cookiesArray.length === 0) {
    if (ytCookie) headers.cookie = ytCookie;
  }
  if (referer) headers.referer = referer;
  // Construir opciones en nuevo formato si hay cookies
  const opts = { requestOptions: { headers } };
  if (cookiesArray && cookiesArray.length) {
    opts.requestOptions.cookies = cookiesArray;
  }
  return opts;
}

// Crear recurso directamente desde info de ytdl (evita pedir info de nuevo)
function createResourceFromYtdlInfo(info, volume = 1.0) {
  try {
    const fmt = selectWebmOpusFormat(info.formats, "highest");
    if (fmt) {
      const vidRef =
        info?.videoDetails?.video_url ||
        (info?.videoDetails?.videoId
          ? `https://www.youtube.com/watch?v=${info.videoDetails.videoId}`
          : undefined);
      const ytdlOpts = {
        format: fmt,
        highWaterMark: 1 << 25,
        ...buildYtdlRequestOptions(vidRef),
      };
      const stream = ytdl.downloadFromInfo(info, ytdlOpts);
      const resource = createAudioResource(stream, {
        inputType: StreamType.WebmOpus,
        inlineVolume: true,
      });
      if (resource.volume)
        resource.volume.setVolumeLogarithmic(Math.max(0, Math.min(2, volume)));
      return resource;
    }
    const vidRef =
      info?.videoDetails?.video_url ||
      (info?.videoDetails?.videoId
        ? `https://www.youtube.com/watch?v=${info.videoDetails.videoId}`
        : undefined);
    const fallbackStream = ytdl.downloadFromInfo(info, {
      quality: "highestaudio",
      filter: "audioonly",
      highWaterMark: 1 << 25,
      ...buildYtdlRequestOptions(vidRef),
    });
    const resource = createAudioResource(fallbackStream, {
      inputType: StreamType.Arbitrary,
      inlineVolume: true,
    });
    if (resource.volume)
      resource.volume.setVolumeLogarithmic(Math.max(0, Math.min(2, volume)));
    return resource;
  } catch (e) {
    return null;
  }
}

function createFastStartResourceFromYtdlInfo(info, volume = 1.0) {
  try {
    const fmt = selectWebmOpusFormat(info.formats, "lowest");
    if (!fmt) return null;
    const vidRef =
      info?.videoDetails?.video_url ||
      (info?.videoDetails?.videoId
        ? `https://www.youtube.com/watch?v=${info.videoDetails.videoId}`
        : undefined);
    const stream = ytdl.downloadFromInfo(info, {
      format: fmt,
      highWaterMark: 1 << 22,
      dlChunkSize: 1 << 20,
      ...buildYtdlRequestOptions(vidRef),
    });
    const resource = createAudioResource(stream, {
      inputType: StreamType.WebmOpus,
      inlineVolume: true,
    });
    if (resource.volume)
      resource.volume.setVolumeLogarithmic(Math.max(0, Math.min(2, volume)));
    return resource;
  } catch {
    return null;
  }
}

async function playNext(guildId) {
  const q = queues.get(guildId);
  if (!q || q.songs.length === 0) return;
  const current = q.songs[0];
  try {
    // cancelar cualquier upgrade pendiente de pista anterior
    if (q.upgradeTimer) {
      try {
        clearTimeout(q.upgradeTimer);
      } catch {}
      q.upgradeTimer = null;
    }

    let resource = null;
    const fastStartEnabled = String(process.env.FAST_START || "1") === "1";
    const fastDelayMs = Math.max(
      500,
      Math.min(8000, Number(process.env.FAST_START_MS || 2000))
    );
    const longEnough = (current.durationSec || 0) >= 60;
  const forceYtDlp = String(process.env.YT_FORCE_YTDLP || "0") === "1";

  if (!forceYtDlp && current.ytdlInfo && fastStartEnabled && longEnough) {
      resource =
        createFastStartResourceFromYtdlInfo(
          current.ytdlInfo,
          q.volume ?? 1.0
        ) || createResourceFromYtdlInfo(current.ytdlInfo, q.volume ?? 1.0);
  } else if (!forceYtDlp && current.ytdlInfo) {
      resource = createResourceFromYtdlInfo(current.ytdlInfo, q.volume ?? 1.0);
    }
    if (!resource) {
      resource = await createResourceFromUrl(current.url, q.volume ?? 1.0);
    }

    q.player.play(resource);

    // Programar upgrade a mayor calidad si aplica
    if (current.ytdlInfo && fastStartEnabled && longEnough) {
      const token = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
      q.currentTrackToken = token;
      q.upgradeTimer = setTimeout(async () => {
        try {
          if (!queues.has(guildId)) return;
          const qq = queues.get(guildId);
          if (!qq || qq.currentTrackToken !== token) return;
          if (qq.player?.state?.status !== AudioPlayerStatus.Playing) return;
          const bestRes = createResourceFromYtdlInfo(
            current.ytdlInfo,
            qq.volume ?? 1.0
          );
          if (!bestRes) return;
          qq.player.play(bestRes);
          if (DEBUG_AUDIO) console.log("[fast-start] upgraded to high quality");
        } catch {}
      }, fastDelayMs);
    }

    // Evitar duplicados: sólo actualizar si ya existe un panel asignado
    if (q.nowPlayingMessageId) {
      try {
        await renderNowPlaying(guildId);
      } catch (e) {
        if (DEBUG_AUDIO)
          console.warn("[renderNowPlaying:error]", e?.message || e);
      }
      try {
        startNowPlayingTicker(guildId);
      } catch {}
    }
  } catch (e) {
    console.error("[playNext:error]", e?.message || e, "url:", current?.url);
    // Fallback: forzar play-dl para esta URL
    try {
      const fallbackRes = await createResourceFromUrl(
        current.url,
        q.volume ?? 1.0,
        { preferPlayDl: true }
      );
      q.player.play(fallbackRes);
      if (q.nowPlayingMessageId) {
        try {
          await renderNowPlaying(guildId);
        } catch {}
        try {
          startNowPlayingTicker(guildId);
        } catch {}
      }
      return;
    } catch (e2) {
      if (DEBUG_AUDIO)
        console.warn("[playNext:fallback-playdl:failed]", e2?.message || e2);
    }
    // Notificar y saltar esta pista
    try {
      if (q.textChannelId) {
        const ch = await client.channels
          .fetch(q.textChannelId)
          .catch(() => null);
        if (ch?.isTextBased?.()) {
          await ch
            .send(
              `⚠️ No se pudo reproducir: ${
                current?.title || current?.url || "pista"
              } — siguiente canción...`
            )
            .catch(() => {});
        }
      }
    } catch {}
    q.songs.shift();
    if (q.songs.length > 0) {
      playNext(guildId).catch((err) =>
        console.error("[playNext:chain:error]", err)
      );
    } else {
      const conn = getVoiceConnection(guildId);
      conn?.destroy();
      queues.delete(guildId);
      clearNowPlaying(guildId).catch(() => {});
      try {
        stopNowPlayingTicker(guildId);
      } catch {}
    }
  }
}

function startNowPlayingTicker(guildId) {
  const q = queues.get(guildId);
  if (!q) return;
  if (q.uiInterval) {
    try {
      clearInterval(q.uiInterval);
    } catch {}
  }
  q.uiInterval = setInterval(() => {
    const qq = queues.get(guildId);
    if (!qq) return stopNowPlayingTicker(guildId);
    if (!qq.nowPlayingMessageId || qq.songs.length === 0) return;
    // Solo refrescar cuando realmente está reproduciendo
    if (qq.player?.state?.status !== AudioPlayerStatus.Playing) return;
    renderNowPlaying(guildId).catch(() => {});
  }, 1_000);
}

function stopNowPlayingTicker(guildId) {
  const q = queues.get(guildId);
  if (!q || !q.uiInterval) return;
  try {
    clearInterval(q.uiInterval);
  } catch {}
  q.uiInterval = null;
}

// ===== UI: Now Playing Embed + Botones =====
function buildControlsComponents(q) {
  const isPaused = q.player.state.status === AudioPlayerStatus.Paused;
  const s = q.songs?.[0];
  const vol = Math.max(0, Math.min(2, q.volume ?? 1));
  const volDownDisabled = vol <= 0.01;
  const volUpDisabled = vol >= 1.99;
  const canShuffle = (q.songs?.length || 0) > 2;
  const hasSong = !!s;
  // Fila 1: transporte y loop
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("music_replay")
  .setEmoji("🔄")
      .setLabel("Reiniciar")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasSong),
    new ButtonBuilder()
      .setCustomId(isPaused ? "music_resume" : "music_pause")
  .setEmoji(isPaused ? "▶️" : "⏸️")
      .setLabel(isPaused ? "Reanudar" : "Pausar")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!hasSong),
    new ButtonBuilder()
      .setCustomId("music_skip")
  .setEmoji("⏭️")
      .setLabel("Siguiente")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasSong),
    new ButtonBuilder()
      .setCustomId("music_stop")
  .setEmoji("🛑")
      .setLabel("Detener")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("music_loop")
      .setEmoji("🔁")
      .setLabel("Bucle")
      .setStyle(q.loop ? ButtonStyle.Success : ButtonStyle.Secondary)
  );
  // Fila 2: volumen, shuffle, guardar y enlace
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("music_vol_down")
      .setEmoji("🔉")
      .setLabel("Vol -")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(volDownDisabled),
    new ButtonBuilder()
      .setCustomId("music_vol_up")
      .setEmoji("🔊")
      .setLabel("Vol +")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(volUpDisabled),
    new ButtonBuilder()
      .setCustomId("music_shuffle")
      .setEmoji("🔀")
  .setLabel("Aleatorio")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!canShuffle),
    new ButtonBuilder()
      .setCustomId("music_save")
      .setEmoji("⭐")
      .setLabel("Guardar")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasSong)
  );
  // Fila 3: mostrar cola y link al tema actual (si existe)
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("music_queue")
      .setEmoji("🧾")
      .setLabel("Cola")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!(q.songs?.length > 0))
  );
  if (s?.url) {
    row3.addComponents(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setURL(s.url)
        .setEmoji("🌐")
        .setLabel("Abrir")
    );
  }
  return [row1, row2, row3];
}

function buildNowPlayingEmbed(q, guild) {
  const s = q.songs?.[0];
  const elapsed = Math.floor(
    (q.player?.state?.resource?.playbackDuration || 0) / 1000
  );
  const total = s?.durationSec || 0;
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(
      q.player?.state?.status === AudioPlayerStatus.Paused
        ? "⏸️ Pausado"
        : "🎶 Reproduciendo ahora"
    )
    .addFields(
      {
        name: "Canción:",
        value: s ? `[${s.title}](${s.url})` : "—",
        inline: false,
      },
      {
        name: "Agregado por:",
        value: s?.requestedById
          ? `<@${s.requestedById}>`
          : guild?.members?.me?.toString() || "—",
        inline: true,
      },
      {
        name: "Duración:",
        value: total ? formatDuration(total) : "—",
        inline: true,
      }
    )
    .setFooter({
      text: `Controles debajo · Volumen: ${Math.round(
        (q.volume ?? 1) * 100
      )}% · Repetir: ${q.loop ? "ON" : "OFF"}`,
    });
  if (total) {
    embed.setDescription(buildProgressBar(total, elapsed));
  }
  if (s?.thumbnailUrl) embed.setThumbnail(s.thumbnailUrl);
  return embed;
}

async function renderNowPlaying(guildId) {
  const q = queues.get(guildId);
  if (!q || !q.textChannelId) return;
  const channel = await client.channels
    .fetch(q.textChannelId)
    .catch(() => null);
  if (!channel || !channel.isTextBased?.()) return;
  const canEmbed = !!channel
    .permissionsFor?.(channel.guild?.members?.me)
    ?.has(PermissionsBitField.Flags.EmbedLinks);
  const embed = canEmbed ? buildNowPlayingEmbed(q, channel.guild) : null;
  const components = buildControlsComponents(q);
  const contentFallback = (() => {
    const s = q.songs?.[0];
    if (!s) return "—";
    const elapsed = Math.floor(
      (q.player?.state?.resource?.playbackDuration || 0) / 1000
    );
    const total = s?.durationSec || 0;
    const line = total ? `${buildProgressBar(total, elapsed)}\n` : "";
    return `🎶 Now Playing\n${line}• ${s.title}${
      total ? ` [${formatDuration(total)}]` : ""
    }`;
  })();
  if (q.nowPlayingMessageId) {
    try {
      const msg = await channel.messages.fetch(q.nowPlayingMessageId);
      await msg.edit(
        canEmbed
          ? { content: "", embeds: [embed], components }
          : { content: contentFallback, components }
      );
      return msg;
    } catch (_) {
      q.nowPlayingMessageId = null;
    }
  }
  const sent = await channel.send(
    canEmbed
      ? { embeds: [embed], components }
      : { content: contentFallback, components }
  );
  q.nowPlayingMessageId = sent.id;
  return sent;
}

// Garantiza que exista un único panel por servidor; si no existe, lo crea en el canal dado
async function ensurePanel(guildId, channelId) {
  const q = getQueue(guildId);
  // Si no hay canal configurado, usar el provisto
  if (!q.textChannelId) q.textChannelId = channelId;
  // Si no hay panel, crearlo en el canal indicado
  if (!q.nowPlayingMessageId) {
    q.textChannelId = channelId;
    try {
      await renderNowPlaying(guildId);
    } catch {}
  }
}

async function clearNowPlaying(guildId) {
  const q = queues.get(guildId);
  if (!q || !q.textChannelId || !q.nowPlayingMessageId) return;
  const channel = await client.channels
    .fetch(q.textChannelId)
    .catch(() => null);
  if (!channel || !channel.isTextBased?.()) return;
  try {
    const msg = await channel.messages.fetch(q.nowPlayingMessageId);
    await msg.delete().catch(() => {});
  } catch {}
  q.nowPlayingMessageId = null;
}

// Comandos básicos
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  // !play <URL|búsqueda>
  if (message.content.startsWith("!play")) {
    const raw = message.content.slice("!play".length).trim();
    const candidate =
      raw || (message.content.match(/https?:\/\/\S+/)?.[0] ?? "");
    if (!candidate) return message.reply("📌 Usá: `!play <link>`");
    // Playlist YouTube: encolar múltiples items
    try {
      const vType = await playdl.validate(canonicalizeYouTubeUrl(candidate));
      if (vType === "yt_playlist") {
        const voiceChannel = message.member.voice.channel;
        if (!voiceChannel)
          return message.reply("❌ Tenés que estar en un canal de voz.");
        const perms = voiceChannel.permissionsFor(message.client.user);
        if (
          !perms?.has(PermissionsBitField.Flags.Connect) ||
          !perms?.has(PermissionsBitField.Flags.Speak)
        ) {
          return message.reply(
            "❌ No tengo permisos para unirme o hablar en ese canal."
          );
        }
  const q = getQueue(message.guild.id);
  if (!q.textChannelId) q.textChannelId = message.channel.id;
        await ensureConnection(message.guild, voiceChannel);
        const pl = await playdl.playlist_info(candidate, { incomplete: true });
        await pl.fetch();
        const items = (pl.videos || []).slice(0, MAX_PLAYLIST_ITEMS);
        if (items.length === 0)
          return message.reply("❌ No pude leer la playlist.");
        let added = 0;
        for (const vid of items) {
          const url =
            vid.url ||
            vid.video_url ||
            (vid.id ? `https://www.youtube.com/watch?v=${vid.id}` : null);
          if (!url) continue;
          const title = vid.title || vid.name || url;
          const dur =
            Number(vid.durationInSec || vid.durationInMs / 1000 || 0) || 0;
          if ((q.songs?.length || 0) >= MAX_QUEUE_LENGTH) break;
          q.songs.push({
            url: canonicalizeYouTubeUrl(url),
            title,
            durationSec: dur ? Math.floor(dur) : 0,
            thumbnailUrl: deriveYouTubeThumb(url),
            requestedById: message.author.id,
          });
          added++;
        }
        if (
          q.songs.length > 0 &&
          q.player.state.status !== AudioPlayerStatus.Playing
        ) {
          await playNext(message.guild.id);
        }
        const queueText = formatQueueMessage(q);
        const sent = await message.reply(
          `📚 Añadidos ${added} temas de la playlist "${
            pl.title || ""
          }" (máx ${MAX_PLAYLIST_ITEMS}${added < items.length ? `, truncado por límite de cola (${MAX_QUEUE_LENGTH})` : ""}).\n\nCola actual:\n${queueText}`
        );
        // Asegurar/actualizar panel sin sobreescribir con el reply
        await ensurePanel(message.guild.id, sent.channel.id);
        await renderNowPlaying(message.guild.id).catch(() => {});
        return sent;
      }
    } catch {}
    const finalUrl = await resolvePlayableUrl(candidate);
    if (!finalUrl) return message.reply("❌ Link inválido o no soportado.");

    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel)
      return message.reply("❌ Tenés que estar en un canal de voz.");

    const perms = voiceChannel.permissionsFor(message.client.user);
    if (
      !perms?.has(PermissionsBitField.Flags.Connect) ||
      !perms?.has(PermissionsBitField.Flags.Speak)
    ) {
      return message.reply(
        "❌ No tengo permisos para unirme o hablar en ese canal."
      );
    }

    try {
  const q = getQueue(message.guild.id);
  if (!q.textChannelId) q.textChannelId = message.channel.id;
      // Paralelizar conexión con fetch de info/metadata
      const connectP = ensureConnection(message.guild, voiceChannel);
      const ytCookie = process.env.YT_COOKIE || process.env.YOUTUBE_COOKIE;
      let songData = null;
      if (isYouTubeUrl(finalUrl)) {
  if (String(process.env.YT_FORCE_YTDLP || "0") === "1") {
          const meta = await fetchMetadata(finalUrl);
          songData = {
            url: finalUrl,
            title: meta.title,
            durationSec: meta.durationSec || 0,
            thumbnailUrl: meta.thumbnailUrl,
            requestedById: message.author.id,
          };
        } else {
          const id = extractYouTubeId(finalUrl) || finalUrl;
          const info = await ytdl.getInfo(id);
          const title = info?.videoDetails?.title || finalUrl;
          const dur = Number(info?.videoDetails?.lengthSeconds || 0) || 0;
          const thumb =
            (info?.videoDetails?.thumbnails || [])[0]?.url ||
            deriveYouTubeThumb(finalUrl);
          songData = {
            url: finalUrl,
            title,
            durationSec: dur ? Math.floor(dur) : 0,
            thumbnailUrl: thumb,
            requestedById: message.author.id,
            ytdlInfo: info,
          };
        }
      } else {
        const meta = await fetchMetadata(finalUrl);
        songData = {
          url: finalUrl,
          title: meta.title,
          durationSec: meta.durationSec || 0,
          thumbnailUrl: meta.thumbnailUrl,
          requestedById: message.author.id,
        };
      }
      await connectP;
      if (!tryEnqueue(q, songData)) {
        const queueText = formatQueueMessage(q);
        const sent = await message.reply(`⚠️ La cola está llena (máx ${MAX_QUEUE_LENGTH}).\n\nCola actual:\n${queueText}`);
        await ensurePanel(message.guild.id, sent.channel.id);
        await renderNowPlaying(message.guild.id).catch(() => {});
        return;
      }
      let header;
      if (q.songs.length === 1) {
        await playNext(message.guild.id);
        header = `🎶 Reproduciendo: ${songData.title}${
          songData.durationSec
            ? ` [${formatDuration(songData.durationSec)}]`
            : ""
        }`;
      } else {
        header = `➕ Añadido a la cola: ${songData.title}${
          songData.durationSec
            ? ` [${formatDuration(songData.durationSec)}]`
            : ""
        } (pos. ${q.songs.length})`;
      }
      const queueText = formatQueueMessage(q);
      const sent = await message.reply(
        `${header}\n\nCola actual:\n${queueText}`
      );
      // Mantener un único panel por servidor (no usar el reply como panel)
      await ensurePanel(message.guild.id, sent.channel.id);
      await renderNowPlaying(message.guild.id).catch(() => {});
    } catch (err) {
      console.error("[play:error]", err);
      message.reply("⚠️ No se pudo reproducir el audio.");
    }
  }

  // !skip
  if (message.content === "!skip") {
    const q = queues.get(message.guild.id);
    if (!q || q.songs.length === 0)
      return message.reply("No hay nada en reproducción.");
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
    try {
      stopNowPlayingTicker(message.guild.id);
    } catch {}
    const queueText = formatQueueMessage(q);
    const r = await message.reply(`⏸️ Pausado.\n\nCola actual:\n${queueText}`);
    renderNowPlaying(message.guild.id).catch(() => {});
    return r;
  }

  // !remove <index>
  if (message.content.startsWith("!remove")) {
    const arg = message.content.split(/\s+/)[1];
    const idx = parseInt(arg, 10);
    const q = queues.get(message.guild.id);
    if (!q || q.songs.length === 0) return message.reply("La cola está vacía.");
    if (!idx || idx < 1 || idx > q.songs.length) return message.reply(`Índice inválido. Rango: 1-${q.songs.length}.`);
    if (idx === 1) {
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
    } else {
      q.songs.splice(idx - 1, 1);
    }
    const queueText = formatQueueMessage(q);
    await renderNowPlaying(message.guild.id).catch(() => {});
    return message.reply(`🗑️ Eliminado el elemento ${idx}.\n\nCola actual:\n${queueText}`);
  }

  // !clear
  if (message.content === "!clear") {
    const q = queues.get(message.guild.id);
    if (!q || q.songs.length === 0) return message.reply("La cola está vacía.");
    if (q.songs.length > 1) q.songs = [q.songs[0]]; // mantener la actual
    const queueText = formatQueueMessage(q);
    await renderNowPlaying(message.guild.id).catch(() => {});
    return message.reply(`🧹 Cola limpiada (se mantiene la canción actual).\n\nCola actual:\n${queueText}`);
  }

  // !resume
  if (message.content === "!resume") {
    const q = queues.get(message.guild.id);
    if (!q) return message.reply("No hay nada en reproducción.");
    q.player.unpause();
    try {
      startNowPlayingTicker(message.guild.id);
    } catch {}
    const queueText = formatQueueMessage(q);
    const r = await message.reply(
      `▶️ Reanudado.\n\nCola actual:\n${queueText}`
    );
    renderNowPlaying(message.guild.id).catch(() => {});
    return r;
  }
  if (message.content === "!queue") {
    const q = queues.get(message.guild.id);
    if (!q || q.songs.length === 0) return message.reply("La cola está vacía.");
    const elapsed = Math.floor(
      (q.player.state?.resource?.playbackDuration || 0) / 1000
    );
    const lines = q.songs.slice(0, 10).map((s, i) => {
      const dur = s.durationSec ? ` [${formatDuration(s.durationSec)}]` : "";
      if (i === 0) {
        const left = s.durationSec
          ? ` (${formatDuration(elapsed)} / ${formatDuration(s.durationSec)})`
          : "";
        return `▶️ ${s.title}${dur}${left}`;
      }
      return `${i + 1}. ${s.title}${dur}`;
    });
    return message.reply(lines.join("\n"));
  }

  // !nowplaying | !np
  if (message.content === "!nowplaying" || message.content === "!np") {
    const q = queues.get(message.guild.id);
    if (!q || q.songs.length === 0)
      return message.reply("No hay nada en reproducción.");
    const s = q.songs[0];
    const elapsed = Math.floor(
      (q.player.state?.resource?.playbackDuration || 0) / 1000
    );
    const total = s.durationSec || 0;
    const header = total
      ? `🎶 Ahora: ${s.title} [${formatDuration(elapsed)} / ${formatDuration(
          total
        )}] • Vol: ${Math.round((q.volume ?? 1) * 100)}%`
      : `🎶 Ahora: ${s.title} • Vol: ${Math.round((q.volume ?? 1) * 100)}%`;
    const bar = total ? `\n${buildProgressBar(total, elapsed)}` : "";
    return message.reply(header + bar);
  }

  // !stop
  if (message.content === "!stop") {
    const q = queues.get(message.guild.id);
    const connection = getVoiceConnection(message.guild.id);
    const queueText = q ? formatQueueMessage(q) : "La cola está vacía.";
    if (q) q.songs = [];
    connection?.destroy();
    queues.delete(message.guild.id);
    const r = await message.reply(
      `⏹️ Música detenida y bot desconectado.\n\nCola final:\n${queueText}`
    );
    clearNowPlaying(message.guild.id).catch(() => {});
    try {
      stopNowPlayingTicker(message.guild.id);
    } catch {}
    return r;
  }

  // !volume <0-200>
  if (message.content.startsWith("!volume")) {
    const arg = message.content.split(/\s+/)[1];
    if (!arg || isNaN(parseInt(arg)))
      return message.reply("📌 Usá: `!volume <0-200>`. Ej: `!volume 100`");
    const pct = Math.max(0, Math.min(200, parseInt(arg)));
    const q = getQueue(message.guild.id);
    q.volume = pct / 100;
    guildVolumes[message.guild.id] = q.volume;
    saveVolumes(guildVolumes);
    const res = q.player.state?.resource;
    if (res?.volume?.setVolumeLogarithmic)
      res.volume.setVolumeLogarithmic(Math.max(0, Math.min(2, q.volume)));
    const r = await message.reply(`🔊 Volumen: ${pct}%`);
    renderNowPlaying(message.guild.id).catch(() => {});
    return r;
  }
});

// ======================
// Interacciones de Slash Commands
// ======================
client.on("interactionCreate", async (interaction) => {
  // Botones de control
  if (interaction.isButton()) {
    const { guild, user } = interaction;
    const q = guild ? queues.get(guild.id) : null;
    if (!q) {
      try {
        await interaction.reply({
          content: "No hay nada en reproducción.",
          ephemeral: true,
        });
      } catch {}
      return;
    }
    if (!sameVoiceChannelRequiredPass(guild, user)) {
      try {
        await interaction.reply({
          content: "❌ Debés estar en el mismo canal de voz que el bot para usar los controles.",
          ephemeral: true,
        });
      } catch {}
      return;
    }
    const id = interaction.customId;
    // Para botones que editan el panel actual, usamos deferUpdate(); para los que sólo responden efímero (cola), respondemos directo.
    const deferForIds = new Set([
      "music_pause",
      "music_resume",
      "music_skip",
      "music_stop",
      "music_loop",
      "music_shuffle",
      "music_replay",
      "music_vol_down",
      "music_vol_up",
      "music_save",
    ]);
    if (deferForIds.has(id)) {
      try { await interaction.deferUpdate(); } catch {}
    }
    if (id === "music_pause") {
      q.player.pause();
      try {
        stopNowPlayingTicker(guild.id);
      } catch {}
      await renderNowPlaying(guild.id).catch(() => {});
      return;
    }
    if (id === "music_resume") {
      q.player.unpause();
      try {
        startNowPlayingTicker(guild.id);
      } catch {}
      await renderNowPlaying(guild.id).catch(() => {});
      return;
    }
    if (id === "music_skip") {
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
    if (id === "music_stop") {
      const connection = getVoiceConnection(guild.id);
      if (q) q.songs = [];
      connection?.destroy();
      queues.delete(guild.id);
      clearNowPlaying(guild.id).catch(() => {});
      stopNowPlayingTicker(guild.id);
      return;
    }
    if (id === "music_loop") {
      q.loop = !q.loop;
      await renderNowPlaying(guild.id).catch(() => {});
      return;
    }
    if (id === "music_shuffle") {
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
    if (id === "music_queue") {
      // Responder efímero con la cola formateada
      const text = formatQueueMessage(q, 20);
      try {
        await interaction.reply({ content: `📋 Cola actual:\n${text}` , ephemeral: true });
      } catch (e) {
        // Si ya fue respondida, intentar editReply
        try { await interaction.editReply({ content: `📋 Cola actual:\n${text}` }); } catch {}
      }
      return;
    }
    if (id === "music_replay") {
      // Reiniciar pista actual sin modificar la cola
      const song = q.songs[0];
      if (song) {
        try {
          const resource = await createResourceFromUrl(
            song.url,
            q.volume ?? 1.0
          );
          q.player.play(resource);
          await renderNowPlaying(guild.id).catch(() => {});
        } catch {}
      }
      return;
    }
    if (id === "music_vol_down" || id === "music_vol_up") {
      const delta = id === "music_vol_up" ? 0.1 : -0.1;
      q.volume = Math.max(0, Math.min(2, (q.volume ?? 1) + delta));
      guildVolumes[guild.id] = q.volume;
      saveVolumes(guildVolumes);
      const res = q.player.state?.resource;
      if (res?.volume?.setVolumeLogarithmic)
        res.volume.setVolumeLogarithmic(q.volume);
      await renderNowPlaying(guild.id).catch(() => {});
      return;
    }
    if (id === "music_save") {
      const s = q.songs?.[0];
      if (s) {
        try {
          const dm = await user.createDM();
          await dm.send({
            embeds: [
              new EmbedBuilder()
                .setColor(0x57f287)
                .setTitle("Guardado")
                .setDescription(`[${s.title}](${s.url})`)
                .addFields(
                  { name: "Servidor", value: guild.name, inline: true },
                  {
                    name: "Duración",
                    value: s.durationSec ? formatDuration(s.durationSec) : "—",
                    inline: true,
                  }
                ),
            ],
          });
        } catch {}
      }
      return;
    }
    return;
  }
  if (!interaction.isChatInputCommand()) return;
  const { commandName, guild, member } = interaction;
  if (!guild) {
    await safeRespond(
      interaction,
      "Este comando sólo funciona en servidores.",
      { ephemeral: true }
    );
    return;
  }

  try {
    if (commandName === "play") {
      const query = interaction.options.getString("query", true);
      const ok = await safeDefer(interaction);
      if (!ok) return;
      // Playlist en /play
      try {
        const vType = await playdl.validate(canonicalizeYouTubeUrl(query));
        if (vType === "yt_playlist") {
          const voiceChannel = member.voice?.channel;
          if (!voiceChannel)
            return safeRespond(
              interaction,
              "❌ Tenés que estar en un canal de voz.",
              { edit: true }
            );
          const perms = voiceChannel.permissionsFor(interaction.client.user);
          if (
            !perms?.has(PermissionsBitField.Flags.Connect) ||
            !perms?.has(PermissionsBitField.Flags.Speak)
          ) {
            return safeRespond(
              interaction,
              "❌ No tengo permisos para unirme o hablar en ese canal.",
              { edit: true }
            );
          }
          const q = getQueue(guild.id);
          if (!q.textChannelId) q.textChannelId = interaction.channelId;
          try {
            await ensureConnection(guild, voiceChannel);
          } catch (e) {
            return safeRespond(
              interaction,
              "❌ No pude conectarme al canal de voz.",
              { edit: true }
            );
          }
          const pl = await playdl.playlist_info(query, { incomplete: true });
          await pl.fetch();
          const items = (pl.videos || []).slice(0, MAX_PLAYLIST_ITEMS);
          if (items.length === 0)
            return safeRespond(interaction, "❌ No pude leer la playlist.", {
              edit: true,
            });
          let added = 0;
          for (const vid of items) {
            const url =
              vid.url ||
              vid.video_url ||
              (vid.id ? `https://www.youtube.com/watch?v=${vid.id}` : null);
            if (!url) continue;
            const title = vid.title || vid.name || url;
            const dur =
              Number(vid.durationInSec || vid.durationInMs / 1000 || 0) || 0;
            if ((q.songs?.length || 0) >= MAX_QUEUE_LENGTH) break;
            q.songs.push({
              url: canonicalizeYouTubeUrl(url),
              title,
              durationSec: dur ? Math.floor(dur) : 0,
              thumbnailUrl: deriveYouTubeThumb(url),
              requestedById: member?.user?.id,
            });
            added++;
          }
          if (
            q.songs.length > 0 &&
            q.player.state.status !== AudioPlayerStatus.Playing
          ) {
            await playNext(guild.id);
          }
          const queueText = formatQueueMessage(q);
          const resp = await safeRespond(
            interaction,
            `📚 Añadidos ${added} temas de la playlist "${
              pl.title || ""
            }" (máx ${MAX_PLAYLIST_ITEMS}${added < items.length ? `, truncado por límite de cola (${MAX_QUEUE_LENGTH})` : ""}).\n\nCola actual:\n${queueText}`,
            { edit: true }
          );
          // Asegurar un único panel
          await ensurePanel(guild.id, interaction.channelId);
          await renderNowPlaying(guild.id).catch(() => {});
          return resp;
        }
      } catch {}

      const finalUrl = await resolvePlayableUrl(query);
      if (!finalUrl)
        return safeRespond(interaction, "❌ Link inválido o no soportado.", {
          edit: true,
        });

      const voiceChannel = member.voice?.channel;
      if (!voiceChannel)
        return safeRespond(
          interaction,
          "❌ Tenés que estar en un canal de voz.",
          { edit: true }
        );
      const perms = voiceChannel.permissionsFor(interaction.client.user);
      if (
        !perms?.has(PermissionsBitField.Flags.Connect) ||
        !perms?.has(PermissionsBitField.Flags.Speak)
      ) {
        return safeRespond(
          interaction,
          "❌ No tengo permisos para unirme o hablar en ese canal.",
          { edit: true }
        );
      }

  const q = getQueue(guild.id);
  if (!q.textChannelId) q.textChannelId = interaction.channelId;
      // Paralelizar conexión con fetch de info/metadata
      const connectP = ensureConnection(guild, voiceChannel).catch((e) => e);
      const ytCookie = process.env.YT_COOKIE || process.env.YOUTUBE_COOKIE;
      let songData = null;
      if (isYouTubeUrl(finalUrl)) {
        if (String(process.env.YT_FORCE_YTDLP || "0") === "1") {
          const meta = await fetchMetadata(finalUrl);
          songData = {
            url: finalUrl,
            title: meta.title,
            durationSec: meta.durationSec || 0,
            thumbnailUrl: meta.thumbnailUrl,
            requestedById: member?.user?.id,
          };
        } else {
          try {
            const id = extractYouTubeId(finalUrl) || finalUrl;
            const info = await ytdl.getInfo(id);
            const title = info?.videoDetails?.title || finalUrl;
            const dur = Number(info?.videoDetails?.lengthSeconds || 0) || 0;
            const thumb =
              (info?.videoDetails?.thumbnails || [])[0]?.url ||
              deriveYouTubeThumb(finalUrl);
            songData = {
              url: finalUrl,
              title,
              durationSec: dur ? Math.floor(dur) : 0,
              thumbnailUrl: thumb,
              requestedById: member?.user?.id,
              ytdlInfo: info,
            };
          } catch {
            const meta = await fetchMetadata(finalUrl);
            songData = {
              url: finalUrl,
              title: meta.title,
              durationSec: meta.durationSec || 0,
              thumbnailUrl: meta.thumbnailUrl,
              requestedById: member?.user?.id,
            };
          }
        }
      } else {
        const meta = await fetchMetadata(finalUrl);
        songData = {
          url: finalUrl,
          title: meta.title,
          durationSec: meta.durationSec || 0,
          thumbnailUrl: meta.thumbnailUrl,
          requestedById: member?.user?.id,
        };
      }
      const connRes = await connectP;
      if (connRes instanceof Error) {
        return safeRespond(
          interaction,
          "❌ No pude conectarme al canal de voz. Revisá permisos o la región del servidor e intentá de nuevo.",
          { edit: true }
        );
      }
      if (!tryEnqueue(q, songData)) {
        const queueText = formatQueueMessage(q);
        const r = await safeRespond(
          interaction,
          `⚠️ La cola está llena (máx ${MAX_QUEUE_LENGTH}).\n\nCola actual:\n${queueText}`,
          { edit: true }
        );
        await ensurePanel(guild.id, interaction.channelId);
        await renderNowPlaying(guild.id).catch(() => {});
        return r;
      }
      let header;
      if (q.songs.length === 1) {
        await playNext(guild.id);
        header = `🎶 Reproduciendo: ${songData.title}${
          songData.durationSec
            ? ` [${formatDuration(songData.durationSec)}]`
            : ""
        }`;
      } else {
        header = `➕ Añadido a la cola: ${songData.title}${
          songData.durationSec
            ? ` [${formatDuration(songData.durationSec)}]`
            : ""
        } (pos. ${q.songs.length})`;
      }
      const queueText = formatQueueMessage(q);
  const r = await safeRespond(
        interaction,
        `${header}\n\nCola actual:\n${queueText}`,
        { edit: true }
      );
  // Mantener un único panel por servidor
  await ensurePanel(guild.id, interaction.channelId);
  await renderNowPlaying(guild.id).catch(() => {});
      return r;
    }

    if (commandName === "skip") {
      const ok = await safeDefer(interaction);
      if (!ok) return;
      const q = queues.get(guild.id);
      if (!q || q.songs.length === 0)
        return safeRespond(interaction, "No hay nada en reproducción.", {
          edit: true,
        });
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
      await safeRespond(
        interaction,
        `⏭️ Saltado.\n\nCola actual:\n${queueText}`,
        { edit: true }
      );
      await renderNowPlaying(guild.id).catch(() => {});
      return;
    }

    if (commandName === "pause") {
      const ok = await safeDefer(interaction);
      if (!ok) return;
      const q = queues.get(guild.id);
      if (!q)
        return safeRespond(interaction, "No hay nada en reproducción.", {
          edit: true,
        });
      q.player.pause();
      try {
        stopNowPlayingTicker(guild.id);
      } catch {}
      const queueText = formatQueueMessage(q);
      await safeRespond(
        interaction,
        `⏸️ Pausado.\n\nCola actual:\n${queueText}`,
        { edit: true }
      );
      await renderNowPlaying(guild.id).catch(() => {});
      return;
    }

    if (commandName === "resume") {
      const ok = await safeDefer(interaction);
      if (!ok) return;
      const q = queues.get(guild.id);
      if (!q)
        return safeRespond(interaction, "No hay nada en reproducción.", {
          edit: true,
        });
      q.player.unpause();
      try {
        startNowPlayingTicker(guild.id);
      } catch {}
      const queueText = formatQueueMessage(q);
      await safeRespond(
        interaction,
        `▶️ Reanudado.\n\nCola actual:\n${queueText}`,
        { edit: true }
      );
      await renderNowPlaying(guild.id).catch(() => {});
      return;
    }

    if (commandName === "queue") {
      const ok = await safeDefer(interaction);
      if (!ok) return;
      const q = queues.get(guild.id);
      if (!q || q.songs.length === 0)
        return safeRespond(interaction, "La cola está vacía.", { edit: true });
      const elapsed = Math.floor(
        (q.player.state?.resource?.playbackDuration || 0) / 1000
      );
      const lines = q.songs.slice(0, 10).map((s, i) => {
        const dur = s.durationSec ? ` [${formatDuration(s.durationSec)}]` : "";
        if (i === 0) {
          const left = s.durationSec
            ? ` (${formatDuration(elapsed)} / ${formatDuration(s.durationSec)})`
            : "";
          return `▶️ ${s.title}${dur}${left}`;
        }
        return `${i + 1}. ${s.title}${dur}`;
      });
      return safeRespond(interaction, lines.join("\n"), { edit: true });
    }

    if (commandName === "remove") {
      const ok = await safeDefer(interaction);
      if (!ok) return;
      const q = queues.get(guild.id);
      if (!q || q.songs.length === 0)
        return safeRespond(interaction, "La cola está vacía.", { edit: true });
      const idx = interaction.options.getInteger("index", true);
      if (idx < 1 || idx > q.songs.length)
        return safeRespond(interaction, `Índice inválido. Rango: 1-${q.songs.length}.`, { edit: true });
      if (idx === 1) {
        q.loop = false;
        q.songs.shift();
        if (q.songs.length > 0) {
          await playNext(guild.id);
        } else {
          const connection = getVoiceConnection(guild.id);
          connection?.destroy();
          queues.delete(guild.id);
          await clearNowPlaying(guild.id).catch(() => {});
        }
      } else {
        q.songs.splice(idx - 1, 1);
      }
      const queueText = formatQueueMessage(q);
      await renderNowPlaying(guild.id).catch(() => {});
      return safeRespond(interaction, `🗑️ Eliminado el elemento ${idx}.\n\nCola actual:\n${queueText}`, { edit: true });
    }

    if (commandName === "clear") {
      const ok = await safeDefer(interaction);
      if (!ok) return;
      const q = queues.get(guild.id);
      if (!q || q.songs.length === 0)
        return safeRespond(interaction, "La cola está vacía.", { edit: true });
      if (q.songs.length > 1) q.songs = [q.songs[0]]; // mantener la actual
      const queueText = formatQueueMessage(q);
      await renderNowPlaying(guild.id).catch(() => {});
      return safeRespond(interaction, `🧹 Cola limpiada (se mantiene la canción actual).\n\nCola actual:\n${queueText}`, { edit: true });
    }
    if (commandName === "nowplaying") {
      const ok = await safeDefer(interaction);
      if (!ok) return;
      const q = queues.get(guild.id);
      if (!q || q.songs.length === 0)
        return safeRespond(interaction, "No hay nada en reproducción.", {
          edit: true,
        });
      const s = q.songs[0];
      const elapsed = Math.floor(
        (q.player.state?.resource?.playbackDuration || 0) / 1000
      );
      const total = s.durationSec || 0;
      const header = total
        ? `🎶 Ahora: ${s.title} [${formatDuration(elapsed)} / ${formatDuration(
            total
          )}] • Vol: ${Math.round((q.volume ?? 1) * 100)}%`
        : `🎶 Ahora: ${s.title} • Vol: ${Math.round((q.volume ?? 1) * 100)}%`;
      const bar = total ? `\n${buildProgressBar(total, elapsed)}` : "";
      return safeRespond(interaction, header + bar, { edit: true });
    }

    if (commandName === "stop") {
      const ok = await safeDefer(interaction);
      if (!ok) return;
      const q = queues.get(guild.id);
      const connection = getVoiceConnection(guild.id);
      const queueText = q ? formatQueueMessage(q) : "La cola está vacía.";
      if (q) q.songs = [];
      connection?.destroy();
      queues.delete(guild.id);
      await clearNowPlaying(guild.id).catch(() => {});
      return safeRespond(
        interaction,
        `⏹️ Música detenida y bot desconectado.\n\nCola final:\n${queueText}`,
        { edit: true }
      );
    }

    if (commandName === "volume") {
      const ok = await safeDefer(interaction);
      if (!ok) return;
      let level = interaction.options.getInteger("level", true);
      if (typeof level !== "number") level = 100;
      const pct = Math.max(0, Math.min(200, level));
      const q = getQueue(guild.id);
      q.volume = pct / 100;
      guildVolumes[guild.id] = q.volume;
      saveVolumes(guildVolumes);
      const res = q.player.state?.resource;
      if (res?.volume?.setVolumeLogarithmic)
        res.volume.setVolumeLogarithmic(Math.max(0, Math.min(2, q.volume)));
      await renderNowPlaying(guild.id).catch(() => {});
      return safeRespond(interaction, `🔊 Volumen: ${pct}%`, { edit: true });
    }
  } catch (e) {
    console.error("[interaction:error]", e);
    if (interaction.deferred || interaction.replied) {
      await safeRespond(interaction, "⚠️ Ocurrió un error.", { edit: true });
    } else {
      await safeRespond(interaction, "⚠️ Ocurrió un error.", {
        ephemeral: true,
      });
    }
  }
});

// Iniciar el bot
client.login(process.env.DISCORD_TOKEN);

// Si corremos en Render Web Service, expongamos un health-check HTTP en PORT
function startHealthServer() {
  const port = Number(process.env.PORT || 0);
  if (!port) return; // no estamos en un Web Service
  const http = require("http");
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  });
  server.listen(port, () =>
    console.log(`[http] health server escuchando en :${port}`)
  );
}
startHealthServer();

// Apagado limpio en plataformas que envían señales (Render)
function gracefulShutdown(signal) {
  console.log(`[shutdown] señal recibida: ${signal}`);
  try {
    for (const [gid] of queues) {
      try {
        getVoiceConnection(gid)?.destroy();
      } catch {}
    }
  } catch {}
  try {
    client.destroy();
  } catch {}
  process.exit(0);
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
