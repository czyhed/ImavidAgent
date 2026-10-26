#!/usr/bin/env bash
# 用项目私有 CA 为商境应用签发带 IP SAN 的 TLS 服务证书。
# 只打印证书主题、有效期和 SAN；绝不打印或复制私钥内容。
#
# 用法（服务器 root）：
#   APP_DIR=/opt/shangjing-app bash infra/app/tls-issue.sh
#   FORCE=1 ... bash infra/app/tls-issue.sh   # 已有证书时强制轮换
#
# 默认读取 /opt/shangjing-middleware/tls/authority/ca.crt|ca.key；
# 写入 $APP_DIR/tls/server.crt|server.key，权限分别 644/600。
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/shangjing-app}"
CA_DIR="${CA_DIR:-/opt/shangjing-middleware/tls/authority}"
CA_CRT="$CA_DIR/ca.crt"
CA_KEY="$CA_DIR/ca.key"
TLS_DIR="$APP_DIR/tls"
DAYS="${DAYS:-397}"
FORCE="${FORCE:-0}"
OPENSSL="${OPENSSL:-openssl}"

log() { printf '[tls-issue] %s\n' "$*"; }
die() { printf '[tls-issue] 错误：%s\n' "$*" >&2; exit 1; }

command -v "$OPENSSL" >/dev/null 2>&1 || die "未找到 openssl。"
[ -r "$CA_CRT" ] || die "无法读取项目 CA 证书：$CA_CRT"
[ -r "$CA_KEY" ] || die "无法读取项目 CA 私钥：$CA_KEY（需要 root 且权限正确）"

if [ -s "$TLS_DIR/server.crt" ] && [ -s "$TLS_DIR/server.key" ] && [ "$FORCE" != "1" ]; then
  log "已存在服务证书，跳过签发（FORCE=1 可轮换）："
  "$OPENSSL" x509 -in "$TLS_DIR/server.crt" -noout -subject -dates -ext subjectAltName
  exit 0
fi

umask 077
mkdir -p "$TLS_DIR"
chmod 700 "$TLS_DIR"

# 旧证书先备份，失败时不覆盖正在使用的文件。
if [ -s "$TLS_DIR/server.crt" ] || [ -s "$TLS_DIR/server.key" ]; then
  backup_dir="$APP_DIR/backups/tls-$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$backup_dir"
  chmod 700 "$backup_dir"
  [ -f "$TLS_DIR/server.crt" ] && cp -p "$TLS_DIR/server.crt" "$backup_dir/server.crt"
  [ -f "$TLS_DIR/server.key" ] && cp -p "$TLS_DIR/server.key" "$backup_dir/server.key"
  log "旧证书已备份到 $backup_dir"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cat > "$tmp/openssl.cnf" <<'EOF'
[req]
distinguished_name = dn
prompt = no

[dn]
CN = 203.0.113.10
O = Shangjing

[ext]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = IP:203.0.113.10,IP:203.0.113.11,IP:127.0.0.1,DNS:localhost
EOF

"$OPENSSL" req -new -newkey rsa:3072 -nodes \
  -keyout "$tmp/server.key" -out "$tmp/server.csr" \
  -config "$tmp/openssl.cnf" >/dev/null 2>&1

# 用随机序列号，不要求 CA 目录可写，也不修改既有 ca.srl。
"$OPENSSL" x509 -req -in "$tmp/server.csr" \
  -CA "$CA_CRT" -CAkey "$CA_KEY" -set_serial "0x$("$OPENSSL" rand -hex 16)" \
  -days "$DAYS" -sha256 -extfile "$tmp/openssl.cnf" -extensions ext \
  -out "$tmp/server.crt" >/dev/null 2>&1

# 先验证再落盘，避免把无效或空证书装上 nginx。
[ -s "$tmp/server.crt" ] || die "证书签发失败，未替换现有文件。"
"$OPENSSL" verify -CAfile "$CA_CRT" "$tmp/server.crt" >/dev/null || die "新证书无法通过 CA 校验，未替换。"

install -m 600 "$tmp/server.key" "$TLS_DIR/server.key.new"
install -m 644 "$tmp/server.crt" "$TLS_DIR/server.crt.new"
mv -f "$TLS_DIR/server.key.new" "$TLS_DIR/server.key"
mv -f "$TLS_DIR/server.crt.new" "$TLS_DIR/server.crt"
chmod 600 "$TLS_DIR/server.key"
chmod 644 "$TLS_DIR/server.crt"

log "已签发：$TLS_DIR/server.crt / server.key（私钥未打印）"
"$OPENSSL" x509 -in "$TLS_DIR/server.crt" -noout -subject -issuer -dates -ext subjectAltName
log "浏览器和客户端仍需显式信任项目 CA（$CA_CRT）才能无警告访问。"
