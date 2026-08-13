-- Stable, Ledger-scoped category identities. The transaction.category text
-- remains as a snapshot for backwards-compatible exports; category_id is the
-- canonical reference for new V2 writes.
create table ledger_v2.categories (
  id uuid primary key default gen_random_uuid(),
  couple_id smallint not null references public.couples(id) on delete cascade,
  ledger_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 40),
  status text not null default 'active' check (status in ('active', 'archived')),
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, ledger_id, couple_id),
  unique (ledger_id, couple_id, name),
  foreign key (ledger_id, couple_id)
    references ledger_v2.ledgers(id, couple_id) on delete cascade
);

create index categories_ledger_status_idx
  on ledger_v2.categories (ledger_id, status, name);

insert into ledger_v2.categories (couple_id, ledger_id, name, is_default)
select l.couple_id, l.id, category_name, true
  from ledger_v2.ledgers l
 cross join unnest(array['餐飲', '交通', '居家', '旅遊', '娛樂', '購物', '醫療', '其他']::text[]) as defaults(category_name)
on conflict (ledger_id, couple_id, name) do nothing;

alter table ledger_v2.transactions
  add column if not exists category_id uuid;

-- Preserve existing V2 text categories where they exactly match a seeded
-- label; unmatched historical text remains a snapshot and is not guessed.
update ledger_v2.transactions t
   set category_id = c.id
  from ledger_v2.categories c
 where t.category_id is null
   and t.category is not null
   and t.ledger_id = c.ledger_id
   and t.couple_id = c.couple_id
   and t.category = c.name;

create index if not exists transactions_category_idx
  on ledger_v2.transactions (ledger_id, category_id)
  where category_id is not null;

alter table ledger_v2.transactions
  drop constraint if exists transactions_category_fk;

alter table ledger_v2.transactions
  add constraint transactions_category_fk
  foreign key (category_id, ledger_id, couple_id)
  references ledger_v2.categories(id, ledger_id, couple_id)
  on delete restrict;

alter table ledger_v2.transactions enable row level security;
alter table ledger_v2.categories enable row level security;
revoke all on ledger_v2.categories from public, anon, authenticated;
grant select, insert, update, delete on ledger_v2.categories to service_role;
