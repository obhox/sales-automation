/* @ds-bundle: {"format":4,"namespace":"LinkiDesignSystem_8f2af2","components":[{"name":"Button","sourcePath":"components/buttons/Button.jsx"},{"name":"IconButton","sourcePath":"components/buttons/IconButton.jsx"},{"name":"Avatar","sourcePath":"components/display/Avatar.jsx"},{"name":"Badge","sourcePath":"components/display/Badge.jsx"},{"name":"Card","sourcePath":"components/display/Card.jsx"},{"name":"Icon","sourcePath":"components/display/Icon.jsx"},{"name":"Metric","sourcePath":"components/display/Metric.jsx"},{"name":"Tag","sourcePath":"components/display/Tag.jsx"},{"name":"Alert","sourcePath":"components/feedback/Alert.jsx"},{"name":"ProgressBar","sourcePath":"components/feedback/ProgressBar.jsx"},{"name":"Skeleton","sourcePath":"components/feedback/Skeleton.jsx"},{"name":"Spinner","sourcePath":"components/feedback/Spinner.jsx"},{"name":"Toast","sourcePath":"components/feedback/Toast.jsx"},{"name":"Checkbox","sourcePath":"components/forms/Checkbox.jsx"},{"name":"Input","sourcePath":"components/forms/Input.jsx"},{"name":"Radio","sourcePath":"components/forms/Radio.jsx"},{"name":"Select","sourcePath":"components/forms/Select.jsx"},{"name":"Switch","sourcePath":"components/forms/Switch.jsx"},{"name":"Textarea","sourcePath":"components/forms/Textarea.jsx"},{"name":"Breadcrumbs","sourcePath":"components/navigation/Breadcrumbs.jsx"},{"name":"Menu","sourcePath":"components/navigation/Menu.jsx"},{"name":"Tabs","sourcePath":"components/navigation/Tabs.jsx"},{"name":"Dialog","sourcePath":"components/overlays/Dialog.jsx"},{"name":"Tooltip","sourcePath":"components/overlays/Tooltip.jsx"}],"sourceHashes":{"components/buttons/Button.jsx":"2447dddf730e","components/buttons/IconButton.jsx":"900035536f09","components/display/Avatar.jsx":"17adf0b4e087","components/display/Badge.jsx":"8eedeaec09f9","components/display/Card.jsx":"0fdab3c7b5cf","components/display/Icon.jsx":"8b63b26f36f2","components/display/Metric.jsx":"d2d60f6ea335","components/display/Tag.jsx":"1fa146655cf8","components/feedback/Alert.jsx":"53320c131775","components/feedback/ProgressBar.jsx":"f509fd29f47a","components/feedback/Skeleton.jsx":"6d5d1214c02e","components/feedback/Spinner.jsx":"fd7975d7d4f7","components/feedback/Toast.jsx":"aa1c7c3f337e","components/forms/Checkbox.jsx":"89e0459cf375","components/forms/Input.jsx":"9d3082e23add","components/forms/Radio.jsx":"a5289ec9fcd8","components/forms/Select.jsx":"8136f2a9db2c","components/forms/Switch.jsx":"cf224a22f7c9","components/forms/Textarea.jsx":"44d8afb7db92","components/navigation/Breadcrumbs.jsx":"bf6c35d17a52","components/navigation/Menu.jsx":"08caf2af5abe","components/navigation/Tabs.jsx":"0cbf01e17856","components/overlays/Dialog.jsx":"8c38b28f46a3","components/overlays/Tooltip.jsx":"2400cac42ab1","ui_kits/linki-app/Contacts.jsx":"0097c9995b8c","ui_kits/linki-app/Dashboard.jsx":"93553f0135c0","ui_kits/linki-app/Sequences.jsx":"426bfa2ece58","ui_kits/linki-app/Shell.jsx":"896113ed0eab","ui_kits/linki-app/data.js":"ade815335922"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.LinkiDesignSystem_8f2af2 = window.LinkiDesignSystem_8f2af2 || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// components/buttons/Button.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const SIZES = {
  sm: {
    h: 'var(--control-sm)',
    px: '10px',
    fs: 'var(--text-sm)',
    gap: '6px',
    icon: 14
  },
  md: {
    h: 'var(--control-md)',
    px: '13px',
    fs: 'var(--text-md)',
    gap: '7px',
    icon: 16
  },
  lg: {
    h: 'var(--control-lg)',
    px: '16px',
    fs: 'var(--text-md)',
    gap: '8px',
    icon: 18
  }
};
const VARIANTS = {
  primary: {
    background: 'var(--primary)',
    color: 'var(--text-onbrand)',
    border: '1px solid transparent',
    '--hov': 'var(--primary-hover)',
    '--act': 'var(--primary-active)'
  },
  secondary: {
    background: 'var(--surface)',
    color: 'var(--text-strong)',
    border: '1px solid var(--border)',
    boxShadow: 'var(--shadow-raised)',
    '--hov': 'var(--surface-hover)',
    '--act': 'var(--surface-sunken)'
  },
  outline: {
    background: 'transparent',
    color: 'var(--primary-text)',
    border: '1px solid var(--primary-border)',
    '--hov': 'var(--primary-subtle)',
    '--act': 'var(--primary-subtle)'
  },
  ghost: {
    background: 'transparent',
    color: 'var(--text)',
    border: '1px solid transparent',
    '--hov': 'var(--surface-sunken)',
    '--act': 'var(--surface-sunken)'
  },
  destructive: {
    background: 'var(--danger-solid)',
    color: '#fff',
    border: '1px solid transparent',
    '--hov': 'color-mix(in srgb, var(--danger-solid) 88%, #000)',
    '--act': 'color-mix(in srgb, var(--danger-solid) 78%, #000)'
  },
  link: {
    background: 'transparent',
    color: 'var(--primary-text)',
    border: '1px solid transparent',
    padding: 0,
    height: 'auto',
    textDecoration: 'none',
    '--hov': 'transparent',
    '--act': 'transparent'
  }
};
function Button({
  children,
  variant = 'primary',
  size = 'md',
  leftIcon,
  rightIcon,
  loading = false,
  disabled = false,
  fullWidth = false,
  type = 'button',
  style,
  ...rest
}) {
  const [hover, setHover] = React.useState(false);
  const [active, setActive] = React.useState(false);
  const s = SIZES[size] || SIZES.md;
  const v = VARIANTS[variant] || VARIANTS.primary;
  const isLink = variant === 'link';
  const off = disabled || loading;
  const base = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: s.gap,
    height: isLink ? 'auto' : s.h,
    padding: isLink ? 0 : `0 ${s.px}`,
    fontFamily: 'var(--font-sans)',
    fontSize: s.fs,
    fontWeight: 'var(--fw-medium)',
    lineHeight: 1,
    letterSpacing: 'var(--ls-tight)',
    borderRadius: isLink ? 0 : 'var(--radius-md)',
    cursor: off ? 'not-allowed' : 'pointer',
    width: fullWidth ? '100%' : undefined,
    transition: 'background var(--dur-fast) var(--ease-standard), border-color var(--dur-fast), transform var(--dur-fast), box-shadow var(--dur-fast)',
    opacity: off ? 'var(--opacity-disabled)' : 1,
    userSelect: 'none',
    whiteSpace: 'nowrap',
    transform: active && !off ? 'scale(.98)' : 'none',
    background: v.background,
    color: v.color,
    border: v.border,
    boxShadow: v.boxShadow,
    textDecoration: isLink && hover && !off ? 'underline' : 'none',
    textUnderlineOffset: '2px',
    ...(hover && !off ? {
      background: v['--hov']
    } : null),
    ...(active && !off ? {
      background: v['--act']
    } : null),
    ...style
  };
  const iconSize = {
    width: s.icon,
    height: s.icon,
    flexShrink: 0,
    display: 'inline-flex'
  };
  return /*#__PURE__*/React.createElement("button", _extends({
    type: type,
    disabled: off,
    style: base,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => {
      setHover(false);
      setActive(false);
    },
    onMouseDown: () => setActive(true),
    onMouseUp: () => setActive(false)
  }, rest), loading && /*#__PURE__*/React.createElement("span", {
    style: {
      ...iconSize,
      borderRadius: '50%',
      border: '2px solid currentColor',
      borderTopColor: 'transparent',
      animation: 'linki-spin .6s linear infinite',
      opacity: .9
    }
  }), !loading && leftIcon && /*#__PURE__*/React.createElement("span", {
    style: iconSize
  }, leftIcon), children, !loading && rightIcon && /*#__PURE__*/React.createElement("span", {
    style: iconSize
  }, rightIcon));
}
Object.assign(__ds_scope, { Button });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/buttons/Button.jsx", error: String((e && e.message) || e) }); }

// components/buttons/IconButton.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const SIZES = {
  sm: {
    d: 'var(--control-sm)',
    icon: 15
  },
  md: {
    d: 'var(--control-md)',
    icon: 17
  },
  lg: {
    d: 'var(--control-lg)',
    icon: 19
  }
};
const VARIANTS = {
  secondary: {
    background: 'var(--surface)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    boxShadow: 'var(--shadow-raised)',
    hov: 'var(--surface-hover)'
  },
  ghost: {
    background: 'transparent',
    color: 'var(--text-muted)',
    border: '1px solid transparent',
    hov: 'var(--surface-sunken)'
  },
  primary: {
    background: 'var(--primary)',
    color: '#fff',
    border: '1px solid transparent',
    hov: 'var(--primary-hover)'
  }
};
function IconButton({
  icon,
  label,
  variant = 'ghost',
  size = 'md',
  disabled = false,
  style,
  ...rest
}) {
  const [hover, setHover] = React.useState(false);
  const s = SIZES[size] || SIZES.md;
  const v = VARIANTS[variant] || VARIANTS.ghost;
  return /*#__PURE__*/React.createElement("button", _extends({
    type: "button",
    "aria-label": label,
    disabled: disabled,
    title: label,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: s.d,
      height: s.d,
      borderRadius: 'var(--radius-md)',
      cursor: disabled ? 'not-allowed' : 'pointer',
      background: hover && !disabled ? v.hov : v.background,
      color: v.color,
      border: v.border,
      boxShadow: v.boxShadow,
      opacity: disabled ? 'var(--opacity-disabled)' : 1,
      transition: 'background var(--dur-fast) var(--ease-standard), color var(--dur-fast)',
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement("span", {
    style: {
      width: s.icon,
      height: s.icon,
      display: 'inline-flex'
    }
  }, icon));
}
Object.assign(__ds_scope, { IconButton });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/buttons/IconButton.jsx", error: String((e && e.message) || e) }); }

// components/display/Avatar.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const SIZES = {
  xs: 20,
  sm: 24,
  md: 32,
  lg: 40,
  xl: 56
};
const PALETTE = ['var(--cobalt-500)', 'var(--teal-500)', '#8B5CF6', 'var(--amber-500)', '#EC4899', 'var(--slate-500)'];
function initials(name = '') {
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] || '') + (p[1]?.[0] || '')).toUpperCase() || '?';
}
function hashColor(name = '') {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = h * 31 + name.charCodeAt(i) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/** User/entity avatar. Falls back to colored initials when no `src`. */
function Avatar({
  name = '',
  src,
  size = 'md',
  square = false,
  status,
  style,
  ...rest
}) {
  const d = SIZES[size] || (typeof size === 'number' ? size : 32);
  const fs = Math.round(d * 0.4);
  return /*#__PURE__*/React.createElement("span", _extends({
    style: {
      position: 'relative',
      display: 'inline-flex',
      flexShrink: 0,
      width: d,
      height: d,
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '100%',
      height: '100%',
      borderRadius: square ? 'var(--radius-md)' : '50%',
      overflow: 'hidden',
      background: src ? 'var(--surface-sunken)' : hashColor(name),
      color: '#fff',
      fontSize: fs,
      fontWeight: 'var(--fw-semibold)',
      letterSpacing: '-.01em',
      boxShadow: 'inset 0 0 0 1px rgba(0,0,0,.06)'
    }
  }, src ? /*#__PURE__*/React.createElement("img", {
    src: src,
    alt: name,
    style: {
      width: '100%',
      height: '100%',
      objectFit: 'cover'
    }
  }) : initials(name)), status && /*#__PURE__*/React.createElement("span", {
    style: {
      position: 'absolute',
      right: -1,
      bottom: -1,
      width: Math.max(8, d * 0.28),
      height: Math.max(8, d * 0.28),
      borderRadius: '50%',
      border: '2px solid var(--surface)',
      background: status === 'online' ? 'var(--success-solid)' : status === 'busy' ? 'var(--danger-solid)' : 'var(--slate-400)'
    }
  }));
}
Object.assign(__ds_scope, { Avatar });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/display/Avatar.jsx", error: String((e && e.message) || e) }); }

// components/display/Badge.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const TONES = {
  neutral: {
    bg: 'var(--surface-sunken)',
    fg: 'var(--text-muted)',
    bd: 'var(--border-subtle)'
  },
  brand: {
    bg: 'var(--primary-subtle)',
    fg: 'var(--primary-text)',
    bd: 'var(--primary-border)'
  },
  success: {
    bg: 'var(--success-bg)',
    fg: 'var(--success-text)',
    bd: 'var(--success-border)'
  },
  warning: {
    bg: 'var(--warning-bg)',
    fg: 'var(--warning-text)',
    bd: 'var(--warning-border)'
  },
  danger: {
    bg: 'var(--danger-bg)',
    fg: 'var(--danger-text)',
    bd: 'var(--danger-border)'
  },
  info: {
    bg: 'var(--info-bg)',
    fg: 'var(--info-text)',
    bd: 'var(--info-border)'
  },
  accent: {
    bg: 'var(--accent-subtle)',
    fg: 'var(--accent-text)',
    bd: 'transparent'
  }
};

