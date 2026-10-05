-- 工作流任务类型、版本化模板与交付项实例（Issue #13 / FLOW-14、FLOW-15、FLOW-16）。
--
-- 三层对象：
--   sj_task_types            稳定的交付项类型键（white / scene / selling / detail / extension），
--                            随代码版本化发布；每个类型带默认节点模板与默认模板键。
--   sj_workflow_templates    模板主体，按 (template_key, version) 追加版本；旧版本不可变，
--                            触发器拒绝删除与内容更新，只允许改 status（停用）。
--   sj_workflow_instances    一个交付项（sj_project_plans.deliverables 内的稳定 id）一份副本。
--                            节点/边/锁定集合是模板的深拷贝，模板后续改版不影响已有实例。
--
-- 端口方向与类型在服务层校验；数据库用 CHECK 兜底 JSON 形状与枚举。
-- 项目外键：0007 与 #12 的 0006 并行开发。若当前库已执行 0006（正常合并顺序如此），
-- 这里补上 ON DELETE CASCADE；若 0006 尚未存在，实例仍按 project_id 逻辑归属，
-- 迁移不会失败。合并 #12 后再执行新库迁移会得到完整外键。

CREATE TABLE IF NOT EXISTS sj_task_types (
  type_key text PRIMARY KEY,
  name text NOT NULL,
  purpose text,
  default_aspect_ratio text,
  default_template_key text NOT NULL,
  default_node_template jsonb NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sj_task_types_key_format CHECK (type_key ~ '^[a-z][a-z0-9_]{1,39}$'),
  CONSTRAINT sj_task_types_name_length CHECK (char_length(name) BETWEEN 1 AND 100),
  CONSTRAINT sj_task_types_version_positive CHECK (version >= 1),
  CONSTRAINT sj_task_types_default_object CHECK (jsonb_typeof(default_node_template) = 'object')
);

CREATE TABLE IF NOT EXISTS sj_workflow_templates (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL DEFAULT 'local',
  template_key text NOT NULL,
  name text NOT NULL,
  description text,
  task_type text NOT NULL REFERENCES sj_task_types (type_key) ON DELETE RESTRICT,
  version integer NOT NULL,
  nodes jsonb NOT NULL,
  edges jsonb NOT NULL,
  ports jsonb NOT NULL,
  locked_nodes jsonb NOT NULL,
  status text NOT NULL DEFAULT 'active',
  is_system boolean NOT NULL DEFAULT false,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sj_workflow_templates_key_format CHECK (template_key ~ '^[a-z][a-z0-9-]{1,63}$'),
  CONSTRAINT sj_workflow_templates_name_length CHECK (char_length(name) BETWEEN 1 AND 200),
  CONSTRAINT sj_workflow_templates_version_positive CHECK (version >= 1),
  CONSTRAINT sj_workflow_templates_status_valid CHECK (status IN ('active', 'disabled')),
  CONSTRAINT sj_workflow_templates_nodes_array CHECK (jsonb_typeof(nodes) = 'array'),
  CONSTRAINT sj_workflow_templates_edges_array CHECK (jsonb_typeof(edges) = 'array'),
  CONSTRAINT sj_workflow_templates_ports_object CHECK (jsonb_typeof(ports) = 'object'),
  CONSTRAINT sj_workflow_templates_locked_array CHECK (jsonb_typeof(locked_nodes) = 'array'),
  CONSTRAINT sj_workflow_templates_key_version UNIQUE (template_key, version)
);

CREATE INDEX IF NOT EXISTS sj_workflow_templates_task_type
  ON sj_workflow_templates (task_type, status, template_key, version DESC);
CREATE INDEX IF NOT EXISTS sj_workflow_templates_workspace
  ON sj_workflow_templates (workspace_id, task_type, template_key, version DESC);

