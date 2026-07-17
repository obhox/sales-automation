import * as React from 'react';
/** Shimmering loading placeholder sized to the content it stands in for. */
export interface SkeletonProps extends React.HTMLAttributes<HTMLSpanElement> {
  width?: number | string;
  height?: number | string;
  radius?: string;
  circle?: boolean;
}
export function Skeleton(props: SkeletonProps): JSX.Element;
