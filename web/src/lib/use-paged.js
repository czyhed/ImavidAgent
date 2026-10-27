import { useCallback, useEffect, useRef, useState } from 'react';
import { appendUnique, clampOffset, pageQuery } from './paging.js';

// 分页列表 hook。request(path) 返回 {<key>:[...], total, nextOffset}。
// 缓存（stale-while-revalidate）按「登录用户 + 路径 + 参数 + 偏移」存放：回到列表先显示上次数据，后台刷新。
const cache = new Map();
const MAX_CACHE = 60;
const remember = (key, value) => { cache.delete(key); cache.set(key, value); if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value); };
export const clearPagedCache = () => cache.clear();

// 搜索框输入防抖：返回已生效的查询；输入框本身保持受控，延迟后才触发请求。
export function useDebounced(value, delay = 300) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (value === settled) return undefined;
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay, settled]);
  return settled;
}

const blank = (key, hit) => ({ key, items: hit?.items || [], total: hit?.total || 0, nextOffset: hit?.nextOffset ?? null, loading: !hit, loadingMore: false, error: '' });

// 翻页式：{items,total,loading,error,reload}。查询 / 筛选变化时由调用方把 offset 置 0。
export function usePage({ request, owner = 'local', path, key = 'items', params = {}, size, offset, setOffset, enabled = true, onData }) {
  const query = pageQuery(params, size, offset), cacheKey = `${owner}|${path}|${query}`;
  const requestRef = useRef(request); requestRef.current = request;
  const dataRef = useRef(onData); dataRef.current = onData;
  const hit = cache.get(cacheKey);
  const [state, setState] = useState(() => blank(cacheKey, hit));
  const [tick, setTick] = useState(0);
  const epoch = useRef(0);
  // 键变化的这一帧立刻改用缓存（或空），不显示上一页数据。
  const view = state.key === cacheKey ? state : blank(cacheKey, hit);
  useEffect(() => {
    if (!enabled) return undefined;
    const ticket = ++epoch.current;
    if (!cache.get(cacheKey)) setState(blank(cacheKey, null));
    requestRef.current(`${path}?${query}`).then(result => {
      if (ticket !== epoch.current) return;
      const items = result[key] || result.items || [], total = Number(result.total ?? items.length);
      const back = clampOffset(total, offset, size);
      if (back !== null) { setOffset(back); return; }
      remember(cacheKey, { items, total });
      dataRef.current?.(result);
      setState({ ...blank(cacheKey, { items, total }), loading: false });
    }).catch(e => { if (ticket === epoch.current) setState(old => ({ ...(old.key === cacheKey ? old : blank(cacheKey, null)), loading: false, error: e.message })); });
    return () => { epoch.current++; };
  }, [cacheKey, tick, enabled]);
  const reload = useCallback(() => setTick(value => value + 1), []);
  return { ...view, reload };
}

// 加载更多式：{items,total,hasMore,loading,loadingMore,error,loadMore,reload,mutate}。查询变化时从头加载。
export function useFeed({ request, owner = 'local', path, key = 'items', params = {}, size, enabled = true, onData }) {
  const query = pageQuery(params, size, 0), cacheKey = `${owner}|${path}|${query}|feed`;
  const requestRef = useRef(request); requestRef.current = request;
  const dataRef = useRef(onData); dataRef.current = onData;
  const paramsRef = useRef(params); paramsRef.current = params;
  const hit = cache.get(cacheKey);
  const [state, setState] = useState(() => blank(cacheKey, hit));
  const [tick, setTick] = useState(0);
  const epoch = useRef(0), stateRef = useRef(state);
  const view = state.key === cacheKey ? state : blank(cacheKey, hit);
  stateRef.current = view;
  useEffect(() => {
    if (!enabled) return undefined;
    const ticket = ++epoch.current;
    if (!cache.get(cacheKey)) setState(blank(cacheKey, null));
    requestRef.current(`${path}?${query}`).then(result => {
      if (ticket !== epoch.current) return;
      const items = result[key] || result.items || [], total = Number(result.total ?? items.length), nextOffset = result.nextOffset ?? null;
      remember(cacheKey, { items, total, nextOffset });
      dataRef.current?.(result);
      setState({ ...blank(cacheKey, { items, total, nextOffset }), loading: false });
    }).catch(e => { if (ticket === epoch.current) setState(old => ({ ...(old.key === cacheKey ? old : blank(cacheKey, null)), loading: false, loadingMore: false, error: e.message })); });
    return () => { epoch.current++; };
  }, [cacheKey, tick, enabled]);
  const loadMore = useCallback(async () => {
    const current = stateRef.current;
    if (current.nextOffset === null || current.loadingMore || current.loading) return;
    const ticket = epoch.current;
    setState({ ...current, loadingMore: true, error: '' });
    try {
      const result = await requestRef.current(`${path}?${pageQuery(paramsRef.current, size, current.nextOffset)}`);
      if (ticket !== epoch.current) return;
      const more = result[key] || result.items || [];
      dataRef.current?.(result);
      const next = { ...current, items: appendUnique(current.items, more), total: Number(result.total ?? current.total), nextOffset: result.nextOffset ?? null, loadingMore: false };
      remember(cacheKey, { items: next.items, total: next.total, nextOffset: next.nextOffset });
      setState(next);
    } catch (e) { if (ticket === epoch.current) setState({ ...current, loadingMore: false, error: e.message }); }
  }, [cacheKey]);
  const reload = useCallback(() => setTick(value => value + 1), []);
  // 本地增删（新建 / 移入回收站）：保留已加载的页数，不整表重载；total 按条数差值调整。
  // 移除时服务端后续条目整体前移，nextOffset 同步减少；新增时靠 appendUnique 去重，不调整偏移。
  const mutate = useCallback(fn => setState(old => {
    const items = fn(old.items), delta = items.length - old.items.length;
    return { ...old, items, total: Math.max(0, old.total + delta), nextOffset: old.nextOffset !== null && delta < 0 ? Math.max(0, old.nextOffset + delta) : old.nextOffset };
  }), []);
  return { ...view, hasMore: view.nextOffset !== null, reload, loadMore, mutate };
}
