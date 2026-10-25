import test from 'node:test';
import assert from 'node:assert/strict';
import { diffOps, applyOps, coalesce, rebase, reuseUnchanged, SaveQueue, mergeStatus, needsPolling, loadView, saveView, viewKey, same } from '../web/src/lib/creation-sync.js';

const task = (id, extra = {}) => ({ id, kind: 'generate', title: id, prompt: '', params: {}, position: { x: 0, y: 0 }, workflowId: 'w', ...extra });
const project = (extra = {}) => ({ name: 'P', workflows: [{ id: 'w', title: 'W' }], tasks: [task('a'), task('b')], edges: [], voiceRoles: [], storyboard: { script: '', shots: [] }, ...extra });

test('diffOps: only changed task fields are emitted, ids and dialogueAudio are never diffed', () => {
  const prev = project();
  const next = { ...prev, tasks: [task('a', { prompt: 'x', params: { size: '1' }, dialogueAudio: { assetId: 'z' } }), task('b')] };
  assert.deepEqual(diffOps(prev, next), [{ type: 'task.patch', id: 'a', fields: { prompt: 'x', params: { size: '1' } } }]);
  assert.deepEqual(diffOps(prev, prev), []);
});

test('diffOps: removed keys become unset, null stays a value', () => {
  const prev = project({ tasks: [task('a', { sourceRunId: 'r', tailFrame: { x: 1 } }), task('b')] });
  const next = project({ tasks: [task('a', { sourceRunId: null }), task('b')] });
  assert.deepEqual(diffOps(prev, next), [{ type: 'task.patch', id: 'a', fields: { sourceRunId: null }, unset: ['tailFrame'] }]);
});

test('diffOps: add/remove nodes, edges by id, workflows and project name in dependency order', () => {
  const prev = project({ edges: [{ id: 'e1', source: 'a', target: 'b' }] });
  const next = project({ name: 'Q', workflows: [{ id: 'w', title: 'W' }, { id: 'w2', title: 'W2' }], tasks: [task('b'), task('c', { workflowId: 'w2' })], edges: [{ id: 'e2', source: 'b', target: 'c' }] });
  const types = diffOps(prev, next).map(op => op.type);
  assert.deepEqual(types, ['workflow.put', 'edge.remove', 'task.remove', 'task.add', 'edge.add', 'project.patch']);
  const ops = diffOps(prev, next);
  assert.equal(ops.find(op => op.type === 'task.remove').id, 'a');
  assert.equal(ops.find(op => op.type === 'project.patch').name, 'Q');
  // 工作流删除排在节点移除之后、节点新增之前。
  const dropped = diffOps(project({ workflows: [{ id: 'w', title: 'W' }, { id: 'x', title: 'X' }], tasks: [task('a'), task('t', { workflowId: 'x' })] }), project({ tasks: [task('a')] })).map(op => op.type);
  assert.deepEqual(dropped, ['task.remove', 'workflow.remove']);
});

test('diffOps: storyboard script and shots become one storyboard.patch with server-only fields stripped', () => {
  const prev = project({ storyboard: { script: 'a', shots: [{ id: 's1', title: 'T', description: '', nodeId: 'a', tailFrameStale: true }] } });
  const next = project({ storyboard: { script: 'b', shots: [{ id: 's1', title: 'T', description: 'd', nodeId: 'a', tailFrameStale: true }] } });
  assert.deepEqual(diffOps(prev, next), [{ type: 'storyboard.patch', script: 'b', shots: [{ id: 's1', title: 'T', description: 'd', nodeId: 'a' }] }]);
  assert.deepEqual(diffOps(prev, { ...prev, storyboard: { ...prev.storyboard, batch: { state: 'running' } } }), []);
});

