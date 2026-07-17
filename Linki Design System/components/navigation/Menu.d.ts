import * as React from 'react';
export interface MenuItemDef {
  label?: React.ReactNode;
  icon?: React.ReactNode;
  onSelect?: () => void;
  tone?: 'danger';
  shortcut?: string;
  divider?: boolean;
}
/** Dropdown menu anchored to a trigger. Closes on select / outside-click / Esc. */
export interface MenuProps extends React.HTMLAttributes<HTMLDivElement> {
  trigger: React.ReactNode;
  items: MenuItemDef[];
  align?: 'start' | 'end';
}
export function Menu(props: MenuProps): JSX.Element;
