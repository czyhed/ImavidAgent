"""Build offline documentation diagrams from the canonical functional spec."""
from pathlib import Path
import json
import re
import html

ROOT = Path(__file__).resolve().parents[2]
DOCS = ROOT / "docs"
spec = (DOCS / "FUNCTIONAL_SPEC.md").read_text(encoding="utf-8")
groups = [
    ("HOME", "工作台", "指标、待办与动态", "#416674", "left"),
    ("PROD", "商品维护与录入", "长期聊天 · 文字与图片", "#32735A", "left"),
    ("FLOW", "项目无限画布", "安排任务与多次生成", "#365DA2", "left"),
    ("ASSET", "素材库与预制模板", "图片视频 · 模板与回收站", "#977131", "left"),
    ("USER", "系统 · 账号与权限", "单工作空间 · 多账号", "#6C5796", "right"),
    ("MODEL", "系统 · 模型能力", "统一注册、授权与调用", "#287C83", "right"),
    ("BILL", "系统 · 实际用量与成本", "取消报价与余额门槛", "#AC6340", "right"),
    ("LOG", "系统 · 日志与审计", "可追溯 · 按权限脱敏", "#677149", "right"),
    ("NEXT", "后续扩展", "不纳入本轮交付", "#78818C", "right"),
]
nodes = []
for line in spec.splitlines():
    match = re.match(r"\| ((?:HOME|PROD|FLOW|ASSET|USER|MODEL|BILL|LOG|NEXT)-\d+) \| (.+?) \| (.+?) \|$", line)
    if match:
        ident, title, detail = match.groups()
        scope = "后续" if ident.startswith("NEXT") else "条件验收" if ident == "PROD-04" else "本轮"
        nodes.append({"id": ident, "title": title, "detail": detail, "scope": scope})
assert len({n["id"] for n in nodes}) == len(nodes), "Duplicate feature ID"
data = {"version": "2.0", "date": "2026-10-22", "groups": [
    {"id": key, "title": title, "subtitle": sub, "color": color, "side": side,
     "items": [n for n in nodes if n["id"].startswith(key + "-")]}
    for key, title, sub, color, side in groups
]}
assert all(g["items"] for g in data["groups"])
(DOCS / "requirements/function-map.json").write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def static_svg():
    heights = {g["id"]: max(82, len(g["items"]) * 38 + 18) for g in data["groups"]}
    sides = {s: [g for g in data["groups"] if g["side"] == s] for s in ["left", "right"]}
    totals = {s: sum(heights[g["id"]] for g in gs) + 36 * (len(gs) - 1) for s, gs in sides.items()}
    height = max(totals.values()) + 240
    cy = 140 + max(totals.values()) / 2
    e = html.escape
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="{height}" viewBox="0 0 2400 {height}" role="img" aria-labelledby="title desc">',
             '<title id="title">商境功能思维导图 v2.0</title><desc id="desc">一期开发基线，覆盖工作台、商品、项目、素材、系统、模型、账单、日志与后续范围；需求不等于已实现。</desc>',
             f'<rect width="2400" height="{height}" fill="#F3F5F0"/>',
             '<g font-family="Microsoft YaHei, Noto Sans SC, sans-serif">',
             '<text x="44" y="57" font-size="31" font-weight="700" fill="#172A23">商境 · 功能思维导图</text>',
             f'<text x="44" y="92" font-size="18" fill="#5B6C64">v2.0 / 2026.10.22　·　{len(nodes)} 项功能　·　需求范围，不代表实现状态　·　功能编号对应 FUNCTIONAL_SPEC.md</text>']
    for side, gs in sides.items():
        y = 140 + (max(totals.values()) - totals[side]) / 2
        for group in gs:
            gh = heights[group["id"]]
            gy = y + gh / 2
            left = side == "left"
            gx, lx = (650, 44) if left else (1500, 1810)
            color = group["color"]
            root_edge, group_edge = (1040, 900) if left else (1360, 1500)
            parts.append(f'<path d="M{root_edge},{cy} C{(root_edge+group_edge)/2},{cy} {(root_edge+group_edge)/2},{gy} {group_edge},{gy}" stroke="{color}" stroke-width="2.5" fill="none" opacity=".65"/>')
            parts.append(f'<rect x="{gx}" y="{gy-36}" width="250" height="72" rx="9" fill="white" stroke="{color}" stroke-width="2"/>')
            parts.append(f'<text x="{gx+125}" y="{gy-5}" text-anchor="middle" font-size="21" font-weight="700" fill="{color}">{e(group["title"])}</text>')
            parts.append(f'<text x="{gx+125}" y="{gy+22}" text-anchor="middle" font-size="14" fill="#5B6C64">{e(group["subtitle"])} · {len(group["items"])} 项</text>')
            for i, item in enumerate(group["items"]):
                ly = y + 9 + i * 38 + 19
                x1, x2 = (gx, lx + 550) if left else (gx + 250, lx)
                parts.append(f'<path d="M{x1},{gy} C{(x1+x2)/2},{gy} {(x1+x2)/2},{ly} {x2},{ly}" stroke="{color}" stroke-width="1.2" fill="none" opacity=".4"/>')
                parts.append(f'<g><title>{e(item["detail"])}</title><rect x="{lx}" y="{ly-16}" width="550" height="32" rx="5" fill="white" stroke="#D9E1D7"/>')
                parts.append(f'<text x="{lx+12}" y="{ly+5}" font-size="12" fill="{color}">{item["id"]}</text><text x="{lx+108}" y="{ly+6}" font-size="17" fill="#20372B">{e(item["title"])}</text>')
                if item["scope"] != "本轮":
                    parts.append(f'<text x="{lx+537}" y="{ly+5}" text-anchor="end" font-size="12" fill="{color}">{item["scope"]}</text>')
                parts.append('</g>')
            y += gh + 36
    parts += [f'<rect x="1040" y="{cy-64}" width="320" height="128" rx="12" fill="#183D2F"/>',
              f'<text x="1200" y="{cy-20}" font-size="30" font-weight="700" text-anchor="middle" fill="white">商境开发基线</text>',
              f'<text x="1200" y="{cy+16}" font-size="18" text-anchor="middle" fill="#DDF08B">商品资料 → 画布 → 图与视频</text>',
              f'<text x="1200" y="{cy+43}" font-size="15" text-anchor="middle" fill="#C2D4C8">商品聊天 · 手动开始 · 图片视频</text>',
              f'<text x="44" y="{height-45}" font-size="17" fill="#5B6C64">阅读提示：本轮以商品聊天、React Flow 画布、动态模型、视频与回收站为主线。实现进度见 STATUS.md。</text>',
              '</g></svg>']
    return "\n".join(parts)


