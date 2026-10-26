# 模型供应商接入

更新：2026-10-23。当前基线为 [FUNCTIONAL_SPEC v2](../FUNCTIONAL_SPEC.md) 与 [Q01—Q43](../requirements/creation-workbench-grilling.md)。创作 v2 已部署，运行代码 b988769；5cc169e 仅补测试 / 验收。独立 QA、三轮审查及确认项修复完成，线上真实 PG / MinIO 无付费烟测通过。配置协议见本文，实现与验证边界见 [STATUS](../STATUS.md)，精确版本与维护见 [app-deployment.md](app-deployment.md)。

## 活动入口与执行能力

系统 → 模型中心管理动态渠道；商品页长期聊天整理事实，项目直接进入 React Flow 无限画布。任务预览执行范围后由用户点击开始，不经过旧项目 03 单图面板、报价、充值、预扣或强制审核。图像 / 视频成功保存后立即可用。

| 类型 | 活动实现 | 条件与边界 |
| --- | --- | --- |
| 文本 / 读图 | OpenAI-compatible chat completions、Anthropic messages；文字与 base64 图片块；记录供应商返回用量 | 人工启用 text / vision 与执行器能力分别校验；图片消息额外要求 vision，不猜测模型名能力 |
| 图片 | OpenAI-compatible images generations / edits，OMYAI JSON data URL、其他默认标准 multipart；服务端传图片字节 | 来源须已登记创作素材或明确成功版本；不接受浏览器自定端点 / 对象键；同步结果立即转存 |
| 视频 | MiniMax H3，优云智算协议；文生 / 单图首帧、提交 / 查询 / 取消、下载 MP4 与转存 | adapter=minimax-h3 或显式 video=minimax-h3 执行配置；仅目录出现 video 不代表可执行；未做真实付费 H3 调用 |

供应商启动配置仅在相应环境变量存在时进行一次有审计的 bootstrap，不随每次启动覆盖管理员修改 / 删除：

| 环境变量名 | 启动渠道与默认 | 配置限制 |
| --- | --- | --- |
| OMYAI_API_KEY | OpenAI-compatible，https://omyai.vip/v1；gpt-image-2.5-flare，image 默认；editTransport=json-data-url | 当前启用 image；目录其他模型需管理员启用与指定能力 |
| DEEPSEEK_API_KEY | OpenAI-compatible，https://api.deepseek.com/v1；deepseek-flash，商品 / AI 规划默认 | **仅 text**；截图 / 图片识别须切换到已配置的 text + vision 模型，不能给 DeepSeek 虚标 vision |
| MINIMAX_H3_API_KEY | minimax-h3，https://cp.compshare.cn；MiniMax-H3，video 默认 | 仅安全配置 Key 不等于已 bootstrap / 部署 / 供应商验证；本次无付费 H3 调用 |

旧 MCP omyai 和静态 providers 注册表属于 v1 路径；火山方舟未接入。旧 OMYAI / DeepSeek 真实调用证据保留在下方历史记录，不用其推断 v2 新路径、所有新模型或视频均已实际付费验证。

## 模型中心配置与目录规则

1. 管理员在系统模型中心新增名称、协议、Base URL 与 Key。配置先保存，目录同步单独执行，失败保留配置与原目录，可手工补 ID；不再要求目录连接成功才能保存渠道。
2. OpenAI / Anthropic 同步先完整读取分页，再原子更新；新发现默认禁用且无推断能力，消失模型保留能力历史并标 unavailable，手工 ID 保留。
3. 管理员明确勾选 text / vision / image / video 并启用。界面单独展示 executorCapabilities；能力勾选不会新增执行器。
4. 商品聊天识别 product、AI 规划 planning、生图 image、视频 video 分别设置默认。商品与规划默认要求 text，图片消息额外 vision；任务可选兼容模型。默认不可用应提示用户，不自动换渠道 / 模型。
5. 配置写操作带 If-Match ETag 和 CSRF；缺修订 428、冲突 409，前端保留输入。渠道可修改 / 轮换 Key / 停用 / 删除，历史任务保留冻结配置；地址改变会阻止旧任务复用，避免把新密钥发到旧地址。

