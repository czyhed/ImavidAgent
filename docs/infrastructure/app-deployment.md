# 商境应用生产部署

更新日期：2026-10-26。本文描述把「商境」Node 服务以容器方式部署到 **203.0.113.10**
的方案与操作步骤。工件位于 [`infra/app/`](../../infra/app/)，本文不包含任何真实密码、
连接串或密钥；实际值只存在于服务器 `/opt/shangjing-app/.env.app` 与既有中间件凭据目录。

范围：**只新增应用容器与 8443 vhost**。PostgreSQL、Redis、MinIO 继续使用
[test-middleware.md](test-middleware.md) 中已部署的 `shangjing-middleware` 项目；
本方案不重复安装、不重启、不清空这些服务与数据。

首次部署前核对的服务器事实（下述端口空闲和防火墙未开放为历史状态）：Ubuntu 24.04，Docker 29.8.2 + Compose v5.6.0，
nginx 1.30.5（宝塔，vhost 目录 `/www/server/panel/vhost/nginx/`），**未安装 Node**；
8443 与 4173 端口空闲。UFW 当前放行 22/80/443/5432/6379/9000/9001，**未放行 8443**。
项目 CA 为 `/opt/shangjing-middleware/tls/authority/ca.crt|ca.key`
（CN `Shangjing Test Middleware CA`，pathlen 0），既有证书 SAN 覆盖
`203.0.113.11`、`203.0.113.10`、`127.0.0.1`、`localhost`。

## 当前发布：视频工作台界面重做（2026-10-27）

时间线 + 单镜编辑、工作台内加素材（自动建节点连线）、项目级分辨率 / 比例 / 时长（`storyboard.settings`）、连播预览、问题标记、手机端可编辑（W1—W8，见 [video-studio-layout-grilling.md](../requirements/video-studio-layout-grilling.md)）。无数据库迁移。

| 项目 | 实际结果 |
| --- | --- |
| 当前运行提交 | `154e07e31d42469b8daa8dff7eac5f00d63cadff` |
| 部署前备份 | `/opt/shangjing-app/backups/pre-studio-20261027T070516Z`（`database.dump` 287,747 字节）；指针 `backups/latest-studio.path` |
| 直接回退 | `shangjing/app:rollback-studio-20261027` 指向上一版 `a08d21239db786687040ff2d65ca505dfa001615` |

验证：容器 healthy，首页与 `/api/session` 200。本地 `npm test` 387/387、`test:creation` 142/142、浏览器全部套件、check / build 通过。

回退：`APP_IMAGE_TAG=rollback-studio-20261027 SKIP_BUILD=1 SKIP_NGINX=1 APP_DIR=/opt/shangjing-app bash /opt/shangjing-app/releases/a08d21239db786687040ff2d65ca505dfa001615/infra/app/deploy.sh`。旧版不认识 `storyboard.settings`，回退后分镜按节点自身参数生成。

## 上一发布：增量保存与加载提速（2026-10-27）

画布 / 视频工作台增量保存（`POST .../ops`、`GET .../status`），取消常驻轮询与整项目版本冲突；静态资源内容哈希 + 长缓存 + brotli，列表摘要，`Server-Timing` 与 `slow-api` 慢请求日志。无数据库迁移。

| 项目 | 实际结果 |
| --- | --- |
| 当前运行提交 | `a08d21239db786687040ff2d65ca505dfa001615` |
| 镜像 | `shangjing/app:a08d21239db786687040ff2d65ca505dfa001615`，`latest` 同步 |
| 发布目录 | `/opt/shangjing-app/releases/a08d21239db786687040ff2d65ca505dfa001615` |
| 部署前备份 | `/opt/shangjing-app/backups/pre-sync-20261027T050657Z`（`database.dump` 287,331 字节）；指针 `backups/latest-sync.path` |
| 直接回退 | `shangjing/app:rollback-sync-20261027` 指向上一版 `10d0f99c0281add210f333f397efeecbee6e7ce2` |

验证：容器 healthy；首页 `no-store`，`app-*.js` / `style-*.css` 返回 `immutable` + `br`（69 KB / 24 KB）；`/api/session` 200 且带 `Server-Timing`。本地合并后 `npm test` 372/372、`test:creation` 136/136、浏览器全部套件、check / build 通过。慢请求查看：`docker logs shangjing-app 2>&1 | grep slow-api`。

回退：`APP_IMAGE_TAG=rollback-sync-20261027 SKIP_BUILD=1 SKIP_NGINX=1 APP_DIR=/opt/shangjing-app bash /opt/shangjing-app/releases/10d0f99c0281add210f333f397efeecbee6e7ce2/infra/app/deploy.sh`。旧版前端仍用整项目 PATCH，数据格式不变，可直接回退。

## 上一发布：生视频重做与火山语音配音（2026-10-27）

按 `docs/requirements/video-storyboard-v2-grilling.md`（V-01～V-25）分五步实现：四种生成方式与素材引用、画布视频节点、分镜单一配置与批量生成、成片保留声音与 AI 分镜、火山语音配音与字幕。按既有流程提交推送、精确归档核验、备份后服务端构建；无数据库迁移。镜像新增 `fonts-wqy-microhei` 用于字幕烧录。

| 项目 | 实际结果 |
| --- | --- |
| 当前运行提交 | `10d0f99c0281add210f333f397efeecbee6e7ce2` |
| 镜像 | `shangjing/app:10d0f99c0281add210f333f397efeecbee6e7ce2`，`latest` 同步 |
| 发布目录 | `/opt/shangjing-app/releases/10d0f99c0281add210f333f397efeecbee6e7ce2` |
| 源码 SHA-256 | `219bce71bf19c0838068b20c4afa2d29f50792a8043a6764ce1897ca41503ebc`（服务器复核一致） |
| 部署前备份 | `/opt/shangjing-app/backups/pre-video-v2-20261026T173407Z`（`database.dump` 283,870 字节、旧指针与旧镜像 ID、SHA256SUMS）；指针 `backups/latest-video-v2.path` |
| 直接回退 | `shangjing/app:rollback-video-v2-20261027` 指向上一版 `7d16c97fe1b3ffe8c385c71b27873795bd4212d1` |

