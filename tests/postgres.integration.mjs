import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startTestPostgres } from './support/postgres.mjs';
import { PgWorkflowRepository, PgWorkflowProjectLookup, WorkflowService } from '../server/workflow.mjs';
import { PgRunRepository, RunService } from '../server/run.mjs';
import { PgRefineRepository, RefineService } from '../server/refine.mjs';
import { PgProjectRepository, projectLifecycleKey } from '../server/projects.mjs';
import { BillingService, PgBillingRepository } from '../server/billing.mjs';

let database;
let pool;
before(async () => { database = await startTestPostgres(); pool = database.pool; });
after(async () => { await database?.stop(); });

async function fixture({ workspaceId = 'local', planVersion = 1 } = {}) {
  const productId = randomUUID();
  const projectId = randomUUID();
  const deliverableId = randomUUID();
  await pool.query('INSERT INTO sj_products(id,workspace_id,name) VALUES($1,$2,$3)',
    [productId, workspaceId, '数据库验收商品']);
  await pool.query('INSERT INTO sj_projects(id,workspace_id,name,product_id,sku_id) VALUES($1,$2,$3,$4,$5)',
    [projectId, workspaceId, '数据库验收项目', productId, randomUUID()]);
  const deliverable = { id: deliverableId, type: 'white', title: '主图', prompt: '清晰商品图' };
  await pool.query(`
    INSERT INTO sj_project_plans(id,project_id,workspace_id,version,status,revision,deliverables,
      product_version,product_snapshot,sku_snapshot,confirmed_at,confirmed_by)
    VALUES($1,$2,$3,$4,'confirmed',1,$5::jsonb,1,'{}'::jsonb,'{}'::jsonb,now(),'integration-test')
  `, [randomUUID(), projectId, workspaceId, planVersion, JSON.stringify([deliverable])]);
  const template = (await pool.query("SELECT * FROM sj_workflow_templates WHERE template_key='system-white' LIMIT 1")).rows[0];
  const workflows = new PgWorkflowRepository(pool);
  const instance = await workflows.insertInstance({ id: randomUUID(), workspaceId, projectId,
    planVersion, deliverableId, taskType: 'white', templateId: template.id,
    templateKey: template.template_key, templateVersion: template.version,
    nodes: template.nodes, edges: template.edges, ports: template.ports,
    lockedNodes: template.locked_nodes, revision: 1, createdAt: new Date(), updatedAt: new Date() });
  const runs = new PgRunRepository(pool);
  const run = await runs.insertRun({ id: randomUUID(), workspaceId, projectId, planVersion,
    deliverableId, workflowInstanceId: instance.id, instanceRevision: 1,
    status: 'awaiting_confirmation', graph: { nodes: instance.nodes, edges: instance.edges } });
  return { workspaceId, projectId, planVersion, deliverableId, instance, workflows, runs, run };
}

function confirmation(f, { key = randomUUID(), ...extra } = {}) {
  const now = new Date();
  return { runId: f.run.id, workflowInstanceId: f.instance.id,
    expectedRevision: 1, expectedInstanceRevision: 1,
    runPatch: { status: 'running', idempotencyKey: key, confirmedAt: now,
      confirmedBy: 'integration-test', startedAt: now, updatedAt: now }, nodeRuns: [], ...extra };
}

// Break: a caller-supplied updatedAt must not produce a duplicate SQL assignment.
test('真实 PostgreSQL：确认开跑持久化状态与时间戳', async () => {
  const f = await fixture();
  const result = await f.runs.confirmRun(confirmation(f));
  assert.equal(result.status, 'ok');
  const stored = await f.runs.getRun(f.run.id);
  assert.equal(stored.status, 'running');
  assert.equal(stored.revision, 2);
  assert.ok(stored.startedAt);
});

