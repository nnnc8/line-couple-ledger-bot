begin;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'ledger_runtime') then
    execute 'revoke all on public.line_action_plans from ledger_runtime';
  end if;
end;
$$;

commit;