-- 模板版本只追加：禁止 DELETE，禁止修改除 status 之外的任何列。
CREATE OR REPLACE FUNCTION sj_workflow_templates_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '工作流模板版本只追加，不能删除。';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.template_key IS DISTINCT FROM OLD.template_key
     OR NEW.name IS DISTINCT FROM OLD.name
     OR NEW.description IS DISTINCT FROM OLD.description
     OR NEW.task_type IS DISTINCT FROM OLD.task_type
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.nodes IS DISTINCT FROM OLD.nodes
     OR NEW.edges IS DISTINCT FROM OLD.edges
     OR NEW.ports IS DISTINCT FROM OLD.ports
     OR NEW.locked_nodes IS DISTINCT FROM OLD.locked_nodes
     OR NEW.is_system IS DISTINCT FROM OLD.is_system
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION '工作流模板版本不可变，请追加新版本。';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sj_workflow_templates_immutable ON sj_workflow_templates;
CREATE TRIGGER sj_workflow_templates_immutable
  BEFORE UPDATE OR DELETE ON sj_workflow_templates
  FOR EACH ROW EXECUTE FUNCTION sj_workflow_templates_append_only();

CREATE TABLE IF NOT EXISTS sj_workflow_instances (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL DEFAULT 'local',
  project_id uuid NOT NULL,
  -- 交付项保存在 sj_project_plans.deliverables JSON 的稳定 id；这里记录所属方案版本。
  plan_version integer NOT NULL,
  deliverable_id uuid NOT NULL,
  task_type text NOT NULL REFERENCES sj_task_types (type_key) ON DELETE RESTRICT,
  template_id uuid NOT NULL REFERENCES sj_workflow_templates (id) ON DELETE RESTRICT,
  template_key text NOT NULL,
  template_version integer NOT NULL,
  nodes jsonb NOT NULL,
  edges jsonb NOT NULL,
  ports jsonb NOT NULL,
  locked_nodes jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sj_workflow_instances_plan_version_positive CHECK (plan_version >= 1),
  CONSTRAINT sj_workflow_instances_template_version_positive CHECK (template_version >= 1),
  CONSTRAINT sj_workflow_instances_revision_positive CHECK (revision >= 1),
  CONSTRAINT sj_workflow_instances_nodes_array CHECK (jsonb_typeof(nodes) = 'array'),
  CONSTRAINT sj_workflow_instances_edges_array CHECK (jsonb_typeof(edges) = 'array'),
  CONSTRAINT sj_workflow_instances_ports_object CHECK (jsonb_typeof(ports) = 'object'),
  CONSTRAINT sj_workflow_instances_locked_array CHECK (jsonb_typeof(locked_nodes) = 'array'),
  -- 一个方案版本里的一个交付项只有一份工作流实例。
  CONSTRAINT sj_workflow_instances_deliverable UNIQUE (project_id, plan_version, deliverable_id)
);

CREATE INDEX IF NOT EXISTS sj_workflow_instances_workspace
  ON sj_workflow_instances (workspace_id, updated_at DESC, id);
CREATE INDEX IF NOT EXISTS sj_workflow_instances_project
  ON sj_workflow_instances (project_id, plan_version);
CREATE INDEX IF NOT EXISTS sj_workflow_instances_template
  ON sj_workflow_instances (template_key, template_version);

DO $$
BEGIN
  IF to_regclass('public.sj_projects') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'sj_workflow_instances_project_fk'
     ) THEN
    ALTER TABLE sj_workflow_instances
      ADD CONSTRAINT sj_workflow_instances_project_fk
      FOREIGN KEY (project_id) REFERENCES sj_projects (id) ON DELETE CASCADE;
  END IF;
END;
$$;

-- 任务类型库（FLOW-14）。默认节点模板与 system-* 模板保持一致：
-- 白底 / 场景 / 扩展建议：资料 → 提示词 → 生图 → 交付候选；
-- 卖点 / 细节：在生图后追加模板合成。
INSERT INTO sj_task_types
  (type_key, name, purpose, default_aspect_ratio, default_template_key, default_node_template, enabled, version)
