"use client";

import { Home, List, Plus, Sparkles, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type NavTab = "dashboard" | "history" | "private" | "add" | "accountant" | "budgets" | "settings";

interface BottomNavProps {
  activeTab: NavTab;
  onTabChange: (tab: NavTab) => void;
  notificationCount?: number;
}

const navItems: Array<{
  id: NavTab;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  isPrimary?: boolean;
}> = [
  { id: "dashboard", label: "首頁", icon: Home },
  { id: "history", label: "帳本", icon: List },
  { id: "add", label: "記帳", icon: Plus, isPrimary: true },
  { id: "accountant", label: "AI", icon: Sparkles },
  { id: "settings", label: "設定", icon: Settings },
];

export function BottomNav({ activeTab, onTabChange, notificationCount = 0 }: BottomNavProps) {
  return (
    <nav className="fixed bottom-0 left-1/2 z-50 w-full max-w-[760px] -translate-x-1/2 border-t border-border bg-white/95 backdrop-blur-xl safe-area-bottom">
      <div className="flex items-center justify-around px-2 py-1.5">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeTab === item.id;

          if (item.isPrimary) {
            return (
              <Button
                key={item.id}
                variant="ghost"
                size="icon"
                className="relative -mt-5 h-12 w-12 rounded-2xl bg-gradient-to-br from-[#0f2f52] to-[#1e4a7a] text-white shadow-lg hover:bg-gradient-to-br hover:from-[#173b63] hover:to-[#1e4a7a]"
                onClick={() => onTabChange(item.id)}
              >
                <Icon className="h-6 w-6" />
              </Button>
            );
          }

          return (
            <Button
              key={item.id}
              variant="ghost"
              size="icon"
              className={cn(
                "relative flex h-12 w-14 flex-col items-center gap-0.5 rounded-xl py-1 text-xs font-semibold",
                isActive ? "text-[#0f2f52]" : "text-muted-foreground"
              )}
              onClick={() => onTabChange(item.id)}
            >
              <Icon className="h-5 w-5" />
              <span className="text-[10px]">{item.label}</span>
              {item.id === "history" && notificationCount > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-destructive-foreground">
                  {notificationCount > 99 ? "99+" : notificationCount}
                </span>
              )}
            </Button>
          );
        })}
      </div>
    </nav>
  );
}
