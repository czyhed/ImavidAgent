import { useEffect, useState } from 'react';
import { Header } from './ReviewUI.jsx';
import { Btn, Tag } from './ui.jsx';
import { isAuthEnabled } from '../lib/auth.js';
import {
  auditExportUrl, auditObjectLabel, createUser, formatCents, formatDateTime, formatPriceUnit,
  getBillingLedger, getBillingPrices, getBillingSummary, ledgerAmount, ledgerTypeLabel,
  listAuditLogs, listUsers, postBillingAdjustment, RESULT_LABELS, roleLabel,
  saveBillingPrice, UNIT_LABELS, unitLabel, updateUser,
} from '../lib/system-api.js';

const TABS = [['users', '用户与权限'], ['billing', '账单与额度'], ['logs', '日志'], ['models', '模型中心'], ['security', '安全与说明']];
const ROLES = [['admin', '管理员'], ['operator', '运营'], ['viewer', '只读']];
const CAPABILITIES = [['image.generate', '图像生成'], ['image.edit', '图像改图'], ['text.chat', '文本对话'], ['vision.analyze', '视觉识别']];
const PAGE_SIZE = 20;

export default function System({ notify, openDialog, closeDialog, setDialogMessage, onOpenRealSystem, canAdmin = true, backend }) {
  const [tab, setTab] = useState('users');
  const apiCall = backend?.apiCall;
  const session = backend?.session;
  const authOn = isAuthEnabled(session);
  const me = session?.user || null;

  return <section className="view rv" data-view="review">
    <Header
      title="系统管理"
      desc="成员、账本与审计日志读取服务端真实数据；前端按角色隐藏写入口，服务端仍逐接口鉴权。"
    />
    <div className="rv-tabs" style={{ marginBottom: 24 }}>{TABS.map(([key, label]) => <button key={key} type="button" className={tab === key ? 'active' : ''} data-rv="system-tab" data-id={key} onClick={() => setTab(key)}>{label}</button>)}</div>
    {tab === 'users'
      ? <Users apiCall={apiCall} authOn={authOn} canAdmin={canAdmin} me={me} notify={notify} openDialog={openDialog} closeDialog={closeDialog} setDialogMessage={setDialogMessage} />
      : tab === 'billing'
        ? <Billing apiCall={apiCall} canAdmin={canAdmin} notify={notify} openDialog={openDialog} closeDialog={closeDialog} setDialogMessage={setDialogMessage} />
        : tab === 'logs'
          ? <Logs apiCall={apiCall} />
          : tab === 'models'
            ? <Models apiCall={apiCall} canAdmin={canAdmin} notify={notify} openDialog={openDialog} closeDialog={closeDialog} setDialogMessage={setDialogMessage} onOpenRealSystem={onOpenRealSystem} />
            : <Security authOn={authOn} me={me} canAdmin={canAdmin} />}
  </section>;
}

