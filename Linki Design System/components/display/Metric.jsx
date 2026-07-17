import React from 'react';

/** KPI / stat block: label, big value, optional delta + trend direction. */
export function Metric({ label, value, delta, trend = 'flat', hint, style, ...rest }) {
  const color = trend === 'up' ? 'var(--success-text)' : trend === 'down' ? 'var(--danger-text)' : 'var(--text-muted)';
  const arrow = trend === 'up' ? 'M7 17 17 7M17 7H9M17 7v8' : trend === 'down' ? 'M7 7l10 10M17 17H9M17 17V9' : 'M5 12h14';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, ...style }} {...rest}>
      <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', fontWeight: 'var(--fw-medium)' }}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{ fontSize: 'var(--text-3xl)', fontWeight: 'var(--fw-semibold)', color: 'var(--text-strong)', letterSpacing: 'var(--ls-tight)', fontFeatureSettings: 'var(--numeric)' }}>{value}</span>
        {delta != null && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 'var(--text-sm)', fontWeight: 'var(--fw-semibold)', color }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d={arrow} /></svg>
            {delta}
          </span>
        )}
      </div>
      {hint && <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)' }}>{hint}</span>}
    </div>
  );
}
