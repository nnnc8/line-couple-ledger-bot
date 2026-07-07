# Deploy to Vercel + wire LINE

## 1. Vercel

1. Import the repo at <https://vercel.com/new>.
2. Framework preset: **Next.js** (auto-detected).
3. Copy every variable from `.env.example` into Project Settings → Environment Variables. For `LIFF_SESSION_SECRET` and `CRON_SECRET`, generate with `openssl rand -hex 32` and `openssl rand -hex 16` respectively. For `COUPLE_SETUP_CODE`, generate with `openssl rand -hex 12`.
4. Deploy. The included `vercel.json` schedules `/api/cron/daily` at 17:15 UTC (01:15 Asia/Taipei).

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