test('真实 PostgreSQL：并发保存与确认由同一实例锁序列化', async () => {
  const f = await fixture();
  const locker = await pool.connect();
  try {
    await locker.query('BEGIN');
    await locker.query('SELECT id FROM sj_workflow_instances WHERE id=$1 FOR UPDATE', [f.instance.id]);
    const confirmPromise = f.runs.confirmRun(confirmation(f));
    const savePromise = f.workflows.updateInstance(f.instance.id, 1,
      { nodes: f.instance.nodes, edges: f.instance.edges, ports: f.instance.ports, updatedAt: new Date() });
    await locker.query('COMMIT');
    const [confirmResult, saveResult] = await Promise.all([confirmPromise, savePromise]);
    assert.ok(
      (confirmResult.status === 'ok' && saveResult.status === 'frozen')
      || (confirmResult.status === 'instance_conflict' && saveResult.status === 'ok'),
      `must serialize without both writes succeeding: ${confirmResult.status}/${saveResult.status}`);
    assert.equal((await f.workflows.getInstance(f.instance.id)).revision, saveResult.status === 'ok' ? 2 : 1);
  } finally {
    await locker.query('ROLLBACK').catch(() => {});
    locker.release();
  }
});

test('真实 PostgreSQL：先保存成功时，旧修订确认冲突且不启动运行', async () => {
  const f = await fixture();
  const save = await f.workflows.updateInstance(f.instance.id, 1,
    { nodes: f.instance.nodes, edges: f.instance.edges, ports: f.instance.ports, updatedAt: new Date() });
  assert.equal(save.status, 'ok');
  const confirm = await f.runs.confirmRun(confirmation(f));
  assert.equal(confirm.status, 'instance_conflict');
  assert.equal((await f.runs.getRun(f.run.id)).status, 'awaiting_confirmation');
});

test('真实 PostgreSQL：重复导入在素材索引延迟后保持原版本和状态修订号', async () => {
  const f = await fixture();
  const jobId = randomUUID();
  await pool.query(`INSERT INTO sj_generation_jobs(id,input_hash,input,status,output)
    VALUES($1,'integration-test',$2::jsonb,'succeeded','{}'::jsonb)`,
  [jobId, JSON.stringify({ workspaceId: f.workspaceId, modelId: 'test:image', prompt: '样例' })]);
  const repo = new PgRefineRepository(pool);
  const project = new PgProjectRepository(pool, { workspaceId: f.workspaceId });
  // The project read confirms this fixture is visible through the same repository seam.
  assert.equal((await project.getProject(f.projectId)).id, f.projectId);
  const imported = await repo.createVersion({ scope: { workspaceId: f.workspaceId,
    projectId: f.projectId, planVersion: 1, deliverableId: f.deliverableId },
  row: { id: randomUUID(), workspaceId: f.workspaceId, projectId: f.projectId,
    planVersion: 1, deliverableId: f.deliverableId, sourceVersionId: null, assetId: null,
    jobId, status: 'draft', isCandidate: false, refinePath: null, requiresQc: false,
    content: { modelId: 'test:image', prompt: '样例' }, cost: { amountCents: 0 }, createdBy: 'integration-test' } });
  const stateAfterFirst = await repo.getState({ projectId: f.projectId, planVersion: 1, deliverableId: f.deliverableId });
  const assetId = randomUUID();
  await pool.query(`INSERT INTO sj_assets(id,workspace_id,source_type,source_id,content_type,object_key)
    VALUES($1,$2,'generation',$3,'image/png',$4)`, [assetId, f.workspaceId, jobId, `test/${assetId}.png`]);
  const repeated = await repo.createVersion({ scope: { workspaceId: f.workspaceId,
    projectId: f.projectId, planVersion: 1, deliverableId: f.deliverableId },
  row: { id: randomUUID(), workspaceId: f.workspaceId, projectId: f.projectId,
    planVersion: 1, deliverableId: f.deliverableId, sourceVersionId: null, assetId,
    jobId, status: 'draft', isCandidate: false, refinePath: null, requiresQc: false,
    content: { modelId: 'test:image', prompt: '样例' }, cost: { amountCents: 0 }, createdBy: 'integration-test' } });
  assert.equal(imported.created, true);
  assert.equal(repeated.created, false);
  assert.equal(repeated.version.id, imported.version.id);
  assert.equal(repeated.version.assetId, null);
  assert.equal((await repo.listVersions({ workspaceId: f.workspaceId, projectId: f.projectId,
    planVersion: 1, deliverableId: f.deliverableId })).length, 1);
  assert.equal((await repo.getState({ projectId: f.projectId, planVersion: 1,
    deliverableId: f.deliverableId })).revision, stateAfterFirst.revision);
});


test('PostgreSQL: concurrent confirmation with one key reuses the committed run', async () => {
  const f = await fixture();
  const key = randomUUID();
  const results = await Promise.all([
    f.runs.confirmRun(confirmation(f, { key })),
    f.runs.confirmRun(confirmation(f, { key })),
  ]);
  assert.deepEqual(results.map(row => row.status).sort(), ['ok', 'started']);
  assert.equal((await f.runs.getRun(f.run.id)).revision, 2);
});

