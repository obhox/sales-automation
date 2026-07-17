import React from 'react';

/** Breadcrumb trail. `items`: [{ label, href? }]. Last item is current (bold). */
export function Breadcrumbs({ items = [], style, ...rest }) {
  return (
    <nav aria-label="Breadcrumb" style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, fontSize: 'var(--text-sm)', ...style }} {...rest}>
      {items.map((it, i) => {
        const last = i === items.length - 1;
        return (
          <React.Fragment key={i}>
            {last
              ? <span aria-current="page" style={{ color: 'var(--text-strong)', fontWeight: 'var(--fw-medium)' }}>{it.label}</span>
              : <a href={it.href || '#'} style={{ color: 'var(--text-muted)', textDecoration: 'none' }}>{it.label}</a>}
            {!last && <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-disabled)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg>}
          </React.Fragment>
        );
      })}
    </nav>
  );
}
