/* IIFE-wrapped */
(function(){
// Sequences screen — list with filters, tabs, per-step preview, row menus.
const { Card, Badge, Icon, Avatar, Button, Tabs, Input, Menu, IconButton, Tag, ProgressBar } = window.LinkiDesignSystem_8f2af2;

function StepPips({ steps, kinds }) {
  const glyph = { email: 'mail', wait: 'clock', call: 'phone', li: 'linkedin' };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      {kinds.slice(0, steps).map((k, i) => (
        <span key={i} style={{ width: 22, height: 22, borderRadius: 'var(--radius-sm)', background: 'var(--surface-sunken)', border: '1px solid var(--border-subtle)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>
          <Icon name={glyph[k] || 'circle'} size={12} />
        </span>
      ))}
    </div>
  );
}

function SequenceCard({ s }) {
  const D = window.LinkiData;
  const kinds = ['email', 'wait', 'email', 'call', 'li', 'wait', 'email'];
  return (
    <Card interactive padding="none" style={{ overflow: 'hidden' }}>
      <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
              <span style={{ fontSize: 'var(--text-lg)', fontWeight: 'var(--fw-semibold)', color: 'var(--text-strong)', letterSpacing: '-.01em' }}>{s.name}</span>
              <Badge tone={D.statusTone[s.status]} dot>{s.status}</Badge>
            </div>
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)', fontFamily: 'var(--font-mono)' }}>{s.id}</span>
          </div>
          <Menu trigger={<IconButton variant="ghost" size="sm" icon={<Icon name="more-horizontal" size={16} />} label="Actions" />}
            items={[{ label: 'Edit steps', icon: <Icon name="pencil" size={15} />, shortcut: 'E' }, { label: 'Duplicate', icon: <Icon name="copy" size={15} /> }, { divider: true }, { label: 'Delete', icon: <Icon name="trash-2" size={15} />, tone: 'danger' }]} />
        </div>
        <StepPips steps={s.steps} kinds={kinds} />
        <div style={{ display: 'flex', gap: 22, paddingTop: 14, borderTop: '1px solid var(--border-subtle)' }}>
          <Stat label="Enrolled" value={s.enrolled.toLocaleString()} />
          <Stat label="Open" value={s.open ? s.open.toFixed(0) + '%' : '—'} />
          <Stat label="Reply" value={s.reply ? s.reply.toFixed(0) + '%' : '—'} accent={s.reply > 20} />
          <Stat label="Meetings" value={s.meetings || '—'} />
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 7 }}>
            <Avatar name={s.owner} size="sm" />
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{s.owner}</span>
          </div>
        </div>
      </div>
    </Card>
  );
}
function Stat({ label, value, accent }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)' }}>{label}</span>
      <span style={{ fontSize: 'var(--text-lg)', fontWeight: 'var(--fw-semibold)', color: accent ? 'var(--success-text)' : 'var(--text-strong)', fontFeatureSettings: 'var(--numeric)' }}>{value}</span>
    </div>
  );
}

function Sequences() {
  const D = window.LinkiData;
  const [tab, setTab] = React.useState('all');
  const shown = D.sequences.filter((s) => tab === 'all' ? true : s.status === tab);
  return (
    <div style={{ maxWidth: 'var(--container-max)', margin: '0 auto', padding: '24px 28px 40px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
        <div style={{ flex: 1 }}>
          <h1 style={{ fontSize: 'var(--text-3xl)', fontWeight: 'var(--fw-semibold)', color: 'var(--text-strong)', letterSpacing: '-.01em' }}>Sequences</h1>
          <p style={{ fontSize: 'var(--text-md)', color: 'var(--text-muted)', marginTop: 4 }}>Multi-step outbound campaigns across email, calls, and LinkedIn.</p>
        </div>
        <Button variant="secondary" leftIcon={<Icon name="upload" size={15} />}>Import</Button>
        <Button variant="primary" leftIcon={<Icon name="plus" size={15} />}>New sequence</Button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
        <Tabs value={tab} onChange={setTab} items={[{ value: 'all', label: 'All', count: D.sequences.length }, { value: 'active', label: 'Active', count: D.sequences.filter((s) => s.status === 'active').length }, { value: 'paused', label: 'Paused' }, { value: 'draft', label: 'Drafts' }, { value: 'completed', label: 'Completed' }]} />
        <div style={{ marginLeft: 'auto', width: 240 }}>
          <Input size="sm" placeholder="Search sequences…" leftIcon={<Icon name="search" size={15} />} />
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {shown.map((s) => <SequenceCard key={s.id} s={s} />)}
      </div>
      {shown.length === 0 && (
        <Card style={{ textAlign: 'center', padding: 48 }}>
          <div style={{ width: 44, height: 44, borderRadius: 'var(--radius-lg)', background: 'var(--primary-subtle)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: 14 }}><Icon name="git-branch" size={22} style={{ color: 'var(--primary-text)' }} /></div>
          <h3 style={{ fontSize: 'var(--text-lg)', fontWeight: 'var(--fw-semibold)', color: 'var(--text-strong)' }}>No sequences here</h3>
          <p style={{ fontSize: 'var(--text-md)', color: 'var(--text-muted)', margin: '6px 0 16px' }}>Build your first outbound flow in a few minutes.</p>
          <Button variant="primary" leftIcon={<Icon name="plus" size={15} />}>New sequence</Button>
        </Card>
      )}
    </div>
  );
}

Object.assign(window, { Sequences });

})();
