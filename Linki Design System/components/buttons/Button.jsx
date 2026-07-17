import React from 'react';

const SIZES = {
  sm: { h: 'var(--control-sm)', px: '10px', fs: 'var(--text-sm)', gap: '6px', icon: 14 },
  md: { h: 'var(--control-md)', px: '13px', fs: 'var(--text-md)', gap: '7px', icon: 16 },
  lg: { h: 'var(--control-lg)', px: '16px', fs: 'var(--text-md)', gap: '8px', icon: 18 },
};

const VARIANTS = {
  primary: {
    background: 'var(--primary)', color: 'var(--text-onbrand)', border: '1px solid transparent',
    '--hov': 'var(--primary-hover)', '--act': 'var(--primary-active)',
  },
  secondary: {
    background: 'var(--surface)', color: 'var(--text-strong)', border: '1px solid var(--border)',
    boxShadow: 'var(--shadow-raised)', '--hov': 'var(--surface-hover)', '--act': 'var(--surface-sunken)',
  },
  outline: {
    background: 'transparent', color: 'var(--primary-text)', border: '1px solid var(--primary-border)',
    '--hov': 'var(--primary-subtle)', '--act': 'var(--primary-subtle)',
  },
  ghost: {
    background: 'transparent', color: 'var(--text)', border: '1px solid transparent',
    '--hov': 'var(--surface-sunken)', '--act': 'var(--surface-sunken)',
  },
  destructive: {
    background: 'var(--danger-solid)', color: '#fff', border: '1px solid transparent',
    '--hov': 'color-mix(in srgb, var(--danger-solid) 88%, #000)', '--act': 'color-mix(in srgb, var(--danger-solid) 78%, #000)',
  },
  link: {
    background: 'transparent', color: 'var(--primary-text)', border: '1px solid transparent',
    padding: 0, height: 'auto', textDecoration: 'none', '--hov': 'transparent', '--act': 'transparent',
  },
};

export function Button({
  children, variant = 'primary', size = 'md', leftIcon, rightIcon,
  loading = false, disabled = false, fullWidth = false, type = 'button', style, ...rest
}) {
  const [hover, setHover] = React.useState(false);
  const [active, setActive] = React.useState(false);
  const s = SIZES[size] || SIZES.md;
  const v = VARIANTS[variant] || VARIANTS.primary;
  const isLink = variant === 'link';
  const off = disabled || loading;

  const base = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: s.gap,
    height: isLink ? 'auto' : s.h, padding: isLink ? 0 : `0 ${s.px}`,
    fontFamily: 'var(--font-sans)', fontSize: s.fs, fontWeight: 'var(--fw-medium)',
    lineHeight: 1, letterSpacing: 'var(--ls-tight)', borderRadius: isLink ? 0 : 'var(--radius-md)',
    cursor: off ? 'not-allowed' : 'pointer', width: fullWidth ? '100%' : undefined,
    transition: 'background var(--dur-fast) var(--ease-standard), border-color var(--dur-fast), transform var(--dur-fast), box-shadow var(--dur-fast)',
    opacity: off ? 'var(--opacity-disabled)' : 1, userSelect: 'none', whiteSpace: 'nowrap',
    transform: active && !off ? 'scale(.98)' : 'none',
    background: v.background, color: v.color, border: v.border, boxShadow: v.boxShadow,
    textDecoration: isLink && hover && !off ? 'underline' : 'none', textUnderlineOffset: '2px',
    ...(hover && !off ? { background: v['--hov'] } : null),
    ...(active && !off ? { background: v['--act'] } : null),
    ...style,
  };

  const iconSize = { width: s.icon, height: s.icon, flexShrink: 0, display: 'inline-flex' };
  return (
    <button type={type} disabled={off} style={base}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => { setHover(false); setActive(false); }}
      onMouseDown={() => setActive(true)} onMouseUp={() => setActive(false)} {...rest}>
      {loading && <span style={{ ...iconSize, borderRadius: '50%', border: '2px solid currentColor', borderTopColor: 'transparent', animation: 'linki-spin .6s linear infinite', opacity: .9 }} />}
      {!loading && leftIcon && <span style={iconSize}>{leftIcon}</span>}
      {children}
      {!loading && rightIcon && <span style={iconSize}>{rightIcon}</span>}
    </button>
  );
}
