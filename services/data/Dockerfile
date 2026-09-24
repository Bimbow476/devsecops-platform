# syntax=docker/dockerfile:1

# ---------- Стадія збірки (з інструментами для нативної збірки better-sqlite3) ----------
FROM node:25-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
# Прибираємо dev-залежності (typescript та ін.) з node_modules перед копіюванням у рантайм
RUN npm prune --omit=dev

# ---------- Стадія виконання ----------
FROM node:25-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
# Краще-sqlite3 збирається/копіюється з build-стадії (сумісність ABI гарантована базовим образом)
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Харднінг: npm та lockfile не потрібні в рантаймі (Trivy не бачить dev-дерева)
RUN chown -R node:node /app && mkdir -p /data && chown node:node /data \
    && rm -f /app/package-lock.json \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
# runAsNonRoot у K8s вимагає числовий UID (node => 1000)
USER 1000
ENV PORT=8082
EXPOSE 8082
VOLUME ["/data"]
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8082)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/index.js"]