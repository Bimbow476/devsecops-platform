# syntax=docker/dockerfile:1

# ---------- Стадія збірки ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
RUN npm run build

# ---------- Стадія виконання (nginx) ----------
FROM nginx:1.29-alpine
# Харднінг: одразу оновлюємо OS-пакети до останніх патчів (Trivy/CI вимога)
RUN apk upgrade --no-cache
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1/"]
CMD ["nginx", "-g", "daemon off;"]