验证：容器 healthy；HTTPS 首页 200，`/api/session` 200，`/api/creation/projects`、`/api/creation/voices`、`/api/model-hub/video/balance` 未登录 401；容器内 `WenQuanYi Micro Hei` 字体与 ffmpeg `subtitles` 滤镜可用；前端包含全能参考、合成配音、烧录字幕、上一镜尾帧、生成全部分镜入口。用户项目用新代码只读读取：修订 223、43 个节点、10 个创作任务、18 条运行、8 个分镜，分镜字段已迁移为 `id/title/description/nodeId`，未改写数据。本地 `npm test` 353/353、`npm run test:creation` 121/121、浏览器 11 套通过。ffmpeg 5.1.9 一次性容器实测：尾帧截取（含 0.4 秒短视频）、成片有声 / 无声混合拼接、台词拼接与混音（原声压低、无声视频、超长截断）、中文字幕烧录（竖屏 720×1280、横屏 1920×1080）。

真实验收（用户已同意）：H3 全能参考方式、1 张参考图 + `<Picture 1>` 标签、480P、4 秒、1:1，42 秒成功，480×480 H.264 + AAC，可用积分 4791 → 4771（20 积分）；画面与参考图一致。火山语音：用户提供 API Key 后，经标准输入写入线上渠道 `ch_4af4d421d0035f53`（AES-256-GCM 加密，未写入文件或日志）并设为语音默认；系统音色与 `ICL_` 音色各合成一句 22 字台词成功，字幕时间戳换算正确，共 51 字符。

回退：`APP_IMAGE_TAG=rollback-video-v2-20261027 SKIP_BUILD=1 SKIP_NGINX=1 APP_DIR=/opt/shangjing-app bash /opt/shangjing-app/releases/7d16c97fe1b3ffe8c385c71b27873795bd4212d1/infra/app/deploy.sh`。旧版本不认识新的视频方式、端口与配音字段，回退后这些节点按旧逻辑处理。

## 历史发布：多张参考图与局部精修（2026-10-26）

生图参考图与改图原图可连接多张图片（每节点最多 8 张，上游生成节点各自固定版本）；结果图新增「局部精修」蒙版编辑，确认后新建连好线的改图节点并弹出执行预览。按既有流程提交推送、精确归档核验、备份后服务端构建；只重建应用，无数据库迁移。

| 项目 | 实际结果 |
| --- | --- |
| 当前运行提交 | `7d16c97fe1b3ffe8c385c71b27873795bd4212d1` |
| 镜像 | `shangjing/app:7d16c97fe1b3ffe8c385c71b27873795bd4212d1`，`latest` 同步 |
| 发布目录 | `/opt/shangjing-app/releases/7d16c97fe1b3ffe8c385c71b27873795bd4212d1` |
| 源码 SHA-256 | `25a2255d0ceac7ef9c1b25378adea76ac253b361660649fde0fa6a44158db377`（服务器复核一致） |
| 部署前备份 | `/opt/shangjing-app/backups/pre-refine-20261026T124902Z`（`database.dump` 270,417 字节、旧指针与旧镜像 ID、SHA256SUMS）；指针 `backups/latest-refine.path` |
| 直接回退 | `shangjing/app:rollback-refine-20261026` 指向上一版 `a817a339c20d1b425cc6715cbc7adf6dbd8f0486` |

验证：容器 healthy；HTTPS 首页 200，`/api/session` 200，受保护接口 401；线上 `CreationProjects.js` 含局部精修入口；用户项目只读核对为修订 203、43 个节点、9 个创作任务、18 条运行记录，部署未改动业务数据。本地 `npm test` 304/304、`npm run test:creation` 77/77、`npm run test:browser` 7 套通过。经用户授权，在线上容器内用 OMYAI `gpt-image-2.5-flare` 各真实调用一次：多图改图（JSON `image` 为 data URL 数组）HTTP 200、35 秒，两张输入图均进入结果；蒙版改图（JSON `mask` 为 data URL）HTTP 200、25 秒，仅透明区域被重绘。探针脚本与输出已清理。

回退：`APP_IMAGE_TAG=rollback-refine-20261026 SKIP_BUILD=1 SKIP_NGINX=1 APP_DIR=/opt/shangjing-app bash /opt/shangjing-app/releases/a817a339c20d1b425cc6715cbc7adf6dbd8f0486/infra/app/deploy.sh`。回退前注意：旧版本不认识 `sourceRunIds` / `maskAssetId`，已使用多参考图或蒙版的节点在旧版本中只会按单图处理。

## 历史发布：画布中文输入法修复（2026-10-26）

用户报告在已登录项目中输入中文提示词时出现大量拼音字母。根因是画布文本框为受控输入，输入法组字的每一步都被写入草稿并触发自动保存，保存 / 轮询再把值写回正在组字的输入框，打断组字并把拼音提交为正文。修复后组字期间只更新本地显示，组字结束或失焦才提交。按既有流程先提交推送、精确归档核验、备份后服务端构建；只重建应用，无数据库迁移，未执行旧项目清理。

| 项目 | 实际结果 |
| --- | --- |
| 当前运行提交 | `a817a339c20d1b425cc6715cbc7adf6dbd8f0486` |
| 镜像 | `shangjing/app:a817a339c20d1b425cc6715cbc7adf6dbd8f0486`，`latest` 同步 |
| 发布目录 | `/opt/shangjing-app/releases/a817a339c20d1b425cc6715cbc7adf6dbd8f0486` |
| 版本指针 | `RELEASE_COMMIT`、`current-release.path`、`.env.app` 的 `APP_IMAGE_TAG` 均已同步精确版本 |
| 源码 SHA-256 | `550c44e345b8595e43389aa17a5945e3e88feb5b53ba17e2c6cf7b47ed106c5a`（上传后服务器复核一致） |
| 部署前备份 | `/opt/shangjing-app/backups/pre-ime-fix-20261026T120326Z`（`database.dump` 256,271 字节、旧指针与旧镜像 ID、SHA256SUMS，权限 600）；指针 `backups/latest-ime-fix.path` |
| 直接回退 | `shangjing/app:rollback-ime-fix-20261026` 指向上一版 `d2cd6df42a5c339af71f728b74c9738dc5596bf0` |

