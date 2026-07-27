-- Remove the abandoned finance-v2 schema while preserving the v1 public ledger.
-- This migration is intentionally idempotent for fresh v1 databases where the
-- finance schema was never created. On production it aborts on any unexpected
-- finance data or object so cleanup cannot silently destroy user-authored rows.

begin;

do $cleanup_preflight$
declare
  expected_tables constant text[] := array[
    'accounts',
    'allocations',
    'budget_lines',
    'import_batches',
    'import_rows',
    'journal_entries',
    'postings',
    'valuations'
  ];
  expected_functions constant text[] := array[
    'assert_posted_entry_balanced',
    'prevent_import_raw_mutation',
    'prevent_posted_entry_mutation',
    'validate_account_scope',
    'validate_journal_scope',
    'validate_posting_scope'
  ];
  actual_tables text[];
  actual_functions text[];
  finance_table_name text;
  has_rows boolean;
  recurring_column_count integer;
  user_session_column_count integer;
  secretary_retention_column_count integer;
  agent_retention_column_count integer;
  finance_event_count integer;
  public_v2_object_count integer;
  finance_schema_fingerprint text;
  public_v2_fingerprint text;
  activity_constraint_fingerprint text;
begin
  if to_regnamespace('finance') is not null then
    select coalesce(array_agg(c.relname order by c.relname), '{}'::text[])
      into actual_tables
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'finance'
      and c.relkind in ('r', 'p');

    if actual_tables is distinct from expected_tables then
      raise exception 'finance cleanup stopped: unexpected table inventory %', actual_tables;
    end if;

    lock table
      finance.accounts,
      finance.allocations,
      finance.budget_lines,
      finance.import_batches,
      finance.import_rows,
      finance.journal_entries,
      finance.postings,
      finance.valuations
    in access exclusive mode;

    with finance_inventory as (
      select jsonb_build_object(
        'columns', coalesce((
          select jsonb_agg(
            jsonb_build_array(
              c.relname,
              a.attnum,
              a.attname,
              format_type(a.atttypid, a.atttypmod),
              a.attnotnull,
              pg_get_expr(ad.adbin, ad.adrelid)
            ) order by c.relname, a.attnum
          )
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          join pg_attribute a on a.attrelid = c.oid
            and a.attnum > 0
            and not a.attisdropped
          left join pg_attrdef ad on ad.adrelid = c.oid and ad.adnum = a.attnum
          where n.nspname = 'finance' and c.relkind in ('r', 'p')
        ), '[]'::jsonb),
        'constraints', coalesce((
          select jsonb_agg(
            jsonb_build_array(cl.relname, con.conname, con.contype, pg_get_constraintdef(con.oid, true))
            order by cl.relname, con.conname
          )
          from pg_constraint con
          join pg_class cl on cl.oid = con.conrelid
          join pg_namespace n on n.oid = cl.relnamespace
          where n.nspname = 'finance'
        ), '[]'::jsonb),
        'indexes', coalesce((
          select jsonb_agg(jsonb_build_array(tablename, indexname, indexdef) order by tablename, indexname)
          from pg_indexes where schemaname = 'finance'
        ), '[]'::jsonb),
        'triggers', coalesce((
          select jsonb_agg(
            jsonb_build_array(c.relname, t.tgname, pg_get_triggerdef(t.oid, true))
            order by c.relname, t.tgname
          )
          from pg_trigger t
          join pg_class c on c.oid = t.tgrelid
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'finance' and not t.tgisinternal
        ), '[]'::jsonb),
        'functions', coalesce((
          select jsonb_agg(
            jsonb_build_array(
              p.proname,
              p.prokind,
              pg_get_function_identity_arguments(p.oid),
              pg_get_function_result(p.oid),
              pg_get_functiondef(p.oid)
            ) order by p.proname, p.oid
          )
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'finance'
        ), '[]'::jsonb),
        'tables', coalesce((
          select jsonb_agg(
            jsonb_build_array(c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity)
            order by c.relname
          )
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'finance' and c.relkind in ('r', 'p')
        ), '[]'::jsonb),
        'policies', coalesce((
          select jsonb_agg(
            jsonb_build_array(tablename, policyname, permissive, roles, cmd, qual, with_check)
            order by tablename, policyname
          )
          from pg_policies where schemaname = 'finance'
        ), '[]'::jsonb)
      ) as payload
    )
    select encode(digest(payload::text, 'sha256'), 'hex')
      into finance_schema_fingerprint
    from finance_inventory;

    if finance_schema_fingerprint <> 'a91c0d72fe581c8d2924735f428ba4cb2a2a7e714b3ce66b1183f60a326feb5a' then
      raise exception 'finance cleanup stopped: finance schema fingerprint mismatch %', finance_schema_fingerprint;
    end if;

    foreach finance_table_name in array expected_tables loop
      execute format('select exists (select 1 from finance.%I limit 1)', finance_table_name)
        into has_rows;
      if has_rows then
        raise exception 'finance cleanup stopped: finance.% contains rows', finance_table_name;
      end if;
    end loop;

    select coalesce(array_agg(p.proname order by p.proname), '{}'::text[])
      into actual_functions
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'finance';

    if actual_functions is distinct from expected_functions then
      raise exception 'finance cleanup stopped: unexpected function inventory %', actual_functions;
    end if;
  end if;

  lock table
    public.users,
    public.secretary_sessions,
    public.agent_events,
    public.recurring_expenses,
    public.activity_events
  in access exclusive mode;

  select
    (select count(*) from information_schema.columns c where c.table_schema = 'public' and (
      (c.table_name = 'users' and c.column_name = 'session_version')
      or (c.table_name = 'secretary_sessions' and c.column_name in ('metadata', 'raw_cleared_at'))
      or (c.table_name = 'agent_events' and c.column_name = 'raw_cleared_at')
      or (c.table_name = 'recurring_expenses' and c.column_name in (
        'finance_expense_account_id', 'finance_funding_account_id', 'finance_currency',
        'finance_command_version', 'last_run_key'
      ))
    ))
    + (select count(*) from pg_indexes where schemaname = 'public' and indexname in (
      'secretary_sessions_raw_retention_idx', 'agent_events_raw_retention_idx', 'recurring_finance_accounts_idx'
    ))
    + (select count(*) from pg_constraint where conname = 'recurring_expenses_finance_currency_check'
      and conrelid = 'public.recurring_expenses'::regclass)
    into public_v2_object_count;

  if to_regnamespace('finance') is not null or public_v2_object_count > 0 then
    with public_v2_inventory as (
      select jsonb_build_object(
        'columns', coalesce((
          select jsonb_agg(
            jsonb_build_array(
              c.table_name, c.ordinal_position, c.column_name, c.data_type,
              c.udt_name, c.is_nullable, c.column_default
            ) order by c.table_name, c.ordinal_position
          )
          from information_schema.columns c
          where c.table_schema = 'public' and (
            (c.table_name = 'users' and c.column_name = 'session_version')
            or (c.table_name = 'secretary_sessions' and c.column_name in ('metadata', 'raw_cleared_at'))
            or (c.table_name = 'agent_events' and c.column_name = 'raw_cleared_at')
            or (c.table_name = 'recurring_expenses' and c.column_name in (
              'finance_expense_account_id', 'finance_funding_account_id', 'finance_currency',
              'finance_command_version', 'last_run_key'
            ))
          )
        ), '[]'::jsonb),
        'indexes', coalesce((
          select jsonb_agg(jsonb_build_array(indexname, indexdef) order by indexname)
          from pg_indexes where schemaname = 'public' and indexname in (
            'secretary_sessions_raw_retention_idx', 'agent_events_raw_retention_idx', 'recurring_finance_accounts_idx'
          )
        ), '[]'::jsonb),
        'constraints', coalesce((
          select jsonb_agg(jsonb_build_array(con.conname, pg_get_constraintdef(con.oid, true)) order by con.conname)
          from pg_constraint con
          where con.conname in (
            'recurring_expenses_finance_currency_check',
            'activity_events_entity_type_check',
            'activity_events_action_check'
          ) and con.conrelid in (
            'public.recurring_expenses'::regclass,
            'public.activity_events'::regclass
          )
        ), '[]'::jsonb)
      ) as payload
    )
    select encode(digest(payload::text, 'sha256'), 'hex')
      into public_v2_fingerprint
    from public_v2_inventory;

    if public_v2_fingerprint <> '1b4bc51313e6188ff2c6b3cc1a5089685275851fea9690f34a08c7b52f46802c' then
      raise exception 'finance cleanup stopped: public v2 fingerprint mismatch %', public_v2_fingerprint;
    end if;
  else
    select encode(digest(
      coalesce(jsonb_agg(jsonb_build_array(con.conname, pg_get_constraintdef(con.oid, true)) order by con.conname), '[]'::jsonb)::text,
      'sha256'
    ), 'hex')
      into activity_constraint_fingerprint
    from pg_constraint con
    where con.conrelid = 'public.activity_events'::regclass
      and con.conname in ('activity_events_entity_type_check', 'activity_events_action_check');

    if activity_constraint_fingerprint <> '954285b6cc050068a68ef75ea1f64d7a605a7c86a3dea1a5e1f0a5cd3786cd13' then
      raise exception 'finance cleanup stopped: v1 activity constraint fingerprint mismatch %', activity_constraint_fingerprint;
    end if;
  end if;

  select count(*) into recurring_column_count
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'recurring_expenses'
    and column_name in (
      'finance_expense_account_id',
      'finance_funding_account_id',
      'finance_currency',
      'finance_command_version',
      'last_run_key'
    );

  if recurring_column_count not in (0, 5) then
    raise exception 'finance cleanup stopped: partial recurring finance schema (% columns)', recurring_column_count;
  end if;

  if recurring_column_count = 5 then
    execute $query$
      select exists (
        select 1
        from public.recurring_expenses
        where finance_expense_account_id is not null
           or finance_funding_account_id is not null
           or finance_currency <> 'TWD'
           or finance_command_version <> 1
           or last_run_key is not null
      )
    $query$ into has_rows;
    if has_rows then
      raise exception 'finance cleanup stopped: recurring finance references exist';
    end if;
  end if;

  select count(*) into user_session_column_count
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'users'
    and column_name = 'session_version';

  if user_session_column_count = 1 then
    execute 'select exists (select 1 from public.users where session_version <> 1)'
      into has_rows;
    if has_rows then
      raise exception 'finance cleanup stopped: non-default session_version exists';
    end if;
  end if;

  select count(*) into secretary_retention_column_count
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'secretary_sessions'
    and column_name in ('metadata', 'raw_cleared_at');

  if secretary_retention_column_count not in (0, 2) then
    raise exception 'finance cleanup stopped: partial secretary retention schema (% columns)', secretary_retention_column_count;
  end if;

  if secretary_retention_column_count = 2 then
    execute $query$
      select exists (
        select 1 from public.secretary_sessions
        where metadata <> '{}'::jsonb or raw_cleared_at is not null
      )
    $query$ into has_rows;
    if has_rows then
      raise exception 'finance cleanup stopped: secretary retention data exists';
    end if;
  end if;

  select count(*) into agent_retention_column_count
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'agent_events'
    and column_name = 'raw_cleared_at';

  if agent_retention_column_count = 1 then
    execute 'select exists (select 1 from public.agent_events where raw_cleared_at is not null)'
      into has_rows;
    if has_rows then
      raise exception 'finance cleanup stopped: agent retention data exists';
    end if;
  end if;

  select count(*) into finance_event_count
  from public.activity_events
  where entity_type in ('finance_entry', 'finance_account', 'valuation', 'import_batch');

  if finance_event_count > 1 or (
    finance_event_count = 1 and not exists (
      select 1
      from public.activity_events
      where id = 597
        and couple_id = 1
        and group_id is null
        and entity_type = 'finance_entry'
        and entity_id = 'finance-v2-rollback-20260713'
        and action = 'delete'
        and encode(digest(
          coalesce(before_state::text, 'null') || '|' || coalesce(after_state::text, 'null'),
          'sha256'
        ), 'hex') = 'ff63b585d3f6b2047df12dfa540deb116fbf7235b4f0d53a2824e6b78efb5783'
    )
  ) then
    raise exception 'finance cleanup stopped: unexpected finance activity events exist';
  end if;
