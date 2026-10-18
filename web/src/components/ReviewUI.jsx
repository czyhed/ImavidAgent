import { ProductArt } from './ProductArt.jsx';
import { Btn, Tag } from './ui.jsx';
import { REVIEW_STEPS, completedSteps, currentStep, money, totalCost } from '../lib/review.js';

export function Header({ title, desc, actions }) {
  return <div className="rv-head"><div><h1>{title}</h1><p>{desc}</p></div><div className="rv-actions">{actions}</div></div>;
}

export function Art({ product, kind = '', large = false }) {
  return <div className={`rv-art ${kind} ${large ? 'rv-edit-canvas' : ''}`}><ProductArt product={product || { art: 'box' }} /><span className="rv-art-label">交互示意 · 非生成结果</span></div>;
}

export function Progress({ completed }) {
  return <div className="rv-progress">{REVIEW_STEPS.map((_, index) => <i key={index} className={index < completed ? 'done' : ''} />)}</div>;
}

export function Steps({ current, completed, disabled = false, onPick }) {
  return <div className="rv-steps">{REVIEW_STEPS.map((label, index) => {
    const no = index + 1;
    const active = no === current;
    return <button key={label} type="button" data-rv="step" data-id={no} className={active ? 'active' : ''} aria-current={active ? 'step' : undefined} onClick={() => onPick?.(no)} disabled={disabled}>
      <b>0{no}</b>{label}<small>{no <= completed ? '已完成' : active ? '当前待办' : '待完成'}</small>
    </button>;
  })}</div>;
}

export function ProjectTable({ data, products, onOpen }) {
  return <div className="rv-table-wrap"><table className="rv-table"><thead><tr><th>项目 / 商品</th><th>当前步骤</th><th>步骤进度</th><th>负责人</th><th>演示费用</th><th /></tr></thead><tbody>{data.projects.map(p => {
    const facts = p.snapshot || products.find(x => x.id === p.productId);
    const step = currentStep(p);
    return <tr key={p.id}>
      <td><button type="button" className="rv-link" data-rv="open-project" data-id={p.id} onClick={() => onOpen(p.id)}>{p.name}</button><small>{facts?.sku || 'SKU 待补充'}</small></td>
      <td><Tag type={step === 5 ? 'warn' : ''}>{p.exported ? '已完成' : REVIEW_STEPS[step - 1]}</Tag></td>
      <td>{completedSteps(p)} / 6 步<Progress completed={completedSteps(p)} /></td>
      <td>{p.owner}</td><td>{money(totalCost(data, p))}</td>
      <td><Btn small data-rv="open-project" data-id={p.id} onClick={() => onOpen(p.id)}>进入</Btn></td>
    </tr>;
  })}</tbody></table></div>;
}

export function downloadFile(filename, content, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([content], { type: type + ';charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