export function Users({ apiCall, authOn, canAdmin, me, notify, openDialog, closeDialog, setDialogMessage }) {
  const [state, setState] = useState({ loading: false, error: '', users: [] });
  const [reloadKey, setReloadKey] = useState(0);
  const canRead = authOn && canAdmin;

  useEffect(() => {
    let active = true;
    if (!canRead) {
      setState({ loading: false, error: '', users: [] });
      return () => { active = false; };
    }
    if (!apiCall) {
      setState({ loading: false, error: '后端连接不可用，暂时无法读取成员。', users: [] });
      return () => { active = false; };
    }
    setState(previous => ({ ...previous, loading: true, error: '' }));
    listUsers(apiCall)
      .then(result => { if (active) setState({ loading: false, error: '', users: result.users || [] }); })
      .catch(error => { if (active) setState({ loading: false, error: error.message || '成员列表读取失败。', users: [] }); });
    return () => { active = false; };
  }, [apiCall, canRead, reloadKey]);

  const refresh = () => setReloadKey(value => value + 1);

  function openCreate() {
    openDialog('新增成员', <form id="rv-user-form" className="rv" onSubmit={async event => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const body = {
        email: String(form.get('email') || '').trim(),
        displayName: String(form.get('displayName') || '').trim(),
        role: String(form.get('role') || 'operator'),
        password: String(form.get('password') || ''),
      };
      try {
        await createUser(apiCall, body);
        closeDialog();
        refresh();
        notify('成员已创建；首次登录需要修改初始密码。');
      } catch (error) {
        setDialogMessage(error.message || '创建成员失败。');
      }
    }}>
      <label className="rv-field">登录邮箱<input name="email" type="email" required maxLength={254} autoComplete="off" placeholder="member@example.com" /></label>
      <label className="rv-field">显示姓名<input name="displayName" maxLength={80} placeholder="留空时使用邮箱前缀" /></label>
      <label className="rv-field">角色<select name="role" defaultValue="operator">{ROLES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className="rv-field">初始密码<input name="password" type="password" required minLength={10} autoComplete="new-password" placeholder="至少 10 个字符" /></label>
      <p className="muted">新成员首次登录时，需要修改临时密码。</p>
      <button className="btn primary" type="submit">创建成员</button>
    </form>);
  }

  function openEdit(user) {
    openDialog('编辑成员', <form id="rv-user-form" className="rv" onSubmit={async event => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      try {
        await updateUser(apiCall, user.id, {
          displayName: String(form.get('displayName') || '').trim(),
          role: String(form.get('role') || user.role),
        });
        closeDialog();
        refresh();
        notify('成员资料已更新。');
      } catch (error) {
        setDialogMessage(error.message || '更新成员失败。');
      }
    }}>
      <label className="rv-field">显示姓名<input name="displayName" required maxLength={80} defaultValue={user.displayName || ''} /></label>
      <label className="rv-field">角色<select name="role" defaultValue={user.role}>{ROLES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <p className="muted">邮箱不可修改。管理员不能取消或停用最后一个管理员账号。</p>
      <button className="btn primary" type="submit">保存修改</button>
    </form>);
  }

  function openReset(user) {
    openDialog('重置密码', <form id="rv-user-form" className="rv" onSubmit={async event => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const password = String(form.get('password') || '');
      try {
        await updateUser(apiCall, user.id, { password });
        closeDialog();
        refresh();
        notify('密码已重置；该成员需要重新登录并修改密码。');
      } catch (error) {
        setDialogMessage(error.message || '重置密码失败。');
      }
    }}>
      <p className="muted">为 {user.email} 设置新的临时密码。提交后该成员所有旧会话立即失效。</p>
      <label className="rv-field">临时密码<input name="password" type="password" required minLength={10} autoComplete="new-password" placeholder="至少 10 个字符" /></label>
      <button className="btn primary" type="submit">确认重置</button>
    </form>);
  }

  async function toggle(user) {
    try {
      await updateUser(apiCall, user.id, { enabled: !user.active });
      refresh();
      notify(user.active ? '成员已停用，旧会话立即失效。' : '成员已启用。');
    } catch (error) {
      notify(error.message || '更新成员状态失败。');
    }
  }

  return <section className="rv-panel" data-rv="system-users">
    <div className="rv-panel-title">
      <div><h2>团队成员</h2><small>管理成员账号、角色与访问权限。</small></div>
      <Btn primary data-rv="add-user" data-role="admin-only" hidden={!canRead} onClick={openCreate}>＋ 新增用户</Btn>
    </div>
    {me && <div className="rv-banner" data-rv="signed-in">
      当前登录：<b>{me.email}</b> · {roleLabel(me.role)}
      {me.mustChangePassword ? ' · 需要修改密码' : ''}
    </div>}
    {!authOn && <p className="rv-empty">当前为本机单用户模式（未启用账号体系）。设置 <code>SJ_AUTH=on</code> 并完成管理员初始化后，才能在此管理真实成员。</p>}
    {authOn && !canAdmin && <p className="rv-empty">成员管理仅对管理员开放。当前角色可以继续查看账单与审计日志。</p>}
    {canRead && state.loading && <p className="rv-empty">正在读取成员…</p>}
    {canRead && state.error && <p className="rv-empty" role="alert">成员列表读取失败：{state.error}</p>}
    {canRead && !state.loading && !state.error && state.users.length === 0 && <p className="rv-empty">还没有其他成员。点击「新增用户」创建第一个团队成员。</p>}
    {canRead && !state.loading && !state.error && state.users.length > 0 && <div className="rv-table-wrap"><table className="rv-table" data-rv="users-table"><thead><tr><th>姓名 / 邮箱</th><th>角色</th><th>状态</th><th>操作</th></tr></thead><tbody>
      {state.users.map(user => <tr key={user.id} data-user-id={user.id}>
        <td><b>{user.displayName || user.email}</b><small>{user.email}</small></td>
        <td>{roleLabel(user.role)}</td>
        <td><Tag type={user.active ? 'ok' : 'warn'}>{user.active ? '正常' : '已停用'}</Tag>{user.mustChangePassword ? <small>待首次改密</small> : null}</td>
        <td><div className="rv-actions" data-role="admin-only">
          <Btn data-rv="edit-user" data-id={user.id} onClick={() => openEdit(user)}>编辑</Btn>
          <Btn data-rv="toggle-user" data-id={user.id} disabled={user.id === me?.id} onClick={() => toggle(user)}>{user.active ? '停用' : '启用'}</Btn>
          <Btn data-rv="reset-password" data-id={user.id} onClick={() => openReset(user)}>重置密码</Btn>
        </div></td>
      </tr>)}
    </tbody></table></div>}
    <div className="rv-capabilities"><Tag>管理员：成员、模型配置及全部业务</Tag><Tag>运营：商品、项目、生成与素材</Tag><Tag>只读：浏览与下载</Tag></div>
  </section>;
}

