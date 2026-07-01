import { randomUUID } from "node:crypto";

import { generateObject } from "ai";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { receiptExtractionSchema } from "./ledger";
import { getModel } from "./model-provider";
import { detectReceiptMime } from "./security";
import { HttpError } from "./http-error";

export interface ReceiptContext {
  db: SupabaseClient;
  user: {
    id: string;
    couple_id: number;
  };
}

type LineReceiptExpenseInput = {
  expense: {
    description: string;
    amountTwd: number;
  };
};

export async function processUploadedLineReceipt<
  TActionInput extends LineReceiptExpenseInput,
>(input: {
  receiptService: Pick<ReceiptService, "createUploadedReceipt" | "process">;
  context: {
    env: { APP_URL: string };
    db: SupabaseClient;
    user: ReceiptContext["user"] & { line_user_id: string };
  };
  lineClient: {
    getMessageContent: (
      messageId: string,
    ) => Promise<AsyncIterable<Uint8Array | Buffer>> | AsyncIterable<Uint8Array | Buffer>;
    pushMessage: (payload: {
      to: string;
      messages: Array<{ type: "text"; text: string }>;
    }) => Promise<unknown>;
  };
  activeGroupId: string | null;
  messageId: string;
  eventId: string;
  today: string;
  buildExpenseInputs: (input: {
    activeGroupId: string;
    receiptId: string;
    today: string;
    extraction: z.infer<typeof receiptExtractionSchema>;
  }) => TActionInput[];
  proposeBatchCreateExpenses: (
    inputs: TActionInput[],
    idempotencyKey: string,
  ) => Promise<unknown>;
}) {
  const chunks: Buffer[] = [];
  let size = 0;
  const content = await input.lineClient.getMessageContent(input.messageId);
  for await (const chunk of content) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    chunks.push(buffer);
  }
  const bytes = Buffer.concat(chunks, size);
  const { receiptId } = await input.receiptService.createUploadedReceipt(
    { db: input.context.db, user: input.context.user },
    {
      groupId: input.activeGroupId,
      sourceEventId: input.eventId,
      bytes,
    },
  );
  try {
    const extraction = await input.receiptService.process(
      { db: input.context.db, user: input.context.user },
      receiptId,
    );
    const actionInputs = input.buildExpenseInputs({
      activeGroupId: input.activeGroupId as string,
      receiptId,
      today: input.today,
      extraction,
    });
    if (actionInputs.length) {
      await input.proposeBatchCreateExpenses(
        actionInputs,
        `receipt-batch:${receiptId}`,
      );
      const totalTwd = actionInputs.reduce(
        (sum, item) => sum + item.expense.amountTwd,
        0,
      );
      await input.lineClient.pushMessage({
        to: input.context.user.line_user_id,
        messages: [
          {
            type: "text",
            text:
              actionInputs.length === 1
                ? `收據辨識完成，已直接記帳：${actionInputs[0]!.expense.description} NT$${actionInputs[0]!.expense.amountTwd}。如需修正可到圖形化帳本編輯。`
                : `收據辨識完成，已直接記帳 ${actionInputs.length} 筆，總額 NT$${totalTwd}。如需修正可到圖形化帳本編輯。`,
          },
        ],
      });
      return;
    }
    await input.lineClient.pushMessage({
      to: input.context.user.line_user_id,
      messages: [
        {
          type: "text",
          text: `收據辨識完成\n${extraction.merchant ?? "未知商家"} 仍需補金額或欄位\n請打開圖形化帳本完成記帳：${input.context.env.APP_URL}/?receipt=${receiptId}`,
        },
      ],
    });
  } catch {
    await input.lineClient.pushMessage({
      to: input.context.user.line_user_id,
      messages: [
        {
          type: "text",
          text: "收據辨識失敗，請重新拍清楚一點，或到圖形化帳本手動新增。",
        },
      ],
    });
  }
}

export const receiptUploadInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  mimeType: z.enum([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/heif",
  ]),
  sizeBytes: z.number().int().positive(),
  groupId: z.string().uuid().nullable(),
});

