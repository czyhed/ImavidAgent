# syntax=docker/dockerfile:1
# 商境应用镜像：Node 24 多阶段构建。
# 构建阶段生成 web/dist；运行阶段只带生产依赖、服务端代码和静态白名单所需文件。
# 不复制 .secrets/、.env*、tests/、docs/，配置一律在运行期通过 env_file 注入。

FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV CI=true
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY vite.config.js ./
COPY web ./web
COPY shared ./shared
RUN npm run build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=4173
# ffmpeg / ffprobe 用于视频分镜拼接成片（服务端转码，不调用模型）；fonts-wqy-microhei 提供中文字体，用于把字幕烧录进成片。
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-wqy-microhei \
 && fc-cache -f \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
# server/ 包含 migrations/ 与 routes/，运行时动态读取，必须整体复制。
COPY --from=build --chown=node:node /app/web/dist ./web/dist
# CreationLifecycle reads the preset seed definitions at server startup.
COPY --chown=node:node web/src/lib/templates.js ./web/src/lib/templates.js
COPY --chown=node:node server ./server
COPY --chown=node:node shared ./shared
COPY --chown=node:node prototype ./prototype
COPY --chown=node:node config ./config
# 渠道加密主密钥在未设置 CHANNEL_ENCRYPTION_KEY 时会写入 /app/.secrets；
# 目录属主保持 node，compose 用命名卷持久化，重建镜像不会丢密钥。
RUN mkdir -p /app/.secrets && chown node:node /app/.secrets && chmod 700 /app/.secrets
USER node
EXPOSE 4173
# 健康检查只请求 GET /（应用静态白名单首页），不触发任何计费接口。
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4173) + '/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "server/index.mjs"]
