/* Real generation uses only same-origin APIs; provider credentials never enter this file. */
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const labels = { queued:'排队中', submitting:'提交中', running:'生成中', storing:'转存图片', succeeded:'已完成', failed:'未成功', unknown:'待核实' };
  const qualityLabels = { auto:'自动', low:'低', medium:'中', high:'高', highest:'最高', standard:'标准', hd:'高清' };
  let csrf = '';
  let allModels = [];
  let imageModels = [];
  let jobs = [];
  let sourceJobId = null;
  let selectedJobId = null;
  let pending = null;
  let sending = false;
  let polling = false;
  let refreshingModels = false;
  const hiddenJobs = new Set();
  const checkedJobs = new Set();
  const ui = { modelId: '', size: '', quality: '', width: '', height: '' };

  const view = document.createElement('section');
  view.className = 'view gen-studio';
  view.dataset.view = 'generation';
  view.hidden = true;
  view.innerHTML = `
    <div class="gen-head">
      <div>
        <p class="kicker">生图工作台 / IMAGE STUDIO</p>
        <h1>让想法，<mark class="hl">成为画面。</mark></h1>
      </div>
      <div class="gen-head-side">
        <span class="autosave" id="gen-catalog-meta">连接中…</span>
        <button class="btn ghost" id="gen-refresh" type="button">刷新模型</button>
      </div>
    </div>
    <div class="studio-message" id="gen-message" role="status" aria-live="polite">正在连接生图服务…</div>
    <div class="studio-grid">
      <aside class="studio-history" aria-label="生成记录">
        <div class="studio-head"><h2>生成记录</h2><span id="gen-history-count">0</span></div>
        <div class="studio-history-actions">
          <button class="studio-small" id="gen-new" type="button">＋ 新建</button>
          <button class="studio-small" id="gen-select-all" type="button">全选</button>
          <button class="studio-small" id="gen-remove" type="button" disabled>移除</button>
        </div>
        <div class="studio-history-list" id="gen-list"><div class="studio-empty">还没有生成记录。描述画面后生成第一张图。</div></div>
      </aside>

      <section class="studio-compose" aria-label="生成参数">
        <form id="gen-form">
          <div class="studio-label"><label for="gen-prompt" id="gen-prompt-label">提示词</label><span>Ctrl + Enter 生成</span></div>
          <textarea id="gen-prompt" maxlength="16000" required placeholder="描述主体、材质、光线、镜头和构图。例如：白色收纳盒置于明亮客厅的木架上，柔和自然光，方形商品场景图，无文字。"></textarea>

          <div class="studio-ref">
            <div class="studio-ref-head"><span>参考图</span><div>
              <button class="studio-small" id="gen-ref-select" type="button">从记录选择</button>
              <button class="studio-small" id="gen-ref-upload" type="button" disabled title="任意参考图上传尚未接入">上传</button>
              <button class="studio-small" id="gen-ref-clear" type="button" hidden>清除</button>
            </div></div>
            <div class="studio-ref-drop" id="gen-source">暂无参考图。可从生成结果中选择一张已生成图片作为改图源；任意图片上传尚未接入。</div>
          </div>

          <label class="studio-field"><span>模型</span>
            <select id="gen-model" required disabled><option>正在加载…</option></select>
          </label>

          <div class="studio-section">
            <div class="studio-section-head"><span>质量</span><em id="gen-quality-note">按渠道能力</em></div>
            <div class="studio-pills" id="gen-quality-pills"></div>
          </div>

          <div class="studio-section">
            <div class="studio-section-head"><span>尺寸</span><em>渠道固定尺寸</em></div>
            <div class="studio-size">
              <label>W <input id="gen-width" type="number" min="256" step="16" inputmode="numeric"></label>
              <span>×</span>
              <label>H <input id="gen-height" type="number" min="256" step="16" inputmode="numeric"></label>
            </div>
            <p class="studio-hint" id="gen-size-note"></p>
          </div>

          <div class="studio-section">
            <div class="studio-section-head"><span>分辨率</span></div>
            <div class="studio-pills" id="gen-resolution-pills"></div>
          </div>

          <div class="studio-section">
            <div class="studio-section-head"><span>宽高比</span></div>
            <div class="studio-ratios" id="gen-ratio-pills"></div>
          </div>

          <input id="gen-size" type="hidden">
          <input id="gen-quality" type="hidden">
          <div class="studio-form-note" id="gen-form-note" role="status"></div>
          <label class="studio-consent"><input id="gen-consent" type="checkbox" required>
            确认生成 1 张图片，按渠道实际账单计费；网络中断时沿用原请求编号。</label>
          <button class="studio-generate" id="gen-submit" type="submit" disabled>生成 1 张图片</button>
        </form>
      </section>

      <section class="studio-results" aria-label="生成结果">
        <div class="studio-head"><h2>生成结果</h2><span id="gen-result-meta">—</span></div>
        <div class="studio-result-grid" id="gen-result-grid"><div class="studio-empty">生成完成后，结果显示在这里。</div></div>
        <p class="studio-hint" id="gen-result-note">选择历史记录查看，或生成新的图片。费用以渠道使用日志为准。</p>
      </section>
    </div>`;
  $('.stage').prepend(view);

  // Keep the compact mobile navigation from the previous generation screen.
  const mobileNav = document.createElement('nav');
  mobileNav.className = 'gen-mobile-nav';
  mobileNav.setAttribute('aria-label', '移动端导航');
  mobileNav.innerHTML = '<button data-screen="dashboard">工作台</button><button data-screen="projects">项目</button><button data-screen="generation">生图</button><button data-screen="system">系统</button>';
  document.body.appendChild(mobileNav);

  function message(text, error = false) {
    $('#gen-message').textContent = text;
    $('#gen-message').dataset.error = String(error);
  }

  function formNote(text, error = false) {
    const el = $('#gen-form-note');
    el.textContent = text;
    el.dataset.error = String(error);
  }

  async function api(path, body, method) {
    const verb = method || (body === undefined ? 'GET' : 'POST');
    const headers = verb === 'GET' ? {} : { 'X-CSRF-Token': csrf };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(path, {
      method: verb,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result.error?.message || '服务请求失败。');
      error.code = result.error?.code;
      throw error;
    }
    return result;
  }

  let toastTimer = null;
  function toast(text) {
    const el = $('#toast');
    if (!el) return;
    el.textContent = text;
    el.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('is-on'), 2800);
  }

  function selectedModel() {
    return imageModels.find(m => m.id === ($('#gen-model').value || ui.modelId)) || null;
  }

  function sourceJob() {
    return sourceJobId ? jobs.find(j => j.id === sourceJobId) || null : null;
  }

  function qualityLabel(value) { return qualityLabels[value] || value; }

  function formatTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
  }

  function duration(job) {
    if (!job.createdAt) return '—';
    const end = job.status === 'succeeded' && job.updatedAt ? new Date(job.updatedAt) : new Date();
    const seconds = Math.max(0, Math.round((end - new Date(job.createdAt)) / 1000));
    return seconds > 0 ? seconds + ' 秒' : '—';
  }

  function statusInfo(status) {
    if (status === 'succeeded') return { label:'成功', cls:'ok' };
    if (status === 'failed') return { label:'失败', cls:'warn' };
    if (status === 'unknown') return { label:'待核实', cls:'warn' };
    return { label:labels[status] || status, cls:'run' };
  }

  function modelShort(job) {
    return String(job.modelId || '').split(':').slice(1).join(':') || job.modelId || '—';
  }

  function parseSize(value) {
    const match = String(value || '').match(/^(\d+)x(\d+)$/i);
    return match ? [Number(match[1]), Number(match[2])] : [0, 0];
  }

  function resolutionLabel(size) {
    const [w, h] = parseSize(size);
    const max = Math.max(w, h);
    if (!max) return size;
    if (max >= 3840) return '4K';
    if (max >= 2560) return '2K';
    if (max >= 1536) return '1.5K';
    return '1K';
  }

  function ratioOf(size) {
    const [w, h] = parseSize(size);
    if (!w || !h) return '';
    const gcd = (a, b) => b ? gcd(b, a % b) : a;
    const d = gcd(w, h);
    return `${w / d}:${h / d}`;
  }

  function visibleJobs() {
    return jobs.filter(job => !hiddenJobs.has(job.id));
  }

  function editModelsFor(job) {
    if (!job) return [];
    const provider = String(job.modelId || '').split(':')[0];
    return imageModels.filter(m => m.providerId === provider && m.operations?.includes('edit'));
  }

  /* ---------------- catalog and model controls ---------------- */
  function renderCatalog(catalog) {
    allModels = catalog.models || [];
    imageModels = allModels.filter(m => m.kind === 'image' && m.executable !== false);
    window.workbench.setModels(allModels);

    const providers = catalog.providers || [];
    $('#gen-catalog-meta').textContent = imageModels.length
      ? `${imageModels.length} 个图像模型 · ${providers.filter(p => p.connected && p.enabled !== false).length} 个渠道在线`
      : '暂无可执行图像模型';

    $('#channel-list').innerHTML = providers.length ? providers.map(p => {
      const enabled = p.enabled !== false;
      const status = !enabled ? '已停用' : p.connected ? (p.modelCount ? '已连接' : '已连接 · 无模型') : '连接不可用';
      const statusClass = !enabled ? 'idle' : p.connected ? (p.modelCount ? 'ok' : 'warn') : 'warn';
      const source = p.source === 'database' ? '＋' : 'O';
      const key = p.source === 'database' ? 'Key ' + esc(p.keyHint || '已隐藏') : '服务端配置';
      const actions = p.deletable ? `<div class="channel-actions">
        <button class="btn small" type="button" data-channel-toggle="${esc(p.id)}" data-enabled="${enabled}">${enabled ? '停用' : '启用'}</button>
        <button class="btn small" type="button" data-channel-delete="${esc(p.id)}" data-name="${esc(p.name)}">删除</button>
      </div>` : '';
      return `<article class="channel"><span class="channel-mark">${source}</span><div class="channel-main">
        <div class="channel-title"><b>${esc(p.name)}</b><span class="status-pill ${statusClass}">${status}</span></div>
        <small>${p.modelCount} 个可用模型 · ${key}</small>
        <div class="channel-meta"><span>${esc(p.baseUrl || '未提供 Base URL')}</span></div>
      </div>${actions}</article>`;
    }).join('') : '<div class="sys-empty">还没有渠道。新增渠道后会自动读取模型。</div>';

    $('#real-model-table').innerHTML = allModels.length ? allModels.map(m => {
      const image = m.kind === 'image';
      const op = image ? (m.operations?.includes('edit') ? '生图 / 改图' : '生图') : '目录已同步 · 执行未接入';
      const pill = image ? '<span class="status-pill ok">可生图</span>' : '<span class="status-pill warn">未执行</span>';
      return `<div class="gen-card"><div class="gen-card-head"><b>${esc(m.name)}</b>${pill}</div>
        <p>${esc(m.providerName)} · ${image ? '图像' : '视频'} · ${op}</p>
        <small>${(m.sizes || []).map(esc).join(' / ')} · ${(m.qualities || []).map(esc).join(' / ')}</small>
        ${m.note ? `<small>${esc(m.note)}</small>` : ''}</div>`;
    }).join('') : '<div class="sys-empty">还没有识别到图像或视频模型。请检查渠道模型命名或服务端配置。</div>';
    $('#sys-channel-count').textContent = providers.filter(p => p.connected && p.enabled !== false).length;

    renderModelOptions(ui.modelId || $('#gen-model').value);
  }

  function renderModelOptions(preferred) {
    const source = sourceJob();
    const provider = source ? String(source.modelId || '').split(':')[0] : '';
    const list = source
      ? imageModels.filter(m => m.providerId === provider && m.operations?.includes('edit'))
      : imageModels.slice();
    let desired = preferred || ui.modelId || $('#gen-model').value;
    if (source && !list.some(m => m.id === desired)) {
      const sourceModel = list.find(m => m.id === source.modelId);
      desired = sourceModel ? sourceModel.id : list[0]?.id || '';
    }
    if (!list.some(m => m.id === desired)) {
      let saved = '';
      try { saved = localStorage.getItem('sj:default-image') || ''; } catch {}
      desired = (list.find(m => m.id === saved) || list.find(m => m.default) || list[0] || {}).id || '';
    }
    if (pending && !list.some(m => m.id === pending.modelId)) {
      $('#gen-model').innerHTML = `<option value="${esc(pending.modelId)}">原提交模型 · 当前不可用</option>` +
        list.map(m => `<option value="${esc(m.id)}">${esc(m.providerName)} · ${esc(m.name)}</option>`).join('');
      $('#gen-model').value = pending.modelId;
      ui.modelId = pending.modelId;
    } else {
      $('#gen-model').innerHTML = list.length
        ? list.map(m => `<option value="${esc(m.id)}">${esc(m.providerName)} · ${esc(m.name)}</option>`).join('')
        : `<option value="">${source ? '该渠道不支持改图' : '暂无可执行图像模型'}</option>`;
      $('#gen-model').value = desired;
      ui.modelId = desired;
    }
    $('#gen-model').disabled = !list.length || !!pending;
    if (source && !list.length) formNote('当前渠道没有可用的改图模型。结束改图后可生成新图。', true);
    else if (!pending) formNote('');
    renderModelParams();
  }

  function syncSizeInputs() {
    const [w, h] = parseSize(ui.size);
    ui.width = w || '';
    ui.height = h || '';
    $('#gen-width').value = w || '';
    $('#gen-height').value = h || '';
    $('#gen-size').value = ui.size || '';
  }

  function renderQualityPills(qualities) {
    $('#gen-quality-pills').innerHTML = qualities.length ? qualities.map(q =>
      `<button type="button" data-quality="${esc(q)}" class="${q === ui.quality ? 'is-active' : ''}" ${pending ? 'disabled' : ''}>${esc(qualityLabel(q))}</button>`
    ).join('') : '<span class="studio-hint">渠道未返回质量参数</span>';
  }

  function renderResolutionPills(sizes) {
    const buckets = new Map();
    for (const size of sizes) {
      const label = resolutionLabel(size);
      if (!buckets.has(label)) buckets.set(label, size);
    }
    $('#gen-resolution-pills').innerHTML = buckets.size ? Array.from(buckets.entries()).map(([label, size]) => {
      const active = parseSize(ui.size)[0] === parseSize(size)[0] && parseSize(ui.size)[1] === parseSize(size)[1];
      return `<button type="button" data-size="${esc(size)}" class="${active ? 'is-active' : ''}" ${pending ? 'disabled' : ''}>${esc(label)}</button>`;
    }).join('') : '<span class="studio-hint">渠道未返回尺寸参数</span>';
  }

  function renderRatioPills(sizes) {
    const ratios = new Map();
    for (const size of sizes) {
      const ratio = ratioOf(size);
      if (ratio && !ratios.has(ratio)) ratios.set(ratio, size);
    }
    $('#gen-ratio-pills').innerHTML = Array.from(ratios.entries()).map(([ratio, size]) => {
      const [w, h] = parseSize(size);
      const iw = w >= h ? 20 : Math.max(9, Math.round(20 * w / h));
      const ih = h >= w ? 20 : Math.max(9, Math.round(20 * h / w));
      const active = ratioOf(ui.size) === ratio;
      return `<button type="button" data-size="${esc(size)}" class="${active ? 'is-active' : ''}" ${pending ? 'disabled' : ''} aria-label="${esc(ratio)}">
        <i style="width:${iw}px;height:${ih}px"></i><span>${esc(ratio)}</span></button>`;
    }).join('');
  }

  function renderModelParams() {
    const model = selectedModel();
    const qualities = model?.qualities || [];
    if (!qualities.includes(ui.quality)) {
      ui.quality = qualities.includes('auto') ? 'auto' : (qualities.includes('high') ? 'high' : qualities[0] || '');
    }
    const sizes = model?.sizes || [];
    if (!sizes.includes(ui.size) && !(model?.flexibleSize && ui.size)) ui.size = sizes[0] || '';
    $('#gen-quality').value = ui.quality;
    $('#gen-size').value = ui.size;
    $('#gen-quality-note').textContent = qualities.length ? `${qualities.length} 档可选` : '按渠道能力';
    $('#gen-size-note').textContent = model?.flexibleSize
      ? '渠道未返回尺寸表，可填写自定义 W×H；是否支持由渠道判断。'
      : sizes.length ? `渠道支持：${sizes.join(' / ')}` : '渠道未返回尺寸参数';
    renderQualityPills(qualities);
    renderResolutionPills(sizes);
    renderRatioPills(sizes);
    syncSizeInputs();
    updateSubmitState();
  }

  function updateSubmitState() {
    const model = selectedModel();
    const source = sourceJob();
    const blocked = Boolean(source && !editModelsFor(source).length);
    const validSize = Boolean(model && ui.size && (model.flexibleSize || model.sizes?.includes(ui.size)));
    const validQuality = Boolean(model && ui.quality && model.qualities?.includes(ui.quality));
    const valid = Boolean(csrf && model && validSize && validQuality &&
      $('#gen-consent').checked && !blocked && !sending);
    $('#gen-submit').disabled = sending || (!pending && !valid);
    $('#gen-submit').textContent = pending
      ? '恢复上次提交（沿用原请求）'
      : source ? '生成修改版 · 1 张' : '生成 1 张图片';
    if (blocked) formNote('当前渠道没有可用的改图模型。结束改图后可生成新图。', true);
    else if (!model) formNote('请选择可用的图像模型。', true);
    else if (!validSize) formNote('请选择渠道支持的尺寸。', true);
    else if (!validQuality) formNote('请选择渠道支持的质量。', true);
    else if (!pending) formNote('');
  }

  /* ---------------- history, results and selection ---------------- */
  function renderJobs() {
    const visible = visibleJobs();
    if (!jobs.some(job => job.id === selectedJobId)) {
      selectedJobId = (visible.find(job => job.status === 'succeeded') || visible[0] || {}).id || null;
    }
    for (const id of Array.from(checkedJobs)) {
      if (!visible.some(job => job.id === id)) checkedJobs.delete(id);
    }
    $('#gen-history-count').textContent = visible.length;
    $('#gen-select-all').textContent = visible.length && checkedJobs.size === visible.length ? '取消全选' : '全选';
    $('#gen-remove').disabled = checkedJobs.size === 0;
    $('#gen-remove').textContent = checkedJobs.size ? `移除 ${checkedJobs.size}` : '移除';
    renderHistory(visible);
    renderResults(visible);
  }

  function renderHistory(visible) {
    $('#gen-list').innerHTML = visible.length ? visible.map(job => {
      const status = statusInfo(job.status);
      const selected = job.id === selectedJobId;
      const checked = checkedJobs.has(job.id);
      const prompt = (job.prompt || '').replace(/\s+/g, ' ').slice(0, 46);
      return `<article class="studio-history-card ${selected ? 'is-active' : ''}" data-open-job="${esc(job.id)}" tabindex="0">
        <label class="studio-check" title="选择记录"><input type="checkbox" data-check-job="${esc(job.id)}" ${checked ? 'checked' : ''}><span></span></label>
        <span class="studio-history-thumb ${job.imageUrl ? 'has-image' : ''}">
          ${job.imageUrl ? `<img src="${esc(job.imageUrl)}" alt="" loading="lazy">` : `<em>${esc(status.label)}</em>`}
        </span>
        <div class="studio-history-body">
          <div class="studio-history-top"><b>${esc(prompt || '未填写提示词')}</b><span class="status-pill ${status.cls}">${status.label}</span></div>
          <div class="studio-history-meta"><span>1 张</span><span>${duration(job)}</span><span>${formatTime(job.createdAt)}</span></div>
          <small>${job.operation === 'edit' ? '改图' : '新图'} · ${esc(modelShort(job))} · ${esc(job.size || '—')}</small>
        </div>
      </article>`;
    }).join('') : '<div class="studio-empty">还没有生成记录。描述画面后生成第一张图。</div>';
  }

  function renderResults(visible) {
    const allSucceeded = visible.filter(job => job.status === 'succeeded' && job.imageUrl);
    const selected = jobs.find(job => job.id === selectedJobId) || null;
    const selectedSucceeded = selected?.status === 'succeeded' ? selected : null;
    const succeeded = (selectedSucceeded
      ? [selectedSucceeded, ...allSucceeded.filter(job => job.id !== selectedSucceeded.id)]
      : allSucceeded).slice(0, 6);
    $('#gen-result-meta').textContent = allSucceeded.length ? `${allSucceeded.length} 张成功结果` : '—';

    let html = '';
    if (selected && selected.status !== 'succeeded') {
      const status = statusInfo(selected.status);
      html += `<article class="studio-status-card">
        <div class="studio-status-head"><span class="status-pill ${status.cls}">${status.label}</span><b>${esc((selected.prompt || '').slice(0, 80))}</b></div>
        <p>${esc(selected.error?.message || '任务在服务端运行，关闭页面后仍可回来查看。')}</p>
        ${selected.status === 'unknown' ? `<button class="studio-small" type="button" data-reconcile="${esc(selected.id)}">查询 / 恢复原任务</button>` : ''}
      </article>`;
    }

    html += succeeded.length ? `<div class="studio-result-cards">${succeeded.map(job => {
      const canEdit = editModelsFor(job).length > 0;
      return `<article class="studio-result-card ${job.id === selectedJobId ? 'is-selected' : ''}" data-open-job="${esc(job.id)}">
        <div class="studio-result-image"><img src="${esc(job.imageUrl)}" alt="${esc((job.prompt || '').slice(0, 80))}" loading="eager"><span>完成</span></div>
        <div class="studio-result-body">
          <div class="studio-result-meta"><b>${esc(job.size || '—')}</b>${job.imageBytes ? `<span>${(job.imageBytes / 1024 / 1024).toFixed(1)} MB</span>` : ''}<span>${duration(job)}</span><span>${formatTime(job.createdAt)}</span></div>
          <p>${esc((job.prompt || '').replace(/\s+/g, ' ').slice(0, 90))}</p>
          <div class="studio-result-actions">
            <a class="studio-small" href="${esc(job.imageUrl)}?download=1">下载</a>
            <button class="studio-small" type="button" data-result-edit="${esc(job.id)}" ${canEdit ? '' : 'disabled title="该渠道未提供改图接口"'}>基于此图修改</button>
            <button class="studio-small" type="button" data-copy-prompt="${esc(job.id)}">复制提示词</button>
          </div>
        </div>
      </article>`;
    }).join('')}</div>` : (selected && selected.status !== 'succeeded' ? '' : '<div class="studio-empty">生成完成后，结果显示在这里。</div>');
    $('#gen-result-grid').innerHTML = html;
    $('#gen-result-note').textContent = allSucceeded.length
      ? '点击「基于此图修改」把该图作为改图源；参考图只使用已保存的生成版本。'
      : '选择历史记录查看，或生成新的图片。费用以渠道使用日志为准。';
  }

  function selectJob(id) {
    if (!jobs.some(job => job.id === id)) return;
    selectedJobId = id;
    renderJobs();
  }

  function loadHistoryJob(job) {
    if (!job || pending || sending) return;
    selectedJobId = job.id;
    sourceJobId = null;
    $('#gen-prompt').value = job.prompt || '';
    $('#gen-consent').checked = false;
    ui.modelId = job.modelId || '';
    ui.size = job.size || '';
    ui.quality = job.quality || '';
    renderSource();
    renderModelOptions(job.modelId);
    renderJobs();
    message('已载入历史记录。可以复制参数重新生成，或基于结果继续修改。');
    $('#gen-prompt').focus();
  }

  async function copyPrompt(job) {
    if (!job?.prompt) return;
    try {
      await navigator.clipboard.writeText(job.prompt);
      message('提示词已复制。');
    } catch {
      message('复制失败，请手动选择提示词文本。', true);
    }
  }

  async function reconcile(id) {
    try {
      await api(`/api/jobs/${id}/reconcile`, {});
      message('正在查询原任务；若首次响应丢失，将使用原编号和原参数恢复，不创建新的生成请求。');
      await refreshJobs();
    } catch (error) { message(error.message, true); }
  }

  /* ---------------- reference / source image ---------------- */
  function renderSource() {
    const source = sourceJob();
    $('#gen-ref-clear').hidden = !source;
    $('#gen-prompt-label').textContent = source ? '修改要求与需要保留的内容' : '提示词';
    if (!source) {
      $('#gen-source').classList.remove('has-source');
      $('#gen-source').innerHTML = '暂无参考图。可从生成结果中选择一张已生成图片作为改图源；任意图片上传尚未接入。';
      return;
    }
    $('#gen-source').classList.add('has-source');
    $('#gen-source').innerHTML = `<img src="${esc(source.imageUrl)}" alt="改图源" loading="eager"><div>
      <b>改图源 · ${esc(modelShort(source))}</b>
      <small>${esc(source.size || '—')} · 原版保留 · 供应商源图有效期为 24 小时</small>
    </div>`;
  }

  function setSource(job) {
    if (!job || job.status !== 'succeeded' || !job.imageUrl) {
      message('请先选择一张已成功的生成图片。', true);
      return;
    }
    if (!editModelsFor(job).length) {
      message('该渠道的模型只支持生图，没有可用的改图接口。', true);
      return;
    }
    sourceJobId = job.id;
    selectedJobId = job.id;
    $('#gen-prompt').value = '';
    $('#gen-consent').checked = false;
    renderSource();
    renderModelOptions(job.modelId);
    renderJobs();
    updateSubmitState();
    $('#gen-prompt').focus();
    message('已选择改图源。请输入要修改的内容和需要保留的部分。');
  }

  function clearSource() {
    sourceJobId = null;
    $('#gen-consent').checked = false;
    renderSource();
    renderModelOptions(ui.modelId);
    updateSubmitState();
    message('已结束改图，下一张将作为新图生成。');
  }

  function newImage() {
    if (pending) return;
    sourceJobId = null;
    $('#gen-prompt').value = '';
    $('#gen-consent').checked = false;
    $('#gen-form-note').textContent = '';
    renderSource();
    renderModelOptions(ui.modelId);
    updateSubmitState();
    $('#gen-prompt').focus();
  }

  /* ---------------- pending / submit ---------------- */
  function writePending(value) {
    pending = value;
    try {
      if (value) localStorage.setItem('sj:generation:pending', JSON.stringify(value));
      else localStorage.removeItem('sj:generation:pending');
    } catch {}
    const disabled = Boolean(value) || sending;
    for (const id of ['gen-model','gen-prompt','gen-width','gen-height','gen-consent','gen-ref-select','gen-ref-clear','gen-new']) {
      const el = $('#' + id);
      if (el) el.disabled = disabled;
    }
    $('#gen-ref-upload').disabled = true;
    $$('#gen-quality-pills button, #gen-resolution-pills button, #gen-ratio-pills button').forEach(button => { button.disabled = disabled; });
    updateSubmitState();
  }

  async function refreshJobs() {
    if (polling || !csrf) return;
    polling = true;
    try {
      jobs = (await api('/api/jobs')).jobs;
      if (pending && jobs.some(job => job.id === pending.requestId)) {
        writePending(null);
        message('上次提交已被服务端接收，已恢复原任务。');
      }
      if (!jobs.some(job => job.id === selectedJobId)) {
        selectedJobId = (jobs.find(job => job.status === 'succeeded') || jobs[0] || {}).id || null;
      }
      renderJobs();
    } finally { polling = false; }
  }

  async function refreshModels() {
    if (!csrf || refreshingModels) return;
    refreshingModels = true;
    try {
      renderCatalog(await api('/api/models/refresh', {}));
    } catch (error) {
      message('模型目录刷新失败：' + error.message, true);
    } finally { refreshingModels = false; }
  }

  function restorePending() {
    if (!pending) return;
    $('#gen-prompt').value = pending.prompt || '';
    sourceJobId = pending.sourceJobId || null;
    ui.modelId = pending.modelId || '';
    ui.size = pending.size || '';
    ui.quality = pending.quality || '';
    renderSource();
    renderModelOptions(pending.modelId);
    $('#gen-consent').checked = true;
    writePending(pending);
    message('有一次提交尚未确认。请恢复原请求，系统不会创建新的请求编号。', true);
  }

  async function connect(refresh = false) {
    try {
      csrf = (await api('/api/session')).csrfToken;
      renderCatalog(await api(refresh ? '/api/models/refresh' : '/api/models', refresh ? {} : undefined));
      await refreshJobs();
      if (pending) restorePending();
      else if (!pending && !$('#gen-prompt').value.trim()) {
        const latest = jobs.find(job => job.status === 'succeeded');
        if (latest) loadHistoryJob(latest);
        else message(imageModels.length
          ? '已连接。生成任务在服务端运行，关闭页面后可回来查看；不会自动切换模型或重新计费。'
          : '暂无可执行图像模型。若渠道只有视频模型，目录可见但视频执行器尚未接入。', !imageModels.length);
      }
    } catch (error) {
      $('#gen-submit').disabled = true;
      $('#gen-catalog-meta').textContent = '未连接';
      message(location.protocol === 'file:' ? '真实生图需要本地后端。请运行 npm run dev，并通过 http://127.0.0.1:4173 打开。' : error.message, true);
    }
  }

  /* ---------------- events ---------------- */
  $('#gen-model').addEventListener('change', function () {
    ui.modelId = this.value;
    renderModelParams();
    updateSubmitState();
  });

  $('#gen-quality-pills').addEventListener('click', function (event) {
    const button = event.target.closest('[data-quality]');
    if (!button || pending) return;
    ui.quality = button.dataset.quality;
    $('#gen-quality').value = ui.quality;
    renderQualityPills(selectedModel()?.qualities || []);
    updateSubmitState();
  });

  $('#gen-resolution-pills').addEventListener('click', function (event) {
    const button = event.target.closest('[data-size]');
    if (!button || pending) return;
    ui.size = button.dataset.size;
    syncSizeInputs();
    renderModelParams();
    updateSubmitState();
  });

  $('#gen-ratio-pills').addEventListener('click', function (event) {
    const button = event.target.closest('[data-size]');
    if (!button || pending) return;
    ui.size = button.dataset.size;
    syncSizeInputs();
    renderModelParams();
    updateSubmitState();
  });

  function onSizeInput() {
    const w = Number($('#gen-width').value);
    const h = Number($('#gen-height').value);
    const model = selectedModel();
    if (!w || !h || !model) {
      ui.size = '';
      $('#gen-size').value = '';
      updateSubmitState();
      return;
    }
    const candidate = `${w}x${h}`;
    if (model.flexibleSize && w >= 256 && h >= 256 && w <= 8192 && h <= 8192) {
      ui.size = candidate;
      $('#gen-size').value = candidate;
      formNote('');
      renderResolutionPills(model.sizes);
      renderRatioPills(model.sizes);
    } else if (!model.flexibleSize && model.sizes?.includes(candidate)) {
      ui.size = candidate;
      $('#gen-size').value = candidate;
      formNote('');
      renderResolutionPills(model.sizes);
      renderRatioPills(model.sizes);
    } else {
      ui.size = '';
      $('#gen-size').value = '';
      formNote(model.flexibleSize
        ? '自定义尺寸需在 256–8192 之间。'
        : `当前渠道不支持 ${w}×${h}。可选：${(model.sizes || []).join(' / ')}`, true);
    }
    updateSubmitState();
  }
  $('#gen-width').addEventListener('input', onSizeInput);
  $('#gen-height').addEventListener('input', onSizeInput);
  $('#gen-consent').addEventListener('change', updateSubmitState);
  $('#gen-prompt').addEventListener('input', () => { if ($('#gen-form-note').dataset.error === 'true') formNote(''); });
  $('#gen-prompt').addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      $('#gen-form').requestSubmit();
    }
  });

  $('#gen-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (sending || !csrf) return;
    if (!pending) {
      const model = selectedModel();
      const prompt = $('#gen-prompt').value.trim();
      if (!model || !ui.size || !ui.quality || !prompt) {
        formNote('请填写提示词并选择可用的模型、尺寸和质量。', true);
        return;
      }
      if (!model.sizes?.includes(ui.size) || !model.qualities?.includes(ui.quality)) {
        formNote('当前模型不支持所选尺寸或质量。', true);
        return;
      }
      writePending({
        requestId: crypto.randomUUID(),
        modelId: model.id,
        prompt,
        size: ui.size,
        quality: ui.quality,
        operation: sourceJobId ? 'edit' : 'generate',
        ...(sourceJobId ? { sourceJobId } : {}),
      });
    }
    sending = true;
    $('#gen-submit').disabled = true;
    formNote('');
    message('正在提交。网络中断时会保留原请求编号。');
    try {
      const job = await api('/api/jobs', pending);
      writePending(null);
      jobs = [job, ...jobs.filter(item => item.id !== job.id)];
      selectedJobId = job.id;
      $('#gen-consent').checked = false;
      renderJobs();
      message('任务已入队，每次生成或修改均为独立计费任务。生成完成后结果显示在结果区。');
    } catch (error) {
      if (['INVALID_PROMPT','INVALID_MODEL','MODEL_UNAVAILABLE','UNSUPPORTED_CAPABILITY','INVALID_SOURCE','SOURCE_EXPIRED','QUEUE_FULL'].includes(error.code)) {
        writePending(null);
      }
      message(error.message + (pending ? ' 请恢复原请求，勿另开页面重复提交。' : ''), true);
    } finally {
      sending = false;
      writePending(pending);
      updateSubmitState();
    }
  });

  $('#gen-new').addEventListener('click', newImage);
  $('#gen-ref-select').addEventListener('click', () => {
    const job = jobs.find(item => item.id === selectedJobId) || jobs.find(item => item.status === 'succeeded');
    setSource(job);
  });
  $('#gen-ref-clear').addEventListener('click', clearSource);
  $('#gen-ref-upload').addEventListener('click', () => {
    message('任意参考图上传尚未接入；目前只支持基于已生成图片修改。', true);
  });

  $('#gen-select-all').addEventListener('click', function () {
    const visible = visibleJobs();
    if (checkedJobs.size === visible.length) checkedJobs.clear();
    else visible.forEach(job => checkedJobs.add(job.id));
    renderJobs();
  });

  $('#gen-remove').addEventListener('click', function () {
    if (!checkedJobs.size) return;
    const count = checkedJobs.size;
    checkedJobs.forEach(id => hiddenJobs.add(id));
    checkedJobs.clear();
    renderJobs();
    toast(`已从当前视图移除 ${count} 条记录；服务端任务和图片仍保留。`);
  });

  $('#gen-list').addEventListener('click', async event => {
    const edit = event.target.closest('[data-result-edit]');
    if (edit) { setSource(jobs.find(job => job.id === edit.dataset.resultEdit)); return; }
    const copy = event.target.closest('[data-copy-prompt]');
    if (copy) { await copyPrompt(jobs.find(job => job.id === copy.dataset.copyPrompt)); return; }
    const reconcileBtn = event.target.closest('[data-reconcile]');
    if (reconcileBtn) { reconcileBtn.disabled = true; await reconcile(reconcileBtn.dataset.reconcile); return; }
    if (event.target.closest('.studio-check, [data-check-job]')) return;
    const open = event.target.closest('[data-open-job]');
    if (open) loadHistoryJob(jobs.find(job => job.id === open.dataset.openJob));
  });

  $('#gen-list').addEventListener('change', function (event) {
    const checkbox = event.target.closest('[data-check-job]');
    if (!checkbox) return;
    if (checkbox.checked) checkedJobs.add(checkbox.dataset.checkJob);
    else checkedJobs.delete(checkbox.dataset.checkJob);
    renderJobs();
  });

  $('#gen-list').addEventListener('keydown', function (event) {
    const card = event.target.closest('[data-open-job]');
    if (card && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      loadHistoryJob(jobs.find(job => job.id === card.dataset.openJob));
    }
  });

  $('#gen-result-grid').addEventListener('click', async event => {
    const edit = event.target.closest('[data-result-edit]');
    if (edit) { setSource(jobs.find(job => job.id === edit.dataset.resultEdit)); return; }
    const copy = event.target.closest('[data-copy-prompt]');
    if (copy) { await copyPrompt(jobs.find(job => job.id === copy.dataset.copyPrompt)); return; }
    const reconcileBtn = event.target.closest('[data-reconcile]');
    if (reconcileBtn) { reconcileBtn.disabled = true; await reconcile(reconcileBtn.dataset.reconcile); return; }
    const open = event.target.closest('[data-open-job]');
    if (open && !event.target.closest('a,button')) selectJob(open.dataset.openJob);
  });

  $('#gen-refresh').addEventListener('click', async function () {
    this.disabled = true;
    await connect(true);
    this.disabled = false;
  });

  window.addEventListener('open-generation', event => {
    if (pending) return;
    refreshModels();
    if (event.detail?.modelId && imageModels.some(m => m.id === event.detail.modelId)) {
      ui.modelId = event.detail.modelId;
      $('#gen-model').value = ui.modelId;
      renderModelParams();
    }
    message('请核对提示词、模型和参数，并确认单张费用授权后生成。项目中的模拟批次不会自动提交。');
  });
  window.addEventListener('generation-open', () => refreshModels());
  window.addEventListener('system-open', () => refreshModels());
  window.addEventListener('default-image-changed', event => {
    if (pending || sending || sourceJobId) return;
    if (imageModels.some(m => m.id === event.detail.modelId)) {
      ui.modelId = event.detail.modelId;
      $('#gen-model').value = ui.modelId;
      renderModelParams();
    }
  });

  /* ---------------- channel management ---------------- */
  const channelDialog = $('#channel-dialog');
  const channelForm = $('#channel-form');
  if (channelDialog && channelForm) {
    const testStatus = $('#channel-test');
    const submit = $('#channel-submit');
    const setStatus = (text, error = false) => {
      testStatus.textContent = text;
      testStatus.dataset.error = String(error);
    };
    $('#add-channel').addEventListener('click', () => {
      setStatus('');
      channelDialog.showModal();
      channelForm.elements.name.focus();
    });
    for (const close of channelDialog.querySelectorAll('[data-close-channel]')) {
      close.addEventListener('click', () => channelDialog.close());
    }
    channelDialog.addEventListener('click', event => {
      if (event.target === channelDialog) channelDialog.close();
    });
    channelDialog.addEventListener('close', () => {
      channelForm.reset();
      setStatus('');
      submit.disabled = false;
      submit.textContent = '测试并保存';
    });
    channelForm.addEventListener('submit', async event => {
      event.preventDefault();
      if (location.protocol === 'file:') {
        setStatus('请先运行 npm run dev，并通过 http://127.0.0.1:4173 打开后再新增渠道。', true);
        return;
      }
      if (!csrf) {
        setStatus('正在建立本机会话…');
        await connect();
      }
      if (!csrf) {
        setStatus('无法建立本机会话，请刷新页面后重试。', true);
        return;
      }
      const data = new FormData(channelForm);
      submit.disabled = true;
      submit.textContent = '连接并读取模型中…';
      setStatus('正在请求模型列表并测试连接…');
      try {
        const result = await api('/api/channels', {
          name: data.get('name'),
          baseUrl: data.get('baseUrl'),
          apiKey: data.get('apiKey'),
        });
        channelDialog.close();
        await connect(true);
        toast(result.warning || '渠道已保存，模型目录已刷新');
      } catch (error) {
        setStatus(error.message, true);
      } finally {
        submit.disabled = false;
        submit.textContent = '测试并保存';
      }
    });
    $('#sys-refresh').addEventListener('click', async function () {
      this.disabled = true;
      try {
        await connect(true);
        toast('模型目录已刷新');
      } finally { this.disabled = false; }
    });
    $('#channel-list').addEventListener('click', async event => {
      const remove = event.target.closest('[data-channel-delete]');
      if (remove) {
        const name = remove.dataset.name || '这个渠道';
        if (!window.confirm(`删除渠道「${name}」？已保存的图片和任务不会删除。`)) return;
        remove.disabled = true;
        try {
          await api('/api/channels/' + encodeURIComponent(remove.dataset.channelDelete), undefined, 'DELETE');
          await connect(true);
          toast('渠道已删除');
        } catch (error) { toast(error.message); }
        finally { remove.disabled = false; }
        return;
      }
      const toggle = event.target.closest('[data-channel-toggle]');
      if (toggle) {
        const enabled = toggle.dataset.enabled === 'true';
        toggle.disabled = true;
        try {
          await api('/api/channels/' + encodeURIComponent(toggle.dataset.channelToggle) + '/enabled', { enabled: !enabled });
          await connect(true);
          toast(enabled ? '渠道已停用，不再参与新任务' : '渠道已启用');
        } catch (error) { toast(error.message); }
        finally { toggle.disabled = false; }
      }
    });
  }

  try { pending = JSON.parse(localStorage.getItem('sj:generation:pending') || 'null'); } catch { pending = null; }
  connect();
  setInterval(() => refreshJobs().catch(() => {
    message('暂时无法读取任务状态。任务不会因此重新提交，请稍后刷新。', true);
  }), 5000);
})();

