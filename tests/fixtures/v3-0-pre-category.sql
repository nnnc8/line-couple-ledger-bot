-- Entirely synthetic shape for the existing category migration regression:
-- 3 Ledgers, 215 expenses + 8 transfers, 101 text categories. No production data.
begin;
insert into ledger_v2.ledgers (id, couple_id, name, created_by_user_id)
select ('aaaaaaaa-aaaa-4aaa-8aaa-' || lpad(n::text,12,'0'))::uuid, 1, 'Synthetic ' || n,
       '11111111-1111-4111-8111-111111111111'::uuid from generate_series(1,3) n;
insert into ledger_v2.ledger_members (ledger_id, couple_id, user_id)
select l.id, 1, u.id from ledger_v2.ledgers l cross join public.users u where u.couple_id = 1;
insert into ledger_v2.ledger_default_shares (ledger_id, couple_id, user_id, weight)
select ledger_id, couple_id, user_id, 1 from ledger_v2.ledger_members;
insert into ledger_v2.transactions (id, couple_id, ledger_id, type, amount_twd, occurred_on, description, category, split_method, created_by_user_id)
select ('bbbbbbbb-bbbb-4bbb-8bbb-' || lpad(n::text,12,'0'))::uuid, 1,
       ('aaaaaaaa-aaaa-4aaa-8aaa-' || lpad((1+(n%3))::text,12,'0'))::uuid,
       case when n <= 215 then 'expense' else 'transfer' end, 100, '2026-08-13', 'Synthetic ' || n,
       case when n <= 101 then '餐飲' else null end,
       case when n <= 215 then 'equal' else 'none' end,
       '11111111-1111-4111-8111-111111111111'::uuid from generate_series(1,223) n;
insert into ledger_v2.transaction_payments (transaction_id, ledger_id, couple_id, user_id, amount_twd)
select id, ledger_id, couple_id, '11111111-1111-4111-8111-111111111111'::uuid, 100 from ledger_v2.transactions;
insert into ledger_v2.transaction_shares (transaction_id, ledger_id, couple_id, user_id, amount_twd)
select t.id, t.ledger_id, t.couple_id, u.id, case when t.type = 'transfer' then 100 else 50 end
from ledger_v2.transactions t cross join public.users u where u.couple_id = 1
and (t.type <> 'transfer' or u.id = '22222222-2222-4222-8222-222222222222'::uuid);
commit;
