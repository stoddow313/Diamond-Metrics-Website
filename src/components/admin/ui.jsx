// Small shared form primitives for the admin, matching the site's dark theme.
import { Children, cloneElement, isValidElement, useId } from 'react';
import { inputStyle } from './theme';

const NATIVE_CONTROLS = new Set(['input', 'select', 'textarea']);

// The label names its control: when the first child is an input, select or
// textarea (or a component marked `labelable`), it gets an id the label
// points at, so screen readers announce it and clicking the label focuses it.
export function Field({ label, children }) {
  const autoId = useId();
  const kids = Children.toArray(children);
  const first = kids[0];
  const labelable = isValidElement(first) && (NATIVE_CONTROLS.has(first.type) || first.type?.labelable === true);
  const id = labelable ? first.props.id || autoId : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-bold" style={{ color: '#cfe8ff' }}>{label}</label>
      {labelable ? [cloneElement(first, { id }), ...kids.slice(1)] : children}
    </div>
  );
}

export function TextInput(props) {
  return (
    <input
      {...props}
      className={`w-full px-3 py-2 rounded-lg border text-white text-sm outline-none focus:border-sky-400 ${props.className || ''}`}
      style={{ ...inputStyle, ...props.style }}
    />
  );
}

export function Select({ children, ...props }) {
  return (
    <select
      {...props}
      className={`w-full px-3 py-2 rounded-lg border text-white text-sm outline-none focus:border-sky-400 ${props.className || ''}`}
      style={{ ...inputStyle, ...props.style }}
    >
      {children}
    </select>
  );
}

TextInput.labelable = true;
Select.labelable = true;

export function PrimaryButton({ children, ...props }) {
  return (
    <button
      {...props}
      className={`px-4 py-2 rounded-xl font-bold text-sm cursor-pointer transition-transform hover:-translate-y-0.5 disabled:opacity-50 disabled:hover:translate-y-0 ${props.className || ''}`}
      style={{ backgroundColor: '#38bdf8', color: '#0f172a', ...props.style }}
    >
      {children}
    </button>
  );
}

export function GhostButton({ children, ...props }) {
  return (
    <button
      {...props}
      className={`px-4 py-2 rounded-xl font-bold text-sm border cursor-pointer transition-colors hover:bg-slate-800 ${props.className || ''}`}
      style={{ borderColor: '#334155', color: '#cfe8ff', ...props.style }}
    >
      {children}
    </button>
  );
}

export function ErrorNote({ children }) {
  if (!children) return null;
  return (
    <p className="text-sm py-2 px-3 rounded-lg" style={{ backgroundColor: 'rgba(239, 68, 68, 0.12)', color: '#f87171' }}>
      {children}
    </p>
  );
}
