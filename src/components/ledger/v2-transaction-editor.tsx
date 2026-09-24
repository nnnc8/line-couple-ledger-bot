"use client";

import * as React from "react";
import { LoaderCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { User, V2LedgerBootstrap } from "@/lib/types";

type PaymentMode = "self" | "partner" | "both";
type SplitMode = "equal" | "weights" | "percentage" | "exact";
type TransactionType = "expense" | "income" | "transfer";

export type TransactionEditorValue = {
  type: TransactionType;
  amountTwd: string;
  occurredOn: string;
  description: string;
  category: string | null;
  categoryId: string | null;
  note: string | null;
  splitMethod: "none" | SplitMode;
  payments: Array<{ userId: string; amountTwd: string }>;
  shares?: Array<{ userId: string; amountTwd: string }>;
  percentages?: [number, number];
  exactShares?: Record<string, string>;
};

type TransactionDraft = V2LedgerBootstrap["transactions"][number];

export function V2TransactionEditor({
  user,
  partner,
  today,
  defaultShares = {},
  categoryOptions = [],
  initial,
  submitLabel = "儲存",
  busy = false,
  onDraftChange,
  onSubmit,
  onCancel,
}: {
  user: User;
  partner: User;
  today: string;
  defaultShares?: Record<string, string>;
  categoryOptions?: Array<{ id: string; name: string }>;
  initial?: TransactionDraft;
  submitLabel?: string;
  busy?: boolean;
  onDraftChange?: () => void;
  onSubmit: (value: TransactionEditorValue) => Promise<boolean>;
  onCancel?: () => void;
}) {
  const initialPayments = initial?.payments ?? [{ userId: user.id, amountTwd: "" }];
  const initialPaymentMode: PaymentMode = initialPayments.length > 1
    ? "both"
    : initialPayments[0]?.userId === partner.id ? "partner" : "self";
  const initialSplitMode: SplitMode = initial?.splitMethod && initial.splitMethod !== "none"
    ? initial.splitMethod
    : "weights";
  const [amount, setAmount] = React.useState(initial?.amountTwd ?? "");
  const [description, setDescription] = React.useState(initial?.description ?? "");
  const [occurredOn, setOccurredOn] = React.useState(initial?.occurredOn ?? today);
  const [category, setCategory] = React.useState(initial?.category ?? "");
  const [categoryId, setCategoryId] = React.useState(initial?.categoryId ?? "");
  const [note, setNote] = React.useState(initial?.note ?? "");
  const [transactionType, setTransactionType] = React.useState<TransactionType>(initial?.type ?? "expense");
  const [paymentMode, setPaymentMode] = React.useState<PaymentMode>(initialPaymentMode);
  const [selfPayment, setSelfPayment] = React.useState(initialPayments.find((payment) => payment.userId === user.id)?.amountTwd ?? "");
  const [partnerPayment, setPartnerPayment] = React.useState(initialPayments.find((payment) => payment.userId === partner.id)?.amountTwd ?? "");
  const [splitMode, setSplitMode] = React.useState<SplitMode>(initialSplitMode);
  const [selfShare, setSelfShare] = React.useState(initial?.shares?.find((share) => share.userId === user.id)?.amountTwd ?? "");
  const [partnerShare, setPartnerShare] = React.useState(initial?.shares?.find((share) => share.userId === partner.id)?.amountTwd ?? "");
  const initialSelfPercentage = initial?.type !== "transfer" && initial?.amountTwd && initial.shares
    ? ((Number(initial.shares.find((share) => share.userId === user.id)?.amountTwd ?? "0") / Number(initial.amountTwd)) * 100).toFixed(2).replace(/\.00$/, "")
    : "50";
  const initialPartnerPercentage = initial?.type !== "transfer" && initial?.amountTwd && initial.shares
    ? ((Number(initial.shares.find((share) => share.userId === partner.id)?.amountTwd ?? "0") / Number(initial.amountTwd)) * 100).toFixed(2).replace(/\.00$/, "")
    : "50";
  const [selfPercentage, setSelfPercentage] = React.useState(initialSelfPercentage);
  const [partnerPercentage, setPartnerPercentage] = React.useState(initialPartnerPercentage);
  const [formError, setFormError] = React.useState("");
  const [showMore, setShowMore] = React.useState(Boolean(initial));
  const amountInputRef = React.useRef<HTMLInputElement>(null);

  const amountNumber = Number(amount);
  const paymentTotal = paymentMode === "both"
    ? Number(selfPayment || 0) + Number(partnerPayment || 0)
    : amountNumber;
  const exactTotal = Number(selfShare || 0) + Number(partnerShare || 0);
  const percentageTotal = Number(selfPercentage || 0) + Number(partnerPercentage || 0);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setFormError("");
    if (!Number.isSafeInteger(amountNumber) || amountNumber <= 0) {
      setFormError("請輸入正確的新台幣整數金額");
      return;
    }
    if (!description.trim()) {
      setFormError("請輸入用途");
      return;
    }
    if (transactionType === "transfer" && paymentMode === "both") {
      setFormError("轉帳一次只能指定一位發送人");
      return;
    }
    if (!Number.isSafeInteger(paymentTotal) || paymentTotal !== amountNumber) {
      setFormError(transactionType === "income" ? "收款合計必須等於總額" : "付款合計必須等於總額");
      return;
    }
    if (transactionType !== "transfer" && splitMode === "exact" && exactTotal !== amountNumber) {
      setFormError("兩位成員的分攤合計必須等於總額");
      return;
    }
    if (transactionType !== "transfer" && splitMode === "percentage" && percentageTotal !== 100) {
      setFormError("百分比分攤合計必須等於 100%");
      return;
    }
    const payerId = paymentMode === "partner" ? partner.id : user.id;
    const receiverId = payerId === user.id ? partner.id : user.id;
    const payments = paymentMode === "both"
      ? [
          { userId: user.id, amountTwd: String(Number(selfPayment || 0)) },
          { userId: partner.id, amountTwd: String(Number(partnerPayment || 0)) },
        ].filter((payment) => Number(payment.amountTwd) > 0)
      : [{ userId: payerId, amountTwd: String(amountNumber) }];
    const value: TransactionEditorValue = {
      type: transactionType,
      amountTwd: String(amountNumber),
      occurredOn,
      description: description.trim(),
      category: category.trim() || null,
      categoryId: categoryId || null,
      note: note.trim() || null,
      splitMethod: transactionType === "transfer" ? "none" : splitMode,
      payments,
      ...(transactionType === "transfer"
        ? { shares: [{ userId: receiverId, amountTwd: String(amountNumber) }] }
        : splitMode === "exact"
          ? { exactShares: { [user.id]: String(Number(selfShare || 0)), [partner.id]: String(Number(partnerShare || 0)) } }
          : splitMode === "percentage"
            ? { percentages: [Number(selfPercentage), Number(partnerPercentage)] as [number, number] }
            : {}),
    };
    const saved = await onSubmit(value);
    if (!saved || initial) return;
    setAmount("");
    setDescription("");
    setOccurredOn(today);
    setCategory("");
    setCategoryId("");
    setNote("");
    setSelfPayment("");
    setPartnerPayment("");
    setSelfShare("");
    setPartnerShare("");
    setTransactionType("expense");
    setPaymentMode("self");
    setSplitMode("weights");
    setSelfPercentage("50");
    setPartnerPercentage("50");
    setShowMore(false);
    window.requestAnimationFrame(() => amountInputRef.current?.focus());
  }

  return (
    <form className="space-y-3" onSubmit={(event) => void submit(event)} onChange={onDraftChange} aria-busy={busy}>
      <fieldset disabled={busy} className="min-w-0 space-y-3">
      <div className="grid grid-cols-[1fr_1.7fr] gap-2">
        <Input ref={amountInputRef} inputMode="numeric" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="金額" aria-label="金額（新台幣）" />
        <Input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="用途" aria-label="用途" />
      </div>
      <p className="text-sm text-[var(--muted-foreground)]">{user.label} 付款 · 套用這本帳本的預設分攤</p>
      <details className="rounded-xl border border-[var(--border)] px-2 py-2" open={showMore} onToggle={(event) => setShowMore(event.currentTarget.open)}>
        <summary className="flex min-h-11 cursor-pointer items-center text-base font-semibold">更多設定</summary>
        <div className="mt-3 space-y-2">
          <Select ariaLabel="交易類型" value={transactionType} onValueChange={(value) => { const next = value as TransactionType; setTransactionType(next); if (next === "transfer" && paymentMode === "both") setPaymentMode("self"); }} options={[{ value: "expense", label: "支出" }, { value: "income", label: "收入／退款" }, { value: "transfer", label: "轉帳" }]} />
          <Select
            ariaLabel={transactionType === "income" ? "收款人" : transactionType === "transfer" ? "發送人" : "付款人"}
            value={paymentMode}
            onValueChange={(value) => setPaymentMode(value as PaymentMode)}
            options={[{ value: "self", label: transactionType === "income" ? `${user.label} 收到` : transactionType === "transfer" ? `${user.label} 發送` : `${user.label} 付款` }, { value: "partner", label: transactionType === "income" ? `${partner.label} 收到` : transactionType === "transfer" ? `${partner.label} 發送` : `${partner.label} 付款` }, ...(transactionType === "transfer" ? [] : [{ value: "both", label: transactionType === "income" ? "兩人共同收到" : "兩人共同付款" }])]}
          />
          {paymentMode === "both" ? <div className="grid grid-cols-2 gap-2"><Input inputMode="numeric" value={selfPayment} onChange={(event) => setSelfPayment(event.target.value)} placeholder={`${user.label} ${transactionType === "income" ? "收到" : "付"}`} aria-label={`${user.label} 金額`} /><Input inputMode="numeric" value={partnerPayment} onChange={(event) => setPartnerPayment(event.target.value)} placeholder={`${partner.label} ${transactionType === "income" ? "收到" : "付"}`} aria-label={`${partner.label} 金額`} /></div> : null}
          {transactionType === "transfer" ? <p className="text-xs text-[var(--muted-foreground)]">轉帳會記錄發送人 → 接收人，不會出現支出分攤選項。</p> : <>
            <Select ariaLabel="分攤方式" value={splitMode} onValueChange={(value) => setSplitMode(value as SplitMode)} options={[{ value: "equal", label: "平均分 50 / 50" }, { value: "weights", label: `套用帳本預設（${defaultShares[user.id] ?? "1"} / ${defaultShares[partner.id] ?? "1"}）` }, { value: "percentage", label: "百分比" }, { value: "exact", label: "指定分攤金額" }]} />
            {splitMode === "percentage" ? <div className="grid grid-cols-2 gap-2"><Input inputMode="decimal" value={selfPercentage} onChange={(event) => setSelfPercentage(event.target.value)} placeholder={`${user.label} %`} aria-label={`${user.label} 百分比`} /><Input inputMode="decimal" value={partnerPercentage} onChange={(event) => setPartnerPercentage(event.target.value)} placeholder={`${partner.label} %`} aria-label={`${partner.label} 百分比`} /></div> : null}
            {splitMode === "exact" ? <div className="grid grid-cols-2 gap-2"><Input inputMode="numeric" value={selfShare} onChange={(event) => setSelfShare(event.target.value)} placeholder={`${user.label} 分攤`} aria-label={`${user.label} 分攤`} /><Input inputMode="numeric" value={partnerShare} onChange={(event) => setPartnerShare(event.target.value)} placeholder={`${partner.label} 分攤`} aria-label={`${partner.label} 分攤`} /></div> : null}
            {splitMode === "equal" ? <p className="text-xs text-[var(--muted-foreground)]">每位成員各 50%；奇數金額的餘數固定給帳本中的第一位成員。</p> : null}
          </>}
          <Input type="date" value={occurredOn} onChange={(event) => setOccurredOn(event.target.value)} aria-label="交易日期" className="px-1" />
          {categoryOptions.length ? <Select ariaLabel="分類" value={categoryId} onValueChange={(value) => { setCategoryId(value); setCategory(categoryOptions.find((option) => option.id === value)?.name ?? ""); }} options={[{ value: "", label: "未分類" }, ...categoryOptions.map((option) => ({ value: option.id, label: option.name }))]} /> : <Input value={category} onChange={(event) => setCategory(event.target.value)} placeholder="分類（可選）" aria-label="分類" maxLength={40} />}
          <textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="備註（可選）" aria-label="備註" maxLength={1000} className="min-h-20 w-full rounded-xl border-[1.5px] border-[var(--border)] bg-[var(--card)] px-3 py-2 text-base outline-none focus:border-accent focus:ring-2 focus:ring-[var(--accent-glow)]" />
        </div>
      </details>
      {formError ? <p className="text-sm font-medium text-destructive" role="alert">{formError}</p> : null}
      </fieldset>
      <div className="flex gap-2">
        {onCancel ? <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>取消</Button> : null}
        <Button type="submit" variant="primary" size={onCancel ? "sm" : "block"} className={onCancel ? undefined : "flex-1"} disabled={busy}>{busy ? <><LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> 儲存中…</> : submitLabel}</Button>
      </div>
    </form>
  );
}
