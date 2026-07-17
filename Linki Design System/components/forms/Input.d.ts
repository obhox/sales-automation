import * as React from 'react';
/**
 * Single-line text field with label, hint, error, and optional icon adornments.
 * @startingPoint section="Components" subtitle="Text field with label & validation" viewport="700x150"
 */
export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size' | 'style'> {
  label?: string;
  hint?: string;
  /** Error message; also flips the field to the danger state. */
  error?: string;
  size?: 'sm' | 'md' | 'lg';
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  style?: React.CSSProperties;
  containerStyle?: React.CSSProperties;
}
export function Input(props: InputProps): JSX.Element;
