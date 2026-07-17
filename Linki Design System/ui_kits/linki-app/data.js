// Fake seed data for the Linki app UI kit.
window.LinkiData = (function () {
  const sequences = [
    { id: 'seq_9F42', name: 'Q3 Outbound — Founders', status: 'active', steps: 5, enrolled: 142, open: 61.2, reply: 24.6, meetings: 12, owner: 'Dana Ruiz' },
    { id: 'seq_7A18', name: 'Warm re-engage', status: 'active', steps: 3, enrolled: 88, open: 54.0, reply: 18.1, meetings: 6, owner: 'Marco Silva' },
    { id: 'seq_4C90', name: 'Enterprise ABM', status: 'paused', steps: 7, enrolled: 34, open: 48.5, reply: 15.4, meetings: 4, owner: 'Priya Nair' },
    { id: 'seq_2B55', name: 'Trial expiry nudge', status: 'active', steps: 4, enrolled: 210, open: 66.9, reply: 21.0, meetings: 9, owner: 'Dana Ruiz' },
    { id: 'seq_1E03', name: 'Event follow-up — SaaStr', status: 'draft', steps: 2, enrolled: 0, open: 0, reply: 0, meetings: 0, owner: 'Leah Park' },
    { id: 'seq_8D77', name: 'Churned win-back', status: 'completed', steps: 6, enrolled: 156, open: 42.3, reply: 12.8, meetings: 5, owner: 'Marco Silva' },
  ];
  const contacts = [
    { name: 'Alicia Gomez', title: 'VP Sales', company: 'Northwind', stage: 'Qualified', owner: 'Dana Ruiz', email: 'alicia@northwind.io', last: '2h ago', health: 'online' },
    { name: 'Ben Ito', title: 'Founder', company: 'Loomly', stage: 'Lead', owner: 'Marco Silva', email: 'ben@loomly.com', last: '1d ago', health: 'busy' },
    { name: 'Carmen Diaz', title: 'Head of Growth', company: 'Segment Bay', stage: 'Proposal', owner: 'Priya Nair', email: 'carmen@segmentbay.co', last: '3h ago', health: 'online' },
    { name: 'David Okoro', title: 'RevOps Lead', company: 'Traylo', stage: 'Qualified', owner: 'Dana Ruiz', email: 'd.okoro@traylo.app', last: '5d ago', health: 'offline' },
    { name: 'Elena Rossi', title: 'CMO', company: 'Brightside', stage: 'Negotiation', owner: 'Leah Park', email: 'elena@brightside.eu', last: '20m ago', health: 'online' },
    { name: 'Farid Hassan', title: 'CEO', company: 'Kettle', stage: 'Lead', owner: 'Marco Silva', email: 'farid@kettle.dev', last: '2d ago', health: 'offline' },
    { name: 'Grace Lin', title: 'Ops Manager', company: 'Nimbus', stage: 'Qualified', owner: 'Priya Nair', email: 'grace@nimbus.cloud', last: '1h ago', health: 'busy' },
  ];
  const activity = [
    { icon: 'reply', tone: 'accent', text: 'Alicia Gomez replied to Q3 Outbound', time: '2m' },
    { icon: 'calendar-check', tone: 'brand', text: 'Meeting booked with Carmen Diaz', time: '18m' },
    { icon: 'mail-open', tone: 'muted', text: 'Ben Ito opened “Warm re-engage” · step 2', time: '41m' },
    { icon: 'user-plus', tone: 'muted', text: 'Leah Park enrolled 34 contacts in Enterprise ABM', time: '1h' },
    { icon: 'alert-triangle', tone: 'warning', text: '2 messages bounced in Trial expiry nudge', time: '2h' },
  ];
  const stageTone = { Lead: 'neutral', Qualified: 'info', Proposal: 'brand', Negotiation: 'warning', Won: 'success' };
  const statusTone = { active: 'success', paused: 'warning', draft: 'neutral', completed: 'info' };
  return { sequences, contacts, activity, stageTone, statusTone };
})();