/** Small status/label pill. `dot` prepends a status dot; `solid` fills. */
function Badge({
  children,
  tone = 'neutral',
  solid = false,
  dot = false,
  style,
  ...rest
}) {
  const t = TONES[tone] || TONES.neutral;
  const base = solid ? {
    background: t.fg,
    color: '#fff',
    border: '1px solid transparent'
  } : {
    background: t.bg,
    color: t.fg,
    border: `1px solid ${t.bd}`
  };
  return /*#__PURE__*/React.createElement("span", _extends({
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      height: 20,
      padding: '0 8px',
      fontSize: 'var(--text-2xs)',
      fontWeight: 'var(--fw-semibold)',
      lineHeight: 1,
      letterSpacing: 'var(--ls-wide)',
      borderRadius: 'var(--radius-sm)',
      whiteSpace: 'nowrap',
      ...base,
      ...style
    }
  }, rest), dot && /*#__PURE__*/React.createElement("span", {
    style: {
      width: 6,
      height: 6,
      borderRadius: '50%',
      background: solid ? '#fff' : t.fg
    }
  }), children);
}
Object.assign(__ds_scope, { Badge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/display/Badge.jsx", error: String((e && e.message) || e) }); }

// components/display/Card.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Surface container. `interactive` adds hover lift; `padding` in token steps. */
function Card({
  children,
  padding = 'md',
  interactive = false,
  style,
  ...rest
}) {
  const [hover, setHover] = React.useState(false);
  const pad = {
    none: 0,
    sm: 'var(--space-4)',
    md: 'var(--space-6)',
    lg: 'var(--space-8)'
  }[padding] ?? padding;
  return /*#__PURE__*/React.createElement("div", _extends({
    onMouseEnter: () => interactive && setHover(true),
    onMouseLeave: () => interactive && setHover(false),
    style: {
      background: 'var(--surface)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 'var(--radius-lg)',
      boxShadow: hover ? 'var(--shadow-floating)' : 'var(--shadow-raised)',
      padding: pad,
      transition: 'box-shadow var(--dur-base) var(--ease-standard), transform var(--dur-base), border-color var(--dur-base)',
      transform: hover ? 'translateY(-1px)' : 'none',
      cursor: interactive ? 'pointer' : 'default',
      borderColor: hover ? 'var(--border)' : 'var(--border-subtle)',
      ...style
    }
  }, rest), children);
}
Object.assign(__ds_scope, { Card });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/display/Card.jsx", error: String((e && e.message) || e) }); }

// components/display/Icon.jsx
try { (() => {
function toPascal(name) {
  return String(name).replace(/(^|[-_ ])(\w)/g, (_, __, c) => c.toUpperCase());
}

/**
 * Renders a Lucide icon by name. Requires the Lucide UMD script on the page
 * (window.lucide). Falls back to an empty box glyph if the name is unknown or
 * Lucide hasn't loaded — never throws.
 */
function Icon({
  name,
  size = 16,
  strokeWidth = 2,
  color = 'currentColor',
  style,
  ...rest
}) {
  const lib = typeof window !== 'undefined' && window.lucide && window.lucide.icons;
  const node = lib && (lib[toPascal(name)] || lib[name]);
  // Lucide icon data comes in two shapes across versions:
  //   modern: [tag, attrs, [ [childTag, childAttrs], … ]]  (a full element)
  //   legacy: [ [childTag, childAttrs], … ]                (children only)
  const raw = Array.isArray(node) ? typeof node[0] === 'string' ? Array.isArray(node[2]) ? node[2] : [] : node : null;
  const kids = raw ? raw.map(([tag, attrs], i) => React.createElement(tag, {
    key: i,
    ...attrs
  })) : null;
  return React.createElement('svg', {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: color,
    strokeWidth,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    style: {
      display: 'inline-block',
      flexShrink: 0,
      verticalAlign: 'middle',
      ...style
    },
    'aria-hidden': true,
    ...rest
  }, kids || React.createElement('rect', {
    x: 4,
    y: 4,
    width: 16,
    height: 16,
    rx: 2,
    opacity: .25
  }));
}
Object.assign(__ds_scope, { Icon });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/display/Icon.jsx", error: String((e && e.message) || e) }); }

// components/display/Metric.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** KPI / stat block: label, big value, optional delta + trend direction. */
function Metric({
  label,
  value,
  delta,
  trend = 'flat',
  hint,
  style,
  ...rest
}) {
  const color = trend === 'up' ? 'var(--success-text)' : trend === 'down' ? 'var(--danger-text)' : 'var(--text-muted)';
  const arrow = trend === 'up' ? 'M7 17 17 7M17 7H9M17 7v8' : trend === 'down' ? 'M7 7l10 10M17 17H9M17 17V9' : 'M5 12h14';
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 'var(--text-sm)',
      color: 'var(--text-muted)',
      fontWeight: 'var(--fw-medium)'
    }
  }, label), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'baseline',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 'var(--text-3xl)',
      fontWeight: 'var(--fw-semibold)',
      color: 'var(--text-strong)',
      letterSpacing: 'var(--ls-tight)',
      fontFeatureSettings: 'var(--numeric)'
    }
  }, value), delta != null && /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 3,
      fontSize: 'var(--text-sm)',
      fontWeight: 'var(--fw-semibold)',
      color
    }
  }, /*#__PURE__*/React.createElement("svg", {
    width: "13",
    height: "13",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2.5",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, /*#__PURE__*/React.createElement("path", {
    d: arrow
  })), delta)), hint && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 'var(--text-xs)',
      color: 'var(--text-subtle)'
    }
  }, hint));
}
Object.assign(__ds_scope, { Metric });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/display/Metric.jsx", error: String((e && e.message) || e) }); }

// components/display/Tag.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Removable metadata chip (labels, filters, recipients). */
function Tag({
  children,
  onRemove,
  color,
  style,
  ...rest
}) {
  const [hover, setHover] = React.useState(false);
  return /*#__PURE__*/React.createElement("span", _extends({
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      height: 24,
      padding: onRemove ? '0 4px 0 9px' : '0 10px',
      fontSize: 'var(--text-xs)',
      fontWeight: 'var(--fw-medium)',
      color: 'var(--text)',
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-pill)',
      boxShadow: 'var(--shadow-raised)',
      whiteSpace: 'nowrap',
      ...style
    }
  }, rest), color && /*#__PURE__*/React.createElement("span", {
    style: {
      width: 7,
      height: 7,
      borderRadius: '50%',
      background: color
    }
  }), children, onRemove && /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: onRemove,
    "aria-label": "Remove",
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 16,
      height: 16,
      border: 'none',
      borderRadius: 'var(--radius-sm)',
      cursor: 'pointer',
      padding: 0,
      background: hover ? 'var(--surface-sunken)' : 'transparent',
      color: 'var(--text-subtle)'
    }
  }, /*#__PURE__*/React.createElement("svg", {
    width: "10",
    height: "10",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2.5",
    strokeLinecap: "round"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M18 6 6 18M6 6l12 12"
  }))));
}
Object.assign(__ds_scope, { Tag });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/display/Tag.jsx", error: String((e && e.message) || e) }); }

// components/feedback/Alert.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const TONES = {
  info: {
    bg: 'var(--info-bg)',
    bd: 'var(--info-border)',
    fg: 'var(--info-text)',
    icon: 'info'
  },
  success: {
    bg: 'var(--success-bg)',
    bd: 'var(--success-border)',
    fg: 'var(--success-text)',
    icon: 'check-circle-2'
  },
  warning: {
    bg: 'var(--warning-bg)',
    bd: 'var(--warning-border)',
    fg: 'var(--warning-text)',
    icon: 'alert-triangle'
  },
  danger: {
    bg: 'var(--danger-bg)',
    bd: 'var(--danger-border)',
    fg: 'var(--danger-text)',
    icon: 'alert-circle'
  }
};
const GLYPH = {
  'info': 'M12 16v-4M12 8h.01',
  'check-circle-2': 'm9 12 2 2 4-4',
  'alert-triangle': 'M12 9v4M12 17h.01',
  'alert-circle': 'M12 8v4M12 16h.01'
};

/** Inline contextual message. Persistent (unlike Toast). */
function Alert({
  tone = 'info',
  title,
  children,
  onClose,
  style,
  ...rest
}) {
  const t = TONES[tone] || TONES.info;
  const circle = tone !== 'warning';
  return /*#__PURE__*/React.createElement("div", _extends({
    role: "alert",
    style: {
      display: 'flex',
      gap: 11,
      padding: '12px 14px',
      background: t.bg,
      border: `1px solid ${t.bd}`,
      borderRadius: 'var(--radius-md)',
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement("svg", {
    width: "18",
    height: "18",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: t.fg,
    strokeWidth: "2",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    style: {
      flexShrink: 0,
      marginTop: 1
    }
  }, tone === 'warning' ? /*#__PURE__*/React.createElement("path", {
    d: "M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"
  }) : /*#__PURE__*/React.createElement("circle", {
    cx: "12",
    cy: "12",
    r: "10"
  }), /*#__PURE__*/React.createElement("path", {
    d: GLYPH[t.icon]
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, title && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 'var(--text-md)',
      fontWeight: 'var(--fw-semibold)',
      color: t.fg,
      marginBottom: children ? 3 : 0
    }
  }, title), children && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 'var(--text-sm)',
      color: 'var(--text)',
      lineHeight: 'var(--lh-normal)'
    }
  }, children)), onClose && /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: onClose,
    "aria-label": "Dismiss",
    style: {
      flexShrink: 0,
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      color: t.fg,
      padding: 2,
      opacity: .7,
      display: 'inline-flex'
    }
  }, /*#__PURE__*/React.createElement("svg", {
    width: "15",
    height: "15",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    strokeLinecap: "round"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M18 6 6 18M6 6l12 12"
  }))));
}
Object.assign(__ds_scope, { Alert });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/Alert.jsx", error: String((e && e.message) || e) }); }

// components/feedback/ProgressBar.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const TONE = {
  brand: 'var(--primary)',
  success: 'var(--success-solid)',
  warning: 'var(--warning-solid)',
  danger: 'var(--danger-solid)'
};

/** Determinate progress bar (0–100). Optional label + value readout. */
function ProgressBar({
  value = 0,
  tone = 'brand',
  label,
  showValue = false,
  size = 'md',
  style,
  ...rest
}) {
  const v = Math.max(0, Math.min(100, value));
  const h = size === 'sm' ? 4 : size === 'lg' ? 10 : 6;
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      ...style
    }
  }, rest), (label || showValue) && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      fontSize: 'var(--text-sm)'
    }
  }, label && /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--text-muted)'
    }
  }, label), showValue && /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--text-strong)',
      fontWeight: 'var(--fw-medium)',
      fontFeatureSettings: 'var(--numeric)'
    }
  }, Math.round(v), "%")), /*#__PURE__*/React.createElement("div", {
    role: "progressbar",
    "aria-valuenow": v,
    "aria-valuemin": 0,
    "aria-valuemax": 100,
    style: {
      height: h,
      background: 'var(--surface-sunken)',
      borderRadius: 'var(--radius-pill)',
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: `${v}%`,
      height: '100%',
      background: TONE[tone] || TONE.brand,
      borderRadius: 'var(--radius-pill)',
      transition: 'width var(--dur-slow) var(--ease-standard)'
    }
  })));
}
Object.assign(__ds_scope, { ProgressBar });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/ProgressBar.jsx", error: String((e && e.message) || e) }); }

