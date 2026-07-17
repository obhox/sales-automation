import * as React from 'react';
/**
 * Surface container for grouped content. The system's default "paper".
 * @startingPoint section="Components" subtitle="Elevated surface container" viewport="700x220"
 */
export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  padding?: 'none' | 'sm' | 'md' | 'lg' | string;
  /** Hover lift + pointer, for clickable cards. @default false */
  interactive?: boolean;
}
export function Card(props: CardProps): JSX.Element;
