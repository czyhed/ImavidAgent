# 测试服务器与中间件接入

更新日期：2026-10-26。适用于商境项目开发与测试环境。

2026-10-26 后续修复已更新应用到 `d2cd6df`：大项目保存及视频参数问题已修复；最新数据库 / 配置 / 主密钥备份 `/opt/shangjing-app/backups/pre-video-fix-20261026T075546Z` 已隔离恢复。保留 5 商品 / 7 项目 / 37 素材 / 20 模板 / 16 历史运行 / 1 用户，中间件及其他服务未重启。用户项目的 13 个任务预览均通过，无付费生成。以下 B 版首发及 10 月 23 日记录保留为历史，精确版本见 [部署记录](app-deployment.md)。

2026-10-26 应用更新到 `2a0a89d`，全站 B 版与任务画布已上线；数据库、配置及渠道主密钥备份在 `/opt/shangjing-app/backups/pre-ui-deploy-20261026T063624Z`，已隔离恢复核验。中间件与其他服务未重启，现有业务保留。当前 WLAN 地址已改变，本机私密 SSH 配置已更新到网卡 22 / `192.168.112.197`，原配置留在本机忽略目录；主机密钥保持原指纹。以下 10 月 23 日记录为历史，当前运行状态见 [部署记录](app-deployment.md)。

## 2026-10-23 创作 v2 接入维护

应用已在 `https://203.0.113.10:8443` 运行创作 v2，精确提交 b988769f06eac67eb423342bec6b996beec27617；SJ_AUTH=on，4173 仅回环，0018 / 0019 已应用。TLS、健康与真实 PG / MinIO 无付费烟测通过。三个中间件继续使用下表版本、端口和账号；本次没有重建或重启中间件，没有清空共享库 / Redis / 桶。应用实际发布状态见 [STATUS](../STATUS.md) 和 [部署记录](app-deployment.md)。

MinIO 账号 `shangjing_app` 保留既有 `shangjing-app` 策略，新增权限仅为素材桶 `creation/*` 前缀的 `ListBucketVersions` 与 `DeleteObjectVersion`，用于 v2 手动永久删除全部版本。策略文件已更新并在服务端应用；旧策略备份 `/opt/shangjing-app/backups/creation-v2-20261022T140915Z/minio-policy.before.json`，应用账号启用与策略关联已核验。维护用 mc 显式 `SSL_CERT_FILE=/tls/CAs/ca.crt` 校验证书，不使用 `--insecure`；管理客户端临时配置和上传已清除。

维护窗口新数据库备份已在隔离库恢复核验，计数 6 商品 / 6 项目 / 6 生成任务 / 1 用户。归属及原清单核对通过后，已删除本应用 59 条旧测试业务、14 个已备份且逐一回读 SHA-256 的对象版本；保留账号 / 配置 / 预制模板，维护后旧计数为 0/0/0/1，不重复清理。原对象备份在 `/opt/shangjing-app/backups/creation-v2-20261022T140915Z/objects/`；新数据库 / 配置 / 渠道主密钥备份在同批次 `before-cleanup-20261023T004641Z`，由 `creation-v2-final.path` 指向。临时管理环境与烟测记录 / 脚本已清除。完整配置、账号密码与 SSH 仍仅在下述私密路径，不写入公开记录。备份目前同盘，后续需安全迁移至异机。

## 接续时先看这里

**PostgreSQL、Redis、MinIO 已安装并通过公网访问验证。** 用户明确授权公网直连，要求使用强密码。三个服务属于独立 Docker Compose 项目。2026-10-20 本机生图后端开始复用 PostgreSQL 和 MinIO；Redis 尚未用于业务队列，火山方舟尚未接入。模型接入与验证详见 [模型供应商接入](model-providers.md)。

1. 先读本文和根目录 `AGENTS.md`。
2. 应用配置读取根目录 `.env.middleware.local`；完整账号密码表在 `.secrets/middleware-access.local.md`。
3. 加载项目 CA 公共证书，使用 TLS 连接。不要关闭证书验证。
4. 使用应用账号；只有维护操作使用管理员账号。
5. 复用现有服务，不重复安装、不覆盖凭据、不清空数据。

## 实际访问地址

