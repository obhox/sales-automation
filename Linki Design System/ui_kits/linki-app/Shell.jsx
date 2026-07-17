/* IIFE-wrapped */
(function(){
// Persistent app chrome: sidebar + topbar. Owns active-screen state.
const { Icon, Avatar, Badge, Button, IconButton, Input, Menu, Tooltip } = window.LinkiDesignSystem_8f2af2;

const NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: 'layout-dashboard' },
  { id: 'sequences', label: 'Sequences', icon: 'git-branch', badge: '3' },
  { id: 'contacts', label: 'Contacts', icon: 'users' },
  { id: 'inbox', label: 'Inbox', icon: 'inbox', badge: '12' },
  { id: 'analytics', label: 'Analytics', icon: 'bar-chart-3' },
];
const NAV2 = [
  { id: 'settings', label: 'Settings', icon: 'settings' },
  { id: 'help', label: 'Help & docs', icon: 'life-buoy' },
];

function BrandGlyph({ size = 30 }) {
  return (
    <span style={{ width: size, height: size, borderRadius: 9, background: 'var(--cobalt-600)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, boxShadow: 'var(--shadow-raised)' }}>
      <svg width={size * 0.56} height={size * 0.56} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" /></svg>
    </span>
  );
}

function NavItem({ item, active, onClick }) {
  const [hover, setHover] = React.useState(false);
  return (
    <button onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, width: '100%', height: 34, padding: '0 10px',
        border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer', textAlign: 'left',
        background: active ? 'var(--primary-subtle)' : hover ? 'var(--surface-sunken)' : 'transparent',
        color: active ? 'var(--primary-text)' : 'var(--text-muted)',
        fontSize: 'var(--text-md)', fontWeight: active ? 'var(--fw-semibold)' : 'var(--fw-medium)',
        transition: 'background var(--dur-fast), color var(--dur-fast)',
      }}>
      <Icon name={item.icon} size={17} />
      <span style={{ flex: 1 }}>{item.label}</span>
      {item.badge && <span style={{ fontSize: 'var(--text-2xs)', fontWeight: 'var(--fw-semibold)', color: active ? 'var(--primary-text)' : 'var(--text-subtle)', background: active ? 'var(--surface)' : 'var(--surface-sunken)', borderRadius: 'var(--radius-pill)', padding: '1px 7px', fontFeatureSettings: 'var(--numeric)' }}>{item.badge}</span>}
    </button>
  );
}

function Sidebar({ active, setActive }) {
  return (
    <aside style={{ width: 'var(--sidebar-w)', flexShrink: 0, height: '100%', background: 'var(--surface)', borderRight: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', padding: 12, boxSizing: 'border-box' }}>
      <button style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px', marginBottom: 14, border: 'none', background: 'transparent', cursor: 'pointer', borderRadius: 'var(--radius-md)' }}>
        <BrandGlyph />
        <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', minWidth: 0 }}>
          <span style={{ fontSize: 'var(--text-md)', fontWeight: 'var(--fw-semibold)', color: 'var(--text-strong)', letterSpacing: '-.01em' }}>Acme Inc</span>
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)' }}>Growth plan</span>
        </span>
        <Icon name="chevrons-up-down" size={15} style={{ color: 'var(--text-subtle)', marginLeft: 'auto' }} />
      </button>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {NAV.map((n) => <NavItem key={n.id} item={n} active={active === n.id} onClick={() => setActive(n.id)} />)}
      </div>
      <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {NAV2.map((n) => <NavItem key={n.id} item={n} active={active === n.id} onClick={() => setActive(n.id)} />)}
        <div style={{ height: 1, background: 'var(--border-subtle)', margin: '8px 4px' }} />
        <button style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px', border: 'none', background: 'transparent', cursor: 'pointer', borderRadius: 'var(--radius-md)' }}>
          <Avatar name="Dana Ruiz" size="sm" status="online" />
          <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', minWidth: 0 }}>
            <span style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--fw-medium)', color: 'var(--text-strong)' }}>Dana Ruiz</span>
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)', overflow: 'hidden', textOverflow: 'ellipsis' }}>dana@acme.io</span>
          </span>
        </button>
      </div>
    </aside>
  );
}

