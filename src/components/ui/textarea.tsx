import * as React from "react";
import { cn } from "@/lib/utils";

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        "min-h-[88px] w-full rounded-xl border border-[var(--border)] bg-[var(--card)] px-3.5 py-3 text-[15px] text-foreground placeholder:text-[var(--muted-foreground)] transition focus:border-accent focus:outline-none focus:ring-[3px] focus:ring-[var(--accent-glow)] resize-y",
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";