验证：容器 healthy；项目 CA 校验 HTTPS 首页 200，`/api/session` 200，`/api/creation/projects` 与 `/api/model-hub` 401；线上 `CreationProjects.js` 含组字结束处理；用户项目只读核对为修订 165、36 个节点、9 个创作任务、9 条运行记录，部署未改动业务数据。本地 `npm test` 295/295、`npm run test:creation` 72/72、`npm run test:browser` 6 套通过（新增 `tests/creation-ime-browser.mjs`，含停顿超过自动保存间隔的拼音组字）。未创建付费任务。

回退：`APP_IMAGE_TAG=rollback-ime-fix-20261026 SKIP_BUILD=1 SKIP_NGINX=1 APP_DIR=/opt/shangjing-app bash /opt/shangjing-app/releases/d2cd6df42a5c339af71f728b74c9738dc5596bf0/infra/app/deploy.sh`，成功后同步版本指针与 `.env.app`。备份仍为同盘，异机副本待安全迁移。

## 历史发布：项目保存与视频参数修复（2026-10-26）

用户报告已登录项目的错误后，先上线 `5d1eb6a` 修复大项目保存 413，再上线 `d2cd6df` 修复视频参数规范化与错误显示。两次都先提交推送、精确归档核验、服务端构建及备份恢复验证，只重建应用；未执行旧项目清理，无数据库迁移，中间件和其他服务保持运行。

| 项目 | 实际结果 |
| --- | --- |
| 当前运行提交 | `d2cd6df42a5c339af71f728b74c9738dc5596bf0` |
| 镜像 | `shangjing/app:d2cd6df42a5c339af71f728b74c9738dc5596bf0`，`latest` 同步 |
| 镜像 ID | `sha256:1dfef3fcd568a6b55d0df02f44fffda522a527131e0291c871cc7608d4710ab1` |
| 发布目录 | `/opt/shangjing-app/releases/d2cd6df42a5c339af71f728b74c9738dc5596bf0` |
| 版本指针 | `RELEASE_COMMIT`、`current-release.path`、`.env.app` 的 `APP_IMAGE_TAG` 均已同步精确版本 |
| 源码 SHA-256 | `6d0a157fcf6b1abea1154c12c71e64c446d45bd8f2effffa80a7ddbb46b30de5` |
| 最新备份 | `/opt/shangjing-app/backups/pre-video-fix-20261026T075546Z`；指针 `backups/latest-video-fix.path` |
| 备份内容 | `database.dump`、`env.app`、`app-secrets.tar.gz`、旧指针 / 镜像 ID、归档 `source.tar.gz`；SHA256SUMS 通过，权限受限 |
| 恢复验证 | 既有 PostgreSQL 镜像、无网络、tmpfs 临时容器恢复成功并移除；5 商品 / 7 项目 / 37 素材 / 20 模板 / 16 运行 / 1 用户 |
| 直接回退 | `shangjing/app:rollback-video-fix-20261026` 指向保存修复 `5d1eb6a7b6d5291a974f195001e2cb2c9dcfdc9e`，镜像 ID `sha256:59c777f525e0507b6f1f493b1147af8e0c4bad5049e1572a971d9df2f535b181` |
| 首次保存修复备份 | `/opt/shangjing-app/backups/pre-save-fix-20261026T072606Z`；指针 `backups/latest-save-fix.path`，已独立恢复验证；源码归档 SHA-256 `ccff28606f2931f2f32b9076d23a9a3b949d0f195acfcf7eeea1e228d445a113` |
| 更早回退 | `shangjing/app:rollback-save-fix-20261026` 保留 B 版首发 `2a0a89d` 镜像；通常应优先回退到已有保存修复的 `5d1eb6a` |

线上应用 healthy，项目 CA 校验 HTTPS 首页及登录配图通过；归档与线上配图字节一致，共享模块可加载。在用户已登录的原项目内，原待保存内容已保存并刷新核验，13 个创作任务 / 52 个节点保留；逐项执行预览均 HTTP 200 / `canStart:true`，视频显示 1080P / 9:16 / 15 秒，未点击开始，运行记录前后为 0。本地验证为单元 295、创作集成 72、check（含 Vite build）、五套浏览器及最终完整画布回归；独立 QA 全部发现关闭。没有真实供应商调用，不能把 fixture H3 成功算作真实付费验收。

回退使用旧发布目录的 `infra/app/deploy.sh`，指定 `APP_IMAGE_TAG=rollback-video-fix-20261026 SKIP_BUILD=1 SKIP_NGINX=1 APP_DIR=/opt/shangjing-app`；成功后同步版本指针及 `.env.app`。回退应用前保全新写入，不自动恢复数据库。备份仍同盘，异机副本待安全迁移。

## 历史发布：全站 B 版与任务画布（2026-10-26）

用户明确授权部署上线；先提交推送，再按精确 SHA 归档、核对哈希并在服务器构建。此次只重建应用容器，nginx 配置不变，中间件及其他服务未重启，不执行旧项目清理脚本。