end;
$cleanup_preflight$;

drop index if exists public.recurring_finance_accounts_idx;
alter table public.recurring_expenses
  drop constraint if exists recurring_expenses_finance_currency_check;
alter table public.recurring_expenses
  drop column if exists finance_expense_account_id,
  drop column if exists finance_funding_account_id,
  drop column if exists finance_currency,
  drop column if exists finance_command_version,
  drop column if exists last_run_key;

drop index if exists public.secretary_sessions_raw_retention_idx;
drop index if exists public.agent_events_raw_retention_idx;
alter table public.secretary_sessions
  drop column if exists metadata,
  drop column if exists raw_cleared_at;
alter table public.agent_events
  drop column if exists raw_cleared_at;
alter table public.users
  drop column if exists session_version;

delete from public.activity_events
where id = 597
  and couple_id = 1
  and group_id is null
  and entity_type = 'finance_entry'
  and entity_id = 'finance-v2-rollback-20260713'
  and action = 'delete'
  and encode(digest(
    coalesce(before_state::text, 'null') || '|' || coalesce(after_state::text, 'null'),
    'sha256'
  ), 'hex') = 'ff63b585d3f6b2047df12dfa540deb116fbf7235b4f0d53a2824e6b78efb5783';

alter table public.activity_events
  drop constraint if exists activity_events_entity_type_check;
alter table public.activity_events
  add constraint activity_events_entity_type_check check (
    entity_type in ('group', 'expense', 'settlement', 'budget', 'recurring')
  );

alter table public.activity_events
  drop constraint if exists activity_events_action_check;
alter table public.activity_events
  add constraint activity_events_action_check check (
    action in ('create', 'update', 'delete', 'restore', 'archive', 'settle')
  );

do $drop_finance$
begin
  if to_regnamespace('finance') is null then
    return;
  end if;

  execute $sql$
    drop table
      finance.import_rows,
      finance.allocations,
      finance.postings,
      finance.valuations,
      finance.budget_lines,
      finance.import_batches,
      finance.journal_entries,
      finance.accounts
    restrict
  $sql$;

  execute 'drop function finance.assert_posted_entry_balanced() restrict';
  execute 'drop function finance.prevent_import_raw_mutation() restrict';
  execute 'drop function finance.prevent_posted_entry_mutation() restrict';
  execute 'drop function finance.validate_account_scope() restrict';
  execute 'drop function finance.validate_journal_scope() restrict';
  execute 'drop function finance.validate_posting_scope() restrict';
  execute 'drop schema finance restrict';
end;
$drop_finance$;

commit;
