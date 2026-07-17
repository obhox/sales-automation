Display primitives — Icon, Badge, Tag, Avatar, Card, Metric.

```jsx
<Badge tone="success" dot>Connected</Badge>
<Tag color="var(--viz-3)" onRemove={() => {}}>Enterprise</Tag>
<Avatar name="Dana Ruiz" status="online" />
<Metric label="Reply rate" value="24.6%" delta="+3.1%" trend="up" />
<Card interactive><h3 className="h4">Acme Corp</h3></Card>
<Icon name="zap" size={18} />
```

Badge tones: neutral/brand/success/warning/danger/info/accent. Avatar auto-generates colored initials without `src`. Metric uses tabular numerals; set `trend` to color the delta.
