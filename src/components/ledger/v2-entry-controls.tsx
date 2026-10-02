"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { allocationDifference, entryMoney, entryPresentation, entrySummaries } from "@/lib/v2-entry-presentation";
import type { DraftFields, TransactionDraft } from "@/lib/v2-transaction-draft";
import type { User } from "@/lib/types";
import type { EntryControlSurface } from "./v2-transaction-editor";

// An unapplied selection patch, not a transaction draft or command owner.
// Cancel drops this patch; Apply hands it to the existing P1-B owner.
export function V2EntryControls({ surface, draft, user, partner, locked, onApply, onCancel }: {
  surface: EntryControlSurface; draft: TransactionDraft; user: User; partner: User; locked: boolean;
  onApply: (patch: Partial<DraftFields>) => void; onCancel: () => void;
}) {
  const [patch, setPatch] = React.useState<Partial<DraftFields>>({});
  const [composing, setComposing] = React.useState(false);
  const candidate = { ...draft, ...patch };
  const change = (next: Partial<DraftFields>) => setPatch(current => ({ ...current, ...next }));
  const { payer, split } = entryPresentation(candidate);
  const labels = { [user.id]: user.label, [partner.id]: partner.label };
  const summary = entrySummaries(candidate, labels);
  const isPayer = surface === "payer";
  const semantics = candidate.type === "income" ? "收款" : candidate.type === "transfer" ? "發送" : "付款";
  const allocationWord = candidate.type === "income" ? "分配" : "分攤";
  const selectionLabel = isPayer ? `${semantics}人` : `${allocationWord}方式`;
  const result = isPayer ? payer : split;
  const error = candidate.amountTwd && !result.command ? result.error : "";
  const difference = isPayer && candidate.paymentMode === "both" && candidate.type !== "transfer" ? allocationDifference(candidate.amountTwd, candidate.selfPayment, candidate.partnerPayment) : !isPayer && candidate.splitMode === "exact" ? allocationDifference(candidate.amountTwd, candidate.selfShare, candidate.partnerShare) : "";
  const message = difference || error;
  const input = (field: "selfPayment" | "partnerPayment" | "selfShare" | "partnerShare" | "selfPercentage" | "partnerPercentage", label: string, decimal = false) => <div data-member-id={field.startsWith("self") ? user.id : partner.id} className="min-w-0 space-y-1"><label htmlFor={`entry-control-${field}`} className="block text-sm font-semibold">{label}</label><Input id={`entry-control-${field}`} value={candidate[field]} inputMode={decimal ? "decimal" : "numeric"} onChange={event => change({ [field]: event.target.value })} aria-label={label} aria-invalid={Boolean(message)} aria-describedby={message ? "entry-control-error" : undefined} /></div>;
  return <div className="space-y-3" onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} onKeyDown={event => { if (event.key === "Enter" && (event.target instanceof HTMLInputElement || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault(); }}>
    <fieldset disabled={locked} className="min-w-0 space-y-3">
      <label htmlFor="entry-control-mode" className="block text-sm font-semibold">{selectionLabel}</label>
      <select id="entry-control-mode" value={isPayer ? candidate.paymentMode : candidate.splitMode} aria-label={selectionLabel} aria-invalid={Boolean(message)} aria-describedby={message ? "entry-control-error" : undefined} onChange={event => change(isPayer ? { paymentMode: event.target.value as DraftFields["paymentMode"] } : { splitMode: event.target.value as DraftFields["splitMode"] })} className="h-11 min-h-11 w-full min-w-0 appearance-none rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 text-base focus-visible:outline-2 focus-visible:outline-accent">
        {isPayer ? <>
          {candidate.type === "transfer" && candidate.paymentMode === "both" ? <option value="both" disabled>請選擇一位發送人</option> : null}
          {draft.memberIds.map(id => <option key={id} value={id === user.id ? "self" : "partner"}>{labels[id]} {semantics}</option>)}
          {candidate.type !== "transfer" ? <option value="both">兩人{semantics}</option> : null}
        </> : <><option value="weights">開啟時的帳本預設</option><option value="equal">{candidate.type === "income" ? "平均分配" : "平均分"}</option><option value="percentage">百分比</option><option value="exact">指定金額</option></>}
      </select>
      {isPayer && candidate.paymentMode === "both" && candidate.type !== "transfer" ? <div className="grid grid-cols-1 gap-3 min-[380px]:grid-cols-2">{draft.memberIds.map(id => <React.Fragment key={id}>{input(id === user.id ? "selfPayment" : "partnerPayment", `${labels[id]} 金額`)}</React.Fragment>)}</div> : null}
      {!isPayer && candidate.splitMode === "percentage" ? <div className="grid grid-cols-1 gap-3 min-[380px]:grid-cols-2">{draft.memberIds.map(id => <React.Fragment key={id}>{input(id === user.id ? "selfPercentage" : "partnerPercentage", `${labels[id]} 百分比`, true)}</React.Fragment>)}</div> : null}
      {!isPayer && candidate.splitMode === "exact" ? <div className="grid grid-cols-1 gap-3 min-[380px]:grid-cols-2">{draft.memberIds.map(id => <React.Fragment key={id}>{input(id === user.id ? "selfShare" : "partnerShare", `${labels[id]} ${allocationWord}`)}</React.Fragment>)}</div> : null}
      <p className="break-words text-base">{isPayer ? summary.payerSummary : summary.splitSummary}</p>
      {!isPayer && summary.shares ? <p data-testid="split-control-preview" className="break-words text-base">{candidate.type === "income" ? "款項分配" : "分攤金額"}：{summary.shares.map(share => `${labels[share.userId]} ${entryMoney(share.amountTwd)}`).join("／")}</p> : null}
      {!isPayer && candidate.splitMode === "weights" ? <p className="text-sm text-[var(--muted-foreground)]">本筆依開啟時的預設：{draft.memberIds.map(id => `${labels[id]} ${draft.defaultShares[id]}`).join("／")}</p> : null}
      {message ? <p id="entry-control-error" role="status" className="text-sm text-destructive">{message}</p> : null}
    </fieldset>
    <div className="flex flex-wrap gap-2"><Button tabIndex={0} variant="ghost" onClick={onCancel}>取消</Button><Button tabIndex={0} onClick={() => onApply(patch)} disabled={locked || composing}>套用</Button></div>
  </div>;
}