(DOCS / "ecommerce-ai-feature-mindmap.svg").write_text(static_svg() + "\n", encoding="utf-8")

outline = ["# 商境功能思维导图 v2.0", "", "与 [开发基线](FUNCTIONAL_SPEC.md) 同源生成。下列“本轮”表示需求范围，不表示功能已经开发。",
           "", "[交互版](ecommerce-ai-feature-mindmap.html) · [SVG 完整图](ecommerce-ai-feature-mindmap.svg)", "", "## 功能树", ""]
for group in data["groups"]:
    outline += ["### " + group["title"], ""]
    outline += [f'- **{n["id"]} {n["title"]}**（{n["scope"]}）：{n["detail"]}' for n in group["items"]]
    outline += [""]
outline += ["## Mermaid 源码", "", "```mermaid", "mindmap", "  root((商境功能基线 v2.0))"]
for group in data["groups"]:
    outline += ["    " + group["title"].replace("·", "")]
    outline += ["      " + n["id"] + " " + n["title"] + ("【" + n["scope"] + "】" if n["scope"] != "本轮" else "") for n in group["items"]]
outline += ["```", "", "生成方式：`python scripts/docs/build_feature_map.py`。功能表为来源，禁止只改图而不更新功能基线。", ""]
(DOCS / "ecommerce-ai-feature-mindmap.md").write_text("\n".join(outline), encoding="utf-8")

