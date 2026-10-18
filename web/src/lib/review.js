// Browser-local review workspace. Every mutation here is a demonstration and
// is persisted under the prototype key that the pre-React page used.
import { ensureLayout } from './flow.js';

export const REVIEW_KEY = 'sj:prototype:review:v1';
export const REVIEW_STEPS = ['商品资料', '方案报价', '制作任务', '精修', '质检审核', '打包导出'];

export const TYPES = {
  white: { name: '白底主图 / 多角度', kind: '', ratio: '1:1', chain: ['generate'], hint: '纯白背景、柔和投影' },
  scene: { name: '场景图', kind: 'scene', ratio: '3:4', chain: ['generate'], hint: '自然家居场景、柔和日光' },
  selling: { name: '卖点 / 促销图', kind: 'selling', ratio: '1:1', chain: ['generate', 'composite'], hint: '留出文案排版空间' },
  detail: { name: '细节 / 尺寸 / 包装清单', kind: 'selling', ratio: '3:4', chain: ['generate', 'composite'], hint: '细节特写，留出尺寸标注区域' },
  extension: { name: 'AI 扩展建议', kind: 'scene', ratio: '1:1', chain: ['generate'], hint: '按建议意图构图' },
};

export const NODE = { input: '商品资料', prompt: '文本提示词', generate: '生图', edit: '改图', composite: '模板合成', output: '交付候选' };
export const NODE_STATUS = {
  idle: '待执行', pending: '待执行', queued: '排队中', done: '已生成 · 记成本', running: '执行中', succeeded: '成功',
  failed: '明确失败', unknown: '状态未知', blocked: '上游失败 · 已阻塞', skipped: '已停止 · 释放预占',
};
export const NODE_PRICE = { input: 0, prompt: 0, generate: 1.2, edit: 1.2, composite: 0, output: 0 };
export const DEFAULT_PLAN = [['white', '白底主图'], ['scene', '自然光场景'], ['scene', '家居陈列'], ['selling', '容量卖点'], ['selling', '叠放卖点']];
export const QC_CHECKS = ['商品形状、颜色与原图一致', '文案、规格和价格符合冻结资料', '文字清晰、没有错字或溢出', '尺寸、构图与交付要求一致'];

export const stamp = () => new Date().toLocaleString('zh-CN', { hour12: false });
export const money = n => '¥' + Number(n || 0).toFixed(2);

export function makeFlow(type, model = '演示图像模型') {
  const flow = [{ id: 'n1', type: 'prompt', status: 'idle' }];
  TYPES[type].chain.forEach(t => flow.push({
    id: 'n' + (flow.length + 1), type: t, from: flow.at(-1).id,
    model: t === 'composite' ? '' : model, status: 'idle',
  }));
  return flow;
}

export function makeItem(id, type, name, prompt) {
  const item = {
    id, type, name, kind: TYPES[type].kind, status: 'idle', versions: [], candidate: null,
    approved: false, checks: [],
    prompt: prompt || `以已确认商品为唯一主体，${TYPES[type].hint}。保留商品形状、颜色和已确认参数，不添加文字或虚构卖点。`,
    model: '演示图像模型', size: '1024 × 1024', ratio: TYPES[type].ratio, price: 1.2,
    flow: makeFlow(type),
  };
  return ensureLayout(item);
}

export const baseItems = () => DEFAULT_PLAN.map(([type, name], i) => makeItem(i, type, name));

function syncLegacy(d) {
  const gen = d.flow.find(n => n.type === 'generate');
  d.flow[0].status = 'done';
  if (d.status === 'succeeded') d.flow.forEach(n => { if (n.type !== 'prompt') n.status = 'succeeded'; });
  else if (d.status === 'failed') { gen.status = 'failed'; lane(d, gen).slice(1).forEach(n => { n.status = 'skipped'; }); }
  else if (d.status === 'unknown' || d.status === 'running') gen.status = 'unknown';
}

export function normalize(p) {
  p.planVersion ??= 1;
  p.suggestions ??= [];
  p.requirement ??= '';
  p.items.forEach(d => {
    if (!d.type) d.type = d.kind === 'scene' ? 'scene' : d.kind === 'selling' ? 'selling' : 'white';
    d.ratio ??= TYPES[d.type].ratio;
    d.planVersion ??= 1;
    if (!d.flow) {
      d.flow = makeFlow(d.type, d.model);
      if (p.planReady) syncLegacy(d);
    }
    ensureLayout(d);
    if (p.frozen && d.status !== 'idle') d.frozen = true;
  });
  return p;
}

