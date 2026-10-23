# ---- build ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# Production-only install; omit dev tooling from the runtime image.
RUN npm install --omit=dev --no-audit --no-fund

# ---- runtime ----
FROM node:22-alpine
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public
COPY tests ./tests

# Run unprivileged.
RUN addgroup -g 1001 -S hive && adduser -u 1001 -S hive -G hive \
    && chown -R hive:hive /app
USER hive

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
