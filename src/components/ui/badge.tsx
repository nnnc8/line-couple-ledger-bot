import * as React from "react";
import { cn } from "@/lib/utils";

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: "default" | "secondary" | "success" | "warn" | "danger" | "outline";
}

export function Badge({ className, variant = "default", ...props }: BadgeProps) {
  const styles: Record<NonNullable<BadgeProps["variant"]>, string> = {
    default: "bg-accent-soft text-accent",
    secondary: "bg-muted text-foreground/70",
    success: "bg-[rgba(16,185,129,.15)] text-[#0f9776]",
    warn: "bg-[rgba(245,158,11,.15)] text-[#b45309]",
    danger: "bg-[rgba(239,68,68,.15)] text-destructive",
    outline: "border border-[var(--border)] text-foreground/70",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold",
        styles[variant],
        className,
      )}
      {...props}
    />
  );
}