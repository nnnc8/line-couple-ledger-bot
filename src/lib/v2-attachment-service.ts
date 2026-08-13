import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { HttpError } from "./http-error";
import { withTx } from "./db/tx";

const mimeTypes = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf"] as const;

export const v2AttachmentInputSchema = z.object({
  ledgerId: z.string().uuid(),
  transactionId: z.string().uuid().optional(),
  fileName: z.string().trim().min(1).max(180),
  mimeType: z.enum(mimeTypes),
  sizeBytes: z.number().int().min(1).max(10 * 1024 * 1024),
});

export async function createV2AttachmentUpload(
  db: SupabaseClient,
  user: { id: string; couple_id: number },
  rawInput: unknown,
) {
  const input = v2AttachmentInputSchema.parse(rawInput);
  const safeName = input.fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const attachmentId = randomUUID();
  const storagePath = `${user.couple_id}/${input.ledgerId}/${attachmentId}-${safeName}`;
  await withTx(async (client) => {
    const access = await client.query<{ id: string }>(
      `select l.id
         from ledger_v2.ledgers l
         join ledger_v2.ledger_members lm
           on lm.ledger_id = l.id and lm.couple_id = l.couple_id
        where l.id = $1
          and l.couple_id = $2
          and l.status = 'active'
          and lm.user_id = $3`,
      [input.ledgerId, user.couple_id, user.id],
    );
    if (!access.rows[0]) throw new HttpError(404, "Ledger 不存在或無權限");
    if (input.transactionId) {
      const transaction = await client.query<{ id: string }>(
        `select id
           from ledger_v2.transactions
          where id = $1 and ledger_id = $2 and couple_id = $3`,
        [input.transactionId, input.ledgerId, user.couple_id],
      );
      if (!transaction.rows[0]) throw new HttpError(404, "Transaction 不存在");
    }
    await client.query(
      `insert into ledger_v2.attachments
        (id, couple_id, ledger_id, transaction_id, owner_user_id,
         storage_path, mime_type, size_bytes, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'uploaded')`,
      [attachmentId, user.couple_id, input.ledgerId, input.transactionId ?? null, user.id, storagePath, input.mimeType, input.sizeBytes],
    );
  });
  const signed = await db.storage.from("receipts").createSignedUploadUrl(storagePath);
  if (signed.error || !signed.data) {
    await withTx(async (client) => {
      await client.query("delete from ledger_v2.attachments where id = $1 and couple_id = $2", [attachmentId, user.couple_id]);
    });
    throw new HttpError(503, "附件上傳暫時不可用");
  }
  return {
    attachment: {
      id: attachmentId,
      ledgerId: input.ledgerId,
      transactionId: input.transactionId ?? null,
      storagePath,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      status: "uploaded",
    },
    signedUpload: signed.data,
  };
}

export async function listV2TransactionAttachments(
  db: SupabaseClient,
  user: { id: string; couple_id: number },
  transactionId: string,
) {
  const parsedTransactionId = z.string().uuid().parse(transactionId);
  const rows = await withTx(async (client) => {
    const access = await client.query<{ ledger_id: string }>(
      `select t.ledger_id
         from ledger_v2.transactions t
         join ledger_v2.ledger_members lm
           on lm.ledger_id = t.ledger_id and lm.couple_id = t.couple_id
        where t.id = $1 and t.couple_id = $2 and lm.user_id = $3`,
      [parsedTransactionId, user.couple_id, user.id],
    );
    const ledgerId = access.rows[0]?.ledger_id;
    if (!ledgerId) throw new HttpError(404, "Transaction 不存在或無權限");
    const result = await client.query<{
      id: string;
      ledger_id: string;
      transaction_id: string | null;
      mime_type: string;
      size_bytes: number;
      status: string;
      created_at: string;
      storage_path: string;
    }>(
      `select id, ledger_id, transaction_id, mime_type, size_bytes, status, created_at, storage_path
         from ledger_v2.attachments
        where couple_id = $1 and ledger_id = $2 and transaction_id = $3 and status <> 'deleted'
        order by created_at desc`,
      [user.couple_id, ledgerId, parsedTransactionId],
    );
    return result.rows;
  });
  const withUrls = await Promise.all(rows.map(async (attachment) => {
    const signed = await db.storage.from("receipts").createSignedUrl(attachment.storage_path, 60 * 10);
    return {
      id: attachment.id,
      ledgerId: attachment.ledger_id,
      transactionId: attachment.transaction_id,
      mimeType: attachment.mime_type,
      sizeBytes: attachment.size_bytes,
      status: attachment.status,
      createdAt: attachment.created_at,
      url: signed.error ? null : signed.data.signedUrl,
    };
  }));
  return { attachments: withUrls };
}

export async function completeV2AttachmentUpload(
  user: { id: string; couple_id: number },
  attachmentId: string,
) {
  const parsedAttachmentId = z.string().uuid().parse(attachmentId);
  return withTx(async (client) => {
    const result = await client.query<{
      id: string;
      ledger_id: string;
      transaction_id: string | null;
      mime_type: string;
      size_bytes: number;
      status: string;
      storage_path: string;
    }>(
      `update ledger_v2.attachments a
          set status = 'ready', updated_at = now()
        where a.id = $1
          and a.couple_id = $2
          and a.owner_user_id = $3
          and a.status = 'uploaded'
          and exists (
            select 1
              from ledger_v2.ledger_members lm
             where lm.ledger_id = a.ledger_id
               and lm.couple_id = a.couple_id
               and lm.user_id = $3
          )
      returning a.id, a.ledger_id, a.transaction_id, a.mime_type,
                a.size_bytes, a.status, a.storage_path`,
      [parsedAttachmentId, user.couple_id, user.id],
    );
    const attachment = result.rows[0];
    if (!attachment) throw new HttpError(404, "附件不存在、已完成或無權限");
    return {
      attachment: {
        id: attachment.id,
        ledgerId: attachment.ledger_id,
        transactionId: attachment.transaction_id,
        mimeType: attachment.mime_type,
        sizeBytes: attachment.size_bytes,
        status: attachment.status,
      },
    };
  });
}