密钥仅在提交时由浏览器发至后端，AES-256-GCM 加密存 sj_model_channels，公开响应仅末四位掩码；不入 localStorage、URL、console 或日志。加密主密钥 .secrets/channel-encryption.key（32 字节，首次生成；或 CHANNEL_ENCRYPTION_KEY 覆盖）须与数据库安全备份，丢失不可恢复。环境变量实际值只在忽略文件 / 安全部署环境维护，本文不包含真实 Key。

## 安全传输与媒体

**新 server/providers/creation-http.mjs 只直连，不支持 MODEL_HTTPS_PROXY。** 它使用带安全 DNS lookup 的 undici Agent，校验公网地址并钉定解析；通用转发代理会绕开该保护，旧代理设置不能用作新调用的可达性保证。协调者于 2026-10-22 在实际服务器验证三个供应商 HTTPS 端点均可直连；这只证明传输可达，不证明账号、模型执行或付费成功。

- Base URL 需 HTTPS；显式配置 localhost / 回环 HTTP 仅供本地开发 / fixture，不放宽任意结果下载地址。
- 外部结果逐跳验证 HTTPS / 公网地址，限跳转 / 超时 / 流式大小，按 PNG / JPEG / WebP / MP4 字节签名检查；模型 Key 不转发结果下载域名，供应商原始错误正文不直接外泄。
- 新路径图像输入 / 结果上限 10 MiB，视频结果 100 MiB；H3 协议首帧函数上限 30 MiB，仍受现有来源图片校验约束，不能据此承诺所有 30 MiB 图片可用。超限明确报错。
- 创作文件写私有 shangjing-assets；浏览器仅同源 /api/creation/assets/:id/file，视频支持 HEAD / Range，长期 MinIO Key 不发浏览器。
- 商品资料 evidence 不默认进入生成；creative 明确上传 / 转入。任务所选源素材或具体成功结果由服务端读取字节，OMYAI / H3 传 data URL，普通图像 edits 可 multipart。私有 MinIO URL 不交给供应商，不默认外部信任项目 CA。
- CreationMedia 另有五分钟签名公开 TLS 媒体接口（需 SJ_MEDIA_PUBLIC_ORIGIN 与独立 SJ_MEDIA_SIGNING_KEY）；当前 H3 首帧走 data URL，不要求启用公开网关，也不代表该网关已对外部署。

## 图片与 H3 协议

图像生成 POST /images/generations，改图 POST /images/edits。OMYAI 使用 executorConfig.editTransport=json-data-url；普通 OpenAI 兼容默认 multipart。服务端保存来源关系及输入快照，不借用 v1 MCP 的上游图片 24 小时有效期作为新路径限制。

H3 接口为 POST /minimax/v2/video_generation、GET /minimax/v2/query/video_generation/{id}、DELETE /minimax/v2/video_generation/{id}。提交带 Idempotency-Key；仅返回 task_id 视作 queued；参数校验时长 4–30 秒、允许分辨率 / 比例及布尔开关；单图首帧 content 的 role=first_frame。成功下载 content.url 为 MP4，再写私有存储并归集；UI 可预览 / 下载。此协议通过本地 HTTP fixture，**未通过真实付费 H3 成片验收**。

## 状态、恢复与成本

- 执行前冻结任务 / 参数、商品资料、具体来源版本、模型 / 协议配置与图修订；同请求编号和选择幂等，不同参数返回冲突。AI 安排不执行，用户先预览范围再开始。
- 后台仅查询原上游任务；unknown 不重新提交、不换模型。明确失败须用户确认新请求；取消保持 cancelling / unknown 直到终态，不能据此宣称已取消计费。
- 同步图片返回丢失且无上游编号时不能安全重提；转存中断保留原任务待核实，不因本地重启重新生成。供应商支持查询的已知编号才继续原查询。
- 同任务保留多次生成；上游成功后下游待用户选择具体成功版本，随后再次点击开始。成功前置复用，已有结果 / 输入不受商品或模板更新影响。
- 仅记实际用量 / 可确认成本，不做内部报价、充值或余额门槛。token、积分、时长仅为用量；只有供应商明确返回有效 costMicros 与 currency 才为已知货币成本，其余 null /「未统计」，不用零代替。保留最小成本和删除审计，不记 Key。

