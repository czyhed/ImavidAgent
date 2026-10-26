#!/usr/bin/env bash
# 商境应用生产部署脚本（幂等，可重复执行）。
#
# 只操作 Compose 项目 shangjing-app：
#   - 构建镜像、启动/更新应用容器、等待健康检查通过、安装并重载 nginx vhost。
#   - 不启动、不重启、不删除 shangjing-middleware 的 PostgreSQL/Redis/MinIO
#     容器、数据目录或数据卷；不执行 docker system prune / volume prune。
#
# 用法（服务器 root 或具备 docker 权限的运维账号）：
#   APP_DIR=/opt/shangjing-app bash infra/app/deploy.sh
#
# 常用开关：
#   APP_DIR=/opt/shangjing-app        部署目录（默认 /opt/shangjing-app）
#   APP_NETWORK=auto|host|bridge      网络模式；auto 在代码缺少 SJ_LISTEN_HOST 时用 host
#   SKIP_BUILD=1                      跳过镜像构建，直接启动现有标签
#   SKIP_NGINX=1                      只部署应用，不安装/重载 nginx
#   NGINX_VHOST_DIR=...               宝塔 vhost 目录
#   NGINX_BIN=...                     nginx 可执行文件
#
# 前置条件：
#   - /opt/shangjing-app/.env.app 已按 .env.app.example 填好（权限 600）
#   - 项目 CA 公共证书在 /opt/shangjing-app/tls/authority/ca.crt（或由环境指定）
#   - 已运行 tls-issue.sh 生成 /opt/shangjing-app/tls/server.crt|server.key
#   - 已确认 UFW 放行 8443/tcp
set -Eeuo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_DIR="${APP_DIR:-/opt/shangjing-app}"
ENV_FILE="${APP_ENV_FILE:-$APP_DIR/.env.app}"
CA_PATH="${MIDDLEWARE_CA_HOST_PATH:-$APP_DIR/tls/authority/ca.crt}"
TLS_CRT="$APP_DIR/tls/server.crt"
TLS_KEY="$APP_DIR/tls/server.key"
NGINX_VHOST_DIR="${NGINX_VHOST_DIR:-/www/server/panel/vhost/nginx}"
NGINX_VHOST="$NGINX_VHOST_DIR/shangjing-app.conf"
NGINX_SOURCE="$REPO_DIR/infra/app/nginx-shangjing.conf"
HEALTH_URL="http://127.0.0.1:4173/"
MIDDLEWARE_PROJECT="shangjing-middleware"

log() { printf '[deploy] %s\n' "$*"; }
warn() { printf '[deploy] 警告：%s\n' "$*" >&2; }
die() { printf '[deploy] 错误：%s\n' "$*" >&2; exit 1; }
COMPOSE=()

on_error() {
  local code="$1"
  trap - ERR
  printf '\n[deploy] 部署失败（退出码 %s）。\n' "$code" >&2
  printf '[deploy] 最近 200 行应用日志：\n' >&2
  if [ "${#COMPOSE[@]}" -gt 0 ]; then
    "${COMPOSE[@]}" logs --tail=200 app >&2 || true
  fi
  printf '[deploy] 完整日志：docker compose -f %s/infra/app/compose.yaml logs -f app\n' "$REPO_DIR" >&2
  printf '[deploy] 日志驱动 json-file，单文件 10 MiB、保留 3 个；未触碰 %s 的容器与数据。\n' "$MIDDLEWARE_PROJECT" >&2
  exit "$code"
}
trap 'on_error $?' ERR

# ---------- 前置检查 ----------
command -v docker >/dev/null 2>&1 || die "未找到 docker。"
docker compose version >/dev/null 2>&1 || die "未找到 docker compose 插件。"
[ -d "$REPO_DIR/server" ] || die "仓库目录不正确：$REPO_DIR"
[ -f "$ENV_FILE" ] || die "缺少环境文件：$ENV_FILE（从 infra/app/.env.app.example 复制）"
[ -r "$CA_PATH" ] || die "缺少项目 CA 公共证书：$CA_PATH"

if stat -c '%a' "$ENV_FILE" 2>/dev/null | grep -qvE '^(600|640)$'; then
  warn "$ENV_FILE 权限大于 640，建议 chmod 600。"
fi
# 只检查非注释行，模板注释里的示例文字不算占位符。
if grep -vE '^[[:space:]]*#' "$ENV_FILE" | grep -qE 'REPLACE_WITH|CHANGE_ME|<公网IP>'; then
  die "$ENV_FILE 仍含占位符，请填入真实值后再部署。"
fi
if ! grep -qE '^SJ_AUTH=on([[:space:]]|$)' "$ENV_FILE"; then
  warn "SJ_AUTH 未明确设为 on；生产环境应开启账号鉴权。"
fi

# ---------- 网络模式 ----------
# server/index.mjs 当前固定监听 127.0.0.1；bridge 端口映射无法到达容器回环。
# 若主分支尚未加入 SJ_LISTEN_HOST，自动使用 host 网络覆盖文件，保留“仅本机可达”。
APP_NETWORK="${APP_NETWORK:-auto}"
if [ "$APP_NETWORK" = "auto" ]; then
  if grep -q 'SJ_LISTEN_HOST' "$REPO_DIR/server/index.mjs"; then
    APP_NETWORK=bridge
  else
    APP_NETWORK=host
  fi
fi
case "$APP_NETWORK" in
  host)
    warn "server/index.mjs 未支持 SJ_LISTEN_HOST，本次使用 host 网络；应用仅监听宿主 127.0.0.1:4173。"
    ;;
  bridge)
    if ! grep -q 'SJ_LISTEN_HOST' "$REPO_DIR/server/index.mjs"; then
      die "指定了 APP_NETWORK=bridge，但入口仍硬编码 127.0.0.1，端口映射不可达。请改用 host 或先合入 SJ_LISTEN_HOST 补丁。"
    fi
    ;;
  *) die "APP_NETWORK 只能是 auto、host 或 bridge。" ;;
