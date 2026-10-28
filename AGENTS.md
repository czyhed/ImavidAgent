# 项目接续说明

更新：2026-10-23。活动范围以 `docs/FUNCTIONAL_SPEC.md` v2.0 与 `docs/requirements/creation-workbench-grilling.md` Q01—Q43 为准。状态、验证、待办及 v1 历史见 `docs/STATUS.md`。创作 v2 已部署，运行提交 b988769；5cc169e 仅补测试 / 验收，运行代码一致。精确版本、备份和回退见 docs/infrastructure/app-deployment.md。

## 接续顺序

1. 先读 `docs/README.md`、`docs/STATUS.md`，再读功能基线及全部 Q01—Q43；术语以 `GLOSSARY.md` 为准，架构取舍见 `docs/adr/`。旧四会话稿、六步专题、报价 / 预占账本 ADR 与 archive 仅作历史，不覆盖 v2。
2. 模型 / 媒体 / 渠道读 `docs/infrastructure/model-providers.md`；部署 / TLS / 维护 / 备份读 `docs/infrastructure/test-middleware.md`；执行进度见 `docs/CREATION_IMPLEMENTATION_PLAN.md`。
3. 主流程：商品长期聊天 → 独立创作素材 → 项目无限画布 → 手动 / AI 安排 → 预览并开始 → 下游手选具体成功版本 → 再开始。报价、充值、余额门槛及强制候选 / 审核 / 六步已退出活动功能；成功立即可用、打包按需。

## 活动实现与验证边界

