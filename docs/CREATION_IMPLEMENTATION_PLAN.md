# 创作工作台 v2 执行计划

更新：2026-10-23。范围为 [FUNCTIONAL_SPEC.md v2](FUNCTIONAL_SPEC.md) 和全部 [Q01—Q43](requirements/creation-workbench-grilling.md)。开始点 main@16c693c；运行版本 b988769 已先推送后部署，5cc169e 补齐最终回归覆盖，运行代码一致。实现、独立验收与线上烟测均已完成，证据边界见 CREATION_ACCEPTANCE.md。

| 顺序 | 可验收交付 | 当前状态与边界 |
| --- | --- | --- |
| 1 | 用户决定、基线、术语 / 架构、导图 | 已落文档，初始提交 18d2a00；本次同步活动状态与接续规则 |
| 2 | 加密动态渠道、目录 / 手工能力 / 四环节默认、文本与视觉 | 已集成 ModelHub、OpenAI / Anthropic、配置并发保护与密钥轮换；真实临时 SQL / 协议 fixture 验证；截图需另配 vision，DeepSeek 启动仅 text |
| 3 | 商品长期聊天、冲突合并、资料 / 创作素材分离 | 已集成持久聊天、第一消息建档、事实 / 手工字段保护、附件用途与显式转素材；失败保留资料 |
| 4 | React Flow 主画布、版本、AI 建议、依赖执行 / 恢复 | 已集成无限画布、任务 / 参数 / 布局持久化、范围预览与显式开始；下游手选具体版本，未知不重提；独立 SQL / 浏览器及整站 fixture 通过 |
| 5 | MiniMax H3、视频首帧、取消 / 转存 | 已实现文字 / 单图首帧与提交 / 查询 / 取消 / MP4 下载；模拟供应商验收，未发真实付费 H3 请求 |
| 6 | 模板 CRUD、归集、回收站与永久删除 | 已集成持久图 / 视频模板、套用快照、成功结果归集、恢复、管理员影响预览 / 引用阻止 / 版本化对象清理 |
| 7a | 自动测试与集成验证 | 已完成：npm test 283/283、test:creation 58/58（含12项运行回归）、check / build 197 modules、五套 v2 browser、生产 Docker 构建 / 导入通过；付费模型模拟 |
| 7b | 独立 QA、最终三轴评审 | 已完成：独立 QA 20 通过 / 4 部分受限；三轮审查所有确认项已修复，最后覆盖缺口在 5cc169e 补齐；见 CREATION_ACCEPTANCE.md |
| 7c | 归属核对、备份恢复、旧测试数据清理 | 已完成：新备份隔离恢复计数 6/6/6/1；14 对象版本备份与 SHA-256 验证后删除；旧业务清理 59 条，保留账号 / 配置 / 模板 / 中间件 |
| 8 | 最终提交推送、部署、健康与无付费烟测 | 已完成：b988769 精确 SHA 镜像上线，TLS / healthy / 静态包通过，8 组真实 PG / MinIO 烟测通过，测试数据与临时会话 / 脚本已清除，付费调用 0 |

## 交互与实现基准

复用绿灰视觉与 React 19.3.1 / Vite 8.3.5 / @xyflow/react 12.12.0 / Node / pg / MinIO；未新增注册表依赖。中央无限画布、左侧商品 / AI 安排、右侧任务参数 / 来源版本 / 历史，手机上下布局与触控缩放。视觉基准保持背景 #f3f5f0、面板 #ffffff、正文 #20372b、主色 #245b44、边界 #d7dfd3、等待 #9a6c25；Microsoft YaHei / Noto Sans SC，正文 14px、标题 20px，真实结果预览优先。活动实现位于 web/src 的 Creation 页面，旧六步组件仅历史。

商品聊天先存消息，再整理明确事实；图片资料不默认用于生成，创作素材单独选择。AI 建议确认后才改画布，生成另由用户预览并开始。成功前置复用，下游手选具体结果后再次开始；同任务多版本与冻结输入可追溯。取消报价与内部额度门槛，未知成本未统计；成功即可下载，ZIP 按需，无强制审核。

## 测试与配置前提

完整命令及证据见 STATUS。独立测试入口为 creation-model / creation-products / creation-projects 的 SQL 与浏览器脚本、creation-overview / creation-http / creation-cleanup / creation-file-cleanup，以及 creation-app.integration / creation-app-browser。协调者已补 npm run test:creation 与 v2 test:browser 聚合；test:browser:legacy 保留 v1 browser-smoke，聚合以最终 package.json 为准。临时 SQL 与本地 S3 / 供应商 HTTP fixture 不连接共享业务数据，不产生真实费用；真实 MinIO SDK 调用 fixture 不代表集群或付费供应商验证。

- 商品截图识别需商品默认模型具备 text + vision 及兼容执行器；DeepSeek bootstrap 仅 text，配置尚缺时应明确报错并保留消息。
- H3 配置 video 执行器；首帧服务端读取图片并传 data URL，不交付私有 MinIO URL。H3 未真实付费验证。
- 新 creation-http 传输固定公网 DNS 安全检查并直连，不支持 MODEL_HTTPS_PROXY；协调者已验证实际服务器三个供应商 HTTPS 端点直连可达；这不证明认证 / 模型执行或付费成功，不以旧代理配置推断新链路可用。

## 清理与发布完成记录

2026-10-23 只停止应用进行维护，保留 PostgreSQL / Redis / MinIO 和其他服务。数据库新备份在隔离库恢复验证，配置 / 渠道主密钥同批归档，原清单 digest 核对未漂移，才执行 Q41—Q43 授权的本应用旧业务及归属对象清理。删除 59 条旧业务、14 个旧对象版本；保留账号权限、渠道密钥、模型配置、预制模板、结构和基础设施。**这次清理已执行，不作为待办重跑。**

新备份目录 `/opt/shangjing-app/backups/creation-v2-20261022T140915Z/before-cleanup-20261023T004641Z`；原批次 `objects/` 包含对象字节及 SHA-256。完整备份目前同盘，异机灾备尚待安全迁移。

代码先提交推送，按 b988769 完整 SHA 归档构建并在原服务上线；0018 / 0019 已应用。线上真实 CRUD、模板、引用保护及 MinIO 上传 / Range / 全版本删除均通过；临时烟测内容、会话和管理员环境已移除，生成运行数为 0。运行版本、目录、账号名、配置位置、证书有效期与回退步骤见 [app-deployment.md](infrastructure/app-deployment.md)，不在接续时重复清理或部署文档专用提交。

## 历史计划说明

先前“各独立 worktree 实现中 / 待集成”描述的是 18d2a00 后的分派阶段；在 a8b6158 已由上表集成状态取代。旧六步 / 报价计划与 PROJECT_COMPLETION_PLAN 的 v1 完成度只作历史，不作为本次任务待办；原 v1 状态与部署证据保留在 STATUS 的历史归档。