主地址 **203.0.113.10**。**203.0.113.11 是同一服务器的另一个公网 IP**，可以连接同一套服务，两者不是主备集群。

| 服务 | 公网地址 | 实际版本 | 应用账号 | 管理账号 |
| --- | --- | --- | --- | --- |
| PostgreSQL | `203.0.113.10:5432`，数据库 `shangjing`，必须 TLS | 17.11 | `shangjing_app` | `postgres` |
| Redis | `rediss://203.0.113.10:6379/0`，必须 TLS | 7.4.11 | `shangjing_app` | `admin` |
| MinIO S3 API | `https://203.0.113.10:9000` | RELEASE.2025-10-15T17-29-55Z | `shangjing_app` | `sj_minio_admin` |
| MinIO 控制台 | `https://203.0.113.10:9001` | 随 MinIO 构建 | 仅桶范围权限 | `sj_minio_admin` |

四个端口均绑定 `0.0.0.0`，UFW 已放行对应 TCP 端口。连接仍需 TLS 和账号认证；MinIO 登录页及健康检查可以匿名访问。把地址中的 `.254` 换为 `.235` 即可访问同一数据，证书覆盖两个 IP。

服务器是 Ubuntu 24.04.1 LTS，56 个逻辑 CPU，约 32 GiB 内存、464 GiB 根磁盘，部署前约 420 GiB 可用。已有 Docker 29.8.2、Compose v5.6.0，Docker 已启用开机启动。保留了服务器上其他项目的服务和数据。

## 密码和配置位置

每个应用/管理密码独立生成，使用 32 字节安全随机数，编码后为 43 个 URL 安全字符，具有 256 位随机熵。没有复用服务器 root 密码。

| 文件 | 用途 | 提交 Git |
| --- | --- | --- |
| `.secrets/middleware-access.local.md` | 人类可阅读的完整地址、账号、密码表 | 否 |
| `.env.middleware.local` | 应用实际连接配置和应用密码 | 否 |
| `.secrets/middleware-admin.json` | 各服务管理/应用密码的结构化来源 | 否 |
| `.secrets/server.json` | SSH 主机、端口、root 凭据和本机直连选项 | 否 |
| `.secrets/known_hosts` | 已记录的 SSH 主机公钥 | 否 |
| `.secrets/tls/ca.crt` | 项目 CA 公共证书，客户端需要信任 | 否，本工作区随连接配置管理 |
| `.secrets/tls/*.key` | CA 和服务端私钥，仅部署维护使用 | 否 |
| `.env.example` | 不含真实密码的配置模板 | 是 |
| `infra/middleware/` | 不含真实密码的部署、构建和备份配置 | 是 |

服务器部署配置和密码备份在 `/opt/shangjing-middleware/.env`，目录权限 `700`、文件权限 `600`。检查配置使用 `docker compose config --quiet`，不要执行会输出展开后的明文密码的 `docker compose config`。

切换同一工作区的智能体可以继续读取这些忽略的文件。换电脑或新克隆时，它们不会自动同步；需要安全迁移应用配置和 CA 公共证书，并更新本地证书路径。普通应用开发不需要 CA 私钥、服务端私钥或管理员密码。

2026-10-20 旧原型预览服务已移除，随后新增 `server/index.mjs` 作为真实生图后端，默认仅监听 `127.0.0.1:4173`。静态文件使用精确白名单，仅提供原型 HTML 和生图 JS/CSS；不提供项目根目录浏览、`.secrets/`、`.env`、后端源码或文档。模型 Key 单独保存在忽略文件 `.env.models.local`。

## TLS 与证书

证书由本项目私有 CA 签发，客户端必须显式信任。三个服务使用不同私钥，证书包含两个公网 IP、127.0.0.1、localhost 和对应 Compose 服务名。

