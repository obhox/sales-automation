import * as React from 'react';
/** Inline, persistent contextual message. For transient popups use Toast. */
export interface AlertProps extends React.HTMLAttributes<HTMLDivElement> {
  tone?: 'info' | 'success' | 'warning' | 'danger';
  title?: React.ReactNode;
  /** Optional dismiss handler; renders a close button. */
  onClose?: () => void;
}
export function Alert(props: AlertProps): JSX.Element;
