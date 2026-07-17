import React from 'react';

/** Indeterminate loading spinner. Inherits color via currentColor by default. */
export function Spinner({ size = 18, thickness = 2, color = 'var(--primary)', style, ...rest }) {
  return (
    <span role="status" aria-label="Loading" style={{
      display: 'inline-block', width: size, height: size, borderRadius: '50%',
      border: `${thickness}px solid color-mix(in srgb, ${color} 22%, transparent)`,
      borderTopColor: color, animation: 'linki-spin .6s linear infinite', ...style,
    }} {...rest} />
  );
}
