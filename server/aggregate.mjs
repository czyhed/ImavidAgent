import {
  PgProjectRepository, computeProjectStepState, deriveProjectStatus, projectLifecycleKey,
} from './projects.mjs';
import { BillingService, PgBillingRepository } from './billing.mjs';
import { AssetIndexService, PgAssetRepository } from './assets-index.mjs';

// 工作台只读聚合（Issue #19 / HOME-01—03）。
// 所有数字都来自现有业务表或现有服务；没有数据的字段返回 null，绝不用 0 或演示数字代替。
// 本模块不写数据库、不调用模型、不创建任务，金额只对管理员 / 运营 / 本机单用户返回。

const LOCAL_WORKSPACE = 'local';
const RECENT_PROJECT_LIMIT = 4;
const ACTIVITY_LIMIT = 8;

const TASK_STATUSES = Object.freeze([
  'queued', 'submitting', 'running', 'storing', 'succeeded', 'failed', 'unknown', 'cancelled',
]);
const ACTIVE_TASK_STATUSES = Object.freeze(['queued', 'submitting', 'running', 'storing']);
const PROJECT_STATUSES = Object.freeze(['draft', 'active', 'review', 'completed', 'cancelled']);
const STEP_LABELS = Object.freeze(['商品资料', '方案报价', '制作任务', '精修', '质检审核', '打包导出']);
const STEP_STATUS_LABELS = Object.freeze({
  in_progress: '进行中', completed: '已完成', needs_review: '需复核', skipped: '已跳过',
});
const JOB_EVENT_LABELS = Object.freeze({
  queued: '已排队', submitting: '提交中', running: '执行中', storing: '转存中',
  succeeded: '成功', failed: '失败', unknown: '状态未知', cancelled: '已取消', reconciled: '已核实',
});
const AUDIT_ACTION_LABELS = Object.freeze({
  'project.created': '创建项目',
  'project.updated': '更新项目',
  'project.cancelled': '取消项目',
  'project.plan.updated': '更新方案',
  'project.plan.confirmed': '确认方案',
  'project.plan.deliverables.added': '追加交付项',
  'project.step.updated': '更新项目步骤',
  'project.deliverable.executed': '交付项已执行',
  'refine.estimated': '精修估价',
  'refine.confirmed': '确认精修',
  'refine.completed': '精修完成',
  'refine.failed': '精修失败',
  'refine.unknown': '精修状态未知',
  'deliverable.version.imported': '导入交付版本',
  'deliverable.candidate.selected': '选定交付候选',
  'deliverable.rework.requested': '交付返修',
});

