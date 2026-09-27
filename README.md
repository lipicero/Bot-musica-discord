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

## Deploy en Render (Web Service)

Render exige un único HTTP en `0.0.0.0:$PORT`. El bot abre dashboard + health en ese puerto al arrancar:

1. Crear un **Web Service** con runtime **Docker** (usa el `Dockerfile` del repo; instala con **pnpm**).
2. Health Check Path: `/health`
3. Variables: `DISCORD_TOKEN` (obligatoria), opcional `YT_COOKIE`, `WEB_PASSWORD`.
4. **No** definas `PORT` ni `WEB_PORT` en el Dashboard: Render inyecta `PORT`.

Verificación rápida tras el deploy: `https://<tu-servicio>.onrender.com/health` debe devolver `ok`.

Nota (plan free): el Web Service se duerme tras ~15 min sin HTTP. El bot de Discord se cae con el sleep; para 24/7 hace falta un plan de pago o un ping externo a `/health`.

## Dependencias locales

```bash
corepack enable
pnpm install
pnpm start
```
