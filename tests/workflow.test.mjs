import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from '../server/http.mjs';
import { AppError } from '../server/errors.mjs';
import {
  TASK_TYPE_KEYS, WorkflowService, validateWorkflowGraph,
} from '../server/workflow.mjs';

// 测试只用内存仓储、内存项目/模型查询与模拟审计；不连接 PostgreSQL、不调用模型、不产生费用。

const TYPE_NAMES = {
  white: '白底主图 / 多角度',
  scene: '场景图',
  selling: '卖点 / 促销图',
  detail: '细节 / 尺寸 / 包装清单',
  extension: 'AI 扩展建议',
};

function clone(value) {
  return structuredClone(value);
}

function rawWhiteGraph({ modelId = null, prompt = '' } = {}) {
  return {
    nodes: [
      { id: 'materials', type: 'input', name: '商品资料' },
      { id: 'prompt', type: 'prompt', name: '文本提示词', params: { prompt, copy: [] } },
      {
        id: 'generate',
        type: 'generate',
        name: '生图',
        params: modelId ? { modelId, aspectRatio: '1:1' } : { aspectRatio: '1:1' },
      },
      { id: 'ready', type: 'output', name: '交付候选' },
    ],
    edges: [
      { id: 'edge-materials-prompt', source: 'materials', sourcePort: 'snapshot', target: 'prompt', targetPort: 'source' },
      { id: 'edge-prompt-generate', source: 'prompt', sourcePort: 'prompt', target: 'generate', targetPort: 'prompt' },
      { id: 'edge-generate-ready', source: 'generate', sourcePort: 'image', target: 'ready', targetPort: 'result' },
    ],
    lockedNodes: [],
  };
}

class MemoryWorkflowRepository {
  taskTypes = new Map();
  templates = [];
  instances = new Map();
  startedInstances = new Set();

  async listTaskTypes() {
    return [...this.taskTypes.values()].map(clone);
  }

  async getTaskType(typeKey) {
    const row = this.taskTypes.get(typeKey);
    return row ? clone(row) : null;
  }

  async listTemplates({ taskType = null, status = null, workspaceId = null } = {}) {
    const latest = new Map();
    for (const row of this.templates) {
      if (taskType && row.taskType !== taskType) continue;
      if (status && row.status !== status) continue;
      if (workspaceId && !row.isSystem && row.workspaceId !== workspaceId) continue;
      const current = latest.get(row.templateKey);
      if (!current || row.version > current.version) latest.set(row.templateKey, row);
    }
    return [...latest.values()]
      .sort((a, b) => a.taskType.localeCompare(b.taskType) || a.templateKey.localeCompare(b.templateKey))
      .map(clone);
  }

  async getTemplate(templateKey, version = null) {
    const rows = this.templates.filter(row => row.templateKey === templateKey);
    if (!rows.length) return null;
    const row = version
      ? rows.find(item => item.version === version)
      : rows.reduce((best, item) => (!best || item.version > best.version ? item : best), null);
    return row ? clone(row) : null;
  }

  async listTemplateVersions(templateKey) {
    return this.templates
      .filter(row => row.templateKey === templateKey)
      .sort((a, b) => b.version - a.version)
      .map(clone);
  }

  async createTemplateVersion(record, { createOnly = false } = {}) {
    const rows = this.templates.filter(row => row.templateKey === record.templateKey);
    if (createOnly && rows.length) {
      throw new AppError('TEMPLATE_EXISTS', '模板键已存在。', 409);
    }
    const version = Math.max(0, ...rows.map(row => row.version)) + 1;
    const row = { ...clone(record), version };
    this.templates.push(row);
    return clone(row);
  }

  async getInstance(id) {
    const row = this.instances.get(id);
    return row ? clone(row) : null;
  }

  async getInstanceForDeliverable(projectId, planVersion, deliverableId) {
    for (const row of this.instances.values()) {
      if (row.projectId === projectId && row.planVersion === planVersion && row.deliverableId === deliverableId) {
        return clone(row);
      }
    }
    return null;
  }

  async insertInstance(record) {
    if (await this.getInstanceForDeliverable(record.projectId, record.planVersion, record.deliverableId)) {
      throw new AppError('INSTANCE_EXISTS', '该交付项已有工作流实例。', 409);
    }
    if (this.instances.has(record.id)) {
      throw new AppError('INSTANCE_EXISTS', '工作流实例编号重复。', 409);
    }
    this.instances.set(record.id, clone(record));
    return clone(record);
  }

