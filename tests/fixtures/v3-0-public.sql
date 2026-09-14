-- Minimal, synthetic V1 dependencies for the checked-in V2 migrations.
-- Applied only to a newly created v3_0_test_* database on loopback.
create schema storage;
create table storage.buckets (
  id text primary key, name text not null, public boolean not null default false,
  file_size_limit bigint, allowed_mime_types text[]
);
create table public.couples (id smallint primary key, name text not null default 'Test couple');
create table public.users (
  id uuid primary key, couple_id smallint not null references public.couples(id),
  role text not null check (role in ('owner', 'partner')),
  line_user_id text not null unique, display_name text,
  unique (couple_id, role)
);
create table public.groups (
  id uuid primary key default gen_random_uuid(), couple_id smallint not null references public.couples(id),
  name text not null default 'Test group'
);
create table public.expenses (
  id uuid primary key default gen_random_uuid(), couple_id smallint not null references public.couples(id)
);
create table public.expense_splits (
  expense_id uuid not null references public.expenses(id), user_id uuid references public.users(id), amount_twd bigint
);
create table public.settlements (
  id uuid primary key default gen_random_uuid(), couple_id smallint not null references public.couples(id)
);
insert into public.couples (id) values (1), (2);
insert into public.users (id, couple_id, role, line_user_id) values
  ('11111111-1111-4111-8111-111111111111', 1, 'owner', 'line-owner'),
  ('22222222-2222-4222-8222-222222222222', 1, 'partner', 'line-partner'),
  ('33333333-3333-4333-8333-333333333333', 2, 'owner', 'line-other-owner'),
  ('44444444-4444-4444-8444-444444444444', 2, 'partner', 'line-other-partner');
