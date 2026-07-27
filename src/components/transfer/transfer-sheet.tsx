"use client";

import * as React from "react";
import { ArrowRight, Landmark } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import type { Group } from "@/lib/types";

export type TransferDirection = "me_to_partner" | "partner_to_me";

export type TransferFormInput = {
  type: "transfer";
  groupId: string;
  direction: TransferDirection;
  amountTwd: number;
  occurredOn: string;
  notes?: string;
  idempotencyKey: string;
};

interface TransferSheetProps {
  open: boolean;
  groups: Group[];
  initialGroupId: string;
  currentUserId: string;
  groupBalances: Record<
    string,
    Array<{ user_id: string; balance_twd: number }>
  >;
  today: string;
  busy: boolean;
  onClose: () => void;
  onSubmit: (input: TransferFormInput) => void;
}

export function transferBalanceAfter(
  currentBalance: number,
  direction: TransferDirection,
  amountTwd: number,
): number {
  return direction === "me_to_partner"
    ? currentBalance + amountTwd
    : currentBalance - amountTwd;
}

export function isValidTransferAmount(value: string): boolean {
  const amount = Number(value);
  return (
    /^\d+$/.test(value.trim()) &&
    Number.isSafeInteger(amount) &&
    amount >= 1 &&
    amount <= 100_000_000
  );
}

function balanceCopy(balance: number): string {
  if (balance === 0) return "雙方已結清";
  return balance > 0
    ? `另一半欠你 NT$${balance.toLocaleString()}`
    : `你欠另一半 NT$${Math.abs(balance).toLocaleString()}`;
}

function transferNotice(
  currentBalance: number,
  direction: TransferDirection,
  amountTwd: number,
): string | null {
  if (currentBalance === 0) {
    return "目前沒有欠款；這筆會成為預付款，並建立新的雙方餘額。";
  }
  const repaysCurrentDebt =
    (currentBalance < 0 && direction === "me_to_partner") ||
    (currentBalance > 0 && direction === "partner_to_me");
  if (!repaysCurrentDebt) {
    return "這是目前欠款的反方向，記錄後欠款會增加。請確認เงินจริง方向無誤。";
  }
  if (amountTwd > Math.abs(currentBalance)) {
    return "金額超過目前欠款，餘額會跨過 0，超出的部分將成為預付款。";
  }
  return null;
}

