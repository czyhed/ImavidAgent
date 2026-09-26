#!/bin/sh
set -eu
mc --config-dir /tmp/mc alias set local https://minio:9000 sj_minio_admin "$MINIO_ADMIN_PASSWORD" >/dev/null
mc --config-dir /tmp/mc mb --ignore-existing local/shangjing-assets local/shangjing-exports
mc --config-dir /tmp/mc anonymous set none local/shangjing-assets
mc --config-dir /tmp/mc anonymous set none local/shangjing-exports
mc --config-dir /tmp/mc version enable local/shangjing-assets
mc --config-dir /tmp/mc version enable local/shangjing-exports
mc --config-dir /tmp/mc admin user add local shangjing_app "$MINIO_APP_PASSWORD"
mc --config-dir /tmp/mc admin policy create local shangjing-app /config/minio-policy.json
mc --config-dir /tmp/mc admin policy attach local shangjing-app --user shangjing_app
