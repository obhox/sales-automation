import * as React from 'react';
/** Centered modal dialog with scrim + Esc/scrim close. Controlled via `open`. */
export interface DialogProps extends React.HTMLAttributes<HTMLDivElement> {
  open: boolean;
  onClose?: () => void;
  title?: React.ReactNode;
  description?: React.ReactNode;
  /** Footer node, typically the action buttons. */
  footer?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
}
export function Dialog(props: DialogProps): JSX.Element | null;
