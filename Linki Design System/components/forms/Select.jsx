import React from 'react';

const H = { sm: 'var(--control-sm)', md: 'var(--control-md)', lg: 'var(--control-lg)' };

/** Native select styled to match Input, with a custom chevron. */
export function Select({ label, hint, error, size = 'md', children, id, disabled, style, containerStyle, ...rest }) {
  const [focus, setFocus] = React.useState(false);
  const uid = id || React.useId();
  const invalid = !!error;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, ...containerStyle }}>
      {label && <label htmlFor={uid} style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--fw-medium)', color: 'var(--text-strong)' }}>{label}</label>}
      <div style={{ position: 'relative', display: 'flex' }}>
        <select id={uid} disabled={disabled} aria-invalid={invalid} onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
          style={{
            appearance: 'none', WebkitAppearance: 'none', width: '100%', height: H[size], padding: '0 34px 0 11px',
            background: disabled ? 'var(--surface-sunken)' : 'var(--surface)',
            border: `1px solid ${invalid ? 'var(--danger-solid)' : focus ? 'var(--border-focus)' : 'var(--border)'}`,
            borderRadius: 'var(--radius-md)', fontSize: 'var(--text-md)', color: 'var(--text)', cursor: disabled ? 'not-allowed' : 'pointer',
            outline: 'none', boxShadow: focus ? 'var(--focus-ring)' : 'none', transition: 'border-color var(--dur-fast), box-shadow var(--dur-fast)',
            opacity: disabled ? 'var(--opacity-disabled)' : 1, ...style,
          }} {...rest}>
          {children}
        </select>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-subtle)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}><path d="m6 9 6 6 6-6" /></svg>
      </div>
      {(hint || error) && <span style={{ fontSize: 'var(--text-xs)', color: invalid ? 'var(--danger-text)' : 'var(--text-subtle)' }}>{error || hint}</span>}
    </div>
  );
}
