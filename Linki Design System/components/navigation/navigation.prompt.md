Navigation — Tabs, Breadcrumbs, Menu (dropdown).

```jsx
<Tabs items={[{value:'all',label:'All',count:214},{value:'active',label:'Active'}]} defaultValue="all" />
<Breadcrumbs items={[{label:'Sequences',href:'#'},{label:'Q3 Outbound'}]} />
<Menu trigger={<IconButton icon={<Icon name="more-horizontal" />} label="More" />}
  items={[{label:'Edit',icon:<Icon name="pencil" size={15}/>,shortcut:'E'},{divider:true},{label:'Delete',icon:<Icon name="trash-2" size={15}/>,tone:'danger'}]} />
```

Tabs supports `underline` (page-level) and `pill` (in-panel segmented) variants. Menu is fully self-contained (open state, dismissal).
