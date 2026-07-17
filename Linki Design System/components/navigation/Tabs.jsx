import React from 'react';

/**
 * Tab bar. Underline (default) or pill style. Controlled via value/onChange,
 * or uncontrolled with defaultValue. `items`: [{ value, label, icon?, count? }].
 */
export function Tabs({ items = [], value, defaultValue, onChange, variant = 'underline', style, ...rest }) {
  const [internal, setInternal] = React.useState(defaultValue ?? items[0]?.value);
  const active = value !== undefined ? value : internal;
  const set = (v) => { if (value === undefined) setInternal(v); onChange?.(v); };
  const pill = variant === 'pill';

  return (
    <div role="tablist" style={{
      display: 'inline-flex', gap: pill ? 3 : 4, alignItems: 'center',
      padding: pill ? 3 : 0, background: pill ? 'var(--surface-sunken)' : 'transparent',
      borderRadius: pill ? 'var(--radius-md)' : 0,
      borderBottom: pill ? 'none' : '1px solid var(--border-subtle)', ...style,
    }} {...rest}>
      {items.map((it) => {
        const on = it.value === active;
        return (
          <button key={it.value} role="tab" aria-selected={on} onClick={() => set(it.value)}
            style={{
              position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 6,
              height: pill ? 28 : 36, padding: pill ? '0 12px' : '0 4px', margin: pill ? 0 : '0 8px',
              marginBottom: pill ? 0 : -1, border: 'none', background: pill && on ? 'var(--surface)' : 'transparent',
              borderRadius: pill ? 'var(--radius-sm)' : 0, cursor: 'pointer',
              fontSize: 'var(--text-md)', fontWeight: 'var(--fw-medium)',
              color: on ? 'var(--text-strong)' : 'var(--text-muted)',
              boxShadow: pill && on ? 'var(--shadow-raised)' : 'none',
              borderBottom: pill ? 'none' : `2px solid ${on ? 'var(--primary)' : 'transparent'}`,
              transition: 'color var(--dur-fast), background var(--dur-fast)',
            }}>
            {it.icon}
            {it.label}
            {it.count != null && (
              <span style={{ fontSize: 'var(--text-xs)', fontWeight: 'var(--fw-semibold)', color: on ? 'var(--primary-text)' : 'var(--text-subtle)', background: on ? 'var(--primary-subtle)' : 'var(--surface-sunken)', borderRadius: 'var(--radius-pill)', padding: '1px 6px', fontFeatureSettings: 'var(--numeric)' }}>{it.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
