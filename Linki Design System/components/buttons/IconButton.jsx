import React from 'react';

const SIZES = {
  sm: { d: 'var(--control-sm)', icon: 15 },
  md: { d: 'var(--control-md)', icon: 17 },
  lg: { d: 'var(--control-lg)', icon: 19 },
};

const VARIANTS = {
  secondary: { background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-raised)', hov: 'var(--surface-hover)' },
  ghost: { background: 'transparent', color: 'var(--text-muted)', border: '1px solid transparent', hov: 'var(--surface-sunken)' },
  primary: { background: 'var(--primary)', color: '#fff', border: '1px solid transparent', hov: 'var(--primary-hover)' },
};

export function IconButton({ icon, label, variant = 'ghost', size = 'md', disabled = false, style, ...rest }) {
  const [hover, setHover] = React.useState(false);
  const s = SIZES[size] || SIZES.md;
  const v = VARIANTS[variant] || VARIANTS.ghost;
  return (
    <button type="button" aria-label={label} disabled={disabled} title={label}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: s.d, height: s.d, borderRadius: 'var(--radius-md)', cursor: disabled ? 'not-allowed' : 'pointer',
        background: hover && !disabled ? v.hov : v.background, color: v.color, border: v.border,
        boxShadow: v.boxShadow, opacity: disabled ? 'var(--opacity-disabled)' : 1,
        transition: 'background var(--dur-fast) var(--ease-standard), color var(--dur-fast)', ...style,
      }} {...rest}>
      <span style={{ width: s.icon, height: s.icon, display: 'inline-flex' }}>{icon}</span>
    </button>
  );
}
