import * as React from 'react';
/** Removable metadata chip. Provide onRemove to render the × affordance. */
export interface TagProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Show a leading color dot (category color). */
  color?: string;
  /** When set, renders a remove button firing this handler. */
  onRemove?: () => void;
}
export function Tag(props: TagProps): JSX.Element;