## 接入结构与公开 API

| 文件 | 职责 |
| --- | --- |
| server/model-hub.mjs、server/channels.mjs | 加密渠道、目录 / 能力 / 默认、配置事务锁、调用分派与用量 |
| server/providers/creation-http.mjs | 直连安全传输、目录分页、受限下载 / 签名 / 用量标准化 |
| server/providers/creation-text.mjs | OpenAI / Anthropic 文字与读图协议 |
| server/providers/creation-image.mjs、creation-video.mjs | 图片生成 / 改图、H3 提交 / 查询 / 取消 |
| server/creation-products.mjs、creation-projects.mjs | 长期聊天与事实、画布 / 生成快照 / 执行恢复 |
| server/creation-store.mjs、creation-media.mjs、creation-lifecycle.mjs | SQL 持久化、私有媒体 / 版本删除、模板与回收站 |
| server/index.mjs、server/http.mjs、server/routes/creation-*.mjs | 一次 bootstrap、后台 tick、账号 / CSRF / 路由 / 静态白名单 |
| web/src/components/Creation*.jsx | 活动五菜单、无限画布、商品聊天、模板 / 回收站与模型中心 |

| API | 行为 / 权限 |
| --- | --- |
| GET /api/model-hub | 渠道 / 目录 / 能力 / 默认 / ETag，查看者以上 |
| POST /api/model-hub/channels | 管理员保存加密渠道，不以目录同步成功为保存门槛 |
| PATCH / DELETE /api/model-hub/channels/:id | 管理员修改 / Key 轮换 / 停用或删除 |
| POST /api/model-hub/channels/:id/sync | 管理员显式同步目录，失败保留配置 |
| POST /api/model-hub/channels/:id/models | 管理员手工 ID、启用与能力 |
| POST /api/model-hub/defaults | 管理员设置 product / planning / image / video 默认 |
| /api/creation/products、/products/:id/chat | 商品资料 / 长期聊天 / 明确建议采纳；写需运营以上 |
| /api/creation/projects/:id/preview、/start、/recover、/cancel | 预览 / 用户显式开始 / 原任务查询 / 取消，执行写需运营以上 |
| /api/creation/assets/:id/file、/projects/:id/export | 同源结果读取 / 成功结果 ZIP；查看者以上 |
| GET /api/creation/overview | 同工作空间指标 / 实际用量，查看者成本脱敏 |

模型配置写需管理员 + If-Match，所有业务写需服务端角色与 CSRF 校验。账号保留 SJ_AUTH 模式、HttpOnly 会话 / 改密 / 退出 / 本机初始化，浏览器展示权限不是后端授权。

## 启动、验证与维护

Node.js 24+、npm ci、npm run build 后运行 npm run dev，本机回环 127.0.0.1:4173。任务必要时安全迁移 .env.middleware.local、.env.models.local、项目 CA 与渠道主密钥，更新证书路径；私密配置仅在授权维护时读取，值不入公开记录。公网服务保持原账号 / 端口 / 项目 CA，v2 已上线；OMYAI / DeepSeek / H3 私密配置已就绪，截图仍需兼容 vision 模型，付费生成未作为本次烟测步骤。

测试与命令见 STATUS：最终283/283默认测试、check / build 197 modules、test:creation 58/58（含12项运行回归）、五套 v2 browser 均通过。fixture 不连接真实供应商，不证明账号 / 模型 / 幂等 / 生成质量；旧浏览器脚本为 v1 历史。线上另有8组真实 PG / MinIO 无付费烟测通过，未调用付费图像 / H3。

新数据库 / 配置 / 渠道主密钥备份位于 `/opt/shangjing-app/backups/creation-v2-20261022T140915Z/before-cleanup-20261023T004641Z`，已隔离恢复验证。14个旧对象 / 14版本字节在原批次 objects/ 备份并经回读 SHA-256 校验；核对归属及清单未漂移后，已显式删除59条旧测试业务及14对象版本，保留账号 / 渠道 / 模型配置 / 预制模板 / 结构。清理已完成，不重复执行。备份同盘，异机迁移尚未完成。当前运行版本、健康、凭据路径与回退条件见 app-deployment.md。

## v1 接入历史归档（非当前接续指南）