function Billing({ apiCall, canAdmin, notify, openDialog, closeDialog, setDialogMessage }) {
  const [summary, setSummary] = useState({ loading: true, error: '', data: null });
  const [ledger, setLedger] = useState({ loading: true, error: '', data: null, offset: 0 });
  const [reloadKey, setReloadKey] = useState(0);
  const [ledgerOffset, setLedgerOffset] = useState(0);

  useEffect(() => {
    let active = true;
    if (!apiCall) {
      setSummary({ loading: false, error: '后端连接不可用，暂时无法读取账单。', data: null });
      return () => { active = false; };
    }
    setSummary(previous => ({ ...previous, loading: true, error: '' }));
    getBillingSummary(apiCall)
      .then(data => { if (active) setSummary({ loading: false, error: '', data }); })
      .catch(error => { if (active) setSummary({ loading: false, error: error.message || '账单汇总读取失败。', data: null }); });
    return () => { active = false; };
  }, [apiCall, reloadKey]);

  useEffect(() => {
    let active = true;
    if (!apiCall) {
      setLedger({ loading: false, error: '后端连接不可用，暂时无法读取流水。', data: null, offset: ledgerOffset });
      return () => { active = false; };
    }
    setLedger(previous => ({ ...previous, loading: true, error: '', offset: ledgerOffset }));
    getBillingLedger(apiCall, { limit: PAGE_SIZE, offset: ledgerOffset })
      .then(data => { if (active) setLedger({ loading: false, error: '', data, offset: ledgerOffset }); })
      .catch(error => { if (active) setLedger({ loading: false, error: error.message || '账本流水读取失败。', data: null, offset: ledgerOffset }); });
    return () => { active = false; };
  }, [apiCall, ledgerOffset, reloadKey]);

  const data = summary.data;
  const entries = ledger.data?.entries || [];

  function adjust() {
    openDialog('充值 / 调账', <form id="rv-balance-form" className="rv" onSubmit={async event => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const amount = Number(form.get('amount'));
      const amountCents = Math.round(amount * 100);
      const reason = String(form.get('reason') || '').trim();
      const reference = String(form.get('reference') || '').trim();
      if (!Number.isFinite(amountCents) || amountCents === 0) { setDialogMessage('请输入非零金额。'); return; }
      if (!reason) { setDialogMessage('请填写调账原因。'); return; }
      if (!reference) { setDialogMessage('请填写业务引用，例如充值单号或审批单号。'); return; }
      try {
        await postBillingAdjustment(apiCall, { amountCents, reason, reference });
        closeDialog();
        setLedgerOffset(0);
        setReloadKey(value => value + 1);
        notify('调账已追加到真实账本。');
      } catch (error) {
        setDialogMessage(error.message || '调账失败。');
      }
    }}>
      <label className="rv-field">变动金额（CNY；正数充值，负数扣减）<input name="amount" type="number" step="0.01" required placeholder="例如 100 或 -20.50" /></label>
      <label className="rv-field">原因<input name="reason" required maxLength={500} /></label>
      <label className="rv-field">业务引用<input name="reference" required maxLength={200} placeholder="充值单号 / 审批单号" /></label>
      <p className="muted">调账只追加真实流水，不覆盖历史记录；扣减后余额不足以覆盖预占时会被服务端拒绝。</p>
      <button className="btn primary" type="submit">确认调账</button>
    </form>);
  }

  return <>
    <div className="rv-banner">账本与价格来自服务端，以供应商实际账单为准。预占表示在途资金，待核价任务金额未定，不显示为 0。</div>
    {summary.error && <div className="rv-banner warning" role="alert" data-rv="billing-error">账单汇总暂不可用：{summary.error}</div>}
    <div className="rv-metrics" data-rv="billing-metrics" aria-busy={summary.loading}>
      <div className="rv-metric"><span>可用额度</span><strong>{summary.loading ? '读取中' : data ? formatCents(data.availableCents) : '—'}</strong><small>账面余额减去在途预占</small></div>
      <div className="rv-metric"><span>账面余额</span><strong>{summary.loading ? '读取中' : data ? formatCents(data.balanceCents) : '—'}</strong><small>全部入账与结算后的余额</small></div>
      <div className="rv-metric"><span>在途预占</span><strong>{summary.loading ? '读取中' : data ? formatCents(data.heldCents) : '—'}</strong><small>成功结算或失败释放后解除</small></div>
      <div className="rv-metric"><span>本月结算</span><strong>{summary.loading ? '读取中' : data ? formatCents(data.settledCents) : '—'}</strong><small>{data?.from ? `${formatDateTime(data.from)} 起` : '按自然月统计'}</small></div>
      <div className="rv-metric"><span>待核价任务</span><strong>{summary.loading ? '读取中' : data ? `${data.pendingPriceCount} 笔` : '—'}</strong><small>金额未定，需管理员补价</small></div>
    </div>
    <section className="rv-panel" data-rv="system-billing">
      <div className="rv-panel-title">
        <div><h2>额度流水</h2><small>{ledger.data ? `共 ${ledger.data.total} 条，按时间倒序；每页 ${PAGE_SIZE} 条。` : '追加式流水，不覆盖历史记录。'}</small></div>
        <Btn primary data-rv="adjust-balance" data-role="admin-only" hidden={!canAdmin} onClick={adjust}>充值 / 调账</Btn>
      </div>
      {!canAdmin && <p className="muted">当前角色只读；充值 / 调账仅管理员可执行。</p>}
      {ledger.loading && <p className="rv-empty">正在读取流水…</p>}
      {!ledger.loading && ledger.error && <p className="rv-empty" role="alert">账本流水读取失败：{ledger.error}</p>}
      {!ledger.loading && !ledger.error && entries.length === 0 && <p className="rv-empty">还没有账本流水。任务结算或管理员调账后会出现在这里。</p>}
      {!ledger.loading && !ledger.error && entries.length > 0 && <div className="rv-table-wrap"><table className="rv-table" data-rv="ledger-table"><thead><tr><th>时间</th><th>类型</th><th>事项</th><th>金额</th><th>任务 / 引用</th><th>操作者</th></tr></thead><tbody>
        {entries.map(entry => <tr key={entry.id} data-ledger-id={entry.id}>
          <td>{formatDateTime(entry.createdAt)}</td>
          <td>{ledgerTypeLabel(entry.entryType)}</td>
          <td>{entry.reason || entry.projectId || '—'}<small>{entry.modelId || entry.capability || ''}</small></td>
          <td>{ledgerAmount(entry)}</td>
          <td>{entry.taskId || '—'}<small>{entry.reference || entry.projectId || ''}</small></td>
          <td>{entry.actorId || '—'}</td>
        </tr>)}
      </tbody></table></div>}
      <div className="rv-actions" style={{ marginTop: 16 }}>
        <Btn data-rv="ledger-prev" disabled={ledgerOffset === 0 || ledger.loading} onClick={() => setLedgerOffset(value => Math.max(0, value - PAGE_SIZE))}>上一页</Btn>
        <Btn data-rv="ledger-next" disabled={ledger.loading || !ledger.data?.nextOffset} onClick={() => setLedgerOffset(ledger.data.nextOffset)}>下一页</Btn>
        <small className="muted">第 {ledgerOffset + 1}–{ledgerOffset + entries.length} 条</small>
      </div>
    </section>
  </>;
}

