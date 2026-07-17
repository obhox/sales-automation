import * as React from 'react';
/** Checkbox with label; supports controlled `checked` and `indeterminate`. */
export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'style'> {
  label?: React.ReactNode;
  checked?: boolean;
  indeterminate?: boolean;
  style?: React.CSSProperties;
}
export function Checkbox(props: CheckboxProps): JSX.Element;
