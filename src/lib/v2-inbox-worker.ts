import { withTx } from "./db/tx";

export interface V2InboxRow {
  id: number;
  webhook_event_id: string;
  payload: Record<string, unknown>;
}

/** Claim one durable LINE event. Business handling happens after commit. */
export async function claimV2LineInbox(limit = 20): Promise<V2InboxRow[]> {
  return withTx(async (client) => {
    const result = await client.query<V2InboxRow>(
      `with candidates as (
         select id
           from ledger_v2.line_inbox
          where status in ('received', 'failed')
            and next_attempt_at <= now()
            and (lease_until is null or lease_until < now())
          order by received_at, id
          limit $1
          for update skip locked
       )
       update ledger_v2.line_inbox inbox
          set status = 'processing',
              attempt_count = inbox.attempt_count + 1,
              lease_until = now() + interval '2 minutes'
         from candidates
        where inbox.id = candidates.id
      returning inbox.id, inbox.webhook_event_id, inbox.payload`,
      [limit],
    );
    return result.rows;
  });
}

export async function finishV2LineInbox(id: number, status: "processed" | "failed" | "ignored", error?: string) {
  return withTx(async (client) => {
    await client.query(
      `update ledger_v2.line_inbox
          set status = $2,
              lease_until = null,
              last_error = $3,
              processed_at = case when $2 in ('processed', 'ignored') then now() else null end,
              next_attempt_at = case when $2 = 'failed' then now() + interval '1 minute' else next_attempt_at end
        where id = $1`,
      [id, status, error ?? null],
    );
  });
}

export async function resetStaleV2LineInboxLeases() {
  return withTx(async (client) => {
    const result = await client.query(
      `update ledger_v2.line_inbox
          set status = 'failed', lease_until = null,
              last_error = coalesce(last_error, 'worker lease expired'),
              next_attempt_at = now()
        where status = 'processing' and lease_until < now()
      returning id`,
    );
    return result.rowCount ?? 0;
  });
}