以下保留旧配置与真实付费验证证据；原型入口、视频仅目录、DeepSeek 未实现、MODEL_HTTPS_PROXY 配置、旧 API / 队列 / 去重窗口 / 源图有效期等只属于 v1，不覆盖上述 v2 路径。旧真实调用不能替代新路径付费验收。

<details>
<summary>展开 2026-10-21 v1 模型接入与验证记录</summary>

### v1 原始模型接入记录

更新日期：2026-10-21。当前版本为本机单用户开发接入，不是公网多租户生产服务。

原型导航更新：真实单图入口为「项目 → 示例项目 → 03 制作任务 → 打开真实单图面板」，渠道管理入口为「系统 → 模型中心 → 管理真实渠道」。新五菜单、项目流程和系统账本/查价均为本地评审原型，不改变既有任务、密钥、端口、账号和存储配置；商品原图不自动传给模型。原有单图接口保持不变。

#### 当前可用

- `omyai-openai`（官方 OpenAI 标准，默认渠道）：`https://omyai.vip/v1`，读取 `OMYAI_API_KEY`。模型目录已发现 `gpt-image-2`、`gpt-image-2.5-flare`、`gpt-image-2.5-sunburst`，三者均可执行生成与改图；`gpt-image-2.5-flare` 为默认模型。生成走 `POST /images/generations`，改图走 `POST /images/edits`。
- `omyai`（MCP 异步，历史渠道）：已设为 `enabled: false`，不再发布模型或接收新任务；历史任务仍保留供应商编号，可用于查询、下载和待核实恢复。
- 系统页可新增 OpenAI 兼容渠道：填写名称、Base URL、API Key，保存前请求 `<Base URL>/models` 测试连接并自动发现图像/视频模型。图像模型通过 `<Base URL>/images/generations` 执行同步单张生图；默认改图协议为官方 multipart `/images/edits`；视频模型只同步目录，执行器尚未接入。
- 生图页为应用内右侧的三栏工作台：生成记录、提示词/模型/质量/尺寸/分辨率/宽高比、生成结果，保留全局导航和页面头部。选择历史记录会回填参数；结果可下载、复制提示词或基于该图修改。参考图支持已生成版本，以及商品页已上传、服务端登记的商品原图（选择时先调用 preflight 门禁，提交只带 sourceAssetId）；批量多张和画布尚未接入；一次任务生成一张图片。
- 文生图与改图入口。MCP 渠道改图调用 `edit_image` 并携带真实 `source_job_id`；官方渠道改图由服务端从私有 MinIO 读取源图或商品原图后上传，不接受浏览器 URL 或对象键。源图关系与每一版图片分别保留。
- 官方渠道通过 `GET /models` 发现权限和模型，不按模型名称猜能力；MCP 渠道通过 `list_image_models` 与 `tools/list`。模型列表每分钟刷新缓存，页面也可主动刷新。
- PostgreSQL 保存任务；MinIO 保存成功图片。同步官方结果在提交返回后立即转存，不再依赖适配器进程内的临时缓存。页面刷新或关闭不会取消服务端任务；本机服务退出会暂停执行，重启后待核实任务需显式恢复。
- 真实计费以 OMYAI 使用日志为准。没有调用供应商未提供的精确报价接口，没有自动退款、自动重试、故障切换模型或项目账本实现。

#### 官方 OpenAI 标准生图接口（omyai-openai，2026-10-21）

真实密钥验证（未重复计费测试）：

- `GET https://omyai.vip/v1/models` 返回 `gpt-image-2`、`gpt-image-2.5-flare`、`gpt-image-2.5-sunburst`；目录中均为 image、`executable=true`、`operations=["generate","edit"]`，默认 `gpt-image-2.5-flare`。
- `POST https://omyai.vip/v1/images/generations` 使用 JSON `{model:"gpt-image-2.5-flare",prompt,size:"1024x1024",quality:"low",n:1}` 返回 HTTP 200，`data[0].b64_json` 为约 565 KB PNG。该次调用由供应商计费，未重复执行。
- `POST https://omyai.vip/v1/images/edits`：OMYAI 网关拒绝 `multipart/form-data`，返回 400 `Model name not specified`；改用 JSON 且 `image` 为 `data:image/png;base64,<...>` 时返回 HTTP 200 与 `data[0].b64_json`。本适配器对 `omyai-openai` 使用 `editTransport: "json-data-url"`，其他 OpenAI 兼容渠道默认使用官方 multipart 字段 `model`、`prompt`、`image`、`size`、`quality`、`n=1`。
- 来源图由服务端读取：改图源任务从私有 MinIO 的对象读取；商品原图按 `sourceAssetId` 读取已登记的原图记录，截图类型拒绝。MCP 渠道不接收任意图片上传，继续只接受 `source_job_id`。
- 单张图片上限 20 MB；商品原图上传本身限制 10 MB。生成结果在 `submit` 返回后立即写入私有 MinIO；内存缓存仅保留为兼容回退，不作为持久化依赖。