function seededProject(id, name, stage, sampleProduct) {
  const items = baseItems();
  if (stage > 3) {
    items.forEach(d => {
      d.status = 'succeeded';
      d.versions = [{ id: 1, type: '首次生成', time: '示例记录' }];
      d.candidate = 1;
    });
  }
  if (stage === 3) {
    items[0].status = 'succeeded';
    items[0].versions = [{ id: 1, type: '首次生成', time: '示例记录' }];
    items[1].status = 'failed';
    items[2].status = 'unknown';
  }
  if (stage > 2) items.forEach(d => { if (d.status !== 'idle') syncLegacy(d); else d.flow[0].status = 'done'; });
  return normalize({
    id, name, productId: sampleProduct?.id, snapshot: stage > 2 ? structuredClone(sampleProduct) : null,
    prechecked: stage > 1, planReady: stage > 2, frozen: stage > 2, items, owner: '林晓',
    sample: true, events: [], exported: false,
  });
}

export function createSeedReview(products) {
  const sample = products.find(p => p.id === 'sample-box') || products[0];
  const data = {
    projects: [
      seededProject('demo-spring', '白色收纳盒 · 秋日上新', 3, sample),
      seededProject('demo-studio', '白色收纳盒 · 主图升级', 5, sample),
      seededProject('demo-draft', '家居收纳 · 场景企划', 1, sample),
    ],
    users: [
      { id: 'admin', name: '林晓', account: 'admin', role: '管理员', enabled: true },
      { id: 'operator', name: '陈言', account: 'chenyan', role: '运营', enabled: true },
      { id: 'viewer', name: '许一', account: 'xuyi', role: '只读', enabled: true },
    ],
    ledger: [{ id: 'seed-recharge', label: '演示初始充值', amount: 500, time: '示例记录', type: '充值' }],
    logs: [], prices: [], role: '管理员', flowTemplates: [],
  };
  data.projects.forEach(p => p.items.filter(d => d.status === 'succeeded').forEach(d => data.ledger.push({
    id: 'seed-' + p.id + '-' + d.id, projectId: p.id, label: p.name + ' / ' + d.name + ' / 示例历史',
    amount: -d.price, time: '示例记录', type: '生成',
  })));
  return data;
}

export function loadReview(products) {
  let data = createSeedReview(products);
  try {
    const saved = JSON.parse(localStorage.getItem(REVIEW_KEY) || 'null');
    if (saved?.projects?.length && Array.isArray(saved.users) && Array.isArray(saved.ledger)) data = saved;
  } catch { /* keep seeded data */ }
  data.flowTemplates ??= [];
  data.projects.forEach(normalize);
  // A reload interrupts local animation; an in-flight demo becomes unknown.
  data.projects.forEach(p => p.items.forEach(d => {
    if (d.status === 'running') {
      d.status = 'unknown';
      d.flow.forEach(n => { if (n.status === 'running') n.status = n.type === 'generate' ? 'unknown' : 'idle'; });
    }
  }));
  return data;
}

export function saveReview(data) {
  try { localStorage.setItem(REVIEW_KEY, JSON.stringify(data)); return true; }
  catch { return false; }
}

export function currentStep(p) {
  if (!p.prechecked) return 1;
  if (!p.frozen) return 2;
  if (p.items.some(d => d.status !== 'succeeded')) return 3;
  if (p.items.some(d => !d.candidate)) return 4;
  if (p.items.some(d => !d.approved)) return 5;
  return 6;
}

export const completedSteps = p => (p.exported ? 6 : currentStep(p) - 1);

export function totalCost(data, p) {
  return data.ledger.filter(l => l.projectId === p.id && l.type === '生成').reduce((sum, l) => sum - l.amount, 0);
}

export function lane(d, start) {
  const out = [start];
  let n = start;
  while ((n = d.flow.find(x => x.from === n.id && x.type !== 'generate'))) out.push(n);
  return out;
}

export const lanes = d => d.flow.filter(n => n.type === 'generate').map(g => lane(d, g));
export const estimate = d => d.flow.filter(n => ['idle', 'failed', 'skipped'].includes(n.status)).reduce((s, n) => s + NODE_PRICE[n.type], 0);
export const fullPrice = d => d.flow.reduce((s, n) => s + NODE_PRICE[n.type], 0);
export const chainText = d => {
  const l = lanes(d);
  return ['提示词', ...(l[0] || []).map(n => NODE[n.type])].join(' → ') + (l.length > 1 ? ` · ${l.length} 个分支` : '');
};
export const nextNodeId = d => 'n' + (Math.max(0, ...d.flow.map(n => Number(n.id.slice(1)) || 0)) + 1);

