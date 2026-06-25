alter table public.notifications
  drop constraint if exists notifications_line_status_check;

alter table public.notifications
  add constraint notifications_line_status_check
  check (line_status in ('pending', 'sending', 'sent', 'skipped', 'failed'));
