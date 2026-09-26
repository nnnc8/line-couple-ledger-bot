"use client";

import * as React from "react";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { draftPreview, type DraftFields, type TransactionDraft } from "@/lib/v2-transaction-draft";
import { money } from "@/lib/format";
import type { User } from "@/lib/types";

type PaymentMode = DraftFields["paymentMode"];
type SplitMode = DraftFields["splitMode"];
type TransactionType = DraftFields["type"];

export function V2TransactionEditor({ user, partner, draft, categoryOptions = [], submitLabel = "儲存交易", busy = false, locked = false, errorField, onChange, onSubmit, onCancel }: {
  user: User;
  partner: User;
  draft: TransactionDraft;
  categoryOptions?: Array<{ id: string; name: string }>;
  submitLabel?: string;
  busy?: boolean;
  locked?: boolean;
  errorField?: keyof DraftFields;
  onChange: (patch: Partial<DraftFields>) => void;
  onSubmit: () => Promise<void>;
  onCancel?: () => void;
}) {
  const { amountTwd: amount, description, occurredOn, category, categoryId, note, type: transactionType, paymentMode, selfPayment, partnerPayment, splitMode, selfShare, partnerShare, selfPercentage, partnerPercentage, defaultShares } = draft;
  const [showMore, setShowMore] = React.useState(draft.operationType === "replace");
  const amountInputRef = React.useRef<HTMLInputElement>(null);
  const preview = draftPreview(draft);
  const setAmount = (amountTwd: string) => onChange({ amountTwd });
  const setDescription = (description: string) => onChange({ description });
  const setOccurredOn = (occurredOn: string) => onChange({ occurredOn });
  const setCategory = (category: string) => onChange({ category });
  const setNote = (note: string) => onChange({ note });
  const setTransactionType = (type: TransactionType) => onChange({ type });
  const setPaymentMode = (paymentMode: PaymentMode) => onChange({ paymentMode });
  const setSelfPayment = (selfPayment: string) => onChange({ selfPayment });
  const setPartnerPayment = (partnerPayment: string) => onChange({ partnerPayment });
  const setSplitMode = (splitMode: SplitMode) => onChange({ splitMode });
  const setSelfShare = (selfShare: string) => onChange({ selfShare });
  const setPartnerShare = (partnerShare: string) => onChange({ partnerShare });
  const setSelfPercentage = (selfPercentage: string) => onChange({ selfPercentage });
  const setPartnerPercentage = (partnerPercentage: string) => onChange({ partnerPercentage });
  return (
    <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void onSubmit(); }} aria-busy={busy}>
      <fieldset disabled={busy || locked} className="min-w-0 space-y-3">
      <div className="grid grid-cols-[1fr_1.7fr] gap-2">
        <Input ref={amountInputRef} inputMode="numeric" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="金額" aria-label="金額（新台幣）" aria-invalid={errorField === "amountTwd"} aria-describedby={errorField === "amountTwd" ? "entry-error" : undefined} />
        <Input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="用途" aria-label="用途" maxLength={120} aria-invalid={errorField === "description"} aria-describedby={errorField === "description" ? "entry-error" : undefined} />
      </div>
      <p className="text-sm text-[var(--muted-foreground)]">{paymentMode === "both" ? "兩人共同" : paymentMode === "self" ? user.label : partner.label}{transactionType === "income" ? "收款" : transactionType === "transfer" ? "發送" : "付款"} · {transactionType === "transfer" ? "轉帳" : splitMode === "weights" ? "本筆依開啟時的預設" : draft.operationType === "replace" && splitMode === "exact" ? "沿用這筆分攤" : splitMode === "exact" ? "指定分攤金額" : splitMode === "equal" ? "平均分攤" : "百分比分攤"}</p>
      {preview ? <p className="text-sm" data-testid="entry-preview">{transactionType === "transfer" ? "收款" : "分攤"}：{preview.shares.map(share => `${share.userId === user.id ? user.label : partner.label} ${money(Number(share.amountTwd))}`).join("、")}</p> : null}
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
          <Input type="date" value={occurredOn} onChange={(event) => setOccurredOn(event.target.value)} aria-label="交易日期" className="px-0.5" />
          {categoryOptions.length ? <Select ariaLabel="分類" value={categoryId} onValueChange={(value) => { onChange({ categoryId: value, category: categoryOptions.find((option) => option.id === value)?.name ?? "" }); }} options={[{ value: "", label: "未分類" }, ...categoryOptions.map((option) => ({ value: option.id, label: option.name }))]} /> : <Input value={category} onChange={(event) => setCategory(event.target.value)} placeholder="分類（可選）" aria-label="分類" maxLength={40} />}
          <textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="備註（可選）" aria-label="備註" maxLength={1000} className="min-h-20 w-full rounded-xl border-[1.5px] border-[var(--border)] bg-[var(--card)] px-3 py-2 text-base outline-none focus:border-accent focus:ring-2 focus:ring-[var(--accent-glow)]" />
        </div>
      </details>
      </fieldset>
      <div className="flex gap-2">
        {onCancel ? <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy || locked}>取消</Button> : null}
        <Button type="submit" variant="primary" size={onCancel ? "sm" : "block"} className={onCancel ? undefined : "flex-1"} disabled={busy || locked}>{busy ? <><LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> 儲存中…</> : submitLabel}</Button>
      </div>
    </form>
  );
}
