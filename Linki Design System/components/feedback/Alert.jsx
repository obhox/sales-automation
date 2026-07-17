import React from 'react';

const TONES = {
  info:    { bg: 'var(--info-bg)', bd: 'var(--info-border)', fg: 'var(--info-text)', icon: 'info' },
  success: { bg: 'var(--success-bg)', bd: 'var(--success-border)', fg: 'var(--success-text)', icon: 'check-circle-2' },
  warning: { bg: 'var(--warning-bg)', bd: 'var(--warning-border)', fg: 'var(--warning-text)', icon: 'alert-triangle' },
  danger:  { bg: 'var(--danger-bg)', bd: 'var(--danger-border)', fg: 'var(--danger-text)', icon: 'alert-circle' },
};

const GLYPH = {
  'info': 'M12 16v-4M12 8h.01',
  'check-circle-2': 'm9 12 2 2 4-4',
  'alert-triangle': 'M12 9v4M12 17h.01',
  'alert-circle': 'M12 8v4M12 16h.01',
};

/** Inline contextual message. Persistent (unlike Toast). */
export function Alert({ tone = 'info', title, children, onClose, style, ...rest }) {
  const t = TONES[tone] || TONES.info;
  const circle = tone !== 'warning';
  return (
    <div role="alert" style={{
      display: 'flex', gap: 11, padding: '12px 14px', background: t.bg,
      border: `1px solid ${t.bd}`, borderRadius: 'var(--radius-md)', ...style,
    }} {...rest}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={t.fg} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}>
        {tone === 'warning'
          ? <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
          : <circle cx="12" cy="12" r="10" />}
        <path d={GLYPH[t.icon]} />
      </svg>
      <div style={{ flex: 1, minWidth: 0 }}>
        {title && <div style={{ fontSize: 'var(--text-md)', fontWeight: 'var(--fw-semibold)', color: t.fg, marginBottom: children ? 3 : 0 }}>{title}</div>}
        {children && <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text)', lineHeight: 'var(--lh-normal)' }}>{children}</div>}
      </div>
      {onClose && (
        <button type="button" onClick={onClose} aria-label="Dismiss" style={{ flexShrink: 0, background: 'none', border: 'none', cursor: 'pointer', color: t.fg, padding: 2, opacity: .7, display: 'inline-flex' }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      )}
    </div>
  );
}