// components/feedback/Skeleton.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Loading placeholder. Set width/height (or a radius) to match target content. */
function Skeleton({
  width = '100%',
  height = 14,
  radius = 'var(--radius-sm)',
  circle = false,
  style,
  ...rest
}) {
  const d = circle ? typeof height === 'number' ? height : 32 : undefined;
  return /*#__PURE__*/React.createElement("span", _extends({
    "aria-hidden": true,
    style: {
      display: 'block',
      width: circle ? d : width,
      height: circle ? d : height,
      borderRadius: circle ? '50%' : radius,
      background: 'linear-gradient(90deg, var(--surface-sunken) 0%, var(--bg-subtle) 40%, var(--surface-sunken) 80%)',
      backgroundSize: '800px 100%',
      animation: 'linki-shimmer 1.4s ease-in-out infinite',
      ...style
    }
  }, rest));
}
Object.assign(__ds_scope, { Skeleton });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/Skeleton.jsx", error: String((e && e.message) || e) }); }

// components/feedback/Spinner.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Indeterminate loading spinner. Inherits color via currentColor by default. */
function Spinner({
  size = 18,
  thickness = 2,
  color = 'var(--primary)',
  style,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("span", _extends({
    role: "status",
    "aria-label": "Loading",
    style: {
      display: 'inline-block',
      width: size,
      height: size,
      borderRadius: '50%',
      border: `${thickness}px solid color-mix(in srgb, ${color} 22%, transparent)`,
      borderTopColor: color,
      animation: 'linki-spin .6s linear infinite',
      ...style
    }
  }, rest));
}
Object.assign(__ds_scope, { Spinner });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/Spinner.jsx", error: String((e && e.message) || e) }); }

// components/feedback/Toast.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const TONES = {
  neutral: 'var(--text-strong)',
  success: 'var(--success-solid)',
  danger: 'var(--danger-solid)',
  warning: 'var(--warning-solid)',
  info: 'var(--primary)'
};
const GLYPH = {
  success: 'm9 12 2 2 4-4',
  danger: 'M12 8v4M12 16h.01',
  warning: 'M12 9v4M12 17h.01',
  info: 'M12 16v-4M12 8h.01',
  neutral: null
};

/** Transient notification card. Presentational — pair with your own queue/timer. */
function Toast({
  tone = 'neutral',
  title,
  description,
  action,
  onClose,
  style,
  ...rest
}) {
  const c = TONES[tone] || TONES.neutral;
  const g = GLYPH[tone];
  return /*#__PURE__*/React.createElement("div", _extends({
    role: "status",
    style: {
      display: 'flex',
      alignItems: 'flex-start',
      gap: 11,
      width: 360,
      maxWidth: '92vw',
      padding: '13px 14px',
      background: 'var(--surface)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 'var(--radius-lg)',
      boxShadow: 'var(--shadow-popover)',
      animation: 'linki-pop var(--dur-slow) var(--ease-emphasized)',
      ...style
    }
  }, rest), g && /*#__PURE__*/React.createElement("svg", {
    width: "18",
    height: "18",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: c,
    strokeWidth: "2",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    style: {
      flexShrink: 0,
      marginTop: 1
    }
  }, tone === 'warning' ? /*#__PURE__*/React.createElement("path", {
    d: "M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"
  }) : /*#__PURE__*/React.createElement("circle", {
    cx: "12",
    cy: "12",
    r: "10"
  }), /*#__PURE__*/React.createElement("path", {
    d: g
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, title && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 'var(--text-md)',
      fontWeight: 'var(--fw-semibold)',
      color: 'var(--text-strong)'
    }
  }, title), description && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 'var(--text-sm)',
      color: 'var(--text-muted)',
      marginTop: 2,
      lineHeight: 'var(--lh-normal)'
    }
  }, description), action && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 9
    }
  }, action)), onClose && /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: onClose,
    "aria-label": "Dismiss",
    style: {
      flexShrink: 0,
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      color: 'var(--text-subtle)',
      padding: 2,
      display: 'inline-flex'
    }
  }, /*#__PURE__*/React.createElement("svg", {
    width: "15",
    height: "15",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    strokeLinecap: "round"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M18 6 6 18M6 6l12 12"
  }))));
}
Object.assign(__ds_scope, { Toast });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/Toast.jsx", error: String((e && e.message) || e) }); }

// components/forms/Checkbox.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Checkbox with label. Controlled via `checked`; supports `indeterminate`. */
function Checkbox({
  label,
  checked = false,
  indeterminate = false,
  disabled = false,
  onChange,
  id,
  style,
  ...rest
}) {
  const uid = id || React.useId();
  const on = checked || indeterminate;
  return /*#__PURE__*/React.createElement("label", {
    htmlFor: uid,
    style: {
      display: 'inline-flex',
      alignItems: 'flex-start',
      gap: 9,
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 'var(--opacity-disabled)' : 1,
      ...style
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      position: 'relative',
      display: 'inline-flex',
      flexShrink: 0,
      marginTop: 1
    }
  }, /*#__PURE__*/React.createElement("input", _extends({
    type: "checkbox",
    id: uid,
    checked: checked,
    disabled: disabled,
    onChange: onChange,
    ref: el => {
      if (el) el.indeterminate = indeterminate;
    },
    style: {
      position: 'absolute',
      opacity: 0,
      width: 16,
      height: 16,
      margin: 0,
      cursor: 'inherit'
    }
  }, rest)), /*#__PURE__*/React.createElement("span", {
    "aria-hidden": true,
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 16,
      height: 16,
      borderRadius: 'var(--radius-sm)',
      background: on ? 'var(--primary)' : 'var(--surface)',
      border: `1px solid ${on ? 'var(--primary)' : 'var(--border-strong)'}`,
      color: '#fff',
      transition: 'background var(--dur-fast), border-color var(--dur-fast)'
    }
  }, indeterminate ? /*#__PURE__*/React.createElement("svg", {
    width: "10",
    height: "10",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "3.5",
    strokeLinecap: "round"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M5 12h14"
  })) : checked ? /*#__PURE__*/React.createElement("svg", {
    width: "11",
    height: "11",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "3.5",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M20 6 9 17l-5-5"
  })) : null)), label && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 'var(--text-md)',
      color: 'var(--text)',
      lineHeight: 1.35
    }
  }, label));
}
Object.assign(__ds_scope, { Checkbox });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Checkbox.jsx", error: String((e && e.message) || e) }); }

// components/forms/Input.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const H = {
  sm: 'var(--control-sm)',
  md: 'var(--control-md)',
  lg: 'var(--control-lg)'
};

/** Text input with label, hint, error, and optional leading/trailing adornments. */
function Input({
  label,
  hint,
  error,
  size = 'md',
  leftIcon,
  rightIcon,
  id,
  disabled,
  style,
  containerStyle,
  ...rest
}) {
  const [focus, setFocus] = React.useState(false);
  const uid = id || React.useId();
  const invalid = !!error;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      ...containerStyle
    }
  }, label && /*#__PURE__*/React.createElement("label", {
    htmlFor: uid,
    style: {
      fontSize: 'var(--text-sm)',
      fontWeight: 'var(--fw-medium)',
      color: 'var(--text-strong)'
    }
  }, label), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      height: H[size],
      padding: '0 11px',
      background: disabled ? 'var(--surface-sunken)' : 'var(--surface)',
      border: `1px solid ${invalid ? 'var(--danger-solid)' : focus ? 'var(--border-focus)' : 'var(--border)'}`,
      borderRadius: 'var(--radius-md)',
      boxShadow: focus ? invalid ? '0 0 0 3px var(--danger-bg)' : 'var(--focus-ring)' : 'none',
      transition: 'border-color var(--dur-fast), box-shadow var(--dur-fast)',
      opacity: disabled ? 'var(--opacity-disabled)' : 1
    }
  }, leftIcon && /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      color: 'var(--text-subtle)'
    }
  }, leftIcon), /*#__PURE__*/React.createElement("input", _extends({
    id: uid,
    disabled: disabled,
    "aria-invalid": invalid,
    onFocus: () => setFocus(true),
    onBlur: () => setFocus(false),
    style: {
      flex: 1,
      minWidth: 0,
      height: '100%',
      border: 'none',
      outline: 'none',
      background: 'transparent',
      fontSize: 'var(--text-md)',
      color: 'var(--text)',
      ...style
    }
  }, rest)), rightIcon && /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      color: 'var(--text-subtle)'
    }
  }, rightIcon)), (hint || error) && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 'var(--text-xs)',
      color: invalid ? 'var(--danger-text)' : 'var(--text-subtle)'
    }
  }, error || hint));
}
Object.assign(__ds_scope, { Input });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Input.jsx", error: String((e && e.message) || e) }); }

// components/forms/Radio.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Single radio option with label. Group via shared `name` + value. */
function Radio({
  label,
  checked = false,
  disabled = false,
  onChange,
  name,
  value,
  id,
  style,
  ...rest
}) {
  const uid = id || React.useId();
  return /*#__PURE__*/React.createElement("label", {
    htmlFor: uid,
    style: {
      display: 'inline-flex',
      alignItems: 'flex-start',
      gap: 9,
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 'var(--opacity-disabled)' : 1,
      ...style
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      position: 'relative',
      display: 'inline-flex',
      flexShrink: 0,
      marginTop: 1
    }
  }, /*#__PURE__*/React.createElement("input", _extends({
    type: "radio",
    id: uid,
    name: name,
    value: value,
    checked: checked,
    disabled: disabled,
    onChange: onChange,
    style: {
      position: 'absolute',
      opacity: 0,
      width: 16,
      height: 16,
      margin: 0,
      cursor: 'inherit'
    }
  }, rest)), /*#__PURE__*/React.createElement("span", {
    "aria-hidden": true,
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 16,
      height: 16,
      borderRadius: '50%',
      background: 'var(--surface)',
      border: `1px solid ${checked ? 'var(--primary)' : 'var(--border-strong)'}`,
      transition: 'border-color var(--dur-fast)'
    }
  }, checked && /*#__PURE__*/React.createElement("span", {
    style: {
      width: 7,
      height: 7,
      borderRadius: '50%',
      background: 'var(--primary)'
    }
  }))), label && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 'var(--text-md)',
      color: 'var(--text)',
      lineHeight: 1.35
    }
  }, label));
}
Object.assign(__ds_scope, { Radio });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Radio.jsx", error: String((e && e.message) || e) }); }

// components/forms/Select.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const H = {
  sm: 'var(--control-sm)',
  md: 'var(--control-md)',
  lg: 'var(--control-lg)'
};

/** Native select styled to match Input, with a custom chevron. */
function Select({
  label,
  hint,
  error,
  size = 'md',
  children,
  id,
  disabled,
  style,
  containerStyle,
  ...rest
}) {
  const [focus, setFocus] = React.useState(false);
  const uid = id || React.useId();
  const invalid = !!error;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      ...containerStyle
    }
  }, label && /*#__PURE__*/React.createElement("label", {
    htmlFor: uid,
    style: {
      fontSize: 'var(--text-sm)',
      fontWeight: 'var(--fw-medium)',
      color: 'var(--text-strong)'
    }
  }, label), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      display: 'flex'
    }
  }, /*#__PURE__*/React.createElement("select", _extends({
    id: uid,
    disabled: disabled,
    "aria-invalid": invalid,
    onFocus: () => setFocus(true),
    onBlur: () => setFocus(false),
    style: {
      appearance: 'none',
      WebkitAppearance: 'none',
      width: '100%',
      height: H[size],
      padding: '0 34px 0 11px',
      background: disabled ? 'var(--surface-sunken)' : 'var(--surface)',
      border: `1px solid ${invalid ? 'var(--danger-solid)' : focus ? 'var(--border-focus)' : 'var(--border)'}`,
      borderRadius: 'var(--radius-md)',
      fontSize: 'var(--text-md)',
      color: 'var(--text)',
      cursor: disabled ? 'not-allowed' : 'pointer',
      outline: 'none',
      boxShadow: focus ? 'var(--focus-ring)' : 'none',
      transition: 'border-color var(--dur-fast), box-shadow var(--dur-fast)',
      opacity: disabled ? 'var(--opacity-disabled)' : 1,
      ...style
    }
  }, rest), children), /*#__PURE__*/React.createElement("svg", {
    width: "16",
    height: "16",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "var(--text-subtle)",
    strokeWidth: "2",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    style: {
      position: 'absolute',
      right: 10,
      top: '50%',
      transform: 'translateY(-50%)',
      pointerEvents: 'none'
    }
  }, /*#__PURE__*/React.createElement("path", {
    d: "m6 9 6 6 6-6"
  }))), (hint || error) && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 'var(--text-xs)',
      color: invalid ? 'var(--danger-text)' : 'var(--text-subtle)'
    }
  }, error || hint));
}
Object.assign(__ds_scope, { Select });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Select.jsx", error: String((e && e.message) || e) }); }

// components/forms/Switch.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const SIZES = {
  sm: {
    w: 30,
    h: 18,
    k: 14
  },
  md: {
    w: 36,
    h: 21,
    k: 17
  }
};

