import React from 'react';

const SIZES = { xs: 20, sm: 24, md: 32, lg: 40, xl: 56 };
const PALETTE = ['var(--cobalt-500)', 'var(--teal-500)', '#8B5CF6', 'var(--amber-500)', '#EC4899', 'var(--slate-500)'];

function initials(name = '') {
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] || '') + (p[1]?.[0] || '')).toUpperCase() || '?';
}
function hashColor(name = '') {
  let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/** User/entity avatar. Falls back to colored initials when no `src`. */
export function Avatar({ name = '', src, size = 'md', square = false, status, style, ...rest }) {
  const d = SIZES[size] || (typeof size === 'number' ? size : 32);
  const fs = Math.round(d * 0.4);
  return (
    <span style={{ position: 'relative', display: 'inline-flex', flexShrink: 0, width: d, height: d, ...style }} {...rest}>
      <span style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%',
        borderRadius: square ? 'var(--radius-md)' : '50%', overflow: 'hidden',
        background: src ? 'var(--surface-sunken)' : hashColor(name), color: '#fff',
        fontSize: fs, fontWeight: 'var(--fw-semibold)', letterSpacing: '-.01em',
        boxShadow: 'inset 0 0 0 1px rgba(0,0,0,.06)',
      }}>
        {src ? <img src={src} alt={name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : initials(name)}
      </span>
      {status && <span style={{
        position: 'absolute', right: -1, bottom: -1, width: Math.max(8, d * 0.28), height: Math.max(8, d * 0.28),
        borderRadius: '50%', border: '2px solid var(--surface)',
        background: status === 'online' ? 'var(--success-solid)' : status === 'busy' ? 'var(--danger-solid)' : 'var(--slate-400)',
      }} />}
    </span>
  );
}