export function charge(data, p, d, label, amount = d.price) {
  data.ledger.unshift({
    id: crypto.randomUUID(), projectId: p.id, label: `${p.name} / ${d.name} / ${label}`,
    amount: -amount, time: stamp(), type: '生成',
  });
}

// Runs every unfinished branch of a confirmed workflow. A failed branch stops;
// there is no automatic retry.
export function runItem(data, p, d, fail, label = '首次生成') {
  d.flow.filter(n => n.type === 'generate' && n.status !== 'succeeded').forEach(g => {
    const chain = lane(d, g);
    if (fail) {
      g.status = 'failed';
      chain.slice(1).forEach(n => { n.status = 'skipped'; });
      return;
    }
    chain.forEach(n => {
      if (n.status === 'succeeded') return;
      n.status = 'succeeded';
      const type = n.type === 'generate' ? label : NODE[n.type];
      d.versions.push({ id: d.versions.length + 1, type, time: stamp(), node: n.id });
      if (NODE_PRICE[n.type]) charge(data, p, d, type, NODE_PRICE[n.type]);
    });
  });
  const gens = d.flow.filter(n => n.type === 'generate');
  d.status = gens.some(n => n.status === 'succeeded') ? 'succeeded'
    : gens.some(n => n.status === 'unknown') ? 'unknown' : 'failed';
  d.approved = false;
  d.checks = [];
}

// Deterministic stand-in for the text-model planner: type library + keyword
// hints + fact guard.
export function planDemo(p, facts = {}) {
  const req = p.requirement || '';
  const plan = DEFAULT_PLAN.map(([type, name]) => [type, name]);
  if (/尺寸|细节|包装|规格|清单/.test(req)) plan.push(['detail', '尺寸与细节']);
  if (/户外|场景|氛围|生活/.test(req)) plan.push(['scene', '补充场景']);
  const known = [facts.name, facts.selling, facts.desc, ...(facts.params || []).flat()].join(' ');
  const claims = ['防水', '防摔', '认证', '食品级', '环保', '抗菌', '承重', '静音'].filter(w => req.includes(w) && !known.includes(w));
  const suggestions = [
    { name: '使用前后对比', hint: '同一空间整理前后对比，商品为唯一新增物品' },
    { name: '多件组合搭配', hint: '同款多件组合陈列，保持比例真实' },
  ];
  return { plan: plan.slice(0, 10), claims, suggestions };
}

export const ASSET_TEMPLATES = [
  { id: 'white', name: '纯白主图', category: '白底', kind: '', desc: '干净背景，准确呈现商品轮廓。', prompt: '{商品}，纯白背景，柔和投影，主体居中；保持原始外形，不添加文字。' },
  { id: 'home', name: '自然光家居场景', category: '场景', kind: 'scene', desc: '统一自然光，为小套图建立空间感。', prompt: '{商品}置于{场景}，柔和窗光，真实比例，保持商品原始颜色和结构，无文字。' },
  { id: 'selling', name: '单一卖点展示', category: '卖点', kind: 'selling', desc: '底图与文案分离，留出排版空间。', prompt: '以{商品}为主体，清晰展示已确认卖点：{卖点}。右侧留白，底图不生成文字。' },
  { id: 'promo', name: '上新促销版式', category: '促销', kind: 'selling', desc: '适合上新首屏，价格需另行核实。', prompt: '{商品}上新视觉，背景简洁明亮，上方留出标题区，不绘制价格或文字。' },
  { id: 'edit', name: '光线与背景精修', category: '改图', kind: 'scene', desc: '保持商品形状，只调整环境。', prompt: '保持{商品}的形状、颜色与数量，仅将环境调整为{场景}，不修改商品。' },
  { id: 'video', name: '产品短片分镜', category: '视频分镜', kind: '', desc: '仅预览结构，视频执行尚未接入。', prompt: '开场全景 → 商品细节 → 使用场景 → 品牌收尾。' },
];

export const NAV_TITLES = { dashboard: '工作台', projects: '项目', project: '项目生产', assets: '素材库', system: '系统管理', products: '商品资料库', generation: '真实生图', 'real-system': '真实渠道管理' };
export const NAV_LABELS = { dashboard: '工作台', projects: '项目', products: '商品', assets: '素材', system: '系统' };
