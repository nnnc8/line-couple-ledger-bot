# Couple Ledger V2 cutover runbook

V2 is additive and remains disabled by default. The only supported sequence for a target couple is:

1. Apply and review both migrations with `supabase db push --include-all`.
2. Run `pnpm migration:v2:plan -- <output-path> <couple-id>` and retain the digest.
3. Run the guarded importer with `V2_COUPLE_ID=<id> V2_MIGRATION_APPLY=1 pnpm migration:v2:apply --apply`. It refuses any quarantine row, balance mismatch, changed source hash, or non-V1 writer state.
4. Review the verified `migration_batches` summary and run `V2_COUPLE_ID=<id> V2_CUTOVER_APPLY=1 pnpm migration:v2:cutover --apply`. It locks the V1 financial tables, verifies the zero-quarantine batch, fences V1, and atomically selects the V2 writer.
5. Only after authenticated LIFF/LINE smoke checks pass, enable `V2_LEDGER_ENABLED=1`, `NEXT_PUBLIC_V2_LEDGER_UI=1`, and `V2_LINE_INBOX_ENABLED=1` for the target deployment. On Vercel Hobby, the signed webhook performs an opportunistic `after()` drain and `/api/cron/daily` is the durable 50-row-per-plane safety sweep; `/api/cron/v2-workers` is reserved for an external scheduler or Vercel Pro and is not registered in `vercel.json`.

No script deletes V1 rows. The workflow migration installs a database-side V1 write trigger so old expense, settlement, group, and split writers cannot create a second accounting truth after cutover. Rollback is intentionally a separately reviewed incident operation; do not flip `active_plane` manually.

Before any production rehearsal, clone the V1 schema and representative rows into
an isolated local PostgreSQL database, apply all migrations (including
`20260813031549_v2_transaction_lineage`, `20260813041139_v2_ledger_categories`,
and `20260813043813_v2_recurring_semantics`), run the plan/backfill, and then
run `V2_TEST_DATABASE_URL=<localhost-url> pnpm test:precutover`. The guarded
suite verifies atomic proposal rollback, every supported transaction shape,
LINE replay idempotency, receipt metadata, pagination/export, and worker retry
recovery without contacting Supabase production.