  async updateInstance(id, expectedRevision, patch) {
    const current = this.instances.get(id);
    if (!current) return { status: 'missing' };
    if (this.startedInstances?.has(id) && !patch.allowStartedRun) return { status: 'frozen', revision: current.revision };
    if (current.revision !== expectedRevision) return { status: 'conflict', revision: current.revision };
    const next = {
      ...current,
      nodes: clone(patch.nodes),
      edges: clone(patch.edges),
      ports: clone(patch.ports),
      revision: current.revision + 1,
      updatedAt: patch.updatedAt,
    };
    this.instances.set(id, next);
    return { status: 'ok', instance: clone(next) };
  }
}

function seedRepository() {
  const repository = new MemoryWorkflowRepository();
  const graph = validateWorkflowGraph(rawWhiteGraph().nodes, rawWhiteGraph().edges);
  for (const typeKey of TASK_TYPE_KEYS) {
    repository.taskTypes.set(typeKey, {
      typeKey,
      name: TYPE_NAMES[typeKey],
      purpose: '',
      defaultAspectRatio: '1:1',
      defaultTemplateKey: `system-${typeKey}`,
      defaultNodeTemplate: {},
      enabled: true,
      version: 1,
      updatedAt: new Date(),
    });
    repository.templates.push({
      id: randomUUID(),
      workspaceId: 'local',
      templateKey: `system-${typeKey}`,
      name: `${TYPE_NAMES[typeKey]}默认工作流`,
      description: null,
      taskType: typeKey,
      version: 1,
      nodes: clone(graph.nodes),
      edges: clone(graph.edges),
      ports: clone(graph.ports),
      lockedNodes: clone(graph.lockedNodes),
      status: 'active',
      isSystem: true,
      createdBy: null,
      createdAt: new Date(),
    });
  }
  return repository;
}

class MemoryProjects {
  rows = new Map();

  set({ projectId, planVersion = 1, workspaceId = 'local', planStatus = 'draft', deliverable }) {
    this.rows.set(`${projectId}:${planVersion}`, {
      workspaceId, planStatus, deliverables: [clone(deliverable)],
    });
  }

  async getDeliverable({ projectId, planVersion, deliverableId }) {
    const row = this.rows.get(`${projectId}:${planVersion}`);
    if (!row) return null;
    const deliverable = row.deliverables.find(item => item.id === deliverableId);
    if (!deliverable) return null;
    return {
      projectId,
      workspaceId: row.workspaceId,
      projectStatus: 'active',
      planVersion,
      planStatus: row.planStatus,
      deliverable: clone(deliverable),
    };
  }
}

class MemoryModels {
  rows = new Map();

  add(id, patch = {}) {
    this.rows.set(id, {
      id,
      enabled: true,
      executable: true,
      capabilities: ['image.generate', 'image.edit'],
      ...patch,
    });
  }

  async getModel(id) {
    const row = this.rows.get(id);
    return row ? clone(row) : null;
  }
}

class MemoryAudit {
  entries = [];

  async record(entry) {
    this.entries.push(clone(entry));
    return clone(entry);
  }
}

function makeDeliverable(type = 'white') {
  return {
    id: randomUUID(),
    type,
    title: TYPE_NAMES[type],
    status: 'planned',
    promptText: '主体：燕麦色陶瓷杯；构图：正面视角',
    prompt: { aspectRatio: '1:1' },
    copy: [{ slot: 'headline', text: '燕麦色陶瓷杯' }],
    parameters: {},
  };
}

function fixture({ planStatus = 'draft', workspaceId = 'local', deliverable = makeDeliverable() } = {}) {
  const repository = seedRepository();
  const projects = new MemoryProjects();
  const projectId = randomUUID();
  projects.set({ projectId, planStatus, workspaceId, deliverable });
  const models = new MemoryModels();
  models.add('test:image');
  models.add('test:other');
  models.add('test:disabled', { enabled: false });
  const audit = new MemoryAudit();
  const service = new WorkflowService(repository, { projects, models, audit });
  return { repository, projects, models, audit, service, projectId, planVersion: 1, deliverable };
}

function addBranch(nodes, edges, id, fromPort = 'copy') {
  return {
    nodes: [
      ...clone(nodes),
      { id, type: 'generate', name: '并行生图', params: { aspectRatio: '1:1' } },
    ],
    edges: [
      ...clone(edges),
      { id: `edge-prompt-${id}`, source: 'prompt', sourcePort: fromPort, target: id, targetPort: 'prompt' },
    ],
  };
}

// ---- 纯图校验 ----

