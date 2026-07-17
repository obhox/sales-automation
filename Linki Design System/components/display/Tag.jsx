import React from 'react';

/** Removable metadata chip (labels, filters, recipients). */
export function Tag({ children, onRemove, color, style, ...rest }) {
  const [hover, setHover] = React.useState(false);
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, height: 24, padding: onRemove ? '0 4px 0 9px' : '0 10px',
      fontSize: 'var(--text-xs)', fontWeight: 'var(--fw-medium)', color: 'var(--text)',
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-pill)',
      boxShadow: 'var(--shadow-raised)', whiteSpace: 'nowrap', ...style,
    }} {...rest}>
      {color && <span style={{ width: 7, height: 7, borderRadius: '50%', background: color }} />}
      {children}
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label="Remove"
          onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 16,
            border: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer', padding: 0,
            background: hover ? 'var(--surface-sunken)' : 'transparent', color: 'var(--text-subtle)',
          }}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      )}
    </span>
  );
}
