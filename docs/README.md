# 文档索引

更新：2026-10-26。当前功能范围是创作工作台 v2，完整决定为 Q01—Q43，并叠加用户确认的全站 B 版与任务画布；需求、代码验证与服务器部署分别记录。

2026-10-26：全站 B 版与项目左侧任务列表 / 节点内编辑已上线，当前运行提交 `d2cd6df`，已修复大项目保存 413 与视频参数显示 / 执行不一致。用户实际 13 个任务预览全部通过，未启动生成；实现与验收见 [STATUS 最新记录](STATUS.md)，备份及精确镜像见 [部署记录](infrastructure/app-deployment.md)。

## 阅读顺序

1. [根目录 AGENTS.md](../AGENTS.md)：接续规则、基础设施与私密配置约束。
2. [STATUS.md](STATUS.md)：已实现能力、测试证据、当前部署与未完成事项。
3. [FUNCTIONAL_SPEC.md v2.0](FUNCTIONAL_SPEC.md) 和 [完整 Q01—Q43](requirements/creation-workbench-grilling.md)：统一功能范围与用户决定，需求确认不等于实现 / 发布完成。
4. [GLOSSARY.md](../GLOSSARY.md) 与 [adr/](adr/)：领域术语与架构取舍；引用旧 ADR 时核对是否被 v2 覆盖。
5. 模型 / 媒体工作读 [model-providers.md](infrastructure/model-providers.md)；部署 / 备份读 [test-middleware.md](infrastructure/test-middleware.md)。
6. [CREATION_IMPLEMENTATION_PLAN.md](CREATION_IMPLEMENTATION_PLAN.md)：实施里程碑与发布完成记录。

## 当前入口与状态

五菜单为工作台 / 项目 / 商品 / 素材 / 系统。活动 React Creation 页面连接 `/api/creation/*` 与 `/api/model-hub`：长期商品聊天、独立创作素材、项目 React Flow 无限画布、AI 建议与手动开始、具体版本选择、图片 / H3 视频执行器、持久模板与回收站。报价、充值、余额预扣及强制候选 / 审核 / 六步交付已退出活动入口。

**当前运行 `2a0a89d`，入口 `https://203.0.113.10:8443`。** 全站 B 版与任务画布于 2026-10-26 更新；`npm test` 293/293、`test:creation` 67/67、五套浏览器及 check / build 通过，独立交互复验通过。部署前备份及隔离恢复通过，线上 TLS、静态资源、会话鉴权与已有业务读取验证通过；本次保留全部业务数据，未执行历史清理或付费生成。详见 [STATUS](STATUS.md)、[验收记录](CREATION_ACCEPTANCE.md) 和 [应用部署](infrastructure/app-deployment.md)。

H3 未做真实付费调用；截图识别需兼容 vision 模型，DeepSeek 启动默认仅 text；供应商安全传输仅直连。备份目前同盘，异机副本仍待安全迁移。

## 目录与权威范围

| 位置 | 内容与使用条件 |
| --- | --- |
| `FUNCTIONAL_SPEC.md` | v2 功能基线；改范围先核对这里与 Q01—Q43，再同步导图 |
| `requirements/creation-workbench-grilling.md` | 本次完整用户决定与清理 / 部署授权，补充文字优先于选项编号 |
| `requirements/video-storyboard-v2-grilling.md` | 生视频重做 V-01～V-25：四种生成方式、素材引用与标签、分镜与画布单一配置、积分、火山语音配音与字幕；取代旧的「仅文生 / 首帧、成片无声」限制 |
| `STATUS.md` | 当前能力、验证命令、部署边界、v1 历史归档；开发 / 维护后更新事实与结果 |
| `CREATION_ACCEPTANCE.md` | 独立交互 QA、三轴审查、回归与发布证据边界 |
| `CREATION_IMPLEMENTATION_PLAN.md` | v2 里程碑、QA / 评审、备份清理和发布完成记录 |
| `../GLOSSARY.md` | 当前商品、任务、生成记录、具体版本、模型能力等领域术语 |
| `adr/0003-canvas-creation-without-quotation.md` | 画布创作取代六步 / 报价；旧预占账本 ADR 与之冲突部分仅历史 |
| `infrastructure/model-providers.md` | v2 渠道 / 能力 / 默认配置、文本 / 视觉 / 图像 / H3 协议与验证限制 |
| `infrastructure/test-middleware.md` | 实际 PostgreSQL / Redis / MinIO、TLS、账号位置、维护与备份；其中有日期的旧业务描述须结合 STATUS |
| `infrastructure/app-deployment.md` | 应用精确运行版本、无付费线上烟测、备份与回退 |
| `infrastructure/deployment-record.json` | 非私密中间件部署元数据，不据此推断 v2 应用已发布 |
| `agents/` | Issue、分诊标签、领域文档与外部评审配置 |
| `requirements/function-map.json`、`ecommerce-ai-feature-mindmap.*` | 导图数据及 HTML / SVG / 文字树；按生成脚本维护，不手改生成内容 |
| `PROJECT_COMPLETION_PLAN.md` | v1 完成度审计与分期历史，不作为 v2 实施进度或范围 |
| `product/project-workflow.md`、`product/product-intake.md` | v1 六步 / 规划 / 商品三路录入专题；涉及与 v2 冲突的入口和门禁只作历史 |
| `requirements/discussion-decisions.md` | v1 用户原话确认记录；本次覆盖项以 Q01—Q43 为准 |
| `archive/` | v1.1 功能基线、早期 PHASE1 与专题历史；只读，不覆盖 v2 |

## 验证入口

先运行 `npm test`、`npm run check`、`npm run build`，再按 STATUS 的独立 v2 SQL / 浏览器命令验证。`npm run test:creation` 聚合创作回归，`npm run test:browser` 聚合五套 v2 浏览器；旧浏览器入口为 `npm run test:browser:legacy`。旧文件名包含 real 的浏览器测试仍为 v1 历史回归，不能替代新整站测试或付费供应商验证。
