import React from 'react';
import type { StylesConfig, GroupBase } from 'react-select';

import './styles.css';

// ─── Widget ──────────────────────────────────────────────────────────────────

export interface WidgetProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Remove the default padding. */
  noPadding?: boolean;
  /** Transparent background and no border/shadow. */
  transparent?: boolean;
}

export function Widget({ noPadding, transparent, className, children, ...rest }: WidgetProps) {
  const cls = [
    'ui-widget',
    noPadding    && 'ui-widget--no-padding',
    transparent  && 'ui-widget--transparent',
    className,
  ].filter(Boolean).join(' ');

  return <div className={cls} {...rest}>{children}</div>;
}

// ─── Button ───────────────────────────────────────────────────────────────────

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
export type ButtonSize    = 'sm' | 'md' | 'lg';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?:   ButtonVariant;
  size?:      ButtonSize;
  /** Shows a spinner and sets the button to disabled. */
  loading?:   boolean;
  /** Stretches the button to full container width. */
  fullWidth?: boolean;
}

export function Button({
  variant   = 'primary',
  size      = 'md',
  loading   = false,
  fullWidth = false,
  disabled,
  className,
  children,
  ...rest
}: ButtonProps) {
  const cls = [
    'ui-button',
    variant !== 'primary' && `ui-button--${variant}`,
    size    !== 'md'      && `ui-button--${size}`,
    fullWidth             && 'ui-button--full',
    className,
  ].filter(Boolean).join(' ');

  return (
    <button className={cls} disabled={disabled || loading} {...rest}>
      {loading && <span className="ui-button__spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}

// ─── LineEdit ─────────────────────────────────────────────────────────────────

export interface LineEditProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  label?:    string;
  error?:    string;
  hint?:     string;
  /** Icon / adornment rendered inside the input on the left. */
  leading?:  React.ReactNode;
  /** Icon / adornment rendered inside the input on the right. */
  trailing?: React.ReactNode;
  onChange?: (value: string, event: React.ChangeEvent<HTMLInputElement>) => void;
}

export function LineEdit({
  label,
  error,
  hint,
  leading,
  trailing,
  className,
  onChange,
  id,
  ...rest
}: LineEditProps) {
  const autoId  = React.useId();
  const inputId = id ?? autoId;

  const inputCls = [
    'ui-input',
    error           && 'ui-input--error',
    leading  != null && 'ui-input--has-lead',
    trailing != null && 'ui-input--has-trail',
    className,
  ].filter(Boolean).join(' ');

  const inputEl = (
    <input
      id={inputId}
      className={inputCls}
      onChange={e => onChange?.(e.target.value, e)}
      {...rest}
    />
  );

  return (
    <div className="ui-field">
      {label && (
        <label className="ui-label" htmlFor={inputId}>
          {label}
        </label>
      )}

      {leading != null || trailing != null ? (
        <div className="ui-input-wrap">
          {leading != null && (
            <span className="ui-input-slot ui-input-slot--lead" aria-hidden="true">
              {leading}
            </span>
          )}
          {inputEl}
          {trailing != null && (
            <span className="ui-input-slot ui-input-slot--trail" aria-hidden="true">
              {trailing}
            </span>
          )}
        </div>
      ) : (
        inputEl
      )}

      {error ? (
        <span className="ui-error" role="alert">{error}</span>
      ) : hint ? (
        <span className="ui-hint">{hint}</span>
      ) : null}
    </div>
  );
}

// ─── Selector ─────────────────────────────────────────────────────────────────

export interface SelectorOption {
  value:     string;
  label:     string;
  disabled?: boolean;
}

export interface SelectorProps
  extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'onChange'> {
  options:      SelectorOption[];
  placeholder?: string;
  label?:       string;
  onChange?:    (value: string, event: React.ChangeEvent<HTMLSelectElement>) => void;
}

export function Selector({
  options,
  placeholder,
  label,
  className,
  onChange,
  value,
  id,
  ...rest
}: SelectorProps) {
  const autoId   = React.useId();
  const selectId = id ?? autoId;

  return (
    <div className="ui-field">
      {label && (
        <label className="ui-label" htmlFor={selectId}>
          {label}
        </label>
      )}
      <select
        id={selectId}
        className={['ui-select', className].filter(Boolean).join(' ')}
        onChange={e => onChange?.(e.target.value, e)}
        value={value ?? ''}
        {...rest}
      >
        {placeholder && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {options.map(opt => (
          <option key={opt.value} value={opt.value} disabled={opt.disabled}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

// ─── reactSelectStyles ────────────────────────────────────────────────────────

/** Read a CSS custom property from :root at call time (stays in sync automatically). */
function v(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Cached so every call returns the same object reference.
// react-select compares the `styles` prop by reference and resets internal
// state (including open-menu) when it changes — a new object on every render
// causes the menu to collapse mid-click, making items unselectable.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _reactSelectStylesCache: StylesConfig<any, any, any> | null = null;

/**
 * Returns a stable react-select StylesConfig that reads from the same CSS
 * variables defined in styles.css, so react-select dropdowns are visually
 * identical to the native .ui-select.
 *
 * The returned object is cached — every call returns the same reference, which
 * is required for react-select to behave correctly.
 *
 * @example
 * <ReactSelect styles={reactSelectStyles()} ... />
 */
export function reactSelectStyles<
  Option  = { value: string; label: string },
  IsMulti extends boolean = boolean,
  Group   extends GroupBase<Option> = GroupBase<Option>,
>(): StylesConfig<Option, IsMulti, Group> {
  if (_reactSelectStylesCache) return _reactSelectStylesCache as StylesConfig<Option, IsMulti, Group>;
  _reactSelectStylesCache = {
    control: (base, state) => ({
      ...base,
      backgroundColor: v('--ui-surface-2'),
      border:          `1.5px solid ${state.isFocused ? v('--ui-accent') : v('--ui-border')}`,
      borderRadius:    v('--ui-r'),
      boxShadow:       state.isFocused ? v('--ui-shadow-focus') : 'none',
      color:           v('--ui-text'),
      cursor:          'pointer',
      fontFamily:      'inherit',
      fontSize:        v('--ui-fs-sm'),
      minHeight:       '36px',
      transition:      `border-color ${v('--ui-t-fast')}, box-shadow ${v('--ui-t-fast')}`,
      '&:hover': {
        borderColor: state.isFocused ? v('--ui-accent') : v('--ui-border-hover'),
      },
    }),

    valueContainer: (base) => ({
      ...base,
      padding: `0 ${v('--ui-sp-3')}`,
    }),

    menu: (base) => ({
      ...base,
      animation:       `ui-fade-in ${v('--ui-t-fast')} ease`,
      backgroundColor: v('--ui-surface-2'),
      border:          `1.5px solid ${v('--ui-border')}`,
      borderRadius:    v('--ui-r'),
      boxShadow:       v('--ui-shadow-lg'),
      overflow:        'hidden',
      zIndex:          100,
    }),

    menuList: (base) => ({
      ...base,
      padding: '4px',
    }),

    option: (base, state) => ({
      ...base,
      backgroundColor: state.isSelected
        ? v('--ui-accent')
        : state.isFocused
        ? v('--ui-accent-muted')
        : 'transparent',
      borderRadius: v('--ui-r-sm'),
      color:        state.isSelected ? '#fff' : v('--ui-text'),
      cursor:       'pointer',
      fontSize:     v('--ui-fs-sm'),
      padding:      `${v('--ui-sp-2')} ${v('--ui-sp-3')}`,
      transition:   `background ${v('--ui-t-fast')}`,
      '&:active': {
        backgroundColor: v('--ui-accent-dim'),
        color:           '#fff',
      },
    }),

    placeholder: (base) => ({
      ...base,
      color:    v('--ui-placeholder'),
      fontSize: v('--ui-fs-sm'),
    }),

    singleValue: (base) => ({
      ...base,
      color:    v('--ui-text'),
      fontSize: v('--ui-fs-sm'),
    }),

    input: (base) => ({
      ...base,
      color:    v('--ui-text'),
      fontSize: v('--ui-fs-sm'),
    }),

    indicatorSeparator: () => ({
      display: 'none',
    }),

    dropdownIndicator: (base, state) => ({
      ...base,
      color:      state.isFocused ? v('--ui-accent') : v('--ui-text-muted'),
      padding:    '0 8px',
      transition: `color ${v('--ui-t-fast')}`,
      '&:hover': {
        color: v('--ui-accent-hover'),
      },
    }),

    clearIndicator: (base) => ({
      ...base,
      color:   v('--ui-text-muted'),
      padding: '0 6px',
      '&:hover': {
        color: v('--ui-danger'),
      },
    }),

    multiValue: (base) => ({
      ...base,
      backgroundColor: v('--ui-surface-3'),
      borderRadius:    v('--ui-r-sm'),
    }),

    multiValueLabel: (base) => ({
      ...base,
      color:    v('--ui-text'),
      fontSize: v('--ui-fs-xs'),
      padding:  '2px 6px',
    }),

    multiValueRemove: (base) => ({
      ...base,
      borderRadius: `0 ${v('--ui-r-sm')} ${v('--ui-r-sm')} 0`,
      color:        v('--ui-text-muted'),
      '&:hover': {
        backgroundColor: v('--ui-danger-muted'),
        color:           v('--ui-danger'),
      },
    }),

    noOptionsMessage: (base) => ({
      ...base,
      color:    v('--ui-text-muted'),
      fontSize: v('--ui-fs-sm'),
    }),

    loadingMessage: (base) => ({
      ...base,
      color:    v('--ui-text-muted'),
      fontSize: v('--ui-fs-sm'),
    }),
  };
  return _reactSelectStylesCache as StylesConfig<Option, IsMulti, Group>;
}

// ─── injectGlobalStyles ───────────────────────────────────────────────────────

let _injected = false;

/**
 * Call once at your app root (e.g. main.tsx or App.tsx) to register the UI
 * design-system stylesheet. Safe to call multiple times — only runs once.
 *
 * The CSS is bundled automatically via the module-level import at the top of
 * this file; this function serves as an explicit, searchable call-site marker.
 */
export function injectGlobalStyles(): void {
  if (_injected) return;
  _injected = true;
}
