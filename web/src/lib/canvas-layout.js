// 画布自动布局（纯函数）：按任务「维度」分 lane，lane 内按依赖深度从左到右，
// 输出节点跟随上游 lane 靠右；无维度任务按依赖层级兜底。参考草图 caotu.png。
export const DIMENSION_PRESETS = ['商品白底图', '多卖点组合图', '多卖点实拍说明', '详情参数图', '使用场景图'];
export const SOURCE_LANE = '素材与提示词';
export const UNGROUPED_LANE = '未分组';
const SOURCE_KINDS = new Set(['product', 'image', 'prompt']);
const COLUMN_GAP = 320;
const ROW_GAP = 64;
const LANE_GAP = 40;
const ORIGIN_X = 80;
const ORIGIN_Y = 60;

function dimensionOf(task) {
  const value = typeof task?.dimension === 'string' ? task.dimension.trim() : '';
  return value || null;
}

// 依赖深度：从任意来源节点出发的最长路径。
function depthsOf(tasks, edges) {
  const inbound = new Map(tasks.map(t => [t.id, []]));
  for (const edge of edges) if (inbound.has(edge.target)) inbound.get(edge.target).push(edge.source);
  const depths = new Map();
  const visiting = new Set();
  const depth = id => {
    if (depths.has(id)) return depths.get(id);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const sources = inbound.get(id) || [];
    const value = sources.length ? Math.max(...sources.map(depth)) + 1 : 0;
    visiting.delete(id);
    depths.set(id, value);
    return value;
  };
  for (const task of tasks) depth(task.id);
  return depths;
}

export function autoLayout(tasks, edges = [], { columnGap = COLUMN_GAP, rowGap = ROW_GAP } = {}) {
  const list = Array.isArray(tasks) ? tasks : [];
  if (!list.length) return {};
  const depths = depthsOf(list, edges);
  const byId = new Map(list.map(t => [t.id, t]));
  const laneOf = new Map();
  const laneKey = task => {
    if (laneOf.has(task.id)) return laneOf.get(task.id);
    let key;
    const dimension = dimensionOf(task);
    if (dimension) key = dimension;
    else if (SOURCE_KINDS.has(task.kind)) key = SOURCE_LANE;
    else {
      // 生成/输出节点未标维度：继承第一个图片/视频上游的维度，否则归入未分组。
      const upstream = edges.filter(e => e.target === task.id).map(e => byId.get(e.source)).find(Boolean);
      const inherited = upstream ? laneKey(upstream) : null;
      key = inherited && inherited !== SOURCE_LANE ? inherited : UNGROUPED_LANE;
    }
    laneOf.set(task.id, key);
    return key;
  };
  for (const task of list) laneKey(task);
  const order = [];
  for (const lane of [SOURCE_LANE, UNGROUPED_LANE]) if (list.some(t => laneOf.get(t.id) === lane)) order.push(lane);
  for (const task of list) {
    const lane = laneOf.get(task.id);
    if (!order.includes(lane)) order.push(lane);
  }
  // lane 内按 (深度, 原顺序) 排；同 lane 同深度垂直堆叠。
  const cells = new Map();
  list.forEach((task, index) => {
    const key = laneOf.get(task.id);
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push({ task, depth: depths.get(task.id) || 0, index });
  });
  let y = ORIGIN_Y;
  const positions = {};
  for (const lane of order) {
    const items = cells.get(lane).sort((a, b) => a.depth - b.depth || a.index - b.index);
    const stacks = new Map();
    let rowHeight = 0;
    for (const item of items) {
      const count = stacks.get(item.depth) || 0;
      stacks.set(item.depth, count + 1);
      item.stack = count;
      rowHeight = Math.max(rowHeight, (count + 1) * rowGap);
    }
    for (const item of items) {
      positions[item.task.id] = {
        x: Math.round(ORIGIN_X + item.depth * columnGap),
        y: Math.round(y + item.stack * rowGap),
      };
    }
    y += rowHeight + LANE_GAP;
  }
  return positions;
}
