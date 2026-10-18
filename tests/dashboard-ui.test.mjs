import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UNKNOWN, activityMeta, anomalyRows, count, formatCents, formatCount, formatDate,
  metricCards, projectProgressLabel, projectStatusLabel, projectStepLabel,
  recentActivity, recentProjects, todoRows,
} from '../web/src/lib/dashboard.js';

// 工作台展示纯函数：空值必须显示「未统计」，不能被格式化成 0 或演示数字。

test('count and formatters keep unavailable values distinct from zero', () => {
  assert.equal(count(0), 0);
  assert.equal(count('12'), 12);
  assert.equal(count(null), null);
  assert.equal(count(undefined), null);
  assert.equal(count(''), null);
  assert.equal(count(1.5), null);

  assert.equal(formatCount(0), '0');
  assert.equal(formatCount(1234), '1,234');
  assert.equal(formatCount(null), UNKNOWN);
  assert.equal(formatCount(undefined), UNKNOWN);

  assert.equal(formatCents(0), '¥0.00');
  assert.equal(formatCents(12345), '¥123.45');
  assert.equal(formatCents(null), UNKNOWN);
  assert.equal(formatDate(null), UNKNOWN);
  assert.equal(formatDate('not-a-date'), UNKNOWN);
  assert.notEqual(formatDate('2026-10-21T08:00:00.000Z'), UNKNOWN);
});

test('project labels show step, progress and unknown statuses', () => {
  assert.equal(projectStatusLabel('review'), '待审核');
  assert.equal(projectStatusLabel('unexpected'), UNKNOWN);
  assert.equal(projectStepLabel(null), UNKNOWN);
  assert.equal(projectStepLabel({ status: 'completed', currentStep: null }), '已完成');
  assert.equal(projectStepLabel({ status: 'active', currentStep: null }), '无待办步骤');
  assert.equal(projectStepLabel({ currentStep: { step: 2, label: '方案报价' } }), '02 方案报价');
  assert.equal(projectProgressLabel({ progress: { completed: 2, total: 6 } }), '2 / 6 步');
  assert.equal(projectProgressLabel({}), UNKNOWN);
});

test('metric cards show real numbers, unknown values and viewer amount restrictions', () => {
  const data = {
    scope: { amountsVisible: true },
    metrics: {
      projects: {
        total: 3, byStatus: { active: 2 }, inReview: 1, awaitingPlan: 1,
      },
      tasks: { total: 5, active: 1, failed: 1, unknown: 0 },
      outputs: { total: 4, available: 3, unavailable: 1 },
    },
    amounts: { settledCents: 9900, pendingPriceCount: 2 },
  };
  const cards = metricCards(data);
  assert.deepEqual(cards.map(card => [card.key, card.value]), [
    ['projects', '3'], ['tasks', '5'], ['outputs', '4'], ['amounts', '¥99.00'],
  ]);
  assert.equal(cards[0].hint, '2 进行中 · 1 待审核 · 1 待确认方案');
  assert.equal(cards[1].hint, '进行中 1 · 失败 1 · 未知 0');
  assert.equal(cards[2].hint, '可用 3 · 缺文件 1');
  assert.equal(cards[3].hint, '2 个待核价');

  const missing = metricCards(null);
  assert.ok(missing.every(card => card.value === UNKNOWN));
  assert.ok(missing.slice(0, 3).every(card => card.hint.endsWith('数据源未统计')));
  assert.equal(missing[3].hint, UNKNOWN);

  const viewer = metricCards({ ...data, scope: { amountsVisible: false }, amounts: null });
  assert.equal(viewer[3].value, UNKNOWN);
  assert.equal(viewer[3].hint, '金额明细仅管理员与运营可见');
});

test('dashboard list helpers never fabricate entries', () => {
  assert.deepEqual(todoRows(null), []);
  assert.deepEqual(anomalyRows(null), []);
  assert.deepEqual(recentProjects(null), []);
  assert.deepEqual(recentActivity(null), []);
  assert.deepEqual(todoRows({ todos: [{ key: 'x' }] }), [{ key: 'x' }]);
  assert.equal(activityMeta(null), UNKNOWN);
  assert.equal(activityMeta({ actorEmail: 'ops@example.test', actorRole: 'operator' }), 'ops@example.test · operator');
  assert.equal(activityMeta({ actorRole: 'viewer' }), 'viewer');
  assert.equal(activityMeta({ kind: 'job' }), '生成服务');
  assert.equal(activityMeta({ kind: 'audit' }), '业务事件');
});