export class ReceiptService {
  constructor(
    private readonly options: {
      model: string;
      receiptLimit: number;
    },
  ) {}

  async createUpload(
    context: ReceiptContext,
    input: unknown,
    requireGroup?: (groupId: string) => Promise<void>,
  ) {
    const parsed = receiptUploadInputSchema
      .extend({
        sizeBytes: z.number().int().positive().max(this.options.receiptLimit),
      })
      .parse(input);
    await this.assertReceiptRate(context.db, context.user.id);
    if (parsed.groupId && requireGroup) await requireGroup(parsed.groupId);
    const receiptId = randomUUID();
    const extension = this.fileExtension(parsed.mimeType);
    const path = this.storagePath(context.user.couple_id, context.user.id, receiptId, extension);
    const row = await context.db.from("receipts").insert({
      id: receiptId,
      couple_id: context.user.couple_id,
      owner_user_id: context.user.id,
      group_id: parsed.groupId,
      storage_path: path,
      mime_type: parsed.mimeType,
      size_bytes: parsed.sizeBytes,
    });
    if (row.error) throw new Error("receipt create failed");
    const signed = await context.db.storage
      .from("receipts")
      .createSignedUploadUrl(path);
    if (signed.error) throw new Error("receipt upload URL failed");
    return {
      receiptId,
      path,
      token: signed.data.token,
      signedUrl: signed.data.signedUrl,
    };
  }

  async createUploadedReceipt(
    context: ReceiptContext,
    input: {
      groupId: string | null;
      sourceEventId: string;
      bytes: Uint8Array;
    },
  ) {
    await this.assertReceiptRate(context.db, context.user.id);
    if (input.bytes.length > this.options.receiptLimit) {
      throw new HttpError(413, "收據不可超過 10 MB");
    }
    const mimeType = detectReceiptMime(input.bytes);
    if (!mimeType) throw new HttpError(400, "收據格式不正確");
    const receiptId = randomUUID();
    const extension = this.fileExtension(mimeType);
    const path = this.storagePath(
      context.user.couple_id,
      context.user.id,
      receiptId,
      extension,
    );
    const receipt = await context.db.from("receipts").insert({
      id: receiptId,
      couple_id: context.user.couple_id,
      owner_user_id: context.user.id,
      group_id: input.groupId,
      storage_path: path,
      mime_type: mimeType,
      size_bytes: input.bytes.length,
      source_event_id: input.sourceEventId,
      status: "uploaded",
    });
    if (receipt.error) throw new Error("receipt create failed");
    const upload = await context.db.storage
      .from("receipts")
      .upload(path, input.bytes, { contentType: mimeType, upsert: false });
    if (upload.error) {
      await context.db
        .from("receipts")
        .update({ status: "failed", failure_reason: "upload failed" })
        .eq("id", receiptId);
      throw new Error("receipt upload failed");
    }
    return { receiptId, mimeType, path };
  }

