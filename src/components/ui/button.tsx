import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl font-semibold outline-none transition-all active:translate-y-px disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-foreground hover:bg-[var(--primary-hover)] active:bg-[var(--primary-hover)] shadow-[0_2px_8px_rgba(20,42,71,0.18)]",
        accent: "bg-accent text-accent-foreground hover:opacity-90 shadow-[0_2px_8px_rgba(59,130,246,0.25)]",
        secondary: "bg-secondary text-secondary-foreground hover:bg-[#e4ebf3] border border-[var(--border)]",
        outline: "border border-[var(--border)] bg-[var(--card)] text-foreground hover:bg-muted",
        ghost: "text-accent hover:bg-accent-soft",
        danger: "bg-destructive/10 text-destructive hover:bg-destructive/20 border border-destructive/30",
        link: "text-accent underline-offset-4 hover:underline",
      },
      size: {
        sm: "h-9 px-3 text-sm",
        md: "h-11 px-4 text-[15px]",
        lg: "h-12 px-5 text-base",
        block: "h-12 w-full text-base",
        icon: "size-11",
        "icon-sm": "size-9",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export function Button({
  className,
  variant,
  size,
  type,
  ...props
}: ButtonProps) {
  return (
    <button
      type={type ?? "button"}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { buttonVariants };