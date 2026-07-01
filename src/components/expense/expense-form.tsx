"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { Segmented } from "@/components/ui/segmented";
import { Camera, Check, Loader2, Trash2 } from "lucide-react";
import { tagPreset, tagColor } from "@/lib/categories";
import type { Bootstrap, Expense } from "@/lib/types";
import type { PendingActionInput } from "@/lib/optimistic";
import { cn } from "@/lib/utils";

type SplitMethod = "equal" | "exact" | "percentage";
type LedgerType = "shared" | "private";
type PaidBy = "self" | "partner";

interface ExpenseFormProps {
  data: Bootstrap;
  busy: boolean;
  editExpense: Expense | null;
  onSubmit: (body: PendingActionInput) => void;
  onDelete?: () => void;
  onExit: () => void;
  onReceipt: (
    file: File,
  ) => Promise<{
    receiptId: string;
    extraction: { merchant: string | null; expenseDate: string | null; amountTwd: number | null };
  }>;
}

interface FormState {
  ledger: LedgerType;
  description: string;
  merchant: string;
  notes: string;
  tag: string;
  amount: string;
  paidBy: PaidBy;
  expenseDate: string;
  splitMethod: SplitMethod;
  selfValue: string;
  partnerValue: string;
  receiptId: string | null;
}

function deriveInitial(data: Bootstrap, editing: Expense | null): FormState {
  if (editing) {
    const mine =
      editing.expense_splits.find((s) => s.user_id === data.user.id)?.amount_twd ?? 0;
    const theirs =
      editing.expense_splits.find((s) => s.user_id !== data.user.id)?.amount_twd ?? 0;
    return {
      ledger: editing.ledger,
      description: editing.description,
      merchant: editing.merchant ?? "",
      notes: editing.notes ?? "",
      tag: editing.tag,
      amount: String(editing.amount_twd),
      paidBy: editing.paid_by_user_id === data.user.id ? "self" : "partner",
      expenseDate: editing.expense_date,
      splitMethod: editing.split_method as SplitMethod,
      selfValue:
        editing.split_method === "percentage"
          ? String(Math.round((mine / editing.amount_twd) * 10000) / 100)
          : String(mine),
      partnerValue:
        editing.split_method === "percentage"
          ? String(Math.round((theirs / editing.amount_twd) * 10000) / 100)
          : String(theirs),
      receiptId: editing.receipts[0]?.id ?? null,
    };
  }
  const draft =
    typeof window !== "undefined"
      ? (JSON.parse(sessionStorage.getItem("receiptDraft") ?? "null") as {
          merchant?: string;
          expense_date?: string;
          amount_twd?: number;
          receipt_id?: string;
        } | null)
      : null;
  return {
    ledger: "shared",
    description: draft?.merchant ?? "",
    merchant: draft?.merchant ?? "",
    notes: "",
    tag: "",
    amount: draft?.amount_twd ? String(draft.amount_twd) : "",
    paidBy: "self",
    expenseDate: draft?.expense_date ?? data.today,
    splitMethod: "equal",
    selfValue: "",
    partnerValue: "",
    receiptId: draft?.receipt_id ?? null,
  };
}

