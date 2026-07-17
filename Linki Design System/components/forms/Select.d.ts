import * as React from 'react';
/** Native <select> styled to match Input, with custom chevron. Pass <option>s as children. */
export interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'size' | 'style'> {
  label?: string;
  hint?: string;
  error?: string;
  size?: 'sm' | 'md' | 'lg';
  style?: React.CSSProperties;
  containerStyle?: React.CSSProperties;
}
export function Select(props: SelectProps): JSX.Element;
