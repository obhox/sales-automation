import * as React from 'react';
/** KPI block: label, large tabular value, and optional delta with trend arrow. */
export interface MetricProps extends React.HTMLAttributes<HTMLDivElement> {
  label: string;
  value: React.ReactNode;
  /** Delta string, e.g. "+12.4%". */
  delta?: React.ReactNode;
  trend?: 'up' | 'down' | 'flat';
  /** Sub-line caption below the value. */
  hint?: string;
}
export function Metric(props: MetricProps): JSX.Element;