/** On/off toggle for instant-apply settings (no Save needed). */
function Switch({
  label,
  checked = false,
  disabled = false,
  size = 'md',
  onChange,
  id,
  style,
  ...rest
}) {
  const uid = id || React.useId();
  const s = SIZES[size] || SIZES.md;
  return /*#__PURE__*/React.createElement("label", {
    htmlFor: uid,
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 10,
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 'var(--opacity-disabled)' : 1,
      ...style
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      position: 'relative',
      display: 'inline-flex',
      flexShrink: 0,
      width: s.w,
      height: s.h
    }
  }, /*#__PURE__*/React.createElement("input", _extends({
    type: "checkbox",
    role: "switch",
    id: uid,
    checked: checked,
    disabled: disabled,
    onChange: onChange,
    style: {
      position: 'absolute',
      opacity: 0,
      width: '100%',
      height: '100%',
      margin: 0,
      cursor: 'inherit'
    }
  }, rest)), /*#__PURE__*/React.createElement("span", {
    "aria-hidden": true,
    style: {
      width: '100%',
      height: '100%',
      borderRadius: 'var(--radius-pill)',
      background: checked ? 'var(--primary)' : 'var(--slate-300)',
      transition: 'background var(--dur-base) var(--ease-standard)'
    }
  }), /*#__PURE__*/React.createElement("span", {
    "aria-hidden": true,
    style: {
      position: 'absolute',
      top: (s.h - s.k) / 2,
      left: checked ? s.w - s.k - (s.h - s.k) / 2 : (s.h - s.k) / 2,
      width: s.k,
      height: s.k,
      borderRadius: '50%',
      background: '#fff',
      boxShadow: '0 1px 2px rgba(16,24,40,.3)',
      transition: 'left var(--dur-base) var(--ease-standard)'
    }
  })), label && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 'var(--text-md)',
      color: 'var(--text)'
    }
  }, label));
}
Object.assign(__ds_scope, { Switch });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Switch.jsx", error: String((e && e.message) || e) }); }

// components/forms/Textarea.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Multi-line text input with label / hint / error. */
function Textarea({
  label,
  hint,
  error,
  rows = 4,
  id,
  disabled,
  style,
  containerStyle,
  ...rest
}) {
  const [focus, setFocus] = React.useState(false);
  const uid = id || React.useId();
  const invalid = !!error;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      ...containerStyle
    }
  }, label && /*#__PURE__*/React.createElement("label", {
    htmlFor: uid,
    style: {
      fontSize: 'var(--text-sm)',
      fontWeight: 'var(--fw-medium)',
      color: 'var(--text-strong)'
    }
  }, label), /*#__PURE__*/React.createElement("textarea", _extends({
    id: uid,
    rows: rows,
    disabled: disabled,
    "aria-invalid": invalid,
    onFocus: () => setFocus(true),
    onBlur: () => setFocus(false),
    style: {
      padding: '9px 11px',
      background: disabled ? 'var(--surface-sunken)' : 'var(--surface)',
      border: `1px solid ${invalid ? 'var(--danger-solid)' : focus ? 'var(--border-focus)' : 'var(--border)'}`,
      borderRadius: 'var(--radius-md)',
      fontSize: 'var(--text-md)',
      color: 'var(--text)',
      fontFamily: 'var(--font-sans)',
      lineHeight: 'var(--lh-normal)',
      resize: 'vertical',
      outline: 'none',
      boxShadow: focus ? 'var(--focus-ring)' : 'none',
      transition: 'border-color var(--dur-fast), box-shadow var(--dur-fast)',
      opacity: disabled ? 'var(--opacity-disabled)' : 1,
      ...style
    }
  }, rest)), (hint || error) && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 'var(--text-xs)',
      color: invalid ? 'var(--danger-text)' : 'var(--text-subtle)'
    }
  }, error || hint));
}
Object.assign(__ds_scope, { Textarea });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Textarea.jsx", error: String((e && e.message) || e) }); }

// components/navigation/Breadcrumbs.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Breadcrumb trail. `items`: [{ label, href? }]. Last item is current (bold). */
function Breadcrumbs({
  items = [],
  style,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("nav", _extends({
    "aria-label": "Breadcrumb",
    style: {
      display: 'flex',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: 6,
      fontSize: 'var(--text-sm)',
      ...style
    }
  }, rest), items.map((it, i) => {
    const last = i === items.length - 1;
    return /*#__PURE__*/React.createElement(React.Fragment, {
      key: i
    }, last ? /*#__PURE__*/React.createElement("span", {
      "aria-current": "page",
      style: {
        color: 'var(--text-strong)',
        fontWeight: 'var(--fw-medium)'
      }
    }, it.label) : /*#__PURE__*/React.createElement("a", {
      href: it.href || '#',
      style: {
        color: 'var(--text-muted)',
        textDecoration: 'none'
      }
    }, it.label), !last && /*#__PURE__*/React.createElement("svg", {
      width: "14",
      height: "14",
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "var(--text-disabled)",
      strokeWidth: "2",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }, /*#__PURE__*/React.createElement("path", {
      d: "m9 18 6-6-6-6"
    })));
  }));
}
Object.assign(__ds_scope, { Breadcrumbs });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/navigation/Breadcrumbs.jsx", error: String((e && e.message) || e) }); }

// components/navigation/Menu.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Dropdown menu. `trigger` is any node; `items`: [{ label, icon?, onSelect?,
 * tone?: 'danger', divider?: true, shortcut? }]. Closes on select / outside click / Esc.
 */
function Menu({
  trigger,
  items = [],
  align = 'start',
  style,
  ...rest
}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef(null);
  React.useEffect(() => {
    if (!open) return;
    const onDoc = e => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKey = e => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return /*#__PURE__*/React.createElement("div", _extends({
    ref: ref,
    style: {
      position: 'relative',
      display: 'inline-flex',
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement("span", {
    onClick: () => setOpen(o => !o),
    style: {
      display: 'inline-flex',
      cursor: 'pointer'
    }
  }, trigger), open && /*#__PURE__*/React.createElement("div", {
    role: "menu",
    style: {
      position: 'absolute',
      top: 'calc(100% + 6px)',
      [align === 'end' ? 'right' : 'left']: 0,
      zIndex: 'var(--z-dropdown)',
      minWidth: 200,
      padding: 5,
      background: 'var(--surface)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 'var(--radius-lg)',
      boxShadow: 'var(--shadow-popover)',
      animation: 'linki-pop var(--dur-fast) var(--ease-emphasized)'
    }
  }, items.map((it, i) => it.divider ? /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      height: 1,
      background: 'var(--border-subtle)',
      margin: '5px 0'
    }
  }) : /*#__PURE__*/React.createElement(MenuItem, {
    key: i,
    item: it,
    onClose: () => setOpen(false)
  }))));
}
function MenuItem({
  item,
  onClose
}) {
  const [hover, setHover] = React.useState(false);
  const danger = item.tone === 'danger';
  return /*#__PURE__*/React.createElement("button", {
    role: "menuitem",
    type: "button",
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    onClick: () => {
      item.onSelect?.();
      onClose();
    },
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 9,
      width: '100%',
      height: 32,
      padding: '0 9px',
      border: 'none',
      borderRadius: 'var(--radius-sm)',
      cursor: 'pointer',
      textAlign: 'left',
      fontSize: 'var(--text-md)',
      color: danger ? 'var(--danger-text)' : 'var(--text)',
      background: hover ? danger ? 'var(--danger-bg)' : 'var(--surface-sunken)' : 'transparent'
    }
  }, item.icon && /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      color: danger ? 'var(--danger-text)' : 'var(--text-muted)'
    }
  }, item.icon), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1
    }
  }, item.label), item.shortcut && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 'var(--text-xs)',
      color: 'var(--text-subtle)',
      fontFamily: 'var(--font-mono)'
    }
  }, item.shortcut));
}
Object.assign(__ds_scope, { Menu });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/navigation/Menu.jsx", error: String((e && e.message) || e) }); }

// components/navigation/Tabs.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Tab bar. Underline (default) or pill style. Controlled via value/onChange,
 * or uncontrolled with defaultValue. `items`: [{ value, label, icon?, count? }].
 */
function Tabs({
  items = [],
  value,
  defaultValue,
  onChange,
  variant = 'underline',
  style,
  ...rest
}) {
  const [internal, setInternal] = React.useState(defaultValue ?? items[0]?.value);
  const active = value !== undefined ? value : internal;
  const set = v => {
    if (value === undefined) setInternal(v);
    onChange?.(v);
  };
  const pill = variant === 'pill';
  return /*#__PURE__*/React.createElement("div", _extends({
    role: "tablist",
    style: {
      display: 'inline-flex',
      gap: pill ? 3 : 4,
      alignItems: 'center',
      padding: pill ? 3 : 0,
      background: pill ? 'var(--surface-sunken)' : 'transparent',
      borderRadius: pill ? 'var(--radius-md)' : 0,
      borderBottom: pill ? 'none' : '1px solid var(--border-subtle)',
      ...style
    }
  }, rest), items.map(it => {
    const on = it.value === active;
    return /*#__PURE__*/React.createElement("button", {
      key: it.value,
      role: "tab",
      "aria-selected": on,
      onClick: () => set(it.value),
      style: {
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: pill ? 28 : 36,
        padding: pill ? '0 12px' : '0 4px',
        margin: pill ? 0 : '0 8px',
        marginBottom: pill ? 0 : -1,
        border: 'none',
        background: pill && on ? 'var(--surface)' : 'transparent',
        borderRadius: pill ? 'var(--radius-sm)' : 0,
        cursor: 'pointer',
        fontSize: 'var(--text-md)',
        fontWeight: 'var(--fw-medium)',
        color: on ? 'var(--text-strong)' : 'var(--text-muted)',
        boxShadow: pill && on ? 'var(--shadow-raised)' : 'none',
        borderBottom: pill ? 'none' : `2px solid ${on ? 'var(--primary)' : 'transparent'}`,
        transition: 'color var(--dur-fast), background var(--dur-fast)'
      }
    }, it.icon, it.label, it.count != null && /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 'var(--text-xs)',
        fontWeight: 'var(--fw-semibold)',
        color: on ? 'var(--primary-text)' : 'var(--text-subtle)',
        background: on ? 'var(--primary-subtle)' : 'var(--surface-sunken)',
        borderRadius: 'var(--radius-pill)',
        padding: '1px 6px',
        fontFeatureSettings: 'var(--numeric)'
      }
    }, it.count));
  }));
}
Object.assign(__ds_scope, { Tabs });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/navigation/Tabs.jsx", error: String((e && e.message) || e) }); }

// components/overlays/Dialog.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Centered modal dialog with scrim. Controlled via `open` + `onClose`. */
function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  style,
  ...rest
}) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = e => {
      if (e.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  const maxW = {
    sm: 400,
    md: 520,
    lg: 680
  }[size] || 520;
  return /*#__PURE__*/React.createElement("div", {
    role: "dialog",
    "aria-modal": "true",
    onMouseDown: onClose,
    style: {
      position: 'fixed',
      inset: 0,
      zIndex: 'var(--z-modal)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 'var(--space-6)',
      background: 'var(--scrim)',
      backdropFilter: 'blur(2px)',
      animation: 'linki-pop var(--dur-fast) var(--ease-standard)'
    }
  }, /*#__PURE__*/React.createElement("div", _extends({
    onMouseDown: e => e.stopPropagation(),
    style: {
      width: '100%',
      maxWidth: maxW,
      maxHeight: '90vh',
      overflow: 'auto',
      background: 'var(--surface)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 'var(--radius-xl)',
      boxShadow: 'var(--shadow-modal)',
      animation: 'linki-pop var(--dur-slow) var(--ease-emphasized)',
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'flex-start',
      gap: 12,
      padding: '20px 22px 0'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, title && /*#__PURE__*/React.createElement("h2", {
    style: {
      fontSize: 'var(--text-xl)',
      fontWeight: 'var(--fw-semibold)',
      color: 'var(--text-strong)',
      letterSpacing: 'var(--ls-tight)'
    }
  }, title), description && /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 'var(--text-sm)',
      color: 'var(--text-muted)',
      marginTop: 5,
      lineHeight: 'var(--lh-normal)'
    }
  }, description)), onClose && /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: onClose,
    "aria-label": "Close",
    style: {
      flexShrink: 0,
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      color: 'var(--text-subtle)',
      padding: 4,
      marginTop: -2,
      display: 'inline-flex'
    }
  }, /*#__PURE__*/React.createElement("svg", {
    width: "18",
    height: "18",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    strokeLinecap: "round"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M18 6 6 18M6 6l12 12"
  })))), children && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '16px 22px',
      fontSize: 'var(--text-md)',
      color: 'var(--text)',
      lineHeight: 'var(--lh-normal)'
    }
  }, children), footer && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'flex-end',
      gap: 10,
      padding: '14px 22px 20px',
      borderTop: children ? '1px solid var(--border-subtle)' : 'none',
      marginTop: children ? 0 : 8
    }
  }, footer)));
}
Object.assign(__ds_scope, { Dialog });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/overlays/Dialog.jsx", error: String((e && e.message) || e) }); }

