# Debian (glibc) rather than Alpine (musl): the WebTransport QUIC addon only ships glibc prebuilts.
FROM node:25-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:25-slim AS production

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/build ./build
COPY --from=builder /app/dist ./dist
RUN chown -R node:node /app

USER node

EXPOSE 9001
EXPOSE 9002/udp

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "import('http').then(h => h.get('http://localhost:9001', r => process.exit(r.statusCode === 200 ? 0 : 1)))" || exit 1

CMD ["npm", "start"]
