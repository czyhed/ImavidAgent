#!/bin/bash
set -euo pipefail
cd /opt/shangjing-middleware
MINIO_TAG=RELEASE.2025-10-15T17-29-55Z
MC_TAG=RELEASE.2025-08-13T08-35-41Z
MINIO_COMMIT=$(curl -fsSL --retry 3 "https://api.github.com/repos/minio/minio/commits/$MINIO_TAG" | python3 -c 'import json,sys; print(json.load(sys.stdin)["sha"])')
MC_COMMIT=$(curl -fsSL --retry 3 "https://api.github.com/repos/minio/mc/commits/$MC_TAG" | python3 -c 'import json,sys; print(json.load(sys.stdin)["sha"])')
curl -fsSL --retry 3 "https://codeload.github.com/minio/minio/tar.gz/$MINIO_COMMIT" -o sources/minio.tar.gz
curl -fsSL --retry 3 "https://codeload.github.com/minio/mc/tar.gz/$MC_COMMIT" -o sources/mc.tar.gz
printf 'MINIO_TAG=%s\nMINIO_COMMIT=%s\nMC_TAG=%s\nMC_COMMIT=%s\n' "$MINIO_TAG" "$MINIO_COMMIT" "$MC_TAG" "$MC_COMMIT" > sources/versions.txt
sha256sum sources/*.tar.gz > sources/SHA256SUMS
docker build --progress=plain --build-arg "MINIO_COMMIT=$MINIO_COMMIT" -f minio.Dockerfile -t "shangjing/minio:$MINIO_TAG" .
docker image inspect "shangjing/minio:$MINIO_TAG" --format '{{.Id}}' > sources/image-id.txt
touch .minio-build-complete
echo MINIO_BUILD_COMPLETE
