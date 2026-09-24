import * as React from "react";
import { cn } from "@/lib/utils";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "h-11 min-w-0 w-full rounded-xl border border-[var(--border)] bg-[var(--card)] px-3.5 text-base text-foreground placeholder:text-[var(--muted-foreground)] transition focus:border-accent focus:outline-none focus:ring-[3px] focus:ring-[var(--accent-glow)] disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";