  async process(context: ReceiptContext, receiptId: string) {
    const id = z.string().uuid().parse(receiptId);
    const row = await context.db
      .from("receipts")
      .select("id, owner_user_id, storage_path, size_bytes")
      .eq("id", id)
      .eq("couple_id", context.user.couple_id)
      .eq("owner_user_id", context.user.id)
      .single();
    if (row.error) throw new HttpError(404, "找不到收據");
    await context.db
      .from("receipts")
      .update({
        status: "processing",
        failure_reason: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);
    try {
      const file = await context.db.storage
        .from("receipts")
        .download(row.data.storage_path);
      if (file.error) throw new Error("download failed");
      const bytes = new Uint8Array(await file.data.arrayBuffer());
      if (bytes.length > this.options.receiptLimit || bytes.length !== row.data.size_bytes) {
        throw new HttpError(400, "收據大小不符");
      }
      const mimeType = detectReceiptMime(bytes);
      if (!mimeType) throw new HttpError(400, "收據格式不正確");
      const response = await generateObject({
        model: getModel(this.options.model),
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                image: bytes,
                mimeType,
              } as any,
              {
                type: "text",
                text: "辨識這張台灣收據、付款紀錄或叫車/行程截圖。若畫面只有一筆消費，填 merchant、expenseDate、amountTwd 與 confidence；若畫面有多筆交易，items 逐筆列出 merchant/代碼、expenseDate、amountTwd、description。金額只取實際付款的 TWD 整數，忽略 NT$0、折抵、退款與看不清楚的項目；看不清楚欄位用 null。",
              },
            ],
          },
        ],
        temperature: 0,
        schema: receiptExtractionSchema,
      });
      const extraction = response.object;
      const update = await context.db
        .from("receipts")
        .update({
          status: "ready",
          mime_type: mimeType,
          extraction,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);
      if (update.error) throw new Error("receipt update failed");
      return extraction;
    } catch (error) {
      await context.db
        .from("receipts")
        .update({
          status: "failed",
          failure_reason:
            error instanceof Error ? error.message.slice(0, 200) : "OCR failed",
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);
      throw error;
    }
  }

  async url(context: ReceiptContext, receiptId: string) {
    const row = await context.db
      .from("receipts")
      .select("storage_path, owner_user_id, group_id, expense_id")
      .eq("id", z.string().uuid().parse(receiptId))
      .eq("couple_id", context.user.couple_id)
      .is("deleted_at", null)
      .single();
    if (row.error) throw new HttpError(404, "找不到收據");
    if (!row.data.group_id && row.data.owner_user_id !== context.user.id) {
      throw new HttpError(403, "無權查看私人收據");
    }
    const signed = await context.db.storage
      .from("receipts")
      .createSignedUrl(row.data.storage_path, 300);
    if (signed.error) throw new Error("receipt URL failed");
    return signed.data.signedUrl;
  }

  async details(context: ReceiptContext, receiptId: string) {
    const result = await context.db
      .from("receipts")
      .select("id, owner_user_id, status, extraction")
      .eq("id", z.string().uuid().parse(receiptId))
      .eq("couple_id", context.user.couple_id)
      .is("deleted_at", null)
      .single();
    if (result.error || result.data.owner_user_id !== context.user.id) {
      throw new HttpError(404, "找不到收據");
    }
    return z
      .object({
        id: z.string().uuid(),
        status: z.enum(["uploaded", "processing", "ready", "failed"]),
        extraction: receiptExtractionSchema.nullable(),
      })
      .parse(result.data);
  }

  async purgeDeleted(db: SupabaseClient, now = new Date()) {
    const expiredReceipts = await db
      .from("receipts")
      .select("id, storage_path")
      .lt(
        "deleted_at",
        new Date(now.getTime() - 30 * 24 * 60 * 60 * 1_000).toISOString(),
      );
    if (expiredReceipts.error || !expiredReceipts.data?.length) return 0;

    await db.storage
      .from("receipts")
      .remove(expiredReceipts.data.map((row) => row.storage_path));
    await db
      .from("receipts")
      .delete()
      .in(
        "id",
        expiredReceipts.data.map((row) => row.id),
      );
    return expiredReceipts.data.length;
  }

  private fileExtension(mimeType: string) {
    return mimeType === "image/jpeg" ? "jpg" : mimeType.split("/")[1]!;
  }

  private storagePath(coupleId: number, userId: string, receiptId: string, extension: string) {
    return `${coupleId}/${userId}/${receiptId}.${extension}`;
  }

  private async assertReceiptRate(db: SupabaseClient, userId: string) {
    const result = await db
      .from("receipts")
      .select("id", { count: "exact", head: true })
      .eq("owner_user_id", userId)
      .gte("created_at", new Date(Date.now() - 10 * 60 * 1_000).toISOString());
    if (result.error) throw new Error("receipt rate lookup failed");
    if ((result.count ?? 0) >= 10) {
      throw new HttpError(429, "收據上傳太頻繁，請稍後再試");
    }
  }
}
