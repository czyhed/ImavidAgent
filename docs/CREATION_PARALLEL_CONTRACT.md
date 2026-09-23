# v2 并行实现接缝（2026-10-22）

统一范围 docs/FUNCTIONAL_SPEC.md 与 requirements/creation-workbench-grilling.md。三路独立 worktree，主协调者集成。不得真实付费调用，不得打印或提交凭据。已有依赖可链接主目录 node_modules，不安装新依赖。所有模块真实 PostgreSQL 持久化，保留工作区/权限/CSRF/乐观锁。

## 所有权

- product-assets：server/creation-store.mjs、server/creation-media.mjs、server/creation-products.mjs、server/creation-lifecycle.mjs、server/routes/creation-products.mjs、server/routes/creation-assets.mjs、web/src/components/CreationProducts.jsx、CreationAssets.jsx、CreationTrash.jsx、对应独立 CSS 与 tests/creation-products*。负责聊天/手工字段/资料素材分离、模板 CRUD、回收站、引用及永久删除。
- project-canvas：server/creation-projects.mjs、server/routes/creation-projects.mjs、web/src/components/CreationProjects.jsx、CreationProjectCanvas.jsx、对应独立 CSS 与 tests/creation-projects*。负责主 React Flow 无限画布、规划确认、DAG、预览启动、版本冻结、恢复/取消、成本与归集。
- model-video：server/model-hub.mjs、server/channels.mjs（仅协议兼容新增）、server/providers/creation-*、server/routes/model-hub.mjs、web/src/components/CreationModels.jsx、对应独立 CSS 与 tests/creation-model*。负责目录人工能力默认、OpenAI/Anthropic 文本视觉、图片和 MiniMax H3 执行器。
- coordinator：index/http/App/backend 连接、迁移、dashboard/System整合、清理/部署、总文档/测试/集成。其余文件修改先邮件协调。每个 worker 完成代码测试后在自己分支提交，不推送或部署，报告 SHA 和 API。

## 共用接口

CreationStore(pool) 公开 get(workspace,id,client?)、list(workspace,kind,trash=false)、create(workspace,kind,body,client?,id?)、change(workspace,id,expectedRevision,fn(current,client))；pool 可用于事务 SQL。fn 返回完整记录，null 不变。记录 id/workspaceId/kind/revision/trashedAt/createdAt/updatedAt 由服务器保护。所有产品/项目/素材/模板存 sj_creation_records，执行存 sj_creation_runs。

ModelHub(store,channels,{transport=fetch}={}): catalog() => {models,defaults}; sync(channelId); configure(channelId,modelId,patch); setDefault(stage,channelId,modelId); resolve(stage,selection?) => 模型快照；complete({stage,model?,messages,system?}) => {text,usage}; submitGeneration(snapshot) / pollGeneration(snapshot,upstreamId) / cancelGeneration(snapshot,upstreamId) => {status,upstreamId?,bytes?,mime?,usage?,error?}。stage 为 product/planning/image/video，人工能力为 text/vision/image/video；snapshot 含 kind(image/video),model({channelId,modelId,...}),prompt,params,sourceImage?({bytes,mime,url?}),requestKey。unknown 不自动重新 submit。传输失败不泄漏原始 key。文本 complete 只调用一次并保存 usage，不自动重试。

CreationMedia(store,minioClient,{bucket='shangjing-assets',publicOrigin?,signingKey?}={}): put(workspace,{bytes,mime,name,productId?,projectId?,taskId?,runId?,role?}) => asset记录；read(workspace,id) => {bytes,mime,name}；source(workspace,id) => 同read；remove(workspace,id) 清理该对象所有版本；publicUrl(workspace,id) 返回仅该文件短时签名链接（未配可信公开TLS明确拒绝）。产品附件 role=evidence，创作素材 role=creative，产出 role=result；项目只能选creative/result。路由同源 /api/creation/assets/:id/file，视频 range 支持。

CreationProducts(store,{hub,media})，CreationProjects(store,{hub,media})，CreationLifecycle(store,{media})：各实现 API/构造器自行报告，根集成注入 ctx.creationProducts/creationProjects/creationLifecycle/creationMedia/modelHub。路由导出既有 routes() 数组；客户端 API 统一 /api/creation/* 与 /api/model-hub/*，可另建自己 lib 不改共用 backend.js。React组件 props {backend,notify,onOpenProject,onOpenProduct,onCreateProject,productId,projectId}按需使用，backend session/csrfToken 见既有 lib/backend.js。共用 auth canWrite/canAdmin，真正权限在服务端。

项目 body {name,productId,productSnapshot,tasks:[],edges:[],viewport?}；task {id,kind:image|video,title,prompt,params,model?,position:{x,y},productSnapshot?,sourceAssetId?,sourceRunId?,subject:product|concept}。edges {id,source,target}；图不允许环。商品 body {name,facts:{},manualFields:[],messages:[],evidenceIds:[],creativeAssetIds:[]}；素材 body 至少 {name,mime,objectKey,role,productId?,projectId?,taskId?,runId?}。精确成功版本以runId选定，禁止自动最新。删除引用检查上述字段和run.input。

中央不可改动旧迁移；0018由协调者维护，需求发邮件。前端入口由协调者切换，无旧报价/充值/强制审核。先完成可真实使用全流程，然后集成验收修正。
