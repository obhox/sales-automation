import React from 'react';

/** Single radio option with label. Group via shared `name` + value. */
export function Radio({ label, checked = false, disabled = false, onChange, name, value, id, style, ...rest }) {
  const uid = id || React.useId();
  return (
    <label htmlFor={uid} style={{ display: 'inline-flex', alignItems: 'flex-start', gap: 9, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 'var(--opacity-disabled)' : 1, ...style }}>
      <span style={{ position: 'relative', display: 'inline-flex', flexShrink: 0, marginTop: 1 }}>
        <input type="radio" id={uid} name={name} value={value} checked={checked} disabled={disabled} onChange={onChange}
          style={{ position: 'absolute', opacity: 0, width: 16, height: 16, margin: 0, cursor: 'inherit' }} {...rest} />
        <span aria-hidden style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 16, borderRadius: '50%',
          background: 'var(--surface)', border: `1px solid ${checked ? 'var(--primary)' : 'var(--border-strong)'}`,
          transition: 'border-color var(--dur-fast)',
        }}>
          {checked && <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--primary)' }} />}
        </span>
      </span>
      {label && <span style={{ fontSize: 'var(--text-md)', color: 'var(--text)', lineHeight: 1.35 }}>{label}</span>}
    </label>
  );
}
