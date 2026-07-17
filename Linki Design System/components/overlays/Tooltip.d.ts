import * as React from 'react';
/** Hover/focus tooltip wrapping a single trigger child. */
export interface TooltipProps extends React.HTMLAttributes<HTMLSpanElement> {
  label: React.ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  children: React.ReactNode;
}
export function Tooltip(props: TooltipProps): JSX.Element;