function integer(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function sumStatuses(byStatus, statuses) {
  return statuses.reduce((total, status) => total + (byStatus[status] || 0), 0);
}

function estimateFrom(price, deliverables) {
  if (!price || typeof price !== 'object') return null;
  return {
    currency: price.currency || 'CNY',
    totalCents: integer(price.totalCents),
    pendingPriceCount: integer(price.pendingPriceCount),
    deliverableCount: Array.isArray(deliverables)
      ? deliverables.length
      : integer(price.deliverableCount),
  };
}

function mapProject(row, events, evidence) {
  const project = { status: row.status };
  const plan = { status: row.plan_status, deliverables: row.plan_deliverables || [] };
  const stepState = computeProjectStepState({ project, plan, events, evidence });
  const status = deriveProjectStatus(
    project,
    stepState,
    row.plan_status === 'confirmed' || ['active', 'review', 'completed'].includes(row.status),
  );
  return {
    id: row.id,
    name: row.name,
    skuSpec: row.sku_spec ?? null,
    status,
    ownerId: row.owner_id ?? null,
    planVersion: integer(row.current_plan_version),
    planStatus: row.plan_status ?? null,
    progress: stepState.progress,
    currentStep: stepState.currentStep ? {
      step: stepState.currentStep.step,
      key: stepState.currentStep.key,
      label: stepState.currentStep.name,
      status: stepState.currentStep.status,
    } : null,
    estimate: estimateFrom(row.plan_price, row.plan_deliverables),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function projectMetrics(projects) {
  if (!Array.isArray(projects)) return null;
  const byStatus = Object.fromEntries(PROJECT_STATUSES.map(status => [status, 0]));
  for (const project of projects) {
    if (Object.hasOwn(byStatus, project.status)) byStatus[project.status] += 1;
  }
  return {
    total: projects.length,
    byStatus,
    awaitingPlan: projects.filter(project => project.planStatus === 'draft').length,
    awaitingPlanProjectId: projects.find(project => project.planStatus === 'draft')?.id ?? null,
    inReview: projects.filter(project => project.currentStep?.step === 5).length,
    inReviewProjectId: projects.find(project => project.currentStep?.step === 5)?.id ?? null,
    completed: byStatus.completed,
  };
}

function taskMetrics(tasks) {
  if (!tasks) return null;
  const byStatus = Object.fromEntries(TASK_STATUSES.map(status => [status, 0]));
  for (const status of TASK_STATUSES) {
    byStatus[status] = integer(tasks.byStatus?.[status]) ?? 0;
  }
  return {
    total: integer(tasks.total) ?? sumStatuses(byStatus, TASK_STATUSES),
    active: sumStatuses(byStatus, ACTIVE_TASK_STATUSES),
    succeeded: byStatus.succeeded,
    failed: byStatus.failed,
    unknown: byStatus.unknown,
    byStatus,
  };
}

function productMetrics(products) {
  if (!products) return null;
  return {
    total: integer(products.total),
    pending: integer(products.pending),
    pendingProductId: products.pendingProductId ?? null,
  };
}

function outputMetrics(outputs) {
  if (!outputs) return null;
  return {
    total: integer(outputs.total),
    available: integer(outputs.available),
    unavailable: integer(outputs.unavailable),
  };
}

function amountsFor(billing, visible) {
  if (!billing || !visible) return null;
  return {
    currency: billing.currency || 'CNY',
    period: { from: iso(billing.from), to: iso(billing.to) },
    settledCents: integer(billing.settledCents),
    costOnlyMicros: integer(billing.costOnlyMicros),
    pendingPriceCount: integer(billing.pendingPriceCount),
  };
}

function item(key, label, detail, count, screen, severity = 'info', target = {}) {
  return { key, label, detail, count, severity, targetScreen: screen, ...target };
}

function todoItems(projects, products) {
  return [
    item('products.pending', '待核实商品', '补充规格、价格与来源证据，再确认商品档案。',
      products?.pending ?? null, 'products', 'info', products?.pendingProductId ? { targetProductId: products.pendingProductId } : {}),
    item('projects.plan', '待确认方案', '当前方案仍是草稿，确认后才会冻结资料与价格。',
      projects?.awaitingPlan ?? null, 'projects', 'info', projects?.awaitingPlanProjectId ? { targetProjectId: projects.awaitingPlanProjectId } : {}),
    item('projects.review', '待审核交付', '项目已进入质检审核步骤，等待人工处理。',
      projects?.inReview ?? null, 'projects', 'warn', projects?.inReviewProjectId ? { targetProjectId: projects.inReviewProjectId } : {}),
  ].filter(entry => entry.count === null || entry.count > 0);
}

function anomalyItems(tasks, outputs, pendingPriceCount) {
  return [
    item('tasks.failed', '失败任务', '明确失败的任务需人工决定是否重试；不会自动重试或换模型。',
      tasks?.failed ?? null, 'generation', 'warn'),
    item('tasks.unknown', '未知任务', '只核实原请求，不自动重新生成；费用保持待核对。',
      tasks?.unknown ?? null, 'generation', 'error'),
    item('billing.pending_price', '待核价任务', '未定价任务不按 0 计费，需管理员补价。',
      pendingPriceCount, 'system', 'warn'),
    item('outputs.unavailable', '素材文件缺失', '索引记录仍保留，需检查对象存储中的文件。',
      outputs?.unavailable ?? null, 'assets', 'warn'),
  ].filter(entry => entry.count === null || entry.count > 0);
}

function recentProjects(projects, amountsVisible) {
  if (!Array.isArray(projects)) return null;
  return projects.slice(0, RECENT_PROJECT_LIMIT).map(project => ({
    id: project.id,
    name: project.name,
    skuSpec: project.skuSpec,
    status: project.status,
    planStatus: project.planStatus,
    progress: project.progress,
    currentStep: project.currentStep,
    updatedAt: project.updatedAt,
    // 最近项目里的预算同属金额明细，查看者得到 null，而不是 0。
    estimate: amountsVisible ? project.estimate : null,
  }));
}

function auditTitle(action) {
  return AUDIT_ACTION_LABELS[action] || String(action || '业务操作').replaceAll('.', ' · ');
}

function projectEventTitle(event) {
  const step = Number(event.step);
  const label = STEP_LABELS[step - 1] || `步骤 ${step}`;
  const status = STEP_STATUS_LABELS[event.status] || event.status;
  return `${label} · ${status}`;
}

function activityItems(activity) {
  if (!activity) return null;
  const items = [];
  for (const row of activity.audit || []) {
    items.push({
      id: `audit:${row.id}`,
      kind: 'audit',
      action: row.action,
      title: auditTitle(row.action),
      result: row.result || 'success',
      actorEmail: row.actorEmail ?? null,
      actorRole: row.actorRole ?? null,
      target: { type: row.targetType ?? null, id: row.targetId ?? null },
      at: iso(row.createdAt),
    });
  }
  for (const row of activity.jobEvents || []) {
    items.push({
      id: `job:${row.id}`,
      kind: 'job',
      action: `job.${row.event}`,
      title: `生成任务 · ${JOB_EVENT_LABELS[row.event] || row.event}`,
      result: row.event === 'failed' ? 'failure' : 'success',
      actorEmail: null,
      actorRole: null,
      target: { type: 'job', id: row.jobId ?? null },
      at: iso(row.createdAt),
    });
  }
  for (const row of activity.projectEvents || []) {
    items.push({
      id: `project-event:${row.id}`,
      kind: 'project',
      action: `project.step.${row.status}`,
      title: projectEventTitle(row),
      result: row.status === 'needs_review' ? 'failure' : 'success',
      actorEmail: null,
      actorRole: null,
      target: { type: 'project', id: row.projectId ?? null },
      at: iso(row.createdAt),
    });
  }
  return items
    .filter(entry => entry.at)
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, ACTIVITY_LIMIT);
}

// 纯函数：内存仓储测试与 PostgreSQL 路由共用同一份结果结构与脱敏规则。
export function buildDashboard(snapshot = {}, options = {}) {
  const role = options.role || 'local';
  const amountsVisible = options.amountsVisible ?? role !== 'viewer';
  const projects = projectMetrics(snapshot.projects);
  const tasks = taskMetrics(snapshot.tasks);
  const products = productMetrics(snapshot.products);
  const outputs = outputMetrics(snapshot.outputs);
  const amounts = amountsFor(snapshot.billing, amountsVisible);
  const pendingPriceCount = integer(snapshot.billing?.pendingPriceCount);
  const generatedAt = iso(options.now?.()) || new Date().toISOString();
  const sources = options.sources || {};
  return {
    generatedAt,
    scope: {
      mode: snapshot.workspaceId === LOCAL_WORKSPACE ? 'local' : 'workspace',
      role,
      amountsVisible,
    },
    sources: {
      projects: sources.projects || (snapshot.projects === null ? 'unavailable' : 'ok'),
      tasks: sources.tasks || (snapshot.tasks === null ? 'unavailable' : 'ok'),
      products: sources.products || (snapshot.products === null ? 'unavailable' : 'ok'),
      outputs: sources.outputs || (snapshot.outputs === null ? 'unavailable' : 'ok'),
      billing: sources.billing || (snapshot.billing === null ? 'unavailable' : 'ok'),
      activity: sources.activity || (snapshot.activity === null ? 'unavailable' : 'ok'),
    },
    metrics: { projects, tasks, products, outputs },
    amounts,
    todos: todoItems(projects, products),
    anomalies: anomalyItems(tasks, outputs, pendingPriceCount),
    recent: {
      projects: recentProjects(snapshot.projects, amountsVisible),
      activity: activityItems(snapshot.activity),
    },
  };
}

async function safe(load) {
  try { return { ok: true, value: await load() }; }
  catch { return { ok: false, value: null }; }
}

// PostgreSQL 仓储。只读查询；项目步骤状态复用项目模块的真实证据投影。
export class PgDashboardRepository {
  constructor(pool, { now = () => new Date() } = {}) {
    this.pool = pool;
    this.now = now;
  }

  async projects(workspaceId) {
    const rows = (await this.pool.query(`
      SELECT p.id,p.name,p.sku_spec,p.status,p.owner_id,p.current_plan_version,
             p.created_at,p.updated_at,
             pl.status AS plan_status,pl.price AS plan_price,
             pl.deliverables AS plan_deliverables
      FROM sj_projects p
      LEFT JOIN sj_project_plans pl
        ON pl.project_id=p.id AND pl.version=p.current_plan_version
      WHERE p.workspace_id=$1
      ORDER BY p.updated_at DESC,p.id ASC
    `, [workspaceId])).rows;
    if (!rows.length) return [];
    const eventRows = (await this.pool.query(`
      SELECT project_id,step,step_key,status,created_at
      FROM sj_project_events
      WHERE workspace_id=$1
      ORDER BY project_id,seq ASC
    `, [workspaceId])).rows;
    const byProject = new Map();
    for (const event of eventRows) {
      const list = byProject.get(event.project_id) || [];
      list.push({
        step: event.step,
        stepKey: event.step_key,
        status: event.status,
        createdAt: iso(event.created_at),
      });
      byProject.set(event.project_id, list);
    }
    const evidenceByProject = await new PgProjectRepository(this.pool, { workspaceId })
      .getLifecycleEvidence(rows.map(row => ({
        projectId: row.id,
        planVersion: integer(row.current_plan_version),
        deliverableIds: Array.isArray(row.plan_deliverables)
          ? row.plan_deliverables.map(item => item.id).filter(Boolean)
          : [],
      })));
    return rows.map(row => mapProject(
      row,
      byProject.get(row.id) || [],
      evidenceByProject.get(projectLifecycleKey(row.id, integer(row.current_plan_version))),
    ));
  }

  async products(workspaceId) {
    const row = (await this.pool.query(`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE status <> 'confirmed')::int AS pending,
             (SELECT id::text FROM sj_products WHERE workspace_id=$1 AND status <> 'confirmed'
              ORDER BY updated_at ASC,id ASC LIMIT 1) AS pending_product_id
      FROM sj_products
      WHERE workspace_id=$1
    `, [workspaceId])).rows[0];
    return { total: row.total, pending: row.pending, pendingProductId: row.pending_product_id ?? null };
  }

  async tasks(workspaceId) {
    const rows = (await this.pool.query(`
      SELECT status,count(*)::int AS count
      FROM sj_generation_jobs
      WHERE COALESCE(input->>'workspaceId','local')=$1
      GROUP BY status
    `, [workspaceId])).rows;
    const byStatus = {};
    for (const row of rows) byStatus[row.status] = row.count;
    const total = rows.reduce((sum, row) => sum + Number(row.count || 0), 0);
    return { total, byStatus };
  }

  async outputs(workspaceId) {
    // 与素材页共用索引服务与统计口径：模板不计入真实产出。
    const service = new AssetIndexService(
      new PgAssetRepository(this.pool, { workspaceId }),
      { workspaceId, now: this.now },
    );
    const page = await service.list({ limit: 1 });
    return page.summary.outputs;
  }

  async billing(workspaceId) {
    // 与「系统 / 账单」共用同一个账本汇总，避免工作台另算一套费用。
    const service = new BillingService(
      new PgBillingRepository(this.pool),
      { workspaceId, now: this.now },
    );
    return service.summary();
  }

  async activity(workspaceId, { limit = ACTIVITY_LIMIT, actorId = null } = {}) {
    const auditWhere = [workspaceId === LOCAL_WORKSPACE ? 'workspace_id IS NULL' : 'workspace_id=$1::uuid'];
    const auditParams = workspaceId === LOCAL_WORKSPACE ? [] : [workspaceId];
    if (actorId) {
      auditParams.push(actorId);
      auditWhere.push(`actor_id=$${auditParams.length}::uuid`);
    }
    auditParams.push(limit);
    const [audit, jobEvents, projectEvents] = await Promise.all([
      this.pool.query(`
        SELECT id,actor_email,actor_role,action,target_type,target_id,result,created_at
        FROM sj_audit_logs
        WHERE ${auditWhere.join(' AND ')}
        ORDER BY created_at DESC,id DESC
        LIMIT $${auditParams.length}
      `, auditParams),
      this.pool.query(`
        SELECT e.id,e.job_id,e.event,e.created_at
        FROM sj_job_events e
        JOIN sj_generation_jobs j ON j.id=e.job_id
        WHERE COALESCE(j.input->>'workspaceId','local')=$1
        ORDER BY e.created_at DESC,e.id DESC
        LIMIT $2
      `, [workspaceId, limit]),
      this.pool.query(`
        SELECT id,project_id,step,step_key,status,created_at
        FROM sj_project_events
        WHERE workspace_id=$1
        ORDER BY seq DESC
        LIMIT $2
      `, [workspaceId, limit]),
    ]);
    return {
      audit: audit.rows.map(row => ({
        id: row.id,
        actorEmail: row.actor_email ?? null,
        actorRole: row.actor_role ?? null,
        action: row.action,
        targetType: row.target_type ?? null,
        targetId: row.target_id ?? null,
        result: row.result,
        createdAt: row.created_at,
      })),
      jobEvents: jobEvents.rows.map(row => ({
        id: row.id,
        jobId: row.job_id,
        event: row.event,
        createdAt: row.created_at,
      })),
      projectEvents: projectEvents.rows.map(row => ({
        id: row.id,
        projectId: row.project_id,
        step: row.step,
        stepKey: row.step_key,
        status: row.status,
        createdAt: row.created_at,
      })),
    };
  }
}

export class DashboardService {
  constructor(repository, { workspaceId = null, role = 'local', now = () => new Date() } = {}) {
    this.repository = repository;
    this.workspaceId = workspaceId || LOCAL_WORKSPACE;
    this.role = role;
    this.now = now;
  }

  async get({ auditScope = null } = {}) {
    const actorId = auditScope && !auditScope.canReadAll ? auditScope.actorId : null;
    const [projects, products, tasks, outputs, billing, activity] = await Promise.all([
      safe(() => this.repository.projects(this.workspaceId)),
      safe(() => this.repository.products(this.workspaceId)),
      safe(() => this.repository.tasks(this.workspaceId)),
      safe(() => this.repository.outputs(this.workspaceId)),
      safe(() => this.repository.billing(this.workspaceId)),
      safe(() => this.repository.activity(this.workspaceId, { limit: ACTIVITY_LIMIT, actorId })),
    ]);
    const values = {
      workspaceId: this.workspaceId,
      projects: projects.value,
      products: products.value,
      tasks: tasks.value,
      outputs: outputs.value,
      billing: billing.value,
      activity: activity.value,
    };
    return buildDashboard(values, {
      role: this.role,
      amountsVisible: this.role !== 'viewer',
      now: this.now,
      sources: {
        projects: projects.ok ? 'ok' : 'unavailable',
        products: products.ok ? 'ok' : 'unavailable',
        tasks: tasks.ok ? 'ok' : 'unavailable',
        outputs: outputs.ok ? 'ok' : 'unavailable',
        billing: billing.ok ? 'ok' : 'unavailable',
        activity: activity.ok ? 'ok' : 'unavailable',
      },
    });
  }
}
