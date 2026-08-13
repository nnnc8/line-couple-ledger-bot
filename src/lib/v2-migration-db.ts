import type { PoolClient } from "pg";

import type {
  LegacyExpenseRow,
  LegacyGroupRow,
  LegacySettlementRow,
  LegacySnapshot,
  LegacyUserRow,
} from "./v2-migration";

/**
 * Read one complete V1 couple snapshot through the caller's transaction.
 * Migration planning and the cutover barrier must use the exact same query
 * shape so a late V1 write changes the digest instead of being silently lost.
 */
export async function loadV2LegacySnapshot(
  client: PoolClient,
  coupleId: number,
): Promise<LegacySnapshot> {
  const users = await client.query<LegacyUserRow>(
    `select id, couple_id, role
       from public.users
      where couple_id = $1
      order by role, id`,
    [coupleId],
  );
  const groups = await client.query<LegacyGroupRow>(
    `select id, couple_id, name, color, created_by_user_id, archived_at, created_at
       from public.groups
      where couple_id = $1
      order by created_at, id`,
    [coupleId],
  );
  const expenses = await client.query<LegacyExpenseRow>(
    `select e.id, e.couple_id, e.ledger, e.group_id, e.description,
            e.merchant, e.notes, e.tag, e.amount_twd,
            e.paid_by_user_id, e.created_by_user_id, e.expense_date,
            e.split_method, e.deleted_at, e.version, e.created_at,
            e.mirror_kind, e.mirror_source_expense_id,
            coalesce(
              jsonb_agg(
                jsonb_build_object('user_id', es.user_id, 'amount_twd', es.amount_twd)
                order by es.user_id
              ) filter (where es.user_id is not null),
              '[]'::jsonb
            ) as expense_splits
       from public.expenses e
       left join public.expense_splits es on es.expense_id = e.id
      where e.couple_id = $1
      group by e.id
      order by e.expense_date, e.created_at, e.id`,
    [coupleId],
  );
  const settlements = await client.query<LegacySettlementRow>(
    `select id, couple_id, group_id, from_user_id, to_user_id, amount_twd,
            intent, occurred_on, notes, voided_at, created_at, version
       from public.settlements
      where couple_id = $1
      order by occurred_on, created_at, id`,
    [coupleId],
  );
  return {
    coupleId,
    users: users.rows,
    groups: groups.rows,
    expenses: expenses.rows,
    settlements: settlements.rows,
  };
}