| 项目 | 实际结果 |
| --- | --- |
| 运行提交 | `2a0a89d592c57126a3df483d3b365d7b86957115` |
| 镜像 | `shangjing/app:2a0a89d592c57126a3df483d3b365d7b86957115`，`latest` 同步指向该镜像 |
| 镜像 ID | `sha256:2222186fca9dffd0f0806ee869ad9c0e8a030093a65b409937019fd58beee2cb` |
| 发布目录 | `/opt/shangjing-app/releases/2a0a89d592c57126a3df483d3b365d7b86957115` |
| 版本指针 | `RELEASE_COMMIT` 为完整 SHA；`current-release.path` 为上述绝对路径；`.env.app` 的 `APP_IMAGE_TAG` 固定完整 SHA |
| 源码归档 SHA-256 | `f3f5d9e26ae730966b3fab19ae230d437559618b416141c6a6e79c629fe1977f` |
| 部署前备份 | `/opt/shangjing-app/backups/pre-ui-deploy-20261026T063624Z`，由 `backups/latest-ui-deploy.path` 指向 |
| 数据库备份 | `database.dump`，206,657 字节，SHA-256 `b15967146fa431ef06c22bc815efd41b1d02906dec3fbdd15b6016d738b6b457` |
| 配套备份 | `env.app`、`app-secrets.tar.gz`、旧版本指针及 `previous-image.id`；权限受限，SHA256SUMS 校验通过 |
| 恢复验证 | 使用既有 PostgreSQL 镜像，在无网络、临时内存数据卷容器隔离恢复成功；验证后已移除该临时容器 |
| 业务保留 | 商品 / 项目 / 素材 / 模板 / 运行 / 用户为 `5 / 6 / 37 / 20 / 16 / 1`，发布前后相同；无新迁移、无清理、无付费生成 |
| 回退镜像 | `shangjing/app:rollback-ui-20261026` 保留原镜像 `sha256:a7c06b9fa892283209bfb7fea1b161c0abe1b10e745c387d718c0aea7bc2d098`；旧运行提交 `d75cdc06c5c796c1477fdb53bb1e5c2408f6aff5` |

线上验证：应用 healthy；经项目 CA 校验的 HTTPS 首页、app.js / CSS、项目 / 商品 / 模型分包及登录配图均 200，配图与归档字节一致，分包含任务列表和节点编辑器。临时五分钟管理员维护会话验证 session、overview、products、projects、assets、templates、trash、model-hub、users、audit-logs 十组读取及已有项目详情均 200；未登录受保护接口 401，缺 CSRF 写请求 403。维护会话在 finally 中删除并核实不存在。nginx 配置测试通过。未执行密码登录、真实模型生成或业务写入验收；这些不计入本次线上结果。

本次备份仍为同盘备份。应用回退可使用旧发布目录的 `deploy.sh`，指定 `APP_IMAGE_TAG=rollback-ui-20261026 SKIP_BUILD=1 SKIP_NGINX=1`；回退前核对新任务分组数据对旧界面的影响、保全新写入，不能自动恢复数据库。成功回退后同步 `.env.app` 与版本指针。

本机 SSH 已按当前 WLAN 更新私密源地址配置，主机公钥指纹不变。本次 SFTP 实测为真实根目录路径（非旧文档所述 chroot），上传归档经校验后归入上述备份目录；后续上传仍先核对映射。

## 历史 v2 发布记录（2026-10-23）

创作 v2 已上线 `https://203.0.113.10:8443`。原先的端口空闲 / 防火墙未开放描述仅为首次部署历史；当前 8443 已开放，4173 仅宿主回环。完整验收范围与部分受限分支见 [CREATION_ACCEPTANCE.md](../CREATION_ACCEPTANCE.md)。

| 项目 | 本次实际结果 |
| --- | --- |
| 运行提交 | `b988769f06eac67eb423342bec6b996beec27617`，先提交推送，再归档构建部署 |
| 后续源代码提交 | `5cc169e` 只增加测试和验收记录，运行代码与 b988769 一致；本文等文档后续提交无需重建应用 |
| 镜像 | `shangjing/app:b988769f06eac67eb423342bec6b996beec27617` |
| 镜像 ID | `sha256:62d318bd8da6aff5eb195ef499b608593cd43b95197b45abba9d5aab8ec7c149` |
| 发布目录 | `/opt/shangjing-app/releases/b988769f06eac67eb423342bec6b996beec27617` |
| 版本指针 | `/opt/shangjing-app/RELEASE_COMMIT`、`/opt/shangjing-app/current-release.path` |
| 迁移 / 鉴权 | 0018-creation.sql、0019-channel-executors.sql 已应用；`SJ_AUTH=on`，沿用已有管理员，无需再次初始化 |
| 健康 / 端口 | 应用 healthy，`127.0.0.1:4173`；nginx 8443 首页 / app.js 项目 CA 校验通过，nginx 配置测试 / reload 成功 |
| nginx 本次备份 | `/opt/shangjing-app/backups/nginx/shangjing-app.conf.20261023T004710Z` |
| 应用证书到期 | **2027-11-22 14:42:56 UTC**；中间件证书另于 **2027-10-19 13:22:14 UTC** 到期 |

维护窗口只停止应用。PostgreSQL / Redis / MinIO 和其他应用未重启；旧应用服务由同一 Compose 项目替换。0018 / 0019 只新增结构，旧数据清理是明确授权的独立维护步骤，现已完成。

### 备份、恢复验证与授权清理

- 原批次：`/opt/shangjing-app/backups/creation-v2-20261022T140915Z`。`objects/` 保存 14 个归属对象 / 14 版本字节，逐一回读 SHA-256 通过；`creation-v2-current.path` 指向原批次。
- 清理前新备份：该批次内 `before-cleanup-20261023T004641Z`，由 `/opt/shangjing-app/backups/creation-v2-final.path` 指向。数据库、应用配置和渠道加密主密钥卷已归档并生成 SHA 清单。新数据库备份已隔离恢复，商品 / 项目 / 生成任务 / 用户计数 `6 / 6 / 6 / 1`。
- 归属核对及原清单 digest 校验未漂移后，显式删除本应用 **59 条旧测试业务记录、14 个对象版本**。旧计数变为 `0 / 0 / 0 / 1`，保留账号权限、渠道密钥、模型配置、预制模板、结构、中间件及其他应用。**这次旧数据清理已执行，不重跑、不覆盖对象备份。**
- 备份位于同一磁盘，尚不能应对整机故障；异机副本需要安全迁移并校验。任何恢复先在隔离环境验证，按下文回退条件处理已有新写入。

MinIO 应用账号仍为 `shangjing_app`，既有 `shangjing-app` 策略仅增加 `shangjing-assets/creation/*` 范围的历史版本列举 / 删除权限。旧策略备份位于原批次 `minio-policy.before.json`。旧对象维护使用一次性管理员环境，完成后已移除；应用没有扩大到整桶 / 旧前缀的版本删除权限。

