import test from 'node:test';
import assert from 'node:assert/strict';
import { autoLayout, DIMENSION_PRESETS } from '../web/src/lib/canvas-layout.js';

const task = (id, kind, extra = {}) => ({ id, kind, title: id, ...extra });

test('auto-layout groups tasks by dimension into lanes with dependency order', () => {
  const source = task('p', 'product', { position: { x: 0, y: 0 } });
  const prompt = task('t', 'prompt', { position: { x: 0, y: 400 } });
  const white = task('g1', 'generate', { dimension: '商品白底图', position: { x: 500, y: 0 } });
  const scene = task('g2', 'generate', { dimension: '使用场景图', position: { x: 900, y: 0 } });
  const edit = task('e', 'edit', { dimension: '使用场景图', position: { x: 1300, y: 0 } });
  const out = task('o', 'output', { position: { x: 1700, y: 0 } });
  const edges = [
    { id: 'a', source: 'p', target: 'g1', sourceHandle: 'image', targetHandle: 'ref' },
    { id: 'b', source: 't', target: 'g1', sourceHandle: 'text', targetHandle: 'prompt' },
    { id: 'c', source: 'g1', target: 'g2', sourceHandle: 'image', targetHandle: 'image' },
    { id: 'd', source: 'g2', target: 'e', sourceHandle: 'image', targetHandle: 'image' },
    { id: 'e', source: 'e', target: 'o', sourceHandle: 'image', targetHandle: 'asset' },
  ];
  const positions = autoLayout([source, prompt, white, scene, edit, out], edges);
  // 来源节点在素材 lane（最上），两个维度各自成 lane，输出跟随上游 lane。
  assert.equal(positions.p.y < positions.g1.y, true);
  assert.equal(positions.g1.y < positions.g2.y, true);
  assert.equal(positions.g2.y, positions.e.y, '同维度任务在同一 lane');
  assert.equal(positions.e.y, positions.o.y, '输出节点继承上游维度 lane');
  assert.equal(positions.g2.x > positions.g1.x, true, '依赖从左到右');
  assert.equal(positions.e.x > positions.g2.x, true);
  assert.equal(positions.o.x > positions.e.x, true);
  assert.ok(DIMENSION_PRESETS.includes('商品白底图'));
});

test('auto-layout falls back to dependency depth for tasks without a dimension', () => {
  const a = task('a', 'generate', { position: { x: 0, y: 0 } });
  const b = task('b', 'edit', { position: { x: 0, y: 0 } });
  const positions = autoLayout([a, b], [{ id: 'e', source: 'a', target: 'b', sourceHandle: 'image', targetHandle: 'image' }]);
  assert.equal(positions.b.x > positions.a.x, true);
  assert.equal(positions.a.y, positions.b.y, '未分组任务同 lane');
});

test('auto-layout stacks same-depth tasks in a lane without overlapping', () => {
  const a = task('a', 'generate', { position: { x: 0, y: 0 } });
  const b = task('b', 'generate', { position: { x: 0, y: 0 } });
  const positions = autoLayout([a, b], []);
  assert.notEqual(positions.a.y, positions.b.y);
  assert.equal(positions.a.x, positions.b.x);
});

test('auto-layout keeps dimension inheritance away from the source lane', () => {
  const product = task('p', 'product', {});
  const gen = task('g', 'generate', {});
  const positions = autoLayout([product, gen], [{ id: 'e', source: 'p', target: 'g', sourceHandle: 'image', targetHandle: 'ref' }]);
  assert.equal(positions.g.y > positions.p.y, true, '未标维度的生成节点不应混入素材 lane');
});
