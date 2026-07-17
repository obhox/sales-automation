/* IIFE-wrapped */
(function(){
// Contacts screen — CRM data table with selection, stage, owner, enrichment.
const { Card, Badge, Icon, Avatar, Button, Checkbox, Input, Menu, IconButton, Select, Tag } = window.LinkiDesignSystem_8f2af2;

function Contacts() {
  const D = window.LinkiData;
  const [sel, setSel] = React.useState({});
  const allChecked = D.contacts.every((c) => sel[c.email]);
  const someChecked = D.contacts.some((c) => sel[c.email]);
  const toggleAll = () => { const n = {}; if (!allChecked) D.contacts.forEach((c) => n[c.email] = true); setSel(n); };
  const count = Object.values(sel).filter(Boolean).length;
  const th = { padding: '10px 16px', textAlign: 'left', fontSize: 'var(--text-xs)', fontWeight: 'var(--fw-semibold)', color: 'var(--text-subtle)', textTransform: 'uppercase', letterSpacing: '.04em', whiteSpace: 'nowrap', background: 'var(--bg-subtle)' };
  const td = { padding: '11px 16px', fontSize: 'var(--text-md)', color: 'var(--text)', whiteSpace: 'nowrap' };

  return (
    <div style={{ maxWidth: 'var(--container-max)', margin: '0 auto', padding: '24px 28px 40px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
        <div style={{ flex: 1 }}>
          <h1 style={{ fontSize: 'var(--text-3xl)', fontWeight: 'var(--fw-semibold)', color: 'var(--text-strong)', letterSpacing: '-.01em' }}>Contacts</h1>
          <p style={{ fontSize: 'var(--text-md)', color: 'var(--text-muted)', marginTop: 4 }}>{D.contacts.length} people across 6 companies.</p>
        </div>
        <Button variant="secondary" leftIcon={<Icon name="filter" size={15} />}>Filter</Button>
        <Button variant="primary" leftIcon={<Icon name="user-plus" size={15} />}>Add contact</Button>
      </div>

      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <div style={{ width: 280 }}><Input size="sm" placeholder="Search name, company, email…" leftIcon={<Icon name="search" size={15} />} /></div>
        <Select size="sm" defaultValue="All stages" containerStyle={{ width: 150 }}><option>All stages</option><option>Lead</option><option>Qualified</option><option>Proposal</option></Select>
        <Tag color="var(--viz-1)" onRemove={() => {}}>Owner: Dana</Tag>
        {count > 0 && (
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10, padding: '5px 6px 5px 12px', background: 'var(--primary-subtle)', border: '1px solid var(--primary-border)', borderRadius: 'var(--radius-md)' }}>
            <span style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--fw-medium)', color: 'var(--primary-text)' }}>{count} selected</span>
            <Button size="sm" variant="primary" leftIcon={<Icon name="git-branch" size={14} />}>Enroll</Button>
          </div>
        )}
      </div>

      <Card padding="none" style={{ overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>
            <th style={{ ...th, width: 44, paddingRight: 0 }}><Checkbox checked={allChecked} indeterminate={someChecked && !allChecked} onChange={toggleAll} /></th>
            <th style={th}>Name</th><th style={th}>Company</th><th style={th}>Stage</th>
            <th style={th}>Owner</th><th style={th}>Last activity</th><th style={{ ...th, textAlign: 'right' }}></th>
          </tr></thead>
          <tbody>
            {D.contacts.map((c) => {
              const on = !!sel[c.email];
              return (
                <tr key={c.email} style={{ borderTop: '1px solid var(--border-subtle)', background: on ? 'var(--primary-subtle)' : 'transparent' }}>
                  <td style={{ ...td, paddingRight: 0 }}><Checkbox checked={on} onChange={() => setSel({ ...sel, [c.email]: !on })} /></td>
                  <td style={td}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <Avatar name={c.name} size="sm" status={c.health} />
                      <div style={{ display: 'flex', flexDirection: 'column' }}>
                        <span style={{ fontWeight: 'var(--fw-medium)', color: 'var(--text-strong)' }}>{c.name}</span>
                        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)' }}>{c.title} · {c.email}</span>
                      </div>
                    </div>
                  </td>
                  <td style={{ ...td, color: 'var(--text-muted)' }}>{c.company}</td>
                  <td style={td}><Badge tone={D.stageTone[c.stage]}>{c.stage}</Badge></td>
                  <td style={td}><div style={{ display: 'flex', alignItems: 'center', gap: 7 }}><Avatar name={c.owner} size="xs" /><span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{c.owner.split(' ')[0]}</span></div></td>
                  <td style={{ ...td, color: 'var(--text-subtle)', fontSize: 'var(--text-sm)' }}>{c.last}</td>
                  <td style={{ ...td, textAlign: 'right', paddingLeft: 0 }}>
                    <Menu align="right" trigger={<IconButton variant="ghost" size="sm" icon={<Icon name="more-horizontal" size={16} />} label="Contact actions" />}
                      items={[{ label: 'View profile', icon: <Icon name="user" size={15} /> }, { label: 'Send email', icon: <Icon name="mail" size={15} /> }, { label: 'Enroll in sequence', icon: <Icon name="git-branch" size={15} /> }, { divider: true }, { label: 'Remove', icon: <Icon name="trash-2" size={15} />, tone: 'danger' }]} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div style={{ display: 'flex', alignItems: 'center', padding: '12px 16px', borderTop: '1px solid var(--border-subtle)' }}>
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-subtle)' }}>Showing {D.contacts.length} of 1,204</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <Button variant="secondary" size="sm" disabled leftIcon={<Icon name="chevron-left" size={15} />}>Prev</Button>
            <Button variant="secondary" size="sm" rightIcon={<Icon name="chevron-right" size={15} />}>Next</Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

Object.assign(window, { Contacts });

})();
