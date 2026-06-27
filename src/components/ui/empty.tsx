import * as React from "react";
import { cn } from "@/lib/utils";

interface EmptyProps {
  title: string;
  description?: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}

export function Empty({ title, description, icon, action, className }: EmptyProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 py-10 text-center",
        className,
      )}
    >
      {icon ? (
        <div className="flex size-14 items-center justify-center rounded-2xl bg-muted text-[26px] text-[var(--muted-foreground)]">
          {icon}
        </div>
      ) : null}
      <div className="space-y-1">
        <p className="text-[15px] font-medium text-foreground/80">{title}</p>
        {description ? (
          <p className="text-[13px] leading-relaxed text-[var(--muted-foreground)]">
            {description}
          </p>
        ) : null}
      </div>
      {action}
    </div>
  );
}