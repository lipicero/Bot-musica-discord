# syntax=docker/dockerfile:1

# Imagen base Debian/glibc para compatibilidad con ffmpeg-static / @discordjs/opus
FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Evitar prompts interactivos de pnpm al aprobar scripts de build
ENV CI=true

WORKDIR /app

# Runtime + toolchain para compilar @discordjs/opus (prebuild Node 22 a menudo falta)
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      tzdata \
      tini \
      curl \
      python3 \
      make \
      g++ \
    && rm -rf /var/lib/apt/lists/*

# pnpm vía Corepack (versión fijada en package.json → packageManager)
RUN corepack enable \
    && corepack prepare pnpm@10.32.1 --activate \
    && pnpm --version

# Instalar yt-dlp binario estático (Linux)
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

# Dependencias primero (mejor cache de capas)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod \
    && pnpm store prune

# Código fuente
COPY . .

RUN mkdir -p logs \
    && chown -R node:node /app

USER node

# Render inyecta PORT; el proceso escucha 0.0.0.0:$PORT
EXPOSE 10000

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "index.js"]