- 三个中间件服务端证书到期：**2027-10-19 13:22:14 UTC，即北京时间 21:22:14**。
- 应用 nginx 8443 证书单独到期：**2027-11-22 14:42:56 UTC**，路径见 [app-deployment.md](app-deployment.md)。
- CA 到期：2036-10-16 13:22:14 UTC。
- CA SHA-256 指纹：`254974efc524a5cb5e8bb9fffc8e426b76dc5b302925c4f375293cd58bebda35`。
- 应用通过 `MIDDLEWARE_CA_CERT` / `PGSSLROOTCERT` 加载 CA；不要关闭证书校验。
- 本机 Windows PostgreSQL 客户端读取中文路径证书存在兼容问题，已将 CA 公共证书复制到 `%LOCALAPPDATA%\Shangjing\middleware\ca.crt`。实际环境文件已指向该路径，原件仍在 `.secrets/tls/ca.crt`。
- `remote.py` 的 `client_ca_path()` 可以重新生成公共证书副本，不复制私钥。
- 浏览器控制台会因私有 CA 提示证书不受信任。可将本项目 CA 导入当前用户受信任根证书库后访问；本次未自动修改系统证书信任库。

尚未设置自动续期。到期前应保留原 CA，签发并部署新服务端证书，校验文件 UID/权限，重启服务并运行验证脚本。`prepare.py` 会保留已有证书和密码，不能直接当成轮换工具。

## 组件使用约定

### PostgreSQL

- 项目数据库 `shangjing`，应用角色 `shangjing_app`。
- 应用角色拥有该数据库及 public schema，可执行项目迁移；不是超级用户，也没有创建其他数据库或角色的权限。
- TCP 必须 TLS，密码使用 SCRAM-SHA-256。容器内部 Unix socket 用于本机维护。
- 配置 `PGSSLMODE=verify-full` 和 CA。`DATABASE_URL` 不包含证书本地路径，不能只复制 URL 而遗漏证书设置。
- 数据目录 `/opt/shangjing-middleware/data/postgres`。
- 容器内存上限 2 GiB，shared_buffers 256 MiB，max_connections 100；项目连接池应控制总连接数。

### Redis

- DB 0，应用用户 `shangjing_app`；默认用户禁用。
- 应用键和 Pub/Sub 频道必须以 **`sj:`** 开头；应用禁止 CONFIG、ACL、FLUSHALL、FLUSHDB、SHUTDOWN 等管理命令。
- BullMQ 队列选项使用 `prefix: 'sj:bullmq'`，不要用 ioredis 的 `keyPrefix` 代替。
- 使用 `rediss://` 并设置 TLS CA。BullMQ Worker 按库要求单独设置连接的 `maxRetriesPerRequest: null`。
- 已开启 AOF（每秒 fsync）与 RDB，maxmemory 512 MiB、noeviction；达到上限会拒绝写入，需要处理错误并监控容量。
- 数据目录 `/opt/shangjing-middleware/data/redis`，容器内存上限 1 GiB。
- Redis 不是正式账本或任务的唯一事实来源；AOF everysec 不保证断电时零丢失。

### MinIO

- Region `us-east-1`，S3 客户端使用 path-style，例如 AWS SDK 的 `forcePathStyle: true`。
- 两个私有桶：`shangjing-assets` 保存原始素材、中间结果和成品，`shangjing-exports` 保存导出包；均已启用版本控制。
- 应用仅允许这两个桶的列举、对象读写、普通删除和分片上传相关操作，不能创建桶或执行管理操作。ListBuckets 可能返回权限过滤后的项目桶列表，这是 MinIO 的行为。
- 普通删除会留下删除标记，旧版本仍占用空间。本次未配置自动过期；后续实现彻底删除时必须覆盖历史版本并明确授权。
- 数据目录 `/opt/shangjing-middleware/data/minio`，容器内存上限 3 GiB。
- 不把长期 Access Key/Secret Key 发给浏览器；由后端鉴权后生成短期上传/下载链接。
- 火山方舟尚未接入。MinIO 已公网可达，但**不能假定火山方舟信任私有 CA 的 HTTPS URL**。模型接入时需提供公共 CA 签发的域名/网关，或验证所选模型的其他上传方式。

## Node 后端接入示例

以下是后续开发配置示例，不代表当前原型已集成。安全加载 `.env.middleware.local` 并安装相关客户端包后：

```js
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import Redis from 'ioredis';

const ca = readFileSync(process.env.MIDDLEWARE_CA_CERT, 'utf8');
const db = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl: { ca, rejectUnauthorized: true },
  max: 10,
});
const redis = new Redis(process.env.REDIS_URL, {
  tls: { ca, rejectUnauthorized: true },
});
// BullMQ Worker 另建 maxRetriesPerRequest: null 的连接，队列 prefix 使用 sj:bullmq。
```

