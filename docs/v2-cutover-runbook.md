# Couple Ledger V2 cutover runbook

V2 is additive and remains disabled by default. The only supported sequence for a target couple is:

1. Apply and review both migrations with `supabase db push --include-all`.
2. Run `pnpm migration:v2:plan -- <output-path> <couple-id>` and retain the digest.
3. Run the guarded importer with `V2_COUPLE_ID=<id> V2_MIGRATION_APPLY=1 pnpm migration:v2:apply --apply`. It refuses any quarantine row, balance mismatch, changed source hash, or non-V1 writer state.
4. Review the verified `migration_batches` summary and run `V2_COUPLE_ID=<id> V2_CUTOVER_APPLY=1 pnpm migration:v2:cutover --apply`. It locks the V1 financial tables, verifies the zero-quarantine batch, fences V1, and atomically selects the V2 writer.
5. Only after authenticated LIFF/LINE smoke checks pass, enable `V2_LEDGER_ENABLED=1`, `NEXT_PUBLIC_V2_LEDGER_UI=1`, and (when a worker is scheduled) `V2_LINE_INBOX_ENABLED=1` for the target deployment.

No script deletes V1 rows. The workflow migration installs a database-side V1 write trigger so old expense, settlement, group, and split writers cannot create a second accounting truth after cutover. Rollback is intentionally a separately reviewed incident operation; do not flip `active_plane` manually.
