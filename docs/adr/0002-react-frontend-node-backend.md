# 前端整体迁移到 React + React Flow，后端保持 Node.js

现有前端是单个纯 HTML/JS 原型页，React Flow 依赖 React。用户选择整体迁移到 React，而不是只给画布单独做一个 React 岛或继续原生实现；后端继续用 Node.js，框架未定。迁移顺序（汇总约定）：先原样迁五个菜单并对齐浏览器测试，再做画布。在此之前，评审原型中的画布是原生 HTML/CSS 简化实现，不代表最终交互。依据：D-W-06。

**Consequences**：`prototype/*` 与 `tests/*-browser.mjs` 随迁移重写；后端静态白名单改为服务构建产物；TypeScript 与构建工具在迁移开始时决定（Q-11）。

**2026-10-21 更新（Issue #5 Phase 1）**：五菜单已迁移到 `web/`，采用 React 19.3.1 + Vite 8.3.5，语言为 JavaScript/JSX（不引入 TypeScript）；构建到 `web/dist`，文件名固定为 `assets/app.js` / `assets/app.css`，由 Node 静态白名单提供。旧 `prototype/prototype.html` 路径保留为回退。浏览器测试已针对 React 版本运行。React Flow 画布仍属 #15，当前项目画布继续使用原生简化实现。

**2026-10-21 更新（Issue #15 已实现）**：项目画布已在 `web/src/components/WorkflowCanvas.jsx` 用 `@xyflow/react` 12.12.0（精确锁定）替换原生简化实现，`web/src/lib/flow.js` 提供纯函数图模型与校验。画布与六步视图共用浏览器本地演示状态 `sj:prototype:review:v1`，未接入服务端项目 / 工作流 API。拖拽位置会保存并在刷新后回读；连线在落盘前按服务端同款规则校验（自环、有向环、重复边、端口类型、必需输入），锁定根节点不可删除，手机 ≤760px 只读。构建仍为单入口并输出固定文件名，Node 静态白名单和旧原型回退不变；新增依赖只影响包体（`app.js` 约 563 kB，gzip 约 176 kB），不改变服务端路由或数据。
