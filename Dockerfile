FROM node:25-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:25-alpine AS production

RUN addgroup -g 1001 -S nodejs
RUN adduser -S nodejs -u 1001

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/build ./build
COPY --from=builder /app/dist ./dist
RUN chown -R nodejs:nodejs /app

USER nodejs

EXPOSE 9001

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "import('http').then(h => h.get('http://localhost:9001', r => process.exit(r.statusCode === 200 ? 0 : 1)))" || exit 1

CMD ["npm", "start"]
