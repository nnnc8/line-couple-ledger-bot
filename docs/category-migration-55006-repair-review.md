# CATEGORY MIGRATION 55006 REPAIR REVIEW

日期：2026-08-14

Repository：`line-couple-ledger-bot`

Branch：`codex/couple-ledger-v2-incident-bootstrap`

本文件只記錄本機隔離 rehearsal、migration 修正與測試。沒有執行 production retry、deploy、unfreeze、LINE/Rich Menu 變更或 financial write。

## 1. Failure reproduction

使用已驗證 recovery dump `20260814T060504Z` 建立本機 database `cl_cat_repair_before_20260814`。其狀態符合 production categories migration 失敗後的前置狀態：

- 223 transactions、223 payments、438 shares
- `ledger_v2.categories` 不存在
- `transactions.category_id` 不存在
- `recurring_rules.category_id` 不存在
- lineage、retry/dead-letter 與 incident freeze 已存在

執行未修改的 `20260813041139_v2_ledger_categories.sql`：

```text
psql -d cl_cat_repair_before_20260814 -v ON_ERROR_STOP=1 -1 \\
  -f supabase/migrations/20260813041139_v2_ledger_categories.sql
```

結果：`UPDATE 101` 後於 `CREATE INDEX transactions_category_idx` 失敗：

```text
ERROR: cannot CREATE INDEX "transactions" because it has pending trigger events
SQLSTATE 55006
```

`-1` transaction rollback 後，categories table、category column、index 均不存在，沒有 partial schema。

## 2. PostgreSQL trigger root cause

categories migration 的 backfill DML 是：

```sql
update ledger_v2.transactions t
   set category_id = c.id
  from ledger_v2.categories c
 where t.category_id is null
   and t.category is not null
   and t.ledger_id = c.ledger_id
   and t.couple_id = c.couple_id
   and t.category = c.name;
```

本機 production-shape fixture 中此 UPDATE 命中 101 rows。每一列 UPDATE 都排入 `ledger_v2.transactions` 的 deferred constraint trigger。原 migration 隨後對同一 relation 執行 CREATE INDEX，PostgreSQL 不允許在仍有 pending trigger events 時重建該 relation 的 index，因此回傳 55006。

## 3. Pending constraint/trigger identity

catalog 查詢確認唯一相關的 deferred user constraint trigger：

| 欄位 | 值 |
|---|---|
| trigger | `transaction_integrity_on_header` |
| constraint | `transaction_integrity_on_header` |
| function | `ledger_v2.assert_transaction_integrity()` |
| table | `ledger_v2.transactions` |
| timing | `AFTER INSERT OR DELETE OR UPDATE` |
| deferrable | `true` |
| initially deferred | `true` |
| `pg_constraint.contype` | `t` (constraint trigger) |

既有 transactions 外鍵 triggers 均為非 deferred / initially immediate；它們不是這次 55006 的根因。

## 4. Existing migration ordering

原始順序：

1. 建立 `ledger_v2.categories`
2. 建立 categories index
3. seed 每個 Ledger 的預設 categories
4. 新增 `transactions.category_id`
5. UPDATE transactions 做 category backfill
6. 建立 `transactions_category_idx`
7. drop/add `transactions_category_fk`
8. 對 transactions 啟用 RLS
9. 對 categories 啟用 RLS、revoke/grant

問題不只在第 6 步。實驗中只把 index 提前後，CREATE INDEX 雖通過，但第 7 步 `ALTER TABLE transactions` 仍因同一批 pending events 失敗；再保留 transactions RLS DDL 也會在第 8 步失敗。

## 5. Fix options evaluated

### Option A — move transactions DDL before backfill

有效，但必須移動所有會碰 `ledger_v2.transactions` 的 DDL，而不只是 index：

- `transactions_category_idx`
- drop/add `transactions_category_fk`
- `ALTER TABLE transactions ENABLE ROW LEVEL SECURITY`

這些操作都在 UPDATE 前完成。partial index 可在所有 `category_id` 仍為 NULL 時建立；後續 UPDATE 由 PostgreSQL 自動維護 index。category FK 允許 NULL，且已 seed 的 category references 通過驗證。此方案不改 accounting data 或 trigger mode，最終 schema 與原意相同。

### Option B — `SET CONSTRAINTS transaction_integrity_on_header IMMEDIATE`

catalog 上的 exact constraint 已確認可指定。此語句會立即執行目前 pending 的 integrity checks；現有 fixture 的 transaction rows 可通過檢查。但它會把 constraint mode 的時序語意帶入 migration，且仍需確保後續所有 transactions DDL 不再遇到 pending events。相較之下，Option A 不改 constraint mode，風險與 diff 都較小，因此未採用 `SET CONSTRAINTS ALL IMMEDIATE` 或拆 migration。

