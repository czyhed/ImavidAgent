export const PRODUCTS_KEY = 'sj:prototype:products:v1';
export const PRODUCT_STATES = { draft: '草稿', pending: '待核实', confirmed: '已确认' };

export const PRODUCT_SEED = [
  { id: 'sample-box', name: '白色收纳盒', brand: '留白家居', category: '收纳用品', sku: 'HB-045-WH', price: '69', priceMax: '', currency: 'CNY', priceType: '售价', condition: '单个装，不含运费', status: 'confirmed', art: 'box', color: '#E9EADD', description: '可叠放收纳盒，适用于衣柜与家居杂物整理。', selling: '45L 容量\n同规格可叠放', params: [['容量', '45', 'L'], ['尺寸', '58 × 40 × 30', 'cm'], ['材质', 'PP', ''], ['颜色', '白色', '']], source: '示例资料', url: '', version: 1, updatedAt: '2026-10-20T03:32:00Z', history: ['v1 · 示例资料已确认'] },
  { id: 'sample-mug', name: '晨间陶瓷杯', brand: '日常器物', category: '餐厨用品', sku: 'MG-320-CR', price: '39', priceMax: '59', currency: 'CNY', priceType: '价格区间', condition: '不同釉色与套装价格不同', status: 'pending', art: 'mug', color: '#EEE4D5', description: '温润釉面，适合日常饮水与咖啡。', selling: '', params: [['容量', '320', 'mL'], ['材质', '陶瓷', '']], source: '链接解析示例', url: 'https://demo.example/products/morning-mug', version: 1, updatedAt: '2026-10-20T02:45:00Z', history: ['v1 · 示例解析结果，待核实规格与价格'] },
  { id: 'sample-lamp', name: '折页桌面灯', brand: '几何生活', category: '家居照明', sku: 'LT-012-SD', price: '', priceMax: '', currency: '', priceType: '售价', condition: '', status: 'draft', art: 'lamp', color: '#E2E9E7', description: '桌面照明资料待补充。', selling: '', params: [['颜色', '砂白', '']], source: '手动录入示例', url: '', version: 1, updatedAt: '2026-10-19T09:20:00Z', history: ['v1 · 保存草稿'] },
  { id: 'sample-bag', name: '日用帆布托特包', brand: '慢作', category: '箱包配饰', sku: 'BG-001-NT', price: '89', priceMax: '', currency: 'CNY', priceType: '售价', condition: '单件', status: 'pending', art: 'bag', color: '#E9E5DC', description: '天然色帆布，简洁无印花。', selling: '', params: [['材质', '帆布', ''], ['颜色', '天然色', '']], source: '手动录入示例', url: '', version: 1, updatedAt: '2026-10-19T08:10:00Z', history: ['v1 · 等待核实尺寸'] },
];

export const now = () => new Date().toISOString();
export const formatDate = value => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
export const newId = () => crypto.randomUUID();

export function loadProducts() {
  let products = structuredClone(PRODUCT_SEED);
  let warning = '';
  try {
    const saved = JSON.parse(localStorage.getItem(PRODUCTS_KEY) || 'null');
    if (Array.isArray(saved) && saved.every(p => p && typeof p.id === 'string' && typeof p.name === 'string' && Array.isArray(p.params) && PRODUCT_STATES[p.status])) products = saved;
  } catch { warning = '本地资料暂时无法读取。当前显示示例，请检查浏览器存储权限。'; }
  return { products, warning };
}

export function saveProducts(products) {
  try { localStorage.setItem(PRODUCTS_KEY, JSON.stringify(products)); return true; }
  catch { return false; }
}

export function productPrice(p) {
  if (p.price === '' || p.price == null) return '未录入';
  const symbol = { CNY: '¥', USD: '$', EUR: '€' }[p.currency] || '';
  return symbol + p.price + (p.priceMax ? '–' + p.priceMax : '') + (!p.currency ? '（币种待核实）' : '');
}

export function productMissing(p) {
  return [!p.sku && 'SKU', (p.price === '' || p.price == null) && '价格', p.price !== '' && !p.currency && '币种', !p.params.length && '商品参数'].filter(Boolean);
}

export function screenshotProduct(seedProduct) {
  return {
    ...structuredClone(seedProduct || PRODUCT_SEED[1]),
    id: newId(), name: '燕麦色陶瓷杯', sku: '', price: '49', priceMax: '', currency: 'CNY',
    source: '截图识别演示', url: '', status: 'pending', version: 1, updatedAt: now(),
    importFingerprint: 'demo-screenshot-mug-v1',
    evidence: [['商品名称', '截图 1 · 标题', '高'], ['容量 320 mL', '截图 2 · 参数表', '高'], ['售价 ¥49', '截图 1 · 单杯售价，需核对条件', '中']],
    history: ['v1 · 示例截图建档，字段待人工核实；未调用视觉模型'],
  };
}

export const PRODUCT_IMPORT_EXAMPLES = {
  tray: 'https://demo.example/products/bamboo-tray',
  mug: 'https://demo.example/products/ceramic-cup',
  locked: 'https://demo.example/products/private-item',
};

export function importedProduct(url) {
  const partial = url === PRODUCT_IMPORT_EXAMPLES.mug;
  return {
    id: newId(), name: partial ? '素白陶瓷杯' : '竹制长方形托盘', brand: partial ? '' : '木间', category: '餐厨用品',
    sku: partial ? '' : 'TR-032-NT', price: partial ? '' : '49.90', priceMax: '', currency: partial ? '' : 'CNY',
    priceType: '售价', condition: partial ? '' : '原色 / 单件，价格为演示快照',
    status: 'pending', art: partial ? 'mug' : 'tray', color: partial ? '#EEE4D5' : '#EBE4D5',
    description: partial ? '示例页面仅提供商品名称与材质，其他信息需要补充。' : '竹制托盘，适合茶杯、咖啡与餐点摆放。以下资料均为交互演示。',
    selling: '', params: partial ? [['材质', '陶瓷', '']] : [['材质', '竹', ''], ['尺寸', '32 × 22 × 2', 'cm'], ['颜色', '原色', '']],
    source: '链接解析示例', url, version: 1, updatedAt: now(),
    history: ['v1 · 演示解析完成，保存为待核实草稿'],
  };
}

export function productBrief(p) {
  return `商品：${p.name}\nSKU：${p.sku || '未填写'}\n品牌：${p.brand || '未填写'}\n资料版本：v${p.version}\n\n已确认参数：\n${p.params.map(row => `${row[0]}：${row[1]} ${row[2]}`).join('\n')}\n\n价格快照：${productPrice(p)}（${p.priceType}）\n适用条件：${p.condition || '未填写'}\n\n商品说明：${p.description || '未填写'}\n卖点记录：${p.selling || '未填写'}\n\n创作约束：仅使用以上已确认事实，不补造参数；价格进入广告前再次核对适用条件与时效。`;
}
