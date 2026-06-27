import * as React from "react";
import { cn } from "@/lib/utils";

interface ProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  value: number;
  tone?: "primary" | "warn" | "danger" | "success";
}

export function Progress({
  value,
  tone = "primary",
  className,
  ...props
}: ProgressProps) {
  const clamped = Math.max(0, Math.min(100, value));
  const colors = {
    primary: "bg-accent",
    warn: "bg-[#f59e0b]",
    danger: "bg-destructive",
    success: "bg-[var(--success)]",
  };
  return (
    <div
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn("h-2 w-full overflow-hidden rounded-full bg-muted", className)}
      {...props}
    >
      <div
        className={cn("h-full rounded-full transition-[width] duration-500", colors[tone])}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}