import * as React from 'react';

/** Square button holding a single icon; used in toolbars, table rows, headers. */
export interface IconButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'style'> {
  /** The icon node (e.g. <Icon name="more-horizontal" />). */
  icon: React.ReactNode;
  /** Accessible label — REQUIRED (rendered as aria-label + title). */
  label: string;
  variant?: 'secondary' | 'ghost' | 'primary';
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  style?: React.CSSProperties;
}
export function IconButton(props: IconButtonProps): JSX.Element;
