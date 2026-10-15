import { useState } from 'react';
import { roleLabel } from '../lib/auth.js';
import authArt from '../assets/auth-creative.webp';

// 账号入口（Issue #24）：登录、首次本机管理员初始化、强制改密。
// 密码只保存在组件内存中随表单提交，绝不写入 localStorage、URL、console 或日志。

function Brand({ children, screen, headline = ['让商品', '被看见。'] }) {
  return (
    <div className="auth-shell" data-auth-screen={screen}>
      <section className="auth-brand" aria-label="商境">
        <div className="auth-logo">商境</div>
        <div className="auth-brand-copy">

          <h1>{screen==='setup'?'创建你的工作空间':'让商品被看见'}</h1>
          <p>整理资料，连接创意，完成创作。</p>
          <div className="auth-art" aria-hidden="true"><img src={authArt} alt="" /></div>
        </div>
        <p className="auth-foot">商境 · 商品创作工作台</p>
      </section>
      <section className="auth-main">
        <div className="auth-card">{children}</div>
      </section>
    </div>
  );
}

export function BootScreen({ message = '正在连接工作空间…' }) {
  return (
    <div className="auth-boot" data-auth-screen="boot" role="status" aria-live="polite">
      <span className="auth-boot-mark" aria-hidden="true"><i /><i /><i /><i /></span>
      <p>{message}</p>
    </div>
  );
}

export default function AuthScreen({ backend, session }) {
  const setupRequired = session?.setupRequired === true;
  const [mode, setMode] = useState(setupRequired ? 'setup' : 'login');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [loginEmail, setLoginEmail] = useState('');

  const switchMode = next => {
    setError('');
    setNotice('');
    setMode(next);
  };

  async function submitLogin(event) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') || '').trim();
    const password = String(form.get('password') || '');
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await backend.login(email, password);
    } catch (err) {
      setError(err.message || '登录失败，请稍后重试。');
    } finally {
      setBusy(false);
    }
  }

  async function submitSetup(event) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') || '').trim();
    const password = String(form.get('password') || '');
    const workspaceName = String(form.get('workspaceName') || '').trim();
    if (password.length < 10) {
      setError('密码长度需为 10–200 个字符。');
      return;
    }
    if (!workspaceName) {
      setError('请填写工作空间名称。');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await backend.setupAdmin({ email, password, workspaceName });
      setNotice('管理员已创建，正在登录…');
      try {
        await backend.login(email, password);
      } catch {
        setLoginEmail(email);
        setMode('login');
        setNotice('管理员已创建，请使用刚设置的账号登录。');
      }
    } catch (err) {
      setError(err.message || '管理员初始化失败。');
    } finally {
      setBusy(false);
    }
  }

  if (mode === 'setup') {
    return (
      <Brand screen="setup" headline={['初始化', '工作空间。']}>
        <header className="auth-card-head">
          <p className="auth-eyebrow">首次使用</p>
          <h2>创建第一个管理员</h2>
          <p>管理员初始化只允许在服务端本机进行。远程访问无法初始化，请由服务器本机操作者完成。</p>
        </header>
        <form id="auth-setup-form" className="auth-form" onSubmit={submitSetup} noValidate>
          <label className="auth-field">邮箱
            <input name="email" type="email" required maxLength={254} autoComplete="email" placeholder="admin@example.com" />
          </label>
          <label className="auth-field">密码（至少 10 个字符）
            <input name="password" type="password" required minLength={10} maxLength={200} autoComplete="new-password" placeholder="设置管理员密码" />
          </label>
          <label className="auth-field">工作空间名称
            <input name="workspaceName" required maxLength={80} defaultValue="商境" autoComplete="organization" placeholder="例如：商境家居内容团队" />
          </label>
          <div className="auth-error" id="auth-error" data-auth-error role="alert">{error}</div>
          <div className="auth-notice" data-auth-notice role="status">{notice}</div>
          <button className="btn primary wide" type="submit" disabled={busy}>{busy ? '正在初始化…' : '创建管理员'}</button>
        </form>
        {!setupRequired && <p className="auth-alt">如果管理员已经存在，请直接登录。</p>}
        <div className="auth-switch">
          <span>已有管理员账号？</span>
          <button type="button" onClick={() => switchMode('login')}>返回登录</button>
        </div>
      </Brand>
    );
  }

  return (
    <Brand screen="login">
      <header className="auth-card-head">
        <p className="auth-eyebrow">账号登录</p>
        <h2>进入工作空间</h2>
        <p>使用管理员或团队成员账号登录。首次登录可能需要先修改临时密码。</p>
      </header>
      <form id="auth-login-form" className="auth-form" onSubmit={submitLogin}>
        <label className="auth-field">邮箱
          <input name="email" type="email" required maxLength={254} autoComplete="username" defaultValue={loginEmail} placeholder="you@example.com" />
        </label>
        <label className="auth-field">密码
          <input name="password" type="password" required maxLength={200} autoComplete="current-password" placeholder="输入密码" />
        </label>
        <div className="auth-error" id="auth-error" data-auth-error role="alert">{error}</div>
        <div className="auth-notice" data-auth-notice role="status">{notice}</div>
        <button className="btn primary wide" type="submit" disabled={busy}>{busy ? '正在登录…' : '登录'}</button>
      </form>
      {setupRequired
        ? <div className="auth-switch"><span>首次部署？</span><button type="button" onClick={() => switchMode('setup')}>初始化管理员</button></div>
        : <p className="auth-alt">没有账号？请联系管理员。</p>}
    </Brand>
  );
}

export function PasswordChangeScreen({ backend, session }) {
  const user = session?.user || null;
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const currentPassword = String(form.get('currentPassword') || '');
    const newPassword = String(form.get('newPassword') || '');
    const confirmPassword = String(form.get('confirmPassword') || '');
    if (newPassword.length < 10) {
      setError('新密码长度需为 10–200 个字符。');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('两次输入的新密码不一致。');
      return;
    }
    if (newPassword === currentPassword) {
      setError('新密码不能与当前密码相同。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await backend.changePassword(currentPassword, newPassword);
    } catch (err) {
      setError(err.message || '修改密码失败，请稍后重试。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Brand screen="password-change"><button type="button" className="auth-exit" onClick={()=>backend.logout().catch(e=>setError(e.message))}>退出登录</button>
      <header className="auth-card-head">
        <p className="auth-eyebrow">首次登录</p>
        <h2>修改临时密码</h2>
        <p>首次登录，请先设置自己的密码。</p>
        {user && <p className="auth-identity" data-auth-user={user.email} data-auth-role={user.role}>{user.email} · {roleLabel(user.role)}</p>}
      </header>
      <form id="auth-password-form" className="auth-form" onSubmit={submit}>
        <label className="auth-field">当前密码
          <input name="currentPassword" type="password" required maxLength={200} autoComplete="current-password" />
        </label>
        <label className="auth-field">新密码（至少 10 个字符）
          <input name="newPassword" type="password" required minLength={10} maxLength={200} autoComplete="new-password" />
        </label>
        <label className="auth-field">再次输入新密码
          <input name="confirmPassword" type="password" required minLength={10} maxLength={200} autoComplete="new-password" />
        </label>
        <div className="auth-error" id="auth-error" data-auth-error role="alert">{error}</div>
        <button className="btn primary wide" type="submit" disabled={busy}>{busy ? '正在修改…' : '修改密码并继续'}</button><p className="auth-session-note">修改后，其他设备上的旧会话将失效。</p>
      </form>
    </Brand>
  );
}