已知限制：OMYAI 的 JSON data URL 改图已由真实调用验证，但本次未重复付费执行；动态 OpenAI 兼容渠道的改图默认 multipart，供应商若不支持需单独确认传输方式；视频模型只同步目录；官方渠道返回 `url` 而非 `b64_json` 时仍受 HTTPS 与内网地址拦截约束。

#### 已选定供应商（2026-10-21）

用户指定：后续功能用到**文本模型**时使用 **DeepSeek 官方 API**，用到**生图模型**时使用 **OMYAI**（`https://omyai.vip`，现由官方 OpenAI 标准渠道 `omyai-openai` 承载）。

- DeepSeek Key 已存入忽略文件 `.env.models.local` 的 `DEEPSEEK_API_KEY`。适配器、`config/providers.json` 条目和 `text.chat` 执行器**尚未实现**；接入时按官方文档确认 Base URL、模型名和计费，不按记忆硬编码。
- OMYAI Key 与 `.env.models.local` 中已有的 `OMYAI_API_KEY` 一致，未改动。
- 截图识别所需的视觉模型（`vision.analyze`）尚未指定供应商，仍属 Q-02。

#### 启动与私密配置

1. 安装 Node.js 24+，执行 `npm ci`。
2. 安全迁移 `.env.middleware.local`、项目 CA 证书，并更新绝对路径。
3. 在 Git 忽略的 `.env.models.local` 设置 `OMYAI_API_KEY`。不要把真实值写入本文、前端、命令参数或 `config/providers.json`。
4. 系统页新增渠道的密钥不写入 `.env.models.local`，而是经本机接口提交后加密存入 PostgreSQL。首次启动自动生成 `.secrets/channel-encryption.key`（32 字节）；也可用 `CHANNEL_ENCRYPTION_KEY` 提供 base64 主密钥。该文件必须与数据库一起安全备份，丢失后已保存的动态渠道密钥无法解密。
5. 可选 `MODEL_HTTPS_PROXY` 为模型 HTTPS 请求的 HTTP 代理，直连环境留空。本机直连曾出现 TLS 握手中断，当前私密配置使用本机代理。代理不用于 PostgreSQL/MinIO，不关闭 TLS 验证。
6. 运行 `npm run dev`，访问 `http://127.0.0.1:4173`，按上方入口打开真实单图面板或真实渠道管理。

服务端只绑定回环地址；所有请求校验 Host，拒绝外部 Origin，写入接口需页面会话令牌。静态文件为精确白名单，无通用目录服务。此设计适合本机开发，不能替代生产鉴权。对外部署前必须实现登录、用户/项目隔离、权限、限流和正式费用策略。

#### 结构与扩展契约

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 静态渠道配置 | `config/providers.json` | 稳定 ID、适配器类型、端点、密钥环境变量名、启用状态、图片下载域名白名单；`editTransport` 声明改图传输（OMYAI 为 `json-data-url`） |
| 动态渠道存储 | `server/channels.mjs` | Base URL 校验、AES-256-GCM 密钥加密、末四位掩码、PostgreSQL `sj_model_channels` |
| 渠道服务 | `server/channel-service.mjs` | 新增前连接测试、增删停用、注册表同步 |
| 注册与能力目录 | `server/providers/registry.mjs` | 多供应商注册、隔离故障、返回 `providerId:modelId` 唯一标识及能力 |
| OMYAI 适配器 | `server/providers/omyai.mjs` | MCP 模型发现、提交、查询、受控下载 |
| OpenAI 兼容适配器 | `server/providers/openai.mjs` | `/v1/models` 发现、同步图像生成、官方 multipart / OMYAI JSON data URL 改图、即时结果回传与视频目录 |
| 任务服务 | `server/jobs.mjs` | 参数验证、请求去重、源图校验、状态转换、转存，不保存供应商密钥 |
| 数据与对象存储 | `server/store.mjs` | PostgreSQL 队列、任务与版本关系、MinIO 私有对象 |
| HTTP | `server/http.mjs` | 本机访问约束、会话令牌、接口与静态白名单 |
| 页面 | `prototype/prototype.html`、`prototype/generation.js` | 应用内三栏生图工作台、渠道管理、模型选择、单张确认、状态查询、下载与改图 |