export function Logs({ apiCall }) {
  const [selectedLog, setSelectedLog] = useState(null);
  const [action, setAction] = useState('');
  const [result, setResult] = useState('');
  const [applied, setApplied] = useState({ action: '', result: '' });
  const [offset, setOffset] = useState(0);
  const [state, setState] = useState({ loading: true, error: '', data: null });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    if (!apiCall) {
      setState({ loading: false, error: '后端连接不可用，暂时无法读取日志。', data: null });
      return () => { active = false; };
    }
    setState(previous => ({ ...previous, loading: true, error: '' }));
    listAuditLogs(apiCall, { limit: PAGE_SIZE, offset, action: applied.action, result: applied.result })
      .then(data => { if (active) setState({ loading: false, error: '', data }); })
      .catch(error => { if (active) setState({ loading: false, error: error.message || '审计日志读取失败。', data: null }); });
    return () => { active = false; };
  }, [apiCall, offset, applied, reloadKey]);

  const logs = state.data?.logs || [];
  const exportHref = auditExportUrl(applied);

  function apply(event) {
    event.preventDefault();
    setOffset(0);
    setApplied({ action: action.trim(), result });
  }

  function clear() {
    setAction('');
    setResult('');
    setOffset(0);
    setApplied({ action: '', result: '' });
  }

  return <section className="rv-panel" data-rv="system-logs">
    <div className="rv-panel-title">
      <div><h2>操作记录</h2><small>只追加审计日志，不含密码、密钥或提示词全文；非管理员只看到自己的记录。</small></div>
      <a className="btn" data-rv="audit-export" href={exportHref} download>导出 CSV</a>
    </div>
    <form className="rv-actions" data-rv="audit-filter" onSubmit={apply} style={{ marginBottom: 16 }}>
      <label className="rv-field" style={{ flex: '1 1 220px' }}>动作筛选<input value={action} onChange={event => setAction(event.target.value)} placeholder="例如 auth.login.succeeded，可用 * 结尾" maxLength={200} /></label>
      <label className="rv-field">结果<select value={result} onChange={event => setResult(event.target.value)}><option value="">全部</option><option value="success">成功</option><option value="failure">失败</option></select></label>
      <Btn primary data-rv="audit-apply" type="submit">查询</Btn>
      <Btn data-rv="audit-clear" onClick={clear}>清除筛选</Btn>
    </form>
    {state.data && <p className="muted" data-rv="audit-total">共 {state.data.total} 条记录。</p>}
    {state.loading && <p className="rv-empty">正在读取审计日志…</p>}
    {!state.loading && state.error && <p className="rv-empty" role="alert">审计日志读取失败：{state.error}</p>}
    {!state.loading && !state.error && logs.length === 0 && <p className="rv-empty">还没有审计记录。登录、成员变更或创作操作后会出现在这里。</p>}
    {!state.loading && !state.error && logs.length > 0 && <div className="rv-table-wrap"><table className="rv-table" data-rv="audit-table"><thead><tr><th>时间</th><th>动作</th><th>对象</th><th>结果</th><th>操作者</th><th>详情</th></tr></thead><tbody>
      {logs.map(log => <tr key={log.id} data-audit-id={log.id}>
        <td>{formatDateTime(log.createdAt)}</td>
        <td><b>{log.action}</b></td>
        <td>{auditObjectLabel(log)}</td>
        <td><Tag type={log.result === 'failure' ? 'warn' : 'ok'}>{RESULT_LABELS[log.result] || log.result}</Tag></td>
        <td>{log.actorEmail || '—'}<small>{log.actorRole ? roleLabel(log.actorRole) : ''}</small></td>
        <td><Btn small onClick={() => setSelectedLog(log)}>查看详情</Btn></td>
      </tr>)}
    </tbody></table></div>}
    <div className="rv-actions" style={{ marginTop: 16 }}>
      <Btn data-rv="audit-prev" disabled={offset === 0 || state.loading} onClick={() => setOffset(value => Math.max(0, value - PAGE_SIZE))}>上一页</Btn>
      <Btn data-rv="audit-next" disabled={state.loading || !state.data?.nextOffset} onClick={() => setOffset(state.data.nextOffset)}>下一页</Btn>
      <small className="muted">第 {offset + 1}–{offset + logs.length} 条</small>
    </div>
    {selectedLog && <div className="cp-modal-backdrop"><section role="dialog" aria-modal="true" aria-label="操作详情" className="cp-modal b-drawer"><header><h2>操作详情</h2><button aria-label="关闭操作详情" onClick={() => setSelectedLog(null)}>×</button></header><dl className="b-audit-detail"><dt>动作</dt><dd>{selectedLog.action}</dd><dt>时间</dt><dd>{formatDateTime(selectedLog.createdAt)}</dd><dt>操作者</dt><dd>{selectedLog.actorEmail || '—'}</dd><dt>对象</dt><dd>{auditObjectLabel(selectedLog)}</dd><dt>结果</dt><dd>{RESULT_LABELS[selectedLog.result] || selectedLog.result}</dd></dl><h3>操作记录</h3><pre className="b-info">{JSON.stringify(selectedLog.metadata || selectedLog.detail || {}, null, 2)}</pre><footer><button onClick={() => setSelectedLog(null)}>关闭</button></footer></section></div>}
  </section>;
}