VALUES
  (
    'white', '白底主图 / 多角度', '正面白底、侧面、背面等主图合规用途', '1:1', 'system-white',
    '{"nodes":[{"id":"materials","type":"input","name":"商品资料","params":{},"ports":[{"id":"snapshot","direction":"out","type":"data","required":true}]},{"id":"prompt","type":"prompt","name":"文本提示词","params":{"prompt":"","copy":[]},"ports":[{"id":"source","direction":"in","type":"data","required":true},{"id":"prompt","direction":"out","type":"text","required":true},{"id":"copy","direction":"out","type":"text","required":false}]},{"id":"generate","type":"generate","name":"生图","params":{"modelId":null,"aspectRatio":"1:1"},"ports":[{"id":"prompt","direction":"in","type":"text","required":true},{"id":"image","direction":"out","type":"image","required":true}]},{"id":"ready","type":"output","name":"交付候选","params":{},"ports":[{"id":"result","direction":"in","type":"image","required":true}]}],"edges":[{"id":"edge-materials-prompt","source":"materials","sourcePort":"snapshot","target":"prompt","targetPort":"source"},{"id":"edge-prompt-generate","source":"prompt","sourcePort":"prompt","target":"generate","targetPort":"prompt"},{"id":"edge-generate-ready","source":"generate","sourcePort":"image","target":"ready","targetPort":"result"}],"lockedNodes":["materials","ready"]}'::jsonb,
    true, 1
  ),
  (
    'scene', '场景图', '使用场景、氛围布景', '3:4', 'system-scene',
    '{"nodes":[{"id":"materials","type":"input","name":"商品资料","params":{},"ports":[{"id":"snapshot","direction":"out","type":"data","required":true}]},{"id":"prompt","type":"prompt","name":"文本提示词","params":{"prompt":"","copy":[]},"ports":[{"id":"source","direction":"in","type":"data","required":true},{"id":"prompt","direction":"out","type":"text","required":true},{"id":"copy","direction":"out","type":"text","required":false}]},{"id":"generate","type":"generate","name":"生图","params":{"modelId":null,"aspectRatio":"3:4"},"ports":[{"id":"prompt","direction":"in","type":"text","required":true},{"id":"image","direction":"out","type":"image","required":true}]},{"id":"ready","type":"output","name":"交付候选","params":{},"ports":[{"id":"result","direction":"in","type":"image","required":true}]}],"edges":[{"id":"edge-materials-prompt","source":"materials","sourcePort":"snapshot","target":"prompt","targetPort":"source"},{"id":"edge-prompt-generate","source":"prompt","sourcePort":"prompt","target":"generate","targetPort":"prompt"},{"id":"edge-generate-ready","source":"generate","sourcePort":"image","target":"ready","targetPort":"result"}],"lockedNodes":["materials","ready"]}'::jsonb,
    true, 1
  ),
  (
    'selling', '卖点 / 促销图', '无字底图 + 模板合成文案', '1:1', 'system-selling',
    '{"nodes":[{"id":"materials","type":"input","name":"商品资料","params":{},"ports":[{"id":"snapshot","direction":"out","type":"data","required":true}]},{"id":"prompt","type":"prompt","name":"文本提示词","params":{"prompt":"","copy":[]},"ports":[{"id":"source","direction":"in","type":"data","required":true},{"id":"prompt","direction":"out","type":"text","required":true},{"id":"copy","direction":"out","type":"text","required":false}]},{"id":"generate","type":"generate","name":"生图","params":{"modelId":null,"aspectRatio":"1:1"},"ports":[{"id":"prompt","direction":"in","type":"text","required":true},{"id":"image","direction":"out","type":"image","required":true}]},{"id":"composite","type":"composite","name":"模板合成","params":{"templateId":null},"ports":[{"id":"base","direction":"in","type":"image","required":true},{"id":"copy","direction":"in","type":"text","required":true},{"id":"image","direction":"out","type":"image","required":true}]},{"id":"ready","type":"output","name":"交付候选","params":{},"ports":[{"id":"result","direction":"in","type":"image","required":true}]}],"edges":[{"id":"edge-materials-prompt","source":"materials","sourcePort":"snapshot","target":"prompt","targetPort":"source"},{"id":"edge-prompt-generate","source":"prompt","sourcePort":"prompt","target":"generate","targetPort":"prompt"},{"id":"edge-generate-composite","source":"generate","sourcePort":"image","target":"composite","targetPort":"base"},{"id":"edge-prompt-composite","source":"prompt","sourcePort":"copy","target":"composite","targetPort":"copy"},{"id":"edge-composite-ready","source":"composite","sourcePort":"image","target":"ready","targetPort":"result"}],"lockedNodes":["materials","ready"]}'::jsonb,
    true, 1
  ),
  (
    'detail', '细节 / 尺寸 / 包装清单', '细节特写、尺寸标注、包装内容物等信息图', '3:4', 'system-detail',
    '{"nodes":[{"id":"materials","type":"input","name":"商品资料","params":{},"ports":[{"id":"snapshot","direction":"out","type":"data","required":true}]},{"id":"prompt","type":"prompt","name":"文本提示词","params":{"prompt":"","copy":[]},"ports":[{"id":"source","direction":"in","type":"data","required":true},{"id":"prompt","direction":"out","type":"text","required":true},{"id":"copy","direction":"out","type":"text","required":false}]},{"id":"generate","type":"generate","name":"生图","params":{"modelId":null,"aspectRatio":"3:4"},"ports":[{"id":"prompt","direction":"in","type":"text","required":true},{"id":"image","direction":"out","type":"image","required":true}]},{"id":"composite","type":"composite","name":"模板合成","params":{"templateId":null},"ports":[{"id":"base","direction":"in","type":"image","required":true},{"id":"copy","direction":"in","type":"text","required":true},{"id":"image","direction":"out","type":"image","required":true}]},{"id":"ready","type":"output","name":"交付候选","params":{},"ports":[{"id":"result","direction":"in","type":"image","required":true}]}],"edges":[{"id":"edge-materials-prompt","source":"materials","sourcePort":"snapshot","target":"prompt","targetPort":"source"},{"id":"edge-prompt-generate","source":"prompt","sourcePort":"prompt","target":"generate","targetPort":"prompt"},{"id":"edge-generate-composite","source":"generate","sourcePort":"image","target":"composite","targetPort":"base"},{"id":"edge-prompt-composite","source":"prompt","sourcePort":"copy","target":"composite","targetPort":"copy"},{"id":"edge-composite-ready","source":"composite","sourcePort":"image","target":"ready","targetPort":"result"}],"lockedNodes":["materials","ready"]}'::jsonb,
    true, 1
  ),
  (
    'extension', 'AI 扩展建议', '类型库外、AI 针对该商品提议的图', '1:1', 'system-extension',
    '{"nodes":[{"id":"materials","type":"input","name":"商品资料","params":{},"ports":[{"id":"snapshot","direction":"out","type":"data","required":true}]},{"id":"prompt","type":"prompt","name":"文本提示词","params":{"prompt":"","copy":[]},"ports":[{"id":"source","direction":"in","type":"data","required":true},{"id":"prompt","direction":"out","type":"text","required":true},{"id":"copy","direction":"out","type":"text","required":false}]},{"id":"generate","type":"generate","name":"生图","params":{"modelId":null,"aspectRatio":"1:1"},"ports":[{"id":"prompt","direction":"in","type":"text","required":true},{"id":"image","direction":"out","type":"image","required":true}]},{"id":"ready","type":"output","name":"交付候选","params":{},"ports":[{"id":"result","direction":"in","type":"image","required":true}]}],"edges":[{"id":"edge-materials-prompt","source":"materials","sourcePort":"snapshot","target":"prompt","targetPort":"source"},{"id":"edge-prompt-generate","source":"prompt","sourcePort":"prompt","target":"generate","targetPort":"prompt"},{"id":"edge-generate-ready","source":"generate","sourcePort":"image","target":"ready","targetPort":"result"}],"lockedNodes":["materials","ready"]}'::jsonb,
    true, 1
  )