新增 OpenAI 兼容渠道：在「系统」页点击「新增渠道」，填写名称、Base URL、API Key。服务端先请求 `<Base URL>/models` 测试连接和发现模型，成功后才保存；Base URL 必须为 HTTPS，本机 `http://localhost` 例外。动态渠道保存在 PostgreSQL `sj_model_channels`，密钥使用 AES-256-GCM 加密，前端只显示末四位掩码。进入「生图」或「系统」页会刷新模型目录；每次创建生图任务前还会重新读取所选渠道的模型目录，目录读取失败则拒绝新任务。

新增相同 OMYAI MCP 协议渠道：仍在 `config/providers.json` 增加唯一 `id`、`name`、`endpoint`、`apiKeyEnv`，在 `.env.models.local` 提供 Key，然后重启；当前前端「新增渠道」只支持 OpenAI 兼容协议，不要把 MCP 端点填进该表单。

新增不同协议：在 `server/providers/` 新建适配器，注册到 `adapterFactories`，实现：

- `catalog()` → 标准模型描述：`id`、`providerId`、`upstreamModel`、`name`、`kind`、`operations`、`sizes`、`qualities`、默认项和可为空的价格。供应商权限不可用时不得保留为可选模型。
- `submit(job)` → 上游任务编号。采用任务 UUID 作为支持去重的请求编号，提交参数来自数据库快照，不能静默换模型。同步适配器可额外返回 `result.data`（图片 Buffer），任务服务收到后立即转存；`job.input.sourceImage` 只存在于执行内存，不写入任务 JSONB。
- `poll(upstreamId)` → 标准任务状态和结果下载链接。同步供应商可在适配器内转换为同样的任务契约；无法查询/去重时须明确进入待核实状态，不自动重新提交。
- `download(url)` → 经安全校验的二进制结果。下载地址必须来自供应商结果且属于白名单 HTTPS 域名；不向图片域名发送模型 Key，不跟随未经校验的重定向。

**新增视频仍需实现代码，不能只改一个类型字段。** 扩展能力描述与任务校验，加入时长、帧率、音频、输入图片等明确参数；实现该供应商的视频提交、查询与下载适配器，扩展媒体签名校验与 MIME/预览 UI，并覆盖计费和超时恢复测试。现有供应商命名空间、任务表、上游任务编号、去重与私有对象存储可复用。当前系统页会将发现到的视频模型显示为「目录已同步 · 执行未接入」，不会将其放入可执行生图列表。

系统页已暴露渠道新增、停用、删除和模型刷新；OpenAI 兼容图像模型可执行生图，视频模型仅同步目录。默认选择只保存在当前浏览器，任务创建后冻结实际模型和参数。新增渠道的密钥只在提交时经本机接口传输，不写入浏览器存储、页面 URL 或日志。

#### 状态、恢复与计费边界

```text
queued → submitting → running → storing → succeeded
                     ↘ failed
任何响应中断、状态不明、转存失败、进程重启 → unknown
```

