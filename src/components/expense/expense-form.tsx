"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Camera, Check, Loader2 } from "lucide-react";

const expenseSchema = z.object({
  ledger: z.enum(["shared", "private"]),
  description: z.string().min(1, "請輸入說明").max(100),
  merchant: z.string().max(100).default(""),
  notes: z.string().max(500).default(""),
  category: z.string().default("other"),
  categoryLabel: z.string().default(""),
  amountTwd: z.string().min(1, "請輸入金額"),
  paidBy: z.enum(["self", "partner"]),
  expenseDate: z.string().min(1, "請選擇日期"),
  splitMethod: z.enum(["equal", "exact", "percentage"]),
  selfValue: z.string().default(""),
  partnerValue: z.string().default(""),
  receiptId: z.string().nullable().default(null),
});

type ExpenseFormData = z.infer<typeof expenseSchema>;

const categoryNames: Record<string, string> = {
  food: "餐飲",
  transport: "交通",
  groceries: "生鮮",
  household: "居家",
  entertainment: "娛樂",
  shopping: "購物",
  medical: "醫療",
  travel: "旅行",
  other: "其他",
};

const categoryEmojis: Record<string, string> = {
  food: "🍽",
  transport: "🚗",
  groceries: "🥬",
  household: "🏠",
  entertainment: "🎮",
  shopping: "🛍",
  medical: "💊",
  travel: "✈️",
  other: "📦",
};

type ExpenseEditorProps = {
  data: {
    today: string;
    user: { id: string; role: string };
    users: Array<{ id: string; role: string; label: string }>;
    activeGroupId: string;
  };
  busy: boolean;
  onSubmit(body: unknown): void;
  onReceipt(
    file: File,
  ): Promise<{
    extraction: {
      merchant: string | null;
      expenseDate: string | null;
      amountTwd: number | null;
    };
    receiptId: string;
  }>;
};

