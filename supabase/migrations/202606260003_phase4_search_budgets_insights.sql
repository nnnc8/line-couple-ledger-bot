alter table public.budgets
  add column if not exists category_label text;

alter table public.budgets drop constraint if exists budgets_category_label_check;
alter table public.budgets add constraint budgets_category_label_check
  check (
    category_label is null
    or (category is not null and length(btrim(category_label)) between 1 and 40)
  );

drop index if exists public.budgets_group_month_total_unique;
drop index if exists public.budgets_group_month_category_unique;

create unique index budgets_group_month_total_unique
  on public.budgets (group_id, month)
  where category is null and category_label is null;

create unique index budgets_group_month_category_unique
  on public.budgets (group_id, month, category)
  where category is not null and category_label is null;

create unique index budgets_group_month_label_unique
  on public.budgets (group_id, month, category, category_label)
  where category_label is not null;

alter table public.notifications
  add column if not exists insight_rule_id text;

alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
  check (kind in ('expense', 'settlement', 'budget', 'recurring', 'receipt', 'accountant', 'insight'));

create index if not exists notifications_insight_recent_idx
  on public.notifications (group_id, insight_rule_id, created_at desc)
  where insight_rule_id is not null;
