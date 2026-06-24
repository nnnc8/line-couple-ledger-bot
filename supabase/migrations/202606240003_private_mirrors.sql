alter table public.expenses
  add column if not exists mirror_kind text,
  add column if not exists mirror_source_expense_id uuid references public.expenses(id) on delete set null;

alter table public.expenses alter column source_action_id drop not null;

alter table public.expenses drop constraint if exists expenses_mirror_kind_check;
alter table public.expenses add constraint expenses_mirror_kind_check
check (mirror_kind is null or mirror_kind = 'shared_share');

alter table public.expenses drop constraint if exists expenses_source_action_or_mirror_check;
alter table public.expenses add constraint expenses_source_action_or_mirror_check
check (
  (source_action_id is not null and mirror_kind is null and mirror_source_expense_id is null)
  or
  (
    source_action_id is null
    and ledger = 'private'
    and group_id is null
    and mirror_kind = 'shared_share'
    and mirror_source_expense_id is not null
  )
);

create unique index if not exists expenses_private_mirror_unique_idx
  on public.expenses (mirror_source_expense_id, created_by_user_id)
  where mirror_kind = 'shared_share';

create index if not exists expenses_mirror_source_idx
  on public.expenses (mirror_source_expense_id)
  where mirror_kind = 'shared_share';

create or replace function public.sync_private_mirrors_for_expense(p_source_expense_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  source_row public.expenses%rowtype;
  owner_id uuid;
  share_twd bigint;
  mirror_id uuid;
begin
  select * into source_row
  from public.expenses
  where id = p_source_expense_id and ledger = 'shared';
  if not found then
    return;
  end if;

  for owner_id in
    select source_row.created_by_user_id
    union
    select created_by_user_id
    from public.expenses
    where mirror_kind = 'shared_share'
      and mirror_source_expense_id = source_row.id
  loop
    select amount_twd into share_twd
    from public.expense_splits
    where expense_id = source_row.id and user_id = owner_id;

    if coalesce(share_twd, 0) <= 0 then
      update public.expenses
      set deleted_at = coalesce(source_row.deleted_at, now()),
        deleted_by_user_id = source_row.deleted_by_user_id,
        version = version + 1,
        updated_at = now()
      where mirror_kind = 'shared_share'
        and mirror_source_expense_id = source_row.id
        and created_by_user_id = owner_id;
      continue;
    end if;

    insert into public.expenses (
      couple_id, group_id, ledger, description, merchant, notes, category, category_label,
      amount_twd, paid_by_user_id, created_by_user_id, expense_date, split_method,
      source_action_id, mirror_kind, mirror_source_expense_id, deleted_at, deleted_by_user_id
    ) values (
      source_row.couple_id, null, 'private', source_row.description, source_row.merchant,
      source_row.notes, source_row.category, source_row.category_label, share_twd,
      owner_id, owner_id, source_row.expense_date, 'equal', null, 'shared_share',
      source_row.id, source_row.deleted_at, source_row.deleted_by_user_id
    )
    on conflict (mirror_source_expense_id, created_by_user_id)
      where mirror_kind = 'shared_share'
    do update set
      description = excluded.description,
      merchant = excluded.merchant,
      notes = excluded.notes,
      category = excluded.category,
      category_label = excluded.category_label,
      amount_twd = excluded.amount_twd,
      paid_by_user_id = excluded.paid_by_user_id,
      expense_date = excluded.expense_date,
      split_method = excluded.split_method,
      deleted_at = excluded.deleted_at,
      deleted_by_user_id = excluded.deleted_by_user_id,
      version = public.expenses.version + 1,
      updated_at = now()
    returning id into mirror_id;

    insert into public.expense_splits (expense_id, user_id, amount_twd)
    values (mirror_id, owner_id, share_twd)
    on conflict (expense_id, user_id)
    do update set amount_twd = excluded.amount_twd;
  end loop;
end;
$$;

create or replace function public.sync_private_mirrors_from_expense_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.sync_private_mirrors_for_expense(new.id);
  return new;
end;
$$;

create or replace function public.sync_private_mirrors_from_split_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.sync_private_mirrors_for_expense(new.expense_id);
  return new;
end;
$$;

drop trigger if exists expenses_sync_private_mirrors on public.expenses;
create trigger expenses_sync_private_mirrors
after update of description, merchant, notes, category, category_label, amount_twd, expense_date, deleted_at, deleted_by_user_id
on public.expenses
for each row
when (new.ledger = 'shared')
execute function public.sync_private_mirrors_from_expense_trigger();

drop trigger if exists expense_splits_sync_private_mirrors on public.expense_splits;
create trigger expense_splits_sync_private_mirrors
after insert or update of amount_twd
on public.expense_splits
for each row
execute function public.sync_private_mirrors_from_split_trigger();

revoke all on function public.sync_private_mirrors_for_expense(uuid) from public, anon, authenticated;
revoke all on function public.sync_private_mirrors_from_expense_trigger() from public, anon, authenticated;
revoke all on function public.sync_private_mirrors_from_split_trigger() from public, anon, authenticated;
grant execute on function public.sync_private_mirrors_for_expense(uuid) to service_role;