test('DAG 校验拒绝自环、有向环、重复节点、悬空边与不兼容端口', () => {
  assert.throws(
    () => validateWorkflowGraph(
      [
        { id: 'materials', type: 'input' },
        { id: 'prompt', type: 'prompt' },
        { id: 'generate', type: 'generate' },
        { id: 'ready', type: 'output' },
      ],
      [
        { id: 'a', source: 'materials', sourcePort: 'snapshot', target: 'prompt', targetPort: 'source' },
        { id: 'b', source: 'prompt', sourcePort: 'prompt', target: 'generate', targetPort: 'prompt' },
        { id: 'c', source: 'generate', sourcePort: 'image', target: 'generate', targetPort: 'prompt' },
      ],
    ),
    { code: 'SELF_LOOP', status: 422 },
  );

  assert.throws(
    () => validateWorkflowGraph(
      [
        { id: 'materials', type: 'input' },
        { id: 'prompt', type: 'prompt' },
        { id: 'editA', type: 'edit' },
        { id: 'editB', type: 'edit' },
        { id: 'ready', type: 'output' },
      ],
      [
        { id: 'a', source: 'materials', sourcePort: 'snapshot', target: 'prompt', targetPort: 'source' },
        { id: 'b', source: 'prompt', sourcePort: 'prompt', target: 'editA', targetPort: 'instruction' },
        { id: 'c', source: 'editA', sourcePort: 'image', target: 'editB', targetPort: 'source' },
        { id: 'd', source: 'editB', sourcePort: 'image', target: 'editA', targetPort: 'source' },
        { id: 'e', source: 'editA', sourcePort: 'image', target: 'ready', targetPort: 'result' },
      ],
    ),
    { code: 'DAG_CYCLE', status: 422 },
  );

  assert.throws(
    () => validateWorkflowGraph(
      [
        { id: 'materials', type: 'input' },
        { id: 'materials', type: 'input' },
        { id: 'ready', type: 'output' },
      ],
      [],
    ),
    { code: 'DUPLICATE_NODE', status: 422 },
  );

  assert.throws(
    () => validateWorkflowGraph(
      [
        { id: 'materials', type: 'input' },
        { id: 'prompt', type: 'prompt' },
        { id: 'ready', type: 'output' },
      ],
      [
        { id: 'a', source: 'materials', sourcePort: 'snapshot', target: 'prompt', targetPort: 'source' },
        { id: 'b', source: 'prompt', sourcePort: 'prompt', target: 'ghost', targetPort: 'result' },
      ],
    ),
    { code: 'DANGLING_EDGE', status: 422 },
  );

  assert.throws(
    () => validateWorkflowGraph(
      [
        { id: 'materials', type: 'input' },
        { id: 'prompt', type: 'prompt' },
        { id: 'ready', type: 'output' },
      ],
      [
        { id: 'a', source: 'materials', sourcePort: 'snapshot', target: 'prompt', targetPort: 'source' },
        { id: 'b', source: 'prompt', sourcePort: 'prompt', target: 'ready', targetPort: 'result' },
      ],
    ),
    { code: 'PORT_TYPE_MISMATCH', status: 422 },
  );
});

test('同一输入端口不能被两条边占用，必需输入端口必须连接', () => {
  assert.throws(
    () => validateWorkflowGraph(
      [
        { id: 'materials', type: 'input' },
        { id: 'promptA', type: 'prompt' },
        { id: 'promptB', type: 'prompt' },
        { id: 'generate', type: 'generate' },
        { id: 'ready', type: 'output' },
      ],
      [
        { id: 'a1', source: 'materials', sourcePort: 'snapshot', target: 'promptA', targetPort: 'source' },
        { id: 'a2', source: 'materials', sourcePort: 'snapshot', target: 'promptB', targetPort: 'source' },
        { id: 'b1', source: 'promptA', sourcePort: 'prompt', target: 'generate', targetPort: 'prompt' },
        { id: 'b2', source: 'promptB', sourcePort: 'prompt', target: 'generate', targetPort: 'prompt' },
        { id: 'c', source: 'generate', sourcePort: 'image', target: 'ready', targetPort: 'result' },
      ],
    ),
    { code: 'INPUT_PORT_OCCUPIED', status: 422 },
  );

  assert.throws(
    () => validateWorkflowGraph(
      [
        { id: 'materials', type: 'input' },
        { id: 'prompt', type: 'prompt' },
        { id: 'ready', type: 'output' },
      ],
      [
        { id: 'a', source: 'materials', sourcePort: 'snapshot', target: 'prompt', targetPort: 'source' },
      ],
    ),
    { code: 'REQUIRED_PORT_UNCONNECTED', status: 422 },
  );
});

// ---- 模板与实例 ----

