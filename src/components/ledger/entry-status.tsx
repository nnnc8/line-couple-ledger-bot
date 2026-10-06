"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import type { V2EntrySession } from "@/hooks/use-v2-entry-session";
import { commandOf } from "@/lib/v2-entry-operation";
import { money } from "@/lib/format";
import { timelineDateLabel } from "@/lib/v2-timeline";

/** One status location at a time, using only the existing owner's outcome. */
export function EntryStatus({ entry, ledgerId, today, onView }: {
  entry: V2EntrySession; ledgerId: string | null; today?: string; onView?: () => void;
}) {
  const [slowOperation, setSlowOperation] = React.useState<string | null>(null);
  const operation = entry.operation?.ledgerId === ledgerId ? entry.operation : null;
  const submitting = Boolean(operation && entry.write === "submitting");
  React.useEffect(() => {
    if (!submitting || !operation) return;
    const timeout = window.setTimeout(() => setSlowOperation(operation.idempotencyKey), 2000);
    return () => window.clearTimeout(timeout);
  }, [submitting, operation]);
  if (entry.blocked) return <p role="alert" className="mt-3 rounded-xl border p-3 text-sm">{entry.blocked}</p>;
  const command = operation ? commandOf(operation) : null;
  const committed = operation && entry.write === "committed";
  const unknown = operation && entry.write === "unknown";
  const rejected = operation && entry.write === "rejected";
  const date = committed && operation.operationType === "create" && command && today && command.occurredOn !== today ? `${timelineDateLabel(command.occurredOn, today)}的` : "";
  let message = submitting ? (operation?.operationType === "replace" ? "正在修改…" : "正在加入…")
    : unknown ? "尚未確認是否已加入，請勿再記一次。"
    : committed && command ? `${operation.operationType === "replace" ? "已修改" : "已加入"}${date}${command.description} ${money(Number(command.amountTwd))}`
    : rejected ? "尚未加入，請檢查標示欄位。" : "";
  if (unknown && operation.operationType === "replace") message = "尚未確認是否已修改，請勿另送一次修改。";
  if (rejected && operation.operationType === "replace") message = "尚未修改，請檢查標示欄位。";
  if (!message && !entry.error) return null;
  return <div className="mt-3 space-y-2 text-sm" role={entry.error && !unknown ? "alert" : "status"} aria-live="polite" aria-atomic="false" data-write-outcome={entry.write} data-read-freshness={entry.read}>
    {message ? <p><span data-testid={committed ? "entry-success-copy" : undefined}>{message}</span>{committed ? <span aria-live="off">{entry.read === "failed" ? "。其他紀錄暫時無法更新。" : entry.read === "refreshing" ? "。其他紀錄更新中…" : ""}</span> : null}</p> : null}
    {submitting && slowOperation === operation?.idempotencyKey ? <p>連線比平常慢</p> : null}
    {entry.error ? <p id="entry-error" className="text-destructive">{entry.error}</p> : null}
    {unknown && command ? <>
      <p className="font-semibold">{command.description} {money(Number(command.amountTwd))} · {command.occurredOn}</p>
      <p>{command.type === "income" ? "收款" : "付款"}：{command.payments.map(payment => `${payment.userId === operation.actorUserId ? "你" : "另一半"} ${money(Number(payment.amountTwd))}`).join("、")}<br />{command.type === "transfer" ? "接收" : "分攤"}：{command.shares.map(share => `${share.userId === operation.actorUserId ? "你" : "另一半"} ${money(Number(share.amountTwd))}`).join("、")}</p>
      <p>{operation.operationType === "replace" ? "若已修改會讀回原結果；若未修改會完成這一筆。" : "若已加入會讀回原結果；若未加入會完成這一筆。"}</p><Button variant="outline" size="sm" onClick={() => void entry.replay()}>確認並完成這筆</Button>
    </> : null}
    {committed && onView ? <Button data-testid="entry-view-created" variant="ghost" onClick={onView}>查看</Button> : null}
    {committed && entry.read === "failed" ? <Button variant="outline" size="sm" onClick={() => void entry.retryRead()}>重新整理</Button> : null}
  </div>;
}