export function TransferSheet({
  open,
  groups,
  initialGroupId,
  currentUserId,
  groupBalances,
  today,
  busy,
  onClose,
  onSubmit,
}: TransferSheetProps) {
  const [groupId, setGroupId] = React.useState(initialGroupId);
  const [direction, setDirection] =
    React.useState<TransferDirection>("me_to_partner");
  const [amount, setAmount] = React.useState("");
  const [occurredOn, setOccurredOn] = React.useState(today);
  const [notes, setNotes] = React.useState("");
  const [error, setError] = React.useState("");
  const requestRef = React.useRef<{ fingerprint: string; key: string } | null>(null);

  const currentBalance = groupBalances[groupId]?.find(
    (balance) => balance.user_id === currentUserId,
  )?.balance_twd;
  const amountTwd = Number(amount);
  const validAmount = isValidTransferAmount(amount);
  const groupReady = currentBalance !== undefined;
  const afterBalance = validAmount && currentBalance !== undefined
    ? transferBalanceAfter(currentBalance, direction, amountTwd)
    : currentBalance ?? 0;
  const notice = validAmount && currentBalance !== undefined
    ? transferNotice(currentBalance, direction, amountTwd)
    : null;

  function submit() {
    setError("");
    if (!groupReady) {
      setError("群組餘額仍在更新，請稍候再送出");
      return;
    }
    if (!validAmount) {
      setError("請輸入 1 至 100,000,000 的整數金額");
      return;
    }
    if (!occurredOn || occurredOn > today) {
      setError("轉帳日期不得晚於今天");
      return;
    }
    const trimmedNotes = notes.trim();
    if (trimmedNotes.length > 200) {
      setError("備註最多 200 字");
      return;
    }
    const fingerprint = JSON.stringify({
      groupId,
      direction,
      amountTwd,
      occurredOn,
      notes: trimmedNotes,
    });
    const idempotencyKey =
      requestRef.current?.fingerprint === fingerprint
        ? requestRef.current.key
        : crypto.randomUUID();
    requestRef.current = { fingerprint, key: idempotencyKey };
    onSubmit({
      type: "transfer",
      groupId,
      direction,
      amountTwd,
      occurredOn,
      notes: trimmedNotes || undefined,
      idempotencyKey,
    });
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="記錄轉帳"
      subtitle="只記錄เงินจริง移動，不會計入支出報表"
      labelledBy="transfer-sheet-title"
      variant="full"
    >
      <div className="space-y-5 pt-1">
        <div>
          <Label htmlFor="transfer-group" className="mb-2">群組</Label>
          <Select
            id="transfer-group"
            value={groupId}
            disabled={busy}
            onValueChange={(value) => {
              setError("");
              setGroupId(value);
            }}
            options={groups
              .filter((group) => !group.archived_at)
              .map((group) => ({ value: group.id, label: group.name }))}
          />
        </div>

        <div>
          <Label className="mb-2">方向</Label>
          <Segmented
            ariaLabel="轉帳方向"
            value={direction}
            onValueChange={(value) => setDirection(value as TransferDirection)}
            options={[
              { value: "me_to_partner", label: "我轉給另一半" },
              { value: "partner_to_me", label: "另一半轉給我" },
            ]}
          />
        </div>

        <div className="space-y-1 text-center">
          <p className="text-[12px] font-semibold text-[var(--muted-foreground)]">
            金額（TWD）
          </p>
          <input
            aria-label="轉帳金額（TWD）"
            inputMode="numeric"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="0"
            className="w-full border-0 border-b-2 border-[var(--border)] bg-transparent py-2 text-center text-[40px] font-extrabold tracking-tight placeholder:text-[var(--muted-foreground)]/40 focus:border-accent focus:outline-none focus:ring-0"
          />
        </div>

        <div>
          <Label htmlFor="transfer-date" className="mb-2">日期</Label>
          <Input
            id="transfer-date"
            type="date"
            max={today}
            value={occurredOn}
            onChange={(event) => setOccurredOn(event.target.value)}
          />
        </div>

        <div>
          <Label htmlFor="transfer-notes" className="mb-2">備註</Label>
          <Textarea
            id="transfer-notes"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="選填"
            maxLength={200}
            className="min-h-[72px]"
          />
          <p className="mt-1 text-right text-[11px] text-[var(--muted-foreground)]">
            {notes.length}/200
          </p>
        </div>

        <div
          aria-live="polite"
          className="rounded-2xl border border-[var(--border)] bg-muted/55 p-4"
        >
          <div className="flex items-center gap-2 text-[12px] font-semibold text-[var(--muted-foreground)]">
            <Landmark className="size-4" /> 餘額預覽
          </div>
          {groupReady ? (
            <div className="mt-2 flex items-center gap-2 text-[13px] font-semibold">
              <span className="min-w-0 flex-1">{balanceCopy(currentBalance)}</span>
              <ArrowRight className="size-4 shrink-0 text-[var(--muted-foreground)]" />
              <span className="min-w-0 flex-1 text-right">
                {validAmount ? balanceCopy(afterBalance) : "輸入金額後顯示"}
              </span>
            </div>
          ) : (
            <p className="mt-2 text-[13px] text-[var(--muted-foreground)]">
              無法取得這個群組的餘額，請重新整理後再試
            </p>
          )}
          {notice && groupReady ? (
            <p className="mt-3 rounded-xl bg-amber-100 px-3 py-2 text-[12px] font-semibold leading-5 text-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
              {notice}
            </p>
          ) : null}
        </div>

        {error ? (
          <p className="text-[13px] font-medium text-destructive">{error}</p>
        ) : null}

        <Button
          variant="primary"
          size="block"
          disabled={busy}
          onClick={submit}
          className="font-bold"
        >
          記錄這筆轉帳
        </Button>
      </div>
    </Sheet>
  );
}
