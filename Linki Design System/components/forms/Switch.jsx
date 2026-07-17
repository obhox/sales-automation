import React from 'react';

const SIZES = { sm: { w: 30, h: 18, k: 14 }, md: { w: 36, h: 21, k: 17 } };

/** On/off toggle for instant-apply settings (no Save needed). */
export function Switch({ label, checked = false, disabled = false, size = 'md', onChange, id, style, ...rest }) {
  const uid = id || React.useId();
  const s = SIZES[size] || SIZES.md;
  return (
    <label htmlFor={uid} style={{ display: 'inline-flex', alignItems: 'center', gap: 10, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 'var(--opacity-disabled)' : 1, ...style }}>
      <span style={{ position: 'relative', display: 'inline-flex', flexShrink: 0, width: s.w, height: s.h }}>
        <input type="checkbox" role="switch" id={uid} checked={checked} disabled={disabled} onChange={onChange}
          style={{ position: 'absolute', opacity: 0, width: '100%', height: '100%', margin: 0, cursor: 'inherit' }} {...rest} />
        <span aria-hidden style={{
          width: '100%', height: '100%', borderRadius: 'var(--radius-pill)',
          background: checked ? 'var(--primary)' : 'var(--slate-300)',
          transition: 'background var(--dur-base) var(--ease-standard)',
        }} />
        <span aria-hidden style={{
          position: 'absolute', top: (s.h - s.k) / 2, left: checked ? s.w - s.k - (s.h - s.k) / 2 : (s.h - s.k) / 2,
          width: s.k, height: s.k, borderRadius: '50%', background: '#fff', boxShadow: '0 1px 2px rgba(16,24,40,.3)',
          transition: 'left var(--dur-base) var(--ease-standard)',
        }} />
      </span>
      {label && <span style={{ fontSize: 'var(--text-md)', color: 'var(--text)' }}>{label}</span>}
    </label>
  );
}