function Topbar({ title, onCommand, dark, setDark }) {
  return (
    <header style={{ height: 'var(--topbar-h)', flexShrink: 0, borderBottom: '1px solid var(--border-subtle)', background: 'var(--surface)', display: 'flex', alignItems: 'center', gap: 12, padding: '0 20px' }}>
      <span style={{ fontSize: 'var(--text-lg)', fontWeight: 'var(--fw-semibold)', color: 'var(--text-strong)', letterSpacing: '-.01em' }}>{title}</span>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
        <button onClick={onCommand} style={{ display: 'flex', alignItems: 'center', gap: 8, height: 34, padding: '0 10px 0 11px', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', background: 'var(--surface)', cursor: 'pointer', color: 'var(--text-subtle)', fontSize: 'var(--text-sm)' }}>
          <Icon name="search" size={15} /><span>Search or jump to…</span>
          <kbd style={{ marginLeft: 24, fontFamily: 'var(--font-mono)', fontSize: 11, background: 'var(--surface-sunken)', border: '1px solid var(--border-subtle)', borderRadius: 5, padding: '1px 5px' }}>⌘K</kbd>
        </button>
        <Tooltip label={dark ? 'Light mode' : 'Dark mode'} side="bottom">
          <IconButton variant="ghost" icon={<Icon name={dark ? 'sun' : 'moon'} />} label="Toggle theme" onClick={() => setDark(!dark)} />
        </Tooltip>
        <Tooltip label="Notifications" side="bottom"><IconButton variant="ghost" icon={<Icon name="bell" />} label="Notifications" /></Tooltip>
        <Button variant="primary" size="sm" leftIcon={<Icon name="plus" size={15} />}>New sequence</Button>
      </div>
    </header>
  );
}

function CommandPalette({ open, onClose, setActive }) {
  const cmds = [
    { icon: 'layout-dashboard', label: 'Go to Dashboard', id: 'dashboard' },
    { icon: 'git-branch', label: 'Go to Sequences', id: 'sequences' },
    { icon: 'users', label: 'Go to Contacts', id: 'contacts' },
    { icon: 'plus', label: 'Create new sequence' },
    { icon: 'upload', label: 'Import contacts (CSV)' },
    { icon: 'settings', label: 'Open settings', id: 'settings' },
  ];
  if (!open) return null;
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'var(--scrim)', zIndex: 'var(--z-modal)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '12vh', animation: 'linki-pop var(--dur-slow) var(--ease-standard)' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 560, maxWidth: '90vw', background: 'var(--surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-modal)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
          <Icon name="search" size={18} style={{ color: 'var(--text-subtle)' }} />
          <input autoFocus placeholder="Type a command or search…" style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', fontSize: 'var(--text-lg)', color: 'var(--text)' }} />
          <kbd style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-subtle)', border: '1px solid var(--border-subtle)', borderRadius: 5, padding: '1px 6px' }}>ESC</kbd>
        </div>
        <div style={{ padding: 8 }}>
          <div style={{ fontSize: 'var(--text-2xs)', fontWeight: 'var(--fw-semibold)', letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text-subtle)', padding: '6px 10px' }}>Quick actions</div>
          {cmds.map((c, i) => (
            <button key={i} onClick={() => { if (c.id) setActive(c.id); onClose(); }}
              onMouseEnter={(e) => e.currentTarget.style.background = 'var(--surface-sunken)'} onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
              style={{ display: 'flex', alignItems: 'center', gap: 11, width: '100%', padding: '9px 10px', border: 'none', background: 'transparent', borderRadius: 'var(--radius-md)', cursor: 'pointer', textAlign: 'left', color: 'var(--text)', fontSize: 'var(--text-md)' }}>
              <Icon name={c.icon} size={16} style={{ color: 'var(--text-muted)' }} />{c.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Shell({ children, active, setActive, title }) {
  const [cmd, setCmd] = React.useState(false);
  const [dark, setDark] = React.useState(false);
  React.useEffect(() => {
    const el = document.getElementById('linki-root');
    if (el) el.setAttribute('data-theme', dark ? 'dark' : 'light');
    const onKey = (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); setCmd((v) => !v); } if (e.key === 'Escape') setCmd(false); };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [dark]);
  return (
    <div style={{ display: 'flex', height: '100%', background: 'var(--bg-app)' }}>
      <Sidebar active={active} setActive={setActive} />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <Topbar title={title} onCommand={() => setCmd(true)} dark={dark} setDark={setDark} />
        <main style={{ flex: 1, overflow: 'auto' }}>{children}</main>
      </div>
      <CommandPalette open={cmd} onClose={() => setCmd(false)} setActive={setActive} />
    </div>
  );
}

Object.assign(window, { Shell, BrandGlyph });

})();
