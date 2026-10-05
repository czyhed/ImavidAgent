import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withWorkflows, workflowScope, createWorkflow } from '../shared/creation-workflows.mjs';

test('legacy grouping keeps every node ID, edge and frozen source intact', () => {
 const project = { tasks: [{ id: 'old', kind: 'generate', title: '原主图', sourceRunId: 'version-1' }, { id: 'shot', kind: 'video', dimension: '视频分镜' }], edges: [] };
 const migrated = withWorkflows(project);
 assert.equal(migrated.tasks[0].id, 'old');
 assert.equal(migrated.tasks[0].sourceRunId, 'version-1');
 assert.equal(migrated.tasks[1].workflowId, 'storyboard');
 assert.equal(project.tasks[0].workflowId, undefined);
 assert.deepEqual(withWorkflows(migrated), migrated);
 const longTitle = '旧任务'.repeat(60);
 const longProject = withWorkflows({ tasks: [{ id: 'long', kind: 'generate', title: longTitle }], edges: [] });
 assert.equal(longProject.workflows[0].title.length, 100);
 assert.equal(longProject.tasks[0].title, longTitle);
});

test('new creative tasks own separate reference, prompt, generation and output nodes', () => {
 const project = { productId: 'product', productSnapshot: { name: '保温杯' } };
 const first = createWorkflow(project, { title: '秋日主图', prompt: '自然光', sourceAssetId: 'photo', templateSnapshot: { id: 'template' } }, randomUUID);
 const second = createWorkflow(project, { title: '展示短片', kind: 'video' }, randomUUID);
 assert.equal(first.tasks.length, 4);
 assert.ok(first.tasks.every(t => t.workflowId === first.workflow.id));
 assert.equal(first.tasks.find(t => t.kind === 'generate').templateSnapshot.id, 'template');
 assert.equal(first.tasks.find(t => t.kind === 'prompt').prompt, '自然光');
 assert.equal(second.edges.find(e => e.target === second.tasks.at(-1).id).sourceHandle, 'video');
 const combined = { tasks: [...first.tasks, ...second.tasks], edges: [...first.edges, ...second.edges] };
 const scope = workflowScope(combined, first.workflow.id);
 assert.deepEqual([...scope.owned], first.tasks.map(t => t.id));
 assert.deepEqual(scope.visible, scope.owned);
});

test('cross-task dependencies are visible without becoming owned execution targets', () => {
 const project = { tasks: [{ id: 'a', workflowId: 'one' }, { id: 'b', workflowId: 'two' }, { id: 'c', workflowId: 'three' }], edges: [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }] };
 const scope = workflowScope(project, 'three');
 assert.deepEqual([...scope.owned], ['c']);
 assert.deepEqual([...scope.visible].sort(), ['a', 'b', 'c']);
});
