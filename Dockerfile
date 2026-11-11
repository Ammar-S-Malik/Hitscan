# Game server image. The client is static files and is hosted separately (Cloudflare Pages).
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8787

# Install dependencies first so this layer is cached until package files change.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev

COPY shared shared
COPY server server

EXPOSE 8787
USER node
CMD ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "server/src/main.ts"]