test('diffOps: a project without any storyboard counts as an empty one, so the first script or shot is saved', () => {
  const prev = project(); delete prev.storyboard;
  const shot = { id: 's1', title: '分镜 1', description: '', nodeId: null };
  assert.deepEqual(diffOps(prev, { ...prev, storyboard: { script: '脚本', shots: [] } }), [{ type: 'storyboard.patch', script: '脚本' }]);
  assert.deepEqual(diffOps(prev, { ...prev, storyboard: { script: '', shots: [shot] } }), [{ type: 'storyboard.patch', shots: [shot] }]);
  assert.deepEqual(diffOps(prev, { ...prev, storyboard: { script: '', shots: [] } }), []);
});

test('applyOps reproduces next from prev and does not mutate its input', () => {
  const prev = project({ edges: [{ id: 'e1', source: 'a', target: 'b' }] });
  const next = project({ name: 'Q', tasks: [task('b', { prompt: 'p' }), task('c')], edges: [{ id: 'e2', source: 'b', target: 'c' }] });
  const frozen = JSON.stringify(prev);
  const result = applyOps(prev, diffOps(prev, next));
  assert.equal(JSON.stringify(prev), frozen);
  assert.equal(result.name, 'Q');
  assert.deepEqual(result.tasks.map(t => t.id).sort(), ['b', 'c']);
  assert.equal(result.tasks.find(t => t.id === 'b').prompt, 'p');
  assert.deepEqual(result.edges, next.edges);
  assert.deepEqual(diffOps(result, next), []);
});

test('applyOps skips operations on nodes removed elsewhere and removes dangling edges and tail frames', () => {
  const server = project({ tasks: [task('a'), task('b', { tailFrame: { fromNodeId: 'a', runId: null, assetId: null } })], edges: [{ id: 'e1', source: 'a', target: 'b' }] });
  const out = applyOps(server, [{ type: 'task.patch', id: 'gone', fields: { prompt: 'x' } }, { type: 'edge.add', edge: { id: 'e9', source: 'a', target: 'gone' } }, { type: 'edge.remove', id: 'nope' }, { type: 'task.remove', id: 'a' }]);
  assert.deepEqual(out.tasks.map(t => t.id), ['b']);
  assert.deepEqual(out.edges, []);
  assert.equal(out.tasks[0].tailFrame, null);
});

test('applyOps keeps server-only dialogueAudio, merges storyboard shots by id and syncs node titles', () => {
  const server = project({ tasks: [task('a', { dialogueAudio: { assetId: 'z' }, title: '新标题' })], storyboard: { script: '', shots: [{ id: 's1', title: '旧', description: '', nodeId: 'a', tailFrameStale: true }] } });
  const out = applyOps(server, [{ type: 'task.patch', id: 'a', fields: { dialogueAudio: null, prompt: 'p' } }, { type: 'storyboard.patch', shots: [{ id: 's1', title: '旧', description: 'x', nodeId: null }] }]);
  assert.deepEqual(out.tasks[0].dialogueAudio, { assetId: 'z' });
  assert.equal(out.storyboard.shots[0].nodeId, 'a');
  assert.equal(out.storyboard.shots[0].title, '新标题');
  assert.equal(out.storyboard.shots[0].description, 'x');
});

test('coalesce merges consecutive patches of the same node and folds patches into their add', () => {
  const merged = coalesce([
    { type: 'task.patch', id: 'a', fields: { prompt: '1' } },
    { type: 'task.patch', id: 'b', fields: { prompt: 'b' } },
    { type: 'task.patch', id: 'a', fields: { prompt: '2', title: 't' }, unset: ['x'] },
    { type: 'task.patch', id: 'a', fields: { x: 1 } },
  ]);
  assert.deepEqual(merged, [{ type: 'task.patch', id: 'a', fields: { prompt: '2', title: 't', x: 1 } }, { type: 'task.patch', id: 'b', fields: { prompt: 'b' } }]);
  const added = coalesce([{ type: 'task.add', task: task('n') }, { type: 'task.patch', id: 'n', fields: { prompt: 'p' }, unset: ['workflowId'] }]);
  assert.equal(added.length, 1);
  assert.equal(added[0].task.prompt, 'p');
  assert.equal('workflowId' in added[0].task, false);
  // 删除后再新增同编号：补丁只合入新增之后的那个。
  const readd = coalesce([{ type: 'task.patch', id: 'a', fields: { prompt: 'old' } }, { type: 'task.remove', id: 'a' }, { type: 'task.add', task: task('a') }, { type: 'task.patch', id: 'a', fields: { prompt: 'new' } }]);
  assert.deepEqual(readd.map(op => op.type), ['task.patch', 'task.remove', 'task.add']);
  assert.equal(readd[2].task.prompt, 'new');
  assert.deepEqual(coalesce([{ type: 'project.patch', name: 'a' }, { type: 'project.patch', voiceRoles: [] }, { type: 'storyboard.patch', script: 'a' }, { type: 'storyboard.patch', shots: [] }]), [{ type: 'project.patch', name: 'a', voiceRoles: [] }, { type: 'storyboard.patch', script: 'a', shots: [] }]);
});

