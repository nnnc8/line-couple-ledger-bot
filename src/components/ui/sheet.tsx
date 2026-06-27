"use client";

import * as React from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

interface SheetProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  title?: string;
  subtitle?: string;
  className?: string;
  bodyClassName?: string;
  labelledBy?: string;
  variant?: "compact" | "full";
  showClose?: boolean;
}

export function Sheet({
  open,
  onClose,
  children,
  title,
  subtitle,
  className,
  bodyClassName,
  labelledBy,
  variant = "compact",
  showClose = true,
}: SheetProps) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 animate-backdrop-in sm:items-center sm:p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className={cn(
          "w-full max-w-[640px] rounded-t-3xl bg-[var(--card)] shadow-[var(--shadow-sheet)] animate-sheet-up sm:rounded-3xl",
          variant === "full" ? "max-h-[92dvh]" : "",
          className,
        )}
      >
        <div className="flex items-center justify-between gap-3 px-5 pt-4">
          <div className="flex justify-center absolute left-1/2 top-3 -translate-x-1/2">
            <span className="h-1.5 w-10 rounded-full bg-muted sm:hidden" />
          </div>
          <div className="space-y-0.5">
            {title ? (
              <h2
                id={labelledBy}
                className="text-lg font-bold tracking-tight"
              >
                {title}
              </h2>
            ) : null}
            {subtitle ? (
              <p className="text-[13px] text-[var(--muted-foreground)]">{subtitle}</p>
            ) : null}
          </div>
          {showClose ? (
            <button
              aria-label="關閉"
              onClick={onClose}
              className="flex size-9 items-center justify-center rounded-full text-[var(--muted-foreground)] transition hover:bg-muted"
            >
              <X className="size-5" />
            </button>
          ) : null}
        </div>
        <div
          className={cn(
            "px-5 pt-3 pb-[max(20px,env(safe-area-inset-bottom))]",
            variant === "full" && "max-h-[calc(92dvh-64px)] overflow-y-auto touch-scroll",
            bodyClassName,
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}