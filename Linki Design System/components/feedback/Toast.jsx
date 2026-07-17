import React from 'react';

const TONES = {
  neutral: 'var(--text-strong)', success: 'var(--success-solid)',
  danger: 'var(--danger-solid)', warning: 'var(--warning-solid)', info: 'var(--primary)',
};
const GLYPH = {
  success: 'm9 12 2 2 4-4', danger: 'M12 8v4M12 16h.01',
  warning: 'M12 9v4M12 17h.01', info: 'M12 16v-4M12 8h.01', neutral: null,
};

/** Transient notification card. Presentational — pair with your own queue/timer. */
export function Toast({ tone = 'neutral', title, description, action, onClose, style, ...rest }) {
  const c = TONES[tone] || TONES.neutral;
  const g = GLYPH[tone];
  return (
    <div role="status" style={{
      display: 'flex', alignItems: 'flex-start', gap: 11, width: 360, maxWidth: '92vw', padding: '13px 14px',
      background: 'var(--surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-lg)',
      boxShadow: 'var(--shadow-popover)', animation: 'linki-pop var(--dur-slow) var(--ease-emphasized)', ...style,
    }} {...rest}>
      {g && (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}>
          {tone === 'warning' ? <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" /> : <circle cx="12" cy="12" r="10" />}
          <path d={g} />
        </svg>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        {title && <div style={{ fontSize: 'var(--text-md)', fontWeight: 'var(--fw-semibold)', color: 'var(--text-strong)' }}>{title}</div>}
        {description && <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: 2, lineHeight: 'var(--lh-normal)' }}>{description}</div>}
        {action && <div style={{ marginTop: 9 }}>{action}</div>}
      </div>
      {onClose && (
        <button type="button" onClick={onClose} aria-label="Dismiss" style={{ flexShrink: 0, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-subtle)', padding: 2, display: 'inline-flex' }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      )}
    </div>
  );
}
