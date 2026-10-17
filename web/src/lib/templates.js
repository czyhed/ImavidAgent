// 预制提示词模板（Issue #21）：只读配置，不调用模型、不产生费用。
// 模板正文使用 {{占位符}} 语法；art 是自制 CSS/SVG 示意图标记，不含外部 URL。
// 模板带入项目只写本地草稿（sj:prototype:review:v1），不会确认方案或提交生成。

export const TEMPLATE_VERSION = 1;
export const TEMPLATE_CATEGORIES = ['全部', '白底', '场景', '卖点', '促销', '细节', '改图', '视频分镜'];

export const TEMPLATES = [
  {
    id: 'tpl-white-hero',
    version: 1,
    name: '纯白主图 · 轮廓优先',
    category: '白底',
    taskType: 'white',
    appliesTo: '白底主图 / 首图 / 多角度',
    description: '干净白底，优先保证商品轮廓和比例准确，便于后续统一套图。',
    prompt: '以{{商品}}为唯一主体，纯白背景，柔和投影，主体居中并保留完整轮廓；保持原始形状、颜色与比例，不添加文字、道具或未确认卖点。',
    placeholders: [
      { name: '商品', required: true, example: '白色布艺收纳盒，方形敞口', hint: '写清品类与外形，不写未确认参数' },
      { name: '角度', required: false, fallback: '正面略俯视', example: '正面略俯视', hint: '可选；留空使用建议角度' },
    ],
    compat: { ratio: '1:1', size: '1024 × 1024', quality: '标准 / 高质量', note: '白底首图优先 1:1；模型不支持方形时选最接近画幅，后期裁切必须保留完整主体。' },
    art: 'white',
  },
  {
    id: 'tpl-scene-home',
    version: 1,
    name: '自然光家居场景',
    category: '场景',
    taskType: 'scene',
    appliesTo: '场景图 / 家居陈列',
    description: '柔和侧窗光与真实家居环境，为套图建立统一的空间感。',
    prompt: '{{商品}}置于{{场景}}，{{光线}}，真实比例与自然投影；保持商品原始颜色、结构与数量，不添加文字，场景中不出现无关品牌。',
    placeholders: [
      { name: '商品', required: true, example: '白色布艺收纳盒', hint: '与商品资料名称保持一致' },
      { name: '场景', required: true, example: '木质衣柜旁的地板', hint: '只写已确认可用的真实场景' },
      { name: '光线', required: false, fallback: '柔和侧窗光', example: '午后侧窗光', hint: '可选；留空使用柔和侧窗光' },
    ],
    compat: { ratio: '3:4', size: '1024 × 1365', quality: '标准', note: '场景图建议 3:4 竖版；模型只支持 1:1 时保留完整商品，并为后期裁切留出空间。' },
    art: 'scene',
  },
  {
    id: 'tpl-scene-table',
    version: 1,
    name: '桌面使用场景',
    category: '场景',
    taskType: 'scene',
    appliesTo: '场景图 / 桌面陈列',
    description: '用少量搭配物交代使用方式，避免堆砌道具遮挡商品。',
    prompt: '{{商品}}放在{{台面}}上，旁边搭配{{搭配物}}，营造{{氛围}}的日常使用氛围；商品保持真实比例和结构，不添加文字或虚构功能。',
    placeholders: [
      { name: '商品', required: true, example: '晨间陶瓷杯', hint: '写清品类与已确认颜色' },
      { name: '台面', required: true, example: '浅色木桌', hint: '材质与颜色会影响整体色调' },
      { name: '搭配物', required: true, example: '一小摞书和绿植', hint: '控制在 1–2 件，不遮挡主体' },
      { name: '氛围', required: false, fallback: '安静', example: '清晨安静', hint: '可选；留空使用「安静」' },
    ],
    compat: { ratio: '4:3', size: '1024 × 768', quality: '标准', note: '桌面场景建议 4:3；若用于竖版首屏，请改用 3:4 模板并重新确认裁切。' },
    art: 'table',
  },
  {
    id: 'tpl-selling-single',
    version: 1,
    name: '单一卖点信息位',
    category: '卖点',
    taskType: 'selling',
    appliesTo: '卖点图 / 促销底图',
    description: '底图只呈现画面，文案与价格另行排版，避免模型写错字。',
    prompt: '以{{商品}}为主体，清晰呈现已确认卖点：{{卖点}}。{{留白}}留出标题与参数排版空间，底图不生成任何文字、价格或认证标识。',
    placeholders: [
      { name: '商品', required: true, example: '45L 白色收纳盒', hint: '只引用已确认事实' },
      { name: '卖点', required: true, example: '同规格可叠放', hint: '必须来自商品已确认卖点' },
      { name: '留白', required: false, fallback: '右侧', example: '右侧', hint: '可选；留空在右侧留白' },
    ],
    compat: { ratio: '1:1', size: '1024 × 1024', quality: '标准', note: '卖点文案由模板合成排版；底图留白建议不少于 30%，未确认卖点不得写入提示词。' },
    art: 'selling',
  },
  {
    id: 'tpl-selling-stack',
    version: 1,
    name: '多件组合卖点',
    category: '卖点',
    taskType: 'selling',
    appliesTo: '卖点图 / 多件组合',
    description: '同款多件组合展示容量与收纳关系，适合表现可叠放等卖点。',
    prompt: '{{数量}}件{{商品}}同款组合陈列，展示{{卖点}}；保持每件比例与颜色一致，排列整齐，{{留白}}留出文案区，不生成文字。',
    placeholders: [
      { name: '商品', required: true, example: '白色收纳盒', hint: '多件必须为同款同色' },
      { name: '卖点', required: true, example: '可叠放节省空间', hint: '必须来自已确认卖点' },
      { name: '数量', required: false, fallback: '两', example: '两', hint: '可选；建议 2–3 件，留空为两件' },
      { name: '留白', required: false, fallback: '左侧', example: '左侧', hint: '可选；留空在左侧留白' },
    ],
    compat: { ratio: '3:4', size: '1024 × 1365', quality: '标准', note: '多件组合易改变比例；建议 3:4 竖版并逐件核对数量、颜色与结构。' },
    art: 'stack',
  },
  {
    id: 'tpl-promo-new',
    version: 1,
    name: '上新首屏促销版式',
    category: '促销',
    taskType: 'selling',
    appliesTo: '上新首屏 / 促销底图',
    description: '简洁色块与标题区，价格和活动信息一律由人工排版。',
    prompt: '{{商品}}上新首屏视觉，背景为{{主色}}简洁色块，商品完整居中，上方保留标题区；不绘制价格、折扣或未经核实的促销信息。',
    placeholders: [
      { name: '商品', required: true, example: '白色收纳盒', hint: '写清品类与主色' },
      { name: '主色', required: false, fallback: '低饱和米白', example: '低饱和米白', hint: '可选；避免与商品颜色冲突' },
    ],
    compat: { ratio: '4:5', size: '1024 × 1280', quality: '高质量', note: '促销信息必须由模板合成并在发布前二次核对；底图不得出现文字、价格或折扣数字。' },
    art: 'promo',
  },
  {
    id: 'tpl-promo-season',
    version: 1,
    name: '季节活动氛围',
    category: '促销',
    taskType: 'scene',
    appliesTo: '活动图 / 季节主题',
    description: '用季节氛围强化首屏情绪，商品本身保持克制不变形。',
    prompt: '{{商品}}置于{{季节}}主题场景中，色调为{{色调}}，保留商品原始外形与已确认颜色；画面不出现文字、节日标识或品牌 Logo。',
    placeholders: [
      { name: '商品', required: true, example: '晨间陶瓷杯', hint: '写清品类与颜色' },
      { name: '季节', required: true, example: '初秋', hint: '只写氛围，不写未确认活动' },
      { name: '色调', required: false, fallback: '温暖低饱和', example: '温暖低饱和', hint: '可选；留空使用温暖低饱和' },
    ],
    compat: { ratio: '1:1', size: '1024 × 1024', quality: '标准', note: '活动图多用 1:1 或 4:5；季节元素不得遮挡商品，也不得暗示未确认的赠品或折扣。' },
    art: 'season',
  },
  {
    id: 'tpl-detail-closeup',
    version: 1,
    name: '细节与尺寸特写',
    category: '细节',
    taskType: 'detail',
    appliesTo: '细节图 / 尺寸说明 / 包装清单',
    description: '突出材质与结构细节，尺寸数字留给后期排版，避免模型乱写。',
    prompt: '{{商品}}的{{细节部位}}特写，真实材质纹理与颜色，浅景深；{{标注区}}预留尺寸标注区域，不生成文字或数字，尺寸由后期排版补充。',
    placeholders: [
      { name: '商品', required: true, example: '白色收纳盒', hint: '写清品类' },
      { name: '细节部位', required: true, example: '侧边提手与卡扣', hint: '只写真实存在的结构' },
      { name: '标注区', required: false, fallback: '右下角', example: '右下角', hint: '可选；留空在右下角留白' },
    ],
    compat: { ratio: '3:4', size: '1024 × 1365', quality: '高质量', note: '细节图建议 3:4 并预留标注区域；尺寸数字必须由人工排版，不让模型生成。' },
    art: 'detail',
  },
  {
    id: 'tpl-edit-light',
    version: 1,
    name: '光线与背景精修',
    category: '改图',
    taskType: 'edit',
    appliesTo: '精修 / 改图（需要有效源图）',
    description: '只调整背景与光线，锁定商品本身；需要供应商仍可访问的源图。',
    prompt: '以已提供图片为基础，保持{{商品}}的{{保留项}}不变，仅把背景与光线调整为{{场景}}；不改变形状、颜色、数量和已确认细节，不添加文字。',
    placeholders: [
      { name: '商品', required: true, example: '白色收纳盒', hint: '与源图中的商品一致' },
      { name: '场景', required: true, example: '柔和的浅灰背景与自然侧光', hint: '只描述环境变化' },
      { name: '保留项', required: false, fallback: '形状、颜色与数量', example: '形状、颜色与数量', hint: '可选；留空锁定形状、颜色与数量' },
    ],
    compat: { ratio: '沿用源图画幅', size: '与源图一致', quality: '高质量', note: '改图必须使用有效源图；供应商保留期约 23 小时，过期图只能查看或下载，不能直接改图。' },
    art: 'edit',
  },
  {
    id: 'tpl-video-storyboard',
    version: 1,
    name: '产品短片分镜',
    category: '视频分镜',
    taskType: 'video',
    appliesTo: '视频分镜（仅查看结构）',
    description: '预览分镜结构，可填写与复制提示词；视频执行器未接入。',
    prompt: '{{商品}}产品短片分镜：开场全景（{{使用场景}}）→ 细节特写 → 使用中景 → 品牌收尾。镜头{{镜头感}}，全片保持商品真实比例与颜色，不添加文字。',
    placeholders: [
      { name: '商品', required: true, example: '白色收纳盒', hint: '写清品类与颜色' },
      { name: '使用场景', required: true, example: '衣物收纳', hint: '只写已确认用途' },
      { name: '镜头感', required: false, fallback: '平稳推进', example: '平稳推进', hint: '可选；留空使用平稳推进' },
    ],
    compat: { ratio: '9:16 或 16:9', size: '—', quality: '—', note: '仅查看与复制结构；视频模型只同步目录，执行器未接入，不提交视频任务、不计费。' },
    art: 'storyboard',
    video: true,
    bringable: false,
  },
];

export const templateById = id => TEMPLATES.find(template => template.id === id);

export function templatePlaceholders(template) {
  return template?.placeholders || [];
}

export function renderTemplate(template, values = {}) {
  if (!template) return '';
  return template.prompt.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, name) => {
    const value = String(values[name] ?? '').trim();
    if (value) return value;
    const definition = template.placeholders.find(item => item.name === name);
    if (definition && !definition.required && definition.fallback) return definition.fallback;
    return match;
  });
}

export function missingRequired(template, values = {}) {
  return template.placeholders
    .filter(item => item.required && !String(values[item.name] ?? '').trim())
    .map(item => item.name);
}

export function templateMatches(template, category = '全部', query = '') {
  const inCategory = category === '全部' || template.category === category;
  const text = `${template.name} ${template.category} ${template.appliesTo} ${template.description} ${template.prompt}`.toLowerCase();
  return inCategory && text.includes(query.trim().toLowerCase());
}