esac

COMPOSE=(docker compose --project-name shangjing-app --env-file "$ENV_FILE"
  -f "$REPO_DIR/infra/app/compose.yaml")
if [ "$APP_NETWORK" = "host" ]; then
  COMPOSE+=(-f "$REPO_DIR/infra/app/compose.host-network.yaml")
fi

export APP_ENV_FILE="$ENV_FILE"
export APP_SOURCE_DIR="$REPO_DIR"
export MIDDLEWARE_CA_HOST_PATH="$CA_PATH"

log "仓库：$REPO_DIR"
log "部署目录：$APP_DIR"
log "网络模式：$APP_NETWORK"
log "只操作 Compose 项目 shangjing-app；不会改动 $MIDDLEWARE_PROJECT 的容器、数据目录或数据卷。"
if docker ps --format '{{.Names}}' | grep -q '^shangjing-middleware'; then
  log "已检测到 $MIDDLEWARE_PROJECT 容器，本脚本不会重启它们。"
fi

# ---------- 配置校验 ----------
"${COMPOSE[@]}" config --quiet
log "compose 配置校验通过。"

# ---------- 构建 ----------
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  log "构建镜像（构建上下文：$REPO_DIR）..."
  "${COMPOSE[@]}" build --pull app
  log "镜像构建完成。"
else
  log "SKIP_BUILD=1，跳过构建。"
fi

# ---------- 启动 ----------
"${COMPOSE[@]}" up -d --wait --wait-timeout 180 app
log "容器已启动并通过 compose 健康检查。"

# ---------- 应用健康检查 ----------
healthy=0
for _ in $(seq 1 30); do
  if command -v curl >/dev/null 2>&1; then
    if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then healthy=1; break; fi
  elif "${COMPOSE[@]}" exec -T app node -e \
    "fetch('$HEALTH_URL').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" >/dev/null 2>&1; then
    healthy=1; break
  fi
  sleep 2
done
[ "$healthy" = "1" ] || die "GET $HEALTH_URL 未通过，请查看上方日志。"
log "GET / 健康检查通过。"

# ---------- nginx ----------
if [ "${SKIP_NGINX:-0}" = "1" ]; then
  log "SKIP_NGINX=1，跳过 nginx 安装与重载。"
  "${COMPOSE[@]}" ps
  exit 0
fi

if [ ! -s "$TLS_CRT" ] || [ ! -s "$TLS_KEY" ]; then
  warn "缺少 $TLS_CRT / $TLS_KEY，跳过 nginx 配置。"
  warn "先运行：APP_DIR=$APP_DIR bash $REPO_DIR/infra/app/tls-issue.sh"
  warn "再重新执行本脚本，或手动安装 $NGINX_SOURCE。"
  "${COMPOSE[@]}" ps
  exit 0
fi

[ -d "$NGINX_VHOST_DIR" ] || die "nginx vhost 目录不存在：$NGINX_VHOST_DIR"

if command -v nginx >/dev/null 2>&1; then
  nginx_bin="${NGINX_BIN:-$(command -v nginx)}"
elif [ -x /www/server/nginx/sbin/nginx ]; then
  nginx_bin="${NGINX_BIN:-/www/server/nginx/sbin/nginx}"
else
  die "未找到 nginx 可执行文件，请设置 NGINX_BIN。"
fi

# APP_DIR 非默认路径时替换证书路径；不修改仓库中的模板。
tmp_conf="$(mktemp)"
trap 'rm -f "$tmp_conf"' EXIT
sed "s#/opt/shangjing-app#$APP_DIR#g" "$NGINX_SOURCE" > "$tmp_conf"

previous_conf=""
if [ -f "$NGINX_VHOST" ] && cmp -s "$tmp_conf" "$NGINX_VHOST"; then
  log "nginx vhost 无变化：$NGINX_VHOST"
else
  if [ -f "$NGINX_VHOST" ]; then
    backup_dir="$APP_DIR/backups/nginx"
    mkdir -p "$backup_dir"
    previous_conf="$backup_dir/shangjing-app.conf.$(date -u +%Y%m%dT%H%M%SZ)"
    cp -p "$NGINX_VHOST" "$previous_conf"
    log "已备份现有 vhost 到 $previous_conf"
  fi
  install -m 644 "$tmp_conf" "$NGINX_VHOST"
  log "已安装 vhost：$NGINX_VHOST"
fi

if ! "$nginx_bin" -t; then
  # 测试失败时恢复旧配置，避免留下无法 reload 的 vhost。
  if [ -n "$previous_conf" ]; then
    install -m 644 "$previous_conf" "$NGINX_VHOST"
    warn "nginx -t 失败，已恢复旧 vhost：$previous_conf"
  else
    rm -f "$NGINX_VHOST"
    warn "nginx -t 失败，已移除新安装的 vhost。"
  fi
  die "请检查证书路径与 $NGINX_SOURCE 后重试。"
fi
"$nginx_bin" -s reload
log "nginx 已重载。"

if command -v ufw >/dev/null 2>&1 && ! ufw status 2>/dev/null | grep -q '8443/tcp'; then
  warn "UFW 未显示 8443/tcp 放行；如需公网访问，请执行：ufw allow 8443/tcp"
fi

"${COMPOSE[@]}" ps
log "部署完成：https://<服务器公网IP>:8443（浏览器需信任项目 CA）。"
log "首次管理员请通过 SSH 隧道访问 http://127.0.0.1:4173 初始化，详见 docs/infrastructure/app-deployment.md。"
