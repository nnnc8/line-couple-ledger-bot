import { cn } from "@/lib/utils";

export function Skeleton({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className={cn("animate-pulse-soft rounded-md bg-muted", className)}
      style={style}
    />
  );
}

export function SkeletonBlock({
  className,
}: {
  className?: string;
}) {
  return (
    <div
      className={cn(
        "animate-pulse-soft rounded-2xl border border-[var(--border)] bg-muted",
        className,
      )}
    />
  );
}