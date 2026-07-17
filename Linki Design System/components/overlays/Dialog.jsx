import React from 'react';

/** Centered modal dialog with scrim. Controlled via `open` + `onClose`. */
export function Dialog({ open, onClose, title, description, children, footer, size = 'md', style, ...rest }) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  const maxW = { sm: 400, md: 520, lg: 680 }[size] || 520;
  return (
    <div role="dialog" aria-modal="true" onMouseDown={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 'var(--z-modal)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 'var(--space-6)', background: 'var(--scrim)', backdropFilter: 'blur(2px)',
        animation: 'linki-pop var(--dur-fast) var(--ease-standard)',
      }}>
      <div onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: maxW, maxHeight: '90vh', overflow: 'auto', background: 'var(--surface)',
          border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-modal)',
          animation: 'linki-pop var(--dur-slow) var(--ease-emphasized)', ...style,
        }} {...rest}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '20px 22px 0' }}>
          <div style={{ flex: 1 }}>
            {title && <h2 style={{ fontSize: 'var(--text-xl)', fontWeight: 'var(--fw-semibold)', color: 'var(--text-strong)', letterSpacing: 'var(--ls-tight)' }}>{title}</h2>}
            {description && <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: 5, lineHeight: 'var(--lh-normal)' }}>{description}</p>}
          </div>
          {onClose && (
            <button type="button" onClick={onClose} aria-label="Close" style={{ flexShrink: 0, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-subtle)', padding: 4, marginTop: -2, display: 'inline-flex' }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
          )}
        </div>
        {children && <div style={{ padding: '16px 22px', fontSize: 'var(--text-md)', color: 'var(--text)', lineHeight: 'var(--lh-normal)' }}>{children}</div>}
        {footer && <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '14px 22px 20px', borderTop: children ? '1px solid var(--border-subtle)' : 'none', marginTop: children ? 0 : 8 }}>{footer}</div>}
      </div>
    </div>
  );
}