### 线上无付费烟测

8 组检查通过：TLS 与真实临时管理员会话 / CSRF、受保护集合读取、四环节默认配置、商品与画布 CRUD 持久化、引用阻止与回收站恢复、模板 CRUD 与当前管理员工作空间10个可用预制模板保留、真实 MinIO 64×64 PNG 上传 / 字节读回 / Range 206 / 全部对象版本永久删除、烟测记录清理与零生成运行。旧表仍为 `0 / 0 / 0 / 1`；新商品 / 项目 / 素材 / 回收站为空，未创建生成运行。

烟测用15分钟维护会话验证真实鉴权接口，finally 删除会话；临时脚本与一次性管理环境已移除。没有测试用户密码登录，没有发起付费图像 / H3 请求。首次无效测试图片被格式校验拒绝，修正为有效图片并按真实路由修正集合字段后，整轮通过；应用运行代码未因烟测修改。

生产配置包含 `MINIMAX_H3_API_KEY`，OMYAI 图像、DeepSeek 文本与 CompShare H3 从私密配置引导进入加密渠道。DeepSeek 默认只有 text；截图需管理员配置兼容的 text + vision 商品模型。新执行器安全 TLS 直连，忽略旧 `MODEL_HTTPS_PROXY`。H3 的协议与媒体管线已验证，真实付费成片仍未验收。

## 架构与端口

```text
浏览器 ── HTTPS 8443 (项目 CA 签发证书) ──> nginx 1.30.5（宝塔）
                                             │  proxy_pass Host=$http_host
                                             ▼
                                  127.0.0.1:4173（仅宿主回环）
                                             │
                                    Docker: shangjing-app
                                             │ TLS + 项目 CA
                       ┌─────────────────────┼─────────────────────┐
                       ▼                     ▼                     ▼
              PostgreSQL 5432        MinIO 9000            OMYAI（公网 HTTPS）
              Redis 6379（预留）      （私有桶）
```

| 项 | 值 |
| --- | --- |
| 公网入口 | `https://203.0.113.10:8443`、`https://203.0.113.11:8443`（同一台服务器） |
| nginx vhost | `/www/server/panel/vhost/nginx/shangjing-app.conf` |
| 应用容器 | Compose 项目 `shangjing-app`，容器名 `shangjing-app` |
| 应用监听 | 宿主 `127.0.0.1:4173`，公网不可直接访问 |
| 镜像 | `shangjing/app:<APP_IMAGE_TAG>`，默认 `latest` |
| 证书 | `/opt/shangjing-app/tls/server.crt`、`server.key`，项目 CA 签发 |
| CA | `/opt/shangjing-app/tls/authority/ca.crt`（只读挂载进容器） |
| 日志 | Docker `json-file`，单文件 10 MiB × 3；`docker compose logs app` |
| 数据 | 只在既有 PostgreSQL / MinIO；应用侧命名卷仅存渠道加密主密钥 |

**不占用 443**：宝塔现有 443 vhost 保持不变。8443 需要在 UFW 放行
（`ufw allow 8443/tcp`）；80/443 的既有放行与本方案无关。

## 服务器目录

```text
/opt/shangjing-app/
├── .env.app                 # 600，唯一应用配置（不提交、不打印）
├── tls/
│   ├── authority/ca.crt     # 项目 CA 公共证书，只读挂载
│   ├── server.crt           # 644，8443 服务证书
│   └── server.key           # 600，nginx 读取
├── backups/
│   ├── nginx/               # 被替换 vhost 的备份
│   ├── creation-v2-*/       # 维护前数据库 / 配置 / 主密钥 / 对象及校验清单
│   └── tls-*/               # 轮换前的旧证书
├── releases/<SHA>/         # 当前按精确提交归档构建的版本目录
├── RELEASE_COMMIT          # 当前运行提交
├── current-release.path    # 当前运行目录
└── src/                     # 可选：仓库检出目录，deploy.sh 所在仓库可在任意路径
```

仓库可以检出在任意目录（例如 `/opt/shangjing-app/src`），`deploy.sh`
会从自身位置推出仓库根目录；`APP_DIR` 只决定配置文件、TLS 与备份位置。

## 凭据与私密文件位置（只记录路径）

| 内容 | 位置 | 说明 |
| --- | --- | --- |
| 应用环境变量 | `/opt/shangjing-app/.env.app` | 600；数据库/MinIO/模型密钥、Host 白名单 |
| 项目 CA 公共证书 | `/opt/shangjing-app/tls/authority/ca.crt` | 来源 `/opt/shangjing-middleware/tls/authority/ca.crt` |
| CA 私钥 | `/opt/shangjing-middleware/tls/authority/ca.key` | 仅 `tls-issue.sh` 以 root 读取，不复制到应用目录 |
| 服务证书私钥 | `/opt/shangjing-app/tls/server.key` | 600，仅 nginx master 读取 |
| 渠道加密主密钥 | Docker 卷 `shangjing-app-secrets` 内 `.secrets/channel-encryption.key`，或 `.env.app` 的 `CHANNEL_ENCRYPTION_KEY` | 必须与 PostgreSQL 一起备份；丢失后动态渠道密钥不可恢复 |
| 中间件账号密码 | `.secrets/middleware-access.local.md`、`.secrets/middleware-admin.json`、服务器 `/opt/shangjing-middleware/.env` | 沿用既有管理方式，不复制进应用镜像或 `.env.app` 以外的位置 |

镜像构建上下文由根目录 [`.dockerignore`](../../.dockerignore) 排除
`.secrets/`、`.env*`、`tests/`、`docs/`、`scripts/`、`node_modules/` 与 `web/dist`。
运行期配置全部来自 `env_file`，**不把 `.env.app` COPY 进镜像**。

## 环境变量

完整清单与说明见 [`infra/app/.env.app.example`](../../infra/app/.env.app.example)。
部署前必须确认：

