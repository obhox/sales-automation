import React from 'react';

/** Surface container. `interactive` adds hover lift; `padding` in token steps. */
export function Card({ children, padding = 'md', interactive = false, style, ...rest }) {
  const [hover, setHover] = React.useState(false);
  const pad = { none: 0, sm: 'var(--space-4)', md: 'var(--space-6)', lg: 'var(--space-8)' }[padding] ?? padding;
  return (
    <div
      onMouseEnter={() => interactive && setHover(true)} onMouseLeave={() => interactive && setHover(false)}
      style={{
        background: 'var(--surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-lg)',
        boxShadow: hover ? 'var(--shadow-floating)' : 'var(--shadow-raised)', padding: pad,
        transition: 'box-shadow var(--dur-base) var(--ease-standard), transform var(--dur-base), border-color var(--dur-base)',
        transform: hover ? 'translateY(-1px)' : 'none', cursor: interactive ? 'pointer' : 'default',
        borderColor: hover ? 'var(--border)' : 'var(--border-subtle)', ...style,
      }} {...rest}>
      {children}
    </div>
  );
}
