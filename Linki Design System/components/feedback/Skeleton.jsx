import React from 'react';

/** Loading placeholder. Set width/height (or a radius) to match target content. */
export function Skeleton({ width = '100%', height = 14, radius = 'var(--radius-sm)', circle = false, style, ...rest }) {
  const d = circle ? (typeof height === 'number' ? height : 32) : undefined;
  return (
    <span aria-hidden style={{
      display: 'block', width: circle ? d : width, height: circle ? d : height,
      borderRadius: circle ? '50%' : radius,
      background: 'linear-gradient(90deg, var(--surface-sunken) 0%, var(--bg-subtle) 40%, var(--surface-sunken) 80%)',
      backgroundSize: '800px 100%', animation: 'linki-shimmer 1.4s ease-in-out infinite', ...style,
    }} {...rest} />
  );
}
