"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { api } from "@/lib/api";

type Step = "welcome" | "pair" | "group" | "first" | "done";

export function OnboardingFlow({ onDone }: { onDone: () => void }) {
  const [step, setStep] = React.useState<Step>("welcome");
  const [pairCode, setPairCode] = React.useState("");
  const [groupName, setGroupName] = React.useState("");
  const [firstExpense, setFirstExpense] = React.useState("");
  const [firstAmount, setFirstAmount] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  async function submitOnboarding() {
    setBusy(true);
    try {
      await api("/api/app/onboarding", {
        pairCode,
        groupName,
        firstExpense,
        firstAmount: firstAmount ? Number(firstAmount) : undefined,
      });
      setStep("done");
      setTimeout(onDone, 1000);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "設定失敗");
      setBusy(false);
    }
  }

  if (step === "welcome") {
    return (
      <main className="mx-auto flex min-h-dvh max-w-[640px] flex-col items-center justify-center px-6 text-center animate-fade-in">
        <div className="flex size-24 items-center justify-center rounded-3xl bg-primary text-3xl font-extrabold text-primary-foreground shadow-[var(--shadow-fab)] mb-6">
          共
        </div>
        <h1 className="text-2xl font-bold tracking-tight">歡迎使用共同帳本</h1>
        <p className="mt-3 text-[15px] text-[var(--muted-foreground)] leading-relaxed">
          一個住在 LINE 裡的貼心記帳助手，<br />
          幫你和另一半輕鬆管理共同生活開銷。
        </p>
        <div className="mt-8 w-full max-w-xs space-y-3">
          <Button
            variant="primary"
            size="lg"
            className="w-full"
            onClick={() => setStep("pair")}
          >
            開始設定
          </Button>
        </div>
      </main>
    );
  }

  if (step === "pair") {
    return (
      <main className="mx-auto flex min-h-dvh max-w-[640px] flex-col justify-center px-6 animate-fade-in">
        <h1 className="text-xl font-bold tracking-tight">輸入配對碼</h1>
        <p className="mt-2 text-[14px] text-[var(--muted-foreground)]">
          配對碼可以在設定頁面找到，或請對方分享給你。
        </p>
        <div className="mt-6">
          <input
            type="text"
            value={pairCode}
            onChange={(e) => setPairCode(e.target.value)}
            placeholder="輸入配對碼"
            className="h-12 w-full rounded-xl border-[1.5px] border-[var(--border)] bg-[var(--card)] px-4 text-[16px] font-medium focus:border-accent focus:outline-none focus:ring-2 focus:ring-[var(--accent-glow)]"
          />
        </div>
        <div className="mt-6 flex gap-3">
          <Button variant="secondary" size="md" onClick={() => setStep("welcome")}>
            返回
          </Button>
          <Button
            variant="primary"
            size="md"
            className="flex-1"
            disabled={!pairCode.trim() || busy}
            onClick={() => setStep("group")}
          >
            下一步
          </Button>
        </div>
      </main>
    );
  }

  if (step === "group") {
    return (
      <main className="mx-auto flex min-h-dvh max-w-[640px] flex-col justify-center px-6 animate-fade-in">
        <h1 className="text-xl font-bold tracking-tight">設定群組名稱</h1>
        <p className="mt-2 text-[14px] text-[var(--muted-foreground)]">
          群組用來分類你們的共同支出，例如「共同生活」、「旅遊基金」等。
        </p>
        <div className="mt-6">
          <input
            type="text"
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            placeholder="例如：共同生活"
            className="h-12 w-full rounded-xl border-[1.5px] border-[var(--border)] bg-[var(--card)] px-4 text-[16px] font-medium focus:border-accent focus:outline-none focus:ring-2 focus:ring-[var(--accent-glow)]"
          />
        </div>
        <div className="mt-6 flex gap-3">
          <Button variant="secondary" size="md" onClick={() => setStep("pair")}>
            返回
          </Button>
          <Button
            variant="primary"
            size="md"
            className="flex-1"
            disabled={!groupName.trim() || busy}
            onClick={() => setStep("first")}
          >
            下一步
          </Button>
        </div>
      </main>
    );
  }

  if (step === "first") {
    return (
      <main className="mx-auto flex min-h-dvh max-w-[640px] flex-col justify-center px-6 animate-fade-in">
        <h1 className="text-xl font-bold tracking-tight">記第一筆帳（選填）</h1>
        <p className="mt-2 text-[14px] text-[var(--muted-foreground)]">
          可以先試記一筆，之後也能在 LINE 直接記帳。
        </p>
        <div className="mt-6 space-y-3">
          <input
            type="text"
            value={firstExpense}
            onChange={(e) => setFirstExpense(e.target.value)}
            placeholder="例如：晚餐"
            className="h-12 w-full rounded-xl border-[1.5px] border-[var(--border)] bg-[var(--card)] px-4 text-[16px] font-medium focus:border-accent focus:outline-none focus:ring-2 focus:ring-[var(--accent-glow)]"
          />
          <input
            type="number"
            value={firstAmount}
            onChange={(e) => setFirstAmount(e.target.value)}
            placeholder="金額（例如 200）"
            className="h-12 w-full rounded-xl border-[1.5px] border-[var(--border)] bg-[var(--card)] px-4 text-[16px] font-medium focus:border-accent focus:outline-none focus:ring-2 focus:ring-[var(--accent-glow)]"
          />
        </div>
        <div className="mt-6 flex gap-3">
          <Button variant="secondary" size="md" onClick={() => setStep("group")}>
            返回
          </Button>
          <Button
            variant="primary"
            size="md"
            className="flex-1"
            disabled={busy}
            onClick={submitOnboarding}
          >
            {busy ? "設定中..." : "完成設定"}
          </Button>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-[640px] flex-col items-center justify-center px-6 text-center animate-fade-in">
      <div className="text-4xl mb-4">🎉</div>
      <h1 className="text-xl font-bold tracking-tight">設定完成！</h1>
      <p className="mt-2 text-[14px] text-[var(--muted-foreground)]">
        即將進入帳本...
      </p>
    </main>
  );
}
