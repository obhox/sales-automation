import React from 'react';

const TONES = {
  neutral: { bg: 'var(--surface-sunken)', fg: 'var(--text-muted)', bd: 'var(--border-subtle)' },
  brand:   { bg: 'var(--primary-subtle)', fg: 'var(--primary-text)', bd: 'var(--primary-border)' },
  success: { bg: 'var(--success-bg)', fg: 'var(--success-text)', bd: 'var(--success-border)' },
  warning: { bg: 'var(--warning-bg)', fg: 'var(--warning-text)', bd: 'var(--warning-border)' },
  danger:  { bg: 'var(--danger-bg)', fg: 'var(--danger-text)', bd: 'var(--danger-border)' },
  info:    { bg: 'var(--info-bg)', fg: 'var(--info-text)', bd: 'var(--info-border)' },
  accent:  { bg: 'var(--accent-subtle)', fg: 'var(--accent-text)', bd: 'transparent' },
};

/** Small status/label pill. `dot` prepends a status dot; `solid` fills. */
export function Badge({ children, tone = 'neutral', solid = false, dot = false, style, ...rest }) {
  const t = TONES[tone] || TONES.neutral;
  const base = solid
    ? { background: t.fg, color: '#fff', border: '1px solid transparent' }
    : { background: t.bg, color: t.fg, border: `1px solid ${t.bd}` };
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, height: 20, padding: '0 8px',
      fontSize: 'var(--text-2xs)', fontWeight: 'var(--fw-semibold)', lineHeight: 1,
      letterSpacing: 'var(--ls-wide)', borderRadius: 'var(--radius-sm)', whiteSpace: 'nowrap',
      ...base, ...style,
    }} {...rest}>
      {dot && <span style={{ width: 6, height: 6, borderRadius: '50%', background: solid ? '#fff' : t.fg }} />}
      {children}
    </span>
  );
}
