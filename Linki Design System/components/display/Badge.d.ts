import * as React from 'react';
/** Status / label pill. Seven semantic tones; solid or subtle; optional status dot. */
export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'info' | 'accent';
  /** Filled treatment instead of subtle tint. @default false */
  solid?: boolean;
  /** Prepend a status dot. @default false */
  dot?: boolean;
}
export function Badge(props: BadgeProps): JSX.Element;
