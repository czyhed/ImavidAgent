-- 质检审核、撤销与冻结版本（Issue #17 / FLOW-10、ACC-10）。
--
-- 一张表：
--   sj_deliverable_reviews  每个交付项的逐次人工审核记录。审核只针对当前候选版本；
--                           四个检查项（商品保真 / 文字 / 尺寸 / 排版）各自记录
--                           pending / passed / issue。四项全部 passed 才能通过；
--                           数据库 CHECK 与触发器提供兜底，服务层仍先做同样的校验。
--                           审核通过写入审核人 / 时间并冻结对应版本；撤销必须填写理由，
--                           解除批准、把交付项退回第 04 步，但保留全部历史记录。
--
-- 冻结：
--   通过时 sj_deliverable_versions.status 变为 approved。新增触发器禁止已批准版本
--   离开 approved（除非事务内显式设置 sj.review.revoke='on' 的撤销操作），0014 的
--   内容不可变 / 禁止删除触发器继续生效。

CREATE TABLE IF NOT EXISTS sj_deliverable_reviews (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL DEFAULT 'local',
  project_id uuid NOT NULL REFERENCES sj_projects (id) ON DELETE CASCADE,
  plan_version integer NOT NULL,
  deliverable_id uuid NOT NULL,
  -- 审核绑定的具体版本；版本内容不可变，因此同时保留版本号快照便于审计与展示。
  version_id uuid NOT NULL REFERENCES sj_deliverable_versions (id) ON DELETE RESTRICT,
  version_number integer NOT NULL,
  status text NOT NULL DEFAULT 'in_review',
  -- 四个检查项的逐项结果：pending 未处理 / passed 通过 / issue 仍存在问题。
  fidelity_result text NOT NULL DEFAULT 'pending',
  text_result text NOT NULL DEFAULT 'pending',
  size_result text NOT NULL DEFAULT 'pending',
  layout_result text NOT NULL DEFAULT 'pending',
  -- 每项可选备注，只允许四个检查项键；不记录密钥或完整提示词。
  notes jsonb NOT NULL DEFAULT '{}'::jsonb,
  reviewed_by text,
  reviewed_at timestamptz,
  revoke_reason text,
  revoked_by text,
  revoked_at timestamptz,
  -- 审核记录级乐观锁：ETag "r<revision>" + If-Match，缺失 428 / 过期 409。
  revision integer NOT NULL DEFAULT 1,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sj_deliverable_reviews_plan_positive CHECK (plan_version >= 1),
  CONSTRAINT sj_deliverable_reviews_version_positive CHECK (version_number >= 1),
  CONSTRAINT sj_deliverable_reviews_revision_positive CHECK (revision >= 1),
  CONSTRAINT sj_deliverable_reviews_status_valid CHECK (status IN (
    'in_review', 'approved', 'revoked'
  )),
  CONSTRAINT sj_deliverable_reviews_fidelity_valid CHECK (
    fidelity_result IN ('pending', 'passed', 'issue')
  ),
  CONSTRAINT sj_deliverable_reviews_text_valid CHECK (
    text_result IN ('pending', 'passed', 'issue')
  ),
  CONSTRAINT sj_deliverable_reviews_size_valid CHECK (
    size_result IN ('pending', 'passed', 'issue')
  ),
  CONSTRAINT sj_deliverable_reviews_layout_valid CHECK (
    layout_result IN ('pending', 'passed', 'issue')
  ),
  CONSTRAINT sj_deliverable_reviews_notes_object CHECK (jsonb_typeof(notes) = 'object'),
  -- 通过门禁：任何 approved 行必须四项全部 passed。数据库层阻止未完成检查项通过。
  CONSTRAINT sj_deliverable_reviews_approved_checks_complete CHECK (
    status <> 'approved' OR (
      fidelity_result = 'passed' AND text_result = 'passed'
      AND size_result = 'passed' AND layout_result = 'passed'
    )
  ),
  CONSTRAINT sj_deliverable_reviews_approved_meta CHECK (
    status <> 'approved' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  ),
  CONSTRAINT sj_deliverable_reviews_revoke_reason_length CHECK (
    revoke_reason IS NULL OR char_length(revoke_reason) BETWEEN 1 AND 500
  ),
  CONSTRAINT sj_deliverable_reviews_revoked_meta CHECK (
    status <> 'revoked' OR (
      revoke_reason IS NOT NULL AND char_length(revoke_reason) BETWEEN 1 AND 500
      AND revoked_by IS NOT NULL AND revoked_at IS NOT NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS sj_deliverable_reviews_deliverable
  ON sj_deliverable_reviews (workspace_id, project_id, plan_version, deliverable_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sj_deliverable_reviews_version
  ON sj_deliverable_reviews (version_id);
-- 同一交付项同时最多一条已通过记录；撤销后保留历史，再审核产生新记录。
CREATE UNIQUE INDEX IF NOT EXISTS sj_deliverable_reviews_active_unique
  ON sj_deliverable_reviews (workspace_id, project_id, plan_version, deliverable_id)
  WHERE status = 'approved';
-- 同一版本的待审核记录最多一条；重复发起返回原记录，不堆出多条。
CREATE UNIQUE INDEX IF NOT EXISTS sj_deliverable_reviews_open_unique
  ON sj_deliverable_reviews (workspace_id, project_id, plan_version, deliverable_id, version_id)
  WHERE status = 'in_review';

-- 审核记录只追加：归属与版本不可改；已通过记录只能撤销，检查项不可再修改；
-- 已撤销记录为终态；未通过的记录不能“撤销批准”。
CREATE OR REPLACE FUNCTION sj_deliverable_reviews_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '审核记录不可删除，请保留审核历史';
  END IF;
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.plan_version IS DISTINCT FROM OLD.plan_version
     OR NEW.deliverable_id IS DISTINCT FROM OLD.deliverable_id
     OR NEW.version_id IS DISTINCT FROM OLD.version_id
     OR NEW.version_number IS DISTINCT FROM OLD.version_number
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION '审核记录的归属、版本与创建信息不可修改';
  END IF;
  IF OLD.status = 'revoked' THEN
    RAISE EXCEPTION '已撤销的审核记录不可再修改';
  END IF;
  IF OLD.status = 'in_review' AND NEW.status = 'revoked' THEN
    RAISE EXCEPTION '未通过的审核不能撤销批准';
  END IF;
  IF OLD.status = 'approved' THEN
    IF NEW.status NOT IN ('approved', 'revoked') THEN
      RAISE EXCEPTION '已通过的审核只能撤销，不能退回检查或改判';
    END IF;
    IF NEW.fidelity_result IS DISTINCT FROM OLD.fidelity_result
       OR NEW.text_result IS DISTINCT FROM OLD.text_result
       OR NEW.size_result IS DISTINCT FROM OLD.size_result
       OR NEW.layout_result IS DISTINCT FROM OLD.layout_result
       OR NEW.notes IS DISTINCT FROM OLD.notes
       OR NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by
       OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at THEN
      RAISE EXCEPTION '已通过的审核检查项与审核人不可修改';
    END IF;
  END IF;
  IF NEW.status = 'in_review' AND (
       NEW.reviewed_by IS NOT NULL OR NEW.reviewed_at IS NOT NULL
       OR NEW.revoke_reason IS NOT NULL OR NEW.revoked_by IS NOT NULL
       OR NEW.revoked_at IS NOT NULL
     ) THEN
    RAISE EXCEPTION '待审核记录不能包含通过或撤销信息';
  END IF;
  IF NEW.status = 'approved' AND (
       NEW.revoke_reason IS NOT NULL OR NEW.revoked_by IS NOT NULL
       OR NEW.revoked_at IS NOT NULL
     ) THEN
    RAISE EXCEPTION '已通过的审核记录不能同时包含撤销信息';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sj_deliverable_reviews_guard ON sj_deliverable_reviews;
CREATE TRIGGER sj_deliverable_reviews_guard
  BEFORE UPDATE OR DELETE ON sj_deliverable_reviews
  FOR EACH ROW EXECUTE FUNCTION sj_deliverable_reviews_guard();

-- 通过即冻结版本：approved 版本不可离开该状态、不可改候选位、不可删除；
-- 只有同一事务内显式设置 sj.review.revoke='on' 的撤销流程可以解除批准。
CREATE OR REPLACE FUNCTION sj_deliverable_versions_approved_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '审核通过的版本不可删除';
  END IF;
  IF OLD.status = 'approved'
     AND (NEW.status IS DISTINCT FROM OLD.status
          OR NEW.is_candidate IS DISTINCT FROM OLD.is_candidate)
     AND coalesce(current_setting('sj.review.revoke', true), '') <> 'on' THEN
    RAISE EXCEPTION '审核通过的版本已冻结；如需返修请先撤销审核';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sj_deliverable_versions_approved_guard ON sj_deliverable_versions;
CREATE TRIGGER sj_deliverable_versions_approved_guard
  BEFORE UPDATE OR DELETE ON sj_deliverable_versions
  FOR EACH ROW EXECUTE FUNCTION sj_deliverable_versions_approved_guard();
