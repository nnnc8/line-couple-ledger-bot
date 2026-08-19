-- Categories were created after the original runtime grants. Restore the same
-- least-privileged table access used by the rest of the V2 accounting schema.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'ledger_runtime') then
    execute 'grant select, insert, update, delete on ledger_v2.categories to ledger_runtime';
  end if;
end;
$$;