- 客户端每次明确的新需求使用 `crypto.randomUUID()`，相同请求重传必须保留 UUID 与全部参数。服务端主键和参数哈希防止重复收费请求，冲突返回 409。
- `unknown` 不是失败或退款保证。页面提供「查询 / 恢复原任务」：已有上游编号时只查询；首次响应丢失时按供应商去重规则重发原编号与原参数。供应商去重窗口为 7 天，服务端超过 6 天禁止无上游编号的恢复提交。
- `failed` 不自动重新生成。先查供应商使用日志；新生成需要用户重新确认。
- 上游原图保留 24 小时；为避免排队导致源图过期，本机在创建时间超过 23 小时后禁止新改图。MinIO 中的保存图片仍可下载；本机长期保存不会延长供应商的编辑有效期。
- 单执行器、一次一个生成任务，最多 10 个排队/执行中任务；同库第二个执行器因 advisory lock 拒绝启动。没有使用 Redis，尚无多机队列扩容实现。
- PostgreSQL `public.sj_generation_jobs` 记录任务；MinIO 私有 `shangjing-assets/generation/<UUID>/` 存图片。不自动清理历史数据、数据库、Redis 或桶。
- 浏览器只得到后端图片 URL，不得到签名的上游 URL、MinIO 密钥或供应商 Key。

#### 本机接口

| 接口 | 行为 |
| --- | --- |
| `GET /api/session` | 本机页面写入令牌 |
| `GET /api/models` | 可用模型及渠道状态，只返回密钥末四位掩码 |
| `POST /api/models/refresh` | 刷新模型，非计费 |
| `POST /api/channels` | 新增 OpenAI 兼容渠道；接收 name、baseUrl、apiKey，先测试并发现模型，成功后加密保存 |
| `POST /api/channels/:id/enabled` | 启用或停用动态渠道；停用渠道不参与新任务 |
| `DELETE /api/channels/:id` | 删除动态渠道；已保存任务和图片不删除 |
| `POST /api/jobs` | 创建或返回相同请求的单张任务；包含 requestId、modelId、prompt、size、quality、operation，以及可选 sourceJobId（改图源任务）或 sourceAssetId（服务端登记的商品原图，仅 openai-compatible 渠道） |
| `GET /api/jobs` | 最近 50 个任务 |
| `GET /api/jobs/:id` | 状态、参数与源版本 |
| `POST /api/jobs/:id/reconcile` | 显式恢复待核实任务，非新生成请求 |
| `GET /api/jobs/:id/image` | 从私有 MinIO 读取成功图片 |
| `GET /api/jobs/:id/image?download=1` | 下载原图 |
| `GET /api/product-images/input` | 商品原图输入门禁状态与已登记协议 |
| `POST /api/product-images/input` | 管理员启用或停用商品原图输入（需已验证协议） |
| `POST /api/product-images/preflight` | 提交前校验原图编号、渠道、模型与操作 |

POST 与 DELETE 都要求 `X-CSRF-Token`；POST 使用 JSON。只有 `POST /api/channels` 接收一次 API Key，且不会回传、记录或写入前端存储。任务接口不接受前端提供上游端点或对象存储路径。

#### 验证与维护