ON CONFLICT (type_key) DO NOTHING;

INSERT INTO sj_workflow_templates
  (id, workspace_id, template_key, name, description, task_type, version, nodes, edges, ports, locked_nodes, status, is_system)
VALUES
  (
    '00000000-0000-4000-8000-000000000001', 'local', 'system-white', '白底主图默认工作流',
    '资料 → 提示词 → 生图 → 交付候选，输入与输出节点锁定。', 'white', 1,
    '[{"id":"materials","type":"input","name":"商品资料","params":{},"ports":[{"id":"snapshot","direction":"out","type":"data","required":true}]},{"id":"prompt","type":"prompt","name":"文本提示词","params":{"prompt":"","copy":[]},"ports":[{"id":"source","direction":"in","type":"data","required":true},{"id":"prompt","direction":"out","type":"text","required":true},{"id":"copy","direction":"out","type":"text","required":false}]},{"id":"generate","type":"generate","name":"生图","params":{"modelId":null,"aspectRatio":"1:1"},"ports":[{"id":"prompt","direction":"in","type":"text","required":true},{"id":"image","direction":"out","type":"image","required":true}]},{"id":"ready","type":"output","name":"交付候选","params":{},"ports":[{"id":"result","direction":"in","type":"image","required":true}]}]'::jsonb,
    '[{"id":"edge-materials-prompt","source":"materials","sourcePort":"snapshot","target":"prompt","targetPort":"source"},{"id":"edge-prompt-generate","source":"prompt","sourcePort":"prompt","target":"generate","targetPort":"prompt"},{"id":"edge-generate-ready","source":"generate","sourcePort":"image","target":"ready","targetPort":"result"}]'::jsonb,
    '{"materials":[{"id":"snapshot","direction":"out","type":"data","required":true}],"prompt":[{"id":"source","direction":"in","type":"data","required":true},{"id":"prompt","direction":"out","type":"text","required":true},{"id":"copy","direction":"out","type":"text","required":false}],"generate":[{"id":"prompt","direction":"in","type":"text","required":true},{"id":"image","direction":"out","type":"image","required":true}],"ready":[{"id":"result","direction":"in","type":"image","required":true}]}'::jsonb,
    '["materials","ready"]'::jsonb, 'active', true
  ),
  (
    '00000000-0000-4000-8000-000000000002', 'local', 'system-scene', '场景图默认工作流',
    '资料 → 提示词 → 生图 → 交付候选，画幅默认 3:4。', 'scene', 1,
    '[{"id":"materials","type":"input","name":"商品资料","params":{},"ports":[{"id":"snapshot","direction":"out","type":"data","required":true}]},{"id":"prompt","type":"prompt","name":"文本提示词","params":{"prompt":"","copy":[]},"ports":[{"id":"source","direction":"in","type":"data","required":true},{"id":"prompt","direction":"out","type":"text","required":true},{"id":"copy","direction":"out","type":"text","required":false}]},{"id":"generate","type":"generate","name":"生图","params":{"modelId":null,"aspectRatio":"3:4"},"ports":[{"id":"prompt","direction":"in","type":"text","required":true},{"id":"image","direction":"out","type":"image","required":true}]},{"id":"ready","type":"output","name":"交付候选","params":{},"ports":[{"id":"result","direction":"in","type":"image","required":true}]}]'::jsonb,
    '[{"id":"edge-materials-prompt","source":"materials","sourcePort":"snapshot","target":"prompt","targetPort":"source"},{"id":"edge-prompt-generate","source":"prompt","sourcePort":"prompt","target":"generate","targetPort":"prompt"},{"id":"edge-generate-ready","source":"generate","sourcePort":"image","target":"ready","targetPort":"result"}]'::jsonb,
    '{"materials":[{"id":"snapshot","direction":"out","type":"data","required":true}],"prompt":[{"id":"source","direction":"in","type":"data","required":true},{"id":"prompt","direction":"out","type":"text","required":true},{"id":"copy","direction":"out","type":"text","required":false}],"generate":[{"id":"prompt","direction":"in","type":"text","required":true},{"id":"image","direction":"out","type":"image","required":true}],"ready":[{"id":"result","direction":"in","type":"image","required":true}]}'::jsonb,
    '["materials","ready"]'::jsonb, 'active', true
  ),
  (
    '00000000-0000-4000-8000-000000000003', 'local', 'system-selling', '卖点图默认工作流',
    '资料 → 提示词 → 生图 → 模板合成 → 交付候选。', 'selling', 1,
    '[{"id":"materials","type":"input","name":"商品资料","params":{},"ports":[{"id":"snapshot","direction":"out","type":"data","required":true}]},{"id":"prompt","type":"prompt","name":"文本提示词","params":{"prompt":"","copy":[]},"ports":[{"id":"source","direction":"in","type":"data","required":true},{"id":"prompt","direction":"out","type":"text","required":true},{"id":"copy","direction":"out","type":"text","required":false}]},{"id":"generate","type":"generate","name":"生图","params":{"modelId":null,"aspectRatio":"1:1"},"ports":[{"id":"prompt","direction":"in","type":"text","required":true},{"id":"image","direction":"out","type":"image","required":true}]},{"id":"composite","type":"composite","name":"模板合成","params":{"templateId":null},"ports":[{"id":"base","direction":"in","type":"image","required":true},{"id":"copy","direction":"in","type":"text","required":true},{"id":"image","direction":"out","type":"image","required":true}]},{"id":"ready","type":"output","name":"交付候选","params":{},"ports":[{"id":"result","direction":"in","type":"image","required":true}]}]'::jsonb,
    '[{"id":"edge-materials-prompt","source":"materials","sourcePort":"snapshot","target":"prompt","targetPort":"source"},{"id":"edge-prompt-generate","source":"prompt","sourcePort":"prompt","target":"generate","targetPort":"prompt"},{"id":"edge-generate-composite","source":"generate","sourcePort":"image","target":"composite","targetPort":"base"},{"id":"edge-prompt-composite","source":"prompt","sourcePort":"copy","target":"composite","targetPort":"copy"},{"id":"edge-composite-ready","source":"composite","sourcePort":"image","target":"ready","targetPort":"result"}]'::jsonb,
    '{"materials":[{"id":"snapshot","direction":"out","type":"data","required":true}],"prompt":[{"id":"source","direction":"in","type":"data","required":true},{"id":"prompt","direction":"out","type":"text","required":true},{"id":"copy","direction":"out","type":"text","required":false}],"generate":[{"id":"prompt","direction":"in","type":"text","required":true},{"id":"image","direction":"out","type":"image","required":true}],"composite":[{"id":"base","direction":"in","type":"image","required":true},{"id":"copy","direction":"in","type":"text","required":true},{"id":"image","direction":"out","type":"image","required":true}],"ready":[{"id":"result","direction":"in","type":"image","required":true}]}'::jsonb,
    '["materials","ready"]'::jsonb, 'active', true
  ),
  (
    '00000000-0000-4000-8000-000000000004', 'local', 'system-detail', '细节图默认工作流',
    '资料 → 提示词 → 生图 → 模板合成 → 交付候选，画幅默认 3:4。', 'detail', 1,
    '[{"id":"materials","type":"input","name":"商品资料","params":{},"ports":[{"id":"snapshot","direction":"out","type":"data","required":true}]},{"id":"prompt","type":"prompt","name":"文本提示词","params":{"prompt":"","copy":[]},"ports":[{"id":"source","direction":"in","type":"data","required":true},{"id":"prompt","direction":"out","type":"text","required":true},{"id":"copy","direction":"out","type":"text","required":false}]},{"id":"generate","type":"generate","name":"生图","params":{"modelId":null,"aspectRatio":"3:4"},"ports":[{"id":"prompt","direction":"in","type":"text","required":true},{"id":"image","direction":"out","type":"image","required":true}]},{"id":"composite","type":"composite","name":"模板合成","params":{"templateId":null},"ports":[{"id":"base","direction":"in","type":"image","required":true},{"id":"copy","direction":"in","type":"text","required":true},{"id":"image","direction":"out","type":"image","required":true}]},{"id":"ready","type":"output","name":"交付候选","params":{},"ports":[{"id":"result","direction":"in","type":"image","required":true}]}]'::jsonb,
    '[{"id":"edge-materials-prompt","source":"materials","sourcePort":"snapshot","target":"prompt","targetPort":"source"},{"id":"edge-prompt-generate","source":"prompt","sourcePort":"prompt","target":"generate","targetPort":"prompt"},{"id":"edge-generate-composite","source":"generate","sourcePort":"image","target":"composite","targetPort":"base"},{"id":"edge-prompt-composite","source":"prompt","sourcePort":"copy","target":"composite","targetPort":"copy"},{"id":"edge-composite-ready","source":"composite","sourcePort":"image","target":"ready","targetPort":"result"}]'::jsonb,
    '{"materials":[{"id":"snapshot","direction":"out","type":"data","required":true}],"prompt":[{"id":"source","direction":"in","type":"data","required":true},{"id":"prompt","direction":"out","type":"text","required":true},{"id":"copy","direction":"out","type":"text","required":false}],"generate":[{"id":"prompt","direction":"in","type":"text","required":true},{"id":"image","direction":"out","type":"image","required":true}],"composite":[{"id":"base","direction":"in","type":"image","required":true},{"id":"copy","direction":"in","type":"text","required":true},{"id":"image","direction":"out","type":"image","required":true}],"ready":[{"id":"result","direction":"in","type":"image","required":true}]}'::jsonb,
    '["materials","ready"]'::jsonb, 'active', true
  ),
  (
    '00000000-0000-4000-8000-000000000005', 'local', 'system-extension', 'AI 扩展建议默认工作流',
    '类型库外建议的通用模板：资料 → 提示词 → 生图 → 交付候选。', 'extension', 1,
    '[{"id":"materials","type":"input","name":"商品资料","params":{},"ports":[{"id":"snapshot","direction":"out","type":"data","required":true}]},{"id":"prompt","type":"prompt","name":"文本提示词","params":{"prompt":"","copy":[]},"ports":[{"id":"source","direction":"in","type":"data","required":true},{"id":"prompt","direction":"out","type":"text","required":true},{"id":"copy","direction":"out","type":"text","required":false}]},{"id":"generate","type":"generate","name":"生图","params":{"modelId":null,"aspectRatio":"1:1"},"ports":[{"id":"prompt","direction":"in","type":"text","required":true},{"id":"image","direction":"out","type":"image","required":true}]},{"id":"ready","type":"output","name":"交付候选","params":{},"ports":[{"id":"result","direction":"in","type":"image","required":true}]}]'::jsonb,
    '[{"id":"edge-materials-prompt","source":"materials","sourcePort":"snapshot","target":"prompt","targetPort":"source"},{"id":"edge-prompt-generate","source":"prompt","sourcePort":"prompt","target":"generate","targetPort":"prompt"},{"id":"edge-generate-ready","source":"generate","sourcePort":"image","target":"ready","targetPort":"result"}]'::jsonb,
    '{"materials":[{"id":"snapshot","direction":"out","type":"data","required":true}],"prompt":[{"id":"source","direction":"in","type":"data","required":true},{"id":"prompt","direction":"out","type":"text","required":true},{"id":"copy","direction":"out","type":"text","required":false}],"generate":[{"id":"prompt","direction":"in","type":"text","required":true},{"id":"image","direction":"out","type":"image","required":true}],"ready":[{"id":"result","direction":"in","type":"image","required":true}]}'::jsonb,
    '["materials","ready"]'::jsonb, 'active', true
  )
ON CONFLICT (template_key, version) DO NOTHING;
