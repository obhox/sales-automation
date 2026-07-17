import * as React from 'react';
export interface Crumb { label: React.ReactNode; href?: string; }
/** Breadcrumb trail; the last item renders as the current page. */
export interface BreadcrumbsProps extends React.HTMLAttributes<HTMLElement> {
  items: Crumb[];
}
export function Breadcrumbs(props: BreadcrumbsProps): JSX.Element;
