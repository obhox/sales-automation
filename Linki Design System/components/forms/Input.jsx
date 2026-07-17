import React from 'react';

const H = { sm: 'var(--control-sm)', md: 'var(--control-md)', lg: 'var(--control-lg)' };

/** Text input with label, hint, error, and optional leading/trailing adornments. */
export function Input({
  label, hint, error, size = 'md', leftIcon, rightIcon, id, disabled, style, containerStyle, ...rest
}) {
  const [focus, setFocus] = React.useState(false);
  const uid = id || React.useId();
  const invalid = !!error;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, ...containerStyle }}>
      {label && <label htmlFor={uid} style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--fw-medium)', color: 'var(--text-strong)' }}>{label}</label>}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, height: H[size], padding: '0 11px',
        background: disabled ? 'var(--surface-sunken)' : 'var(--surface)',
        border: `1px solid ${invalid ? 'var(--danger-solid)' : focus ? 'var(--border-focus)' : 'var(--border)'}`,
        borderRadius: 'var(--radius-md)',
        boxShadow: focus ? (invalid ? '0 0 0 3px var(--danger-bg)' : 'var(--focus-ring)') : 'none',
        transition: 'border-color var(--dur-fast), box-shadow var(--dur-fast)',
        opacity: disabled ? 'var(--opacity-disabled)' : 1,
      }}>
        {leftIcon && <span style={{ display: 'inline-flex', color: 'var(--text-subtle)' }}>{leftIcon}</span>}
        <input id={uid} disabled={disabled} aria-invalid={invalid} onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
          style={{ flex: 1, minWidth: 0, height: '100%', border: 'none', outline: 'none', background: 'transparent', fontSize: 'var(--text-md)', color: 'var(--text)', ...style }} {...rest} />
        {rightIcon && <span style={{ display: 'inline-flex', color: 'var(--text-subtle)' }}>{rightIcon}</span>}
      </div>
      {(hint || error) && <span style={{ fontSize: 'var(--text-xs)', color: invalid ? 'var(--danger-text)' : 'var(--text-subtle)' }}>{error || hint}</span>}
    </div>
  );
}
