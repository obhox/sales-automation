Overlays — Dialog (modal) and Tooltip.

```jsx
<Dialog open={open} onClose={close} title="Delete sequence?"
  description="This removes all 142 enrolled contacts. This can't be undone."
  footer={<><Button variant="secondary" onClick={close}>Cancel</Button><Button variant="destructive">Delete</Button></>} />

<Tooltip label="Copy link" side="top"><IconButton icon={<Icon name="link" />} label="Copy" /></Tooltip>
```

Dialog closes on scrim-click and Esc; keep footers to ≤2 actions with the primary on the right.