- 真实 Key 已读取官方渠道三个模型与能力；Key 未输出到日志或响应。
- 官方渠道 `GET /models` 真实返回 `gpt-image-2`、`gpt-image-2.5-flare`、`gpt-image-2.5-sunburst`，均识别为可执行 image 且支持 `generate` / `edit`，默认 `gpt-image-2.5-flare`。
- 一次官方 `gpt-image-2.5-flare`、1024×1024、low 的真实文生图返回 HTTP 200 与 `data[0].b64_json`（约 565 KB PNG）；该调用由供应商计费，本次未重复执行。
- 官方 `/images/edits` 已验证：multipart 被 OMYAI 网关以 400 `Model name not specified` 拒绝；JSON `image` data URL 返回 HTTP 200 与 `data[0].b64_json`。
- 2026-10-21 部署环境真实验收（登录开启、管理员会话）：商品原图 256×256 PNG 上传 → `POST /api/product-images/input` 启用 `omyai-openai`（协议 `openai-images-edits-v1`，transport `json-data-url`）→ preflight `allowed:true` → `POST /api/jobs` 提交 `operation:edit`、`sourceAssetId`、low 质量，任务 `c43de04f-9775-4382-adfc-2d23c3c6ad7e` 成功，`GET /api/jobs/:id/image` 返回 800,484 字节 PNG。该调用由供应商计费一次，未自动重试。
- `npm test`：238 项后端与纯函数测试通过，其中 `tests/official-image.test.mjs` 11 项覆盖静态渠道配置、官方目录发现、生成请求体与 b64 解析、OMYAI JSON data URL 改图、其他渠道 multipart 字段与来源图字节、缺失 / 超限来源图、MCP / 截图 / 不存在原图拒绝、服务端原图读取与结果即时转存、生成版本从 MinIO 重传、存储失败不重生、幂等与参数冲突；全部使用假 fetch / 假对象存储，不产生付费调用。
- `npm run check`：服务端、外部及内联前端脚本语法。
- `npm run build`：React 构建成功。
- 渠道新增链路已用本机 Mock OpenAI 兼容服务验证：`/v1/models` 返回图像和视频模型，图像保存到数据库、视频只进目录，前端只看到 `••••1234`；测试渠道已删除。该验证不产生真实供应商费用。
- `npm run test:browser`：Chrome 下验证实时模型、已有图片下载、改图选择、390px 移动导航和提交响应中断后恢复同一请求。提交请求被模拟，不发生额外生图费用。
- 已知限制：动态 OpenAI 兼容渠道默认 multipart，若供应商只接受 JSON data URL 需增加配置；视频执行器未接入；商品原图还只能从生图页挑选，项目工作流未自动携带；批量参考图与画布未接入。
- 备份使用既有 PostgreSQL/MinIO 维护流程；`.secrets/channel-encryption.key` 必须与 PostgreSQL 一起安全备份，否则动态渠道密钥无法解密。退出服务不会取消供应商在途请求，重启后按任务状态恢复；同步图片渠道的临时结果在进程重启后不可恢复，需要查询供应商日志。数据保留与删除策略待明确后再实现。

</details>

## 多张参考图与蒙版（2026-10-26 实测）

- 生图 / 改图节点有图片输入时走 OpenAI 标准 `POST /images/edits`。`editTransport=json-data-url`（OMYAI）时：单张 `image` 为 data URL 字符串，多张为 data URL 数组；蒙版为 `mask` data URL。其他渠道用 multipart：单张字段 `image`，多张重复 `image[]`，蒙版字段 `mask`。
- 蒙版语义：与主图同尺寸的 PNG，alpha=0 的区域重绘，其余保留；只作用于第一张（主）图。
- OMYAI `gpt-image-2.5-flare` 已真实验证：两张参考图合成 HTTP 200（输入图像 token 830，约为单图 415 的两倍，说明两张均被读取）；蒙版改图 HTTP 200，只在透明区域生成内容。其他渠道尚未实测。

## MiniMax H3 视频与火山引擎语音（2026-10-27）

- H3：`content` 按方式组装（文字 / 首尾帧 / 全能参考），素材以 Data URL 发送，提交前服务端压缩（图片短边 1080、视频 720p / 24fps H.264），请求体不超过 72 MiB；`blocked` 记为 `CONTENT_BLOCKED` 并显示平台原因；积分单价存于渠道 `executorConfig.pointPrices`（默认 480P 5、768P 10、1080P 19、2K 20、4K 22 积分 / 秒）。2026-10-27 真实验收：全能参考 480P 4 秒成功，扣 20 积分。
- 火山引擎语音：渠道 adapter `volcengine-tts`，固定 `https://openspeech.bytedance.com`，`executorConfig.resourceId` 为 `seed-tts-2.0`（系统 2.0 音色）或 `seed-icl-2.0`（复刻 / 设计音色）；合成用 V3 HTTP Chunked 流式接口，音色设计用 `/api/v3/tts/voice_design`；用量按字符记录。系统音色库 `config/voices.json` 由 `scripts/build-voices.mjs` 从官方音色列表生成。2026-10-27 真实验收：渠道 `ch_4af4d421d0035f53`（密钥加密保存，仅显示末四位）设为语音默认；系统音色 `zh_female_vv_uranus_bigtts` 与 `ICL_uranus_zh_female_kefuwanjun_tob` 均用 `seed-tts-2.0` 合成成功（22 字，约 1.3 秒返回，mp3 24 kHz 单声道约 4.3 秒），`ICL_` 系统音色无需改用 `seed-icl-2.0`；开启字幕时返回逐字时间戳，首个字幕事件可能为空，`flattenWords` 能正确合并，换算出的字幕区间正确。共消耗 51 字符。
