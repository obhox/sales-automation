import React from 'react';

/** Hover/focus tooltip. Wraps a single child; positions on `side`. */
export function Tooltip({ label, children, side = 'top', style, ...rest }) {
  const [show, setShow] = React.useState(false);
  const pos = {
    top: { bottom: '100%', left: '50%', transform: 'translateX(-50%)', marginBottom: 7 },
    bottom: { top: '100%', left: '50%', transform: 'translateX(-50%)', marginTop: 7 },
    left: { right: '100%', top: '50%', transform: 'translateY(-50%)', marginRight: 7 },
    right: { left: '100%', top: '50%', transform: 'translateY(-50%)', marginLeft: 7 },
  }[side];
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}
      onFocus={() => setShow(true)} onBlur={() => setShow(false)} {...rest}>
      {children}
      {show && label && (
        <span role="tooltip" style={{
          position: 'absolute', zIndex: 'var(--z-tooltip)', whiteSpace: 'nowrap', pointerEvents: 'none',
          padding: '5px 9px', background: 'var(--surface-inverse)', color: 'var(--text-inverse)',
          fontSize: 'var(--text-xs)', fontWeight: 'var(--fw-medium)', borderRadius: 'var(--radius-sm)',
          boxShadow: 'var(--shadow-popover)', animation: 'linki-pop var(--dur-fast) var(--ease-standard)', ...pos, ...style,
        }}>{label}</span>
      )}
    </span>
  );
}
