# Finance v2 baseline

Captured 2026-07-12 18:32–18:35 Asia/Taipei from Supabase project `alzzyweydblyyvnbiwpn`.

## Repository and database

- Git branch: `codex/personal-finance-v2`
- Starting commit: `d441888cf9d1b76aeba7d92a475acf05c8637a9d`
- Supabase: `ACTIVE_HEALTHY`, PostgreSQL 17.6.1, `ap-southeast-1`
- Migration head before P0: `20260710_multi_currency`
- Migration applied during this rollout: `20260712103630_finance_v2_p0_repairs`
- Schema source: `supabase/migrations/`
- A Supabase development branch could not be created because the current plan does not support branching.

## Row counts

| Table | Rows |
| --- | ---: |
| `users` | 2 |
| `groups` | 3 |
| `expenses` | 397 |
| `expense_splits` | 577 |
| `settlements` | 3 |
| `pending_actions` | 317 |
| `secretary_sessions` | 3 |
| `agent_events` | 7 |

## P0 invariants before repair

- Shared expenses requiring a positive split: 257 mirror rows.
- Valid active private mirrors: 126.
- Missing or stale mirrors: 131.
- `pending_actions` still marked `pending` after expiry: 51.
- Existing secretary sessions are couple/group-scoped and can mix the two users' messages.

Current group balances:

| Group | User A | User B |
| --- | ---: | ---: |
| 阿提斯 | -NT$16,235 | +NT$16,235 |
| 吃飽喝足 | +NT$413 | -NT$413 |

## Category totals snapshot

The exact six-month category query result was:

| Month | Tagged totals |
| --- | --- |
| 2026-07 | 餐飲 1,473 / 8；其他 7,616 / 4；維修保養 16,000 / 1；醫療 180 / 1；甜點 115 / 2；交通 198 / 1 |
| 2026-06 | 餐飲 1,868 / 4；車貸 5,600 / 1；信用卡費 3,277 / 1；停車費 105 / 1；其他 1,024 / 1；晚餐 漢堡 95 / 1；泰式甜點 130 / 1；越南 290 / 1 |
| 2026-05 | 油資 4,512 / 5；車貸 5,600 / 1；維修保養 1,400 / 1；信用卡費 1,036 / 1；停車費 90 / 1 |
| 2026-04 | 維修保養 24,400 / 4；油資 4,894 / 5；稅金 7,120 / 1；車貸 5,600 / 1；信用卡費 14,735 / 1；停車費 70 / 1 |
| 2026-03 | 油資 3,507 / 5；維修保養 5,600 / 1；車貸 5,600 / 1；信用卡費 3,331 / 1；停車費 195 / 4；交通 50 / 1 |
| 2026-02 | 維修保養 10,000 / 1；保險費 10,478 / 1；信用卡費 4,415 / 1；停車費 75 / 2；其他 863 / 1 |

Numbers after `/` are expense counts. The source query groups shared non-deleted expenses by `date_trunc('month', expense_date)` and `tag`.

## Backup and rollback boundary

- Logical P0 backup: `.finance-v2/backups/production-p0-20260712.sql`
- Covered tables: `pending_actions`, `expenses`, `expense_splits`, `activity_events`, `secretary_sessions`.
- The backup is ignored by Git and contains live financial data. Restore requires a reviewed maintenance transaction; it must not be run blindly against a populated database.
- Supabase CLI's linked dump was attempted but requires Docker on this workstation. The `pg`-based backup above is the usable P0 rollback artifact.

## Advisor baseline

Supabase advisors returned INFO-level findings: RLS is enabled without policies on service-role-only tables, and several foreign keys are unindexed. These are recorded as baseline findings, not silently treated as resolved.
