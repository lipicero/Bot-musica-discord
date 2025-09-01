# Bot de música con panel Now Playing

Este bot muestra un panel "Now Playing" con botones de control:

- ⏮️ Replay
- ⏸️/▶️ Pausa / Reanudar
- ⏭️ Siguiente
- 🔉/🔊 Volumen -/+
- 🔁 Loop (toggle)
- 💾 Guardar (envía el tema actual por DM)
- 🔀 Mezclar cola (sin mover la pista actual)
- ⏹️ Detener

Además, comandos por texto: `!play`, `!skip`, `!pause`, `!resume`, `!queue`, `!nowplaying`, `!stop`, `!volume <0-200>` y equivalentes mediante slash.

## Requisitos

- Node.js 18+
- Variables en `.env`:
  - `DISCORD_TOKEN=...`
  - Opcional: `YT_COOKIE=...` (para evitar bloqueos en YouTube)

## Ejecutar

- Windows (fondo): `start-bot-bg.bat` o `status-bot.bat` para ver estado.
- Primer arranque: usa `/play <url o búsqueda>` o `!play <url>`.

Si el panel no aparece, asegúrate de:
- Que el bot tenga permiso para ver/escribir en el canal de texto y usar botones.
- Estar en un canal de voz válido y dar permisos de Conectar/Hablar.