export function ExpenseForm({
  data,
  busy,
  editExpense,
  onSubmit,
  onDelete,
  onReceipt,
}: ExpenseFormProps) {
  const [state, setState] = React.useState<FormState>(() =>
    deriveInitial(data, editExpense),
  );
  const [ocr, setOcr] = React.useState(false);
  const [err, setErr] = React.useState("");

  function patch<K extends keyof FormState>(key: K, value: FormState[K]) {
    setState((s) => ({ ...s, [key]: value }));
  }

  async function scan(file?: File) {
    if (!file) return;
    setOcr(true);
    setErr("");
    try {
      const r = await onReceipt(file);
      patch("receiptId", r.receiptId);
      if (r.extraction.merchant) {
        patch("merchant", r.extraction.merchant);
        if (!state.description) patch("description", r.extraction.merchant);
      }
      if (r.extraction.expenseDate) patch("expenseDate", r.extraction.expenseDate);
      if (r.extraction.amountTwd) patch("amount", String(r.extraction.amountTwd));
    } catch (reason) {
      setErr(reason instanceof Error ? reason.message : "收據辨識失敗");
    } finally {
      setOcr(false);
    }
  }

  function submit() {
    setErr("");
    const amount = Number(state.amount);
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      setErr("請輸入正確整數金額");
      return;
    }
    if (!state.description.trim()) {
      setErr("請輸入說明");
      return;
    }
    if (!state.expenseDate) {
      setErr("請選擇日期");
      return;
    }

    const expenseBody = {
      ledger: state.ledger,
      groupId: state.ledger === "shared" ? data.activeGroupId : null,
      description: state.description.trim(),
      merchant: state.merchant.trim() || null,
      notes: state.notes.trim() || null,
      tag: state.tag.trim() || "其他",
      amountTwd: amount,
      paidBy: state.paidBy,
      expenseDate: state.expenseDate,
      splitMethod: state.splitMethod,
      selfValue: state.selfValue ? Number(state.selfValue) : null,
      partnerValue: state.partnerValue ? Number(state.partnerValue) : null,
      receiptId: state.receiptId,
    };

    if (editExpense) {
      onSubmit({
        type: "update_expense",
        expenseId: editExpense.id,
        expectedVersion: editExpense.version,
        expense: expenseBody,
      });
    } else {
      onSubmit({ type: "create_expense", expense: expenseBody });
    }
  }

  return (
    <div className="space-y-5 pt-1">
      {/* Hero amount */}
      <div className="space-y-1 text-center">
        <p className="text-[12px] font-semibold text-[var(--muted-foreground)]">
          金額（TWD）
        </p>
        <input
          inputMode="decimal"
          value={state.amount}
          onChange={(e) => patch("amount", e.target.value)}
          placeholder="0"
          aria-label="金額（TWD）"
          className="w-full border-0 border-b-2 border-[var(--border)] bg-transparent py-2 text-center text-[40px] font-extrabold tracking-tight placeholder:text-[var(--muted-foreground)]/40 focus:border-accent focus:outline-none focus:ring-0"
        />
      </div>

      {/* Receipt */}
      <label className="relative flex cursor-pointer flex-col items-center gap-1.5 rounded-2xl border-2 border-dashed border-[var(--border)] bg-muted/30 p-5 text-center transition hover:border-accent hover:bg-accent-soft">
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
          capture="environment"
          className="absolute inset-0 cursor-pointer opacity-0"
          onChange={(e) => void scan(e.target.files?.[0])}
        />
        {ocr ? (
          <Loader2 className="size-7 animate-spin text-[var(--muted-foreground)]" />
        ) : state.receiptId ? (
          <Check className="size-7 text-[var(--success)]" />
        ) : (
          <Camera className="size-7 text-[var(--muted-foreground)]" />
        )}
        <span className="text-[14px] font-semibold">
          {ocr
            ? "辨識中…"
            : state.receiptId
              ? "收據已辨識，可重選"
              : "拍攝或選擇收據"}
        </span>
        <span className="text-[12px] text-[var(--muted-foreground)]">
          自動填入商家、日期與總額
        </span>
      </label>

      {/* Ledger toggle */}
      <div>
        <Label className="mb-2">帳本</Label>
        <Segmented
          value={state.ledger}
          onValueChange={(v) => {
            patch("ledger", v);
            if (v === "private") patch("paidBy", "self");
          }}
          options={[
            { value: "shared", label: "💕 共同" },
            { value: "private", label: "👤 私人" },
          ]}
        />
      </div>

      {/* Description */}
      <div>
        <Label htmlFor="description" className="mb-2">說明</Label>
        <Input
          id="description"
          value={state.description}
          onChange={(e) => patch("description", e.target.value)}
          placeholder="例如：晚餐"
          maxLength={100}
        />
      </div>

      {/* Tag input */}
      <div>
        <Label htmlFor="tag" className="mb-2">標籤</Label>
        <Input
          id="tag"
          list="tag-suggestions"
          value={state.tag}
          onChange={(e) => patch("tag", e.target.value)}
          placeholder="例如：餐飲、交通、購物"
          maxLength={30}
        />
        <datalist id="tag-suggestions">
          {tagPreset.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
      </div>

      {/* Date + Merchant */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="expenseDate" className="mb-2">日期</Label>
          <Input
            id="expenseDate"
            type="date"
            value={state.expenseDate}
            onChange={(e) => patch("expenseDate", e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="merchant" className="mb-2">商家</Label>
          <Input
            id="merchant"
            value={state.merchant}
            onChange={(e) => patch("merchant", e.target.value)}
            placeholder="選填"
            maxLength={100}
          />
        </div>
      </div>

      {/* PaidBy + SplitMethod */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="mb-2">付款人</Label>
          <Select
            value={state.paidBy}
            onValueChange={(v) => patch("paidBy", v as PaidBy)}
            disabled={state.ledger === "private"}
            options={[
              { value: "self", label: "你" },
              { value: "partner", label: "另一半" },
            ]}
          />
        </div>
        <div>
          <Label className="mb-2">分帳方式</Label>
          <Select
            value={state.splitMethod}
            onValueChange={(v) => patch("splitMethod", v as SplitMethod)}
            disabled={state.ledger === "private"}
            options={[
              { value: "equal", label: "平均" },
              { value: "exact", label: "指定金額" },
              { value: "percentage", label: "百分比" },
            ]}
          />
        </div>
      </div>

      {/* Split values */}
      {state.ledger === "shared" && state.splitMethod !== "equal" ? (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="mb-2">
              你的{state.splitMethod === "exact" ? "金額" : "比例 %"}
            </Label>
            <Input
              value={state.selfValue}
              onChange={(e) => patch("selfValue", e.target.value)}
              inputMode="decimal"
              placeholder={state.splitMethod === "exact" ? "0" : "50"}
            />
          </div>
          <div>
            <Label className="mb-2">
              另一半{state.splitMethod === "exact" ? "金額" : "比例 %"}
            </Label>
            <Input
              value={state.partnerValue}
              onChange={(e) => patch("partnerValue", e.target.value)}
              inputMode="decimal"
              placeholder={state.splitMethod === "exact" ? "0" : "50"}
            />
          </div>
        </div>
      ) : null}

      {/* Notes */}
      <div>
        <Label htmlFor="notes" className="mb-2">備註</Label>
        <Textarea
          id="notes"
          value={state.notes}
          onChange={(e) => patch("notes", e.target.value)}
          placeholder="選填"
          maxLength={500}
          className="min-h-[72px]"
        />
      </div>

      {err ? (
        <p className="text-[13px] font-medium text-destructive">{err}</p>
      ) : null}

      {/* Submit */}
      <Button
        variant="primary"
        size="block"
        disabled={busy || ocr}
        onClick={submit}
        className="font-bold"
      >
        {editExpense ? "直接更新" : "直接記帳"}
      </Button>

      {editExpense && onDelete ? (
        <Button
          variant="outline"
          size="block"
          disabled={busy || ocr}
          className="border-destructive/30 text-destructive hover:bg-destructive/10"
          onClick={onDelete}
        >
          <Trash2 className="size-4" /> 刪除這筆支出
        </Button>
      ) : null}
    </div>
  );
}
