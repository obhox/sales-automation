/* IIFE-wrapped */
(function(){
// Dashboard screen — metrics, sending progress, activity, sequence table.
const { Card, Metric, Badge, Icon, Avatar, ProgressBar, Button, Tabs, Menu, IconButton } = window.LinkiDesignSystem_8f2af2;

function SectionTitle({ children, action }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
      <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 'var(--fw-semibold)', color: 'var(--text-strong)', letterSpacing: '-.01em' }}>{children}</h2>
      {action && <div style={{ marginLeft: 'auto' }}>{action}</div>}
    </div>
  );
}

// Tiny inline sparkline-ish bar chart, tokens only.
function MiniBars({ data, color }) {
  const max = Math.max(...data);
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 48 }}>
      {data.map((v, i) => <div key={i} style={{ flex: 1, height: `${(v / max) * 100}%`, background: color, borderRadius: '3px 3px 0 0', opacity: 0.35 + 0.65 * (v / max) }} />)}
    </div>
  );
}

function ActivityRow({ item }) {
  const D = window.LinkiData;
  const toneColor = { accent: 'var(--accent-text)', brand: 'var(--primary-text)', warning: 'var(--warning-text)', muted: 'var(--text-subtle)' }[item.tone];
  const toneBg = { accent: 'var(--accent-subtle)', brand: 'var(--primary-subtle)', warning: 'var(--warning-bg)', muted: 'var(--surface-sunken)' }[item.tone];
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '10px 0', borderBottom: '1px solid var(--border-subtle)' }}>
      <span style={{ width: 28, height: 28, flexShrink: 0, borderRadius: 'var(--radius-md)', background: toneBg, color: toneColor, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><Icon name={item.icon} size={15} /></span>
      <span style={{ flex: 1, fontSize: 'var(--text-sm)', color: 'var(--text)' }}>{item.text}</span>
      <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)', fontFeatureSettings: 'var(--numeric)' }}>{item.time}</span>
    </div>
  );
}

