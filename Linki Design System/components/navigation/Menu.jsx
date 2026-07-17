import React from 'react';

/**
 * Dropdown menu. `trigger` is any node; `items`: [{ label, icon?, onSelect?,
 * tone?: 'danger', divider?: true, shortcut? }]. Closes on select / outside click / Esc.
 */
export function Menu({ trigger, items = [], align = 'start', style, ...rest }) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef(null);
  React.useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex', ...style }} {...rest}>
      <span onClick={() => setOpen(o => !o)} style={{ display: 'inline-flex', cursor: 'pointer' }}>{trigger}</span>
      {open && (
        <div role="menu" style={{
          position: 'absolute', top: 'calc(100% + 6px)', [align === 'end' ? 'right' : 'left']: 0, zIndex: 'var(--z-dropdown)',
          minWidth: 200, padding: 5, background: 'var(--surface)', border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-popover)', animation: 'linki-pop var(--dur-fast) var(--ease-emphasized)',
        }}>
          {items.map((it, i) => it.divider ? (
            <div key={i} style={{ height: 1, background: 'var(--border-subtle)', margin: '5px 0' }} />
          ) : (
            <MenuItem key={i} item={it} onClose={() => setOpen(false)} />
          ))}
        </div>
      )}
    </div>
  );
}

function MenuItem({ item, onClose }) {
  const [hover, setHover] = React.useState(false);
  const danger = item.tone === 'danger';
  return (
    <button role="menuitem" type="button"
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      onClick={() => { item.onSelect?.(); onClose(); }}
      style={{
        display: 'flex', alignItems: 'center', gap: 9, width: '100%', height: 32, padding: '0 9px',
        border: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer', textAlign: 'left',
        fontSize: 'var(--text-md)', color: danger ? 'var(--danger-text)' : 'var(--text)',
        background: hover ? (danger ? 'var(--danger-bg)' : 'var(--surface-sunken)') : 'transparent',
      }}>
      {item.icon && <span style={{ display: 'inline-flex', color: danger ? 'var(--danger-text)' : 'var(--text-muted)' }}>{item.icon}</span>}
      <span style={{ flex: 1 }}>{item.label}</span>
      {item.shortcut && <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)', fontFamily: 'var(--font-mono)' }}>{item.shortcut}</span>}
    </button>
  );
}
