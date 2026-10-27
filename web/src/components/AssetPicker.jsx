import { useEffect, useState } from 'react';
import DraftText from './DraftText.jsx';
import { LoadMore } from './ui.jsx';
import { useDebounced, useFeed } from '../lib/use-paged.js';

// 选择器里的素材 / 模板列表：服务端搜索（输入防抖 300ms）+「加载更多」，每次 30 条，不再一次读取全部。
// request(path) 返回 JSON；owner 用于按登录用户隔离缓存；onLoaded(items) 把读到的素材交给画布缓存（名称 / 已删除检测）。
export const PICKER_SIZE = 30;
const usable = items => items.filter(item => !item.trashedAt && !item.deletionPending);

export function AssetFeed({ request, owner, params, size = PICKER_SIZE, onLoaded, searchLabel = null, placeholder = '搜索素材名称', empty = null, enabled = true, always = false, children }) {
  const [input, setInput] = useState('');
  const q = useDebounced(input, 300);
  const feed = useFeed({ request, owner, path: '/api/creation/assets', params: { ...params, q }, size, enabled, onData: result => onLoaded?.(result.items || []) });
  const items = usable(feed.items);
  return <div className="picker-feed" data-picker-feed>
    {searchLabel && <DraftText type="search" className="picker-search" aria-label={searchLabel} placeholder={placeholder} value={input} onCommit={setInput} />}
    {feed.error && <p className="vn-problem" role="alert">{feed.error}</p>}
    {feed.loading && !items.length ? <p className="v3-note" role="status">正在加载…</p> : items.length || always ? children(items) : !feed.error && (q ? <p className="v3-note">没有匹配的素材，换个关键词试试。</p> : empty)}
    <LoadMore shown={feed.items.length} total={feed.total} hasMore={feed.hasMore} loading={feed.loadingMore} onClick={feed.loadMore} />
  </div>;
}

// 提示词与参数模板选择：按图片 / 视频类型过滤，服务端搜索 + 加载更多；折叠区展开后才请求。
export function TemplateSelect({ request, owner, kind, locked, enabled, onPick }) {
  const [input, setInput] = useState('');
  const q = useDebounced(input, 300);
  const feed = useFeed({ request, owner, path: '/api/creation/templates', params: { type: kind, q }, size: PICKER_SIZE, enabled });
  return <div className="picker-feed">
    <DraftText type="search" className="picker-search" aria-label="搜索模板" placeholder="搜索模板名称" value={input} onCommit={setInput} />
    <select aria-label="提示词与参数模板" value="" disabled={locked} onChange={event => { const template = feed.items.find(t => t.id === event.target.value); if (template) onPick(template); }}>
      <option value="">选择模板</option>
      {feed.items.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
    </select>
    {feed.error && <p className="vn-problem" role="alert">{feed.error}</p>}
    <LoadMore shown={feed.items.length} total={feed.total} hasMore={feed.hasMore} loading={feed.loadingMore} onClick={feed.loadMore} />
  </div>;
}

// 通用分页下拉：服务端搜索（防抖）+ 加载更多；当前选中项即使不在已加载的那一页也保留在选项里（pinned，必要时按编号补取名称）。
export function FeedSelect({ request, owner, path, label, searchLabel, emptyLabel, value, onChange, pinned = null, resolvePath = null, enabled = true }) {
  const [input, setInput] = useState(''), [resolved, setResolved] = useState(null);
  const q = useDebounced(input, 300);
  const feed = useFeed({ request, owner, path, params: { q }, size: PICKER_SIZE, enabled });
  const known = feed.items.find(item => item.id === value) || (pinned?.id === value && pinned.name ? pinned : null) || (resolved?.id === value ? resolved : null);
  useEffect(() => {
    if (!value || known || !resolvePath) return undefined;
    let live = true;
    request(resolvePath(value)).then(result => { const item = result.product || result.item || result; if (live && item?.id === value) setResolved(item); }).catch(() => {});
    return () => { live = false; };
  }, [value, Boolean(known)]);
  return <div className="picker-feed">
    <DraftText type="search" className="picker-search" aria-label={searchLabel} placeholder="搜索" value={input} onCommit={setInput} />
    <select aria-label={label} value={value} onChange={event => onChange(event.target.value)}>
      <option value="">{emptyLabel}</option>
      {value && !feed.items.some(item => item.id === value) && <option value={value}>{known?.name || '已选择'}</option>}
      {feed.items.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select>
    {feed.error && <p className="vn-problem" role="alert">{feed.error}</p>}
    <LoadMore shown={feed.items.length} total={feed.total} hasMore={feed.hasMore} loading={feed.loadingMore} onClick={feed.loadMore} />
  </div>;
}
