-- canonical_labels: group-level label dictionary for category normalization
-- LLM reads this list before assigning labels; avoids divergent labels like 捷運/MRT/台北捷運

create table public.canonical_labels (
  id uuid primary key default gen_random_uuid(),
  group_id uuid references public.groups(id) on delete cascade,
  category text not null,
  label text not null check (length(btrim(label)) between 1 and 40),
  aliases text[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (group_id, category, label)
);

-- Private expenses (group_id is null) also need canonical labels
create unique index canonical_labels_private_idx
  on public.canonical_labels (category, label)
  where group_id is null;

create index canonical_labels_group_idx
  on public.canonical_labels (group_id, category);

alter table public.canonical_labels enable row level security;
revoke all on public.canonical_labels from anon, authenticated;
grant select, insert, update, delete on public.canonical_labels to service_role;
