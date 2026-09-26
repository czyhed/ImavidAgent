FROM golang:1.26-bookworm AS build
ENV GOMAXPROCS=4 CGO_ENABLED=0
WORKDIR /src/minio
COPY sources/minio.tar.gz /tmp/minio.tar.gz
RUN tar -xzf /tmp/minio.tar.gz --strip-components=1 -C /src/minio
ARG MINIO_COMMIT
RUN go build -p 4 -trimpath -ldflags "-s -w -X github.com/minio/minio/cmd.Version=2025-10-15T17:29:55Z -X github.com/minio/minio/cmd.ReleaseTag=RELEASE.2025-10-15T17-29-55Z -X github.com/minio/minio/cmd.CommitID=${MINIO_COMMIT}" -o /out/minio .
WORKDIR /src/mc
COPY sources/mc.tar.gz /tmp/mc.tar.gz
RUN tar -xzf /tmp/mc.tar.gz --strip-components=1 -C /src/mc
RUN go build -p 4 -trimpath -ldflags "-s -w" -o /out/mc .

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/minio /usr/local/bin/minio
COPY --from=build /out/mc /usr/local/bin/mc
EXPOSE 9000 9001
ENTRYPOINT ["minio"]