S3 SDK 使用 `MINIO_ENDPOINT`、环境文件里的应用 Access Key/Secret Key、region `us-east-1`、path-style，并通过 HTTPS Agent 指定同一 CA。控制台 9001 端口不能当作 S3 API 使用。

## 本地验证命令

本工作区已创建独立 Python 环境 `.venv-middleware`，已被 Git 忽略。

```powershell
# 新电脑首次准备；本机不必重复
python -m venv .venv-middleware
.\.venv-middleware\Scripts\python.exe -m pip install -r scripts/middleware/requirements.txt

# 验证 TLS、权限和隔离测试数据的读写，不输出密码
.\.venv-middleware\Scripts\python.exe -u scripts/middleware/verify.py
.\.venv-middleware\Scripts\python.exe -u scripts/middleware/verify.py --host 203.0.113.11
```

脚本使用临时表、随机键和随机对象，并清理它们。清理版本化 MinIO 测试对象需要本地管理凭据，业务应用不应复用管理连接。

持久化演练：先运行 `verify.py --mode seed`，重启本项目三个容器，再运行 `verify.py --mode check-cleanup`。不要在有任务运行时随意重启。探针状态保存在 `.secrets/verification-state.json`，未清理前不能再次 seed。

## SSH 与代理排障

SSH 是 `root@203.0.113.10:22`，密码只在 `.secrets/server.json`。已记录的 ED25519 主机指纹：

```text
SHA256:lD7yVP1YKY5rQkRfv6gaR3RLjYoffZi/O8r8B0LeXqA
```

本机启用了 Meta/Clash TUN，默认路径最初在 SSH 握手前关闭连接。通过物理 WLAN 网卡直连后正常，最初失败不是密码错误。

```powershell
python scripts/middleware/remote.py 'uname -a'
python scripts/middleware/remote.py --script path/to/remote-script.sh
```

脚本依赖 Python/Paramiko，读取本地凭据，不把密码放在 SSH 命令参数中。首次采用首次信任记录主机密钥，后续拒绝密钥变化；不要直接删除记录跳过校验。

当前 `server.json` 的 `interface_index=22`、`source_address=192.168.1.111` 是本机 WLAN 配置。Windows socket 选项只约束此 SSH 连接，不关闭代理、不修改系统路由。换网络后用 `Get-NetIPConfiguration` 核对并更新；无 TUN 或非 Windows 环境可以删除两个字段。添加单主机临时路由的尝试因无管理员权限失败，未修改系统路由。

中间件公网访问不依赖 SSH 隧道。若服务健康而本机访问超时，先检查代理规则，并为这些 IP 使用 DIRECT 路径；不要因为超时直接重装服务或换密码。

## 维护命令和目录

部署目录 `/opt/shangjing-middleware`，Compose 项目名 `shangjing-middleware`。三个容器均配置 `restart: unless-stopped`、健康检查及日志轮转（10 MiB × 3）。

以下命令在服务器执行：

```sh
cd /opt/shangjing-middleware
docker compose ps
docker compose logs --tail 100 postgres redis minio
docker compose config --quiet
# 需要维护时启动或重启本项目服务
docker compose up -d --wait --wait-timeout 120
docker compose restart redis
```

不要清理全局 Docker 卷、删除数据目录或重启整个 Docker；服务器上还有其他项目。

主要配置：`compose.yaml`、`.env`、`postgres/pg_hba.conf`、`postgres/init-app.sh`、`redis/redis.conf`、`redis/users.acl`、`tls/`。PostgreSQL 初始化脚本只在空数据目录首次启动时执行。修改环境变量不会自动轮换已初始化数据库或 MinIO 密码，需通过服务管理操作轮换并同步本地凭据。

`prepare.py` 是部署准备脚本，遇到不同的远程 `.env` 会拒绝覆盖。日常开发不需要运行它。

## 备份与恢复

已生成并校验初始冷备份：

```text
/opt/shangjing-middleware/backups/full-20261019T133336Z.tar.gz
```

约 30 MiB，校验和在同名 `.sha256` 文件及 `deployment-record.json`。包含数据库、Redis、MinIO 历史版本、配置、密码和 TLS 私钥，归档权限 600，必须按敏感文件管理。