// components/overlays/Tooltip.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Hover/focus tooltip. Wraps a single child; positions on `side`. */
function Tooltip({
  label,
  children,
  side = 'top',
  style,
  ...rest
}) {
  const [show, setShow] = React.useState(false);
  const pos = {
    top: {
      bottom: '100%',
      left: '50%',
      transform: 'translateX(-50%)',
      marginBottom: 7
    },
    bottom: {
      top: '100%',
      left: '50%',
      transform: 'translateX(-50%)',
      marginTop: 7
    },
    left: {
      right: '100%',
      top: '50%',
      transform: 'translateY(-50%)',
      marginRight: 7
    },
    right: {
      left: '100%',
      top: '50%',
      transform: 'translateY(-50%)',
      marginLeft: 7
    }
  }[side];
  return /*#__PURE__*/React.createElement("span", _extends({
    style: {
      position: 'relative',
      display: 'inline-flex'
    },
    onMouseEnter: () => setShow(true),
    onMouseLeave: () => setShow(false),
    onFocus: () => setShow(true),
    onBlur: () => setShow(false)
  }, rest), children, show && label && /*#__PURE__*/React.createElement("span", {
    role: "tooltip",
    style: {
      position: 'absolute',
      zIndex: 'var(--z-tooltip)',
      whiteSpace: 'nowrap',
      pointerEvents: 'none',
      padding: '5px 9px',
      background: 'var(--surface-inverse)',
      color: 'var(--text-inverse)',
      fontSize: 'var(--text-xs)',
      fontWeight: 'var(--fw-medium)',
      borderRadius: 'var(--radius-sm)',
      boxShadow: 'var(--shadow-popover)',
      animation: 'linki-pop var(--dur-fast) var(--ease-standard)',
      ...pos,
      ...style
    }
  }, label));
}
Object.assign(__ds_scope, { Tooltip });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/overlays/Tooltip.jsx", error: String((e && e.message) || e) }); }

// ui_kits/linki-app/Contacts.jsx
try { (() => {
/* IIFE-wrapped */
(function () {
  // Contacts screen — CRM data table with selection, stage, owner, enrichment.
  const {
    Card,
    Badge,
    Icon,
    Avatar,
    Button,
    Checkbox,
    Input,
    Menu,
    IconButton,
    Select,
    Tag
  } = window.LinkiDesignSystem_8f2af2;
  function Contacts() {
    const D = window.LinkiData;
    const [sel, setSel] = React.useState({});
    const allChecked = D.contacts.every(c => sel[c.email]);
    const someChecked = D.contacts.some(c => sel[c.email]);
    const toggleAll = () => {
      const n = {};
      if (!allChecked) D.contacts.forEach(c => n[c.email] = true);
      setSel(n);
    };
    const count = Object.values(sel).filter(Boolean).length;
    const th = {
      padding: '10px 16px',
      textAlign: 'left',
      fontSize: 'var(--text-xs)',
      fontWeight: 'var(--fw-semibold)',
      color: 'var(--text-subtle)',
      textTransform: 'uppercase',
      letterSpacing: '.04em',
      whiteSpace: 'nowrap',
      background: 'var(--bg-subtle)'
    };
    const td = {
      padding: '11px 16px',
      fontSize: 'var(--text-md)',
      color: 'var(--text)',
      whiteSpace: 'nowrap'
    };
    return /*#__PURE__*/React.createElement("div", {
      style: {
        maxWidth: 'var(--container-max)',
        margin: '0 auto',
        padding: '24px 28px 40px'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        marginBottom: 18
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1
      }
    }, /*#__PURE__*/React.createElement("h1", {
      style: {
        fontSize: 'var(--text-3xl)',
        fontWeight: 'var(--fw-semibold)',
        color: 'var(--text-strong)',
        letterSpacing: '-.01em'
      }
    }, "Contacts"), /*#__PURE__*/React.createElement("p", {
      style: {
        fontSize: 'var(--text-md)',
        color: 'var(--text-muted)',
        marginTop: 4
      }
    }, D.contacts.length, " people across 6 companies.")), /*#__PURE__*/React.createElement(Button, {
      variant: "secondary",
      leftIcon: /*#__PURE__*/React.createElement(Icon, {
        name: "filter",
        size: 15
      })
    }, "Filter"), /*#__PURE__*/React.createElement(Button, {
      variant: "primary",
      leftIcon: /*#__PURE__*/React.createElement(Icon, {
        name: "user-plus",
        size: 15
      })
    }, "Add contact")), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        marginBottom: 14
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        width: 280
      }
    }, /*#__PURE__*/React.createElement(Input, {
      size: "sm",
      placeholder: "Search name, company, email\u2026",
      leftIcon: /*#__PURE__*/React.createElement(Icon, {
        name: "search",
        size: 15
      })
    })), /*#__PURE__*/React.createElement(Select, {
      size: "sm",
      defaultValue: "All stages",
      containerStyle: {
        width: 150
      }
    }, /*#__PURE__*/React.createElement("option", null, "All stages"), /*#__PURE__*/React.createElement("option", null, "Lead"), /*#__PURE__*/React.createElement("option", null, "Qualified"), /*#__PURE__*/React.createElement("option", null, "Proposal")), /*#__PURE__*/React.createElement(Tag, {
      color: "var(--viz-1)",
      onRemove: () => {}
    }, "Owner: Dana"), count > 0 && /*#__PURE__*/React.createElement("div", {
      style: {
        marginLeft: 'auto',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '5px 6px 5px 12px',
        background: 'var(--primary-subtle)',
        border: '1px solid var(--primary-border)',
        borderRadius: 'var(--radius-md)'
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 'var(--text-sm)',
        fontWeight: 'var(--fw-medium)',
        color: 'var(--primary-text)'
      }
    }, count, " selected"), /*#__PURE__*/React.createElement(Button, {
      size: "sm",
      variant: "primary",
      leftIcon: /*#__PURE__*/React.createElement(Icon, {
        name: "git-branch",
        size: 14
      })
    }, "Enroll"))), /*#__PURE__*/React.createElement(Card, {
      padding: "none",
      style: {
        overflow: 'hidden'
      }
    }, /*#__PURE__*/React.createElement("table", {
      style: {
        width: '100%',
        borderCollapse: 'collapse'
      }
    }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
      style: {
        ...th,
        width: 44,
        paddingRight: 0
      }
    }, /*#__PURE__*/React.createElement(Checkbox, {
      checked: allChecked,
      indeterminate: someChecked && !allChecked,
      onChange: toggleAll
    })), /*#__PURE__*/React.createElement("th", {
      style: th
    }, "Name"), /*#__PURE__*/React.createElement("th", {
      style: th
    }, "Company"), /*#__PURE__*/React.createElement("th", {
      style: th
    }, "Stage"), /*#__PURE__*/React.createElement("th", {
      style: th
    }, "Owner"), /*#__PURE__*/React.createElement("th", {
      style: th
    }, "Last activity"), /*#__PURE__*/React.createElement("th", {
      style: {
        ...th,
        textAlign: 'right'
      }
    }))), /*#__PURE__*/React.createElement("tbody", null, D.contacts.map(c => {
      const on = !!sel[c.email];
      return /*#__PURE__*/React.createElement("tr", {
        key: c.email,
        style: {
          borderTop: '1px solid var(--border-subtle)',
          background: on ? 'var(--primary-subtle)' : 'transparent'
        }
      }, /*#__PURE__*/React.createElement("td", {
        style: {
          ...td,
          paddingRight: 0
        }
      }, /*#__PURE__*/React.createElement(Checkbox, {
        checked: on,
        onChange: () => setSel({
          ...sel,
          [c.email]: !on
        })
      })), /*#__PURE__*/React.createElement("td", {
        style: td
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 10
        }
      }, /*#__PURE__*/React.createElement(Avatar, {
        name: c.name,
        size: "sm",
        status: c.health
      }), /*#__PURE__*/React.createElement("div", {
        style: {
          display: 'flex',
          flexDirection: 'column'
        }
      }, /*#__PURE__*/React.createElement("span", {
        style: {
          fontWeight: 'var(--fw-medium)',
          color: 'var(--text-strong)'
        }
      }, c.name), /*#__PURE__*/React.createElement("span", {
        style: {
          fontSize: 'var(--text-xs)',
          color: 'var(--text-subtle)'
        }
      }, c.title, " \xB7 ", c.email)))), /*#__PURE__*/React.createElement("td", {
        style: {
          ...td,
          color: 'var(--text-muted)'
        }
      }, c.company), /*#__PURE__*/React.createElement("td", {
        style: td
      }, /*#__PURE__*/React.createElement(Badge, {
        tone: D.stageTone[c.stage]
      }, c.stage)), /*#__PURE__*/React.createElement("td", {
        style: td
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 7
        }
      }, /*#__PURE__*/React.createElement(Avatar, {
        name: c.owner,
        size: "xs"
      }), /*#__PURE__*/React.createElement("span", {
        style: {
          fontSize: 'var(--text-sm)',
          color: 'var(--text-muted)'
        }
      }, c.owner.split(' ')[0]))), /*#__PURE__*/React.createElement("td", {
        style: {
          ...td,
          color: 'var(--text-subtle)',
          fontSize: 'var(--text-sm)'
        }
      }, c.last), /*#__PURE__*/React.createElement("td", {
        style: {
          ...td,
          textAlign: 'right',
          paddingLeft: 0
        }
      }, /*#__PURE__*/React.createElement(Menu, {
        align: "right",
        trigger: /*#__PURE__*/React.createElement(IconButton, {
          variant: "ghost",
          size: "sm",
          icon: /*#__PURE__*/React.createElement(Icon, {
            name: "more-horizontal",
            size: 16
          }),
          label: "Contact actions"
        }),
        items: [{
          label: 'View profile',
          icon: /*#__PURE__*/React.createElement(Icon, {
            name: "user",
            size: 15
          })
        }, {
          label: 'Send email',
          icon: /*#__PURE__*/React.createElement(Icon, {
            name: "mail",
            size: 15
          })
        }, {
          label: 'Enroll in sequence',
          icon: /*#__PURE__*/React.createElement(Icon, {
            name: "git-branch",
            size: 15
          })
        }, {
          divider: true
        }, {
          label: 'Remove',
          icon: /*#__PURE__*/React.createElement(Icon, {
            name: "trash-2",
            size: 15
          }),
          tone: 'danger'
        }]
      })));
    }))), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'center',
        padding: '12px 16px',
        borderTop: '1px solid var(--border-subtle)'
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 'var(--text-sm)',
        color: 'var(--text-subtle)'
      }
    }, "Showing ", D.contacts.length, " of 1,204"), /*#__PURE__*/React.createElement("div", {
      style: {
        marginLeft: 'auto',
        display: 'flex',
        gap: 8
      }
    }, /*#__PURE__*/React.createElement(Button, {
      variant: "secondary",
      size: "sm",
      disabled: true,
      leftIcon: /*#__PURE__*/React.createElement(Icon, {
        name: "chevron-left",
        size: 15
      })
    }, "Prev"), /*#__PURE__*/React.createElement(Button, {
      variant: "secondary",
      size: "sm",
      rightIcon: /*#__PURE__*/React.createElement(Icon, {
        name: "chevron-right",
        size: 15
      })
    }, "Next")))));
  }
  Object.assign(window, {
    Contacts
  });
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/linki-app/Contacts.jsx", error: String((e && e.message) || e) }); }

