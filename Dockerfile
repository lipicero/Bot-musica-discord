# syntax=docker/dockerfile:1

# Imagen base Debian/glibc para compatibilidad con ffmpeg-static
FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# Paquetes mínimos y tini para señalización limpia
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tzdata tini \
    && rm -rf /var/lib/apt/lists/*

# Dependencias primero para aprovechar la cache
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
    && npm cache clean --force

# Código fuente
COPY . .

# Asegurar carpeta de logs dentro del contenedor
RUN mkdir -p logs && chown -R node:node /app

# Ejecutar como usuario no root
USER node

# ffmpeg-static se resuelve por plataforma automáticamente; no es necesario instalar ffmpeg del sistema
# ENTRYPOINT con tini para manejar señales (stop/restart) correctamente
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "index.js"]
