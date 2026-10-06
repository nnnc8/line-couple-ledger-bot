"use client";

import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

/** One native modal. Child surfaces replace content instead of nesting dialogs. */
export function LedgerSurfaceHost({ surface, title, onCancel, cancelDisabled = false, returnFocus, initialFocus, fullHeight = false, children }: {
  surface: string | null;
  title: string;
  onCancel: () => void;
  cancelDisabled?: boolean;
  returnFocus: () => HTMLElement | null;
  initialFocus?: () => HTMLElement | null;
  fullHeight?: boolean;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusReturn = useRef(returnFocus);
  useEffect(() => { focusReturn.current = returnFocus; }, [returnFocus]);
  const open = surface !== null;
  const [presentation, setPresentation] = useState(fullHeight);
  if (open && presentation !== fullHeight) setPresentation(fullHeight);
  const focusInitial = useEffectEvent(() => initialFocus?.() ?? heading.current);
  useLayoutEffect(() => {
    const node = dialog.current;
    if (!node || !open) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    node.showModal();
    return () => {
      node.close();
      document.body.style.overflow = overflow;
      const target = focusReturn.current();
      if (target?.isConnected) target.focus({ preventScroll: true });
    };
  }, [open]);
  useLayoutEffect(() => { if (surface) focusInitial()?.focus({ preventScroll: true }); }, [surface, title]);
  useLayoutEffect(() => {
    if (!open || !fullHeight || !window.visualViewport) return;
    const viewport = window.visualViewport;
    const resize = () => {
      dialog.current?.style.setProperty("--ledger-viewport-height", `${viewport.height}px`);
      dialog.current?.style.setProperty("--ledger-viewport-top", `${viewport.offsetTop}px`);
    };
    resize();
    viewport.addEventListener("resize", resize);
    viewport.addEventListener("scroll", resize);
    return () => { viewport.removeEventListener("resize", resize); viewport.removeEventListener("scroll", resize); };
  }, [open, fullHeight]);
  return <dialog id="ledger-surface-dialog" ref={dialog} aria-labelledby="ledger-dialog-title"
    data-full-height={presentation || undefined}
    aria-describedby={surface === "quick-entry" ? "quick-entry-ledger" : undefined}
    className={`${presentation ? "ledger-quick-dialog" : "m-auto max-h-[85dvh] w-[calc(100%-2rem)] max-w-md rounded-2xl"} overflow-y-auto overscroll-contain border border-[var(--border)] bg-[var(--card)] p-4 text-[var(--foreground)] backdrop:bg-black/40`}
    onCancel={event => { event.preventDefault(); if (!cancelDisabled) onCancel(); }}>
    <div className="mb-3 flex items-start justify-between gap-2">
      <h2 ref={heading} id="ledger-dialog-title" tabIndex={-1} className="min-w-0 py-2 text-lg font-bold [overflow-wrap:anywhere]">{title}</h2>
      <Button tabIndex={0} variant="ghost" size="sm" onClick={onCancel} disabled={cancelDisabled} aria-label="關閉視窗">關閉</Button>
    </div>
    {children}
  </dialog>;
}
