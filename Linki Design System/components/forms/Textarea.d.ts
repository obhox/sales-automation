import * as React from 'react';
/** Multi-line text field with label / hint / error. Vertically resizable. */
export interface TextareaProps extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'style'> {
  label?: string;
  hint?: string;
  error?: string;
  style?: React.CSSProperties;
  containerStyle?: React.CSSProperties;
}
export function Textarea(props: TextareaProps): JSX.Element;
