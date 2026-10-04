// Tooltips for secondary explanations, so pages can stay short. Hover or
// keyboard focus shows one; a tap toggles it on touch screens; Escape, a
// scroll or a tap elsewhere closes it. The text is always in the DOM for
// screen readers (aria-describedby), and the visible bubble renders in a
// portal with fixed positioning, so scrolling tables and cards never clip it.
import { cloneElement, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Info } from 'lucide-react';

const GAP = 8;    // between the anchor and the bubble
const EDGE = 8;   // keep clear of the viewport edge

function useTip({ content, placement = 'top', maxWidth = 280 }) {
  const descId = useId();
  const anchor = useRef(null);
  const bubble = useRef(null);
  const timer = useRef(null);
  const pointer = useRef(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);

  const later = useCallback((fn, ms) => { clearTimeout(timer.current); timer.current = setTimeout(fn, ms); }, []);
  const show = useCallback((ms = 0) => later(() => setOpen(true), ms), [later]);
  const hide = useCallback((ms = 0) => later(() => { setOpen(false); setPos(null); }, ms), [later]);
  useEffect(() => () => clearTimeout(timer.current), []);

  // Measure once the bubble exists, then place it above (or below, if there
  // is no room) and keep it inside the viewport.
  useLayoutEffect(() => {
    if (!open || !anchor.current || !bubble.current) return;
    const a = anchor.current.getBoundingClientRect();
    const b = bubble.current.getBoundingClientRect();
    let side = placement;
    let top = side === 'bottom' ? a.bottom + GAP : a.top - b.height - GAP;
    if (side !== 'bottom' && top < EDGE) { side = 'bottom'; top = a.bottom + GAP; }
    else if (side === 'bottom' && top + b.height > window.innerHeight - EDGE) { side = 'top'; top = a.top - b.height - GAP; }
    const left = Math.min(Math.max(EDGE, a.left + a.width / 2 - b.width / 2), window.innerWidth - b.width - EDGE);
    const arrow = Math.min(Math.max(10, a.left + a.width / 2 - left), b.width - 10);
    setPos({ top, left, side, arrow });
  }, [open, placement, content]);

  useEffect(() => {
    if (!open) return undefined;
    const close = () => hide(0);
    const onKey = e => { if (e.key === 'Escape') hide(0); };
    const onDown = e => { if (!anchor.current?.contains(e.target)) hide(0); };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown);
    };
  }, [open, hide]);

  const anchorProps = {
    ref: anchor,
    'aria-describedby': descId,
    onPointerDown: e => { pointer.current = e.pointerType; },
    onPointerEnter: e => { if (e.pointerType === 'mouse') show(90); },
    onPointerLeave: e => { if (e.pointerType === 'mouse') hide(60); },
    // A tap focuses before it clicks; let the click decide on touch.
    onFocus: () => { if (pointer.current !== 'touch') show(0); },
    onBlur: () => hide(0),
  };

  // Touch toggles; mouse and keyboard just open (hover already did).
  const onActivate = e => {
    const touch = pointer.current === 'touch';
    pointer.current = null;
    if (touch) { e.stopPropagation(); if (open) hide(0); else show(0); }
    else show(0);
  };

  const nodes = (
    <>
      <span id={descId} className="sr-only">{content}</span>
      {open && typeof document !== 'undefined' && createPortal(
        <div
          ref={bubble} aria-hidden="true"
          className="fixed z-[200] w-max pointer-events-none rounded-lg border px-3 py-2 text-xs leading-relaxed text-left font-normal normal-case tracking-normal shadow-xl"
          style={{
            top: pos ? pos.top : -9999, left: pos ? pos.left : -9999, maxWidth: Math.min(maxWidth, window.innerWidth - EDGE * 2),
            backgroundColor: '#0f1e38', borderColor: '#2b4a73', color: '#e2e8f0', boxShadow: '0 12px 32px rgba(2, 6, 23, 0.55)',
            opacity: pos ? 1 : 0, transform: pos ? 'none' : 'translateY(3px)', transition: 'opacity 120ms ease, transform 120ms ease',
          }}
        >
          {content}
          {pos && (
            <span
              className="absolute w-2.5 h-2.5 rotate-45 border"
              style={{
                left: pos.arrow - 5, backgroundColor: '#0f1e38', borderColor: '#2b4a73',
                ...(pos.side === 'bottom'
                  ? { top: -5.5, borderRightColor: 'transparent', borderBottomColor: 'transparent' }
                  : { bottom: -5.5, borderLeftColor: 'transparent', borderTopColor: 'transparent' }),
              }}
            />
          )}
        </div>,
        document.body,
      )}
    </>
  );
  return { anchorProps, nodes, onActivate };
}

// Wrap a chip, badge or short phrase: it explains itself on hover or focus.
// `asChild` puts the tooltip on the child element itself (a button keeps its
// own click; hover and focus show the tip, and its text describes the button).
export function Tooltip({ content, children, placement, maxWidth, className = '', focusable = true, asChild = false }) {
  const { anchorProps, nodes, onActivate } = useTip({ content, placement, maxWidth });
  if (!content) return children;
  if (asChild && isValidElement(children)) {
    const merged = { ...anchorProps };
    for (const k of ['onPointerDown', 'onPointerEnter', 'onPointerLeave', 'onFocus', 'onBlur']) {
      const theirs = children.props[k];
      if (theirs) merged[k] = e => { theirs(e); anchorProps[k](e); };
    }
    return <>{cloneElement(children, merged)}{nodes}</>;
  }
  return (
    <>
      <span {...anchorProps} tabIndex={focusable ? 0 : undefined} onClick={onActivate}
        className={`inline-flex items-center rounded outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60 ${focusable ? 'cursor-help' : ''} ${className}`}>
        {children}
      </span>
      {nodes}
    </>
  );
}

// A small ⓘ beside a label or title, holding the explanation the page used to
// spell out.
export function InfoTip({ children, label = 'More info', size = 14, placement, maxWidth, className = '' }) {
  const { anchorProps, nodes, onActivate } = useTip({ content: children, placement, maxWidth });
  return (
    <>
      <button
        type="button" aria-label={label} {...anchorProps}
        onClick={e => { e.preventDefault(); e.stopPropagation(); onActivate(e); }}
        className={`inline-flex items-center justify-center shrink-0 rounded-full align-middle cursor-help transition-colors outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60 text-slate-500 hover:text-sky-300 focus-visible:text-sky-300 ${className}`}
      >
        <Info size={size} strokeWidth={2.25} aria-hidden="true" />
      </button>
      {nodes}
    </>
  );
}
