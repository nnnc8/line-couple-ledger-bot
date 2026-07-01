create or replace function public.apply_pending_action_plan(
  p_action_id uuid,
  p_plan jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  action_row public.pending_actions%rowtype;
  item jsonb;
begin
  select *
  into action_row
  from public.pending_actions
  where id = p_action_id
  for update;

  if not found then
    return jsonb_build_object('result', 'not_found', 'action_type', null);
  end if;

  if action_row.status <> 'pending' then
    return jsonb_build_object('result', 'already_done', 'action_type', action_row.action_type);
  end if;

  if p_plan ? 'insert_expenses' then
    insert into public.expenses (
      id, couple_id, group_id, ledger, description, merchant, notes, tag,
      amount_twd, paid_by_user_id, created_by_user_id, expense_date, split_method,
      source_action_id
    )
    select
      (row->>'id')::uuid,
      (row->>'couple_id')::smallint,
      nullif(row->>'group_id', '')::uuid,
      (row->>'ledger')::public.ledger_type,
      row->>'description',
      nullif(row->>'merchant', ''),
      nullif(row->>'notes', ''),
      row->>'tag',
      (row->>'amount_twd')::bigint,
      (row->>'paid_by_user_id')::uuid,
      (row->>'created_by_user_id')::uuid,
      (row->>'expense_date')::date,
      coalesce((row->>'split_method')::public.split_method, 'equal'),
      (row->>'source_action_id')::uuid
    from jsonb_array_elements(p_plan->'insert_expenses') row;
  end if;

  if p_plan ? 'update_expenses' then
    for item in select value from jsonb_array_elements(p_plan->'update_expenses')
    loop
      update public.expenses
      set
        group_id = nullif(item->>'group_id', '')::uuid,
        ledger = (item->>'ledger')::public.ledger_type,
        description = item->>'description',
        merchant = nullif(item->>'merchant', ''),
        notes = nullif(item->>'notes', ''),
        tag = item->>'tag',
        amount_twd = (item->>'amount_twd')::bigint,
        paid_by_user_id = (item->>'paid_by_user_id')::uuid,
        expense_date = (item->>'expense_date')::date,
        split_method = coalesce((item->>'split_method')::public.split_method, 'equal'),
        deleted_at = case
          when item ? 'deleted_at' then nullif(item->>'deleted_at', '')::timestamptz
          else deleted_at
        end,
        deleted_by_user_id = case
          when item ? 'deleted_by_user_id' then nullif(item->>'deleted_by_user_id', '')::uuid
          else deleted_by_user_id
        end,
        version = version + 1,
        updated_at = now()
      where id = (item->>'id')::uuid
        and couple_id = (item->>'couple_id')::smallint
        and version = (item->>'expected_version')::integer;

      if not found then
        raise sqlstate 'P0001' using message = 'stale';
      end if;
    end loop;
  end if;

  if p_plan ? 'delete_expense_splits' then
    delete from public.expense_splits
    where expense_id in (
      select value::text::uuid
      from jsonb_array_elements_text(p_plan->'delete_expense_splits')
    );
  end if;

  if p_plan ? 'insert_expense_splits' then
    insert into public.expense_splits (expense_id, user_id, amount_twd)
    select
      (row->>'expense_id')::uuid,
      (row->>'user_id')::uuid,
      (row->>'amount_twd')::bigint
    from jsonb_array_elements(p_plan->'insert_expense_splits') row;
  end if;

  if p_plan ? 'update_receipts' then
    for item in select value from jsonb_array_elements(p_plan->'update_receipts')
    loop
      update public.receipts
      set
        expense_id = nullif(item->>'expense_id', '')::uuid,
        group_id = nullif(item->>'group_id', '')::uuid,
        updated_at = now()
      where id = (item->>'id')::uuid;

      if not found then
        raise sqlstate 'P0001' using message = 'stale';
      end if;
    end loop;
  end if;

  if p_plan ? 'soft_delete_receipts_by_expense' then
    update public.receipts
    set deleted_at = now(), updated_at = now()
    where expense_id in (
      select value::text::uuid
      from jsonb_array_elements_text(p_plan->'soft_delete_receipts_by_expense')
    );
  end if;

  if p_plan ? 'restore_receipts_by_expense' then
    update public.receipts
    set deleted_at = null, updated_at = now()
    where expense_id in (
      select value::text::uuid
      from jsonb_array_elements_text(p_plan->'restore_receipts_by_expense')
    );
  end if;

  if p_plan ? 'insert_settlements' then
    insert into public.settlements (
      id, couple_id, group_id, from_user_id, to_user_id, amount_twd, source_action_id
    )
    select
      (row->>'id')::uuid,
      (row->>'couple_id')::smallint,
      (row->>'group_id')::uuid,
      (row->>'from_user_id')::uuid,
      (row->>'to_user_id')::uuid,
      (row->>'amount_twd')::bigint,
      (row->>'source_action_id')::uuid
    from jsonb_array_elements(p_plan->'insert_settlements') row;
  end if;

  if p_plan ? 'insert_activities' then
    insert into public.activity_events (
      couple_id, group_id, actor_user_id, entity_type, entity_id, action, before_state, after_state
    )
    select
      (row->>'couple_id')::smallint,
      nullif(row->>'group_id', '')::uuid,
      (row->>'actor_user_id')::uuid,
      row->>'entity_type',
      row->>'entity_id',
      row->>'action',
      row->'before_state',
      row->'after_state'
    from jsonb_array_elements(p_plan->'insert_activities') row;
  end if;

  if p_plan ? 'insert_notifications' then
    insert into public.notifications (
      recipient_user_id, group_id, kind, title, body, entity_type, entity_id, dedupe_key
    )
    select
      (row->>'recipient_user_id')::uuid,
      nullif(row->>'group_id', '')::uuid,
      row->>'kind',
      row->>'title',
      row->>'body',
      row->>'entity_type',
      row->>'entity_id',
      row->>'dedupe_key'
    from jsonb_array_elements(p_plan->'insert_notifications') row;
  end if;

  update public.pending_actions
  set status = 'confirmed', processed_at = now()
  where id = p_action_id;

  return jsonb_build_object('result', 'confirmed', 'action_type', action_row.action_type);
exception
  when sqlstate 'P0001' then
    return jsonb_build_object('result', 'stale', 'action_type', action_row.action_type);
  when invalid_text_representation or numeric_value_out_of_range or check_violation or foreign_key_violation or unique_violation then
    return jsonb_build_object('result', 'stale', 'action_type', coalesce(action_row.action_type::text, null));
end;
$$;

revoke all on function public.apply_pending_action_plan(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.apply_pending_action_plan(uuid, jsonb) to service_role;
