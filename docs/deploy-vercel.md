# Deploy to Vercel + wire LINE

## 1. Vercel

1. Import the repo at <https://vercel.com/new>.
2. Framework preset: **Next.js** (auto-detected).
3. Copy every variable from `.env.example` into Project Settings → Environment Variables. For `LIFF_SESSION_SECRET` and `CRON_SECRET`, generate with `openssl rand -hex 32` and `openssl rand -hex 16` respectively. For `COUPLE_SETUP_CODE`, generate with `openssl rand -hex 12`.
4. Deploy. The included `vercel.json` schedules `/api/cron/daily` at 17:15 UTC (01:15 Asia/Taipei).

V2 inbox and notification workers intentionally do not use a separate per-minute
Vercel Cron. Vercel Hobby rejects schedules more frequent than once per day at
deployment time. When `V2_LINE_INBOX_ENABLED=1`, a signed webhook is committed
to `ledger_v2.line_inbox` and then opportunistically drained by the same request
through `after()`. The daily cron is the safety sweep and drains both the inbox
and notification outbox again. A failed attempt is persisted with exponential
backoff of 120s, 240s, 480s, 960s, 1920s, 3600s, then 3600s, and a maximum of
eight attempts. On Hobby, the next scheduled sweep is the actual upper bound
for a retry that was not drained opportunistically: at most about 24h59m,
allowing for Vercel's ±59 minute daily scheduling window. Seven failed sweeps
can therefore take at most about 7d6h53m before the eighth attempt is
dead-lettered. With an external scheduler (or Vercel Pro) polling
`/api/cron/v2-workers` every minute, each due retry adds at most one minute of
scheduler delay to the persisted backoff. The endpoint remains available for
that tighter cadence, but is not registered as a Vercel Cron on Hobby.

For isolated PostgreSQL rehearsal, use `V2_TEST_DATABASE_URL` with
`pnpm test:precutover`. The test refuses non-localhost URLs; it must never
receive the linked Supabase `DATABASE_URL`.

## 2. Supabase

1. Create a project, copy the `DATABASE_URL` from Project Settings → Database → Connection string → **Direct** (not the pooler; we use a single connection per request).
2. Locally, link and push schema:
   ```bash
   pnpm dlx supabase login
   pnpm dlx supabase link --project-ref <ref>
   pnpm dlx supabase db push
   ```

## 3. LINE Messaging API

1. In the [LINE Developers Console](https://developers.line.biz/), open your provider → Messaging API channel.
2. Channel → **Messaging API** tab:
   - **Webhook URL**: `https://<your-vercel-domain>/api/line/webhook`
   - Enable **Use webhook** and **Webhook redelivery**.
   - **Verify** should return 200.
3. Issue a long-lived **Channel access token** and put it in `LINE_CHANNEL_ACCESS_TOKEN`.

## 4. LINE Login + LIFF

In the **same provider**, create a LINE Login channel, then add a LIFF app:

- **Size**: `Full`
- **Endpoint URL**: `https://<your-vercel-domain>/`
- **Scopes**: `openid`, `profile`
- **Bot link feature**: optional; recommended for the "open in chat" UI.

Copy the LIFF id to `NEXT_PUBLIC_LIFF_ID` and the channel id to `LINE_LOGIN_CHANNEL_ID`.

## 5. Smoke test (optional, Layer 3)

`pnpm smoke:local` exercises the full create → split → settle → cleanup loop against your real DB. Set the `SMOKE_*` env vars per [env-vars.md](env-vars.md). Failures are loud; successes auto-clean.

The smoke scripts assume the `agent_events` migration (`supabase/migrations/202607080001_agent_events.sql`) has been applied. If you see a `relation "agent_events" does not exist` error, apply the migration first.
