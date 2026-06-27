"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface SelectProps {
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  size?: "sm" | "md";
  id?: string;
  ariaLabel?: string;
}

export function Select({
  value,
  onValueChange,
  options,
  placeholder,
  disabled,
  className,
  size = "md",
  id,
  ariaLabel,
}: SelectProps) {
  const selected = options.find((o) => o.value === value);
  const display = selected?.label ?? placeholder ?? "";
  return (
    <div className={cn("relative inline-flex w-full", className)}>
      <select
        id={id}
        aria-label={ariaLabel}
        value={value}
        disabled={disabled}
        onChange={(e) => onValueChange(e.target.value)}
        className={cn(
          "w-full appearance-none rounded-xl border border-[var(--border)] bg-[var(--card)] pl-3.5 pr-9 text-[15px] text-foreground transition focus:border-accent focus:outline-none focus:ring-[3px] focus:ring-[var(--accent-glow)] disabled:opacity-50",
          size === "sm" ? "h-9 text-[13px]" : "h-11",
          !selected && !placeholder && "text-[var(--muted-foreground)]",
        )}
      >
        {placeholder && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {options.map((opt) => (
          <option key={opt.value} value={opt.value} disabled={opt.disabled}>
            {opt.label}
          </option>
        ))}
      </select>
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-[var(--muted-foreground)]"
      />
      <span className="sr-only">{display}</span>
    </div>
  );
}