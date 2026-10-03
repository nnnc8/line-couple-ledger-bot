"use client";

import * as React from "react";
import { Paperclip } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { api, ApiError } from "@/lib/api";
import type { User, V2Attachment, V2Category, V2LedgerTransaction } from "@/lib/types";
import { timelineMoney, timelinePurpose, timelineTransferDirection, timelineTypeLabel } from "@/lib/v2-timeline";
import { transactionStatusProof, type TransactionStatusProof } from "@/lib/v2-transaction-status";

type Props = {
  transaction: V2LedgerTransaction;
  transactions: readonly V2LedgerTransaction[];
  userId: string;
  users: readonly User[];
  categories: readonly V2Category[];
  entryLocked: boolean;
  onEdit: () => void;
  onOpenTransaction: (id: string) => void;
  onConfirmedMutation: (proof: TransactionStatusProof, action: "void" | "restore") => void;
  onChanged: () => Promise<unknown>;
};

export function TransactionDetail({ transaction, transactions, userId, users, categories, entryLocked, onEdit, onOpenTransaction, onConfirmedMutation, onChanged }: Props) {
  const [more, setMore] = React.useState(false);
  const [confirmation, setConfirmation] = React.useState<"void" | "restore" | null>(null);
  const [busy, setBusy] = React.useState(false);
  const actionInFlight = React.useRef(false);
  const mutationIntent = React.useRef<{ transaction: V2LedgerTransaction; action: "void" | "restore" } | null>(null);
  const [actionMessage, setActionMessage] = React.useState("");
  const [attachments, setAttachments] = React.useState<V2Attachment[]>([]);
  const [attachmentsLoaded, setAttachmentsLoaded] = React.useState(false);
  const [attachmentBusy, setAttachmentBusy] = React.useState(false);
  const attachmentInFlight = React.useRef(false);
  const [attachmentMessage, setAttachmentMessage] = React.useState("");
  const mounted = React.useRef(false);
  const attachmentRead = React.useRef(0);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; attachmentRead.current += 1; }; }, []);
  const purpose = timelinePurpose(transaction);
  const type = timelineTypeLabel(transaction.type);
  const category = transaction.category ?? categories.find(item => item.id === transaction.categoryId)?.name;
  const replaced = Boolean(transaction.replacedByTransactionId);
  const current = transaction.status === "posted";
  const knownLink = (id: string | null | undefined) => id && transactions.some(row => row.id === id && row.ledgerId === transaction.ledgerId) ? id : null;
  const newer = knownLink(transaction.replacedByTransactionId);
  const prior = knownLink(transaction.replacesTransactionId);
  const memberName = (id: string) => id === userId ? "你" : users.find(user => user.id === id) ? "另一半" : "成員";

  async function loadAttachments() {
    const request = ++attachmentRead.current;
    const response = await fetch(`/api/app/v2/transactions/${transaction.id}/attachments`, { cache: "no-store", credentials: "same-origin" });
    const body = await response.json() as { attachments?: V2Attachment[]; error?: string };
    if (!response.ok) throw new Error(body.error ?? "無法讀取收據");
    if (!mounted.current || request !== attachmentRead.current) return;
    setAttachments(body.attachments ?? []);
    setAttachmentsLoaded(true);
  }

  async function mutate(action: "void" | "restore") {
    if (actionInFlight.current || entryLocked) return;
    actionInFlight.current = true;
    setBusy(true);
    setActionMessage("");
    let confirmed = false;
    const success = action === "void" ? "已作廢" : "已恢復";
    const target = mutationIntent.current?.action === action ? mutationIntent.current.transaction : transaction;
    try {
      const result = await api(`/api/app/v2/transactions/${target.id}/mutate`, {
        action, expectedVersion: target.version ?? 1,
        idempotencyKey: `v2:transaction:${target.id}:${action}:${target.version ?? 1}`,
      });
      const proof = transactionStatusProof(result, target, action);
      if (!proof) throw new Error("操作結果尚未確認，請重新讀取內容；再次確認會沿用原操作。");
      confirmed = true;
      mutationIntent.current = null;
      onConfirmedMutation(proof, action);
      if (mounted.current) { setConfirmation(null); setActionMessage(`${success}。正在更新內容與近況…`); }
      await onChanged();
      if (mounted.current) setActionMessage(success);
    } catch (reason) {
      if (mounted.current) {
        if (confirmed) setActionMessage(`${success}。內容與近況暫時無法更新，請重新整理。`);
        else setActionMessage(reason instanceof ApiError && [400, 401, 403, 404, 409, 422].includes(reason.status)
          ? reason.message : `尚未確認是否${action === "void" ? "已作廢" : "已恢復"}。請重新讀取內容；再次確認會沿用原操作。`);
      }
    } finally {
      actionInFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function uploadReceipt(file: File) {
    if (attachmentInFlight.current) return;
    if (file.size > 10 * 1024 * 1024) { setAttachmentMessage("收據必須小於 10 MB"); return; }
    attachmentInFlight.current = true;
    setAttachmentBusy(true); setAttachmentMessage("");
    let complete = false;
    try {
      const result = await api("/api/app/v2/attachments", { ledgerId: transaction.ledgerId, transactionId: transaction.id,
        fileName: file.name, mimeType: file.type, sizeBytes: file.size }) as unknown as { attachment: { id: string }; signedUpload: { signedUrl: string } };
      const response = await fetch(result.signedUpload.signedUrl, { method: "PUT", headers: { "content-type": file.type }, body: file });
      if (!response.ok) throw new Error("收據上傳失敗");
      await api(`/api/app/v2/attachments/${result.attachment.id}/complete`, {});
      complete = true;
      await loadAttachments();
      if (mounted.current) setAttachmentMessage("收據已上傳");
    } catch (reason) {
      if (mounted.current) setAttachmentMessage(complete ? "收據已上傳，收據清單暫時無法更新。" : reason instanceof Error ? reason.message : "收據上傳失敗");
    } finally { attachmentInFlight.current = false; if (mounted.current) setAttachmentBusy(false); }
  }
  async function deleteReceipt(attachment: V2Attachment) {
    if (attachmentInFlight.current) return;
    attachmentInFlight.current = true; setAttachmentBusy(true); setAttachmentMessage("");
    let complete = false;
    try {
      await api(`/api/app/v2/attachments/${attachment.id}`, undefined, { method: "DELETE" });
      complete = true;
      if (mounted.current) setAttachments(rows => rows.filter(row => row.id !== attachment.id));
      await loadAttachments();
      if (mounted.current) setAttachmentMessage("收據已刪除");
    } catch (reason) {
      if (mounted.current) setAttachmentMessage(complete ? "收據已刪除，收據清單暫時無法更新。" : reason instanceof Error ? reason.message : "收據刪除失敗");
    } finally { attachmentInFlight.current = false; if (mounted.current) setAttachmentBusy(false); }
  }

  return <article data-testid="transaction-detail" className="detail-enter space-y-4 [overflow-wrap:anywhere]">
    <Card className="space-y-4 p-4">
      <h2 data-detail-heading tabIndex={-1} className="text-xl font-bold">{purpose}</h2>
      <p className="text-xl font-bold tabular-nums [overflow-wrap:anywhere]" data-testid="detail-amount">{transaction.type === "income" ? "＋" : ""}{timelineMoney(transaction.amountTwd)}</p>
      <dl className="space-y-3 text-base">
        <div><dt className="text-sm text-[var(--muted-foreground)]">類型</dt><dd>{type}</dd></div>
        <div><dt className="text-sm text-[var(--muted-foreground)]">狀態</dt><dd>{replaced ? "這筆已更新" : transaction.status === "voided" ? "已作廢，不計入目前近況" : transaction.status === "deleted" ? "已刪除，不計入目前近況" : "已入帳"}</dd></div>
        <div><dt className="text-sm text-[var(--muted-foreground)]">發生日期</dt><dd>{transaction.occurredOn ?? "日期未提供"}</dd></div>
      </dl>
      {transaction.status === "voided" && replaced ? <p>已作廢，不計入目前近況</p> : null}
      {newer ? <Button variant="outline" className="h-auto min-h-11 whitespace-normal" onClick={() => onOpenTransaction(newer)}>查看新版</Button> : null}
      {prior ? <Button variant="ghost" className="h-auto min-h-11 whitespace-normal" onClick={() => onOpenTransaction(prior)}>查看更新前紀錄</Button> : null}
    </Card>
    <Card className="space-y-4 p-4">
      {transaction.type === "transfer" ? <section aria-labelledby="detail-direction"><h3 id="detail-direction" className="font-bold">轉帳方向</h3><p className="mt-2">{timelineTransferDirection(transaction, userId)}</p></section> : null}
      <section aria-labelledby="detail-payments"><h3 id="detail-payments" className="font-bold">{transaction.type === "income" ? "收款" : transaction.type === "transfer" ? "發送金額" : "付款"}</h3>
        <dl className="mt-2 space-y-2">{transaction.payments.map(part => <div key={part.userId} className="flex flex-wrap justify-between gap-x-4 gap-y-1"><dt>{memberName(part.userId)}</dt><dd className="tabular-nums">{timelineMoney(part.amountTwd)}</dd></div>)}</dl>
      </section>
      <section aria-labelledby="detail-shares"><h3 id="detail-shares" className="font-bold">{transaction.type === "income" ? "款項分配" : transaction.type === "transfer" ? "接收金額" : "分攤"}</h3>
        <dl className="mt-2 space-y-2">{transaction.shares.map(part => <div key={part.userId} className="flex flex-wrap justify-between gap-x-4 gap-y-1"><dt>{memberName(part.userId)}</dt><dd className="tabular-nums">{timelineMoney(part.amountTwd)}</dd></div>)}</dl>
      </section>
      {transaction.type === "income" ? <p className="text-sm text-[var(--muted-foreground)]">收入／退款由收款人收到，款項分配代表兩人的權益。</p> : null}
      <section aria-labelledby="detail-category"><h3 id="detail-category" className="font-bold">分類</h3><p className="mt-2">{category ?? "未分類"}</p></section>
      <section aria-labelledby="detail-note"><h3 id="detail-note" className="font-bold">備註</h3><p className="mt-2 whitespace-pre-wrap">{transaction.note || "沒有備註"}</p></section>
    </Card>
    <Card className="p-4">
      <Button variant="ghost" aria-expanded={more} aria-controls="transaction-more-actions" className="h-auto min-h-11 w-full justify-start whitespace-normal" onClick={() => {
        setMore(value => !value);
        if (!more) void loadAttachments().catch(reason => { if (mounted.current) setAttachmentMessage(reason instanceof Error ? reason.message : "無法讀取收據"); });
      }}>更多操作</Button>
      {more ? <div id="transaction-more-actions" className="mt-3 space-y-4">
        <div className="flex flex-wrap gap-2">
          {current ? <><Button data-testid="transaction-edit" variant="outline" disabled={busy || entryLocked} onClick={onEdit}>修改</Button><Button variant="danger" disabled={busy || entryLocked} onClick={() => { mutationIntent.current = { transaction: structuredClone(transaction), action: "void" }; setConfirmation("void"); setActionMessage(""); }}>作廢</Button></> : null}
          {transaction.status === "voided" ? <Button variant="outline" disabled={busy || entryLocked} onClick={() => { mutationIntent.current = { transaction: structuredClone(transaction), action: "restore" }; setConfirmation("restore"); setActionMessage(""); }}>恢復</Button> : null}
        </div>
        {confirmation ? <section aria-label={confirmation === "void" ? "確認作廢紀錄" : "確認恢復紀錄"} className="space-y-3 rounded-xl border p-3">
          <p>{confirmation === "void" ? "作廢" : "恢復"}「{purpose}」？</p><p>{type} · {timelineMoney(transaction.amountTwd)} · {transaction.occurredOn ?? "日期未提供"}</p>
          <div className="flex flex-wrap gap-2"><Button variant={confirmation === "void" ? "danger" : "primary"} disabled={busy || entryLocked} onClick={() => void mutate(confirmation)}>{busy ? "正在處理…" : confirmation === "void" ? "確認作廢" : "確認恢復"}</Button><Button variant="ghost" disabled={busy} onClick={() => setConfirmation(null)}>取消</Button></div>
        </section> : null}
        {actionMessage ? <p role="status" data-testid="mutation-status">{actionMessage}</p> : null}
        <section aria-labelledby="detail-receipts" className="space-y-3 border-t pt-4">
          <h3 id="detail-receipts" className="font-bold">收據</h3>
          <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-base font-semibold focus-within:ring-2 focus-within:ring-accent">
            <Paperclip aria-hidden="true" className="size-4" />{attachmentBusy ? "收據處理中…" : "加收據"}
            <input aria-label="加收據" className="sr-only" type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf" disabled={attachmentBusy} onChange={event => { const file = event.target.files?.[0]; if (file) void uploadReceipt(file); event.currentTarget.value = ""; }} />
          </label>
          <Button variant="ghost" disabled={attachmentBusy} onClick={() => void loadAttachments().catch(reason => setAttachmentMessage(reason instanceof Error ? reason.message : "無法讀取收據"))}>重新讀取收據</Button>
          {attachmentsLoaded && !attachments.length ? <p>尚無收據</p> : null}
          {attachments.map(attachment => <div key={attachment.id} className="flex flex-wrap items-center gap-2">
            {attachment.url ? <a href={attachment.url} target="_blank" rel="noreferrer" className="min-h-11 min-w-0 flex-1 py-2 text-accent underline">{attachment.mimeType === "application/pdf" ? "PDF 收據" : "圖片收據"} · {new Date(attachment.createdAt).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" })}</a> : <span>收據暫時無法開啟</span>}
            <Button variant="ghost" size="sm" disabled={attachmentBusy} onClick={() => void deleteReceipt(attachment)}>刪除收據</Button>
          </div>)}
          {attachmentMessage ? <p role="status" data-testid="attachment-status">{attachmentMessage}</p> : null}
        </section>
      </div> : null}
    </Card>
  </article>;
}

export function TransactionDetailSkeleton() {
  return <div data-testid="transaction-detail-skeleton" role="status" aria-label="正在載入紀錄詳情" className="space-y-4 p-4">
    {[0, 1, 2].map(row => <div key={row} aria-hidden="true" className="h-20 rounded-xl bg-muted" />)}
  </div>;
}
