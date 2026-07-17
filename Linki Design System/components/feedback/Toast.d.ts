import * as React from 'react';
/** Transient notification card. Presentational — drive visibility/timing yourself. */
export interface ToastProps extends React.HTMLAttributes<HTMLDivElement> {
  tone?: 'neutral' | 'success' | 'danger' | 'warning' | 'info';
  title?: React.ReactNode;
  description?: React.ReactNode;
  /** Action node, e.g. an undo <Button variant="link">. */
  action?: React.ReactNode;
  onClose?: () => void;
}
export function Toast(props: ToastProps): JSX.Element;