export function ExpenseEditor({
  data,
  busy,
  onSubmit,
  onReceipt,
}: ExpenseEditorProps) {
  const [ocr, setOcr] = useState(false);
  const [localError, setLocalError] = useState("");

  const editing =
    typeof window !== "undefined"
      ? (JSON.parse(sessionStorage.getItem("editExpense") ?? "null") as {
          id: string;
          version: number;
          ledger: string;
          description: string;
          merchant: string | null;
          notes: string | null;
          category: string;
          category_label: string | null;
          amount_twd: number;
          paid_by_user_id: string;
          expense_date: string;
          split_method: string;
          expense_splits: Array<{ user_id: string; amount_twd: number }>;
          receipts: Array<{ id: string }>;
        } | null)
      : null;

  const defaultValues: ExpenseFormData = editing
    ? {
        ledger: editing.ledger as "shared" | "private",
        description: editing.description,
        merchant: editing.merchant ?? "",
        notes: editing.notes ?? "",
        category: editing.category,
        categoryLabel: editing.category_label ?? "",
        amountTwd: String(editing.amount_twd),
        paidBy:
          editing.paid_by_user_id === data.user.id ? "self" : "partner",
        expenseDate: editing.expense_date,
        splitMethod: editing.split_method as
          | "equal"
          | "exact"
          | "percentage",
        selfValue: (() => {
          const mine =
            editing.expense_splits.find(
              (s) => s.user_id === data.user.id,
            )?.amount_twd ?? 0;
          return editing.split_method === "percentage"
            ? String(Math.round((mine / editing.amount_twd) * 10_000) / 100)
            : String(mine);
        })(),
        partnerValue: (() => {
          const theirs =
            editing.expense_splits.find(
              (s) => s.user_id !== data.user.id,
            )?.amount_twd ?? 0;
          return editing.split_method === "percentage"
            ? String(
                Math.round((theirs / editing.amount_twd) * 10_000) / 100,
              )
            : String(theirs);
        })(),
        receiptId: editing.receipts[0]?.id ?? null,
      }
    : {
        ledger: "shared",
        description: "",
        merchant: "",
        notes: "",
        category: "other",
        categoryLabel: "",
        amountTwd: "",
        paidBy: "self",
        expenseDate: data.today,
        splitMethod: "equal",
        selfValue: "",
        partnerValue: "",
        receiptId: null,
      };

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm({
    resolver: zodResolver(expenseSchema),
    defaultValues,
  });

  const ledger = watch("ledger");
  const splitMethod = watch("splitMethod");
  const category = watch("category");

  function onFormSubmit(values: ExpenseFormData) {
    setLocalError("");
    const amount = Number(values.amountTwd);
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      setLocalError("請輸入正確整數金額");
      return;
    }
    const expense = {
      ...values,
      groupId: values.ledger === "shared" ? data.activeGroupId : null,
      amountTwd: amount,
      merchant: values.merchant || null,
      notes: values.notes || null,
      selfValue: values.selfValue ? Number(values.selfValue) : null,
      partnerValue: values.partnerValue ? Number(values.partnerValue) : null,
    };
    onSubmit(
      editing
        ? {
            type: "update_expense",
            expenseId: editing.id,
            expectedVersion: editing.version,
            expense,
          }
        : { type: "create_expense", expense },
    );
  }

  async function scan(file?: File) {
    if (!file) return;
    setOcr(true);
    setLocalError("");
    try {
      const result = await onReceipt(file);
      setValue("receiptId", result.receiptId);
      if (result.extraction.merchant) {
        setValue("merchant", result.extraction.merchant);
        setValue("description", result.extraction.merchant);
      }
      if (result.extraction.expenseDate) {
        setValue("expenseDate", result.extraction.expenseDate);
      }
      if (result.extraction.amountTwd) {
        setValue("amountTwd", String(result.extraction.amountTwd));
      }
    } catch (reason) {
      setLocalError(
        reason instanceof Error ? reason.message : "收據辨識失敗",
      );
    } finally {
      setOcr(false);
    }
  }

  return (
    <form onSubmit={handleSubmit(onFormSubmit)} className="space-y-5">
      {/* Header */}
      <div className="space-y-1">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {editing ? "修改流水" : "建立草稿"}
        </p>
        <h2 className="text-lg font-bold tracking-tight">
          {editing ? editing.description : "新增支出"}
        </h2>
      </div>

      {/* Hero amount input */}
      <div className="space-y-1 text-center">
        <Label className="text-xs font-semibold text-muted-foreground">
          金額（TWD）
        </Label>
        <Input
          {...register("amountTwd")}
          required
          inputMode="numeric"
          placeholder="0"
          aria-label="金額（TWD）"
          className="h-16 border-0 border-b-2 border-border bg-transparent text-center text-4xl font-extrabold tracking-tight focus-visible:ring-0 focus-visible:border-primary"
        />
      </div>

      {/* Receipt upload */}
      <label className="relative flex cursor-pointer flex-col items-center gap-1.5 rounded-xl border-2 border-dashed border-border bg-muted/30 p-5 text-center transition-colors hover:border-primary hover:bg-primary/5">
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
          capture="environment"
          className="absolute inset-0 cursor-pointer opacity-0"
          onChange={(e) => void scan(e.target.files?.[0])}
        />
        {ocr ? (
          <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
        ) : watch("receiptId") ? (
          <Check className="h-7 w-7 text-green-500" />
        ) : (
          <Camera className="h-7 w-7 text-muted-foreground" />
        )}
        <span className="text-sm font-semibold text-foreground">
          {ocr
            ? "辨識中…"
            : watch("receiptId")
              ? "收據已辨識，可重新選擇"
              : "拍攝或選擇收據"}
        </span>
        <span className="text-xs text-muted-foreground">
          自動填入商家、日期與總額，確認前都能修改
        </span>
      </label>

      {/* Ledger toggle */}
      <div className="flex rounded-xl bg-muted p-1">
        <button
          type="button"
          className={`flex-1 rounded-lg py-2.5 text-sm font-semibold transition-all ${
            ledger === "shared"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground"
          }`}
          onClick={() => setValue("ledger", "shared")}
        >
          💑 共同帳
        </button>
        <button
          type="button"
          className={`flex-1 rounded-lg py-2.5 text-sm font-semibold transition-all ${
            ledger === "private"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground"
          }`}
          onClick={() => setValue("ledger", "private")}
        >
          👤 私人帳
        </button>
      </div>

      {/* Description */}
      <div className="space-y-2">
        <Label htmlFor="description">說明</Label>
        <Input
          id="description"
          {...register("description", { required: "請輸入說明" })}
          placeholder="例如：晚餐"
          maxLength={100}
        />
        {errors.description && (
          <p className="text-sm text-destructive">
            {errors.description.message}
          </p>
        )}
      </div>

      {/* Category chips */}
      <div className="space-y-2">
        <Label>分類</Label>
        <div className="flex flex-wrap gap-2">
          {Object.entries(categoryNames).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 text-sm font-semibold transition-all ${
                category === key
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "bg-muted text-muted-foreground hover:bg-muted/80"
              }`}
              onClick={() => setValue("category", key)}
            >
              {categoryEmojis[key]} {label}
            </button>
          ))}
        </div>
      </div>

      {/* Date & Merchant */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label htmlFor="expenseDate">日期</Label>
          <Input
            id="expenseDate"
            type="date"
            {...register("expenseDate", { required: "請選擇日期" })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="merchant">商家</Label>
          <Input
            id="merchant"
            {...register("merchant")}
            placeholder="選填"
            maxLength={100}
          />
        </div>
      </div>

      {/* Paid by & Split method */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label>付款人</Label>
          <Select
            value={watch("paidBy")}
            onValueChange={(v) =>
              setValue("paidBy", v as "self" | "partner")
            }
            disabled={ledger === "private"}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="self">你</SelectItem>
              <SelectItem value="partner">另一半</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>分帳方式</Label>
          <Select
            value={splitMethod}
            onValueChange={(v) =>
              setValue(
                "splitMethod",
                v as "equal" | "exact" | "percentage",
              )
            }
            disabled={ledger === "private"}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="equal">平均</SelectItem>
              <SelectItem value="exact">指定金額</SelectItem>
              <SelectItem value="percentage">百分比</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Split values */}
      {ledger === "shared" && splitMethod !== "equal" && (
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label>
              你的{splitMethod === "exact" ? "金額" : "比例 %"}
            </Label>
            <Input
              {...register("selfValue", { required: true })}
              inputMode="decimal"
            />
          </div>
          <div className="space-y-2">
            <Label>
              另一半{splitMethod === "exact" ? "金額" : "比例 %"}
            </Label>
            <Input
              {...register("partnerValue", { required: true })}
              inputMode="decimal"
            />
          </div>
        </div>
      )}

      {/* Notes */}
      <div className="space-y-2">
        <Label htmlFor="notes">備註</Label>
        <Textarea
          id="notes"
          {...register("notes")}
          placeholder="選填備註"
          maxLength={500}
          className="min-h-[72px] resize-y"
        />
      </div>

      {/* Error */}
      {localError && (
        <p className="text-sm font-medium text-destructive">{localError}</p>
      )}

      {/* Submit */}
      <Button
        type="submit"
        className="h-13 w-full text-base"
        disabled={busy || ocr}
      >
        {editing ? "預覽修改" : "預覽並確認"}
      </Button>

      {/* Delete (edit mode) */}
      {editing && (
        <Button
          type="button"
          variant="outline"
          className="h-12 w-full border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
          disabled={busy || ocr}
          onClick={() => {
            if (confirm("確定要刪除這筆支出嗎？")) {
              onSubmit({
                type: "delete_expense",
                expenseId: editing.id,
                expectedVersion: editing.version,
              });
            }
          }}
        >
          刪除此筆支出
        </Button>
      )}
    </form>
  );
}