test('PostgreSQL: caller timestamps work on run and node mutations', async () => {
  const f = await fixture();
  const node = { id: randomUUID(), runId: f.run.id, workspaceId: 'local', nodeId: 'input',
    nodeType: 'input', status: 'pending', idempotencyKey: randomUUID() };
  await f.runs.insertRun({ ...f.run, id: randomUUID(), status: 'cancelled' }, []);
  const updated = await f.runs.updateRun(f.run.id, 1, { status: 'cancelled', updatedAt: new Date() });
  assert.equal(updated.status, 'ok');
  await f.runs.mutateRun({ runId: f.run.id, expectedRevision: 2,
    runPatch: { cancelReason: 'test', updatedAt: new Date() }, nodeUpserts: [node] });
  const patched = await f.runs.updateNodeRun(node.id, { status: 'succeeded', updatedAt: new Date() });
  assert.equal(patched.status, 'succeeded');
  await f.runs.mutateRun({ runId: f.run.id, runPatch: { updatedAt: new Date() },
    nodePatches: [{ id: node.id, patch: { output: { observed: true }, updatedAt: new Date() } }] });
  assert.equal((await f.runs.listNodeRuns(f.run.id))[0].output.observed, true);
  assert.equal((await f.runs.getRun(f.run.id)).cancelReason, 'test');
});

async function job(workspaceId = 'local', status = 'succeeded') {
  const id = randomUUID();
  await pool.query('INSERT INTO sj_generation_jobs(id,input_hash,input,status,output) VALUES($1,$2,$3::jsonb,$4,$5::jsonb)',
    [id, 'integration-test', JSON.stringify({ workspaceId, modelId: 'test:image', prompt: 'Product image' }), status, '{}']);
  return id;
}

async function asset(workspaceId = 'local', sourceId = randomUUID()) {
  const id = randomUUID();
  await pool.query('INSERT INTO sj_assets(id,workspace_id,source_type,source_id,content_type,object_key) VALUES($1,$2,$3,$4,$5,$6)',
    [id, workspaceId, 'generation', sourceId, 'image/png', `test/${id}.png`]);
  return id;
}

