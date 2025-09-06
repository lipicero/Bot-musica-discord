0# Bot de música con panel Now Playing

Este bot muestra un panel "Now Playing" con botones de control:

- ⏮️ Replay
- ⏸️/▶️ Pausa / Reanudar
- ⏭️ Siguiente
- 🔉/🔊 Volumen -/+
- 🔁 Loop (toggle)
- 💾 Guardar (envía el tema actual por DM)
- 🔀 Mezclar cola (sin mover la pista actual)
- ⏹️ Detener

Comandos disponibles (slash):

- `/play <URL>`: reproducir URL o playlist (YouTube)
- `/skip`, `/pause`, `/resume`, `/stop`
- `/queue`, `/nowplaying`, `/volume <0-200>`
- `/bass <preset>`: off/low/med/high/extreme
- Nuevos: `/ping`, `/stats`, `/shuffle`, `/seek <seconds>`

## Requisitos

- Node.js 18+
- Variables en `.env`:
  - `DISCORD_TOKEN=...`
  - Opcional: `YT_COOKIE=...` (para evitar bloqueos en YouTube)

## Ejecutar

- Windows (fondo): `start-bot-bg.bat` o `status-bot.bat` para ver estado.
- Primer arranque: usa `/play <URL>`.

Si el panel no aparece, asegúrate de:
- Que el bot tenga permiso para ver/escribir en el canal de texto y usar botones.
- Estar en un canal de voz válido y dar permisos de Conectar/Hablar.

Tips:
- Puedes alternar aleatorio con `/shuffle` o con el botón “Aleatorio”.
- Usa `/seek` para saltar dentro del tema actual; con bass activo usa FFmpeg para precisión.
