import React from 'react';

function toPascal(name) {
  return String(name).replace(/(^|[-_ ])(\w)/g, (_, __, c) => c.toUpperCase());
}

/**
 * Renders a Lucide icon by name. Requires the Lucide UMD script on the page
 * (window.lucide). Falls back to an empty box glyph if the name is unknown or
 * Lucide hasn't loaded — never throws.
 */
export function Icon({ name, size = 16, strokeWidth = 2, color = 'currentColor', style, ...rest }) {
  const lib = typeof window !== 'undefined' && window.lucide && window.lucide.icons;
  const node = lib && (lib[toPascal(name)] || lib[name]);
  // Lucide icon data comes in two shapes across versions:
  //   modern: [tag, attrs, [ [childTag, childAttrs], … ]]  (a full element)
  //   legacy: [ [childTag, childAttrs], … ]                (children only)
  const raw = Array.isArray(node)
    ? (typeof node[0] === 'string' ? (Array.isArray(node[2]) ? node[2] : []) : node)
    : null;
  const kids = raw
    ? raw.map(([tag, attrs], i) => React.createElement(tag, { key: i, ...attrs }))
    : null;
  return React.createElement('svg', {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    stroke: color, strokeWidth, strokeLinecap: 'round', strokeLinejoin: 'round',
    style: { display: 'inline-block', flexShrink: 0, verticalAlign: 'middle', ...style },
    'aria-hidden': true, ...rest,
  }, kids || React.createElement('rect', { x: 4, y: 4, width: 16, height: 16, rx: 2, opacity: .25 }));
}