test('创建模板会规范化端口、锁定系统输入输出并写审计', async () => {
  const f = fixture();
  const result = await f.service.createTemplate({
    templateKey: 'custom-simple',
    name: '自定义白底模板',
    taskType: 'white',
    ...rawWhiteGraph({ modelId: 'test:image' }),
  }, { workspaceId: 'local' });

  assert.equal(result.template.version, 1);
  assert.equal(result.template.templateKey, 'custom-simple');
  assert.deepEqual(result.template.lockedNodes, ['materials', 'ready']);
  assert.equal(result.template.ports.prompt.length, 3);
  assert.equal(result.template.nodes.find(node => node.id === 'generate').params.modelId, 'test:image');
  assert.equal(result.template.isSystem, false);
  assert.ok(f.audit.entries.some(entry => entry.action === 'workflow.template.created'));

  await assert.rejects(
    f.service.createTemplate({
      templateKey: 'custom-simple', name: '重复', taskType: 'white', ...rawWhiteGraph(),
    }, { workspaceId: 'local' }),
    { code: 'TEMPLATE_EXISTS', status: 409 },
  );
});

test('实例从模板深拷贝，草稿可保存但不可开跑，确认后方可运行', async () => {
  const draft = fixture();
  const created = await draft.service.createInstance(
    draft.projectId, draft.planVersion, draft.deliverable.id, {}, { workspaceId: 'local' },
  );
  assert.equal(created.instance.templateKey, 'system-white');
  assert.equal(created.instance.templateVersion, 1);
  assert.equal(created.planStatus, 'draft');
  assert.equal(created.runnable, false);
  assert.deepEqual(created.instance.lockedNodes, ['materials', 'ready']);
  const prompt = created.instance.nodes.find(node => node.id === 'prompt');
  assert.equal(prompt.params.prompt, draft.deliverable.promptText);
  assert.deepEqual(prompt.params.copy, draft.deliverable.copy);
  assert.ok(draft.audit.entries.some(entry => entry.action === 'workflow.instance.created'));

  await assert.rejects(
    draft.service.createInstance(
      draft.projectId, draft.planVersion, draft.deliverable.id, {}, { workspaceId: 'local' },
    ),
    { code: 'INSTANCE_EXISTS', status: 409 },
  );

  const confirmed = fixture({ planStatus: 'confirmed' });
  const runnable = await confirmed.service.createInstance(
    confirmed.projectId, confirmed.planVersion, confirmed.deliverable.id, {}, { workspaceId: 'local' },
  );
  assert.equal(runnable.planStatus, 'confirmed');
  assert.equal(runnable.runnable, true);
});

test('修改实例不影响模板，也不影响同一模板创建的其他实例', async () => {
  const f = fixture();
  const created = await f.service.createInstance(
    f.projectId, f.planVersion, f.deliverable.id, {}, { workspaceId: 'local' },
  );
  const branch = addBranch(created.instance.nodes, created.instance.edges, 'generate2');
  const updated = await f.service.updateInstance(created.instance.id, {
    nodes: branch.nodes,
    edges: branch.edges,
  }, { workspaceId: 'local', ifMatch: '"r1"' });
  assert.equal(updated.instance.revision, 2);
  assert.equal(updated.instance.nodes.length, 5);

  const template = await f.repository.getTemplate('system-white', 1);
  assert.equal(template.nodes.length, 4);
  assert.equal(template.edges.length, 3);

  const other = makeDeliverable();
  const otherProject = randomUUID();
  f.projects.set({ projectId: otherProject, planStatus: 'draft', deliverable: other });
  const second = await f.service.createInstance(
    otherProject, 1, other.id, {}, { workspaceId: 'local' },
  );
  assert.equal(second.instance.nodes.length, 4);
  assert.equal(second.instance.edges.length, 3);
  assert.equal(f.audit.entries.some(entry => entry.action === 'workflow.instance.updated'), true);
});

test('JSONB 往返重排端口对象键后，锁定校验仍按语义比较', async () => {
  const f = fixture();
  const created = await f.service.createInstance(
    f.projectId, f.planVersion, f.deliverable.id, {}, { workspaceId: 'local' },
  );
  // PostgreSQL JSONB 会按自己的规则重排对象键；模拟读回后的端口键顺序。
  const stored = f.repository.instances.get(created.instance.id);
  for (const node of stored.nodes) {
    node.ports = node.ports.map(port => ({
      required: port.required, type: port.type, direction: port.direction, id: port.id,
    }));
  }
  const branch = addBranch(created.instance.nodes, created.instance.edges, 'generate2');
  const updated = await f.service.updateInstance(created.instance.id, {
    nodes: branch.nodes, edges: branch.edges,
  }, { workspaceId: 'local', ifMatch: '"r1"' });
  assert.equal(updated.instance.revision, 2);
});

