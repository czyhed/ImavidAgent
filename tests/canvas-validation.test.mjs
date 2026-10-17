import test from 'node:test';
import assert from 'node:assert/strict';
import { makeItem } from '../web/src/lib/review.js';
import {
  addGenerateBranch, addNodeAfter, connectNodes, connectionError, ensureLayout,
  flowLanes, removeNode, validateFlow,
} from '../web/src/lib/flow.js';

// 画布前端校验的纯函数测试（Issue #15）。不启动浏览器、不连接服务端、
// 不创建生成任务，也不改变方案确认状态。

const make = (type = 'white') => makeItem(0, type, '测试交付项');

test('默认工作流通过 DAG 与端口校验', () => {
  const item = make();
  assert.equal(validateFlow(item).ok, true);
  assert.equal(item.flow.length, 2);
  assert.equal(flowLanes(item).length, 1);
});

test('拒绝自环', () => {
  const item = make();
  item.flow[1].from = item.flow[1].id;
  const result = validateFlow(item);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SELF_LOOP');
});

test('拒绝有向环', () => {
  const item = {
    ...make(),
    flow: [
      { id: 'n1', type: 'prompt', status: 'idle' },
      { id: 'n2', type: 'edit', from: 'n3', status: 'idle' },
      { id: 'n3', type: 'edit', from: 'n2', status: 'idle' },
    ],
  };
  const result = validateFlow(item);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DAG_CYCLE');
});

test('拒绝文本输出连接到图片输入', () => {
  const item = make();
  item.flow.push({ id: 'n3', type: 'edit', from: null, status: 'idle', x: 475, y: 24 });
  const result = connectionError(item, 'n1', 'n3');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PORT_TYPE_MISMATCH');
  assert.match(result.message, /文本 → 图片/);
  assert.equal(item.flow[2].from, null);
});

test('拒绝同向重复边', () => {
  const item = make();
  const result = connectionError(item, 'n1', 'n2');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DUPLICATE_EDGE');
});

test('允许在类型兼容时替换已有输入连线，并保持单入边', () => {
  const item = make();
  assert.equal(addGenerateBranch(item).ok, true);
  assert.equal(addNodeAfter(item, 'n3', 'edit').ok, true);
  const edit = item.flow.find(node => node.type === 'edit');
  assert.equal(edit.from, 'n3');
  assert.equal(connectNodes(item, 'n2', edit.id).ok, true);
  assert.equal(edit.from, 'n2');
  assert.equal(item.flow.filter(node => node.from === edit.id).length, 0);
  assert.equal(validateFlow(item).ok, true);
});

test('拒绝环路连接且不落盘', () => {
  const item = make();
  assert.equal(connectionError(item, 'n2', 'n2').code, 'SELF_LOOP');
  assert.equal(addNodeAfter(item, 'n2', 'edit').ok, true);
  const first = item.flow.find(node => node.type === 'edit');
  assert.equal(addNodeAfter(item, first.id, 'edit').ok, true);
  const second = item.flow.at(-1);
  const result = connectionError(item, second.id, first.id);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DAG_CYCLE');
  assert.equal(first.from, 'n2');
});

test('拒绝未连接必需输入的节点', () => {
  const item = make();
  item.flow[1].from = null;
  const result = validateFlow(item);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'REQUIRED_PORT_UNCONNECTED');
});

test('拒绝悬空上游', () => {
  const item = make();
  item.flow[1].from = 'n9';
  const result = validateFlow(item);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DANGLING_EDGE');
});

test('锁定根节点不可删除，已执行或带下游节点也不可删除', () => {
  const item = make();
  const prompt = item.flow[0];
  assert.equal(removeNode(item, prompt.id).code, 'LOCKED_NODE');

  assert.equal(addNodeAfter(item, 'n2', 'edit').ok, true);
  assert.equal(addGenerateBranch(item).ok, true);
  const generate = item.flow.find(node => node.type === 'generate');
  assert.equal(removeNode(item, generate.id).code, 'HAS_DOWNSTREAM');

  const edit = item.flow.find(node => node.type === 'edit');
  assert.equal(removeNode(item, edit.id).ok, true);
  assert.equal(item.flow.some(node => node.id === edit.id), false);

  item.frozen = true;
  assert.equal(removeNode(item, 'n2').code, 'WORKFLOW_FROZEN');
});

test('追加节点沿用端口与模板合成终端规则', () => {
  const item = make();
  const invalid = addNodeAfter(item, 'n1', 'edit');
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'PORT_TYPE_MISMATCH');
  assert.equal(item.flow.length, 2);

  const generated = addNodeAfter(item, 'n2', 'edit');
  assert.equal(generated.ok, true);
  assert.equal(item.flow.at(-1).from, 'n2');
  assert.equal(item.flow.at(-1).model, item.model);

  const composite = addNodeAfter(item, item.flow.at(-1).id, 'composite');
  assert.equal(composite.ok, true);
  const afterComposite = addNodeAfter(item, item.flow.at(-1).id, 'edit');
  assert.equal(afterComposite.ok, false);
  assert.equal(afterComposite.code, 'COMPOSITE_TERMINAL');
});

test('并行出图分支最多三个且各自可见', () => {
  const item = make();
  assert.equal(addGenerateBranch(item).ok, true);
  assert.equal(addGenerateBranch(item).ok, true);
  assert.equal(flowLanes(item).length, 3);
  const fourth = addGenerateBranch(item);
  assert.equal(fourth.ok, false);
  assert.equal(fourth.code, 'BRANCH_LIMIT');
  assert.equal(validateFlow(item).ok, true);
});

test('布局为缺省位置补值且保留已保存坐标', () => {
  const item = make();
  const generate = item.flow[1];
  assert.equal(Number.isFinite(generate.x), true);
  assert.equal(Number.isFinite(generate.y), true);
  generate.x = 321;
  generate.y = 123;
  ensureLayout(item);
  assert.equal(generate.x, 321);
  assert.equal(generate.y, 123);
});

test('画布校验不改变方案确认、执行与审核状态', () => {
  const item = make();
  const before = JSON.stringify({ frozen: item.frozen, status: item.status, approved: item.approved, candidate: item.candidate });
  addGenerateBranch(item);
  addNodeAfter(item, 'n2', 'edit');
  connectionError(item, 'n1', 'n2');
  assert.equal(JSON.stringify({ frozen: item.frozen, status: item.status, approved: item.approved, candidate: item.candidate }), before);
  assert.equal(item.versions.length, 0);
});
