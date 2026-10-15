import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export function Tag({ children, type = '' }) {
  return <span className={`rv-tag ${type}`}>{children}</span>;
}

export function Btn({ children, primary = false, small = false, ghost = false, className = '', ...props }) {
  return (
    <button
      type="button"
      className={`btn ${primary ? 'primary' : ''} ${small ? 'small' : ''} ${ghost ? 'ghost' : ''} ${className}`}
      {...props}
    >{children}</button>
  );
}

export function ProgressBar({ steps, completed }) {
  return <div className="rv-progress">{steps.map((_, i) => <i key={i} className={i < completed ? 'done' : ''} />)}</div>;
}

export function Toast({ message }) {
  return <div id="toast" className={`toast ${message ? 'is-on' : ''}`} role="status">{message || ''}</div>;
}

export function Dialog({ id, className = '', labelId, onClose, children }) {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);
  return createPortal(
    <dialog
      ref={ref}
      id={id}
      className={className}
      aria-labelledby={labelId}
      onCancel={event => { event.preventDefault(); onClose?.(); }}
      onClick={event => { if (event.target === ref.current) onClose?.(); }}
    >{children}</dialog>,
    document.body,
  );
}

export function Modal({ title, children, onClose, message = '' }) {
  return (
    <Dialog id="rv-dialog" className="rv rv-dialog" labelId="rv-dialog-title" onClose={onClose}>
      <div className="rv-dialog-head">
        <h2 id="rv-dialog-title">{title}</h2>
        <button type="button" data-rv="close" aria-label="关闭" onClick={onClose}>×</button>
      </div>
      <div className="rv-dialog-content">
        {children}
        <div className="rv-message" id="rv-message" role="alert">{message}</div>
      </div>
    </Dialog>
  );
}

// 统一的删除 / 危险操作确认：替代 window.confirm，与全局蓝色主题一致。
export function ConfirmDialog({ open, title = '确认操作', message, confirmText = '确认', danger = true, busy = false, onCancel, onConfirm }) {
  if (!open) return null;
  return createPortal(
    <div className="cp-modal-backdrop" role="dialog" aria-modal="true" aria-label={title} onClick={event => { if (event.target === event.currentTarget && !busy) onCancel?.(); }}>
      <div className="confirm-box">
        <h2>{title}</h2>
        <p>{message}</p>
        <footer>
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>取消</button>
          <button type="button" className={`btn ${danger ? 'danger' : 'primary'}`} data-confirm-accept onClick={onConfirm} disabled={busy}>{confirmText}</button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
