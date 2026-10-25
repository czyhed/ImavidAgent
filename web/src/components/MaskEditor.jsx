import { useEffect, useRef, useState } from 'react';
import DraftText from './DraftText.jsx';

const fileUrl = id => `/api/creation/assets/${id}/file`;

// 局部精修蒙版编辑器：按原图尺寸建离屏绘制层，显示时按容器缩放。
// 导出的蒙版 PNG 与原图同尺寸，不透明黑色底，涂抹区域 alpha=0（OpenAI 语义：透明处重绘）。
export default function MaskEditor({ assetId, title = '局部精修', initialInstruction = '', confirmLabel = '确认并预览', onCancel, onConfirm }) {
 const layerRef = useRef(null), viewRef = useRef(null), strokes = useRef([]), current = useRef(null);
 const [image, setImage] = useState(null), [loadError, setLoadError] = useState(''), [error, setError] = useState('');
 const [brush, setBrush] = useState(6), [erase, setErase] = useState(false), [count, setCount] = useState(0), [instruction, setInstruction] = useState(initialInstruction), [saving, setSaving] = useState(false);

 useEffect(() => {
  let alive = true, url = null;
  (async () => {
   try {
    const response = await fetch(fileUrl(assetId));
    if (!response.ok) throw new Error('原图读取失败');
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);
    if (!alive) return;
    const layer = document.createElement('canvas'); layer.width = bitmap.width; layer.height = bitmap.height;
    layerRef.current = layer; url = URL.createObjectURL(blob);
    setImage({ width: bitmap.width, height: bitmap.height, url });
   } catch (e) { if (alive) setLoadError(e.message || '原图读取失败'); }
  })();
  return () => { alive = false; if (url) URL.revokeObjectURL(url); };
 }, [assetId]);
 useEffect(() => {
  const onKey = event => { if (event.key === 'Escape' && !saving) onCancel(); };
  window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
 }, [onCancel, saving]);

 // 画笔大小为原图长边的 0.5%—10%，保证不同分辨率下手感一致。
 const brushSize = () => Math.max(2, brush * Math.max(layerRef.current.width, layerRef.current.height) / 200);
 function segment(context, stroke, from, to) {
  context.save(); context.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over';
  context.strokeStyle = context.fillStyle = '#ef4444'; context.lineWidth = stroke.size; context.lineCap = context.lineJoin = 'round';
  if (from === to) { context.beginPath(); context.arc(to.x, to.y, stroke.size / 2, 0, Math.PI * 2); context.fill(); }
  else { context.beginPath(); context.moveTo(from.x, from.y); context.lineTo(to.x, to.y); context.stroke(); }
  context.restore();
 }
 // 显示层始终与离屏层保持同步；撤销 / 清空通过重放笔画实现，避免保存整幅快照。
 function paintView() {
  const view = viewRef.current, layer = layerRef.current; if (!view || !layer) return;
  const context = view.getContext('2d'); context.clearRect(0, 0, view.width, view.height); context.drawImage(layer, 0, 0, view.width, view.height);
 }
 function replay() {
  const layer = layerRef.current, context = layer.getContext('2d'); context.clearRect(0, 0, layer.width, layer.height);
  for (const stroke of strokes.current) stroke.points.forEach((point, index) => segment(context, stroke, stroke.points[Math.max(0, index - 1)], point));
  paintView(); setCount(strokes.current.length);
 }
 useEffect(() => {
  const view = viewRef.current; if (!image || !view) return;
  // 显示层按显示宽度缩放，避免超大原图占满内存；导出始终使用原图尺寸的离屏层。
  const scale = Math.min(1, 1600 / Math.max(image.width, image.height));
  view.width = Math.round(image.width * scale); view.height = Math.round(image.height * scale); paintView();
 }, [image]);
 const point = event => { const rect = viewRef.current.getBoundingClientRect(); return { x: (event.clientX - rect.left) * layerRef.current.width / rect.width, y: (event.clientY - rect.top) * layerRef.current.height / rect.height }; };
 function down(event) {
  if (!layerRef.current || saving || (event.pointerType === 'mouse' && event.button !== 0)) return;
  event.preventDefault(); event.currentTarget.setPointerCapture?.(event.pointerId);
  const start = point(event); current.current = { erase, size: brushSize(), points: [start] };
  strokes.current.push(current.current); segment(layerRef.current.getContext('2d'), current.current, start, start); paintView(); setCount(strokes.current.length);
 }
 function move(event) {
  const stroke = current.current; if (!stroke) return;
  const next = point(event); segment(layerRef.current.getContext('2d'), stroke, stroke.points.at(-1), next); stroke.points.push(next); paintView();
 }
 const up = () => { current.current = null; };
 const undo = () => { strokes.current.pop(); replay(); };
 const clear = () => { strokes.current = []; replay(); };

 async function confirm() {
  setError('');
  const layer = layerRef.current;
  if (!layer) return;
  // 橡皮擦可能擦光全部笔画，所以以实际像素为准判断是否涂抹。
  const painted = layer.getContext('2d').getImageData(0, 0, layer.width, layer.height).data.some((value, index) => index % 4 === 3 && value > 0);
  if (!painted) { setError('请先在图片上涂抹需要修改的区域。'); return; }
  const output = document.createElement('canvas'); output.width = layer.width; output.height = layer.height;
  const context = output.getContext('2d'); context.fillStyle = '#000'; context.fillRect(0, 0, output.width, output.height);
  context.globalCompositeOperation = 'destination-out'; context.drawImage(layer, 0, 0);
  const blob = await new Promise(resolve => output.toBlob(resolve, 'image/png'));
  if (!blob) { setError('蒙版生成失败，请重试。'); return; }
  setSaving(true);
  try { await onConfirm({ blob, instruction: instruction.trim(), width: output.width, height: output.height }); }
  catch (e) { setError(e.message || '提交失败，请重试。'); setSaving(false); }
 }

 return <div className="v3-overlay mask-overlay"><div className="v3-dialog mask-dialog" role="dialog" aria-modal="true" aria-label={title}>
  <header><h2>{title}</h2><button type="button" aria-label="关闭" disabled={saving} onClick={onCancel}>×</button></header>
  <p className="v3-dialog-lead">用画笔涂出需要修改的区域，其余部分保持不变。</p>
  {loadError ? <p role="alert">{loadError}</p> : <>
   <div className="mask-toolbar" role="toolbar" aria-label="蒙版工具">
    <button type="button" className={`v3-btn small${erase ? '' : ' primary'}`} aria-pressed={!erase} onClick={() => setErase(false)}>画笔</button>
    <button type="button" className={`v3-btn small${erase ? ' primary' : ''}`} aria-pressed={erase} onClick={() => setErase(true)}>橡皮擦</button>
    <label className="mask-size">大小<input type="range" aria-label="画笔大小" min="1" max="20" value={brush} onChange={e => setBrush(Number(e.target.value))} /></label>
    <button type="button" className="v3-btn small" disabled={!count || saving} onClick={undo}>撤销</button>
    <button type="button" className="v3-btn small" disabled={!count || saving} onClick={clear}>清空</button>
   </div>
   <div className="mask-stage" style={image ? { aspectRatio: `${image.width} / ${image.height}`, width: `min(100%, ${(60 * image.width / image.height).toFixed(2)}dvh)` } : undefined}>
    {image ? <><img src={image.url} alt="待精修的原图" draggable="false" /><canvas ref={viewRef} aria-label="蒙版绘制区" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} /></> : <div className="canvas-result-empty">正在读取原图…</div>}
   </div>
  </>}
  <label className="v3-field"><span>修改要求</span><DraftText multiline aria-label="修改要求" rows={3} maxLength={20000} value={instruction} disabled={saving} onCommit={setInstruction} placeholder="例如：把涂抹区域的背景换成木纹桌面" /></label>
  {error && <p role="alert" className="mask-error">{error}</p>}
  <footer><button type="button" className="v3-btn" disabled={saving} onClick={onCancel}>取消</button><button type="button" className="v3-btn primary" disabled={!count || !image || saving} onClick={confirm}>{saving ? '正在提交…' : confirmLabel}</button></footer>
 </div></div>;
}
