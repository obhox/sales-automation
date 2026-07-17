Feedback — Alert (inline, persistent), Toast (transient), Spinner, Skeleton, ProgressBar.

```jsx
<Alert tone="warning" title="Domain not verified" onClose={fn}>Add a TXT record to send from this domain.</Alert>
<Toast tone="success" title="Sequence launched" description="142 contacts enrolled." onClose={fn} />
<ProgressBar value={68} label="Sending" showValue />
<Skeleton width={180} height={12} />  <Spinner />
```

Alert stays until dismissed; Toast is transient (you own the timer/queue). Skeleton should mirror the shape of the content it replaces.
