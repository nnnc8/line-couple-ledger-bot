begin;

do $$
begin
  if exists (
    select 1
    from pg_roles
    where rolname = 'ledger_runtime'
  ) then
    execute
      'grant execute on function public.group_balances(uuid) to ledger_runtime';
  end if;
end;
$$;

commit;