test('锁定节点不可删除、不可改类型，锁定边不可断开，并记录失败审计', async () => {
  const f = fixture();
  const created = await f.service.createInstance(
    f.projectId, f.planVersion, f.deliverable.id, {}, { workspaceId: 'local' },
  );
  const instanceId = created.instance.id;
  const original = created.instance;

  await assert.rejects(
    f.service.updateInstance(instanceId, {
      nodes: original.nodes.filter(node => node.id !== 'materials'),
      edges: original.edges,
    }, { workspaceId: 'local', ifMatch: '"r1"' }),
    { code: 'LOCKED_NODE_PROTECTED', status: 409 },
  );

  await assert.rejects(
    f.service.updateInstance(instanceId, {
      nodes: original.nodes.map(node => (node.id === 'materials' ? { ...node, type: 'prompt' } : node)),
      edges: original.edges,
    }, { workspaceId: 'local', ifMatch: '"r1"' }),
    { code: 'LOCKED_NODE_PROTECTED', status: 409 },
  );

  await assert.rejects(
    f.service.updateInstance(instanceId, {
      nodes: original.nodes,
      edges: original.edges.filter(edge => edge.id !== 'edge-materials-prompt'),
    }, { workspaceId: 'local', ifMatch: '"r1"' }),
    { code: 'LOCKED_EDGE_PROTECTED', status: 409 },
  );

  const after = await f.service.getInstance(instanceId, { workspaceId: 'local' });
  assert.equal(after.instance.revision, 1);
  const failures = f.audit.entries.filter(entry => entry.action === 'workflow.instance.locked_violation');
  assert.equal(failures.length, 3);
  assert.ok(failures.every(entry => entry.result === 'failure'));
});

test('另存模板只追加版本，旧版本与实例互不影响', async () => {
  const f = fixture();
  const created = await f.service.createInstance(
    f.projectId, f.planVersion, f.deliverable.id, {}, { workspaceId: 'local' },
  );
  const branch = addBranch(created.instance.nodes, created.instance.edges, 'generate2');
  await f.service.updateInstance(created.instance.id, {
    nodes: branch.nodes, edges: branch.edges,
  }, { workspaceId: 'local', ifMatch: '"r1"' });

  const saved = await f.service.saveInstanceAsTemplate(created.instance.id, {
    templateKey: 'custom-from-instance',
    name: '实例另存模板',
  }, { workspaceId: 'local', ifMatch: '"r2"' });
  assert.equal(saved.template.version, 1);
  assert.equal(saved.template.nodes.length, 5);
  assert.equal(saved.template.isSystem, false);

  const more = addBranch(branch.nodes, branch.edges, 'generate3');
  await f.service.updateInstance(created.instance.id, {
    nodes: more.nodes, edges: more.edges,
  }, { workspaceId: 'local', ifMatch: '"r2"' });

  const second = await f.service.saveInstanceAsTemplate(created.instance.id, {
    templateKey: 'custom-from-instance',
    name: '实例另存模板 v2',
  }, { workspaceId: 'local', ifMatch: '"r3"' });
  assert.equal(second.template.version, 2);
  assert.equal(second.template.nodes.length, 6);

  const versions = await f.service.listTemplateVersions('custom-from-instance', { workspaceId: 'local' });
  assert.deepEqual(versions.versions.map(row => row.version), [2, 1]);
  assert.equal(versions.versions.find(row => row.version === 1).nodes.length, 5);
  assert.equal((await f.repository.getTemplate('system-white', 1)).nodes.length, 4);

  await assert.rejects(
    f.service.saveInstanceAsTemplate(created.instance.id, { templateKey: 'custom-x' }, { workspaceId: 'local' }),
    { code: 'REVISION_REQUIRED', status: 428 },
  );
  await assert.rejects(
    f.service.saveInstanceAsTemplate(created.instance.id, { templateKey: 'custom-x' }, {
      workspaceId: 'local', ifMatch: '"r1"',
    }),
    { code: 'REVISION_CONFLICT', status: 409 },
  );
  await assert.rejects(
    f.service.saveInstanceAsTemplate(created.instance.id, { templateKey: 'system-white' }, {
      workspaceId: 'local', ifMatch: '"r3"',
    }),
    { code: 'SYSTEM_TEMPLATE_PROTECTED', status: 403 },
  );
});

