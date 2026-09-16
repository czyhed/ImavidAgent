# 商境 · 电商内容工作台

依据 [功能开发基线](docs/FUNCTIONAL_SPEC.md) 制作的本地前端原型，用于评审单商品、单 SKU 的创作流程。2026-10-20 已更新为五菜单评审版：工作台、项目、商品、素材、系统。

## 后续开发依据

四个议题已汇总为 [功能规格与开发基线 v1.1](docs/FUNCTIONAL_SPEC.md)，包含功能编号、业务规则、跨模块约定、数据/API 草案、实施顺序和验收清单。新开发按该文档执行；它描述目标范围，不表示功能已经上线。2026-10-21 新增 [项目 AI 规划与自定义工作流](docs/product/project-workflow.md)：前端定为整体迁移到 React + React Flow，迁移尚未开始。

- [交互功能思维导图](docs/ecommerce-ai-feature-mindmap.html)：本地浏览器打开，可展开、搜索、筛选、缩放并查看功能说明。
- [完整 SVG 导图](docs/ecommerce-ai-feature-mindmap.svg) / [文字树与 Mermaid](docs/ecommerce-ai-feature-mindmap.md)。
- [四会话用户确认记录](docs/requirements/discussion-decisions.md)：区分用户决定与智能体建议。
- 修改功能表后运行 `python scripts/docs/build_feature_map.py`，同步导图与 `docs/requirements/function-map.json`。

## 开发接续与测试中间件

后续智能体先读 [AGENTS.md](AGENTS.md) 和 [测试中间件接入文档](docs/infrastructure/test-middleware.md)。PostgreSQL、Redis、MinIO 已独立部署，支持公网 TLS 访问。实际中间件配置在 Git 忽略的 `.env.middleware.local`，OMYAI 密钥在 `.env.models.local`。生图服务已接入 OMYAI、PostgreSQL 和私有 MinIO；系统页可新增 OpenAI 兼容渠道，图像模型可执行生图，视频模型只同步目录。火山方舟和真实视频执行尚未接入。

## 启动

使用 Node.js 24 或更高版本。当前电脑的私密配置已就绪；新电脑需安全迁移配置与 CA，详见 [模型接入文档](docs/infrastructure/model-providers.md)。

```sh
npm ci
npm run dev
```

打开 http://127.0.0.1:4173。可以直接继续首页示例项目，或新建项目并选择白色收纳盒，体验六步流程。

真实能力入口：「项目 → 示例项目 → 03 制作任务 → 打开真实单图面板」；渠道配置入口：「系统 → 模型中心 → 管理真实渠道」。真实单图面板保留提示词、模型、参数、历史结果和计费确认；任务尚未绑定项目，项目示意图和商品原图不会自动发给模型。直接打开 HTML 只能预览，不能新增渠道或调用真实服务。

## 原型边界

- 「商品」支持手动、截图、1688 链接三个入口。截图示例直接建待核实草稿，显示字段证据与置信度，重复示例打开同一记录；自选图片仅本地预览，不进行识别。淘宝/天猫链接引导截图或手动。资料仅存当前浏览器，真实识别、抓取、商品数据库仍待开发。「用于创作」进入新项目草稿。
- 真实单图面板与真实渠道管理接入服务；生成和修改会产生供应商费用，页面不虚构精确价格。
- 系统页支持新增、停用、删除 OpenAI 兼容渠道，保存前自动读取模型。新增渠道的图像模型可从「生图」执行；视频模型只同步目录，视频执行器尚未接入。
- 生图工作台目前一次任务生成 1 张；参考图区域只能选择已生成图片作为改图源，任意图片上传和批量多张尚未接入。
- 「项目」支持本地新建、筛选、资料预检、模板方案、确认冻结、模拟批次、失败项人工重试、未知原请求核对、精修版本和显式候选、逐项审核、带原因撤销、部分交付清单下载。只下载演示 JSON manifest，不提供假图片 ZIP；原型项目与真实任务未绑定。
- 「素材」只读展示当前 `/api/jobs` 返回的真实成功任务，可查看、下载、复制提示词和引用到项目草稿；当前仍受最近 50 个任务限制，不冒充全量分页。六个预制模板使用自制示意图，填写变量后带入项目草稿，不自动生成；视频仅展示分镜。
- 「系统」整合用户、账单、日志、模型中心、安全与说明。新增/编辑/停用用户、重置密码流程、登录预览、追加调账、脱敏日志 CSV、手动价格与 AI 查价候选确认均为本地演示。AI 查价不联网、不宣称示例价格真实。
- 演示项目、用户、价格与账本保存到 `sj:prototype:review:v1`，商品保存到 `sj:prototype:products:v1`。重置演示只清前一个键，保留商品及真实任务。工作台与演示账本同源。
- 当前仅限本机单用户使用。没有公网部署、登录权限、真实视频、商品参考图上传或生产级账本。
- 任务持久化到 PostgreSQL，成功图片转存私有 MinIO；网络中断或状态未知不会自动再次生图。
- 动态渠道密钥加密存入 PostgreSQL，主密钥在 `.secrets/channel-encryption.key`；该文件丢失后已保存的渠道密钥无法恢复，必须与数据库一起备份。

## 验证

```sh
npm test
npm run check
# 本地服务运行且安装了 Chrome 时；浏览器测试不提交付费任务
npm run test:browser
node tests/products-browser.mjs
node tests/review-browser.mjs
```

## 文件

- `prototype/prototype.html`：唯一页面入口及商品原型；`generation.js` / `generation.css` 包含既有真实单图功能和统一功能评审界面
- `server/`：本地 HTTP 服务、动态渠道与密钥加密、供应商适配器、任务与存储
- `config/providers.json`：静态 OMYAI 配置，不含密钥；动态渠道见接入文档
- `GLOSSARY.md`：领域术语
- `docs/`：文档库，入口为 [docs/README.md](docs/README.md)（实现状态 STATUS、功能基线、ADR、专题细则、接入文档、归档）
- `infra/`、`scripts/middleware/`：中间件部署配置与维护脚本