test('rebase layers unsent edits over the latest server project and last write wins per field', () => {
  const local = project();
  const edited = { ...local, tasks: [task('a', { prompt: 'mine' }), task('b')] };
  const pending = diffOps(local, edited);
  // 另一窗口同时改了 a 的标题和 b 的提示词，并删掉了不相关节点。
  const server = project({ tasks: [task('a', { title: 'theirs', prompt: 'old' }), task('b', { prompt: 'their b' }), task('c')] });
  const merged = rebase(server, pending);
  assert.equal(merged.tasks.find(t => t.id === 'a').prompt, 'mine');
  assert.equal(merged.tasks.find(t => t.id === 'a').title, 'theirs');
  assert.equal(merged.tasks.find(t => t.id === 'b').prompt, 'their b');
  // 本地改的节点被他处删除：操作被忽略，不报错。
  const gone = rebase(project({ tasks: [task('b')] }), pending);
  assert.deepEqual(gone.tasks.map(t => t.id), ['b']);
});

function harness(options = {}) {
  const sent = [], timers = [], results = [], rejects = [], states = [];
  let now = 0, handler = options.handler || (async ops => ({ ok: true, count: ops.length }));
  const queue = new SaveQueue({
    send: async (ops, meta) => { sent.push({ ops, meta }); return handler(ops, meta); },
    onResult: (data, ops) => results.push([data, ops]), onReject: (error, ops) => rejects.push([error, ops]), onStatus: s => states.push(s.state),
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; }, clearTimer: t => { if (t) t.live = false; },
    sleep: async ms => { now += ms; }, now: () => now,
  });
  return { queue, sent, timers, results, rejects, states, setHandler: fn => { handler = fn; }, advance: ms => { now += ms; }, live: () => timers.filter(t => t.live) };
}
const patch = (id, v) => ({ type: 'task.patch', id, fields: { prompt: v } });

test('SaveQueue waits 1s after the last change, caps at 5s of continuous edits, and reports status', async () => {
  const h = harness();
  h.queue.push([patch('a', '1')]);
  assert.equal(h.live().length, 1); assert.equal(h.live()[0].ms, 1000);
  h.advance(4500);
  h.queue.push([patch('a', '2')]);
  assert.equal(h.live().length, 1); assert.equal(h.live()[0].ms, 500, '距首次改动满 5 秒时必须发送');
  await h.live()[0].fn(); await new Promise(r => setImmediate(r));
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0].ops, [{ type: 'task.patch', id: 'a', fields: { prompt: '2' } }]);
  assert.equal(h.queue.state, 'saved');
  assert.deepEqual(h.states, ['dirty', 'saving', 'saved']);
});

test('SaveQueue keeps one request in flight and sends later edits afterwards', async () => {
  let release; const gate = new Promise(r => { release = r; });
  const h = harness({ handler: async ops => { if (!h.sent.length || h.sent.length === 1) await gate; return { n: ops.length }; } });
  h.queue.push([patch('a', '1')]);
  const first = h.queue.flush();
  await new Promise(r => setImmediate(r));
  h.queue.push([patch('b', '2')]);
  const second = h.queue.flush();
  assert.equal(second, first, '同时只有一个保存请求');
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.queue.outstanding().map(o => o.id), ['a', 'b']);
  release(); await first;
  assert.equal(h.sent.length, 2);
  assert.equal(h.queue.state, 'saved');
});