test('停用/不存在的模型不能出现在新模板或新实例；已有实例保留模型快照', async () => {
  const f = fixture();
  await assert.rejects(
    f.service.createTemplate({
      templateKey: 'custom-disabled',
      name: '停用模型模板',
      taskType: 'white',
      ...rawWhiteGraph({ modelId: 'test:disabled' }),
    }, { workspaceId: 'local' }),
    { code: 'MODEL_DISABLED', status: 422 },
  );
  await assert.rejects(
    f.service.createTemplate({
      templateKey: 'custom-missing',
      name: '未知模型模板',
      taskType: 'white',
      ...rawWhiteGraph({ modelId: 'test:missing' }),
    }, { workspaceId: 'local' }),
    { code: 'MODEL_NOT_FOUND', status: 422 },
  );

  const template = await f.service.createTemplate({
    templateKey: 'custom-model',
    name: '可用模型模板',
    taskType: 'white',
    ...rawWhiteGraph({ modelId: 'test:image' }),
  }, { workspaceId: 'local' });
  const instance = await f.service.createInstance(
    f.projectId, f.planVersion, f.deliverable.id, { templateKey: template.template.templateKey },
    { workspaceId: 'local' },
  );
  assert.equal(
    instance.instance.nodes.find(node => node.id === 'generate').params.modelId,
    'test:image',
  );

  // 模板里已有的模型停用后，新实例必须拒绝。
  const second = fixture();
  const custom = await second.service.createTemplate({
    templateKey: 'custom-model-2',
    name: '待停用模型模板',
    taskType: 'white',
    ...rawWhiteGraph({ modelId: 'test:image' }),
  }, { workspaceId: 'local' });
  second.models.rows.get('test:image').enabled = false;
  await assert.rejects(
    second.service.createInstance(
      second.projectId, second.planVersion, second.deliverable.id,
      { templateKey: custom.template.templateKey }, { workspaceId: 'local' },
    ),
    { code: 'MODEL_DISABLED', status: 422 },
  );

  // 已存在实例保留模型快照：改提示词不因模型后来停用而失败，但不能新引入停用模型。
  f.models.rows.get('test:image').enabled = false;
  const prompt = instance.instance.nodes.find(node => node.id === 'prompt');
  const patched = await f.service.updateInstance(instance.instance.id, {
    nodes: instance.instance.nodes.map(node => (node.id === 'prompt'
      ? { ...node, params: { ...node.params, prompt: '新的提示词' } }
      : node)),
    edges: instance.instance.edges,
  }, { workspaceId: 'local', ifMatch: '"r1"' });
  assert.equal(patched.instance.nodes.find(node => node.id === 'generate').params.modelId, 'test:image');
  assert.equal(prompt.params.prompt, f.deliverable.promptText);

  await assert.rejects(
    f.service.updateInstance(instance.instance.id, {
      nodes: patched.instance.nodes.map(node => (node.id === 'generate'
        ? { ...node, params: { ...node.params, modelId: 'test:disabled' } }
        : node)),
      edges: patched.instance.edges,
    }, { workspaceId: 'local', ifMatch: '"r2"' }),
    { code: 'MODEL_DISABLED', status: 422 },
  );
});

test('实例创建校验项目、交付项、工作区、模板类型与停用状态', async () => {
  const f = fixture();
  await assert.rejects(
    f.service.createInstance(f.projectId, 1, randomUUID(), {}, { workspaceId: 'local' }),
    { code: 'PROJECT_NOT_FOUND', status: 404 },
  );
  await assert.rejects(
    f.service.createInstance(f.projectId, 1, f.deliverable.id, {}, { workspaceId: 'other-workspace' }),
    { code: 'FORBIDDEN', status: 403 },
  );
  await assert.rejects(
    f.service.createInstance(
      f.projectId, 1, f.deliverable.id, { templateKey: 'system-scene' }, { workspaceId: 'local' },
    ),
    { code: 'TEMPLATE_TYPE_MISMATCH', status: 422 },
  );

  const scene = fixture({ deliverable: makeDeliverable('scene') });
  const sceneTemplate = await scene.repository.getTemplate('system-scene', 1);
  scene.repository.templates.push({
    ...clone(sceneTemplate),
    id: randomUUID(),
    templateKey: 'custom-disabled-template',
    status: 'disabled',
    isSystem: false,
  });
  await assert.rejects(
    scene.service.createInstance(
      scene.projectId, 1, scene.deliverable.id,
      { templateKey: 'custom-disabled-template' }, { workspaceId: 'local' },
    ),
    { code: 'TEMPLATE_DISABLED', status: 409 },
  );

  await assert.rejects(
    f.service.createTemplate({
      templateKey: 'custom-video', name: '视频', taskType: 'video', ...rawWhiteGraph(),
    }, { workspaceId: 'local' }),
    { code: 'INVALID_TASK_TYPE', status: 422 },
  );
});

// ---- HTTP：自动发现、ETag 与角色 ----