// ui_kits/linki-app/Dashboard.jsx
try { (() => {
/* IIFE-wrapped */
(function () {
  // Dashboard screen — metrics, sending progress, activity, sequence table.
  const {
    Card,
    Metric,
    Badge,
    Icon,
    Avatar,
    ProgressBar,
    Button,
    Tabs,
    Menu,
    IconButton
  } = window.LinkiDesignSystem_8f2af2;
  function SectionTitle({
    children,
    action
  }) {
    return /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'center',
        marginBottom: 14
      }
    }, /*#__PURE__*/React.createElement("h2", {
      style: {
        fontSize: 'var(--text-lg)',
        fontWeight: 'var(--fw-semibold)',
        color: 'var(--text-strong)',
        letterSpacing: '-.01em'
      }
    }, children), action && /*#__PURE__*/React.createElement("div", {
      style: {
        marginLeft: 'auto'
      }
    }, action));
  }

  // Tiny inline sparkline-ish bar chart, tokens only.
  function MiniBars({
    data,
    color
  }) {
    const max = Math.max(...data);
    return /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'flex-end',
        gap: 4,
        height: 48
      }
    }, data.map((v, i) => /*#__PURE__*/React.createElement("div", {
      key: i,
      style: {
        flex: 1,
        height: `${v / max * 100}%`,
        background: color,
        borderRadius: '3px 3px 0 0',
        opacity: 0.35 + 0.65 * (v / max)
      }
    })));
  }
  function ActivityRow({
    item
  }) {
    const D = window.LinkiData;
    const toneColor = {
      accent: 'var(--accent-text)',
      brand: 'var(--primary-text)',
      warning: 'var(--warning-text)',
      muted: 'var(--text-subtle)'
    }[item.tone];
    const toneBg = {
      accent: 'var(--accent-subtle)',
      brand: 'var(--primary-subtle)',
      warning: 'var(--warning-bg)',
      muted: 'var(--surface-sunken)'
    }[item.tone];
    return /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 11,
        padding: '10px 0',
        borderBottom: '1px solid var(--border-subtle)'
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        width: 28,
        height: 28,
        flexShrink: 0,
        borderRadius: 'var(--radius-md)',
        background: toneBg,
        color: toneColor,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center'
      }
    }, /*#__PURE__*/React.createElement(Icon, {
      name: item.icon,
      size: 15
    })), /*#__PURE__*/React.createElement("span", {
      style: {
        flex: 1,
        fontSize: 'var(--text-sm)',
        color: 'var(--text)'
      }
    }, item.text), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 'var(--text-xs)',
        color: 'var(--text-subtle)',
        fontFeatureSettings: 'var(--numeric)'
      }
    }, item.time));
  }
  function SeqRow({
    s
  }) {
    const D = window.LinkiData;
    return /*#__PURE__*/React.createElement("tr", {
      style: {
        borderTop: '1px solid var(--border-subtle)'
      }
    }, /*#__PURE__*/React.createElement("td", {
      style: {
        padding: '12px 16px'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        flexDirection: 'column',
        gap: 3
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 'var(--text-md)',
        fontWeight: 'var(--fw-medium)',
        color: 'var(--text-strong)'
      }
    }, s.name), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 'var(--text-xs)',
        color: 'var(--text-subtle)',
        fontFamily: 'var(--font-mono)'
      }
    }, s.id, " \xB7 ", s.steps, " steps"))), /*#__PURE__*/React.createElement("td", {
      style: {
        padding: '12px 16px'
      }
    }, /*#__PURE__*/React.createElement(Badge, {
      tone: D.statusTone[s.status],
      dot: true
    }, s.status)), /*#__PURE__*/React.createElement("td", {
      style: {
        padding: '12px 16px',
        textAlign: 'right',
        fontFeatureSettings: 'var(--numeric)',
        color: 'var(--text)'
      }
    }, s.enrolled.toLocaleString()), /*#__PURE__*/React.createElement("td", {
      style: {
        padding: '12px 16px',
        textAlign: 'right',
        fontFeatureSettings: 'var(--numeric)',
        color: 'var(--text)'
      }
    }, s.open ? s.open.toFixed(1) + '%' : '—'), /*#__PURE__*/React.createElement("td", {
      style: {
        padding: '12px 16px',
        textAlign: 'right',
        fontFeatureSettings: 'var(--numeric)',
        fontWeight: 'var(--fw-semibold)',
        color: s.reply > 20 ? 'var(--success-text)' : 'var(--text)'
      }
    }, s.reply ? s.reply.toFixed(1) + '%' : '—'), /*#__PURE__*/React.createElement("td", {
      style: {
        padding: '12px 16px'
      }
    }, /*#__PURE__*/React.createElement(Avatar, {
      name: s.owner,
      size: "sm"
    })), /*#__PURE__*/React.createElement("td", {
      style: {
        padding: '12px 8px',
        textAlign: 'right'
      }
    }, /*#__PURE__*/React.createElement(Menu, {
      trigger: /*#__PURE__*/React.createElement(IconButton, {
        variant: "ghost",
        size: "sm",
        icon: /*#__PURE__*/React.createElement(Icon, {
          name: "more-horizontal",
          size: 16
        }),
        label: "Row actions"
      }),
      items: [{
        label: 'Open',
        icon: /*#__PURE__*/React.createElement(Icon, {
          name: "arrow-up-right",
          size: 15
        })
      }, {
        label: 'Duplicate',
        icon: /*#__PURE__*/React.createElement(Icon, {
          name: "copy",
          size: 15
        })
      }, {
        label: 'Pause',
        icon: /*#__PURE__*/React.createElement(Icon, {
          name: "pause",
          size: 15
        })
      }, {
        divider: true
      }, {
        label: 'Delete',
        icon: /*#__PURE__*/React.createElement(Icon, {
          name: "trash-2",
          size: 15
        }),
        tone: 'danger'
      }]
    })));
  }
  function Dashboard() {
    const D = window.LinkiData;
    const th = {
      padding: '10px 16px',
      textAlign: 'left',
      fontSize: 'var(--text-xs)',
      fontWeight: 'var(--fw-semibold)',
      color: 'var(--text-subtle)',
      textTransform: 'uppercase',
      letterSpacing: '.04em',
      whiteSpace: 'nowrap'
    };
    return /*#__PURE__*/React.createElement("div", {
      style: {
        maxWidth: 'var(--container-max)',
        margin: '0 auto',
        padding: '24px 28px 40px'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: 16,
        marginBottom: 24
      }
    }, /*#__PURE__*/React.createElement(Card, null, /*#__PURE__*/React.createElement(Metric, {
      label: "Emails sent",
      value: "12,480",
      delta: "+8.2%",
      trend: "up",
      hint: "last 30 days"
    })), /*#__PURE__*/React.createElement(Card, null, /*#__PURE__*/React.createElement(Metric, {
      label: "Open rate",
      value: "61.2%",
      delta: "+2.4%",
      trend: "up"
    })), /*#__PURE__*/React.createElement(Card, null, /*#__PURE__*/React.createElement(Metric, {
      label: "Reply rate",
      value: "24.6%",
      delta: "+3.1%",
      trend: "up"
    })), /*#__PURE__*/React.createElement(Card, null, /*#__PURE__*/React.createElement(Metric, {
      label: "Meetings booked",
      value: "38",
      delta: "-4",
      trend: "down"
    }))), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'grid',
        gridTemplateColumns: '1.6fr 1fr',
        gap: 16,
        marginBottom: 24
      }
    }, /*#__PURE__*/React.createElement(Card, null, /*#__PURE__*/React.createElement(SectionTitle, {
      action: /*#__PURE__*/React.createElement(Tabs, {
        variant: "pill",
        defaultValue: "30",
        items: [{
          value: '7',
          label: '7d'
        }, {
          value: '30',
          label: '30d'
        }, {
          value: '90',
          label: '90d'
        }]
      })
    }, "Sending volume"), /*#__PURE__*/React.createElement(MiniBars, {
      data: [42, 55, 48, 70, 63, 88, 72, 95, 81, 110, 98, 124, 118, 132],
      color: "var(--cobalt-500)"
    }), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        gap: 24,
        marginTop: 16,
        paddingTop: 16,
        borderTop: '1px solid var(--border-subtle)'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        fontSize: 'var(--text-sm)',
        color: 'var(--text-muted)'
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        width: 9,
        height: 9,
        borderRadius: 2,
        background: 'var(--cobalt-500)'
      }
    }), "Delivered ", /*#__PURE__*/React.createElement("b", {
      style: {
        color: 'var(--text-strong)',
        marginLeft: 4
      }
    }, "11,904")), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        fontSize: 'var(--text-sm)',
        color: 'var(--text-muted)'
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        width: 9,
        height: 9,
        borderRadius: 2,
        background: 'var(--teal-500)'
      }
    }), "Opened ", /*#__PURE__*/React.createElement("b", {
      style: {
        color: 'var(--text-strong)',
        marginLeft: 4
      }
    }, "7,285")), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        fontSize: 'var(--text-sm)',
        color: 'var(--text-muted)'
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        width: 9,
        height: 9,
        borderRadius: 2,
        background: 'var(--slate-300)'
      }
    }), "Bounced ", /*#__PURE__*/React.createElement("b", {
      style: {
        color: 'var(--text-strong)',
        marginLeft: 4
      }
    }, "576")))), /*#__PURE__*/React.createElement(Card, null, /*#__PURE__*/React.createElement(SectionTitle, null, "Today\u2019s sending"), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        flexDirection: 'column',
        gap: 16
      }
    }, /*#__PURE__*/React.createElement(ProgressBar, {
      label: "Daily send limit",
      value: 68,
      showValue: true
    }), /*#__PURE__*/React.createElement(ProgressBar, {
      label: "Warmup progress",
      value: 92,
      showValue: true
    }), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: 12,
        background: 'var(--warning-bg)',
        border: '1px solid var(--warning-border)',
        borderRadius: 'var(--radius-md)'
      }
    }, /*#__PURE__*/React.createElement(Icon, {
      name: "alert-triangle",
      size: 16,
      style: {
        color: 'var(--warning-text)',
        flexShrink: 0
      }
    }), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 'var(--text-sm)',
        color: 'var(--warning-text)'
      }
    }, "1 domain needs verification before sending."))))), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'grid',
        gridTemplateColumns: '1.6fr 1fr',
        gap: 16
      }
    }, /*#__PURE__*/React.createElement(Card, {
      padding: "none",
      style: {
        overflow: 'hidden'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        padding: '16px 16px 12px'
      }
    }, /*#__PURE__*/React.createElement(SectionTitle, {
      action: /*#__PURE__*/React.createElement(Button, {
        variant: "ghost",
        size: "sm",
        rightIcon: /*#__PURE__*/React.createElement(Icon, {
          name: "arrow-right",
          size: 15
        })
      }, "All sequences")
    }, "Active sequences")), /*#__PURE__*/React.createElement("table", {
      style: {
        width: '100%',
        borderCollapse: 'collapse'
      }
    }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
      style: th
    }, "Sequence"), /*#__PURE__*/React.createElement("th", {
      style: th
    }, "Status"), /*#__PURE__*/React.createElement("th", {
      style: {
        ...th,
        textAlign: 'right'
      }
    }, "Enrolled"), /*#__PURE__*/React.createElement("th", {
      style: {
        ...th,
        textAlign: 'right'
      }
    }, "Open"), /*#__PURE__*/React.createElement("th", {
      style: {
        ...th,
        textAlign: 'right'
      }
    }, "Reply"), /*#__PURE__*/React.createElement("th", {
      style: th
    }, "Owner"), /*#__PURE__*/React.createElement("th", {
      style: th
    }))), /*#__PURE__*/React.createElement("tbody", null, D.sequences.filter(s => s.status === 'active').map(s => /*#__PURE__*/React.createElement(SeqRow, {
      key: s.id,
      s: s
    }))))), /*#__PURE__*/React.createElement(Card, null, /*#__PURE__*/React.createElement(SectionTitle, null, "Live activity"), /*#__PURE__*/React.createElement("div", null, D.activity.map((a, i) => /*#__PURE__*/React.createElement(ActivityRow, {
      key: i,
      item: a
    }))))));
  }
  Object.assign(window, {
    Dashboard
  });
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/linki-app/Dashboard.jsx", error: String((e && e.message) || e) }); }

