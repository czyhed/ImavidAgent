# 商境应用部署工件

本目录只包含应用容器、TLS 与 nginx 的部署文件，不含任何真实密钥、连接串或 `.env`。
完整步骤见 [docs/infrastructure/app-deployment.md](../../docs/infrastructure/app-deployment.md)。

| 文件 | 用途 |
| --- | --- |
| `Dockerfile` | Node 24 多阶段构建；运行 `node server/index.mjs`，非 root 用户 `node`，健康检查 `GET /` |
| `compose.yaml` | 单服务 `app`，`env_file: .env.app`，仅映射 `127.0.0.1:4173:4173` |
| `compose.host-network.yaml` | 临时覆盖：入口未支持 `SJ_LISTEN_HOST` 时用 host 网络保证回环可达 |
| `.env.app.example` | 环境变量模板，只有变量名与说明 |
| `nginx-shangjing.conf` | 独立 8443 vhost，反代 `127.0.0.1:4173` |
| `tls-issue.sh` | 用项目 CA 签发带 IP SAN 的服务证书 |
| `deploy.sh` | 幂等部署：构建、启动、健康检查、安装 vhost、重载 nginx |

## 与主分支的接口约定（待统一实现）

### 1. Host 白名单：当前代码已支持

`server/http.mjs` 已从 `SJ_ALLOWED_HOSTS`（逗号分隔，`host:port`）追加允许的主机，
`SJ_PUBLIC_ORIGIN` 用于额外放行浏览器 `Origin`，因此**不需要再改代码**。
部署时必须在 `.env.app` 中提供：

```dotenv
SJ_ALLOWED_HOSTS=203.0.113.10:8443,203.0.113.11:8443
SJ_PUBLIC_ORIGIN=https://203.0.113.10:8443
```

nginx 使用 `Host $http_host` 保留端口，否则应用只看到 `203.0.113.10`，
与浏览器发送的 `Origin: https://203.0.113.10:8443` 不一致，写操作会被 `ORIGIN_DENIED` 拒绝。

如果后续修改为不带端口比较，请同步调整 `.env.app` 与本文档，避免两处规则漂移。

### 2. 监听地址：需要主分支补丁（**当前部署阻塞点**）

`server/index.mjs` 已支持 `SJ_LISTEN_HOST`，默认仍为 `127.0.0.1`；
compose 在容器内固定 `SJ_LISTEN_HOST=0.0.0.0`、`PORT=4173`。
容器端口只映射到宿主 `127.0.0.1:4173`，公网访问只能经 nginx。

`deploy.sh` 检测到该变量后自动使用 bridge 网络；旧代码或无该变量时
退回 `compose.host-network.yaml`。也可用 `APP_NETWORK=host|bridge` 强制选择。

### 3. 首次管理员初始化与反代来源

`AuthService.setupAdmin` 只接受回环来源，并拒绝带 `X-Forwarded-For`、
`X-Real-IP` 或 `Forwarded` 的请求。应用位于 nginx 之后时，
`req.socket.remoteAddress` 恒为 `127.0.0.1`，因此 nginx 对
`POST /api/setup/admin` 直接返回 403，只有绕过代理、通过 SSH 隧道直连
`127.0.0.1:4173` 才能完成初始化。初始化完成后再公开 vhost。
后续如需支持远程初始化，应增加一次性初始化令牌，不能仅依赖 socket 地址。
