Form controls — Input, Textarea, Select, Checkbox, Radio, Switch.

```jsx
<Input label="Work email" placeholder="you@company.com" hint="We'll never share it." />
<Input label="Domain" error="Already in use" leftIcon={<Icon name="globe" size={15} />} />
<Select label="Stage"><option>Lead</option><option>Qualified</option></Select>
<Checkbox label="Enroll in sequence" checked onChange={fn} />
<Switch label="Auto-follow-up" checked onChange={fn} />
```

All text fields share label/hint/error props and the same focus ring. Checkbox/Radio/Switch are controlled — pass `checked` + `onChange`. Use Switch for instant-apply settings, Checkbox for form submission.