维护窗口执行后续备份：

```sh
cd /opt/shangjing-middleware
bash backup.sh
```

脚本只停止本项目三个服务，生成冷备份并验证归档可读性和 SHA-256，然后自动启动服务并等待健康。未设置自动定时任务或自动删除旧备份。同盘备份不能应对整机损坏；尚未复制到异机。

恢复应先在隔离目录/服务器验证：核验 SHA-256，按 numeric owner 恢复归档，准备相同版本镜像，确认端口、目录和权限，再启动及检查。PostgreSQL 物理备份要求兼容主版本，不能直接用新主版本启动旧数据。原地覆盖或删除当前数据需有明确的恢复授权。本次未进行异机灾难恢复演练。

## MinIO 构建来源

安装时官方 Quay 镜像返回 401，Docker Hub 镜像不可拉取，`dl.min.io` 二进制下载返回 410。因此从官方 GitHub 的固定源码版本构建，没有采用未知第三方镜像。

- MinIO tag：`RELEASE.2025-10-15T17-29-55Z`，commit `9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a`。
- mc tag：`RELEASE.2025-08-13T08-35-41Z`，commit `7394ce0dd2a80935aded936b09fa12cbb3cb8096`。
- 编译器 Go 1.26.9，运行底座 Debian bookworm-slim；遵循上游 AGPLv3 许可。
- 本地镜像：`shangjing/minio:RELEASE.2025-10-15T17-29-55Z`，不在公共镜像仓库。
- 实际镜像 ID、底座摘要及源码 SHA-256 在 `deployment-record.json`；服务器 `sources/` 保存源归档，`build-minio.log` 保存构建日志。
- 重建命令 `bash build-minio.sh`；构建完成不自动替换现有容器。
- 源码版本固定，Docker 底座使用版本标签，重建可能获取新补丁，因此不保证与第一次构建逐字节相同。

## 已完成验证

- PostgreSQL：两个公网 IP 的 TLS、应用读写、非超级用户、错误密码和明文连接拒绝。
- Redis：两个公网 IP 的 TLS、读写、错误密码拒绝、键前缀和管理命令限制。
- MinIO：上传下载、签名链接、匿名对象访问拒绝、错误密钥拒绝、应用禁止创建桶、私有桶及版本控制、HTTPS 控制台及管理账号登录。
- 三个容器重启后数据仍可读取，隔离测试数据已清理。
- 初始冷备份可读、校验和正确，备份后三个容器均恢复 healthy。
- 本地凭据已被 Git 忽略，非忽略文件中未发现真实密码；部署时验证过旧本地静态服务拒绝访问凭据路径，该服务已于 2026-10-20 随原型清理移除。

未重启整台服务器，未执行异机灾难恢复，未接入火山方舟。2026-10-20 已新增本机生图业务对 PostgreSQL 和 MinIO 的接入；原中间件部署验收与非私密部署元数据见 [deployment-record.json](deployment-record.json)。

## 生图业务新增数据（2026-10-20）

- PostgreSQL 17.11、端口 5432、应用账号 `shangjing_app` 保持不变。新增 `public.sj_generation_jobs` 表及状态索引，保存模型/参数快照、任务状态、上游任务编号、源版本关系和私有对象路径；没有修改已有业务表或清空数据。
- MinIO API 端口 9000、应用账号 `shangjing_app` 保持不变。生成图片存入私有桶 `shangjing-assets` 的 `generation/<任务 UUID>/result.<扩展名>`。浏览器通过本机后端读取，不能获得 MinIO 长期密钥。
- 使用项目 CA 验证两个服务的 TLS。真实生图验证已完成一张图片的记录、转存、浏览器预览与下载，服务重启后仍可读取。
- 当前单进程任务服务用 PostgreSQL 队列和专用 advisory lock 保持一个执行器，未引入 Redis/BullMQ；未来启用时仍须遵循 `sj:` / `sj:bullmq` 约定。
- 任务与图片纳入后续 PostgreSQL/MinIO 冷备份；2026-10-19 的旧备份不含此次新增数据。本次未停机制作新冷备份，维护窗口按既有 `backup.sh` 操作。`.env.models.local` 在本机，需另行安全备份。
