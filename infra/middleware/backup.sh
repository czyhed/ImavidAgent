#!/bin/bash
# Maintenance-window backup: stops only this project's three services briefly.
set -euo pipefail
umask 077
cd /opt/shangjing-middleware
exec 9>/opt/shangjing-middleware/.backup.lock
flock -n 9 || { echo 'Another backup is running' >&2; exit 1; }
stamp=$(date -u +%Y%m%dT%H%M%SZ)
archive="backups/full-$stamp.tar.gz"
restart_services() { docker compose up -d --wait --wait-timeout 120; }
trap restart_services EXIT
docker compose stop postgres redis minio
tar --numeric-owner -czf "$archive.partial" \
  data tls postgres redis compose.yaml .env minio.Dockerfile .dockerignore \
  minio-policy.json init-minio.sh build-minio.sh sources backup.sh .shangjing-managed
tar -tzf "$archive.partial" >/dev/null
mv "$archive.partial" "$archive"
sha256sum "$archive" > "$archive.sha256"
echo "Backup created: /opt/shangjing-middleware/$archive"
echo 'Contains credentials and private keys; keep root-only. Copy securely off this server for disaster recovery.'