// ui_kits/linki-app/Sequences.jsx
try { (() => {
/* IIFE-wrapped */
(function () {
  // Sequences screen — list with filters, tabs, per-step preview, row menus.
  const {
    Card,
    Badge,
    Icon,
    Avatar,
    Button,
    Tabs,
    Input,
    Menu,
    IconButton,
    Tag,
    ProgressBar
  } = window.LinkiDesignSystem_8f2af2;
  function StepPips({
    steps,
    kinds
  }) {
    const glyph = {
      email: 'mail',
      wait: 'clock',
      call: 'phone',
      li: 'linkedin'
    };
    return /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 4
      }
    }, kinds.slice(0, steps).map((k, i) => /*#__PURE__*/React.createElement("span", {
      key: i,
      style: {
        width: 22,
        height: 22,
        borderRadius: 'var(--radius-sm)',
        background: 'var(--surface-sunken)',
        border: '1px solid var(--border-subtle)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--text-muted)'
      }
    }, /*#__PURE__*/React.createElement(Icon, {
      name: glyph[k] || 'circle',
      size: 12
    }))));
  }
  function SequenceCard({
    s
  }) {
    const D = window.LinkiData;
    const kinds = ['email', 'wait', 'email', 'call', 'li', 'wait', 'email'];
    return /*#__PURE__*/React.createElement(Card, {
      interactive: true,
      padding: "none",
      style: {
        overflow: 'hidden'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        padding: 18,
        display: 'flex',
        flexDirection: 'column',
        gap: 14
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1,
        minWidth: 0
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        marginBottom: 5
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 'var(--text-lg)',
        fontWeight: 'var(--fw-semibold)',
        color: 'var(--text-strong)',
        letterSpacing: '-.01em'
      }
    }, s.name), /*#__PURE__*/React.createElement(Badge, {
      tone: D.statusTone[s.status],
      dot: true
    }, s.status)), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 'var(--text-xs)',
        color: 'var(--text-subtle)',
        fontFamily: 'var(--font-mono)'
      }
    }, s.id)), /*#__PURE__*/React.createElement(Menu, {
      trigger: /*#__PURE__*/React.createElement(IconButton, {
        variant: "ghost",
        size: "sm",
        icon: /*#__PURE__*/React.createElement(Icon, {
          name: "more-horizontal",
          size: 16
        }),
        label: "Actions"
      }),
      items: [{
        label: 'Edit steps',
        icon: /*#__PURE__*/React.createElement(Icon, {
          name: "pencil",
          size: 15
        }),
        shortcut: 'E'
      }, {
        label: 'Duplicate',
        icon: /*#__PURE__*/React.createElement(Icon, {
          name: "copy",
          size: 15
        })
      }, {
        divider: true
      }, {
        label: 'Delete',
        icon: /*#__PURE__*/React.createElement(Icon, {
          name: "trash-2",
          size: 15
        }),
        tone: 'danger'
      }]
    })), /*#__PURE__*/React.createElement(StepPips, {
      steps: s.steps,
      kinds: kinds
    }), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        gap: 22,
        paddingTop: 14,
        borderTop: '1px solid var(--border-subtle)'
      }
    }, /*#__PURE__*/React.createElement(Stat, {
      label: "Enrolled",
      value: s.enrolled.toLocaleString()
    }), /*#__PURE__*/React.createElement(Stat, {
      label: "Open",
      value: s.open ? s.open.toFixed(0) + '%' : '—'
    }), /*#__PURE__*/React.createElement(Stat, {
      label: "Reply",
      value: s.reply ? s.reply.toFixed(0) + '%' : '—',
      accent: s.reply > 20
    }), /*#__PURE__*/React.createElement(Stat, {
      label: "Meetings",
      value: s.meetings || '—'
    }), /*#__PURE__*/React.createElement("div", {
      style: {
        marginLeft: 'auto',
        display: 'flex',
        alignItems: 'center',
        gap: 7
      }
    }, /*#__PURE__*/React.createElement(Avatar, {
      name: s.owner,
      size: "sm"
    }), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 'var(--text-sm)',
        color: 'var(--text-muted)'
      }
    }, s.owner)))));
  }
  function Stat({
    label,
    value,
    accent
  }) {
    return /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        flexDirection: 'column',
        gap: 2
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 'var(--text-xs)',
        color: 'var(--text-subtle)'
      }
    }, label), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 'var(--text-lg)',
        fontWeight: 'var(--fw-semibold)',
        color: accent ? 'var(--success-text)' : 'var(--text-strong)',
        fontFeatureSettings: 'var(--numeric)'
      }
    }, value));
  }
  function Sequences() {
    const D = window.LinkiData;
    const [tab, setTab] = React.useState('all');
    const shown = D.sequences.filter(s => tab === 'all' ? true : s.status === tab);
    return /*#__PURE__*/React.createElement("div", {
      style: {
        maxWidth: 'var(--container-max)',
        margin: '0 auto',
        padding: '24px 28px 40px'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        marginBottom: 18
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1
      }
    }, /*#__PURE__*/React.createElement("h1", {
      style: {
        fontSize: 'var(--text-3xl)',
        fontWeight: 'var(--fw-semibold)',
        color: 'var(--text-strong)',
        letterSpacing: '-.01em'
      }
    }, "Sequences"), /*#__PURE__*/React.createElement("p", {
      style: {
        fontSize: 'var(--text-md)',
        color: 'var(--text-muted)',
        marginTop: 4
      }
    }, "Multi-step outbound campaigns across email, calls, and LinkedIn.")), /*#__PURE__*/React.createElement(Button, {
      variant: "secondary",
      leftIcon: /*#__PURE__*/React.createElement(Icon, {
        name: "upload",
        size: 15
      })
    }, "Import"), /*#__PURE__*/React.createElement(Button, {
      variant: "primary",
      leftIcon: /*#__PURE__*/React.createElement(Icon, {
        name: "plus",
        size: 15
      })
    }, "New sequence")), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        marginBottom: 18
      }
    }, /*#__PURE__*/React.createElement(Tabs, {
      value: tab,
      onChange: setTab,
      items: [{
        value: 'all',
        label: 'All',
        count: D.sequences.length
      }, {
        value: 'active',
        label: 'Active',
        count: D.sequences.filter(s => s.status === 'active').length
      }, {
        value: 'paused',
        label: 'Paused'
      }, {
        value: 'draft',
        label: 'Drafts'
      }, {
        value: 'completed',
        label: 'Completed'
      }]
    }), /*#__PURE__*/React.createElement("div", {
      style: {
        marginLeft: 'auto',
        width: 240
      }
    }, /*#__PURE__*/React.createElement(Input, {
      size: "sm",
      placeholder: "Search sequences\u2026",
      leftIcon: /*#__PURE__*/React.createElement(Icon, {
        name: "search",
        size: 15
      })
    }))), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 16
      }
    }, shown.map(s => /*#__PURE__*/React.createElement(SequenceCard, {
      key: s.id,
      s: s
    }))), shown.length === 0 && /*#__PURE__*/React.createElement(Card, {
      style: {
        textAlign: 'center',
        padding: 48
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        width: 44,
        height: 44,
        borderRadius: 'var(--radius-lg)',
        background: 'var(--primary-subtle)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 14
      }
    }, /*#__PURE__*/React.createElement(Icon, {
      name: "git-branch",
      size: 22,
      style: {
        color: 'var(--primary-text)'
      }
    })), /*#__PURE__*/React.createElement("h3", {
      style: {
        fontSize: 'var(--text-lg)',
        fontWeight: 'var(--fw-semibold)',
        color: 'var(--text-strong)'
      }
    }, "No sequences here"), /*#__PURE__*/React.createElement("p", {
      style: {
        fontSize: 'var(--text-md)',
        color: 'var(--text-muted)',
        margin: '6px 0 16px'
      }
    }, "Build your first outbound flow in a few minutes."), /*#__PURE__*/React.createElement(Button, {
      variant: "primary",
      leftIcon: /*#__PURE__*/React.createElement(Icon, {
        name: "plus",
        size: 15
      })
    }, "New sequence")));
  }
  Object.assign(window, {
    Sequences
  });
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/linki-app/Sequences.jsx", error: String((e && e.message) || e) }); }

