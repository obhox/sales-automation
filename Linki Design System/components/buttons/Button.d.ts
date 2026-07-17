import * as React from 'react';

/**
 * Primary interactive control. Six variants cover every action hierarchy
 * from hero CTA (primary) to inline text action (link).
 *
 * @startingPoint section="Components" subtitle="Six-variant action button" viewport="700x150"
 */
export interface ButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'style'> {
  /** Visual weight / intent. @default "primary" */
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'destructive' | 'link';
  /** Control height. @default "md" */
  size?: 'sm' | 'md' | 'lg';
  /** Icon node rendered before the label (e.g. <Icon name="plus" />). */
  leftIcon?: React.ReactNode;
  /** Icon node rendered after the label. */
  rightIcon?: React.ReactNode;
  /** Swaps content for a spinner and blocks interaction. @default false */
  loading?: boolean;
  disabled?: boolean;
  /** Stretch to container width. @default false */
  fullWidth?: boolean;
  style?: React.CSSProperties;
}
export function Button(props: ButtonProps): JSX.Element;