test('SaveQueue retries network and 5xx failures at 1s/3s/9s, then shows failed and keeps edits until retry', async () => {
  const fails = Object.assign(new Error('down'), { status: 503 });
  const h = harness({ handler: async () => { throw fails; } });
  h.queue.push([patch('a', 'x')]);
  await assert.rejects(h.queue.flush(), /down/);
  assert.equal(h.sent.length, 4, '首次 + 三次重试');
  assert.equal(h.queue.state, 'failed');
  assert.deepEqual(h.queue.outstanding(), [patch('a', 'x')]);
  h.setHandler(async () => ({ ok: 1 }));
  await h.queue.retry();
  assert.equal(h.queue.state, 'saved');
  assert.equal(h.results.length, 1);
  // 网络错误（无状态码）同样重试。
  const net = harness({ handler: async (ops, m) => { if (net.sent.length < 3) throw new TypeError('Failed to fetch'); return {}; } });
  net.queue.push([patch('a', 'x')]); await net.queue.flush();
  assert.equal(net.sent.length, 3);
});

test('SaveQueue drops a batch rejected with 4xx, reports it, and still sends later edits', async () => {
  const bad = Object.assign(new Error('节点尚未结束，不能修改执行输入。'), { status: 409, code: 'TASK_RUNNING' });
  let calls = 0;
  const h = harness({ handler: async () => { calls += 1; if (calls === 1) throw bad; return { ok: 1 }; } });
  h.queue.push([patch('a', 'x')]);
  const run = h.queue.flush().then(() => null, error => error);
  h.queue.push([patch('b', 'y')]);
  assert.match((await run).message, /不能修改/);
  assert.equal(h.rejects.length, 1);
  assert.deepEqual(h.rejects[0][1], [patch('a', 'x')]);
  assert.equal(h.sent.length, 2);
  assert.deepEqual(h.sent[1].ops, [patch('b', 'y')]);
  assert.equal(h.queue.state, 'saved');
});

test('SaveQueue does not drop edits on 401 and passes keepalive through', async () => {
  const auth = Object.assign(new Error('请登录'), { status: 401 });
  const h = harness({ handler: async () => { throw auth; } });
  h.queue.push([patch('a', 'x')]);
  await assert.rejects(h.queue.flush({ keepalive: true }));
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].meta.keepalive, true);
  assert.equal(h.queue.state, 'failed');
  assert.equal(h.queue.outstanding().length, 1);
});

test('mergeStatus merges runs, batch and compile without touching the draft and asks for a full reload when needed', () => {
  const detail = { project: { revision: 3, storyboard: { script: 's', shots: [], batch: { state: 'running', items: {} }, compile: { status: 'idle' } } }, runs: [{ id: 'r1', taskId: 'a', status: 'running', input: { kind: 'video' }, output: null }], dubStates: {}, cost: {} };
  const status = { revision: 3, runs: [{ id: 'r1', taskId: 'a', status: 'running', output: { progress: 40 }, input: { kind: 'video' } }], dubStates: {}, storyboard: { batch: { state: 'running', items: { x: { status: 'running' } } }, compile: { status: 'running' } } };
  const merged = mergeStatus(detail, status);
  assert.equal(merged.needsFull, false);
  assert.equal(merged.detail.runs[0].output.progress, 40);
  assert.deepEqual(merged.detail.runs[0].input, { kind: 'video' });
  assert.equal(merged.detail.project.storyboard.script, 's');
  assert.equal(merged.detail.project.storyboard.compile.status, 'running');
  assert.equal(mergeStatus(detail, { ...status, revision: 4 }).needsFull, true);
  assert.equal(mergeStatus(detail, { ...status, runs: [...status.runs, { id: 'r2', status: 'queued' }] }).needsFull, true);
  assert.equal(mergeStatus(detail, { ...status, runs: [{ ...status.runs[0], status: 'succeeded' }] }).needsFull, true);
  assert.equal(mergeStatus(detail, { ...status, storyboard: { batch: null, compile: { status: 'idle' } } }).detail.project.storyboard.batch, undefined);
});

