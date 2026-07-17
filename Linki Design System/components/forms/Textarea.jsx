import React from 'react';

/** Multi-line text input with label / hint / error. */
export function Textarea({ label, hint, error, rows = 4, id, disabled, style, containerStyle, ...rest }) {
  const [focus, setFocus] = React.useState(false);
  const uid = id || React.useId();
  const invalid = !!error;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, ...containerStyle }}>
      {label && <label htmlFor={uid} style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--fw-medium)', color: 'var(--text-strong)' }}>{label}</label>}
      <textarea id={uid} rows={rows} disabled={disabled} aria-invalid={invalid}
        onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
        style={{
          padding: '9px 11px', background: disabled ? 'var(--surface-sunken)' : 'var(--surface)',
          border: `1px solid ${invalid ? 'var(--danger-solid)' : focus ? 'var(--border-focus)' : 'var(--border)'}`,
          borderRadius: 'var(--radius-md)', fontSize: 'var(--text-md)', color: 'var(--text)',
          fontFamily: 'var(--font-sans)', lineHeight: 'var(--lh-normal)', resize: 'vertical', outline: 'none',
          boxShadow: focus ? 'var(--focus-ring)' : 'none', transition: 'border-color var(--dur-fast), box-shadow var(--dur-fast)',
          opacity: disabled ? 'var(--opacity-disabled)' : 1, ...style,
        }} {...rest} />
      {(hint || error) && <span style={{ fontSize: 'var(--text-xs)', color: invalid ? 'var(--danger-text)' : 'var(--text-subtle)' }}>{error || hint}</span>}
    </div>
  );
}
