begin;

revoke all on public.line_action_plans from service_role;
grant select, insert on public.line_action_plans to service_role;

commit;
