import type { SupabaseClient } from "@supabase/supabase-js";

export class ReceiptService {
  constructor() {}

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
}