## 6. Selected minimal fix

已修改同一個 migration timestamp `20260813041139_v2_ledger_categories.sql`：

- 保留 `category_id` column add 在前
- 將 index、FK drop/add、transactions RLS 全部移到 backfill 前
- backfill UPDATE 成為 transactions DDL 後的最後一步
- 保留 categories RLS / revoke / grant

沒有更名 timestamp、沒有新增 production migration、沒有修改已套用的 lineage 或 incident-freeze migration。

修正 migration SHA-256：

```text
88096443a392d9c8a96f3e1703f7ae3f779d13ae3b6b1f9e178bbefee880c765
```

## 7. Production partial-state verification

使用既有 production post-failure read-only evidence：

`/Users/nc8/Documents/New project/artifacts/production-recovery/20260814T065332Z/schema-forward-repair/post-failure-snapshot.json`

確認：

- applied：shadow、workflows、lineage、incident freeze
- not applied：categories、recurring semantics
- `ledger_v2.categories` 不存在
- `transactions.category_id` 不存在
- `recurring_rules.category_id` 不存在
- lineage/retry objects 與 freeze objects 存在
- quarantine = 0
- `active_plane = v2`
- `financial_writes_enabled = false`
- 金融 counts、Ledger balances、兩筆 V2-only rows 與套用前一致

本節只讀取既有 evidence；本輪沒有連 production。

## 8. Current-state rehearsal

在 `cl_cat_repair_baseline_20260814` 還原相同 recovery dump，僅在本機用 Supabase CLI repair metadata 模擬既有 migration history。執行：

```text
supabase db push --db-url 'postgresql://.../cl_cat_repair_baseline_20260814?sslmode=disable' \\
  --include-all --dry-run --workdir /tmp/couple-ledger-v2-incident-bootstrap
```

dry-run 精確列出兩個 pending migrations：

```text
20260813041139_v2_ledger_categories.sql
20260813043813_v2_recurring_semantics.sql
```

以相同 local `db push --include-all --yes` 套用後：

- categories migration：PASS
- recurring semantics migration：PASS
- categories：24（3 Ledgers × 8 defaults）
- exact category links：101
- transactions/payments/shares：223 / 223 / 438
- recurring category column/FK：存在
- migration history：categories、recurring 各記錄一次

## 9. Full migration rehearsal

建立全新本機 `cl_cat_repair_fresh_20260814`：

1. 還原代表性 V1 data（622 expenses、835 expense_splits、3 groups）。
2. 僅在本機移除既有 V2 shadow schema，保留 V1 data。
3. 因 production backup 明確排除 Supabase `storage` schema，補入最小等價本機 `storage.buckets` fixture；沒有連任何遠端 storage。
4. 以 local migration history 將 V1 migrations 標成已套用。
5. dry-run 列出六個 V2 migrations，按 timestamp 順序全部套用。
6. 執行 local deterministic backfill：

```text
DATABASE_URL='postgresql://.../cl_cat_repair_fresh_20260814?sslmode=disable' \\
V2_MIGRATION_APPLY=1 V2_COUPLE_ID=1 \\
pnpm migration:v2:apply -- --apply
```

結果：

- six V2 migrations：PASS
- deterministic batch：`status=verified`
- Ledgers：3
- backfilled transactions：221
- excluded mirrors：366
- excluded private：43
- quarantine：0
- categories：24，linked categories：101
- freeze schema：PASS，writer remains `v1` / `financial_writes_enabled=true`

Fresh backfill reconciliation：

| Ledger | transactions | active amount | owner balance | partner balance |
|---|---:|---:|---:|---:|
| 共同生活 | 0 | 0 | 0 | 0 |
| 阿提斯 | 156 | 269,491 | -18,916 | 18,916 |
| 吃飽喝足 | 65 | 23,069 | 542 | -542 |

每個 Ledger 均獨立、零和，沒有跨 Ledger offset。

## 10. Category backfill validation

Current-state fixture 的結果：

- 3 Ledgers、24 default categories
- 213 transactions 有 textual category
- 101 exact text-to-category links
- 112 unmatched textual values 保留 snapshot、`category_id` 維持 NULL
- category IDs 為 Ledger-scoped
- cross-Ledger category violations：0
- duplicate default category names：0
- payment/share/amount 沒有改變

Unmatched 值（例如 `油資`、`停車費`、`維修保養`）沒有被猜測或跨 Ledger 指派，符合 migration 註解的 deterministic 行為。

## 11. Accounting invariant comparison

Current-state migration 前後的 canonical financial digest（排除 category metadata、包含 transaction/payment/share truth）相同：

```text
BEFORE = feb5cd19e50a88dd7fe2f277621770d7
AFTER  = feb5cd19e50a88dd7fe2f277621770d7
```