test('needsPolling only while runs, batch, compile or dubbing are active', () => {
  const idle = { project: { storyboard: { batch: { state: 'done', items: {} }, compile: { status: 'succeeded' } } }, runs: [{ status: 'succeeded' }, { status: 'failed' }], dubStates: { a: { dub: { status: 'succeeded' } } } };
  assert.equal(needsPolling(idle), false);
  assert.equal(needsPolling(null), false);
  assert.equal(needsPolling({ ...idle, runs: [{ status: 'queued' }] }), true);
  assert.equal(needsPolling({ ...idle, runs: [{ status: 'unknown' }] }), true);
  assert.equal(needsPolling({ ...idle, project: { storyboard: { batch: { state: 'running', items: {} } } } }), true);
  assert.equal(needsPolling({ ...idle, project: { storyboard: { compile: { status: 'running' } } } }), true);
  assert.equal(needsPolling({ ...idle, dubStates: { a: { dub: { status: 'running' } } } }), true);
});

test('canvas view storage is per project and workflow and tolerates a broken storage', () => {
  const mem = new Map();
  const storage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  assert.equal(loadView('p', 'w', storage), null);
  saveView('p', 'w', { x: 1, y: -2, zoom: 0.5, extra: 1 }, storage);
  assert.equal(viewKey('p', 'w'), 'sj:canvas-view:p:w');
  assert.deepEqual(loadView('p', 'w', storage), { x: 1, y: -2, zoom: 0.5 });
  assert.equal(loadView('p', 'other', storage), null);
  mem.set(viewKey('p', 'bad'), '{"x":"a"}');
  assert.equal(loadView('p', 'bad', storage), null);
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(loadView('p', 'w', broken), null);
  assert.doesNotThrow(() => saveView('p', 'w', { x: 0, y: 0, zoom: 1 }, broken));
  assert.equal(same({ a: 1, b: undefined }, { a: 1 }), true);
});

test('reuseUnchanged keeps old object identities for equal content even when key order differs (jsonb reorders keys)', () => {
  const prev = project({ tasks: [task('a', { params: { duration: 15, resolution: '1080P' } }), task('b')], edges: [{ id: 'e', source: 'a', target: 'b' }], storyboard: { script: 's', shots: [{ id: 's1', title: 'T', description: '', nodeId: 'a' }] } });
  const reordered = JSON.parse(JSON.stringify(prev));
  reordered.tasks[0].params = { resolution: '1080P', duration: 15 };
  reordered.tasks[1].prompt = '服务端变了';
  const out = reuseUnchanged(prev, reordered);
  assert.equal(out.tasks[0], prev.tasks[0], '内容相同的节点沿用旧引用');
  assert.notEqual(out.tasks[1], prev.tasks[1]);
  assert.equal(out.tasks[1].prompt, '服务端变了');
  assert.equal(out.edges, prev.edges);
  assert.equal(out.storyboard, prev.storyboard);
  assert.equal(out.workflows, prev.workflows);
  assert.equal(reuseUnchanged(null, reordered), reordered);
});

test('diffOps / applyOps: storyboard.settings is replaced as a whole and null clears it', () => {
  const prev = project();
  const next = project({ storyboard: { script: '', shots: [], settings: { resolution: '480P', duration: 6 } } });
  const ops = diffOps(prev, next);
  assert.deepEqual(ops, [{ type: 'storyboard.patch', settings: { resolution: '480P', duration: 6 } }]);
  assert.deepEqual(applyOps(prev, ops).storyboard.settings, { resolution: '480P', duration: 6 });
  const cleared = diffOps(next, prev);
  assert.deepEqual(cleared, [{ type: 'storyboard.patch', settings: null }]);
  assert.equal(applyOps(next, cleared).storyboard.settings, undefined);
  assert.deepEqual(diffOps(next, project({ storyboard: { script: '', shots: [], settings: { duration: 6, resolution: '480P' } } })), [], 'key order does not matter');
});
