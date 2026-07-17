import * as React from 'react';
/** Indeterminate spinner. */
export interface SpinnerProps extends React.HTMLAttributes<HTMLSpanElement> {
  size?: number;
  thickness?: number;
  color?: string;
}
export function Spinner(props: SpinnerProps): JSX.Element;
