// 分页纯函数：页码换算、去重合并、引用素材编号收集与分批。UI 组件与测试共用，不依赖 React。

// 当前页（从 1 开始）与总页数；total 为 0 时仍算 1 页。
export function pageInfo(total, offset, size) {
  const pages = Math.max(1, Math.ceil((total || 0) / size));
  const page = Math.min(pages, Math.floor(Math.max(0, offset) / size) + 1);
  return { page, pages, from: total ? (page - 1) * size + 1 : 0, to: Math.min(total || 0, page * size) };
}

// 删除 / 移入回收站后当前页可能已空：回退到最后一个有数据的页偏移；仍有数据时返回 null。
export function clampOffset(total, offset, size) {
  if (offset <= 0 || offset < total) return null;
  return Math.max(0, (Math.ceil(total / size) - 1) * size);
}

// 按 id 去重追加（加载更多）：已有的条目保持原位置，新条目接在后面。
export function appendUnique(existing, incoming) {
  const seen = new Set(existing.map(item => item.id));
  return [...existing, ...incoming.filter(item => !seen.has(item.id))];
}

// 列表查询串：忽略空值，保证 limit / offset 总在末尾，便于缓存键与测试。
export function pageQuery(params = {}, limit, offset = 0) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  if (limit) { query.set('limit', String(limit)); query.set('offset', String(offset)); }
  return query.toString();
}

const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
// 项目草稿里引用的素材编号：任务来源图与尾帧（已删除检测、名称显示所需）；缩略图直接用文件地址，不依赖素材列表。
export function referencedAssetIds(draft) {
  const ids = new Set(), add = value => { if (typeof value === 'string' && ID.test(value)) ids.add(value); };
  for (const task of draft?.tasks || []) { add(task.sourceAssetId); add(task.tailFrame?.assetId); }
  return [...ids];
}

// 分批：服务端 ids 查询最多 100 个。
export function chunk(list, size = 50) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
