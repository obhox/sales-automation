import * as React from 'react';
export interface TabItem { value: string; label: React.ReactNode; icon?: React.ReactNode; count?: number; }
/** Tab bar, underline or pill. Controlled (value/onChange) or uncontrolled (defaultValue). */
export interface TabsProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange'> {
  items: TabItem[];
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  variant?: 'underline' | 'pill';
}
export function Tabs(props: TabsProps): JSX.Element;
