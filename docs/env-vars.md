# Environment variables

All variables are read by the Next.js server at boot. `.env.local` is git-ignored; use `.env.example` as the template.

## Required

| Variable | Purpose | Validation |
| :--- | :--- | :--- |
| `DATABASE_URL` | Direct Postgres connection used by `pg` for ACID transactions. Distinct from `SUPABASE_URL`. | `postgresql://...` |
| `SUPABASE_URL` | Supabase project URL. | `https://<ref>.supabase.co` |
| `SUPABASE_SECRET_KEY` | Service-role key; bypasses RLS for admin paths. | opaque string |
| `LINE_CHANNEL_SECRET` | Webhook signature secret. | opaque string |
| `LINE_CHANNEL_ACCESS_TOKEN` | Messaging API token. | opaque string |
| `GEMINI_API_KEY` | Google AI Studio key for secretary + accountant. | opaque string |
| `COUPLE_SETUP_CODE` | Pairing code the first two LINE users must type to bind. | ≥ 20 chars |
| `LINE_LOGIN_CHANNEL_ID` | Numeric LINE Login channel id, for LIFF verification. | numeric string |
| `NEXT_PUBLIC_LIFF_ID` | LIFF app id; exposed to the browser. | opaque string |
| `LIFF_SESSION_SECRET` | Encrypts LIFF session cookies. | ≥ 32 chars |
| `APP_URL` | Public deployment URL; used in redirects and cron auth. | full URL |
| `CRON_SECRET` | Bearer token for `/api/cron/daily`. | ≥ 16 chars |

## Optional

| Variable | Purpose |
| :--- | :--- |
| `NEXT_PUBLIC_LINE_BASIC_ID` | Bot's LINE Basic ID (e.g. `@123xxxxx`). Used by LIFF UI to deep-link back to the chat. |
| `RELEASE_SHA` / `BUILD_TIMESTAMP` | Immutable source SHA and ISO-8601 build time exposed by `/api/version`. Set explicitly for CLI/prebuilt deployments where Vercel Git metadata may be blank. |
| `V2_LEDGER_ENABLED` | Server-side Couple Ledger V2 API and writer gate. `0` (default) keeps the additive V2 API unavailable in a fresh environment; set to `1` only after the migration/cutover gates pass. The root LIFF entry is V2-only and has no separate public UI flag. |
| `V2_LINE_INBOX_ENABLED` | Persists signed LINE webhook events to the durable V2 inbox before dispatch. Keep off until the workflow migration is applied. On Vercel Hobby, webhook `after()` opportunistic drain plus the daily safety sweep are the supported scheduler; use an external scheduler or Vercel Pro for tighter retry cadence. |
| `V2_MIGRATION_APPLY` / `V2_CUTOVER_APPLY` | Explicit one-shot safety gates for the guarded V2 migration and writer-plane cutover scripts. Never set them as persistent deployment flags. |

`V2_INCIDENT_BOOTSTRAP_ONLY` is a deployment-only incident compatibility gate;
when set to `1` it holds unsupported V2 routes and workers. It is not a
product or UI flag.

The CLI/test-only variables `V2_COUPLE_ID`, `V2_MIGRATION_BATCH_KEY`, and
`V2_TEST_DATABASE_URL` are intentionally absent from the application
environment template. PostgreSQL rehearsal tests accept only an isolated
localhost `V2_TEST_DATABASE_URL`; they must never receive the linked Supabase
`DATABASE_URL`.

## Smoke-only (Layer 3)

These are **only** read by `pnpm smoke:*` commands. Keep them blank in production.

| Variable | Purpose |
| :--- | :--- |
| `SMOKE_LINE_USER_ID` | Owner LINE user id; must already exist in `users`. |
| `SMOKE_PARTNER_LINE_USER_ID` | Partner LINE user id; must already exist in `users`. |
| `SMOKE_GROUP_NAME` | Target couple group; auto-created if missing. |
| `SMOKE_CLEANUP_MODE` | `always` (default) or `on-success`. |
