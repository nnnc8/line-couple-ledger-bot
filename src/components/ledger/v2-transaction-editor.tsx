"use client";

import * as React from "react";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { currentEntryDate, type DraftFields, type TransactionDraft } from "@/lib/v2-transaction-draft";
import { entryMoney, entryPresentation, entrySummaries } from "@/lib/v2-entry-presentation";
import type { User } from "@/lib/types";

export type EntryControlSurface = "payer" | "split";

export function V2TransactionEditor({ user, partner, draft, categoryOptions = [], busy = false, locked = false, scopeValid, errorField, serverError, onChange, onSubmit, onCancel, onOpenControls }: {
  user: User; partner: User; draft: TransactionDraft;
  categoryOptions?: Array<{ id: string; name: string }>;
  busy?: boolean; locked?: boolean; scopeValid: boolean;
  errorField?: keyof DraftFields; serverError?: string;
  onChange: (patch: Partial<DraftFields>) => void;
  onSubmit: () => Promise<void>; onCancel?: () => void;
  onOpenControls: (surface: EntryControlSurface, trigger: HTMLElement) => void;
}) {
  const [showMore, setShowMore] = React.useState(false);
  const [composing, setComposing] = React.useState(false);
  const [touched, setTouched] = React.useState<Array<keyof DraftFields>>([]);
  const composingRef = React.useRef(false);
  const form = React.useRef<HTMLFormElement>(null);
  const purpose = React.useRef<HTMLInputElement>(null);
  const primary = React.useRef<HTMLButtonElement>(null);
  const { validation, payer, split } = entryPresentation(draft);
  const summaries = entrySummaries(draft, { [user.id]: user.label, [partner.id]: partner.label });
  const disabledReason = busy ? "正在處理這筆，請稍候" : locked ? "請先確認已送出操作的結果或帳本存取權限" : !scopeValid ? "目前無法確認這本帳本，請重新讀取" : composing ? "請先完成文字輸入" : validation.error;
  const fieldError = (field: keyof DraftFields) => errorField === field ? serverError : validation.field === field && (Boolean(draft[field]) || touched.includes(field)) ? validation.error : undefined;
  const focusField = React.useCallback((field: keyof DraftFields) => {
    const target = ["paymentMode", "selfPayment", "partnerPayment"].includes(field) ? "paymentMode" : ["splitMode", "selfShare", "partnerShare", "selfPercentage", "partnerPercentage"].includes(field) ? "splitMode" : field;
    requestAnimationFrame(() => {
      if (["occurredOn", "category", "categoryId", "note", "type"].includes(field)) {
        const details = form.current?.querySelector("details");
        if (details) details.open = true;
      }
      const selector = target === "category" || target === "categoryId" ? '[aria-label="分類"]' : target === "type" ? '[aria-label="交易類型"]' : `[data-entry-field="${target}"]`;
      form.current?.querySelector<HTMLElement>(selector)?.focus();
    });
  }, []);
  React.useEffect(() => { if (errorField) focusField(errorField); }, [errorField, focusField]);
  const associate = (field: keyof DraftFields) => ({ "aria-invalid": Boolean(fieldError(field)), "aria-describedby": fieldError(field) ? `entry-${field}-error` : undefined, "data-entry-field": field });
  const inline = (field: keyof DraftFields) => fieldError(field) ? <p id={`entry-${field}-error`} className="text-sm text-destructive">{fieldError(field)}</p> : null;
  const blur = (field: keyof DraftFields) => setTouched(current => current.includes(field) ? current : [...current, field]);
  const submit = () => {
    if (composingRef.current || busy || locked || !scopeValid) return;
    if (!validation.command) { if (validation.field) { blur(validation.field); focusField(validation.field); } return; }
    void onSubmit();
  };
  const categoryChoices = [...categoryOptions];
  if (draft.categoryId && !categoryChoices.some(option => option.id === draft.categoryId)) categoryChoices.push({ id: draft.categoryId, name: draft.category || "原有分類" });
  const noteCharacters = Array.from(draft.note);
  const notePreview = noteCharacters.slice(0, 40).join("") + (noteCharacters.length > 40 ? "…" : "");
  const indications = [draft.type === "income" ? "收入／退款" : draft.type === "transfer" ? "轉帳" : "", draft.occurredOn !== currentEntryDate() ? draft.occurredOn : "", draft.category || (draft.categoryId ? "已選分類" : ""), draft.note ? `備註：${notePreview}` : ""].filter(Boolean);
  return <form ref={form} className="space-y-3" onSubmit={event => { event.preventDefault(); if (validation.field) { blur(validation.field); focusField(validation.field); } }} aria-busy={busy}
    onCompositionStart={() => { composingRef.current = true; setComposing(true); }} onCompositionEnd={() => { composingRef.current = false; setComposing(false); }}
    onKeyDown={event => {
      if (event.key !== "Enter") return;
      if (composingRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) { event.preventDefault(); return; }
      if (event.target instanceof HTMLInputElement) {
        event.preventDefault();
        if (event.target.dataset.entryField === "amountTwd") purpose.current?.focus();
        else if (event.target === purpose.current) { if (!disabledReason) primary.current?.focus(); else purpose.current?.blur(); }
      }
    }}>
    <fieldset disabled={busy || locked} className="min-w-0 space-y-3">
      <div className="space-y-1">
        <label htmlFor="entry-amount" className="block text-sm font-semibold">金額</label>
        <div className="relative"><span aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 text-base">NT$</span><Input id="entry-amount" className="pl-12" inputMode="numeric" enterKeyHint="next" value={draft.amountTwd} onChange={event => onChange({ amountTwd: event.target.value })} onBlur={() => blur("amountTwd")} placeholder="0" aria-label="金額，新臺幣" {...associate("amountTwd")} /></div>
        {draft.amountTwd || touched.includes("amountTwd") ? inline("amountTwd") : null}
      </div>
      <div className="space-y-1">
        <label htmlFor="entry-purpose" className="block text-sm font-semibold">用途</label>
        <Input id="entry-purpose" ref={purpose} value={draft.description} onChange={event => onChange({ description: event.target.value })} onBlur={() => blur("description")} placeholder="晚餐" aria-label="用途" maxLength={120} enterKeyHint="done" {...associate("description")} />
        {draft.description || touched.includes("description") ? inline("description") : null}
      </div>
      <div className="space-y-2">
        <button tabIndex={0} type="button" data-testid="payer-summary" data-entry-field="paymentMode" aria-haspopup="dialog" aria-describedby={!payer.command && draft.amountTwd ? "entry-payer-error" : undefined} className="flex min-h-11 w-full items-center justify-between gap-2 rounded-xl border border-[var(--border)] px-3 py-2 text-left text-base focus-visible:outline-2 focus-visible:outline-accent" onClick={event => onOpenControls("payer", event.currentTarget)}><span className="min-w-0 break-words">{summaries.payerSummary}</span><span aria-hidden="true">›</span></button>
        {!payer.command && draft.amountTwd ? <p id="entry-payer-error" className="text-sm text-destructive">{payer.error}</p> : null}
        {draft.type === "transfer" ? <p className="text-sm text-[var(--muted-foreground)]">轉帳會記錄發送人 → 接收人，不會出現支出分攤選項。</p> : <>
          <button tabIndex={0} type="button" data-testid="split-summary" data-entry-field="splitMode" aria-haspopup="dialog" aria-describedby="entry-split-help" className="flex min-h-11 w-full items-center justify-between gap-2 rounded-xl border border-[var(--border)] px-3 py-2 text-left text-base focus-visible:outline-2 focus-visible:outline-accent" onClick={event => onOpenControls("split", event.currentTarget)}><span className="min-w-0 break-words">{summaries.splitSummary}</span><span aria-hidden="true">›</span></button>
          <p id="entry-split-help" className={`text-sm ${!split.command && draft.amountTwd ? "text-destructive" : "text-[var(--muted-foreground)]"}`}>{!split.command && draft.amountTwd ? split.error : draft.splitMode === "weights" ? "本筆依開啟時的預設" : draft.splitMode === "equal" ? "奇數金額的餘數固定給帳本中的第一位成員" : ""}</p>
        </>}
        {summaries.shares ? <p className="text-sm text-[var(--muted-foreground)]" data-testid="entry-preview">{draft.type === "transfer" ? "收款" : draft.type === "income" ? "款項分配" : "分攤"}：{summaries.shares.map(share => `${share.userId === user.id ? user.label : partner.label} ${entryMoney(share.amountTwd)}`).join("、")}</p> : null}
      </div>
      <details className="rounded-xl border border-[var(--border)] px-2" open={showMore} onToggle={event => setShowMore(event.currentTarget.open)}>
        <summary className="flex min-h-11 cursor-pointer items-center text-base font-semibold">更多</summary>
        <div className="mt-2 space-y-3 pb-3">
          <Select ariaLabel="交易類型" value={draft.type} onValueChange={value => onChange({ type: value as DraftFields["type"] })} options={[{ value: "expense", label: "支出" }, { value: "income", label: "收入／退款" }, { value: "transfer", label: "轉帳" }]} />
          <div><label htmlFor="entry-date" className="block text-sm font-semibold">交易日期</label><Input id="entry-date" type="date" value={draft.occurredOn} onChange={event => onChange({ occurredOn: event.target.value })} aria-label="交易日期" className="px-0.5" {...associate("occurredOn")} />{inline("occurredOn")}</div>
          {categoryChoices.length ? <Select ariaLabel="分類" value={draft.categoryId} onValueChange={value => onChange({ categoryId: value, category: categoryChoices.find(option => option.id === value)?.name ?? "" })} options={[{ value: "", label: "未分類" }, ...categoryChoices.map(option => ({ value: option.id, label: option.name }))]} /> : <div><Input value={draft.category} onChange={event => onChange({ category: event.target.value })} placeholder="分類（可選）" aria-label="分類" maxLength={40} {...associate("category")} />{inline("category")}</div>}
          <div><textarea value={draft.note} onChange={event => onChange({ note: event.target.value })} placeholder="備註（可選）" aria-label="備註" maxLength={1000} {...associate("note")} className="min-h-20 w-full rounded-xl border-[1.5px] border-[var(--border)] bg-[var(--card)] px-3 py-2 text-base outline-none focus:border-accent focus:ring-2 focus:ring-[var(--accent-glow)]" />{inline("note")}</div>
        </div>
      </details>
      {!showMore && indications.length ? <p data-testid="entry-more-summary" className="break-words text-sm text-[var(--muted-foreground)]">{indications.join(" · ")}</p> : null}
    </fieldset>
    {disabledReason ? <p id="entry-disabled-reason" role="status" className="text-sm text-[var(--muted-foreground)]">{disabledReason}</p> : null}
    <div className="flex gap-2">
      {onCancel ? <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy || locked}>取消</Button> : null}
      <button tabIndex={0} ref={primary} type="button" className="flex min-h-12 flex-1 items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2 text-base font-semibold text-primary-foreground disabled:opacity-50" disabled={Boolean(disabledReason)} aria-describedby={disabledReason ? "entry-disabled-reason" : undefined} onClick={submit}>{busy ? <><LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> 儲存中…</> : draft.operationType === "replace" ? "儲存修改" : "加入"}</button>
    </div>
  </form>;
}
