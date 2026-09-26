"""Generate a human-readable credential sheet ONLY in the ignored secrets folder."""
import json
from remote import SECRETS, client_ca_path

credentials = json.loads((SECRETS / "middleware-admin.json").read_text())
rows = [
    ("PostgreSQL 应用", "203.0.113.10:5432 / shangjing", "shangjing_app", "POSTGRES_APP_PASSWORD"),
    ("PostgreSQL 管理", "203.0.113.10:5432 / postgres", "postgres", "POSTGRES_ADMIN_PASSWORD"),
    ("Redis 应用", "203.0.113.10:6379 / DB 0", "shangjing_app", "REDIS_APP_PASSWORD"),
    ("Redis 管理", "203.0.113.10:6379 / DB 0", "admin", "REDIS_ADMIN_PASSWORD"),
    ("MinIO 应用", "https://203.0.113.10:9000", "shangjing_app", "MINIO_APP_PASSWORD"),
    ("MinIO 管理/控制台", "https://203.0.113.10:9001", "sj_minio_admin", "MINIO_ADMIN_PASSWORD"),
]
text = """# 测试中间件访问账号（本地私密文件）

不要提交 Git、复制到公开文档或打印到自动化日志。

主地址：203.0.113.10。203.0.113.11 是同一台服务器的另一个 IP，两者不是主备集群。

所有服务通过公网 TLS 访问。各密码独立，以 32 字节随机数生成（256 位随机熵）。

| 用途 | 地址 | 用户名 / Access Key | 密码 / Secret Key |
| --- | --- | --- | --- |
"""
for label, endpoint, user, key in rows:
    text += f"| {label} | {endpoint} | `{user}` | `{credentials[key]}` |\n"
text += f"""
应用环境文件：项目根目录 `.env.middleware.local`。

CA 证书：`{client_ca_path().as_posix()}`，项目原件 `.secrets/tls/ca.crt`。

浏览器访问控制台前，需要信任此项目 CA，或在受控测试环境核对证书后处理浏览器的证书提示。SDK 应配置 CA，不能关闭证书校验。

Redis 应用账号仅允许 `sj:*` 键和频道；BullMQ 队列前缀使用 `sj:bullmq`。

MinIO 应用账号仅允许 `shangjing-assets`、`shangjing-exports` 两个桶的业务操作。它不是管理账号；管理操作使用 `sj_minio_admin`。

服务器 SSH 管理凭据见同目录 `server.json`；服务器上的部署配置及密码备份在 `/opt/shangjing-middleware/.env`（root 可读）。

完整状态、验证、维护、备份、证书到期时间见 `docs/infrastructure/test-middleware.md`。
"""
(SECRETS / "middleware-access.local.md").write_text(text, encoding="utf-8")
print("Private credential sheet generated; no passwords printed.")