template = r'''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>商境 · 功能思维导图 v2.0</title>
<style>
:root{--paper:#f3f5f0;--ink:#1b3328;--muted:#65746a;--line:#d7dfd3;--green:#1b513a}
*{box-sizing:border-box}body{margin:0;color:var(--ink);background:var(--paper);font:14px/1.6 "Microsoft YaHei","Noto Sans SC",sans-serif}
button,input,select{font:inherit;color:inherit}button,a,input,select{touch-action:manipulation}button{cursor:pointer;border:1px solid var(--line);background:white;padding:8px 12px;border-radius:5px}button:hover{border-color:var(--green)}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #af832e;outline-offset:2px}a{color:var(--green)}
header{padding:26px 32px 20px;border-bottom:1px solid var(--line);background:#fff;display:flex;justify-content:space-between;gap:20px;flex-wrap:wrap}
.eyebrow{font-size:11px;letter-spacing:2px;color:var(--muted)}h1{font-size:28px;margin:4px 0 8px}header p{margin:0;color:var(--muted);max-width:820px}.links{display:flex;gap:16px;align-items:center;flex-wrap:wrap}
.toolbar{display:flex;gap:9px;flex-wrap:wrap;align-items:center;padding:14px 32px;border-bottom:1px solid var(--line)}
.toolbar label{display:flex;align-items:center;gap:7px}.toolbar input{padding:8px 10px;border:1px solid var(--line);width:230px;border-radius:5px;background:white}.toolbar select{padding:8px;border:1px solid var(--line);background:white}.primary{background:var(--green);color:white}.count{margin-left:auto;color:var(--muted);font-size:12px}
.layout{display:grid;grid-template-columns:minmax(0,1fr) 318px;min-height:640px}.canvas-wrap{min-width:0;position:relative}.canvas{overflow:auto;height:calc(100vh - 244px);min-height:550px;padding:20px;scrollbar-gutter:stable;background-image:radial-gradient(#d4ddd1 1px,transparent 1px);background-size:20px 20px}svg{display:block;margin:auto}svg g[data-group],svg g[data-feature]{cursor:pointer}svg g:focus{outline:none}svg g:focus>rect{stroke:#9c7222;stroke-width:3}.hint{padding:9px 32px;color:var(--muted);font-size:12px;border-top:1px solid var(--line)}
aside{padding:24px;border-left:1px solid var(--line);background:#fff;overflow-wrap:anywhere}aside h2{font-size:20px;margin:10px 0}aside p{color:var(--muted)}.tag{display:inline-block;padding:3px 8px;background:#eef3e5;font-size:12px}.detail-id{font:12px Consolas,monospace;color:var(--green)}aside ul{padding-left:18px}aside li{margin-bottom:8px}
.legend{display:flex;gap:14px;font-size:12px;margin:22px 0;flex-wrap:wrap}.legend span:before{content:"";display:inline-block;width:7px;height:7px;border-radius:50%;background:#337559;margin-right:5px}.legend span:nth-child(2):before{background:#ac7831}.legend span:nth-child(3):before{background:#78818c}
#empty{padding:80px 20px;text-align:center;color:var(--muted)}[hidden]{display:none!important}footer{padding:14px 32px;border-top:1px solid var(--line);font-size:12px;color:var(--muted)}
@media(max-width:900px){.layout{grid-template-columns:1fr}.canvas{height:62vh;min-height:430px}aside{border-left:0;border-top:1px solid var(--line)}header,.toolbar{padding-left:18px;padding-right:18px}.count{margin-left:0}.toolbar input{width:185px}header h1{font-size:24px}}
@media print{header,.toolbar,aside,.hint,footer{display:none}.layout{display:block}.canvas{height:auto;overflow:visible;background:none;padding:0}svg{width:100%!important;height:auto!important}}
</style></head><body>
<header><div><div class="eyebrow">SHANGJING / FUNCTIONAL SPECIFICATION</div><h1>商境 · 功能思维导图</h1><p>一个商品，一条生产主线。点开分支看功能，点选功能看规则；这里展示开发范围，不代表当前已经实现。</p></div><nav class="links" aria-label="文档"><a href="FUNCTIONAL_SPEC.md">完整开发文档</a><a href="ecommerce-ai-feature-mindmap.svg" download>下载 SVG</a><a href="ecommerce-ai-feature-mindmap.md">文字版</a></nav></header>
<div class="toolbar"><label>搜索 <input id="search" placeholder="功能名称、编号或规则"></label><label>范围 <select id="scope"><option value="all">全部范围</option><option value="current">本轮与条件验收</option><option value="后续">后续扩展</option></select></label><button id="expand" class="primary">全部展开</button><button id="collapse">收起总览</button><button id="minus" aria-label="缩小">−</button><button id="plus" aria-label="放大">＋</button><button id="fit">适应宽度</button><span class="count" id="count" role="status" aria-live="polite"></span></div>
<main class="layout"><div class="canvas-wrap"><div class="canvas" id="canvas"><div id="empty" hidden>没有匹配功能，请更换关键词或范围。</div><svg id="map" role="img" aria-label="可展开的功能思维导图"></svg></div><div class="hint">点击模块展开/收起 · 点击功能查看右侧说明 · 放大后可滚动查看 · 无需联网</div></div>
<aside id="detail"><span class="detail-id">DEVELOPMENT BASELINE / V2.0</span><h2>创作工作台四条主线</h2><p>项目负责生产，商品提供事实，素材保留产出，系统提供账号、模型、费用和日志。</p><ul><li>商品聊天保存事实，创作素材单独上传。</li><li>项目直接进入 React Flow 无限画布。</li><li>图片视频自动入库，模板和回收站可管理。</li><li>AI 安排经确认应用，点击开始才生成。</li><li>模型能力由管理员指定，未知费用保持未统计。</li></ul><div class="legend"><span>本轮</span><span>条件验收</span><span>后续</span></div><p>全部确认依据见43项 grill-me 记录，验收见开发基线。点击具体功能查看对应编号和规则。</p></aside></main>
<footer>2026.10.22 · 与 FUNCTIONAL_SPEC.md 同源生成 · 决策依据来自四个 OpenCode 讨论会话 · 文档图示，不是新增产品原型</footer>
<script id="map-data" type="application/json">__DATA__</script>
<script>
(()=>{'use strict';
const data=JSON.parse(document.querySelector('#map-data').textContent), svg=document.querySelector('#map'), canvas=document.querySelector('#canvas'), detail=document.querySelector('#detail');
const expanded=new Set(), all=data.groups.flatMap(g=>g.items), $=s=>document.querySelector(s);
let zoom=1, selected=null, bounds=[0,0,2400,1000];
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const path=(x,y,a,b,color,w=1.2)=>`<path d="M${x},${y} C${(x+a)/2},${y} ${(x+a)/2},${b} ${a},${b}" fill="none" stroke="${color}" stroke-width="${w}" opacity=".55"/>`;
function size(){const width=Math.max(300,canvas.clientWidth-44,bounds[2]*.78)*zoom;svg.style.width=width+'px';svg.style.height=(width*bounds[3]/bounds[2])+'px'}
function render(){
 const q=$('#search').value.trim().toLowerCase(), scope=$('#scope').value;
 const groups=data.groups.map(g=>({...g,items:g.items.filter(n=>(scope==='all'||(scope==='current'?n.scope!=='后续':n.scope===scope))&&(!q||(g.title+n.id+n.title+n.detail).toLowerCase().includes(q)))})).filter(g=>g.items.length);
 const count=groups.reduce((s,g)=>s+g.items.length,0);$('#count').textContent=`${count} / ${all.length} 项功能`;$('#empty').hidden=!!count;svg.hidden=!count;
 if(!count)return;
 const opened=g=>!!q||expanded.has(g.id), h=g=>opened(g)?Math.max(80,g.items.length*38+18):84;
 const sides={left:groups.filter(g=>g.side==='left'),right:groups.filter(g=>g.side==='right')};
 const totals=Object.fromEntries(Object.entries(sides).map(([s,gs])=>[s,gs.reduce((sum,g)=>sum+h(g)+36,0)-36]));
 const max=Math.max(1,...Object.values(totals)), cy=90+max/2;let parts=[];
 const hasLeftLeaves=sides.left.some(opened),hasRightLeaves=sides.right.some(opened);
 const minX=hasLeftLeaves?24:630,maxX=hasRightLeaves?2380:1770;
 bounds=[minX,54,maxX-minX,max+74];
 for(const [side,gs]of Object.entries(sides)){
  let y=90+(max-totals[side])/2;
  for(const g of gs){
   const left=side==='left',gx=left?650:1500,lx=left?44:1810,gy=y+h(g)/2,c=g.color,open=opened(g);
   parts.push(path(left?1040:1360,cy,left?900:1500,gy,c,2.5));
   parts.push(`<g data-group="${g.id}" role="button" tabindex="0" aria-expanded="${open}" aria-label="${esc(g.title)}，${open?'收起':'展开'}"><rect x="${gx}" y="${gy-36}" width="250" height="72" rx="9" fill="white" stroke="${c}" stroke-width="2"/><text x="${gx+125}" y="${gy-6}" text-anchor="middle" font-size="21" font-weight="700" fill="${c}">${esc(g.title)}</text><text x="${gx+125}" y="${gy+22}" text-anchor="middle" font-size="14" fill="#5b6c64">${g.items.length} 项 · ${open?'− 收起':'+ 展开'}</text></g>`);
   if(open)g.items.forEach((n,i)=>{
    const ly=y+28+i*38,x1=left?gx:gx+250,x2=left?lx+550:lx,isSelected=selected===n.id;
    parts.push(path(x1,gy,x2,ly,c));
    parts.push(`<g data-feature="${n.id}" role="button" tabindex="0" aria-label="${esc(n.id+' '+n.title+' '+n.scope)}"><title>${esc(n.detail)}</title><rect x="${lx}" y="${ly-16}" width="550" height="32" rx="5" fill="${isSelected?'#e8efdc':'white'}" stroke="${isSelected?c:'#d9e1d7'}"/><text x="${lx+12}" y="${ly+5}" font-size="12" fill="${c}">${n.id}</text><text x="${lx+108}" y="${ly+6}" font-size="17" fill="#20372b">${esc(n.title)}</text>${n.scope!=='本轮'?`<text x="${lx+537}" y="${ly+5}" text-anchor="end" font-size="12" fill="${c}">${n.scope}</text>`:''}</g>`);
   });
   y+=h(g)+36;
  }
 }
 parts.push(`<g><rect x="1040" y="${cy-64}" width="320" height="128" rx="12" fill="#183d2f"/><text x="1200" y="${cy-20}" font-size="30" font-weight="700" text-anchor="middle" fill="white">商境开发基线</text><text x="1200" y="${cy+16}" font-size="18" text-anchor="middle" fill="#ddf08b">商品资料 → 画布 → 图与视频</text><text x="1200" y="${cy+43}" font-size="15" text-anchor="middle" fill="#c2d4c8">${all.length} 项功能 · 单工作空间多账号</text></g>`);
 svg.setAttribute('viewBox',bounds.join(' '));svg.innerHTML='<g font-family="Microsoft YaHei,Noto Sans SC,sans-serif">'+parts.join('')+'</g>';size();
}
function selectFeature(id){
 const n=all.find(n=>n.id===id),g=data.groups.find(g=>g.items.some(n=>n.id===id));if(!n)return;selected=id;
 detail.innerHTML=`<span class="detail-id">${esc(n.id)} / ${esc(g.title)}</span><h2>${esc(n.title)}</h2><span class="tag">${n.scope==='本轮'?'本轮开发范围':n.scope}</span><p>${esc(n.detail)}</p><hr><p>范围不代表实现状态。具体输入、异常、权限与验收，以完整开发文档为准。</p><p><a href="FUNCTIONAL_SPEC.md">阅读功能文档，查找 ${esc(n.id)}</a></p><p><a href="requirements/discussion-decisions.md">查看四会话确认记录</a></p>`;
 render();
}
function activate(target){const group=target.closest('[data-group]'),node=target.closest('[data-feature]');if(group){const id=group.dataset.group;expanded.has(id)?expanded.delete(id):expanded.add(id);render();svg.querySelector(`[data-group="${id}"]`)?.focus({preventScroll:true})}else if(node){const id=node.dataset.feature;selectFeature(id);svg.querySelector(`[data-feature="${id}"]`)?.focus({preventScroll:true})}}
svg.addEventListener('click',e=>activate(e.target));svg.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();activate(e.target)}});
$('#search').addEventListener('input',render);$('#scope').addEventListener('change',render);
$('#expand').onclick=()=>{data.groups.forEach(g=>expanded.add(g.id));render()};
$('#collapse').onclick=()=>{expanded.clear();$('#search').value='';zoom=1;render()};
$('#plus').onclick=()=>{zoom=Math.min(5,zoom+.4);size()};$('#minus').onclick=()=>{zoom=Math.max(.6,zoom-.4);size()};$('#fit').onclick=()=>{zoom=1;size();canvas.scrollTo({left:0,top:0})};
new ResizeObserver(size).observe(canvas);render();
})();
</script></body></html>'''
(DOCS / "ecommerce-ai-feature-mindmap.html").write_text(template.replace("__DATA__", json.dumps(data, ensure_ascii=False).replace("</", "<\\/")), encoding="utf-8")
print(f"Generated {len(nodes)} features in {len(groups)} branches: JSON, SVG, Markdown and offline HTML.")