- `SJ_AUTH=on`（生产必须开启登录）；
- `SJ_ALLOWED_HOSTS` 含浏览器地址栏的 **host:port**，例如
  `203.0.113.10:8443,203.0.113.11:8443`；
- `SJ_PUBLIC_ORIGIN=https://203.0.113.10:8443`；
- `PGHOST`、`PGUSER`、`PGPASSWORD`、`MIDDLEWARE_CA_CERT=/run/shangjing/ca.crt`；
- `MINIO_ENDPOINT`、`MINIO_ACCESS_KEY`、`MINIO_SECRET_KEY`；
- `OMYAI_API_KEY`、`DEEPSEEK_API_KEY`、`MINIMAX_H3_API_KEY`；新执行器安全直连，不读取旧 `MODEL_HTTPS_PROXY`；
- `CHANNEL_ENCRYPTION_KEY`（建议显式提供）或依赖命名卷持久化。

`MIDDLEWARE_CA_HOST_PATH` 是 **compose 读取的宿主路径**，用于只读挂载；
`MIDDLEWARE_CA_CERT` 是 **容器内路径**，应用用它校验 PostgreSQL/MinIO。
两者不要写反。

## 首次部署

以下命令在服务器执行，假设仓库已检出（示例 `/opt/shangjing-app/src`）。

服务器的 SFTP 账号被 chroot 到 `/root`，不能直接写 `/opt`。上传文件先落到
`/root/` 暂存目录，再由 root 会话用 `install -m 600`（或 `install -m 644`）
移动到 `/opt/shangjing-app/`；不要在 `/root` 长期保留 `.env.app`、CA 或证书私钥。

```sh
# 0. 检出或上传代码（示例：git clone 到 /opt/shangjing-app/src）
#    SFTP 上传的 .env.app、证书等先放 /root 暂存，再 install 到 /opt。

# 1. 目录与配置
install -d -m 700 /opt/shangjing-app /opt/shangjing-app/tls/authority /opt/shangjing-app/backups
install -m 600 /opt/shangjing-app/src/infra/app/.env.app.example /opt/shangjing-app/.env.app
# 编辑 /opt/shangjing-app/.env.app，填入真实值；不要把内容贴到终端历史或聊天中
install -m 644 /opt/shangjing-middleware/tls/authority/ca.crt /opt/shangjing-app/tls/authority/ca.crt

# 2. 生成渠道加密主密钥（推荐）：openssl rand -base64 32
#    写入 .env.app 的 CHANNEL_ENCRYPTION_KEY；该值与数据库一起备份。

# 3. 签发带 IP SAN 的服务证书（已有证书时跳过；FORCE=1 轮换）
APP_DIR=/opt/shangjing-app bash /opt/shangjing-app/src/infra/app/tls-issue.sh

# 4. 放行 8443（当前只放行 22/80/443/5432/6379/9000/9001，不含 8443）
ufw allow 8443/tcp
ufw status | grep 8443

# 5. 构建并启动应用（此时先不装 vhost 也可以）
SKIP_NGINX=1 APP_DIR=/opt/shangjing-app bash /opt/shangjing-app/src/infra/app/deploy.sh

# 6. 首次管理员初始化：通过 SSH 隧道直连应用，见下一节
# 7. 初始化完成后再执行完整部署，安装 vhost 并重载 nginx
APP_DIR=/opt/shangjing-app bash /opt/shangjing-app/src/infra/app/deploy.sh
```

`deploy.sh` 是幂等的：重复执行只会重建镜像、`up -d`、必要时更新 vhost 并 reload；
不会停止或删除其他 Compose 项目。

### 首次管理员初始化（必须在暴露到公网前完成）

`POST /api/setup/admin` 只接受回环来源，并拒绝带 `X-Forwarded-For`、`X-Real-IP`
或 `Forwarded` 的转发请求。应用在 nginx 之后时服务端看到的来源永远是
`127.0.0.1`，所以 nginx 对 `POST /api/setup/admin` 直接返回 403。
公网用户无法抢先初始化，操作者必须通过 SSH 隧道直连应用端口完成初始化：

```sh
# 本机执行；保持隧道开启
ssh -L 4173:127.0.0.1:4173 root@203.0.113.10
# 浏览器打开 http://127.0.0.1:4173 ，填写管理员邮箱、密码、工作空间名称
```

初始化成功后关闭隧道，再访问 `https://203.0.113.10:8443` 登录。密码至少 10 位；
后续管理员新增的成员首次登录会被要求改密。管理员、运营、只读三种角色的权限由服务端逐接口校验。

如果 vhost 已安装而尚未初始化，仍可用上述隧道完成，不需要停 nginx。

## 日常升级与回滚

以下检出目录示例适用于 Git clone 部署；当前生产使用上文精确 SHA 归档目录，升级时核对实际发布目录与版本指针。

升级：

```sh
cd /opt/shangjing-app/repo
git fetch origin && git checkout main && git pull --ff-only
# 需要可回滚标签时，先在 .env.app 设置 APP_IMAGE_TAG=YYYYMMDD-N
APP_DIR=/opt/shangjing-app bash infra/app/deploy.sh
```

`deploy.sh` 会重新构建镜像、更新容器、等待健康检查、同步 vhost 并 `nginx -s reload`。
数据库迁移由服务启动时自动执行，**只向前应用**；升级前先按既有流程备份数据库。

回滚应用版本：

```sh
# 1. 把 .env.app 的 APP_IMAGE_TAG 改回上一个可用标签
# 2. 不重新构建，直接启动旧镜像
SKIP_BUILD=1 APP_DIR=/opt/shangjing-app bash infra/app/deploy.sh
```

本次使用完整提交 SHA 标签，旧镜像与上述清理前备份保留。后续升级继续使用可追溯标签，默认 `latest` 会被覆盖。**新业务写入后先停止应用写入并备份新状态**，再核对旧镜像与0018 / 0019及现有数据的兼容性；仅切镜像不等于数据回退。确需恢复数据库或对象时，先在隔离环境验证、制定新数据保全方案，再于维护窗口执行；不自动覆盖生产或重新清理。回退后同步版本指针与本文。

