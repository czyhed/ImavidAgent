# 开发票与依赖（backlog）

更新：2026-10-21。票在 GitHub Issues（`leifengyang/agent-project`），全部带 `ready-for-agent` 标签。本文件是依赖图与并行编排记录；票的正文以 Issue 为准。

## 依赖图

```text
无阻塞（可直接开）： #1 auth   #2 product   #3 gateway   #4 assets   #5 react

#1 auth ──┬─ #6 roles
          ├─ #7 bill ──┬─ #14 run
          └─ #8 log    └─ #20 pricelookup
#2 product ─┬─ #9 realimage
            ├─ #22 1688（条件验收）
            ├─ #10 screenshot ← #3 gateway
            └─ #11 planner ← #3 gateway ── #12 projects ─┬─ #13 workflow ─┬─ #14 run ── #16 refine ── #17 review ── #18 export
                                                          │                 └─ #15 canvas ← #5 react
                                                          ├─ #19 home ← #4 assets
                                                          └─ #21 templates ← #5 react
```

## 通道与迁移编号

每个票独占一个迁移编号，避免并行冲突：auth `0001`、product `0002`、gateway `0003`、bill `0004`、log `0005`、projects `0006`、workflow `0007`、assets `0008`、product-images `0009`、screenshot `0010`、screenshot-upload `0011`、price-candidates `0012`、run `0013`、refine `0014`、review `0015`、export `0016`。

## 并行规则

- 一个通道一个 git worktree、一个分支 `feat/<票号>-<slug>`，从 `main` 切出。
- 只新增文件：`server/<模块>.mjs`、`server/routes/<模块>.mjs`、`server/migrations/NNNN-*.sql`、`tests/<模块>.test.mjs`。必须改共享文件时做最小改动并在交付里说明。
- 不新增 npm 依赖（`react` 迁移票除外，且仅 React 与 `@xyflow/react`）。
- 不 push、不合并、不开 PR；由编排者审核后合并。
- 本地验证端口：通道 1 `4181`、2 `4182`、3 `4183`，其余顺延。
- 前端相关票（#5 #15 #21）不得与其他前端票同时运行，避免同一批组件文件冲突。

## 运行记录

| 波次 | 通道 | 票 | 状态 |
| --- | --- | --- | --- |
| 1 | 1 / 2 / 3 | #1 auth / #2 product / #3 gateway | 已合并（2026-10-21）；45 项后端测试与三个浏览器测试通过 |
| 2 | 4 / 5 / 6 / 7 / 8 | #4 assets / #5 react / #6 roles / #7 bill / #8 log | 已合并（2026-10-21） |
| 3 | 9 / 10 / 11 / 20 | #9 realimage / #10 screenshot / #11 planner / #20 pricelookup | #10 #11 #20 已合并；#9 门禁已合并、真实供应商验收受阻（开放） |
| 4 | — | #22 1688 / #23 截图上传 / #12 projects | #22 #23 #12 已合并（2026-10-21）；#22 条件验收未通过，保持开放 |
| 5 | 13 / 24 | #13 workflow / #24 login UI | 已合并（2026-10-21） |
| 6 | 14 / 21 | #14 run / #21 templates | 已合并（2026-10-21） |
| 7 | 15 / 16 | #15 canvas / #16 refine | 已合并（2026-10-21）；194/194 后端测试、五个浏览器测试通过 |
| 8 | 17 / 19 / 18 | #17 review / #19 dashboard / #18 export | 全部已合并（2026-10-21）；218/218 后端测试、六个浏览器测试通过；#18 合并烟测修复 `sj_projects.sku_snapshot` 误引用 |

第 1 波记录：通道 3 因会话中断从旧提交起分支，已按当前 `main` 重建（沿用其网关、DeepSeek 适配器与测试），并改为 `routes()` 自动发现；真实的 `deepseek-flash` 调用一次，prompt 36 + completion 20 = 56 tokens。登录默认 `SJ_AUTH=off`，前端登录页随 #5 开启。
