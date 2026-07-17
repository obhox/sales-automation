import * as React from 'react';
/** Renders a Lucide icon by kebab or Pascal name. Requires window.lucide loaded. */
export interface IconProps extends Omit<React.SVGProps<SVGSVGElement>, 'name' | 'color'> {
  /** Lucide icon name, e.g. "arrow-right", "settings", "trash-2". */
  name: string;
  size?: number;
  strokeWidth?: number;
  color?: string;
}
export function Icon(props: IconProps): JSX.Element;
