import * as React from 'react';
/** Determinate progress bar, 0–100. */
export interface ProgressBarProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: number;
  tone?: 'brand' | 'success' | 'warning' | 'danger';
  label?: React.ReactNode;
  showValue?: boolean;
  size?: 'sm' | 'md' | 'lg';
}
export function ProgressBar(props: ProgressBarProps): JSX.Element;
