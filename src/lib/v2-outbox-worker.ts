import { withTx } from "./db/tx";

export interface V2OutboxRow {
  id: number;
  recipient_user_id: string;
  kind: string;
  payload: Record<string, unknown>;
}

export async function claimV2NotificationOutbox(limit = 20): Promise<V2OutboxRow[]> {
  return withTx(async (client) => {
    const result = await client.query<V2OutboxRow>(
      `with candidates as (
         select id
           from ledger_v2.notification_outbox
          where status in ('pending', 'failed')
            and next_attempt_at <= now()
            and (lease_until is null or lease_until < now())
          order by created_at, id
          limit $1
          for update skip locked
       )
       update ledger_v2.notification_outbox outbox
          set status = 'sending',
              attempt_count = outbox.attempt_count + 1,
              lease_until = now() + interval '2 minutes'
         from candidates
        where outbox.id = candidates.id
      returning outbox.id, outbox.recipient_user_id, outbox.kind, outbox.payload`,
      [limit],
    );
    return result.rows;
  });
}

export async function finishV2NotificationOutbox(id: number, status: "sent" | "failed" | "skipped", error?: string) {
  return withTx(async (client) => {
    await client.query(
      `update ledger_v2.notification_outbox
          set status = $2,
              lease_until = null,
              last_error = $3,
              sent_at = case when $2 = 'sent' then now() else sent_at end,
              next_attempt_at = case when $2 = 'failed' then now() + interval '1 minute' else next_attempt_at end
        where id = $1`,
      [id, status, error ?? null],
    );
  });
}
