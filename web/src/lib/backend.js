import { useCallback, useEffect, useRef, useState } from 'react';

const EMPTY_CATALOG = { providers: [], models: [] };

export function useBackend() {
  const [csrf, setCsrf] = useState('');
  const [catalog, setCatalog] = useState(EMPTY_CATALOG);
  const [jobs, setJobs] = useState([]);
  const [error, setError] = useState('');
  // 先取 /api/session 判断登录模式：未登录或强制改密时不请求任何业务接口。
  const [session, setSession] = useState(null);
  const [sessionReady, setSessionReady] = useState(false);
  const csrfRef = useRef('');
  const sessionRef = useRef(null);
  const polling = useRef(false);

  const rememberSession = useCallback(next => {
    sessionRef.current = next;
    setSession(next);
  }, []);

  const apiCall = useCallback(async (path, body, method) => {
    const verb = method || (body === undefined ? 'GET' : 'POST');
    const headers = verb === 'GET' ? {} : { 'X-CSRF-Token': csrfRef.current };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(path, { method: verb, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) {
      const err = new Error(result.error?.message || '服务请求失败。');
      err.code = result.error?.code;
      throw err;
    }
    return result;
  }, []);

  const refreshJobs = useCallback(async () => {
    if (polling.current || !csrfRef.current) return [];
    polling.current = true;
    try {
      const result = await apiCall('/api/jobs');
      setJobs(result.jobs || []);
      return result.jobs || [];
    } finally { polling.current = false; }
  }, [apiCall]);

  const loadCatalog = useCallback(async (refresh = false) => {
    const result = await apiCall(refresh ? '/api/models/refresh' : '/api/models', refresh ? {} : undefined);
    setCatalog(result);
    return result;
  }, [apiCall]);

  const connect = useCallback(async () => {
    try {
      const next = await apiCall('/api/session');
      csrfRef.current = next.csrfToken || csrfRef.current;
      setCsrf(csrfRef.current);
      rememberSession(next);
      setSessionReady(true);
      // 配置了账号体系且未登录、或必须先改密时，只渲染账号界面，不触碰受保护接口。
      if (typeof next.authenticated === 'boolean' && (!next.authenticated || next.mustChangePassword)) {
        setCatalog(EMPTY_CATALOG);
        setJobs([]);
        setError('');
        return { session: next, catalog: null };
      }
      const loaded = null;
      setJobs([]);
      setError('');
      return { session: next, catalog: loaded };
    } catch (err) {
      setSessionReady(true);
      setError(err.message);
      throw err;
    }
  }, [apiCall, loadCatalog, refreshJobs, rememberSession]);

  // 登录成功后重新取会话并加载工作台数据；失败时保留登录页并展示后端文案。
  const login = useCallback(async (email, password) => {
    const result = await apiCall('/api/session', { email, password });
    if (result.csrfToken) { csrfRef.current = result.csrfToken; setCsrf(result.csrfToken); }
    await connect();
    return result;
  }, [apiCall, connect]);

  const logout = useCallback(async () => {
    try {
      await apiCall('/api/session', undefined, 'DELETE');
    } finally {
      // 重新读取会话后由 authenticated:false 切回登录页；读取失败时清空本地会话状态。
      await connect().catch(() => {
        // 退出后会话读取失败时也停在登录页，而不是把工作台留在屏幕上。
        rememberSession({
          mode: 'account', csrfToken: csrfRef.current, authenticated: false,
          user: null, mustChangePassword: false, setupRequired: false,
        });
        setCatalog(EMPTY_CATALOG);
        setJobs([]);
      });
    }
  }, [apiCall, connect, rememberSession]);

  const setupAdmin = useCallback(async payload => {
    const result = await apiCall('/api/setup/admin', payload);
    if (result.csrfToken) { csrfRef.current = result.csrfToken; setCsrf(result.csrfToken); }
    return result;
  }, [apiCall]);

  const changePassword = useCallback(async (currentPassword, newPassword) => {
    const result = await apiCall('/api/account/password', { currentPassword, newPassword });
    await connect();
    return result;
  }, [apiCall, connect]);

  useEffect(() => { connect().catch(() => {}); }, [connect]);

  return {
    csrf, catalog, jobs, setJobs, error, session, sessionReady,
    apiCall, connect, loadCatalog, refreshJobs, login, logout, setupAdmin, changePassword,
  };
}
