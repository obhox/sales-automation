import React from 'react';

const TONE = { brand: 'var(--primary)', success: 'var(--success-solid)', warning: 'var(--warning-solid)', danger: 'var(--danger-solid)' };

/** Determinate progress bar (0–100). Optional label + value readout. */
export function ProgressBar({ value = 0, tone = 'brand', label, showValue = false, size = 'md', style, ...rest }) {
  const v = Math.max(0, Math.min(100, value));
  const h = size === 'sm' ? 4 : size === 'lg' ? 10 : 6;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, ...style }} {...rest}>
      {(label || showValue) && (
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--text-sm)' }}>
          {label && <span style={{ color: 'var(--text-muted)' }}>{label}</span>}
          {showValue && <span style={{ color: 'var(--text-strong)', fontWeight: 'var(--fw-medium)', fontFeatureSettings: 'var(--numeric)' }}>{Math.round(v)}%</span>}
        </div>
      )}
      <div role="progressbar" aria-valuenow={v} aria-valuemin={0} aria-valuemax={100}
        style={{ height: h, background: 'var(--surface-sunken)', borderRadius: 'var(--radius-pill)', overflow: 'hidden' }}>
        <div style={{ width: `${v}%`, height: '100%', background: TONE[tone] || TONE.brand, borderRadius: 'var(--radius-pill)', transition: 'width var(--dur-slow) var(--ease-standard)' }} />
      </div>
    </div>
  );
}