function SeqRow({ s }) {
  const D = window.LinkiData;
  return (
    <tr style={{ borderTop: '1px solid var(--border-subtle)' }}>
      <td style={{ padding: '12px 16px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ fontSize: 'var(--text-md)', fontWeight: 'var(--fw-medium)', color: 'var(--text-strong)' }}>{s.name}</span>
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)', fontFamily: 'var(--font-mono)' }}>{s.id} · {s.steps} steps</span>
        </div>
      </td>
      <td style={{ padding: '12px 16px' }}><Badge tone={D.statusTone[s.status]} dot>{s.status}</Badge></td>
      <td style={{ padding: '12px 16px', textAlign: 'right', fontFeatureSettings: 'var(--numeric)', color: 'var(--text)' }}>{s.enrolled.toLocaleString()}</td>
      <td style={{ padding: '12px 16px', textAlign: 'right', fontFeatureSettings: 'var(--numeric)', color: 'var(--text)' }}>{s.open ? s.open.toFixed(1) + '%' : '—'}</td>
      <td style={{ padding: '12px 16px', textAlign: 'right', fontFeatureSettings: 'var(--numeric)', fontWeight: 'var(--fw-semibold)', color: s.reply > 20 ? 'var(--success-text)' : 'var(--text)' }}>{s.reply ? s.reply.toFixed(1) + '%' : '—'}</td>
      <td style={{ padding: '12px 16px' }}><Avatar name={s.owner} size="sm" /></td>
      <td style={{ padding: '12px 8px', textAlign: 'right' }}>
        <Menu trigger={<IconButton variant="ghost" size="sm" icon={<Icon name="more-horizontal" size={16} />} label="Row actions" />}
          items={[{ label: 'Open', icon: <Icon name="arrow-up-right" size={15} /> }, { label: 'Duplicate', icon: <Icon name="copy" size={15} /> }, { label: 'Pause', icon: <Icon name="pause" size={15} /> }, { divider: true }, { label: 'Delete', icon: <Icon name="trash-2" size={15} />, tone: 'danger' }]} />
      </td>
    </tr>
  );
}

function Dashboard() {
  const D = window.LinkiData;
  const th = { padding: '10px 16px', textAlign: 'left', fontSize: 'var(--text-xs)', fontWeight: 'var(--fw-semibold)', color: 'var(--text-subtle)', textTransform: 'uppercase', letterSpacing: '.04em', whiteSpace: 'nowrap' };
  return (
    <div style={{ maxWidth: 'var(--container-max)', margin: '0 auto', padding: '24px 28px 40px' }}>
      {/* KPI row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 24 }}>
        <Card><Metric label="Emails sent" value="12,480" delta="+8.2%" trend="up" hint="last 30 days" /></Card>
        <Card><Metric label="Open rate" value="61.2%" delta="+2.4%" trend="up" /></Card>
        <Card><Metric label="Reply rate" value="24.6%" delta="+3.1%" trend="up" /></Card>
        <Card><Metric label="Meetings booked" value="38" delta="-4" trend="down" /></Card>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr', gap: 16, marginBottom: 24 }}>
        {/* Sends chart */}
        <Card>
          <SectionTitle action={<Tabs variant="pill" defaultValue="30" items={[{ value: '7', label: '7d' }, { value: '30', label: '30d' }, { value: '90', label: '90d' }]} />}>Sending volume</SectionTitle>
          <MiniBars data={[42, 55, 48, 70, 63, 88, 72, 95, 81, 110, 98, 124, 118, 132]} color="var(--cobalt-500)" />
          <div style={{ display: 'flex', gap: 24, marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border-subtle)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}><span style={{ width: 9, height: 9, borderRadius: 2, background: 'var(--cobalt-500)' }} />Delivered <b style={{ color: 'var(--text-strong)', marginLeft: 4 }}>11,904</b></div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}><span style={{ width: 9, height: 9, borderRadius: 2, background: 'var(--teal-500)' }} />Opened <b style={{ color: 'var(--text-strong)', marginLeft: 4 }}>7,285</b></div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}><span style={{ width: 9, height: 9, borderRadius: 2, background: 'var(--slate-300)' }} />Bounced <b style={{ color: 'var(--text-strong)', marginLeft: 4 }}>576</b></div>
          </div>
        </Card>
        {/* Today sending */}
        <Card>
          <SectionTitle>Today’s sending</SectionTitle>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <ProgressBar label="Daily send limit" value={68} showValue />
            <ProgressBar label="Warmup progress" value={92} showValue />
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 12, background: 'var(--warning-bg)', border: '1px solid var(--warning-border)', borderRadius: 'var(--radius-md)' }}>
              <Icon name="alert-triangle" size={16} style={{ color: 'var(--warning-text)', flexShrink: 0 }} />
              <span style={{ fontSize: 'var(--text-sm)', color: 'var(--warning-text)' }}>1 domain needs verification before sending.</span>
            </div>
          </div>
        </Card>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr', gap: 16 }}>
        {/* Sequences table */}
        <Card padding="none" style={{ overflow: 'hidden' }}>
          <div style={{ padding: '16px 16px 12px' }}><SectionTitle action={<Button variant="ghost" size="sm" rightIcon={<Icon name="arrow-right" size={15} />}>All sequences</Button>}>Active sequences</SectionTitle></div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={th}>Sequence</th><th style={th}>Status</th>
              <th style={{ ...th, textAlign: 'right' }}>Enrolled</th><th style={{ ...th, textAlign: 'right' }}>Open</th>
              <th style={{ ...th, textAlign: 'right' }}>Reply</th><th style={th}>Owner</th><th style={th}></th>
            </tr></thead>
            <tbody>{D.sequences.filter((s) => s.status === 'active').map((s) => <SeqRow key={s.id} s={s} />)}</tbody>
          </table>
        </Card>
        {/* Activity */}
        <Card>
          <SectionTitle>Live activity</SectionTitle>
          <div>{D.activity.map((a, i) => <ActivityRow key={i} item={a} />)}</div>
        </Card>
      </div>
    </div>
  );
}

Object.assign(window, { Dashboard });

})();