/* Unified functional review. All mutations below are browser-local demonstrations.
   Existing provider execution stays in the explicitly labelled real single-image panel. */
window.addEventListener('DOMContentLoaded', () => {
  'use strict';
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const apiProducts = window.productPrototype;
  const KEY = 'sj:prototype:review:v1';
  const steps = ['商品资料','方案报价','制作任务','精修','质检审核','打包导出'];
  // Task type library and workflow node demo (FLOW-13—17). Planning is deterministic; nothing calls a model.
  const TYPES = {
    white:{name:'白底主图 / 多角度',kind:'',ratio:'1:1',chain:['generate'],hint:'纯白背景、柔和投影'},
    scene:{name:'场景图',kind:'scene',ratio:'3:4',chain:['generate'],hint:'自然家居场景、柔和日光'},
    selling:{name:'卖点 / 促销图',kind:'selling',ratio:'1:1',chain:['generate','composite'],hint:'留出文案排版空间'},
    detail:{name:'细节 / 尺寸 / 包装清单',kind:'selling',ratio:'3:4',chain:['generate','composite'],hint:'细节特写，留出尺寸标注区域'},
    extension:{name:'AI 扩展建议',kind:'scene',ratio:'1:1',chain:['generate'],hint:'按建议意图构图'}
  };
  const NODE = {prompt:'文本提示词',generate:'生图',edit:'改图',composite:'模板合成'};
  const NODE_STATUS = {idle:'待执行',done:'已生成 · 记成本',running:'执行中',succeeded:'成功',failed:'明确失败',unknown:'状态未知',skipped:'已停止 · 释放预占'};
  const NODE_PRICE = {prompt:0,generate:1.2,edit:1.2,composite:0};
  const defaultPlan = [['white','白底主图'],['scene','自然光场景'],['scene','家居陈列'],['selling','容量卖点'],['selling','叠放卖点']];
  const stamp = () => new Date().toLocaleString('zh-CN', {hour12:false});
  const money = n => '¥' + Number(n || 0).toFixed(2);
  const tag = (text, type='') => `<span class="rv-tag ${type}">${esc(text)}</span>`;
  const btn = (text, action, extra='', primary=false) => `<button type="button" class="btn ${primary?'primary':''}" data-rv="${action}" ${extra}>${text}</button>`;
  const product = id => apiProducts.list().find(p => p.id === id);
  const picture = (p, kind='', large=false) => `<div class="rv-art ${kind} ${large?'rv-edit-canvas':''}">${apiProducts.art(p || product('sample-box') || {})}<span class="rv-art-label">交互示意 · 非生成结果</span></div>`;
  const makeFlow = (type, model='演示图像模型') => {
    const flow=[{id:'n1',type:'prompt',status:'idle'}];
    TYPES[type].chain.forEach(t=>flow.push({id:'n'+(flow.length+1),type:t,from:flow.at(-1).id,model:t==='composite'?'':model,status:'idle'}));
    return flow;
  };
  const makeItem = (id,type,name,prompt) => ({id,type,name,kind:TYPES[type].kind,status:'idle',versions:[],candidate:null,approved:false,checks:[],
    prompt:prompt||`以已确认商品为唯一主体，${TYPES[type].hint}。保留商品形状、颜色和已确认参数，不添加文字或虚构卖点。`,
    model:'演示图像模型',size:'1024 × 1024',ratio:TYPES[type].ratio,price:1.2,flow:makeFlow(type)});
  const baseItems = () => defaultPlan.map(([type,name],i) => makeItem(i,type,name));
  const seedProduct = product('sample-box') || apiProducts.list()[0];
  // Older saved demos had fixed items without workflows; derive a workflow from the item outcome.
  function syncLegacy(d){
    const gen=d.flow.find(n=>n.type==='generate');d.flow[0].status='done';
    if(d.status==='succeeded')d.flow.forEach(n=>{if(n.type!=='prompt')n.status='succeeded';});
    else if(d.status==='failed'){gen.status='failed';lane(d,gen).slice(1).forEach(n=>n.status='skipped');}
    else if(d.status==='unknown'||d.status==='running')gen.status='unknown';
  }
  function normalize(p){
    p.planVersion??=1;p.suggestions??=[];p.requirement??='';
    p.items.forEach((d,i)=>{
      if(!d.type)d.type=d.kind==='scene'?'scene':d.kind==='selling'?'selling':'white';
      d.ratio??=TYPES[d.type].ratio;d.planVersion??=1;
      if(!d.flow){d.flow=makeFlow(d.type,d.model);if(p.planReady)syncLegacy(d);}
      if(p.frozen&&d.status!=='idle')d.frozen=true;
    });
    return p;
  }
  const seededProject = (id,name,stage) => {
    const items = baseItems();
    if (stage>3) items.forEach(d => { d.status='succeeded';d.versions=[{id:1,type:'首次生成',time:'示例记录'}];d.candidate=1; });
    if (stage===3) { items[0].status='succeeded';items[0].versions=[{id:1,type:'首次生成',time:'示例记录'}]; items[1].status='failed';items[2].status='unknown'; }
    if (stage>2) items.forEach(d=>{if(d.status!=='idle')syncLegacy(d);else d.flow[0].status='done';});
    return normalize({id,name,productId:seedProduct?.id,snapshot:stage>2?structuredClone(seedProduct):null,prechecked:stage>1,planReady:stage>2,frozen:stage>2,items,owner:'林晓',sample:true,events:[],exported:false});
  };
  let data = {projects:[seededProject('demo-spring','白色收纳盒 · 秋日上新',3),seededProject('demo-studio','白色收纳盒 · 主图升级',5),seededProject('demo-draft','家居收纳 · 场景企划',1)],
    users:[{id:'admin',name:'林晓',account:'admin',role:'管理员',enabled:true},{id:'operator',name:'陈言',account:'chenyan',role:'运营',enabled:true},{id:'viewer',name:'许一',account:'xuyi',role:'只读',enabled:true}],
    ledger:[{id:'seed-recharge',label:'演示初始充值',amount:500,time:'示例记录',type:'充值'}],logs:[],prices:[],role:'管理员'};
  data.projects.forEach(p=>p.items.filter(d=>d.status==='succeeded').forEach(d=>data.ledger.push({id:'seed-'+p.id+'-'+d.id,projectId:p.id,label:p.name+' / '+d.name+' / 示例历史',amount:-d.price,time:'示例记录',type:'生成'})));
  try { const saved=JSON.parse(localStorage.getItem(KEY)||'null'); if(saved?.projects?.length && Array.isArray(saved.users)&&Array.isArray(saved.ledger)) data=saved; } catch {}
  data.flowTemplates??=[];data.projects.forEach(normalize);
  // A reload interrupts local animation, not proof that a task succeeded or failed.
  data.projects.forEach(p=>p.items.forEach(d=>{if(d.status==='running'){d.status='unknown';d.flow.forEach(n=>{if(n.status==='running')n.status=n.type==='generate'?'unknown':'idle';});}}));
  let page='dashboard', tab='users', projectId=data.projects[0].id, step=3, itemId=0, assetTab='outputs', assetFilter='all', projectFilter='all', projectQuery='', assetQuery='', projectView='steps';
  let realJobs=[], realError='', realLoaded=false, realLoading=false, selectedVersion=1, dialogCleanup=null, lastRenderKey='';
  const view=document.createElement('section');view.className='view rv';view.dataset.view='review';$('.stage').append(view);
  const dialog=document.createElement('dialog');dialog.className='rv rv-dialog';dialog.id='rv-dialog';dialog.setAttribute('aria-labelledby','rv-dialog-title');document.body.append(dialog);
  dialog.addEventListener('close',()=>{if(!dialog.open){if(dialogCleanup)dialogCleanup();dialogCleanup=null;}});
  const P=()=>data.projects.find(p=>p.id===projectId)||data.projects[0];
  function save(){try{localStorage.setItem(KEY,JSON.stringify(data));}catch{notify('本地空间不足，改动仅在本次页面保留。');}}
  function log(action,object){data.logs.unshift({id:crypto.randomUUID(),action,object,time:stamp(),actor:'林晓'});data.logs=data.logs.slice(0,100);save();}
  function notify(text){$('#toast').textContent=text;$('#toast').classList.add('is-on');setTimeout(()=>$('#toast').classList.remove('is-on'),3200);}
  function modal(title,body){if(dialogCleanup)dialogCleanup();dialogCleanup=null;if(dialog.open)dialog.close();dialog.innerHTML=`<div class="rv-dialog-head"><h2 id="rv-dialog-title">${title}</h2><button type="button" data-rv="close" aria-label="关闭">×</button></div><div class="rv-dialog-content">${body}<div class="rv-message" id="rv-message" role="alert"></div></div>`;dialog.showModal();}
  function error(text){$('#rv-message').textContent=text;}
  function current(p){
    if(!p.prechecked)return 1;if(!p.frozen)return 2;
    if(p.items.some(d=>d.status!=='succeeded'))return 3;
    if(p.items.some(d=>!d.candidate))return 4;
    if(p.items.some(d=>!d.approved))return 5;
    return 6;
  }
  function completed(p){return p.exported?6:current(p)-1;}
  function totalCost(p){return data.ledger.filter(l=>l.projectId===p.id&&l.type==='生成').reduce((sum,l)=>sum-l.amount,0);}
  function charge(p,d,label,amount=d.price){data.ledger.unshift({id:crypto.randomUUID(),projectId:p.id,label:`${p.name} / ${d.name} / ${label}`,amount:-amount,time:stamp(),type:'生成'});}
  // A branch is one generate node followed by its single-child chain of edit / composite nodes.
  function lane(d,start){const out=[start];let n=start;while((n=d.flow.find(x=>x.from===n.id&&x.type!=='generate')))out.push(n);return out;}
  const lanes=d=>d.flow.filter(n=>n.type==='generate').map(g=>lane(d,g));
  const estimate=d=>d.flow.filter(n=>['idle','failed','skipped'].includes(n.status)).reduce((s,n)=>s+NODE_PRICE[n.type],0);
  const fullPrice=d=>d.flow.reduce((s,n)=>s+NODE_PRICE[n.type],0);
  const chainText=d=>{const l=lanes(d);return ['提示词',...(l[0]||[]).map(n=>NODE[n.type])].join(' → ')+(l.length>1?` · ${l.length} 个分支`:'');};
  const nextNodeId=d=>'n'+(Math.max(0,...d.flow.map(n=>Number(n.id.slice(1))||0))+1);
  // Runs every unfinished branch of a confirmed workflow. Failure stops that branch; no automatic retry.
  function runItem(p,d,fail,label='首次生成'){
    d.flow.filter(n=>n.type==='generate'&&n.status!=='succeeded').forEach(g=>{
      const chain=lane(d,g);
      if(fail){g.status='failed';chain.slice(1).forEach(n=>n.status='skipped');return;}
      chain.forEach(n=>{
        if(n.status==='succeeded')return;
        n.status='succeeded';
        const type=n.type==='generate'?label:NODE[n.type];
        d.versions.push({id:d.versions.length+1,type,time:stamp(),node:n.id});
        if(NODE_PRICE[n.type])charge(p,d,type,NODE_PRICE[n.type]);
      });
    });
    const gens=d.flow.filter(n=>n.type==='generate');
    d.status=gens.some(n=>n.status==='succeeded')?'succeeded':gens.some(n=>n.status==='unknown')?'unknown':'failed';
    d.approved=false;d.checks=[];
  }
  function header(title,desc,actions=''){return `<div class="rv-head"><div><h1>${title}</h1><p>${desc}</p></div><div class="rv-actions">${actions}</div></div>`;}
  function top(nav,title){
    $('.frame').classList.add('is-list');
    $$('.view').forEach(v=>v.hidden=v!==view);
    $('#back-to-projects').hidden=true;$('#crumb-current-wrap').hidden=true;
    $('#crumb-projects').textContent=({dashboard:'工作台',projects:'项目',products:'商品',assets:'素材',system:'系统'})[nav]||'项目';
    $('#crumb-projects').dataset.screen=nav;
    $('#top-title').textContent=title;$('#top-meta').textContent='商境 / 家居内容团队';
    $('.proto-tag').textContent='功能评审原型';
    $('#budget-chip').textContent='演示环境 · 不产生费用';
    $$('.rail-btn').forEach(b=>{const on=b.dataset.nav===nav;b.classList.toggle('is-active',on);if(on)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
    $$('.gen-mobile-nav button').forEach(b=>{if(b.dataset.screen===nav)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
  }
  function route(next,options={}){
    page=next;
    if(options.tab)tab=options.tab;
    if(next==='products'){
      window.workbench.showScreen('products');$('#top-meta').textContent='手动 / 截图 / 1688 链接';
      $('.proto-tag').textContent='本地商品原型';$('#budget-chip').textContent='资料保存在当前浏览器';
    }else{render();}
    window.scrollTo({top:0,behavior:'instant'});
    if(next==='assets'&&!realLoaded)loadAssets();
  }
  function render(){
    if(page==='products')return;
    const titles={dashboard:'工作台',projects:'项目',project:'项目生产',assets:'素材库',system:'系统管理'};
    top(page==='project'?'projects':page,titles[page]||'工作台');
    view.innerHTML=page==='dashboard'?home():page==='projects'?projects():page==='project'?projectPage():page==='assets'?assetsPage():systemPage();
    const key=page+':'+(page==='project'?projectId+':'+step+':'+projectView:'');
    if(key!==lastRenderKey)window.scrollTo({top:0,behavior:'instant'});
    lastRenderKey=key;
  }
  function projectTable(list){
    return `<div class="rv-table-wrap"><table class="rv-table"><thead><tr><th>项目 / 商品</th><th>当前步骤</th><th>步骤进度</th><th>负责人</th><th>演示费用</th><th></th></tr></thead><tbody>${list.map(p=>`<tr><td><button class="rv-link" data-rv="open-project" data-id="${esc(p.id)}">${esc(p.name)}</button><small>${esc((p.snapshot||product(p.productId))?.sku||'SKU 待补充')}</small></td><td>${tag(p.exported?'已完成':steps[current(p)-1],current(p)===5?'warn':'')}</td><td>${completed(p)} / 6 步<div class="rv-progress">${steps.map((_,i)=>`<i class="${i<completed(p)?'done':''}"></i>`).join('')}</div></td><td>${esc(p.owner)}</td><td>${money(totalCost(p))}</td><td>${btn('进入','open-project',`data-id="${esc(p.id)}"`)}</td></tr>`).join('')}</tbody></table></div>`;
  }
  function home(){
    const waiting=data.projects.filter(p=>current(p)===5).length;
    return header('从商品，到一套好内容。','在同一个项目里完成方案、制作、精修与交付。',btn('＋ 新建项目','new-project','',true))+
      `<div class="rv-home-grid"><section class="rv-feature"><div class="rv-feature-copy">${tag('继续创作','ink')}<h2>${esc(P().name)}</h2><p>${esc((P().snapshot||product(P().productId))?.name)}，AI 规划套图交付项，每个交付项按工作流推进。</p><div class="rv-actions">${btn('继续项目','open-project',`data-id="${esc(P().id)}"`,true)}<small>当前：${steps[current(P())-1]}</small></div></div><div class="rv-feature-art">${apiProducts.art(seedProduct||{})}<span>商品示意 · 用于流程评审</span></div></section>
      <section class="rv-panel"><div class="rv-panel-title"><h2>需要你确认</h2>${tag('演示待办')}</div>
      <button class="rv-todo" data-rv="nav" data-page="products"><span><b>核实商品资料</b><small>规格、价格与来源证据</small></span><em>${apiProducts.list().filter(p=>p.status==='pending').length}</em></button>
      <button class="rv-todo" data-rv="nav" data-page="projects"><span><b>审核交付候选</b><small>检查文字与商品保真</small></span><em>${waiting}</em></button>
      <button class="rv-todo" data-rv="open-project" data-id="${esc(data.projects.find(p=>p.items.some(d=>d.status==='unknown'))?.id||P().id)}"><span><b>核对未知任务</b><small>查询原请求，不重复生成</small></span><em>${data.projects.reduce((n,p)=>n+p.items.filter(d=>d.status==='unknown').length,0)}</em></button></section></div>
      <div class="rv-metrics"><div class="rv-metric"><span>演示项目</span><strong>${data.projects.length}</strong><small>一个商品 / 一个 SKU</small></div><div class="rv-metric"><span>待审核项目</span><strong>${waiting}</strong><small>候选版本已选定</small></div><div class="rv-metric"><span>演示成功版本</span><strong>${data.projects.reduce((n,p)=>n+p.items.reduce((m,d)=>m+d.versions.length,0),0)}</strong><small>示意图不计入真实素材</small></div><div class="rv-metric"><span>演示累计生成费用</span><strong>${money(data.ledger.filter(l=>l.type==='生成').reduce((n,l)=>n-l.amount,0))}</strong><small>与系统演示账本同源</small></div></div>
      <section class="rv-panel"><div class="rv-panel-title"><h2>最近项目</h2>${btn('全部项目','nav','data-page="projects"')}</div>${projectTable(data.projects.slice(0,4))}</section>
      <p class="muted" style="margin-top:18px;font-size:12px">当前展示本地演示项目。真实历史图片请到「素材」查看；新增流程不会调用模型或扣费。</p>`;
  }
  function projects(){
    const list=data.projects.filter(p=>(projectFilter==='all'||(projectFilter==='review'?current(p)===5:projectFilter==='complete'?p.exported:!p.exported))&&p.name.toLowerCase().includes(projectQuery.toLowerCase()));
    return header('项目','把一次交付的资料、方案与每张图的版本放在一起。',btn('＋ 新建项目','new-project','',true))+
      `<div class="rv-toolbar"><div class="rv-tabs">${[['all','全部项目'],['active','进行中'],['review','待审核'],['complete','已完成']].map(([k,n])=>`<button data-rv="project-filter" data-id="${k}" class="${projectFilter===k?'active':''}">${n}</button>`).join('')}</div><input class="rv-search" id="rv-project-search" aria-label="搜索项目" placeholder="搜索项目名称" value="${esc(projectQuery)}"></div>
      <section class="rv-panel">${list.length?projectTable(list):'<div class="rv-empty">没有匹配的项目，换个关键词或新建项目。</div>'}</section>`;
  }
  function projectPage(){
    const p=P(), facts=p.snapshot||product(p.productId), index=current(p);
    const views=`<div class="rv-tabs rv-view-switch" role="group" aria-label="项目视图">${[['steps','六步视图'],['canvas','画布视图']].map(([k,n])=>`<button data-rv="project-view" data-id="${k}" class="${projectView===k?'active':''}" aria-pressed="${projectView===k}">${n}</button>`).join('')}</div>`;
    return header(esc(p.name),`${esc(facts?.name||'未关联商品')} / ${esc(facts?.sku||'SKU 待补充')} / ${completed(p)} / 6 步`,views+btn('返回项目','nav','data-page="projects"'))+
      `<div class="rv-steps">${steps.map((s,i)=>`<button data-rv="step" data-id="${i+1}" class="${projectView==='steps'&&step===i+1?'active':''}" ${projectView==='steps'&&step===i+1?'aria-current="step"':''}><b>0${i+1}</b>${s}<small>${p.exported||i+1<index?'已完成':i+1===index?'当前待办':'待完成'}</small></button>`).join('')}</div>
      <div class="rv-banner">流程演示 · 所有任务、价格、审核均保存在本浏览器，不调用模型。${p.frozen?`已冻结商品 v${p.snapshot?.version||1} 与方案 v${p.planVersion}。`:'确认方案后冻结本次商品资料、提示词与价格。'} ${p.sourceAsset?'已引用历史素材，仅保存引用，不提交改图。':''}</div>
      ${projectView==='canvas'?canvasView(p):step===1?stepOne(p,facts):step===2?stepTwo(p):step===3?stepThree(p):step===4?stepFour(p):step===5?stepFive(p):stepSix(p)}`;
  }
  // Deterministic stand-in for the text-model planner: type library + keyword hints + fact guard.
  function planDemo(p){
    const facts=product(p.productId)||{},req=p.requirement||'';
    const plan=defaultPlan.map(([type,name])=>[type,name]);
    if(/尺寸|细节|包装|规格|清单/.test(req))plan.push(['detail','尺寸与细节']);
    if(/户外|场景|氛围|生活/.test(req))plan.push(['scene','补充场景']);
    const known=[facts.name,facts.selling,facts.desc,...(facts.params||[]).flat()].join(' ');
    const claims=['防水','防摔','认证','食品级','环保','抗菌','承重','静音'].filter(w=>req.includes(w)&&!known.includes(w));
    const suggestions=[{name:'使用前后对比',hint:'同一空间整理前后对比，商品为唯一新增物品'},{name:'多件组合搭配',hint:'同款多件组合陈列，保持比例真实'}];
    return {plan:plan.slice(0,10),claims,suggestions};
  }
  function workflowRows(p,d){return lanes(d).map((l,i)=>`<span>${i?'分支 '+(i+1)+'：':''}${['提示词',...l.map(n=>NODE[n.type])].join(' → ')}</span>`).join('');}
  function canvasView(p){
    const mobileNote='<p class="rv-banner rv-canvas-mobile">手机端画布只读；编辑节点请使用桌面端，或切换到六步视图。</p>';
    const lockedNode=(title,state,stepNo)=>`<button class="rv-node locked" data-rv="canvas-step" data-id="${stepNo}"><small>锁定节点 · 0${stepNo}</small><b>${title}</b><em>${state}</em></button>`;
    const passed=p.items.filter(d=>d.approved).length;
    const node=(d,n)=>{
      const editable=!d.frozen&&n.status==='idle'&&n.type!=='prompt'&&!(n.type==='generate'&&d.flow.filter(x=>x.type==='generate').length===1);
      const modelPick=['generate','edit'].includes(n.type)?`<select class="rv-canvas-edit" aria-label="${esc(d.name)} ${NODE[n.type]}模型" data-node-model="${d.id}:${n.id}" ${d.frozen||n.status!=='idle'?'disabled':''}>${modelOptions(n.model||d.model)}</select>`:'';
      return `<div class="rv-node ${n.type} is-${n.status}"><small>${NODE[n.type]}${NODE_PRICE[n.type]?' · '+money(NODE_PRICE[n.type]):n.type==='prompt'?' · 只记成本':' · 不收生成费'}</small><b>${n.type==='prompt'?esc(d.prompt.slice(0,26))+'…':n.type==='composite'?'文案 / Logo 排版':esc(n.model||d.model)}</b>${modelPick}<em>${NODE_STATUS[n.status]}</em>${editable?`<button class="rv-node-del rv-canvas-edit" data-rv="node-delete" data-id="${d.id}" data-node="${n.id}" aria-label="删除节点">×</button>`:''}</div>`;
    };
    const group=d=>{
      const ls=lanes(d),prompt=d.flow[0];
      return `<details class="rv-flow-group" open><summary><b>${esc(d.name)}</b>${tag(TYPES[d.type].name,d.type==='extension'?'warn':'')}${d.planVersion>1?tag('方案 v'+d.planVersion):''}<small>${d.ratio} · 预估 ${money(fullPrice(d))} · ${d.versions.length} 个版本${d.candidate?' · 候选 v'+d.candidate:''}</small></summary>
        <div class="rv-flow-body"><div class="rv-flow-col">${node(d,prompt)}</div><div class="rv-flow-lanes">${ls.map(l=>`<div class="rv-flow-lane">${l.map(n=>node(d,n)).join('<i class="rv-arrow" aria-hidden="true">→</i>')}${!d.frozen?`<label class="rv-canvas-edit rv-add-node"><select aria-label="在此分支末尾追加节点" data-add-node="${d.id}:${l.at(-1).id}"><option value="">＋ 节点</option><option value="edit">改图</option><option value="composite">模板合成</option></select></label>`:''}</div>`).join('')}</div></div>
        <div class="rv-flow-tools rv-canvas-edit">${d.frozen?'<small>已执行节点锁定；新改动请在 04 精修，或追加交付项形成新方案版本。</small>':`${btn('＋ 并行出图分支','add-branch',`data-id="${d.id}" ${ls.length>=3?'disabled':''}`)}${btn('另存为模板','save-template',`data-id="${d.id}"`)}<small>每个交付项最多 3 个分支；分支各自成版本，候选需显式选定。</small>`}</div></details>`;
    };
    return `${mobileNote}<section class="rv-panel rv-canvas"><div class="rv-panel-title"><div><h2>项目工作流</h2><small>与六步视图同一份数据。锁定节点不可删除或绕过；节点只能从左到右连接，不支持循环。</small></div>${tag('简化画布 · 原型')}</div>
      <div class="rv-flow-locked">${lockedNode('商品资料',p.prechecked?'预检通过':'待预检',1)}<i class="rv-arrow" aria-hidden="true">→</i>${lockedNode('AI 规划 / 方案确认',p.frozen?'方案 v'+p.planVersion+' 已确认':p.planReady?'草稿待确认':'未规划',2)}</div>
      ${p.planReady?p.items.map(group).join(''):'<div class="rv-empty">在 02 输入补充要求并点击「AI 规划交付项」后，这里会出现每个交付项的工作流。</div>'}
      <div class="rv-flow-locked">${lockedNode('审核',`${passed} / ${p.items.length} 通过`,5)}<i class="rv-arrow" aria-hidden="true">→</i>${lockedNode('导出',p.exported?'已导出':'待导出',6)}</div></section>`;
  }
  function stepOne(p,facts){
    return `<div class="rv-split"><section class="rv-panel"><h2>本次生产的商品</h2><label class="rv-field">选择商品 / 单一 SKU<select id="rv-project-product" ${p.frozen?'disabled':''}>${apiProducts.list().map(x=>`<option value="${esc(x.id)}" ${p.productId===x.id?'selected':''}>${esc(x.name)} · ${esc(x.sku||'SKU 未填写')} · ${x.status==='confirmed'?'已确认':'待完善'}</option>`).join('')}</select></label>
      <dl class="rv-facts"><div><dt>资料版本</dt><dd>v${facts?.version||1}${p.frozen?' · 已冻结':''}</dd></div><div><dt>价格</dt><dd>${facts?.price?esc(facts.currency+' '+facts.price):'未录入'}</dd></div>${(facts?.params||[]).map(r=>`<div><dt>${esc(r[0])}</dt><dd>${esc(r[1])} ${esc(r[2])}</dd></div>`).join('')}</dl>
      <h3>已确认卖点</h3><p>${esc(facts?.selling||'尚未录入，不由模型补造。').replace(/\n/g,'<br>')}</p><h3>创作约束</h3><p class="muted">保留商品形状、颜色与规格；不添加未确认的材质、容量、认证或价格。</p>
      ${p.frozen?'<p class="rv-banner">历史项目保持冻结版本；新资料请新建项目预览。</p>':btn('打开商品资料','open-product',`data-id="${esc(p.productId||'')}"`)}</section>
      <aside class="rv-panel">${picture(facts)}<h3 style="margin-top:18px">生产前检查</h3><p class="muted">${facts?.image?'已选择本地商品原图，尚未传给模型。':p.sample?'当前使用演示商品示意图，仅供流程评审。':'缺少原始商品主图，请到商品编辑中上传。'}</p>
      <label class="rv-check"><input id="rv-precheck" type="checkbox" ${p.prechecked?'checked':''} ${p.frozen?'disabled':''}>已核对当前 SKU、关键事实及原图；截图仅用于来源证据。</label>
      ${btn(p.prechecked?'进入方案':'确认资料，进入方案','precheck','',true)}</aside></div>`;
  }
  function modelOptions(selected){return [...new Set(['演示图像模型',...Array.from($('#gen-model')?.options||[]).map(x=>x.textContent).filter(x=>!x.includes('加载')&&!x.includes('暂无')),selected].filter(Boolean))].map(m=>`<option ${selected===m?'selected':''}>${esc(m)}</option>`).join('');}
  function stepTwo(p){
    if(!p.prechecked)return `<div class="rv-empty"><h2>先确认本次商品资料</h2><p>商品原图、SKU 和事实核实后，才能准备方案。</p>${btn('返回商品资料','step','data-id="1"',true)}</div>`;
    const typeOptions=[...Object.entries(TYPES).filter(([k])=>k!=='extension').map(([k,t])=>`<option value="${k}">${t.name}</option>`),...data.flowTemplates.map(t=>`<option value="tpl:${esc(t.id)}">模板 · ${esc(t.name)}</option>`)].join('');
    const full=p.items.length>=10;
    return `<section class="rv-panel"><div class="rv-panel-title"><div><h2>AI 规划交付项清单</h2><small>按商品资料和补充要求，在交付项类型库内规划 · 规划与提示词只记成本 · 每个方案最多 10 个交付项</small></div>${btn(p.planReady?'重新规划':'AI 规划交付项','suggest-plan',p.frozen?'disabled':'',true)}</div>
      <label class="rv-field">补充要求（可选）<textarea id="rv-requirement" maxlength="300" placeholder="例如：突出尺寸和收纳细节，多做一张生活场景" ${p.frozen?'disabled':''}>${esc(p.requirement)}</textarea></label>
      ${p.claims?.length?`<div class="rv-banner warning" style="margin-top:14px">补充要求提到「${p.claims.map(esc).join('、')}」，商品资料中没有对应事实，已标为待核实，不写入正式提示词。请先在商品中补充并确认。</div>`:''}
      ${!p.planReady?'<div class="rv-empty" style="margin-top:18px">点击「AI 规划交付项」，生成可编辑的交付项清单。演示使用确定性规划，不调用文本模型；规划结果不会自动执行。</div>':`
      <div class="rv-toolbar"><label class="rv-field">方案默认模型<select id="rv-default-model" ${p.frozen?'disabled':''}>${modelOptions(p.defaultModel||'演示图像模型')}</select></label><span class="muted">可改提示词、逐项覆盖模型；工作流节点在画布视图中编辑。</span></div>
      ${p.items.map((d,i)=>`<div class="rv-plan-row"><b>${String(i+1).padStart(2,'0')}</b><div><h3>${esc(d.name)} ${tag(TYPES[d.type].name,d.type==='extension'?'warn':'')}${d.planVersion>1?' '+tag('方案 v'+d.planVersion):''}</h3><textarea aria-label="${esc(d.name)}提示词" data-plan-prompt="${d.id}" ${d.frozen?'disabled':''}>${esc(d.prompt)}</textarea><div class="rv-chain">${workflowRows(p,d)}</div></div><label class="rv-field">图像模型<select data-plan-model="${d.id}" ${d.frozen?'disabled':''}>${modelOptions(d.model)}</select><span>${d.ratio} / ${d.size}</span></label><span>${money(fullPrice(d))}<small style="display:block">演示预估</small>${!p.frozen?btn('移除','remove-task',`data-id="${d.id}"`):''}</span></div>`).join('')}
      <div class="rv-toolbar"><label class="rv-field">${p.frozen?'追加交付项（形成新方案版本）':'从类型库添加交付项'}<select id="rv-add-type" ${full?'disabled':''}>${typeOptions}</select></label>${btn(p.frozen?'追加到方案 v'+(p.planVersion+1):'添加交付项','add-task',full?'disabled':'')}</div>
      ${p.suggestions.length?`<div class="rv-suggest"><h3>AI 扩展建议 ${tag('类型库外 · 采纳后才加入','warn')}</h3>${p.suggestions.map((s,i)=>`<div class="rv-todo"><span><b>${esc(s.name)}</b><small>${esc(s.hint)}</small></span>${btn('采纳','adopt-suggestion',`data-id="${i}" ${full?'disabled':''}`)}</div>`).join('')}</div>`:''}
      <div class="rv-bottom"><span>${tag('视频 · 执行未接入')} <small>不创建任务、不计入报价</small></span><b>演示总价 ${money(p.items.reduce((n,d)=>n+fullPrice(d),0))}</b></div>
      <div class="rv-bottom"><small>确认冻结资料、提示词与参数；下一步在 03 逐节点估价并一次确认开跑。</small>${btn(p.frozen?'查看制作任务':'确认方案与报价','freeze-plan','',true)}</div>`}</section>`;
  }
  function stepThree(p){
    if(!p.frozen)return `<div class="rv-empty"><h2>方案尚未确认</h2><p>先冻结资料、提示词、模型参数与报价。</p>${btn('返回方案','step','data-id="2"',true)}</div>`;
    const labels={idle:'未开始',running:'制作中',succeeded:'成功',failed:'明确失败',unknown:'状态未知'};
    const successCount=p.items.filter(d=>d.status==='succeeded').length;
    return `<section class="rv-panel"><div class="rv-panel-title"><div><h2>每个交付项，按工作流推进</h2><small>${successCount} / ${p.items.length} 个交付项有成功版本 · 成功后即可精修，批次未完仍停留 03</small></div>${btn('估价并确认开跑','run-batch',p.items.some(d=>d.status==='idle')?'':'disabled',true)}</div>
      <div class="rv-table-wrap"><table class="rv-table"><thead><tr><th>交付项</th><th>工作流 / 模型</th><th>状态</th><th>费用口径</th><th>操作</th></tr></thead><tbody>${p.items.map(d=>`<tr><td><b>${esc(d.name)}</b><small>${esc(TYPES[d.type].name)} · ${d.versions.length} 个版本</small></td><td>${esc(chainText(d))}<small>${esc(d.model)} · ${d.ratio}</small></td><td>${tag(labels[d.status],d.status==='succeeded'?'ok':['failed','unknown'].includes(d.status)?'warn':'')}</td><td>${d.status==='unknown'?'待核对':d.status==='failed'?'不按成功结算':money(fullPrice(d))}<small>演示</small></td><td>${d.status==='succeeded'?btn('去精修','edit-item',`data-id="${d.id}"`):d.status==='failed'?btn('调整并重试','retry',`data-id="${d.id}"`):d.status==='unknown'?btn('查询原请求','recover',`data-id="${d.id}"`):'—'}</td></tr>`).join('')}</tbody></table></div>
      <div class="rv-bottom"><small>不自动付费重试或换模型；未知任务只能恢复原请求。</small>${btn('进入精修','step',`data-id="4" ${successCount?'':'disabled'}`,true)}</div></section>
      <section class="rv-panel" style="margin-top:22px"><div class="rv-panel-title"><div><h3>已接入的真实单图能力</h3><small>过渡入口：真实单图任务尚未绑定项目批次，商品原图也不会自动发送。</small></div>${btn('打开真实单图面板','real-generation')}</div></section>`;
  }
  function stepFour(p){
    const list=p.items.filter(d=>d.status==='succeeded'),d=list.find(d=>d.id===itemId)||list[0];
    if(!d)return `<div class="rv-empty"><h2>等待第一张成功结果</h2>${btn('返回制作任务','step','data-id="3"',true)}</div>`;
    itemId=d.id;if(!d.versions.some(v=>v.id===selectedVersion))selectedVersion=d.versions.at(-1).id;
    return `<div class="rv-edit-grid"><aside>${list.map(x=>`<button class="rv-deliverable ${x.id===d.id?'active':''}" data-rv="edit-item" data-id="${x.id}"><b>${x.name}</b><small style="display:block">${x.versions.length} 个版本 / ${x.candidate?'候选 v'+x.candidate:'待选候选'}</small></button>`).join('')}</aside>
      <section>${picture(p.snapshot,d.kind,true)}<div class="rv-edit-versions">${d.versions.map(v=>`<button data-rv="version" data-id="${v.id}" class="${selectedVersion===v.id?'active':''}">v${v.id} · ${esc(v.type)}${v.id===d.candidate?' ✓ 候选':''}</button>`).join('')}</div><div class="rv-bottom"><small>当前查看 v${selectedVersion}，新版本不会自动成为交付候选。</small>${btn('选为交付候选','candidate',d.approved?'disabled':'',true)}</div></section>
      <aside class="rv-panel"><h2>精修这个版本</h2><label class="rv-field">处理方式<select id="rv-edit-mode"><option value="composite">模板重排 · 不调用模型</option><option value="background">无字底图二次优化</option><option value="polish">整图润色 · 需重检文字</option></select></label>
      <label class="rv-field" style="margin-top:16px">修改要求<textarea id="rv-edit-instruction" placeholder="例如：标题靠左，商品保持居中，增加留白"></textarea></label>
      ${btn('生成修改建议','edit-suggest',d.approved?'disabled':'')}
      <p class="muted" style="margin-top:15px;font-size:12px">模板重排调整文字与排版；整图润色可能改变文字和商品，须重新质检。</p>
      ${btn('创建演示版本','new-version',d.approved?'disabled':'',true)}
      ${d.approved?'<p class="rv-banner">此交付项已审核冻结。请先在 05 撤销通过。</p>':''}
      <div class="rv-bottom">${btn('前往审核','step','data-id="5"')}</div></aside></div>`;
  }
  const checks=['商品形状、颜色与原图一致','文案、规格和价格符合冻结资料','文字清晰、没有错字或溢出','尺寸、构图与交付要求一致'];
  function stepFive(p){
    return `<section class="rv-panel"><div class="rv-panel-title"><div><h2>只审核明确选定的候选版本</h2><small>检查未全部处理，不能通过；已通过版本先撤销再返修。</small></div>${btn('查看导出','step','data-id="6"')}</div>
      <div class="rv-grid">${p.items.map(d=>`<article class="rv-card"><div class="rv-card-body"><div class="rv-panel-title"><h3>${d.name}</h3>${tag(d.approved?'审核通过':d.candidate?'候选 v'+d.candidate:'未选候选',d.approved?'ok':'warn')}</div>
      ${checks.map((c,i)=>`<label class="rv-check"><input type="checkbox" data-qc="${d.id}" data-check="${i}" ${d.checks.includes(i)?'checked':''} ${!d.candidate||d.approved?'disabled':''}>${c}</label>`).join('')}
      ${d.approved?btn('撤销通过','revoke',`data-id="${d.id}"`):btn('审核通过','approve',`data-id="${d.id}" ${d.candidate&&d.checks.length===4?'':'disabled'}`,true)}
      ${btn(d.candidate?'查看 / 返修':'选择候选','edit-item',`data-id="${d.id}" ${d.status==='succeeded'?'':'disabled'}`)}</div></article>`).join('')}</div></section>`;
  }
  function stepSix(p){
    const passed=p.items.filter(d=>d.approved),missing=p.items.filter(d=>!d.approved);
    return `<div class="rv-split"><section class="rv-panel"><h2>本次交付内容</h2><p class="muted">导出不产生生成费用，仅包含审核通过的指定版本。</p>
      ${p.items.map(d=>`<div class="rv-todo"><span><b>${d.name}</b><small>${d.approved?`候选 v${d.candidate} · 审核通过`:'缺项 · 不纳入交付'}</small></span>${tag(d.approved?'纳入清单':'待完成',d.approved?'ok':'warn')}</div>`).join('')}</section>
      <aside class="rv-panel"><h2>打包与交付</h2><dl class="rv-facts"><div><dt>可交付</dt><dd>${passed.length} / ${p.items.length} 张</dd></div><div><dt>导出费用</dt><dd>无</dd></div></dl>
      <p class="rv-banner">当前可以下载演示 manifest；真实图片 ZIP 将在正式开发中接入。</p>
      ${missing.length?`<label class="rv-check"><input type="checkbox" id="rv-partial">确认部分交付，清单明确列出 ${missing.length} 个缺项；未知任务费用仍待核对。</label>`:''}
      ${btn('下载演示交付清单','export',passed.length?'':'disabled',true)}
      ${btn('返回审核','step','data-id="5"')}<p class="muted" style="margin-top:18px;font-size:12px">manifest 包含商品与方案版本、候选、审核状态和缺项，不包含密钥或内部地址。</p></aside></div>`;
  }
  const templates=[
    {id:'white',name:'纯白主图',category:'白底',kind:'',desc:'干净背景，准确呈现商品轮廓。',prompt:'{商品}，纯白背景，柔和投影，主体居中；保持原始外形，不添加文字。'},
    {id:'home',name:'自然光家居场景',category:'场景',kind:'scene',desc:'统一自然光，为小套图建立空间感。',prompt:'{商品}置于{场景}，柔和窗光，真实比例，保持商品原始颜色和结构，无文字。'},
    {id:'selling',name:'单一卖点展示',category:'卖点',kind:'selling',desc:'底图与文案分离，留出排版空间。',prompt:'以{商品}为主体，清晰展示已确认卖点：{卖点}。右侧留白，底图不生成文字。'},
    {id:'promo',name:'上新促销版式',category:'促销',kind:'selling',desc:'适合上新首屏，价格需另行核实。',prompt:'{商品}上新视觉，背景简洁明亮，上方留出标题区，不绘制价格或文字。'},
    {id:'edit',name:'光线与背景精修',category:'改图',kind:'scene',desc:'保持商品形状，只调整环境。',prompt:'保持{商品}的形状、颜色与数量，仅将环境调整为{场景}，不修改商品。'},
    {id:'video',name:'产品短片分镜',category:'视频分镜',kind:'',desc:'仅预览结构，视频执行尚未接入。',prompt:'开场全景 → 商品细节 → 使用场景 → 品牌收尾。'}
  ];
  async function loadAssets(){
    if(realLoading)return;realLoading=true;realError='';
    try{const response=await fetch('/api/jobs');if(!response.ok)throw Error('读取失败');const result=await response.json();realJobs=(result.jobs||[]).filter(j=>j.status==='succeeded');realLoaded=true;}
    catch{realError='暂时无法读取真实素材。请确认本机服务已启动后重试。';}
    finally{realLoading=false;if(page==='assets')render();}
  }
  function assetsPage(){
    const outputs=realJobs.filter(j=>(assetFilter==='all'||j.operation===assetFilter)&&((j.prompt||'')+' '+(j.modelId||'')).toLowerCase().includes(assetQuery.toLowerCase()));
    return header('素材与灵感','真实产出留在这里，成熟的提示词成为下一次创作的起点。',btn('刷新真实素材','refresh-assets'))+
      `<div class="rv-toolbar"><div class="rv-tabs"><button data-rv="asset-tab" data-id="outputs" class="${assetTab==='outputs'?'active':''}">真实素材 ${realLoaded?realJobs.length:''}</button><button data-rv="asset-tab" data-id="templates" class="${assetTab==='templates'?'active':''}">预制模板 ${templates.length}</button></div>${assetTab==='outputs'?`<input class="rv-search" id="rv-asset-search" placeholder="搜索提示词或模型" aria-label="搜索素材" value="${esc(assetQuery)}">`:tag('自制示意图 · 不计入产出')}</div>
      ${assetTab==='templates'?`<div class="rv-grid">${templates.map(t=>`<article class="rv-card">${picture(seedProduct,t.kind)}<div class="rv-card-body"><div class="rv-panel-title"><h3>${t.name}</h3>${tag(t.category)}</div><p>${t.desc}</p>${btn(t.id==='video'?'查看分镜结构':'填写并带入项目','template',`data-id="${t.id}"`)}</div></article>`).join('')}</div>`:
      `<div class="rv-banner">此页只显示接口返回的真实成功任务，不混入项目演示图。当前接口最多返回最近 50 个任务；全量素材分页将在正式开发中接入。</div>
      <div class="rv-tabs" style="margin-bottom:20px">${[['all','全部'],['generate','生成'],['edit','改图']].map(([k,n])=>`<button data-rv="asset-filter" data-id="${k}" class="${assetFilter===k?'active':''}">${n}</button>`).join('')}</div>
      ${realError?`<div class="rv-empty">${realError}<p>${btn('重试','refresh-assets')}</p></div>`:realLoading?'<div class="rv-empty" role="status">正在读取真实素材…</div>':outputs.length?`<div class="rv-grid">${outputs.map(j=>`<article class="rv-card"><div class="rv-art">${j.imageUrl?`<img loading="lazy" src="${esc(j.imageUrl)}" alt="真实生成结果">`:'文件不可用'}</div><div class="rv-card-body"><div class="rv-panel-title"><h3>${j.operation==='edit'?'图片精修':'商品创作'}</h3>${tag('真实产出','ok')}</div><p>${esc((j.prompt||'无提示词').slice(0,90))}</p><small>${esc(j.modelId)} / ${esc(j.size||'尺寸未记录')}</small><div class="rv-bottom">${btn('查看详情','asset-detail',`data-id="${esc(j.id)}"`)}${tag('未审核')}</div></div></article>`).join('')}</div>`:'<div class="rv-empty"><h2>暂无匹配的真实产出</h2><p>成功生成并完成转存后，图片会出现在这里。</p></div>'}`}`;
  }
  function systemPage(){
    const tabs=[['users','用户与权限'],['billing','账单与额度'],['logs','日志'],['models','模型中心'],['security','安全与说明']];
    return header('系统管理','一个团队，共享商品、项目和素材；通过角色管理操作范围。',btn('预览登录','login'))+
      `<div class="rv-tabs" style="margin-bottom:24px">${tabs.map(([k,n])=>`<button class="${tab===k?'active':''}" data-rv="system-tab" data-id="${k}">${n}</button>`).join('')}</div>`+
      (tab==='users'?usersPanel():tab==='billing'?billingPanel():tab==='logs'?logsPanel():tab==='models'?modelsPanel():securityPanel());
  }
  function usersPanel(){
    return `<section class="rv-panel"><div class="rv-panel-title"><div><h2>团队成员</h2><small>本地交互演示；尚未实现真实登录、权限或会话。</small></div>${btn('＋ 新增用户','add-user','',true)}</div><div class="rv-table-wrap"><table class="rv-table"><thead><tr><th>姓名 / 账号</th><th>角色</th><th>状态</th><th>操作</th></tr></thead><tbody>${data.users.map(u=>`<tr><td><b>${esc(u.name)}</b><small>${esc(u.account)}</small></td><td>${esc(u.role)}</td><td>${tag(u.enabled?'正常':'已停用',u.enabled?'ok':'warn')}</td><td><div class="rv-actions">${btn('编辑','edit-user',`data-id="${esc(u.id)}"`)}${btn(u.enabled?'停用':'启用','toggle-user',`data-id="${esc(u.id)}" ${u.id==='admin'?'disabled':''}`)}${btn('重置密码','reset-password',`data-id="${esc(u.id)}"`)}</div></td></tr>`).join('')}</tbody></table></div>
      <div class="rv-capabilities">${tag('管理员：配置、用户、额度及审计')}${tag('运营：商品、项目、生成及审核')}${tag('只读：浏览与下载')}</div></section>`;
  }
  function billingPanel(){
    const balance=data.ledger.reduce((n,l)=>n+l.amount,0),cost=data.ledger.filter(l=>l.type==='生成').reduce((n,l)=>n-l.amount,0),unknown=data.projects.reduce((n,p)=>n+p.items.filter(d=>d.status==='unknown').length,0);
    return `<div class="rv-banner">演示额度账本 · 与演示项目同源，不代表真实供应商余额或费用。项目文本辅助只记成本，不扣客户额度。</div>
      <div class="rv-metrics"><div class="rv-metric"><span>演示余额 / 可用额度</span><strong>${money(balance)}</strong></div><div class="rv-metric"><span>已结算生成</span><strong>${money(cost)}</strong></div><div class="rv-metric"><span>未知待核对</span><strong>${unknown} 笔</strong></div><div class="rv-metric"><span>演示预占</span><strong>¥0.00</strong><small>本演示不模拟在途资金预占</small></div></div>
      <section class="rv-panel"><div class="rv-panel-title"><h2>额度流水</h2>${btn('充值 / 调账','adjust-balance','',true)}</div><div class="rv-table-wrap"><table class="rv-table"><thead><tr><th>事项</th><th>类型</th><th>金额</th><th>时间</th></tr></thead><tbody>${data.ledger.map(l=>`<tr><td>${esc(l.label)}</td><td>${esc(l.type)}</td><td>${l.amount>0?'+':''}${money(l.amount)}</td><td>${esc(l.time)}</td></tr>`).join('')}</tbody></table></div></section>`;
  }
  function logsPanel(){
    return `<section class="rv-panel"><div class="rv-panel-title"><div><h2>操作记录</h2><small>记录本浏览器的原型操作，不含密码、密钥或提示词全文。</small></div>${btn('导出演示 CSV','export-logs')}</div>
      ${data.logs.length?data.logs.map(l=>`<div class="rv-log"><b>${esc(l.action)} · ${esc(l.object)}</b><small>${esc(l.actor)} / ${esc(l.time)} / 演示</small></div>`).join(''):'<div class="rv-empty">暂时没有操作记录。新增用户、确认方案或审核后，可在这里查看。</div>'}</section>`;
  }
  function modelsPanel(){
    return `<section class="rv-panel"><div class="rv-panel-title"><div><h2>模型能力与渠道</h2><small>保留已经接通的渠道管理；新的价格与能力扩展在这里评审。</small></div>${btn('管理真实渠道','real-system','',true)}</div>
      <div class="rv-grid">${[['图像生成 / 改图','已接入单图执行','ok'],['文本 / 视觉理解','规划中，演示不调用','warn'],['视频 / 语音','能力目录预留，执行未接入','']].map(([a,b,c])=>`<div class="rv-panel"><h3>${a}</h3>${tag(b,c)}</div>`).join('')}</div>
      <p class="muted" style="margin-top:18px">项目默认模型、单图覆盖与别名统一选择能力。模型不可用时由用户处理，不自动切换付费模型。</p></section>
      <section class="rv-panel rv-model-price"><div class="rv-panel-title"><div><h2>价格与档位</h2><small>官方价 / 渠道价 / 平台结算价 / 供应商账单分别记录。</small></div><div class="rv-actions">${btn('手动录入','manual-price')}${btn('AI 查价演示','lookup-price','',true)}</div></div>
      ${data.prices.length?`<div class="rv-table-wrap"><table class="rv-table"><thead><tr><th>模型 / 档位</th><th>参考价</th><th>平台结算价</th><th>状态</th></tr></thead><tbody>${data.prices.map(p=>`<tr><td>${esc(p.model)}<small>${esc(p.tier)}</small></td><td>${esc(p.reference||'手动录入')}</td><td>${money(p.price)} / ${esc(p.unit)}</td><td>${tag('本地演示已确认','ok')}</td></tr>`).join('')}</tbody></table></div>`:'<div class="rv-empty">还没有演示价格。手动录入或查看 AI 查价候选，管理员确认后才保存。</div>'}
      <p class="muted" style="margin-top:18px;font-size:12px">真实渠道任务仍按供应商实际费用执行，此处价格不写入真实账本，也不回改已冻结的演示项目。</p></section>`;
  }
  function securityPanel(){return `<div class="rv-split"><section class="rv-panel"><h2>账号与工作空间</h2><p>首期一个商家团队、多账号共享业务资料。正式实现将支持首次改密、停用即时失效与服务端角色校验。</p><h3>凭据与访问</h3><p class="muted">浏览器不持有中间件密码或长期存储密钥；渠道密钥只通过后端使用。当前本机开发服务尚未提供正式登录保护。</p></section><section class="rv-panel"><h2>当前可用边界</h2><p>已有真实单图生成、有限改图、历史任务与图片下载。</p><p class="muted">本次新增的项目、截图识别、审核、用户、账本和 AI 查价均为交互演示。视频执行、真实 ZIP、真实截图识别与项目批次等待正式开发。</p>${btn('预览登录流程','login')}</section></div>`;}

  function newProject(context={}){
    const chosen=context.productId||apiProducts.selected()?.id||seedProduct?.id;
    modal(context.template?'将模板带入项目':context.asset?'将素材带入项目':'新建项目',`<form id="rv-project-form"><label class="rv-field">项目名称<input name="name" required maxlength="80" value="${esc(context.template?context.template.name+' · 新创作':'')}" placeholder="例如：收纳盒 · 秋日上新"></label>
      <label class="rv-field">商品 / SKU<select name="product">${apiProducts.list().map(p=>`<option value="${esc(p.id)}" ${p.id===chosen?'selected':''}>${esc(p.name)} / ${esc(p.sku||'SKU 待补充')}</option>`).join('')}</select></label>
      ${context.template?`<div class="rv-banner">将已填写的模板带入草稿方案，不自动确认或生成。</div>`:context.asset?'<div class="rv-banner">保留素材来源引用；正式改图前还需校验供应商、模型和源图有效期。</div>':'<p class="muted">新建后先核对商品原图和资料；未确认商品也可关联为项目草稿。</p>'}
      <div class="rv-bottom"><button class="btn primary" type="submit">创建项目草稿</button></div></form>`);
    $('#rv-project-form').onsubmit=e=>{e.preventDefault();const f=new FormData(e.target),name=f.get('name').trim();if(!name)return error('请输入项目名称。');const p={id:crypto.randomUUID(),name,productId:f.get('product'),snapshot:null,prechecked:false,frozen:false,planReady:false,items:baseItems(),owner:'林晓',sample:f.get('product')==='sample-box',events:[],exported:false};
      if(context.template){p.items[0].prompt=context.prompt;p.templatePrompt=context.prompt;p.template=context.template.id;}normalize(p);
      if(context.asset)p.sourceAsset={id:context.asset.id,modelId:context.asset.modelId,createdAt:context.asset.createdAt};
      data.projects.unshift(p);projectId=p.id;step=1;log('创建项目草稿',name);dialog.close();route('project');};
  }
  function editUser(id){
    const u=data.users.find(u=>u.id===id);
    modal(u?'编辑用户':'新增用户',`<form id="rv-user-form"><label class="rv-field">显示姓名<input name="name" required maxlength="40" value="${esc(u?.name||'')}"></label><label class="rv-field">登录账号<input name="account" required pattern="[a-zA-Z0-9_.-]{3,40}" title="3–40 位字母、数字、点、横线或下划线" value="${esc(u?.account||'')}" ${u?'readonly':''}></label><label class="rv-field">角色<select name="role" ${u?.id==='admin'?'disabled':''}>${['管理员','运营','只读'].map(r=>`<option ${u?.role===r?'selected':''}>${r}</option>`).join('')}</select></label><p class="muted">原型仅保存姓名、账号和角色，不创建真实账号、不收集密码。正式新增账号需首次改密。</p><button class="btn primary" type="submit">保存演示用户</button></form>`);
    $('#rv-user-form').onsubmit=e=>{e.preventDefault();const f=new FormData(e.target),name=f.get('name').trim(),account=f.get('account').trim();if(!name)return error('请输入姓名。');if(data.users.some(x=>x.account===account&&x.id!==u?.id))return error('该账号已存在。');if(u){u.name=name;u.role=f.get('role')||u.role;}else data.users.push({id:crypto.randomUUID(),name,account,role:f.get('role'),enabled:true});log(u?'修改用户':'新增用户',name);dialog.close();render();};
  }
  function priceForm(lookup=false){
    modal(lookup?'AI 查价候选 · 演示':'手动录入平台价格',`<form id="rv-price-form">${lookup?'<div class="rv-banner warning">此处展示候选确认交互，未联网查价。以下金额是虚构示例，没有真实价格来源，不可用于实际结算。</div><div class="rv-evidence"><div><b>示例图像模型 / 1024 标准</b><span>待管理员确认</span></div><div><span>官方价：¥1.00 / 张</span><span>渠道价：¥0.90 / 张</span></div><div><span>来源：本地演示数据，无公开引用</span><span>非真实报价</span></div></div>':''}
      <label class="rv-field">模型名称<input name="model" required value="${lookup?'示例图像模型':''}" placeholder="模型名称与版本"></label>
      <div class="rv-split"><label class="rv-field">基础档位<input name="tier" required value="${lookup?'1024 × 1024 / 标准':''}" placeholder="图片尺寸质量 / 输入 token / 输出 token"></label><label class="rv-field">计价单位<select name="unit"><option>张</option><option>百万输入 token</option><option>百万输出 token</option><option>秒</option><option>千字符</option></select></label></div>
      <label class="rv-field">平台结算价（CNY，仅演示）<input name="price" type="number" min="0" max="999999" step="0.000001" required placeholder="由管理员填写，不自动采用候选"></label>
      <label class="rv-check"><input type="checkbox" required>确认仅保存本地演示价格，不改动真实渠道与历史任务。</label><button class="btn primary" type="submit">确认保存演示价格</button></form>`);
    $('#rv-price-form').onsubmit=e=>{e.preventDefault();const f=new FormData(e.target);data.prices.push({model:f.get('model').trim(),tier:f.get('tier').trim(),unit:f.get('unit'),price:Number(f.get('price')),reference:lookup?'官方 ¥1.00 / 渠道 ¥0.90（虚构）':'手动录入'});log('确认演示平台价格',f.get('model'));dialog.close();render();};
  }
  function screenshot(){
    modal('截图录入商品',`<p class="muted">多张截图识别同一个商品，直接保存待核实草稿。原图与证据分开维护。</p><div class="rv-split"><div class="rv-thumb-shot"><small>示例截图 1 · 商品页</small>${apiProducts.art({art:'mug'})}<strong>燕麦色陶瓷杯</strong><em>¥49</em><p>单杯 / 燕麦色</p></div><div class="rv-thumb-shot"><small>示例截图 2 · 参数表</small><dl class="rv-facts"><div><dt>容量</dt><dd>320 mL</dd></div><div><dt>材质</dt><dd>陶瓷</dd></div></dl><p>字段会保留截图编号和置信度。</p></div></div>
      <div class="rv-banner" style="margin-top:18px">真实视觉识别待接入。此示例使用固定资料演示建档，不上传截图、不计费；重复点击会打开同一条商品。</div>
      <label class="rv-field">选择本地截图预览（不会识别）<input id="rv-screenshots" type="file" multiple accept="image/png,image/jpeg,image/webp"></label><p id="rv-shot-note" class="muted"></p><div class="rv-actions" id="rv-shot-previews"></div>
      <div class="rv-bottom">${btn('使用示例截图，直接建档','recognize-demo','',true)}</div>`);
    const urls=[];dialogCleanup=()=>urls.forEach(URL.revokeObjectURL);
    $('#rv-screenshots').onchange=e=>{urls.splice(0).forEach(URL.revokeObjectURL);const files=[...e.target.files];$('#rv-shot-previews').replaceChildren();if(files.length>6||files.some(f=>f.size>4*1024*1024||!['image/png','image/jpeg','image/webp'].includes(f.type))){$('#rv-shot-note').textContent='预览最多 6 张 JPG / PNG / WebP，每张不超过 4 MB。';return;}$('#rv-shot-note').textContent=`已选择 ${files.length} 张，仅在本机预览。真实识别未接入，可改用手动录入。`;files.forEach(f=>{const url=URL.createObjectURL(f);urls.push(url);const img=document.createElement('img');img.src=url;img.alt=f.name;img.style='width:80px;height:95px;object-fit:contain';$('#rv-shot-previews').append(img);});};
  }
  function templateDialog(t){
    if(t.id==='video'){modal('产品短片分镜',`<p>${t.prompt}</p><div class="rv-banner warning">视频仅预留能力目录。本轮不创建视频任务，也不计费。</div>`);return;}
    const vars=[...new Set([...t.prompt.matchAll(/\{([^}]+)\}/g)].map(x=>x[1]))];
    modal(t.name,`<form id="rv-template-form">${vars.map(v=>`<label class="rv-field">${v}<input data-var="${v}" required maxlength="180" placeholder="填写已确认的${v}"></label>`).join('')}<label class="rv-field">提示词预览<textarea id="rv-template-preview" readonly>${t.prompt}</textarea></label><p class="muted">推荐 1:1 / 1024，带入项目后再检查模型参数兼容性。文案独立排版。</p><button class="btn primary" type="submit">带入新项目草稿</button></form>`);
    const update=()=>{let text=t.prompt;$$('#rv-template-form [data-var]').forEach(i=>{text=text.replaceAll('{'+i.dataset.var+'}',i.value.trim()||'{'+i.dataset.var+'}');});$('#rv-template-preview').value=text;};
    $('#rv-template-form').oninput=update;
    $('#rv-template-form').onsubmit=e=>{e.preventDefault();if($$('#rv-template-form [data-var]').some(i=>!i.value.trim()))return error('请填写全部变量。');const prompt=$('#rv-template-preview').value;newProject({template:t,prompt});};
  }
  function download(filename,text,type='application/json'){const url=URL.createObjectURL(new Blob([text],{type:type+';charset=utf-8'})),a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);}
  function legacy(kind){
    window.workbench.showScreen(kind);
    page=kind==='system'?'legacy-system':'legacy-generation';
    const target=$(`[data-view="${kind}"]`);
    let back=target.querySelector('.rv-real-back');
    if(!back){back=document.createElement('div');back.className='rv rv-real-back';target.prepend(back);}
    back.innerHTML=`<div class="rv-banner warning">${kind==='generation'?'真实单图面板 · 点击生成将按供应商实际计费。这里的任务尚未写入项目，演示资料不会自动发送。':'真实渠道管理 · 此页操作会影响已有渠道配置。用户、账本、查价演示与此独立。'}</div>${btn(kind==='generation'?'返回项目流程':'返回模型中心',kind==='generation'?'back-project':'back-models')}`;
    $$('.rail-btn').forEach(b=>b.classList.toggle('is-active',b.dataset.nav===(kind==='system'?'system':'projects')));
  }
  function restoreSearch(selector,value){const el=$(selector);if(el){el.focus();el.setSelectionRange(value.length,value.length);}}
  document.addEventListener('input',e=>{
    if(e.target.id==='rv-project-search'){projectQuery=e.target.value;render();restoreSearch('#rv-project-search',projectQuery);}
    if(e.target.id==='rv-asset-search'){assetQuery=e.target.value;render();restoreSearch('#rv-asset-search',assetQuery);}
  });
  document.addEventListener('change',e=>{
    const el=e.target,p=P();
    if(el.id==='rv-project-product'){p.productId=el.value;p.sample=el.value==='sample-box';p.prechecked=false;save();render();}
    const item=id=>p.items.find(x=>x.id===Number(id));
    if(el.id==='rv-requirement'){p.requirement=el.value.trim();save();}
    if(el.dataset.planPrompt!==undefined){item(el.dataset.planPrompt).prompt=el.value;save();}
    if(el.dataset.planModel!==undefined){const d=item(el.dataset.planModel);d.model=el.value;d.flow.forEach(n=>{if(n.status==='idle'&&['generate','edit'].includes(n.type))n.model=el.value;});save();}
    if(el.id==='rv-default-model'){p.defaultModel=el.value;p.items.filter(d=>!d.frozen).forEach(d=>{d.model=el.value;d.flow.forEach(n=>{if(n.status==='idle'&&['generate','edit'].includes(n.type))n.model=el.value;});});save();render();}
    if(el.dataset.nodeModel!==undefined){const [di,ni]=el.dataset.nodeModel.split(':'),n=item(di)?.flow.find(x=>x.id===ni);if(n&&n.status==='idle'){n.model=el.value;save();}}
    if(el.dataset.addNode!==undefined&&el.value){const [di,ni]=el.dataset.addNode.split(':'),d=item(di);if(!d||d.frozen)return;
      // Insert after the branch tail so the chain stays linear; composite never feeds an edit node.
      const tail=d.flow.find(x=>x.id===ni);if(tail.type==='composite'&&el.value==='edit'){render();return notify('模板合成后不再接改图节点；请在合成前追加改图。');}
      d.flow.push({id:nextNodeId(d),type:el.value,from:ni,model:el.value==='edit'?d.model:'',status:'idle'});log('添加工作流节点',d.name+' / '+NODE[el.value]);render();}
    if(el.dataset.qc!==undefined){const d=item(el.dataset.qc),n=+el.dataset.check;d.checks=d.checks.filter(x=>x!==n);if(el.checked)d.checks.push(n);save();render();}
  });
  document.addEventListener('click',async e=>{
    const nav=e.target.closest('.rail-btn,[data-screen],#rail-home');
    if(nav){e.preventDefault();e.stopImmediatePropagation();const dest=nav.dataset.nav||nav.dataset.screen||'dashboard';if(dest==='generation'){route('projects');notify('先选择项目，再从 03 制作或 04 精修进入。');}else if(dest==='billing')route('system',{tab:'billing'});else route(dest);return;}
    if(e.target.closest('#reset-demo')){e.preventDefault();e.stopImmediatePropagation();modal('重置流程演示',`<p>只重置当前浏览器中的演示项目、用户、价格和账本。已录入的商品资料及真实模型任务保持保留。</p>${btn('重置演示并刷新','reset-confirm','',true)}`);return;}
    if(e.target.closest('#product-use')){e.preventDefault();e.stopImmediatePropagation();const p=apiProducts.selected();if(p?.status==='confirmed')newProject({productId:p.id});return;}
    if(e.target.closest('#product-screenshot')){screenshot();return;}
    const b=e.target.closest('[data-rv]');if(!b)return;
    e.preventDefault();e.stopImmediatePropagation();
    const action=b.dataset.rv,id=b.dataset.id,p=P(),d=p.items.find(x=>x.id===Number(id));
    if(action==='close'){dialog.close();return;}
    if(action==='nav'){route(b.dataset.page);return;}
    if(action==='new-project'){newProject();return;}
    if(action==='open-project'){projectId=id;step=current(P());itemId=0;projectView='steps';route('project');return;}
    if(action==='project-filter'){projectFilter=id;render();return;}
    if(action==='step'){step=Number(id);render();return;}
    if(action==='open-product'){route('products');apiProducts.open(id);return;}
    if(action==='precheck'){const facts=product(p.productId);if(!$('#rv-precheck').checked)return notify('请先勾选资料检查。');if(facts?.status!=='confirmed'||!facts?.sku||(!facts?.image&&!p.sample))return notify('请先在商品中确认资料、填写 SKU 并上传原始主图。');p.prechecked=true;step=2;log('确认项目资料',p.name);render();return;}
    if(action==='project-view'){projectView=id;render();return;}
    if(action==='canvas-step'){projectView='steps';step=Number(id);render();return;}
    if(action==='suggest-plan'){
      if(p.frozen)return;
      const req=$('#rv-requirement');if(req)p.requirement=req.value.trim();
      const {plan,claims,suggestions}=planDemo(p);
      p.items=plan.map(([type,name],i)=>{const d=makeItem(i,type,name);d.flow[0].status='done';return d;});
      if(p.templatePrompt)p.items[0].prompt=p.templatePrompt;
      p.claims=claims;p.suggestions=suggestions;p.planReady=true;
      log('AI 规划交付项清单（演示）',`${p.name} / ${plan.length} 项`);render();
      notify(`已规划 ${plan.length} 个交付项和 ${suggestions.length} 条扩展建议；演示规划，未调用文本模型。`);return;
    }
    if(action==='add-task'||action==='adopt-suggestion'){
      if(p.items.length>=10)return notify('每个方案最多 10 个交付项。');
      const nid=Math.max(-1,...p.items.map(x=>x.id))+1;let task;
      if(action==='adopt-suggestion'){const s=p.suggestions.splice(Number(id),1)[0];task=makeItem(nid,'extension',s.name,`以已确认商品为唯一主体，${s.hint}。保留商品形状、颜色和已确认参数，不添加文字或虚构卖点。`);}
      else{const v=$('#rv-add-type').value,tpl=v.startsWith('tpl:')&&data.flowTemplates.find(t=>'tpl:'+t.id===v);
        task=tpl?{...makeItem(nid,tpl.type,tpl.name,tpl.prompt),flow:structuredClone(tpl.flow)}:makeItem(nid,v,TYPES[v].name);}
      task.flow[0].status='done';
      if(p.frozen){p.planVersion+=1;task.planVersion=p.planVersion;p.exported=false;}
      p.items.push(task);log(p.frozen?`方案 v${p.planVersion}：追加交付项`:action==='adopt-suggestion'?'采纳 AI 扩展建议':'添加交付项',task.name);render();
      if(p.frozen)notify(`已生成方案 v${p.planVersion}；已执行的交付项保留，新交付项需在 03 单独确认开跑。`);return;
    }
    if(action==='remove-task'){if(p.frozen)return;p.items=p.items.filter(x=>x.id!==Number(id));log('移除交付项',p.name);render();return;}
    if(action==='add-branch'){
      if(!d||d.frozen)return;const gens=d.flow.filter(n=>n.type==='generate');if(gens.length>=3)return notify('每个交付项最多 3 个并行出图分支。');
      d.flow.push({id:nextNodeId(d),type:'generate',from:'n1',model:d.model,status:'idle'});log('添加并行出图分支',d.name);render();return;
    }
    if(action==='node-delete'){
      if(!d||d.frozen)return;const n=d.flow.find(x=>x.id===b.dataset.node);if(!n||n.status!=='idle'||n.type==='prompt')return;
      if(n.type==='generate'&&d.flow.filter(x=>x.type==='generate').length===1)return notify('每个交付项至少保留一个生图节点。');
      const drop=new Set([n.id]);let grew=true;while(grew){grew=false;d.flow.forEach(x=>{if(!drop.has(x.id)&&drop.has(x.from)){drop.add(x.id);grew=true;}});}
      d.flow=d.flow.filter(x=>!drop.has(x.id));log('删除工作流节点',d.name+' / '+NODE[n.type]);render();return;
    }
    if(action==='save-template'){
      if(!d)return;const name=d.name+' · 自定义';
      data.flowTemplates.push({id:crypto.randomUUID(),name,type:d.type,prompt:d.prompt,flow:d.flow.map(n=>({...n,status:'idle'}))});
      log('另存工作流模板',name);render();notify(`已另存为「${name}」，可在 02 添加交付项时选用。改动不影响原模板。`);return;
    }
    if(action==='freeze-plan'){if(!p.frozen){p.snapshot=structuredClone(product(p.productId));p.frozen=true;log('确认方案与资料快照',p.name);}step=3;render();return;}
    if(action==='run-batch'){
      const pending=p.items.filter(x=>x.status==='idle');if(!pending.length)return;
      const total=pending.reduce((s,x)=>s+estimate(x),0);
      modal('逐节点估价 · 确认开跑',`<p class="muted">整条工作流一次确认并预占；节点按顺序自动执行，不循环、不自动重试。失败只停该分支并释放下游预占。</p>
        <div class="rv-table-wrap"><table class="rv-table"><thead><tr><th>交付项</th><th>付费节点</th><th>预估</th></tr></thead><tbody>${pending.map(x=>`<tr><td><b>${esc(x.name)}</b><small>${esc(chainText(x))}</small></td><td>${x.flow.filter(n=>NODE_PRICE[n.type]).map(n=>NODE[n.type]+' · '+esc(n.model||x.model)).join('<br>')}<small>提示词只记成本；模板合成不收生成费</small></td><td>${money(estimate(x))}</td></tr>`).join('')}</tbody></table></div>
        <div class="rv-bottom"><b>合计预占 ${money(total)}（演示）</b>${btn('确认开跑','confirm-run','',true)}</div>`);return;
    }
    if(action==='confirm-run'){
      const pending=p.items.filter(x=>x.status==='idle');dialog.close();
      pending.forEach(x=>{x.status='running';x.frozen=true;x.flow.forEach(n=>{if(n.type!=='prompt'&&n.status==='idle')n.status='running';});});
      log('确认开跑',`${p.name} / ${pending.length} 个交付项`);render();
      // The last deliverable of a multi-deliverable run fails on purpose to demonstrate branch stop and manual retry.
      pending.forEach((x,i)=>setTimeout(()=>{const fail=pending.length>1&&i===pending.length-1;runItem(p,x,fail);log(fail?'演示任务失败':'演示任务成功',p.name+' / '+x.name);save();if(page==='project'&&P().id===p.id)render();},500+i*400));return;
    }
    if(action==='retry'){modal('调整失败项并重试',`<p>${esc(d.name)} · 只重跑失败节点及其下游，新版本单独计费，不影响其他成功项。</p><label class="rv-field">提示词<textarea id="rv-retry-prompt">${esc(d.prompt)}</textarea></label><label class="rv-check"><input id="rv-retry-consent" type="checkbox">确认演示重试，示例价格 ${money(estimate(d))}，使用新的幂等键，不调用真实模型。</label><div class="rv-bottom">${btn('确认演示重试','confirm-retry',`data-id="${d.id}"`,true)}</div>`);return;}
    if(action==='confirm-retry'){if(!$('#rv-retry-consent').checked)return error('请先确认本次演示重试。');d.prompt=$('#rv-retry-prompt').value;runItem(p,d,false,'手动重试');log('重试失败交付项',d.name);dialog.close();render();return;}
    if(action==='recover'){d.status='failed';d.flow.forEach(n=>{if(n.status==='unknown')n.status='failed';});log('核对原请求：演示返回明确失败',d.name);render();notify('原请求已核对为明确失败，未提交新的生成请求。');return;}
    if(action==='edit-item'){if(!d||d.status!=='succeeded')return;itemId=d.id;selectedVersion=d.candidate||d.versions.at(-1).id;step=4;render();return;}
    if(action==='version'){selectedVersion=Number(id);render();return;}
    if(action==='candidate'){const item=p.items.find(x=>x.id===itemId);item.candidate=selectedVersion;item.checks=[];item.approved=false;p.exported=false;log('选择交付候选',item.name+' v'+selectedVersion);render();return;}
    if(action==='edit-suggest'){$('#rv-edit-instruction').value='保留商品形状、颜色及已确认规格，增加主体周围留白；文字使用模板排版，不补造商品事实。';notify('模板建议已填入，请检查后再创建版本。');return;}
    if(action==='new-version'){
      const item=p.items.find(x=>x.id===itemId),mode=$('#rv-edit-mode').value,text=$('#rv-edit-instruction').value.trim();
      if(!text)return notify('请先填写修改要求。');
      const label=mode==='composite'?'模板重排':mode==='background'?'底图优化':'整图润色';
      modal('确认创建演示版本',`<p>${esc(item.name)} / ${label}</p><p>${esc(text)}</p><div class="rv-banner">${mode==='composite'?'模板重排不调用模型，不计生成费用。':`将模拟新增生成费用 ${money(item.price)}，不请求真实模型。`}</div>${btn('确认创建版本','confirm-version',`data-mode="${mode}" data-label="${label}"`,true)}`);return;
    }
    if(action==='confirm-version'){const item=p.items.find(x=>x.id===itemId);
      // Manual refinement after a run is a separately confirmed node appended after the source version's node.
      const source=item.versions.find(v=>v.id===selectedVersion)?.node,tail=source?lane(item,item.flow.find(n=>n.id===source)||item.flow[1]).at(-1):item.flow.at(-1),nodeId=nextNodeId(item);
      item.flow.push({id:nodeId,type:b.dataset.mode==='composite'?'composite':'edit',from:tail.id,model:b.dataset.mode==='composite'?'':item.model,status:'succeeded',manual:true});
      item.versions.push({id:item.versions.length+1,type:b.dataset.label,time:stamp(),node:nodeId});if(b.dataset.mode!=='composite')charge(p,item,b.dataset.label);selectedVersion=item.versions.at(-1).id;log('创建精修演示版本',item.name+' v'+selectedVersion);dialog.close();render();return;}
    if(action==='approve'){if(!d.candidate||d.checks.length!==4)return;d.approved=true;log('审核通过',p.name+' / '+d.name+' v'+d.candidate);render();return;}
    if(action==='revoke'){modal('撤销审核通过',`<form id="rv-revoke-form"><label class="rv-field">返修原因<textarea name="reason" required maxlength="300" placeholder="说明需要修改的问题"></textarea></label><button type="submit" class="btn primary">撤销并返回精修</button></form>`);$('#rv-revoke-form').onsubmit=e=>{e.preventDefault();const reason=new FormData(e.target).get('reason').trim();if(!reason)return error('请填写原因。');d.approved=false;d.checks=[];p.exported=false;log('撤销审核：'+reason,d.name);itemId=d.id;step=4;dialog.close();render();};return;}
    if(action==='export'){
      const passed=p.items.filter(d=>d.approved),missing=p.items.filter(d=>!d.approved);
      if(!passed.length)return;if(missing.length&&!$('#rv-partial').checked)return notify('请明确确认部分交付及缺项。');
      const manifest={demo:true,note:'交互原型清单，不包含真实媒体文件',project:p.name,productVersion:p.snapshot?.version,planVersion:1,items:passed.map(d=>({name:d.name,candidate:d.candidate,approved:true})),missing:missing.map(d=>({name:d.name,status:d.status}))};
      download('商境_演示交付清单.json',JSON.stringify(manifest,null,2));p.exported=missing.length===0;log('下载演示交付清单',p.name);render();notify('已下载演示 manifest，真实 ZIP 尚未接入。');return;
    }
    if(action==='asset-tab'){assetTab=id;render();return;}
    if(action==='asset-filter'){assetFilter=id;render();return;}
    if(action==='refresh-assets'){loadAssets();return;}
    if(action==='template'){templateDialog(templates.find(t=>t.id===id));return;}
    if(action==='asset-detail'){
      const j=realJobs.find(x=>x.id===id);if(!j)return;
      modal('真实素材详情',`<div class="rv-art" style="height:340px">${j.imageUrl?`<img src="${esc(j.imageUrl)}" alt="生成结果">`:'文件不可用'}</div><p style="margin-top:18px">${tag('真实产出','ok')} ${tag('未审核 · 非正式交付','warn')}</p><dl class="rv-facts"><div><dt>模型</dt><dd>${esc(j.modelId)}</dd></div><div><dt>尺寸 / 质量</dt><dd>${esc(j.size)} / ${esc(j.quality)}</dd></div><div><dt>源任务</dt><dd style="overflow-wrap:anywhere">${esc(j.sourceJobId||'首次生成')}</dd></div><div><dt>时间</dt><dd>${esc(j.createdAt)}</dd></div></dl><p style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(j.prompt)}</p><div class="rv-actions">${j.imageUrl?`<a class="btn" href="${esc(j.imageUrl)}?download=1">下载原图</a>`:''}${btn('复制提示词','copy-asset',`data-id="${esc(id)}"`)}${btn('引用到项目草稿','use-asset',`data-id="${esc(id)}"`)}</div><p class="muted" style="margin-top:15px">历史无项目素材不补造关联。仅保存引用，过期或不兼容源图不能直接执行改图。</p>`);return;
    }
    if(action==='copy-asset'){try{await navigator.clipboard.writeText(realJobs.find(j=>j.id===id).prompt||'');notify('提示词已复制。');}catch{error('浏览器不允许复制，请手动选择上方提示词。');}return;}
    if(action==='use-asset'){newProject({asset:realJobs.find(j=>j.id===id)});return;}
    if(action==='system-tab'){tab=id;render();return;}
    if(action==='add-user'||action==='edit-user'){editUser(id);return;}
    if(action==='toggle-user'){const u=data.users.find(x=>x.id===id);if(u.id==='admin')return;u.enabled=!u.enabled;log(u.enabled?'启用演示用户':'停用演示用户',u.name);render();return;}
    if(action==='reset-password'){modal('重置密码流程',`<p>正式系统将使旧会话失效，并要求用户首次登录修改密码。此原型不生成或保存真实密码。</p>${btn('记录演示重置操作','confirm-reset-password',`data-id="${esc(id)}"`,true)}`);return;}
    if(action==='confirm-reset-password'){log('演示密码重置',data.users.find(u=>u.id===id).name);dialog.close();notify('已记录演示操作，真实密码未改变。');return;}
    if(action==='adjust-balance'){modal('充值 / 调账',`<form id="rv-balance-form"><label class="rv-field">变动金额（CNY；负数为扣减）<input name="amount" type="number" step="0.01" min="-999999" max="999999" required></label><label class="rv-field">原因<input name="reason" required maxlength="120"></label><p class="muted">仅追加演示分录，原流水不会覆盖。</p><button class="btn primary">确认演示调账</button></form>`);$('#rv-balance-form').onsubmit=e=>{e.preventDefault();const f=new FormData(e.target),amount=Number(f.get('amount')),reason=f.get('reason').trim();if(!amount||!reason)return error('请输入非零金额与原因。');data.ledger.unshift({id:crypto.randomUUID(),label:reason,amount,time:stamp(),type:amount>0?'充值':'调账'});log('演示额度调整',money(amount)+' / '+reason);dialog.close();render();};return;}
    if(action==='export-logs'){const cell=x=>'"'+String(x).replace(/^[=+\-@]/,"'$&").replace(/"/g,'""')+'"';download('商境_演示操作日志.csv','\uFEFF'+[['时间','操作人','操作','对象'],...data.logs.map(l=>[l.time,l.actor,l.action,l.object])].map(r=>r.map(cell).join(',')).join('\r\n'),'text/csv');log('导出脱敏演示日志','CSV');render();return;}
    if(action==='manual-price'||action==='lookup-price'){priceForm(action==='lookup-price');return;}
    if(action==='real-system'){legacy('system');return;}
    if(action==='real-generation'){legacy('generation');return;}
    if(action==='back-project'){route('project');return;}
    if(action==='back-models'){route('system',{tab:'models'});return;}
    if(action==='login'){modal('商境工作空间',`<div class="rv-login"><h2>让商品被看见。</h2><p class="muted">团队内容，从这里开始。</p><div class="rv-field">演示账号<input value="admin" readonly aria-label="演示登录账号"></div><div class="rv-field">角色<select id="rv-login-role"><option>管理员</option><option>运营</option><option>只读</option></select></div><p class="rv-banner">登录界面预览，不验证身份、不收集密码；角色仅展示，不具有权限控制作用。</p>${btn('进入演示工作空间','demo-login','',true)}</div>`);return;}
    if(action==='demo-login'){const role=$('#rv-login-role').value;dialog.close();route('dashboard');notify('以'+role+'视角预览；真实权限尚未接入。');return;}
    if(action==='recognize-demo'){const result=apiProducts.addScreenshotExample();if(!result)return error('本地空间不足，未能建档。');dialog.close();route('products');apiProducts.open(result.id);return;}
    if(action==='reset-confirm'){localStorage.removeItem(KEY);location.reload();}
  },true);
  document.body.classList.add('review-mode');
  $$('.rail-btn[data-nav="generation"],.rail-btn[data-nav="billing"]').forEach(b=>b.hidden=true);
  $('.rail-logo').setAttribute('aria-label','商境工作台首页');
  $('.gen-mobile-nav').innerHTML=[['dashboard','工作台'],['projects','项目'],['products','商品'],['assets','素材'],['system','系统']].map(([k,n])=>`<button data-screen="${k}">${n}</button>`).join('');
  $('#products-notice').textContent='本地商品原型 · 手动 / 截图 / 链接三种录入。识别采用示例，不读取真实网页或调用模型；资料保存在当前浏览器。';
  route('dashboard');
});