// ui_kits/linki-app/Shell.jsx
try { (() => {
/* IIFE-wrapped */
(function () {
  // Persistent app chrome: sidebar + topbar. Owns active-screen state.
  const {
    Icon,
    Avatar,
    Badge,
    Button,
    IconButton,
    Input,
    Menu,
    Tooltip
  } = window.LinkiDesignSystem_8f2af2;
  const NAV = [{
    id: 'dashboard',
    label: 'Dashboard',
    icon: 'layout-dashboard'
  }, {
    id: 'sequences',
    label: 'Sequences',
    icon: 'git-branch',
    badge: '3'
  }, {
    id: 'contacts',
    label: 'Contacts',
    icon: 'users'
  }, {
    id: 'inbox',
    label: 'Inbox',
    icon: 'inbox',
    badge: '12'
  }, {
    id: 'analytics',
    label: 'Analytics',
    icon: 'bar-chart-3'
  }];
  const NAV2 = [{
    id: 'settings',
    label: 'Settings',
    icon: 'settings'
  }, {
    id: 'help',
    label: 'Help & docs',
    icon: 'life-buoy'
  }];
  function BrandGlyph({
    size = 30
  }) {
    return /*#__PURE__*/React.createElement("span", {
      style: {
        width: size,
        height: size,
        borderRadius: 9,
        background: 'var(--cobalt-600)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        boxShadow: 'var(--shadow-raised)'
      }
    }, /*#__PURE__*/React.createElement("svg", {
      width: size * 0.56,
      height: size * 0.56,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "#fff",
      strokeWidth: "2.4",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }, /*#__PURE__*/React.createElement("path", {
      d: "M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"
    }), /*#__PURE__*/React.createElement("path", {
      d: "M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"
    })));
  }
  function NavItem({
    item,
    active,
    onClick
  }) {
    const [hover, setHover] = React.useState(false);
    return /*#__PURE__*/React.createElement("button", {
      onClick: onClick,
      onMouseEnter: () => setHover(true),
      onMouseLeave: () => setHover(false),
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        width: '100%',
        height: 34,
        padding: '0 10px',
        border: 'none',
        borderRadius: 'var(--radius-md)',
        cursor: 'pointer',
        textAlign: 'left',
        background: active ? 'var(--primary-subtle)' : hover ? 'var(--surface-sunken)' : 'transparent',
        color: active ? 'var(--primary-text)' : 'var(--text-muted)',
        fontSize: 'var(--text-md)',
        fontWeight: active ? 'var(--fw-semibold)' : 'var(--fw-medium)',
        transition: 'background var(--dur-fast), color var(--dur-fast)'
      }
    }, /*#__PURE__*/React.createElement(Icon, {
      name: item.icon,
      size: 17
    }), /*#__PURE__*/React.createElement("span", {
      style: {
        flex: 1
      }
    }, item.label), item.badge && /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 'var(--text-2xs)',
        fontWeight: 'var(--fw-semibold)',
        color: active ? 'var(--primary-text)' : 'var(--text-subtle)',
        background: active ? 'var(--surface)' : 'var(--surface-sunken)',
        borderRadius: 'var(--radius-pill)',
        padding: '1px 7px',
        fontFeatureSettings: 'var(--numeric)'
      }
    }, item.badge));
  }
  function Sidebar({
    active,
    setActive
  }) {
    return /*#__PURE__*/React.createElement("aside", {
      style: {
        width: 'var(--sidebar-w)',
        flexShrink: 0,
        height: '100%',
        background: 'var(--surface)',
        borderRight: '1px solid var(--border-subtle)',
        display: 'flex',
        flexDirection: 'column',
        padding: 12,
        boxSizing: 'border-box'
      }
    }, /*#__PURE__*/React.createElement("button", {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '6px 8px',
        marginBottom: 14,
        border: 'none',
        background: 'transparent',
        cursor: 'pointer',
        borderRadius: 'var(--radius-md)'
      }
    }, /*#__PURE__*/React.createElement(BrandGlyph, null), /*#__PURE__*/React.createElement("span", {
      style: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        minWidth: 0
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 'var(--text-md)',
        fontWeight: 'var(--fw-semibold)',
        color: 'var(--text-strong)',
        letterSpacing: '-.01em'
      }
    }, "Acme Inc"), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 'var(--text-xs)',
        color: 'var(--text-subtle)'
      }
    }, "Growth plan")), /*#__PURE__*/React.createElement(Icon, {
      name: "chevrons-up-down",
      size: 15,
      style: {
        color: 'var(--text-subtle)',
        marginLeft: 'auto'
      }
    })), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        flexDirection: 'column',
        gap: 2
      }
    }, NAV.map(n => /*#__PURE__*/React.createElement(NavItem, {
      key: n.id,
      item: n,
      active: active === n.id,
      onClick: () => setActive(n.id)
    }))), /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 2
      }
    }, NAV2.map(n => /*#__PURE__*/React.createElement(NavItem, {
      key: n.id,
      item: n,
      active: active === n.id,
      onClick: () => setActive(n.id)
    })), /*#__PURE__*/React.createElement("div", {
      style: {
        height: 1,
        background: 'var(--border-subtle)',
        margin: '8px 4px'
      }
    }), /*#__PURE__*/React.createElement("button", {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '6px 8px',
        border: 'none',
        background: 'transparent',
        cursor: 'pointer',
        borderRadius: 'var(--radius-md)'
      }
    }, /*#__PURE__*/React.createElement(Avatar, {
      name: "Dana Ruiz",
      size: "sm",
      status: "online"
    }), /*#__PURE__*/React.createElement("span", {
      style: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        minWidth: 0
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 'var(--text-sm)',
        fontWeight: 'var(--fw-medium)',
        color: 'var(--text-strong)'
      }
    }, "Dana Ruiz"), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 'var(--text-xs)',
        color: 'var(--text-subtle)',
        overflow: 'hidden',
        textOverflow: 'ellipsis'
      }
    }, "dana@acme.io")))));
  }
  function Topbar({
    title,
    onCommand,
    dark,
    setDark
  }) {
    return /*#__PURE__*/React.createElement("header", {
      style: {
        height: 'var(--topbar-h)',
        flexShrink: 0,
        borderBottom: '1px solid var(--border-subtle)',
        background: 'var(--surface)',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '0 20px'
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 'var(--text-lg)',
        fontWeight: 'var(--fw-semibold)',
        color: 'var(--text-strong)',
        letterSpacing: '-.01em'
      }
    }, title), /*#__PURE__*/React.createElement("div", {
      style: {
        marginLeft: 'auto',
        display: 'flex',
        alignItems: 'center',
        gap: 10
      }
    }, /*#__PURE__*/React.createElement("button", {
      onClick: onCommand,
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        height: 34,
        padding: '0 10px 0 11px',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--surface)',
        cursor: 'pointer',
        color: 'var(--text-subtle)',
        fontSize: 'var(--text-sm)'
      }
    }, /*#__PURE__*/React.createElement(Icon, {
      name: "search",
      size: 15
    }), /*#__PURE__*/React.createElement("span", null, "Search or jump to\u2026"), /*#__PURE__*/React.createElement("kbd", {
      style: {
        marginLeft: 24,
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        background: 'var(--surface-sunken)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 5,
        padding: '1px 5px'
      }
    }, "\u2318K")), /*#__PURE__*/React.createElement(Tooltip, {
      label: dark ? 'Light mode' : 'Dark mode',
      side: "bottom"
    }, /*#__PURE__*/React.createElement(IconButton, {
      variant: "ghost",
      icon: /*#__PURE__*/React.createElement(Icon, {
        name: dark ? 'sun' : 'moon'
      }),
      label: "Toggle theme",
      onClick: () => setDark(!dark)
    })), /*#__PURE__*/React.createElement(Tooltip, {
      label: "Notifications",
      side: "bottom"
    }, /*#__PURE__*/React.createElement(IconButton, {
      variant: "ghost",
      icon: /*#__PURE__*/React.createElement(Icon, {
        name: "bell"
      }),
      label: "Notifications"
    })), /*#__PURE__*/React.createElement(Button, {
      variant: "primary",
      size: "sm",
      leftIcon: /*#__PURE__*/React.createElement(Icon, {
        name: "plus",
        size: 15
      })
    }, "New sequence")));
  }
  function CommandPalette({
    open,
    onClose,
    setActive
  }) {
    const cmds = [{
      icon: 'layout-dashboard',
      label: 'Go to Dashboard',
      id: 'dashboard'
    }, {
      icon: 'git-branch',
      label: 'Go to Sequences',
      id: 'sequences'
    }, {
      icon: 'users',
      label: 'Go to Contacts',
      id: 'contacts'
    }, {
      icon: 'plus',
      label: 'Create new sequence'
    }, {
      icon: 'upload',
      label: 'Import contacts (CSV)'
    }, {
      icon: 'settings',
      label: 'Open settings',
      id: 'settings'
    }];
    if (!open) return null;
    return /*#__PURE__*/React.createElement("div", {
      onClick: onClose,
      style: {
        position: 'fixed',
        inset: 0,
        background: 'var(--scrim)',
        zIndex: 'var(--z-modal)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '12vh',
        animation: 'linki-pop var(--dur-slow) var(--ease-standard)'
      }
    }, /*#__PURE__*/React.createElement("div", {
      onClick: e => e.stopPropagation(),
      style: {
        width: 560,
        maxWidth: '90vw',
        background: 'var(--surface)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-xl)',
        boxShadow: 'var(--shadow-modal)',
        overflow: 'hidden'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '14px 16px',
        borderBottom: '1px solid var(--border-subtle)'
      }
    }, /*#__PURE__*/React.createElement(Icon, {
      name: "search",
      size: 18,
      style: {
        color: 'var(--text-subtle)'
      }
    }), /*#__PURE__*/React.createElement("input", {
      autoFocus: true,
      placeholder: "Type a command or search\u2026",
      style: {
        flex: 1,
        border: 'none',
        outline: 'none',
        background: 'transparent',
        fontSize: 'var(--text-lg)',
        color: 'var(--text)'
      }
    }), /*#__PURE__*/React.createElement("kbd", {
      style: {
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        color: 'var(--text-subtle)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 5,
        padding: '1px 6px'
      }
    }, "ESC")), /*#__PURE__*/React.createElement("div", {
      style: {
        padding: 8
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 'var(--text-2xs)',
        fontWeight: 'var(--fw-semibold)',
        letterSpacing: '.06em',
        textTransform: 'uppercase',
        color: 'var(--text-subtle)',
        padding: '6px 10px'
      }
    }, "Quick actions"), cmds.map((c, i) => /*#__PURE__*/React.createElement("button", {
      key: i,
      onClick: () => {
        if (c.id) setActive(c.id);
        onClose();
      },
      onMouseEnter: e => e.currentTarget.style.background = 'var(--surface-sunken)',
      onMouseLeave: e => e.currentTarget.style.background = 'transparent',
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 11,
        width: '100%',
        padding: '9px 10px',
        border: 'none',
        background: 'transparent',
        borderRadius: 'var(--radius-md)',
        cursor: 'pointer',
        textAlign: 'left',
        color: 'var(--text)',
        fontSize: 'var(--text-md)'
      }
    }, /*#__PURE__*/React.createElement(Icon, {
      name: c.icon,
      size: 16,
      style: {
        color: 'var(--text-muted)'
      }
    }), c.label)))));
  }
  function Shell({
    children,
    active,
    setActive,
    title
  }) {
    const [cmd, setCmd] = React.useState(false);
    const [dark, setDark] = React.useState(false);
    React.useEffect(() => {
      const el = document.getElementById('linki-root');
      if (el) el.setAttribute('data-theme', dark ? 'dark' : 'light');
      const onKey = e => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
          e.preventDefault();
          setCmd(v => !v);
        }
        if (e.key === 'Escape') setCmd(false);
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [dark]);
    return /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        height: '100%',
        background: 'var(--bg-app)'
      }
    }, /*#__PURE__*/React.createElement(Sidebar, {
      active: active,
      setActive: setActive
    }), /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column'
      }
    }, /*#__PURE__*/React.createElement(Topbar, {
      title: title,
      onCommand: () => setCmd(true),
      dark: dark,
      setDark: setDark
    }), /*#__PURE__*/React.createElement("main", {
      style: {
        flex: 1,
        overflow: 'auto'
      }
    }, children)), /*#__PURE__*/React.createElement(CommandPalette, {
      open: cmd,
      onClose: () => setCmd(false),
      setActive: setActive
    }));
  }
  Object.assign(window, {
    Shell,
    BrandGlyph
  });
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/linki-app/Shell.jsx", error: String((e && e.message) || e) }); }

// ui_kits/linki-app/data.js
try { (() => {
// Fake seed data for the Linki app UI kit.
window.LinkiData = function () {
  const sequences = [{
    id: 'seq_9F42',
    name: 'Q3 Outbound — Founders',
    status: 'active',
    steps: 5,
    enrolled: 142,
    open: 61.2,
    reply: 24.6,
    meetings: 12,
    owner: 'Dana Ruiz'
  }, {
    id: 'seq_7A18',
    name: 'Warm re-engage',
    status: 'active',
    steps: 3,
    enrolled: 88,
    open: 54.0,
    reply: 18.1,
    meetings: 6,
    owner: 'Marco Silva'
  }, {
    id: 'seq_4C90',
    name: 'Enterprise ABM',
    status: 'paused',
    steps: 7,
    enrolled: 34,
    open: 48.5,
    reply: 15.4,
    meetings: 4,
    owner: 'Priya Nair'
  }, {
    id: 'seq_2B55',
    name: 'Trial expiry nudge',
    status: 'active',
    steps: 4,
    enrolled: 210,
    open: 66.9,
    reply: 21.0,
    meetings: 9,
    owner: 'Dana Ruiz'
  }, {
    id: 'seq_1E03',
    name: 'Event follow-up — SaaStr',
    status: 'draft',
    steps: 2,
    enrolled: 0,
    open: 0,
    reply: 0,
    meetings: 0,
    owner: 'Leah Park'
  }, {
    id: 'seq_8D77',
    name: 'Churned win-back',
    status: 'completed',
    steps: 6,
    enrolled: 156,
    open: 42.3,
    reply: 12.8,
    meetings: 5,
    owner: 'Marco Silva'
  }];
  const contacts = [{
    name: 'Alicia Gomez',
    title: 'VP Sales',
    company: 'Northwind',
    stage: 'Qualified',
    owner: 'Dana Ruiz',
    email: 'alicia@northwind.io',
    last: '2h ago',
    health: 'online'
  }, {
    name: 'Ben Ito',
    title: 'Founder',
    company: 'Loomly',
    stage: 'Lead',
    owner: 'Marco Silva',
    email: 'ben@loomly.com',
    last: '1d ago',
    health: 'busy'
  }, {
    name: 'Carmen Diaz',
    title: 'Head of Growth',
    company: 'Segment Bay',
    stage: 'Proposal',
    owner: 'Priya Nair',
    email: 'carmen@segmentbay.co',
    last: '3h ago',
    health: 'online'
  }, {
    name: 'David Okoro',
    title: 'RevOps Lead',
    company: 'Traylo',
    stage: 'Qualified',
    owner: 'Dana Ruiz',
    email: 'd.okoro@traylo.app',
    last: '5d ago',
    health: 'offline'
  }, {
    name: 'Elena Rossi',
    title: 'CMO',
    company: 'Brightside',
    stage: 'Negotiation',
    owner: 'Leah Park',
    email: 'elena@brightside.eu',
    last: '20m ago',
    health: 'online'
  }, {
    name: 'Farid Hassan',
    title: 'CEO',
    company: 'Kettle',
    stage: 'Lead',
    owner: 'Marco Silva',
    email: 'farid@kettle.dev',
    last: '2d ago',
    health: 'offline'
  }, {
    name: 'Grace Lin',
    title: 'Ops Manager',
    company: 'Nimbus',
    stage: 'Qualified',
    owner: 'Priya Nair',
    email: 'grace@nimbus.cloud',
    last: '1h ago',
    health: 'busy'
  }];
  const activity = [{
    icon: 'reply',
    tone: 'accent',
    text: 'Alicia Gomez replied to Q3 Outbound',
    time: '2m'
  }, {
    icon: 'calendar-check',
    tone: 'brand',
    text: 'Meeting booked with Carmen Diaz',
    time: '18m'
  }, {
    icon: 'mail-open',
    tone: 'muted',
    text: 'Ben Ito opened “Warm re-engage” · step 2',
    time: '41m'
  }, {
    icon: 'user-plus',
    tone: 'muted',
    text: 'Leah Park enrolled 34 contacts in Enterprise ABM',
    time: '1h'
  }, {
    icon: 'alert-triangle',
    tone: 'warning',
    text: '2 messages bounced in Trial expiry nudge',
    time: '2h'
  }];
  const stageTone = {
    Lead: 'neutral',
    Qualified: 'info',
    Proposal: 'brand',
    Negotiation: 'warning',
    Won: 'success'
  };
  const statusTone = {
    active: 'success',
    paused: 'warning',
    draft: 'neutral',
    completed: 'info'
  };
  return {
    sequences,
    contacts,
    activity,
    stageTone,
    statusTone
  };
}();
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/linki-app/data.js", error: String((e && e.message) || e) }); }

__ds_ns.Button = __ds_scope.Button;

__ds_ns.IconButton = __ds_scope.IconButton;

__ds_ns.Avatar = __ds_scope.Avatar;

__ds_ns.Badge = __ds_scope.Badge;

__ds_ns.Card = __ds_scope.Card;

__ds_ns.Icon = __ds_scope.Icon;

__ds_ns.Metric = __ds_scope.Metric;

__ds_ns.Tag = __ds_scope.Tag;

__ds_ns.Alert = __ds_scope.Alert;

__ds_ns.ProgressBar = __ds_scope.ProgressBar;

__ds_ns.Skeleton = __ds_scope.Skeleton;

__ds_ns.Spinner = __ds_scope.Spinner;

__ds_ns.Toast = __ds_scope.Toast;

__ds_ns.Checkbox = __ds_scope.Checkbox;

__ds_ns.Input = __ds_scope.Input;

__ds_ns.Radio = __ds_scope.Radio;

__ds_ns.Select = __ds_scope.Select;

__ds_ns.Switch = __ds_scope.Switch;

__ds_ns.Textarea = __ds_scope.Textarea;

__ds_ns.Breadcrumbs = __ds_scope.Breadcrumbs;

__ds_ns.Menu = __ds_scope.Menu;

__ds_ns.Tabs = __ds_scope.Tabs;

__ds_ns.Dialog = __ds_scope.Dialog;

__ds_ns.Tooltip = __ds_scope.Tooltip;

})();
