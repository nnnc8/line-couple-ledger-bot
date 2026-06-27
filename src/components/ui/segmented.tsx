"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: React.ReactNode;
}

interface SegmentedProps<T extends string> {
  value: T;
  onValueChange: (value: T) => void;
  options: SegmentedOption<T>[];
  className?: string;
  size?: "sm" | "md";
}

export function Segmented<T extends string>({
  value,
  onValueChange,
  options,
  className,
  size = "md",
}: SegmentedProps<T>) {
  return (
    <div
      role="tablist"
      className={cn(
        "inline-flex items-center gap-1 rounded-xl bg-muted p-1 text-foreground",
        size === "sm" && "p-0.5",
        className,
      )}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onValueChange(opt.value)}
            className={cn(
              "flex flex-1 items-center justify-center gap-1.5 rounded-[10px] font-semibold transition-all active:scale-[0.97]",
              size === "sm" ? "h-9 px-3 text-[13px]" : "h-10 px-4 text-[14px]",
              active
                ? "bg-[var(--card)] text-primary shadow-[0_2px_8px_rgba(15,23,42,0.08)]"
                : "text-[var(--muted-foreground)] hover:text-foreground",
            )}
          >
            {opt.icon}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}