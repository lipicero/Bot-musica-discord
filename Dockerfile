# syntax=docker/dockerfile:1

# Imagen base Debian/glibc para compatibilidad con ffmpeg-static
FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# Paquetes mínimos y tini para señalización limpia
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tzdata tini curl python3 \
    && rm -rf /var/lib/apt/lists/*

# Instalar yt-dlp binario estático (Linux) y hacerlo ejecutable
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

# Dependencias primero para aprovechar la cache
COPY package.json pnpm-lock.yaml* package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
    && npm cache clean --force

# Código fuente
COPY . .

# Asegurar carpeta de logs dentro del contenedor
RUN mkdir -p logs && chown -R node:node /app

# Ejecutar como usuario no root
USER node

# Render inyecta PORT; el proceso debe escuchar 0.0.0.0:$PORT
EXPOSE 10000

# ffmpeg-static se resuelve por plataforma automáticamente; no es necesario instalar ffmpeg del sistema
# ENTRYPOINT con tini para manejar señales (stop/restart) correctamente
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "index.js"]
