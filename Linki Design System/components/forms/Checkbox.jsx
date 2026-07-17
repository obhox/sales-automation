import React from 'react';

/** Checkbox with label. Controlled via `checked`; supports `indeterminate`. */
export function Checkbox({ label, checked = false, indeterminate = false, disabled = false, onChange, id, style, ...rest }) {
  const uid = id || React.useId();
  const on = checked || indeterminate;
  return (
    <label htmlFor={uid} style={{ display: 'inline-flex', alignItems: 'flex-start', gap: 9, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 'var(--opacity-disabled)' : 1, ...style }}>
      <span style={{ position: 'relative', display: 'inline-flex', flexShrink: 0, marginTop: 1 }}>
        <input type="checkbox" id={uid} checked={checked} disabled={disabled} onChange={onChange}
          ref={el => { if (el) el.indeterminate = indeterminate; }}
          style={{ position: 'absolute', opacity: 0, width: 16, height: 16, margin: 0, cursor: 'inherit' }} {...rest} />
        <span aria-hidden style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 16,
          borderRadius: 'var(--radius-sm)', background: on ? 'var(--primary)' : 'var(--surface)',
          border: `1px solid ${on ? 'var(--primary)' : 'var(--border-strong)'}`, color: '#fff',
          transition: 'background var(--dur-fast), border-color var(--dur-fast)',
        }}>
          {indeterminate
            ? <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round"><path d="M5 12h14" /></svg>
            : checked ? <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg> : null}
        </span>
      </span>
      {label && <span style={{ fontSize: 'var(--text-md)', color: 'var(--text)', lineHeight: 1.35 }}>{label}</span>}
    </label>
  );
}