function Models({ apiCall, canAdmin, notify, openDialog, closeDialog, setDialogMessage, onOpenRealSystem }) {
  const [state, setState] = useState({ loading: true, error: '', prices: [] });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    if (!apiCall) {
      setState({ loading: false, error: '后端连接不可用，暂时无法读取价格表。', prices: [] });
      return () => { active = false; };
    }
    setState(previous => ({ ...previous, loading: true, error: '' }));
    getBillingPrices(apiCall, { limit: 50 })
      .then(result => { if (active) setState({ loading: false, error: '', prices: result.prices || [] }); })
      .catch(error => { if (active) setState({ loading: false, error: error.message || '价格表读取失败。', prices: [] }); });
    return () => { active = false; };
  }, [apiCall, reloadKey]);

  function openPrice() {
    openDialog('手动录入平台价格', <form id="rv-price-form" className="rv" onSubmit={async event => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const body = {
        capability: String(form.get('capability') || ''),
        modelId: String(form.get('modelId') || '').trim(),
        tier: String(form.get('tier') || '').trim() || 'default',
        unit: String(form.get('unit') || 'image'),
        unitPrice: String(form.get('unitPrice') || '').trim(),
      };
      const note = String(form.get('note') || '').trim();
      if (note) body.note = note;
      try {
        await saveBillingPrice(apiCall, body);
        closeDialog();
        setReloadKey(value => value + 1);
        notify('真实价格已保存；同能力、同模型、同档位的旧价已停用。');
      } catch (error) {
        setDialogMessage(error.message || '保存价格失败。');
      }
    }}>
      <label className="rv-field">能力<select name="capability" defaultValue="image.generate">{CAPABILITIES.map(([value, label]) => <option key={value} value={value}>{label}（{value}）</option>)}</select></label>
      <label className="rv-field">模型编号<input name="modelId" required maxLength={200} pattern="[A-Za-z0-9][A-Za-z0-9._:/@+\-]{0,199}" title="以字母或数字开头，只含字母、数字与 . _ : / @ + -" placeholder="例如 omyai-openai:gpt-image-2.5-flare" /></label>
      <div className="rv-split">
        <label className="rv-field">档位（tier）<input name="tier" maxLength={80} pattern="[A-Za-z0-9][A-Za-z0-9._:\-]{0,79}" defaultValue="default" /></label>
        <label className="rv-field">计价单位<select name="unit" defaultValue="image">{Object.entries(UNIT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      </div>
      <label className="rv-field">平台结算单价（CNY）<input name="unitPrice" required inputMode="decimal" placeholder="例如 0.25，最多 12 位小数" /></label>
      <label className="rv-field">价格说明（可选）<input name="note" maxLength={500} placeholder="供应商、账单周期或折算依据" /></label>
      <p className="muted">保存后立即生效并停用同能力、同模型、同档位的旧价；不预约未来生效，不修改历史账本或已冻结项目。</p>
      <button className="btn primary" type="submit">保存真实价格</button>
    </form>);
  }

  function openLookup() {
    openDialog('AI 查价候选 · 演示', <div className="rv">
      <div className="rv-banner warning">演示交互，未联网查价。以下金额是虚构示例，没有真实价格来源，不会写入价格表或账本。</div>
      <div className="rv-evidence">
        <div><b>示例图像模型 / 1024 标准</b><span>待管理员核实</span></div>
        <div><span>官方价：¥1.00 / 张</span><span>渠道价：¥0.90 / 张</span></div>
        <div><span>来源：本地示例，无公开引用</span><span>非真实报价</span></div>
      </div>
      <p className="muted">真实价格请通过「手动录入」写入服务端价格表；此窗口没有保存操作。</p>
      <button className="btn primary" type="button" data-rv="close-lookup" onClick={closeDialog}>关闭</button>
    </div>);
  }

  return <>
    <section className="rv-panel" data-rv="system-models">
      <div className="rv-panel-title"><div><h2>模型能力与渠道</h2><small>真实渠道与模型目录在渠道管理中维护；价格在这里按能力与模型登记。</small></div><Btn primary data-rv="real-system" onClick={onOpenRealSystem}>管理真实渠道</Btn></div>
      <div className="rv-grid">{[['图像生成 / 改图', '已接入单图执行', 'ok'], ['文本 / 视觉理解', '能力目录已登记，执行按渠道配置', 'warn'], ['视频 / 语音', '能力目录预留，执行未接入', '']].map(([title, note, type]) => <div className="rv-panel" key={title}><h3>{title}</h3><Tag type={type}>{note}</Tag></div>)}</div>
      <p className="muted" style={{ marginTop: 18 }}>模型不可用时由用户处理，不自动切换付费模型或重试。</p>
    </section>
    <section className="rv-panel rv-model-price" data-rv="price-table">
      <div className="rv-panel-title">
        <div><h2>价格与档位</h2><small>平台结算价来自服务端价格表；官方价与供应商账单分别记录。</small></div>
        <div className="rv-actions">
          <Btn data-rv="manual-price" data-role="admin-only" hidden={!canAdmin} onClick={openPrice}>手动录入</Btn>
          <Btn data-rv="lookup-price" onClick={openLookup}>AI 查价演示</Btn>
        </div>
      </div>
      {state.loading && <p className="rv-empty">正在读取真实价格…</p>}
      {!state.loading && state.error && <p className="rv-empty" role="alert">价格表读取失败：{state.error}</p>}
      {!state.loading && !state.error && state.prices.length === 0 && <p className="rv-empty">还没有真实价格。管理员手动录入后会出现在这里。</p>}
      {!state.loading && !state.error && state.prices.length > 0 && <div className="rv-table-wrap"><table className="rv-table"><thead><tr><th>模型 / 能力</th><th>档位</th><th>结算价</th><th>生效时间</th><th>状态</th></tr></thead><tbody>
        {state.prices.map(price => <tr key={price.id} data-price-id={price.id}>
          <td><b>{price.modelId}</b><small>{price.capability}</small></td>
          <td>{price.tier || 'default'}</td>
          <td>{formatPriceUnit(price.unitPrice, price.unit)}</td>
          <td>{formatDateTime(price.effectiveFrom)}</td>
          <td><Tag type={price.active ? 'ok' : ''}>{price.active ? '生效中' : '历史版本'}</Tag></td>
        </tr>)}
      </tbody></table></div>}
      <p className="muted" style={{ marginTop: 18, fontSize: 12 }}>历史价格保留用于已结算流水核对，不回改已冻结项目；AI 查价演示不产生真实报价。</p>
    </section>
  </>;
}

