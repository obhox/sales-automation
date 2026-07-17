import * as React from 'react';
/** On/off toggle for instant-apply settings. */
export interface SwitchProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size' | 'style'> {
  label?: React.ReactNode;
  checked?: boolean;
  size?: 'sm' | 'md';
  style?: React.CSSProperties;
}
export function Switch(props: SwitchProps): JSX.Element;
