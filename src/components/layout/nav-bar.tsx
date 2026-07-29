"use client";

import * as React from "react";
import {
  Home as IconHome,
  List as IconList,
  Plus,
  ChartNoAxesCombined,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type TabKey = "dashboard" | "history" | "analysis" | "settings";

interface NavProps {
  tab: TabKey;
  onChange: (tab: TabKey) => void;
  unread?: number;
  onAdd: () => void;
}

const tabItems: Array<{
  key: TabKey;
  label: string;
  Icon: LucideIcon;
}> = [
  { key: "dashboard", label: "首頁", Icon: IconHome },
  { key: "history", label: "流水", Icon: IconList },
  { key: "analysis", label: "分析", Icon: ChartNoAxesCombined },
  { key: "settings", label: "設定", Icon: Settings },
];

export function NavBar({ tab, onChange, unread, onAdd }: NavProps) {
  return (
    <nav
      aria-label="主要導覽"
      className="fixed inset-x-0 bottom-0 z-40 mx-auto flex max-w-[640px] items-end justify-between gap-1 border-t border-[var(--border)] bg-[var(--card)]/85 px-2 pb-[max(env(safe-area-inset-bottom),8px)] pt-2 backdrop-blur-xl"
    >
      {tabItems.slice(0, 2).map((item) => (
        <NavButton
          key={item.key}
          active={tab === item.key}
          label={item.label}
          icon={<item.Icon className="size-6" strokeWidth={2.2} />}
          onClick={() => onChange(item.key)}
        />
      ))}
      <button
        type="button"
        aria-label="記一筆"
        onClick={onAdd}
        className="-mt-7 flex h-14 min-w-[72px] shrink-0 flex-col items-center justify-center rounded-2xl bg-accent px-2 text-accent-foreground shadow-[var(--shadow-fab)] transition active:scale-95"
      >
        <Plus className="size-5" strokeWidth={2.6} />
        <span className="text-[13px] font-bold leading-none">記一筆</span>
      </button>
      {tabItems.slice(2).map((item) => (
        <NavButton
          key={item.key}
          active={tab === item.key}
          label={item.label}
          icon={<item.Icon className="size-6" strokeWidth={2.2} />}
          badge={item.key === "settings" ? unread : undefined}
          onClick={() => onChange(item.key)}
        />
      ))}
    </nav>
  );
}

function NavButton({
  active,
  label,
  icon,
  badge,
  onClick,
}: {
  active: boolean;
  label: string;
  icon: React.ReactNode;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 rounded-xl py-1 text-[13px] font-semibold transition",
        active ? "text-primary" : "text-[var(--muted-foreground)]",
      )}
    >
      <span className="relative">
        {icon}
        {badge && badge > 0 ? (
          <span className="absolute -right-2 -top-1 min-w-5 rounded-full bg-destructive px-1 text-center text-[13px] font-bold leading-5 text-destructive-foreground">
            {badge > 99 ? "99+" : badge}
          </span>
        ) : null}
      </span>
      <span className={active ? "font-bold" : ""}>{label}</span>
    </button>
  );
}
