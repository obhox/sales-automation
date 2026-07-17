import * as React from 'react';
/** Avatar with image or auto colored-initials fallback and optional status dot. */
export interface AvatarProps extends React.HTMLAttributes<HTMLSpanElement> {
  name?: string;
  src?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | number;
  /** Rounded-square instead of circle. @default false */
  square?: boolean;
  status?: 'online' | 'busy' | 'offline';
}
export function Avatar(props: AvatarProps): JSX.Element;