nginx 回滚：`deploy.sh` 每次替换前把旧 vhost 备份到
`/opt/shangjing-app/backups/nginx/shangjing-app.conf.<UTC 时间>`；恢复后执行
`nginx -t && nginx -s reload`。

## 备份与恢复

应用自身没有持久业务数据；需要与既有备份一起管理的是：

1. **PostgreSQL / MinIO**：沿用 `/opt/shangjing-middleware/backup.sh` 的冷备份流程；
2. **`.env.app`**：包含数据库、MinIO、模型密钥与渠道主密钥，权限 600；
3. **渠道加密主密钥**：`.env.app` 的 `CHANNEL_ENCRYPTION_KEY`，或命名卷
   `shangjing-app-secrets` 中的 `.secrets/channel-encryption.key`。它必须与
   PostgreSQL 同批备份，否则数据库里的动态渠道密钥无法解密；
4. **TLS**：`/opt/shangjing-app/tls/`（`server.key` 属敏感文件）；CA 私钥仍只在
   `/opt/shangjing-middleware/tls/authority/`，按既有敏感资产管理。

备份命名卷示例（只读打包，不打印内容）：

```sh
mkdir -p /opt/shangjing-app/backups
docker run --rm -v shangjing-app-secrets:/src:ro -v /opt/shangjing-app/backups:/out \
  alpine:3.22 tar -czf /out/app-secrets-$(date -u +%Y%m%dT%H%M%SZ).tar.gz -C /src .
chmod 600 /opt/shangjing-app/backups/app-secrets-*.tar.gz
```

同盘备份不能应对整机损坏；应复制到异机并校验 SHA-256。恢复时先核对归档内容与权限，
在隔离环境验证后再覆盖；**不要删除数据库、MinIO 数据或命名卷来“重装”应用**。

## 验证命令

```sh
# 容器与健康状态
docker compose --project-name shangjing-app \
  --env-file /opt/shangjing-app/.env.app \
  -f /opt/shangjing-app/repo/infra/app/compose.yaml ps
curl -fsS http://127.0.0.1:4173/ >/dev/null && echo app-loopback-ok

# 经 nginx + 项目 CA 验证（不带 -k，必须校验证书）
curl --fail --silent --show-error \
  --cacert /opt/shangjing-app/tls/authority/ca.crt \
  https://203.0.113.10:8443/ >/dev/null && echo nginx-tls-ok

# 证书 SAN 与有效期（不输出私钥）
openssl x509 -in /opt/shangjing-app/tls/server.crt -noout \
  -subject -issuer -dates -ext subjectAltName

# nginx 配置
/www/server/nginx/sbin/nginx -t

# 应用日志（不打印环境变量）
docker logs --tail 200 shangjing-app
```

浏览器访问 `https://203.0.113.10:8443` 前，需要把项目 CA
（`ca.crt`，SHA-256 指纹见 test-middleware.md）导入操作系统或浏览器的受信任根证书；
否则会出现证书警告。客户端命令行使用 `--cacert`，不要用 `-k` 关闭校验。

## 部署记录

| 日期（UTC） | 发布内容 | 验证 |
| --- | --- | --- |
| 2026-10-23 | 创作 v2 `b988769`：长期商品聊天、React Flow 无限画布、模型中心、图像 / H3 执行器、模板与回收站；后续 `5cc169e` 补测试，运行代码一致 | 先推送后按SHA发布；283/283、58/58、五套浏览器及check / build通过；三轮审查关闭确认项；新备份恢复6/6/6/1，授权删除59条旧业务与14对象版本，账号 / 配置 / 模板保留；TLS / healthy / 静态包 / 8组真实PG和MinIO烟测通过，付费调用0；见本文当前记录 |
| 2026-10-25 | `main` `53826d6`：重新发布画布 v3 最新代码（应用代码与 10 月 23 日运行镜像一致，本次只重建校验；新增提交仅含文档与远端脚本） | 部署前备份 `/opt/shangjing-app/backups/pre-deploy-20261025T110719Z.sql`（304,202 字节，含完成标记）；镜像构建、健康检查、nginx reload 通过；HTTPS 首页 200，`/api/session` 200、`/api/creation/projects` 与 `/api/model-hub` 401；`CreationProjects.js` 216,441 字节含结果卡片；未创建付费任务 |
| 2026-10-25（晚） | `main` `d75cdc0`：B 版蓝色 UI 重做（theme.css 顶部导航设计系统，替换 base.css）、画布 v4（维度标签 / 整理布局 / 来源版本选择 / 队列计数与耗时格式）、视频工作台（脚本 → 分镜 → 逐镜 → ffmpeg 成片拼接，storyboard 存项目 JSONB）与 `server/video-compile.mjs`；Dockerfile 运行层安装 ffmpeg；测试基线升至 290/290、65/65 | 部署前备份 `/opt/shangjing-app/backups/pre-deploy-20261025T144607Z.sql`（496,288 字节，含完成标记）；源码归档（SHA-256 `48efd2db…`）上传核对后解压至 `releases/d75cdc0…`，`docker build -f infra/app/Dockerfile`（上下文为发布目录）构建 `shangjing/app:d75cdc0…` 并同步 `latest` 标签，`.env.app` 以 600 复制进发布目录供 compose `env_file` 解析；容器 healthy，回环 200，HTTPS 经项目 CA 200，`/api/session` 200、`/api/creation/projects` 与 `/api/model-hub` 401、storyboard 写路由无 CSRF 返回 403；`CreationProjects.js` 含「视频工作台 / 整理布局」标记；容器内 ffmpeg 5.1.9；未创建付费任务 |
| 2026-10-23 | `main` `8bd6165`：自由节点画布 v3（八类节点、类型化连线、任务队列、节点级重试、浏览器内合成）、商品对话优先、工作台实时队列、旧组件下线 | 部署前 `pg_dump` 备份至 `/opt/shangjing-app/backups/pre-deploy-20261023T083836Z.sql`（352,941 字节，含完成标记）；镜像重建、容器 healthy、回环健康检查通过；HTTPS 首页 200；`GET /api/session` 200，`/api/creation/projects`、`/api/model-hub` 401；`CreationProjects.js` 213,413 字节且含「添加节点 / 任务队列 / 重试全部失败」；未创建付费任务。用户确认后执行 `server/scripts/creation-reset-projects.mjs --yes`：删除 12 个旧项目、15 条运行记录、5 条回收站记录，保留商品、素材、模板、账号与模型配置 |
| 2026-10-22 | `main` `16c693c`：项目工作流开跑前编辑与另存模板、详情 / 列表 / 工作台生命周期统一、确认与保存竞态修复、并发预占补偿、页面分包懒加载与 PostgreSQL 集成测试 | 部署前 `pg_dump` 备份至 `/opt/shangjing-app/backups/pre-deploy-20261022T114524Z.sql`（174,811 字节，含 `PostgreSQL database dump complete`）；镜像重建、容器 healthy、回环 `GET /` 健康检查通过；服务器侧 `curl --cacert` 首页 200；`GET /api/session` 200，`GET /api/projects`、`/api/models` 401（鉴权生效）；`/assets/app.js` 252,152 字节，分包 `/assets/ProjectPage.js` 268,354 字节且含 `edit-workflow`，经 HTTPS 200；未创建付费任务 |
| 2026-10-21 | `main` `3d8307c`：项目列表 / 六步 / 04 精修候选 / 05 审核 / 06 导出（#27/#25）、商品真实接口（#28）、系统成员 / 账本 / 审计 / 价格（#29）、素材真实索引、商品原图改图入口 | 部署前 `pg_dump` 备份至 `/opt/shangjing-app/backups/`；镜像重建、容器 healthy、`deploy.sh` 回环健康检查通过；服务器侧 `curl --cacert` 访问 `https://203.0.113.10:8443/` 返回 200；管理员登录后 `GET /api/session`、`/api/models`、`/api/jobs`、`/api/projects`、`/api/products`、`/api/assets`、`/api/billing`、`/api/billing/ledger`、`/api/billing/prices`、`/api/audit-logs`、`/api/users`、`/api/dashboard` 均为 200；`/assets/app.js` 正常返回。验证经 SSH 端口转发完成，未在服务器留存密码，未创建付费任务 |

