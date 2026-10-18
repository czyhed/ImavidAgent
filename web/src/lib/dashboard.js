// 工作台纯函数：把 GET /api/dashboard 的真实结果格式化为可测试的展示值。
// 空值统一显示「未统计」，不把 null 转成 0，也不回退到演示数字。
export const UNKNOWN = '未统计';

export const PROJECT_STATUS_LABELS = Object.freeze({
  draft: '草稿', active: '进行中', review: '待审核', completed: '已完成', cancelled: '已取消',
});

export function count(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

export function formatCount(value) {
  const number = count(value);
  if (number === null) return UNKNOWN;
  return number.toLocaleString('zh-CN');
}

export function formatCents(value) {
  const cents = count(value);
  if (cents === null) return UNKNOWN;
  return `¥${(cents / 100).toFixed(2)}`;
}

export function formatDate(value) {
  if (!value) return UNKNOWN;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return UNKNOWN;
  return date.toLocaleString('zh-CN', { hour12: false });
}

export function projectStatusLabel(status) {
  return PROJECT_STATUS_LABELS[status] || UNKNOWN;
}

export function projectStepLabel(project) {
  if (!project) return UNKNOWN;
  if (!project.currentStep) return project.status === 'completed' ? '已完成' : '无待办步骤';
  return `${String(project.currentStep.step).padStart(2, '0')} ${project.currentStep.label}`;
}

export function projectProgressLabel(project) {
  const completed = count(project?.progress?.completed);
  const total = count(project?.progress?.total);
  if (completed === null || total === null) return UNKNOWN;
  return `${completed} / ${total} 步`;
}

export function metricCards(data) {
  const projects = data?.metrics?.projects;
  const tasks = data?.metrics?.tasks;
  const outputs = data?.metrics?.outputs;
  const amounts = data?.amounts;
  const amountHint = !data
    ? UNKNOWN
    : data.scope?.amountsVisible === false
      ? '金额明细仅管理员与运营可见'
      : amounts
        ? `${formatCount(amounts.pendingPriceCount)} 个待核价`
        : '账本暂不可用';
  return [
    {
      key: 'projects',
      label: '真实项目',
      value: formatCount(projects?.total),
      hint: projects
        ? `${formatCount(projects.byStatus?.active)} 进行中 · ${formatCount(projects.inReview)} 待审核 · ${formatCount(projects.awaitingPlan)} 待确认方案`
        : '项目数据源未统计',
    },
    {
      key: 'tasks',
      label: '生成任务',
      value: formatCount(tasks?.total),
      hint: tasks
        ? `进行中 ${formatCount(tasks.active)} · 失败 ${formatCount(tasks.failed)} · 未知 ${formatCount(tasks.unknown)}`
        : '任务数据源未统计',
    },
    {
      key: 'outputs',
      label: '成功产出',
      value: formatCount(outputs?.total),
      hint: outputs
        ? `可用 ${formatCount(outputs.available)} · 缺文件 ${formatCount(outputs.unavailable)}`
        : '素材数据源未统计',
    },
    {
      key: 'amounts',
      label: '本月结算',
      value: formatCents(amounts?.settledCents),
      hint: amountHint,
    },
  ];
}

export function todoRows(data) {
  return Array.isArray(data?.todos) ? data.todos : [];
}

export function anomalyRows(data) {
  return Array.isArray(data?.anomalies) ? data.anomalies : [];
}

export function recentProjects(data) {
  return Array.isArray(data?.recent?.projects) ? data.recent.projects : [];
}

export function recentActivity(data) {
  return Array.isArray(data?.recent?.activity) ? data.recent.activity : [];
}

export function activityMeta(item) {
  if (!item) return UNKNOWN;
  if (item.actorEmail) return `${item.actorEmail} · ${item.actorRole || '成员'}`;
  if (item.actorRole) return item.actorRole;
  return item.kind === 'job' ? '生成服务' : '业务事件';
}
