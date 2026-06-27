"use client";

import { Sheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";

interface ConfirmDialogProps {
  preview: string | null;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

function iconForPreview(preview: string): string {
  if (preview.includes("刪除")) return "🗑️";
  if (preview.includes("修改") || preview.includes("更新")) return "✏️";
  if (preview.includes("結清")) return "🤝";
  if (preview.includes("復原")) return "↩️";
  if (preview.includes("預算")) return "🎯";
  return "✅";
}

export function ConfirmDialog({
  preview,
  busy,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const open = preview !== null;
  return (
    <Sheet
      open={open}
      onClose={onCancel}
      title="帳務變更"
      subtitle="即將更新帳本紀錄"
      labelledBy="confirm-title"
    >
      <div className="flex items-start gap-3 rounded-2xl bg-muted p-4">
        <span aria-hidden className="text-2xl">
          {preview ? iconForPreview(preview) : ""}
        </span>
        <pre className="whitespace-pre-line text-[14px] leading-relaxed text-foreground/90">
          {preview}
        </pre>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 pb-1">
        <Button variant="secondary" size="block" disabled={busy} onClick={onCancel}>
          取消
        </Button>
        <Button variant="primary" size="block" disabled={busy} onClick={onConfirm}>
          {busy ? "處理中…" : "確認執行"}
        </Button>
      </div>
    </Sheet>
  );
}