- 活动前端为 web/src 的 Creation 五菜单，React 19.3.1 + Vite 8.3.5（JS/JSX）、@xyflow/react 12.12.0；Node 静态白名单提供 web/dist 与分包。活动 API 为 /api/creation/*、/api/model-hub；旧业务入口返回 410 LEGACY_RETIRED。旧 prototype / 六步组件 / sj:prototype:* 演示键和旧浏览器脚本仅历史参考。
- PostgreSQL 持久保存聊天 / 事实 / 建议、项目任务 / 图修订、冻结输入与多次生成；evidence 图只识别，creative 独立上传或显式转入才用于生成。商品更新由用户同步至未开始任务；来源固定具体成功版本，不自动取最新。
- AI 只建议；用户预览范围再点击开始。同编号与参数幂等；2026-10-28 起不再有「待核实 / unknown」（ADR-0010 覆盖旧规则）：无上游编号的提交超时 / 出错 / 5xx / 响应丢失直接 failed（SUBMIT_UNCONFIRMED），用户一键重试，可能多计一次费用；有上游编号则持续轮询，连续失败超 30 分钟才 failed（POLL_FAILED）；取消立即落为 cancelled。仍不自动重提 / 换模型 / 付费重试。
- OMYAI / OpenAI 兼容图片、OpenAI / Anthropic 文本与读图、MiniMax H3 视频执行器已实现；H3 仅协议 fixture 验证，未做真实付费调用。截图识别需配置 text + vision 渠道，DeepSeek 启动默认仅 text。新 creation-http 安全传输只直连，不支持 MODEL_HTTPS_PROXY。
- 模型目录与执行能力分开：新发现禁用，人工能力及执行器分别校验，失败保留配置，消失标不可用，不自动换默认。回收站保留已有项目引用；永久删除仅管理员先预览，含回收站项目引用也阻止；无自动清理。
- 保留 session 优先、登录 / 本机首次初始化 / 强制改密、HttpOnly 会话 / 退出、成员和三角色逐接口鉴权。SJ_AUTH=off 默认本机单用户，on 启用登录；管理员全权，运营业务写 / 模板 / 移入恢复，查看者只读；模型配置 / 永久删除仅管理员。密码 / 会话令牌不入 localStorage / URL / 日志，前端隐藏不替代鉴权。
- 按 STATUS 的新独立 SQL / 整站浏览器命令验证。协调者已补 test:creation、v2 test:browser 聚合脚本，旧 browser-smoke 改 test:browser:legacy；以合并后的 package.json 为准。fixture 不能视作真实供应商付费验收。最终 test:creation 58/58、npm test 283/283、五套 v2 browser 与 check / build 通过；独立 QA、三轮审查及确认项修复完成，边界见 docs/CREATION_ACCEPTANCE.md。

## 凭据与基础设施约束

- 复用已部署 PostgreSQL、Redis、MinIO；203.0.113.10 与 203.0.113.11 是同机两公网 IP，不是主备。用户授权公网直连，必须 TLS、项目 CA、独立应用账号；中间件证书 2027-10-19 到期，应用 8443 证书 2027-11-22 到期。端口 / 目录冲突先核查，保留其他服务与持久数据。
- 应用配置 .env.middleware.local，账号表 .secrets/middleware-access.local.md，管理密码 .secrets/middleware-admin.json，SSH .secrets/server.json，模型配置 .env.models.local。仅任务必要且授权范围内读取；密码 / Key / 完整连接串不打印、提交 Git 或写公开文档。换电脑安全迁移凭据 / CA 并更新路径。
- 动态 Key AES-256-GCM 加密存 sj_model_channels，浏览器仅末四位掩码，提交不入 localStorage / URL / 日志。32 字节 .secrets/channel-encryption.key（首次生成，或 CHANNEL_ENCRYPTION_KEY 覆盖）必须随数据库安全备份，丢失则动态 Key 不可恢复。config/providers.json 仅公开配置。
- Redis 键 / 频道前缀 sj:，BullMQ prefix sj:bullmq；MinIO 仅私有 shangjing-assets / shangjing-exports。浏览器不持有服务密码 / 长期 MinIO Key。服务端读字节上传供应商，不假定其信任私有 CA，不交付私有 MinIO URL；外链逐跳校验公网 DNS / 地址、体积与媒体签名。
- 远程维护可用 python scripts/middleware/remote.py '远程命令'（Python / Paramiko），首次信任记录主机密钥，变化须核实。Meta/Clash TUN 曾影响 SSH；私密 server 配置有物理网卡选项，换网络核对接口 / 源地址，不直接判服务器故障或删除主机记录。
- Q41—Q43 只授权本应用旧测试业务及归属对象显式清理；保留账号权限、渠道密钥、模型配置、预制模板、结构与基础设施。先核归属、备份与恢复验证，不清整个数据库 / Redis / 共享桶 / 持久化卷；启动迁移不删除数据。
- 2026-10-23 授权旧测试业务清理已完成：59 条旧业务、14 个对象版本，账号 / 配置 / 模板 / 中间件保留，不重跑清理。新备份 /opt/shangjing-app/backups/creation-v2-20261022T140915Z/before-cleanup-20261023T004641Z 已隔离恢复验证；旧对象字节 / SHA-256 在原批次 objects/。备份同盘，异机副本待安全迁移；线上无付费 PG / MinIO 烟测通过且自身记录已清除。维护 / 部署后同步 STATUS 与接入文档。

## Agent skills

### Issue tracker

Issues 记录在 GitHub `czyhed/ImavidAgent`，通过 `gh` CLI 操作。See `docs/agents/issue-tracker.md`.

### Triage labels

使用默认 7 个分诊标签（bug / enhancement / needs-triage / needs-info / ready-for-agent / ready-for-human / wontfix）。See `docs/agents/triage-labels.md`.

### Domain docs

Single-context：术语表 `GLOSSARY.md`，ADR 在 `docs/adr/`。See `docs/agents/domain.md`.

### External peers

`auto`：按宿主自动选择 Claude 或 Codex 适配器，模型默认、effort high。See `docs/agents/cross-model.json`.

16. 2026-10-25 晚 B 版 UI 与视频工作台（在前一条之上生效）：
   - 全站 UI 按 `output/ui-concepts/B-full-suite/`（30 张图册）重做：`web/src/styles/theme.css` 蓝色设计系统（#385AE8 主蓝 / #F5F7FA 画布 / #25313E 文字 / 10px 圆角）、顶部导航外壳替换左侧栏，旧 base.css 已删除；删除类确认统一走 ConfirmDialog。
   - 画布 v4：节点类型工具条、左侧工具栏、节点卡带进度条与版本切换、任务维度标签 + 「整理布局」（`web/src/lib/canvas-layout.js`：维度分 lane、层级兜底）、属性面板含来源版本选择、队列含计数页签 / 模型列 / mm:ss 耗时。
   - 视频工作台：项目内「画布 / 视频工作台」双视图（`CreationVideoStudio.jsx`）；AI 生成脚本与分镜走 planning 环节默认模型；分镜即画布 video 节点（storyboard 存项目 JSONB，路由 `/api/creation/projects/:id/storyboard*`，写需运营 + CSRF + If-Match）；全部成功后 `server/video-compile.mjs` 服务端 ffmpeg 拼接成片（静音、首镜尺寸统一），归集为结果素材。音频环节已按用户确认移除；H3 仍无真实付费验收。
   - 画布稳定性：拖拽 / 连线手势与指针按下期间冻结轮询与节点重建；内容未变化跳过重建；CSS 强制 `.react-flow__node` 可见——三者共同消除「节点偶发隐藏 / 拖拽丢失」。
   - 验证基线：`npm test` 290/290、`test:creation` 65/65（含 7 项分镜集成）、五套 v2 browser（画布 QA 含视频冒烟）、check / build 通过。线上 `d75cdc0` 已部署并完成无付费烟测；部署前备份 `pre-deploy-20261025T144607Z.sql`；镜像含 ffmpeg 5.1.9；详见 `docs/infrastructure/app-deployment.md`。
15. 2026-10-23 创作画布 v3（覆盖第 8、12、13 条中关于「生图页三栏工作台」与单一图片/视频任务节点的描述）：
   - 项目画布为深色工作台，节点类型为商品输入、图片输入、提示词、生图、改图、合成、视频、输出；连线按 text / image / video 类型校验，合成节点在浏览器内拼图并上传结果，不调用模型。
   - 底部任务队列显示运行中/排队/成功/失败、耗时、费用、错误原文，支持取消、核实、单条重试与重试全部失败；运行前统一弹出执行范围预览，「重试」为确认后直接创建新请求。
   - 右侧为紧凑属性面板；生成历史移入任务队列。旧版 ProjectPage / 六步 / WorkflowCanvas / GenerationStudio / 旧 Products、Dashboard、Projects、Assets、WorkflowEditor 组件已删除，`CreationProducts` 改为 ChatGPT 式聊天优先，工作台首屏展示跨项目运行中与待处理任务。
   - 旧图（无端口字段、kind=image/video）仍可被服务端执行以兼容测试；新项目由前端携带 `graphVersion:3` 生成八类节点图。上线 v3 时用 `node server/scripts/creation-reset-projects.mjs --yes（容器内 /app/server/scripts）` 清空旧项目、运行记录与回收站（保留商品、素材、模板、账号、模型与渠道），清理前必须 `pg_dump`。
   - 验证：`npm run check`、`npm test`（283）、`npm run test:creation`（58）、`npm run test:browser`。
