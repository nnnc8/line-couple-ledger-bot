import { withTx } from "./db/tx";
import { createHash } from "node:crypto";

export interface V2InboxRow {
  id: number;
  webhook_event_id: string;
  payload: Record<string, unknown>;
  attempt_count: number;
  lease_token: string;
}

/** Recover the commit-before-inbox-ack crash window from the canonical receipt.
 * The inbox retains the first authenticated payload for an event. Reprocessing
 * that event must not reinterpret the user's subsequently changed preferences.
 * This returns only completion, never another Ledger's transaction to a caller.
 */
export async function hasV2LineAccountingCompletion(claim: V2InboxRow): Promise<boolean> {
  const source = claim.payload.source as { userId?: string } | undefined;
  if (!source?.userId) return false;
  const key = `line:v2:direct:${createHash("sha256").update(claim.webhook_event_id).digest("hex")}`;
  return withTx(async (client) => {
    const result = await client.query(
      `select r.id from ledger_v2.command_receipts r
         join public.users u on u.id = r.created_by_user_id and u.couple_id = r.couple_id
         join ledger_v2.ledger_members lm on lm.user_id = u.id and lm.couple_id = r.couple_id and lm.ledger_id = r.ledger_id
         join ledger_v2.transactions t on t.id::text = r.result->'transaction'->>'id'
           and t.couple_id = r.couple_id and t.ledger_id = r.ledger_id
        where r.idempotency_key = $1 and u.line_user_id = $2 and r.status = 'applied'
          and r.result->'transaction'->>'ledgerId' = r.ledger_id::text
          and not (r.result ? 'settled') and not (r.result ? 'replacedTransactionId')`,
      [key, source.userId],
    );
    return result.rowCount === 1;
  });
}

/** Claim one durable LINE event. Business handling happens after commit. */
export async function claimV2LineInbox(limit = 20): Promise<V2InboxRow[]> {
  return withTx(async (client) => {
    const result = await client.query<V2InboxRow>(
      `with candidates as (
         select id
           from ledger_v2.line_inbox
          where status in ('received', 'failed')
            and attempt_count < max_attempts
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
      returning inbox.id, inbox.webhook_event_id, inbox.payload, inbox.attempt_count, inbox.lease_until::text as lease_token`,
      [limit],
    );
    return result.rows;
  });
}

export async function finishV2LineInbox(claim: V2InboxRow, status: "processed" | "failed" | "ignored" | "dead_letter", error?: string) {
  return withTx(async (client) => {
    const result = await client.query(
      `update ledger_v2.line_inbox
          set status = case when $2 = 'dead_letter' or ($2 = 'failed' and attempt_count >= max_attempts) then 'dead_letter' else $2 end,
              lease_until = null,
              last_error = $3,
              processed_at = case when $2 in ('processed', 'ignored') then now() else null end,
              next_attempt_at = case when $2 = 'failed' and attempt_count < max_attempts then now() + make_interval(secs => least(3600, greatest(60, (power(2::double precision, least(attempt_count, 6)) * 60)::int))) else next_attempt_at end
        where id = $1 and status = 'processing' and lease_until = $4::timestamptz and attempt_count = $5`,
      [claim.id, status, error ?? null, claim.lease_token, claim.attempt_count],
    );
    return result.rowCount === 1;
  });
}

/**
 * Put a claimed event back at the front of the queue when an incident freeze
 * races with the worker claim. This deliberately reverses the claim's
 * attempt increment so maintenance does not consume retries or create a
 * dead-letter record.
 */
export async function releaseV2LineInboxForMaintenance(claim: V2InboxRow) {
  return withTx(async (client) => {
    const result = await client.query(
      `update ledger_v2.line_inbox
          set status = 'received',
              attempt_count = greatest(0, attempt_count - 1),
              lease_until = null,
              next_attempt_at = now(),
              last_error = $2,
              processed_at = null
        where id = $1 and status = 'processing' and lease_until = $3::timestamptz and attempt_count = $4`,
      [claim.id, "financial writes frozen; event retained for retry", claim.lease_token, claim.attempt_count],
    );
    return result.rowCount === 1;
  });
}

export async function resetStaleV2LineInboxLeases() {
  return withTx(async (client) => {
    const result = await client.query(
      `update ledger_v2.line_inbox
          set status = case when attempt_count >= max_attempts then 'dead_letter' else 'failed' end,
              lease_until = null,
              last_error = coalesce(last_error, 'worker lease expired'),
              next_attempt_at = case when attempt_count >= max_attempts then next_attempt_at else now() end
        where status = 'processing' and lease_until < now()
      returning id`,
    );
    return result.rowCount ?? 0;
  });
}