## 已知风险与限制

1. **监听地址**：`server/index.mjs` 默认监听 `127.0.0.1`，可用 `SJ_LISTEN_HOST` 覆盖；
   容器内设为 `0.0.0.0` 以配合端口映射。容器端口只发布到宿主 `127.0.0.1:4173`，
   公网仍只能经 nginx 访问。旧代码无该变量时 `deploy.sh` 自动退回
   `compose.host-network.yaml`，见 [infra/app/README.md](../../infra/app/README.md)。
2. **Host 白名单**：`server/http.mjs` 已支持 `SJ_ALLOWED_HOSTS`（`host:port`）和
   `SJ_PUBLIC_ORIGIN`。nginx 必须传 `Host $http_host`，否则端口丢失会导致
   `ORIGIN_DENIED`。改端口或换域名时三处要同步：nginx `server_name`/端口、
   `SJ_ALLOWED_HOSTS`、`SJ_PUBLIC_ORIGIN`。
3. **CA 信任**：应用证书和 MinIO 证书都由项目私有 CA 签发。浏览器、命令行客户端、
   任何外部模型服务默认都不信任，因此**不能把私有 MinIO 预签名或其他内部 URL 交给供应商**。
   当前 `openai-compatible` 渠道改图由服务端从 MinIO 读取图片字节，经 JSON base64 data URL
   （OMYAI）或标准 multipart（其他渠道）上传，不向供应商暴露 MinIO 地址；旧 MCP 渠道仍用
   供应商已成功任务 ID。商品原图与源任务都必须先经服务端登记与归属校验。
4. **供应商出网**：创作 v2 要求容器可直接访问 OMYAI、DeepSeek 和 CompShare HTTPS。新执行器不读取 `MODEL_HTTPS_PROXY`，它只保留给旧执行器。DNS/跳转逐次校验并固定公共地址，不能用通用代理绕过；2026-10-22 服务器三站 HTTPS 连通已验证，不代表真实付费任务验收。
5. **单实例**：任务执行依赖 PostgreSQL advisory lock，只允许一个执行器。不要为
   `shangjing-app` 扩容多个副本，否则第二个实例会因拿不到任务锁退出。
6. **首次初始化来源**：反代后 `setupAdmin` 只看 socket 地址会误判，因此应用同时拒绝
   任何带转发头的初始化请求，nginx 也对 `/api/setup/admin` 直接返回 403。
   必须先通过 SSH 隧道完成初始化再公开访问；不要删除该 location。
7. **防火墙**：8443 不在默认已放行列表；未放行时本机 curl 通过但公网不可达。
8. **登录与限流**：`SJ_AUTH` 默认是 off，生产必须为 on；登录失败限制是进程内的，
   重启后清零，nginx 层未配置额外限流。
9. **迁移不可回退**：启动时自动执行 `server/migrations/*.sql`，只向前。回滚镜像前
   确认数据库结构与旧版本兼容，或按备份恢复。
10. **镜像构建依赖外网**：需要拉取 `node:24-bookworm-slim` 和 npm 依赖。服务器
    访问 Docker Hub/npm 受限时，先配置 Docker daemon 代理或使用内部镜像仓库；
    不要通过修改 Dockerfile 绕过校验。

## 与中间件部署的边界

`deploy.sh` 只使用 Compose 项目 `shangjing-app`，不会执行：

- `docker compose down` / `down -v`；
- `docker system prune`、`docker volume prune`；
- 重启 `shangjing-middleware` 的 postgres/redis/minio；
- 修改 `/opt/shangjing-middleware` 下的配置、证书或数据目录。

应用只以 `shangjing_app` 账号连接既有 PostgreSQL/MinIO，使用 TLS 与项目 CA；
Redis 尚未用于业务队列，未来启用时仍须遵守 `sj:` 键前缀与 `sj:bullmq` 队列前缀。