async function startServer(options) {
  const server = createServer({
    store: {}, assets: {}, registry: {}, service: {}, channels: null,
    port: 0, root: new URL('../', import.meta.url), ...options,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('HTTP 路由自动发现、ETag 428/409 与模板/实例接口', async t => {
  const f = fixture();
  const { server, base } = await startServer({ workflow: f.service });
  t.after(() => new Promise(resolve => server.close(resolve)));

  const types = await fetch(`${base}/api/task-types`);
  assert.equal(types.status, 200);
  const library = await types.json();
  assert.deepEqual(library.types.map(item => item.typeKey), [...TASK_TYPE_KEYS]);

  const templates = await fetch(`${base}/api/workflow-templates`);
  assert.equal(templates.status, 200);
  const listed = await templates.json();
  assert.equal(listed.templates.some(item => item.templateKey === 'system-white'), true);

  const session = await (await fetch(`${base}/api/session`)).json();
  const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken };

  const noToken = await fetch(`${base}/api/workflow-templates`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ templateKey: 'custom-http', name: 'HTTP 模板', taskType: 'white', ...rawWhiteGraph() }),
  });
  assert.equal(noToken.status, 403);

  const createdTemplate = await fetch(`${base}/api/workflow-templates`, {
    method: 'POST', headers,
    body: JSON.stringify({ templateKey: 'custom-http', name: 'HTTP 模板', taskType: 'white', ...rawWhiteGraph() }),
  });
  assert.equal(createdTemplate.status, 201);

  const created = await fetch(
    `${base}/api/projects/${f.projectId}/plans/1/deliverables/${f.deliverable.id}/workflow`,
    { method: 'POST', headers, body: JSON.stringify({}) },
  );
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('etag'), '"r1"');
  const createdBody = await created.json();
  const instance = createdBody.instance;

  const missing = await fetch(`${base}/api/workflow-instances/${instance.id}`, {
    method: 'PATCH', headers,
    body: JSON.stringify({ nodes: instance.nodes, edges: instance.edges }),
  });
  assert.equal(missing.status, 428);
  assert.equal((await missing.json()).error.code, 'REVISION_REQUIRED');

  const stale = await fetch(`${base}/api/workflow-instances/${instance.id}`, {
    method: 'PATCH', headers: { ...headers, 'If-Match': '"r9"' },
    body: JSON.stringify({ nodes: instance.nodes, edges: instance.edges }),
  });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, 'REVISION_CONFLICT');

  const branch = addBranch(instance.nodes, instance.edges, 'generate2');
  const patched = await fetch(`${base}/api/workflow-instances/${instance.id}`, {
    method: 'PATCH', headers: { ...headers, 'If-Match': '"r1"' },
    body: JSON.stringify({ nodes: branch.nodes, edges: branch.edges }),
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.headers.get('etag'), '"r2"');

  const getInstance = await fetch(`${base}/api/workflow-instances/${instance.id}`);
  assert.equal(getInstance.status, 200);
  assert.equal(getInstance.headers.get('etag'), '"r2"');

  const byDeliverable = await fetch(
    `${base}/api/projects/${f.projectId}/plans/1/deliverables/${f.deliverable.id}/workflow`,
  );
  assert.equal(byDeliverable.status, 200);
  assert.equal(byDeliverable.headers.get('etag'), '"r2"');
  assert.equal((await byDeliverable.json()).instance.id, instance.id);

  const saveNoMatch = await fetch(`${base}/api/workflow-instances/${instance.id}/save-as-template`, {
    method: 'POST', headers, body: JSON.stringify({ templateKey: 'custom-http-save' }),
  });
  assert.equal(saveNoMatch.status, 428);

  const saved = await fetch(`${base}/api/workflow-instances/${instance.id}/save-as-template`, {
    method: 'POST', headers: { ...headers, 'If-Match': '"r2"' },
    body: JSON.stringify({ templateKey: 'custom-http-save', name: 'HTTP 另存' }),
  });
  assert.equal(saved.status, 201);
  const savedBody = await saved.json();
  assert.equal(savedBody.template.templateKey, 'custom-http-save');

  const versions = await fetch(`${base}/api/workflow-templates/custom-http-save/versions`);
  assert.equal(versions.status, 200);
  assert.equal((await versions.json()).versions.length, 1);
});

