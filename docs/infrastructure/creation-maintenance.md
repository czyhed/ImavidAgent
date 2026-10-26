# 创作工作台 v2 维护与旧测试数据清理

2026-10-22。范围依据 FUNCTIONAL_SPEC.md §5、grill-me Q41/Q43。本文是操作规程，实际执行结果记录在 STATUS.md 和发布记录。

## 发布前验证

- 三路 worktree 提交后由主分支集成，运行单元、独立 PostgreSQL、供应商 HTTP 协议模拟和整站浏览器检查。
- 不通过真实付费任务验证；MiniMax H3 首帧使用服务器读取的图片字节编码 Data URL，不外传私有 MinIO 地址。
- 提交推送完成后以精确提交构建镜像，保留当前镜像标签和旧源码归档供回退。
- 应用单实例执行，PostgreSQL advisory 锁保证不会并行启动第二个执行器。

## 授权清理范围

旧业务表、非模板素材索引、已登记生成文件、商品原图/截图与导出包。保留账号、角色、会话、渠道及加密密钥、模型配置、预制模板、架构和中间件。旧审计保留，追加最小清理审计。清理不属于迁移或自动启动步骤。

`server/legacy-cleanup.mjs` 使用显式表清单，不使用 CASCADE，不清数据库/Redis/桶。预览保存表数量及完整行指纹，执行时锁表重新校验；新增、删除或原地修改都会中止。对象键只接受旧应用 generation/products/screenshots/exports UUID 前缀。

## 维护窗口顺序

1. 停本应用执行器，保留 PostgreSQL/Redis/MinIO 和其他应用。确认没有新业务写入。旧 unknown 记录只保留备份，不因清理重新提交付费请求。
2. `pg_dump` 项目数据库；验证完整性并在隔离数据库恢复演练。备份 `.env.app`、渠道加密主密钥和精确旧镜像/源码。文件目录 root-only，凭据不输出。
3. 运行 `cleanup-legacy.mjs --plan <私密目录>/legacy.json`。检查归属与预览。设置 `SJ_MAINTENANCE_DIR` 指向该私密目录。
4. 用仅维护窗口可用的 MinIO 管理连接运行 `legacy-files.mjs --plan ... --backup <私密目录>/objects`。按精确对象键备份全部版本及删除标记，写 SHA-256 清单并读回校验。不会按前缀递归删除邻居对象。
5. 在已有用户授权基础上，显式设置 `SJ_LEGACY_CLEANUP_AUTHORIZED=2026-10-22-all-old-test-data`，运行数据库清理 `--apply`。成功后生成 `.files-pending`；无该清单不能清理对象。
6. 对象清理 `legacy-files.mjs --plan ... --backup ... --delete`：复核备份字节校验及版本集合，只删除精确键的全部版本/删除标记，结束后验证为空。失败保留清单；允许已备份版本部分删除后的续跑，拒绝新版本。
7. 通过应用账号更新 MinIO 最小策略：只在 `shangjing-assets/creation/*` 增加 ListBucketVersions / DeleteObjectVersion。旧文件一次性清理由维护账号完成，浏览器永远不接触管理凭据。
8. 部署精确提交，验证容器、TLS、登录、五菜单、模型目录、空白旧业务和预制模板。只做免费 CRUD/读取烟测。

## 回收站与长期维护

没有自动过期机制。商品、项目、素材只在用户手动移入后隐藏；恢复仍需用户操作。管理员先预览永久删除影响，再确认。引用与 deletionPending 在同工作区事务锁内校验；有生成中/未知任务的项目不能移入。永久删除时清除所有对象版本，最小用量通过 `creation.retained-cost` 审计保留。

新创作文件 `creation/<工作区哈希>/<UUID>.<扩展名>`，只使用私有 shangjing-assets；下载/视频 Range 都经过同源会话鉴权。可选签名媒体地址需要独立可信 TLS 和签名密钥，当前 H3 首帧不依赖此网关。

渠道密钥 AES-256-GCM 存 PostgreSQL，主密钥在 app-secrets 卷。必须与数据库一起备份。初始环境渠道仅引导一次，删除后不会因重启复活。同步目录失败保留已配置项；不自动替换默认模型。

同盘备份无法抵御整机损坏，需另行安全复制到异机；恢复时先在隔离环境验证。