兩側均為：223 transactions、223 payments、438 shares、總 amount `403816`。

每個 Ledger 的 signed balance 也完全相同：

- 共同生活：0 / 0
- 阿提斯：-18,916 / 18,916
- 吃飽喝足：7 / -7

## 12. Migration-history rehearsal

Current-state history simulation：

- lineage = applied once
- freeze = applied once
- categories = applied once
- recurring = applied once
- dry-run 只列 categories + recurring

Fresh-V1 history simulation：

- 所有 V1 migrations = applied once
- 六個 V2 migrations = applied once
- 無 duplicate timestamp
- `supabase migration list --db-url ...` local output 的 local/remote versions 全部一致

所有 `migration repair` 操作只針對 localhost rehearsal metadata，沒有對 linked/production 執行。

## 13. Test results

| Command | Result |
|---|---|
| `pnpm typecheck` | PASS |
| `pnpm test` | PASS，233 tests |
| `pnpm test:tx` | PASS，23 pass；8 opt-in PostgreSQL/Supabase tests skipped，因本機未提供 Supabase REST credentials |
| `pnpm test:precutover` | PASS，5 tests，使用 local PostgreSQL |
| `pnpm test:incident` | PASS，5 tests；含 real PostgreSQL 55006 regression |
| `pnpm test:bootstrap` | PASS，1 test，使用 local PostgreSQL |
| `pnpm test:e2e -- --reporter=line` | PASS，36/36 Chromium/WebKit |
| `pnpm build` | PASS，Next.js production build |
| current-state local dry-run/apply | PASS |
| fresh-V1 six-migration apply + backfill | PASS，quarantine=0 |

新增 regression test `src/lib/v2-category-migration.pg.test.ts`：

- 真正執行 PostgreSQL transaction
- 用原始 order 重現 SQLSTATE 55006
- 驗證 rollback 後 categories schema 完全不存在
- 用修正版 order 執行並 `SET CONSTRAINTS ALL IMMEDIATE`
- 驗證 24 categories、101 links、223/223/438 financial rows

另外修正既有 bootstrap test 的 missing-schema assertion：原本把「存在」判成 missing，且取錯三段名稱；修正只涉及 test gate，不涉及產品 writer。

## 14. Commit/diff

本輪 diff：

- `supabase/migrations/20260813041139_v2_ledger_categories.sql`：將 transactions DDL 移至 backfill 前
- `src/lib/v2-category-migration.pg.test.ts`：新增 PostgreSQL regression test
- `src/lib/v2-bootstrap-compatibility.pg.test.ts`：修正既有 schema-gate assertion
- `package.json`：新增 `test:incident`
- `docs/category-migration-55006-repair-review.md`：本報告

建議 commit：

```text
fix: avoid pending trigger events in category migration
```

目前尚未 push、尚未 deploy。

## 15. Production retry plan

以下命令只供下一個獲批准的 production change window；本 review **沒有執行**。

### Preconditions — READ ONLY

1. 確認 production 仍 frozen，financial digest/reconciliation 未變。
2. 確認 migration history 為 lineage + freeze 已套用，categories/recurring 未套用。
3. 確認 categories table、`transactions.category_id`、`recurring_rules.category_id` 仍不存在。
4. 確認 recovery point `20260814T060504Z` 可用。
5. 記錄修正版 categories migration SHA：`88096443a392d9c8a96f3e1703f7ae3f779d13ae3b6b1f9e178bbefee880c765`。
6. 重新確認 local old-order reproduction、corrected current-state apply、fresh-V1 rehearsal 全部 PASS。

### Production pending-list check — READ ONLY

```text
supabase db push --linked --include-all --dry-run --output-format json --yes
```

唯一允許的 pending list 必須是：

```text
20260813041139_v2_ledger_categories.sql
20260813043813_v2_recurring_semantics.sql
```

### Production retry — PRODUCTION MUTATION — DO NOT EXECUTE DURING THIS REVIEW

```text
supabase db push --linked --include-all --yes
```

不可重新套用 lineage，不可 rerun incident-freeze，不可使用 manual SQL 或 `migration repair`。套用失敗時立即停止，不得 retry loop；套用成功後只做 read-only catalog、history、financial digest 與 Ledger reconciliation，仍不得 unfreeze 或切換 writer。

## 16. GO / NO-GO

本機 root-cause reproduction、最小修正、current-state rehearsal、fresh-V1 full rehearsal、accounting invariants 與 regression tests 均通過。修正可進入 production retry 的人工審查，但本輪沒有取得 production retry 授權，也沒有執行 production mutation。

CATEGORY MIGRATION FIX APPROVED FOR PRODUCTION RETRY REVIEW

PRODUCTION RETRY: NO-GO

FULL CUTOVER: NO-GO