function Security({ authOn, me, canAdmin }) {
  return <div className="rv-split">
    <section className="rv-panel"><h2>账号与工作空间</h2>
      <p>首期一个商家团队、多账号共享业务资料。登录启用后支持首次改密、停用即时失效与服务端逐接口角色校验。</p>
      {me ? <p className="muted">当前登录：{me.email} · {roleLabel(me.role)}。前端按角色隐藏写入口，服务端仍逐接口鉴权。</p>
        : <p className="muted">当前未启用账号体系（本机单用户模式）；设置 <code>SJ_AUTH=on</code> 后启用登录与三角色鉴权。</p>}
      <h3>凭据与访问</h3><p className="muted">浏览器不持有中间件密码或长期存储密钥；渠道密钥只通过后端使用。密码与会话令牌不写入 localStorage、URL 或日志。</p>
    </section>
    <section className="rv-panel"><h2>当前可用边界</h2>
      <p>成员、账本流水、价格表与审计日志读取真实服务端接口；管理员可创建成员、调账与录入价格。</p>
      <p className="muted">{authOn ? `已启用账号体系；当前角色${canAdmin ? '可读取成员列表' : '不能读取成员列表'}。` : '未启用账号体系，成员管理不可用；账单与日志按本机单工作空间读取。'}项目、商品与精修审核界面仍多为本地演示；视频执行与真实截图识别尚未接入。</p>
    </section>
  </div>;
}