test('角色鉴权：查看者只读、运营可写、未登录 401', async t => {
  const f = fixture();
  const viewerId = randomUUID();
  const operatorId = randomUUID();
  const users = {
    'viewer-token': { id: viewerId, role: 'viewer', active: true, workspaceId: 'ws-view' },
    'operator-token': { id: operatorId, role: 'operator', active: true, workspaceId: 'ws-op' },
  };
  const auth = {
    async authenticate(token) {
      const user = users[token];
      return user ? { session: { tokenHash: token }, user } : null;
    },
  };
  const { server, base } = await startServer({ auth, workflow: f.service });
  t.after(() => new Promise(resolve => server.close(resolve)));

  const anonymous = await fetch(`${base}/api/task-types`);
  assert.equal(anonymous.status, 401);

  const viewerCookie = { Cookie: 'sj_session=viewer-token' };
  const viewerSession = await (await fetch(`${base}/api/session`, { headers: viewerCookie })).json();
  const viewerRead = await fetch(`${base}/api/task-types`, { headers: viewerCookie });
  assert.equal(viewerRead.status, 200);
  const viewerWrite = await fetch(`${base}/api/workflow-templates`, {
    method: 'POST',
    headers: { ...viewerCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': viewerSession.csrfToken },
    body: JSON.stringify({ templateKey: 'custom-viewer', name: '查看者', taskType: 'white', ...rawWhiteGraph() }),
  });
  assert.equal(viewerWrite.status, 403);

  const operatorCookie = { Cookie: 'sj_session=operator-token' };
  const operatorSession = await (await fetch(`${base}/api/session`, { headers: operatorCookie })).json();
  const operatorWrite = await fetch(`${base}/api/workflow-templates`, {
    method: 'POST',
    headers: { ...operatorCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': operatorSession.csrfToken },
    body: JSON.stringify({ templateKey: 'custom-operator', name: '运营', taskType: 'white', ...rawWhiteGraph() }),
  });
  assert.equal(operatorWrite.status, 201);
  const written = await operatorWrite.json();
  assert.equal(written.template.workspaceId, 'ws-op');
});


test('canvas positions persist in instances and templates; invalid coordinates are rejected', async () => {
  const f = fixture();
  const { instance } = await f.service.createInstance(f.projectId, f.planVersion, f.deliverable.id, {}, { workspaceId: 'local' });
  const nodes = instance.nodes.map(node => ({ ...node, position: { x: 240.5, y: -20 } }));
  const saved = await f.service.updateInstance(instance.id, { nodes }, { workspaceId: 'local', ifMatch: '"r1"' });
  assert.deepEqual(saved.instance.nodes[1].position, { x: 240.5, y: -20 });
  const template = await f.service.saveInstanceAsTemplate(instance.id, { name: 'Position template' }, { workspaceId: 'local', ifMatch: '"r2"' });
  assert.deepEqual(template.template.nodes[1].position, { x: 240.5, y: -20 });
  for (const position of [{ x: null, y: 0 }, { x: '20', y: 0 }, { x: 100001, y: 0 }, { x: 0, y: 0, z: 1 }]) {
    await assert.rejects(f.service.updateInstance(instance.id, { nodes: nodes.map(node => ({ ...node, position })) }, { workspaceId: 'local', ifMatch: '"r2"' }), { code: 'INVALID_NODE_POSITION' });
  }
  assert.equal((await f.service.getInstance(instance.id)).instance.revision, 2);
});

test('a canvas can insert an edit node before the locked output and persist its layout', async () => {
  const f = fixture();
  const { instance } = await f.service.createInstance(f.projectId, f.planVersion, f.deliverable.id, {}, { workspaceId: 'local' });
  const nodes = [...instance.nodes.map(node => ({ ...node })), {
    id: 'edit-1', type: 'edit', name: '改图', params: { modelId: 'test:image', instruction: '保持商品结构' },
    position: { x: 720, y: 24 },
  }];
  const edges = instance.edges.filter(edge => edge.target !== 'ready');
  edges.push(
    { id: 'edge-generate-edit', source: 'generate', sourcePort: 'image', target: 'edit-1', targetPort: 'source' },
    { id: 'edge-edit-ready', source: 'edit-1', sourcePort: 'image', target: 'ready', targetPort: 'result' },
  );
  const saved = await f.service.updateInstance(instance.id, { nodes, edges }, { workspaceId: 'local', ifMatch: '"r1"' });
  assert.equal(saved.instance.nodes.find(node => node.id === 'edit-1').params.instruction, '保持商品结构');
  assert.deepEqual(saved.instance.nodes.find(node => node.id === 'edit-1').position, { x: 720, y: 24 });
  assert.equal(saved.instance.edges.some(edge => edge.target === 'ready' && edge.source === 'edit-1'), true);
  f.repository.startedInstances.add(instance.id);
  await assert.rejects(
    f.service.updateInstance(instance.id, { nodes: saved.instance.nodes, edges: saved.instance.edges }, { workspaceId: 'local', ifMatch: '"r2"' }),
    { code: 'INSTANCE_FROZEN', status: 409 },
  );
});