async function version(f, { id = randomUUID(), deliverableId = f.deliverableId,
  workspaceId = f.workspaceId, planVersion = f.planVersion, number = 1, jobId = null,
  assetId = null, status = 'draft', candidate = false } = {}) {
  await pool.query('INSERT INTO sj_deliverable_versions(id,workspace_id,project_id,plan_version,deliverable_id,version,job_id,asset_id,status,is_candidate) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [id, workspaceId, f.projectId, planVersion, deliverableId, number, jobId, assetId, status, candidate]);
  return id;
}

async function candidateState(f, versionId) {
  await pool.query('INSERT INTO sj_deliverable_states(workspace_id,project_id,plan_version,deliverable_id,current_candidate_version_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(project_id,plan_version,deliverable_id) DO UPDATE SET current_candidate_version_id=EXCLUDED.current_candidate_version_id',
    [f.workspaceId, f.projectId, f.planVersion, f.deliverableId, versionId]);
}

async function approval(f, versionId, { workspaceId = f.workspaceId, number = 1 } = {}) {
  const id = randomUUID();
  await pool.query('INSERT INTO sj_deliverable_reviews(id,workspace_id,project_id,plan_version,deliverable_id,version_id,version_number,status,fidelity_result,text_result,size_result,layout_result,reviewed_by,reviewed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now())',
    [id, workspaceId, f.projectId, f.planVersion, f.deliverableId, versionId, number,
      'approved', 'passed', 'passed', 'passed', 'passed', 'integration-test']);
  return id;
}

async function exported(f, versionId, { workspaceId = f.workspaceId, planVersion = f.planVersion,
  missing = [] } = {}) {
  const id = randomUUID();
  const hash = 'a'.repeat(64);
  await pool.query('INSERT INTO sj_project_exports(id,workspace_id,project_id,plan_version,idempotency_key,request_hash,status,file_name,object_key,bytes,zip_sha256,manifest_sha256,completed_at,items,missing,item_count,missing_count) VALUES($1::uuid,$2,$3,$4,$1::text,$5,$6,$7,$8,$9,$5,$5,now(),$10::jsonb,$11::jsonb,1,$12)',
    [id, workspaceId, f.projectId, planVersion, hash, 'completed', 'test.zip', `test/${id}.zip`, 100,
      JSON.stringify([{ deliverableId: f.deliverableId, versionId }]), JSON.stringify(missing), missing.length]);
}

async function evidence(f, deliverableIds = [f.deliverableId], workspaceId = f.workspaceId) {
  const repo = new PgProjectRepository(pool, { workspaceId });
  const found = await repo.getLifecycleEvidence([{ projectId: f.projectId, planVersion: f.planVersion, deliverableIds }]);
  return found.get(projectLifecycleKey(f.projectId, f.planVersion));
}

test('PostgreSQL lifecycle: latest confirmed run wins, unknown nodes override and scopes stay isolated', async () => {
  const f = await fixture();
  await f.runs.insertRun({ ...f.run, id: randomUUID(), status: 'succeeded', idempotencyKey: randomUUID(),
    confirmedAt: new Date(), confirmedBy: 'integration-test', createdAt: new Date('2020-01-01') });
  const latest = await f.runs.insertRun({ ...f.run, id: randomUUID(), status: 'running', idempotencyKey: randomUUID(),
    confirmedAt: new Date(), confirmedBy: 'integration-test', createdAt: new Date('2021-01-01') });
  for (const patch of [{ workspaceId: 'other' }, { planVersion: 2 }, { deliverableId: randomUUID() }]) {
    await f.runs.insertRun({ ...f.run, id: randomUUID(), status: 'succeeded', idempotencyKey: randomUUID(),
      confirmedAt: new Date(), confirmedBy: 'integration-test', ...patch });
  }
  assert.deepEqual((await evidence(f)).runs, [{ deliverableId: f.deliverableId, status: 'running' }]);
  await pool.query('INSERT INTO sj_workflow_node_runs(id,run_id,workspace_id,node_id,node_type,status,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [randomUUID(), latest.id, f.workspaceId, 'generate', 'generate', 'unknown', randomUUID()]);
  assert.deepEqual((await evidence(f)).runs, [{ deliverableId: f.deliverableId, status: 'unknown' }]);
  assert.deepEqual((await evidence(f, [], f.workspaceId)).runs, []);
  assert.deepEqual((await evidence(f, [f.deliverableId], 'other')).runs, []);
});

test('PostgreSQL lifecycle: only successful same-workspace jobs or assets count as produced', async () => {
  const f = await fixture();
  const jobDeliverable = f.deliverableId;
  const assetDeliverable = randomUUID();
  const foreignJobDeliverable = randomUUID();
  const foreignAssetDeliverable = randomUUID();
  const failedJobDeliverable = randomUUID();
  await version(f, { deliverableId: jobDeliverable, jobId: await job() });
  await version(f, { deliverableId: assetDeliverable, assetId: await asset() });
  await version(f, { deliverableId: foreignJobDeliverable, jobId: await job('other') });
  await version(f, { deliverableId: foreignAssetDeliverable, assetId: await asset('other') });
  await version(f, { deliverableId: failedJobDeliverable, jobId: await job('local', 'failed') });
  await version(f, { planVersion: 2, jobId: await job() });
  await version(f, { deliverableId: randomUUID(), assetId: await asset() });
  const result = await evidence(f, [jobDeliverable, assetDeliverable, foreignJobDeliverable, foreignAssetDeliverable, failedJobDeliverable]);
  assert.deepEqual(result.producedDeliverableIds.sort(), [jobDeliverable, assetDeliverable].sort());
});

test('PostgreSQL lifecycle: candidate pointer and matching approved review are both required', async () => {
  const f = await fixture();
  const old = await version(f, { status: 'approved' });
  const oldReview = await approval(f, old);
  const current = await version(f, { number: 2, status: 'candidate', candidate: true });
  await candidateState(f, old);
  assert.deepEqual((await evidence(f)).candidateDeliverableIds, []);
  await candidateState(f, current);
  assert.deepEqual((await evidence(f)).candidateDeliverableIds, [f.deliverableId]);
  assert.deepEqual((await evidence(f)).approvedDeliverableIds, []);
  await pool.query('UPDATE sj_deliverable_versions SET status=$1 WHERE id=$2', ['approved', current]);
  assert.deepEqual((await evidence(f)).approvedDeliverableIds, []);
  await approval(f, current, { workspaceId: 'other', number: 2 });
  assert.deepEqual((await evidence(f)).approvedDeliverableIds, []);
  await pool.query('UPDATE sj_deliverable_reviews SET status=$1,revoke_reason=$2,revoked_by=$3,revoked_at=now() WHERE id=$4',
    ['revoked', 'integration test', 'integration-test', oldReview]);
  await approval(f, current, { number: 2 });
  assert.deepEqual((await evidence(f)).approvedDeliverableIds, [f.deliverableId]);
  const otherPlanVersion = await version(f, { planVersion: 2, status: 'candidate', candidate: true });
  await candidateState(f, otherPlanVersion);
  assert.deepEqual((await evidence(f)).candidateDeliverableIds, []);
  assert.deepEqual((await evidence(f)).approvedDeliverableIds, []);
});

test('PostgreSQL lifecycle: exports must match current approved versions and retain missing counts', async () => {
  const f = await fixture();
  const old = await version(f);
  const current = await version(f, { number: 2, status: 'approved', candidate: true });
  await candidateState(f, current);
  await approval(f, current, { number: 2 });
  await exported(f, old);
  await exported(f, current, { workspaceId: 'other' });
  await exported(f, current, { planVersion: 2 });
  assert.deepEqual((await evidence(f)).exports, [
    { status: 'completed', missingCount: 0, matchesCurrentCandidates: false },
  ]);
  await exported(f, current, { missing: [{ deliverableId: randomUUID(), reason: 'not-approved' }] });
  await exported(f, current);
  const rows = (await evidence(f)).exports;
  assert.equal(rows.length, 3);
  assert.ok(rows.some(row => row.missingCount === 1 && row.matchesCurrentCandidates));
  assert.ok(rows.some(row => row.missingCount === 0 && row.matchesCurrentCandidates));
});

test('PostgreSQL refine service: delayed index and concurrent replays return one immutable draft', async () => {
  const f = await fixture();
  const service = new RefineService(new PgRefineRepository(pool));
  const body = { projectId: f.projectId, planVersion: f.planVersion, jobId: await job() };
  const first = await service.importVersion(f.deliverableId, body);
  await asset(f.workspaceId, body.jobId);
  const replays = await Promise.all(Array.from({ length: 4 }, () => service.importVersion(f.deliverableId, body)));
  assert.ok(replays.every(row => row.created === false && row.version.id === first.version.id));
  assert.ok(replays.every(row => row.state.revision === first.state.revision && row.versions.length === 1));
  const changed = await service.importVersion(f.deliverableId, { ...body, content: { variant: 'new' } });
  assert.equal(changed.created, true);
  const child = await service.importVersion(f.deliverableId, { ...body, sourceVersionId: first.version.id });
  assert.equal(child.created, true);
  const one = await service.importVersion(f.deliverableId, { projectId: f.projectId, planVersion: 1, assetId: await asset() });
  const two = await service.importVersion(f.deliverableId, { projectId: f.projectId, planVersion: 1, assetId: await asset() });
  assert.notEqual(one.version.id, two.version.id);
});

test('PostgreSQL run service: editing during reservation rejects stale graph and releases new reservation', async () => {
  const f = await fixture();
  const nodes = f.instance.nodes.map(node => node.type === 'generate'
    ? { ...node, params: { ...node.params, modelId: 'test:image' } } : node);
  await f.workflows.updateInstance(f.instance.id, 1, { nodes, edges: f.instance.edges, ports: f.instance.ports, updatedAt: new Date() });
  const workflows = new WorkflowService(f.workflows, { projects: new PgWorkflowProjectLookup(pool) });
  let resume;
  let reached;
  const barrier = new Promise(resolve => { reached = resolve; });
  const gate = new Promise(resolve => { resume = resolve; });
  const released = [];
  const billing = {
    async quote(input) {
      return { ...input, priced: true, status: 'priced', billingMode: 'credit', amountCents: 25,
        currency: 'CNY', unit: 'image', unitPrice: 25, priceId: 'test-price', priceVersion: 1 };
    },
    async reserve() { reached(); await gate; return { created: true, entry: { amountCents: 25 } }; },
    async release(taskId) { released.push(taskId); },
  };
  const service = new RunService(f.runs, { workflows, billing, autoStart: false });
  const estimate = await service.estimate({ workflowInstanceId: f.instance.id });
  const confirming = service.confirm({ runId: estimate.run.id, revision: estimate.run.revision, idempotencyKey: randomUUID() });
  const rejected = assert.rejects(confirming, error => error.code === 'INSTANCE_CHANGED' && error.status === 409);
  await barrier;
  try {
    const changedNodes = nodes.map(node => node.type === 'prompt'
      ? { ...node, params: { ...node.params, prompt: 'changed after estimate' } } : node);
    await workflows.updateInstance(f.instance.id, { revision: 2, nodes: changedNodes }, { workspaceId: f.workspaceId });
  } finally {
    resume();
  }
  await rejected;
  assert.equal(released.length, 1);
  assert.equal((await f.runs.getRun(estimate.run.id)).status, 'awaiting_confirmation');
  assert.equal((await f.runs.listNodeRuns(estimate.run.id)).length, 0);
});

test('PostgreSQL workflow: normal editor freezes after a run has started', async () => {
  const f = await fixture();
  assert.equal((await f.runs.confirmRun(confirmation(f))).status, 'ok');
  const result = await f.workflows.updateInstance(f.instance.id, 1, { nodes: f.instance.nodes,
    edges: f.instance.edges, ports: f.instance.ports, updatedAt: new Date() });
  assert.equal(result.status, 'frozen');
  assert.equal((await f.workflows.getInstance(f.instance.id)).revision, 1);
});


test('PostgreSQL run service: concurrent replay leaves only reservations used by the winning run', { timeout: 15000 }, async () => {
  const f = await fixture();
  const nodes = f.instance.nodes.map(node => node.type === 'generate'
    ? { ...node, params: { ...node.params, modelId: 'test:image' } } : node);
  await f.workflows.updateInstance(f.instance.id, 1, { nodes, edges: f.instance.edges,
    ports: f.instance.ports, updatedAt: new Date() });
  const workflows = new WorkflowService(f.workflows, { projects: new PgWorkflowProjectLookup(pool) });
  let releaseGate;
  const gate = new Promise(resolve => { releaseGate = resolve; });
  const held = new Set();
  let count = 0;
  const billing = {
    async quote(input) { return { ...input, priced: true, amountCents: 25, currency: 'CNY' }; },
    async reserve(input) {
      held.add(input.taskId);
      count += 1;
      if (count === 2) releaseGate();
      await gate;
      return { created: true, entry: { amountCents: 25 } };
    },
    async release(taskId) { held.delete(taskId); },
  };
  const service = new RunService(f.runs, { workflows, billing, autoStart: false });
  const estimated = await service.estimate({ workflowInstanceId: f.instance.id });
  const body = { runId: estimated.run.id, revision: estimated.run.revision, idempotencyKey: randomUUID() };
  const results = await Promise.all([service.confirm(body), service.confirm(body)]);
  assert.deepEqual(results.map(row => row.created).sort(), [false, true]);
  const paid = (await f.runs.listNodeRuns(estimated.run.id)).filter(row => row.nodeType === 'generate');
  assert.equal(paid.length, 1);
  assert.deepEqual([...held], paid.map(row => row.billingTaskId));
});


test('PostgreSQL run service: replay preserves a shared reservation used by committed nodes', { timeout: 15000 }, async () => {
  const f = await fixture();
  const nodes = f.instance.nodes.map(node => node.type === 'generate'
    ? { ...node, params: { ...node.params, modelId: 'test:image' } } : node);
  await f.workflows.updateInstance(f.instance.id, 1, { nodes, edges: f.instance.edges,
    ports: f.instance.ports, updatedAt: new Date() });
  const billingTaskId = randomUUID();
  await f.runs.mutateRun({ runId: f.run.id, nodeUpserts: [{ id: billingTaskId, runId: f.run.id,
    workspaceId: f.workspaceId, nodeId: 'generate', nodeType: 'generate', status: 'pending',
    billingTaskId, idempotencyKey: randomUUID() }] });
  const workflows = new WorkflowService(f.workflows, { projects: new PgWorkflowProjectLookup(pool) });
  let releaseGate;
  const gate = new Promise(resolve => { releaseGate = resolve; });
  let enteredReserve;
  const entered = new Promise(resolve => { enteredReserve = resolve; });
  const held = new Set();
  const released = [];
  let count = 0;
  const billing = {
    async quote(input) { return { ...input, priced: true, amountCents: 25, currency: 'CNY' }; },
    async reserve(input) {
      const created = !held.has(input.taskId);
      held.add(input.taskId);
      count += 1;
      if (count === 1) { enteredReserve(); await gate; }
      return { created, entry: { amountCents: 25 } };
    },
    async release(taskId) { released.push(taskId); held.delete(taskId); },
  };
  const service = new RunService(f.runs, { workflows, billing, autoStart: false });
  const estimate = await service.estimate({ workflowInstanceId: f.instance.id });
  const body = { runId: estimate.run.id, revision: estimate.run.revision, idempotencyKey: randomUUID() };
  const first = service.confirm(body);
  await entered;
  let second;
  try { second = await service.confirm(body); } finally { releaseGate(); }
  const results = [await first, second];
  assert.deepEqual(results.map(row => row.created).sort(), [false, true]);
  assert.deepEqual([...held], [billingTaskId]);
  assert.deepEqual(released, []);
  assert.equal((await f.runs.listNodeRuns(f.run.id)).find(row => row.nodeId === 'generate').billingTaskId, billingTaskId);
});


test('PostgreSQL billing: shared task remains reserved when a different confirmation key wins', { timeout: 15000 }, async () => {
  const f = await fixture();
  const nodes = f.instance.nodes.map(node => node.type === 'generate'
    ? { ...node, params: { ...node.params, modelId: 'test:image' } } : node);
  await f.workflows.updateInstance(f.instance.id, 1, { nodes, edges: f.instance.edges,
    ports: f.instance.ports, updatedAt: new Date() });
  const billingTaskId = randomUUID();
  await f.runs.mutateRun({ runId: f.run.id, nodeUpserts: [{ id: billingTaskId, runId: f.run.id,
    workspaceId: f.workspaceId, nodeId: 'generate', nodeType: 'generate', status: 'pending',
    billingTaskId, idempotencyKey: randomUUID() }] });
  const real = new BillingService(new PgBillingRepository(pool));
  await real.setPrice({ capability: 'image.generate', modelId: 'test:image', unit: 'image', unitPrice: '0.25' });
  await real.adjust({ amountCents: 1000, reason: 'Isolated integration test', reference: randomUUID() });
  const heldBefore = (await real.balance()).heldCents;
  let resume;
  let entered;
  const gate = new Promise(resolve => { resume = resolve; });
  const barrier = new Promise(resolve => { entered = resolve; });
  const billing = {
    quote: input => real.quote(input), release: (...args) => real.release(...args),
    async reserve(...args) {
      const result = await real.reserve(...args);
      if (result.created) { entered(); await gate; }
      return result;
    },
  };
  const workflows = new WorkflowService(f.workflows, { projects: new PgWorkflowProjectLookup(pool) });
  const service = new RunService(f.runs, { workflows, billing, autoStart: false });
  const estimate = await service.estimate({ workflowInstanceId: f.instance.id });
  const body = { runId: estimate.run.id, revision: estimate.run.revision, idempotencyKey: randomUUID() };
  const first = service.confirm(body);
  const rejected = assert.rejects(first, error => error.code === 'REVISION_CONFLICT');
  await barrier;
  try { await service.confirm({ ...body, idempotencyKey: randomUUID() }); } finally { resume(); }
  await rejected;
  assert.equal((await real.balance()).heldCents - heldBefore, 25);
  assert.equal((await f.runs.getRun(f.run.id)).status, 'running');
});

test('PostgreSQL billing: cross-run key collision releases only the rejected reservation', { timeout: 15000 }, async () => {
  const real = new BillingService(new PgBillingRepository(pool));
  await real.setPrice({ capability: 'image.generate', modelId: 'test:image', unit: 'image', unitPrice: '0.25' });
  await real.adjust({ amountCents: 1000, reason: 'Isolated integration test', reference: randomUUID() });
  const before = (await real.balance()).heldCents;
  let count = 0;
  let resume;
  const gate = new Promise(resolve => { resume = resolve; });
  const billing = {
    quote: input => real.quote(input), release: (...args) => real.release(...args),
    async reserve(...args) {
      const result = await real.reserve(...args);
      if (++count === 2) resume();
      await gate;
      return result;
    },
  };
  const requests = [];
  const key = randomUUID();
  for (let index = 0; index < 2; index += 1) {
    const f = await fixture();
    const nodes = f.instance.nodes.map(node => node.type === 'generate'
      ? { ...node, params: { ...node.params, modelId: 'test:image' } } : node);
    await f.workflows.updateInstance(f.instance.id, 1, { nodes, edges: f.instance.edges,
      ports: f.instance.ports, updatedAt: new Date() });
    const workflows = new WorkflowService(f.workflows, { projects: new PgWorkflowProjectLookup(pool) });
    const service = new RunService(f.runs, { workflows, billing, autoStart: false });
    const estimate = await service.estimate({ workflowInstanceId: f.instance.id });
    requests.push({ f, service, body: { runId: estimate.run.id, revision: estimate.run.revision, idempotencyKey: key } });
  }
  const results = await Promise.allSettled(requests.map(row => row.service.confirm(row.body)));
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal((await real.balance()).heldCents - before, 25);
  const rejected = results.find(row => row.status === 'rejected');
  assert.equal(rejected.reason.code, 'IDEMPOTENCY_CONFLICT');
  const loser = requests[results.findIndex(row => row.status === 'rejected')];
  assert.equal((await loser.f.runs.getRun(loser.body.runId)).status, 'awaiting_confirmation');
});


test('PostgreSQL billing: partial reservation failure preserves the committed winner holds', { timeout: 15000 }, async () => {
  const f = await fixture();
  const nodes = f.instance.nodes.map(node => node.type === 'generate'
    ? { ...node, params: { ...node.params, modelId: 'test:image' } } : node);
  nodes.push({ ...nodes.find(node => node.type === 'generate'), id: 'generate-two', name: 'Second image' });
  const edges = [...f.instance.edges, { id: 'prompt-two', source: 'prompt', sourcePort: 'prompt',
    target: 'generate-two', targetPort: 'prompt' }];
  await f.workflows.updateInstance(f.instance.id, 1, { nodes, edges, ports: f.instance.ports, updatedAt: new Date() });
  const tasks = ['generate', 'generate-two'].map(nodeId => ({ id: randomUUID(), nodeId }));
  await f.runs.mutateRun({ runId: f.run.id, nodeUpserts: tasks.map(task => ({ id: task.id,
    runId: f.run.id, workspaceId: f.workspaceId, nodeId: task.nodeId, nodeType: 'generate',
    status: 'pending', billingTaskId: task.id, idempotencyKey: randomUUID() })) });
  const real = new BillingService(new PgBillingRepository(pool));
  await real.setPrice({ capability: 'image.generate', modelId: 'test:image', unit: 'image', unitPrice: '0.25' });
  await real.adjust({ amountCents: 1000, reason: 'Isolated integration test', reference: randomUUID() });
  const heldBefore = (await real.balance()).heldCents;
  let resume;
  let entered;
  const gate = new Promise(resolve => { resume = resolve; });
  const barrier = new Promise(resolve => { entered = resolve; });
  let calls = 0;
  const billing = {
    quote: input => real.quote(input), release: (...args) => real.release(...args),
    async reserve(...args) {
      if (++calls === 2) throw Object.assign(new Error('Explicit second reservation failure'), { code: 'TEST_RESERVE_FAILED' });
      const result = await real.reserve(...args);
      entered();
      await gate;
      return result;
    },
  };
  const workflows = new WorkflowService(f.workflows, { projects: new PgWorkflowProjectLookup(pool) });
  const service = new RunService(f.runs, { workflows, billing, autoStart: false });
  const winner = new RunService(f.runs, { workflows, billing: real, autoStart: false });
  const estimate = await service.estimate({ workflowInstanceId: f.instance.id });
  const body = { runId: estimate.run.id, revision: estimate.run.revision, idempotencyKey: randomUUID() };
  const confirming = service.confirm(body);
  const rejected = assert.rejects(confirming, error => error.code === 'TEST_RESERVE_FAILED');
  await barrier;
  try {
    await winner.confirm({ ...body, idempotencyKey: randomUUID() });
    assert.equal((await real.balance()).heldCents - heldBefore, 50);
  } finally { resume(); }
  await rejected;
  assert.equal((await real.balance()).heldCents - heldBefore, 50);
  assert.equal((await f.runs.getRun(f.run.id)).status, 'running');
  assert.deepEqual((await f.runs.listNodeRuns(f.run.id)).filter(row => row.nodeType === 'generate')
    .map(row => row.reservedCents), [25, 25]);
});
