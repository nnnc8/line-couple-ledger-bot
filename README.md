# LINE Couple Ledger Bot

> Self-hosted, LINE-first AI expense tracker for couples, roommates, and small households.
> Speak in plain chat; an AI secretary writes the entry directly when a group is named (or when it's private); shared entries without a group name are rejected; a mobile LIFF dashboard shows the rest.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=nextdotjs)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue?logo=typescript)](https://www.typescriptlang.org)
[![Tests](https://img.shields.io/badge/tests-174%2F174%20passing-brightgreen)](#-verification)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

<p align="center">
  <a href="#-30-second-tour">30-second tour</a> •
  <a href="#-quickstart">Quickstart</a> •
  <a href="#-architecture">Architecture</a> •
  <a href="#-commands">Commands</a> •
  <a href="#-verification">Verification</a> •
  <a href="#-deploy">Deploy</a> •
  <a href="docs/">Docs</a>
</p>

---

## 30-second tour

1. Two people join a LINE group with the bot.
2. Anyone types a message like `dinner 860, I paid` (or `私人 lunch 120` for a private entry, or `<group name> dinner 860` for an explicit shared group).
3. The **secretary AI** commits single shared / private text entries directly in one Postgres transaction. Shared text entries without a group name are asked to disambiguate; images are rejected.
4. Both members open the LIFF dashboard for charts, history, private ledger, settlements, recurring templates, and recent decision history.
5. Edits, deletes, and settlements still go through a one-tap confirm flow in the LIFF.

> Looking for the original Traditional Chinese walkthrough? See [docs/README.zh-TW.md](docs/README.zh-TW.md).

## Features

- **LINE-native text + voice** — type free text or send a voice note; the secretary AI parses amount, payer, category, and split. (Images are accepted as a message and immediately rejected — see "v1 limits" below.)
- **Two-person scope, three modes** — shared expenses, private ledger per member, and full settlement. A pairing code locks the group to the first two members.
- **Direct text-entry writes** — single shared or private text entries commit in a single Postgres transaction. Shared text without an explicit group name is rejected with a `needs_group` prompt; private entries and chitchat are not gated.
- **Confirm flow for mutations** — updates, deletes, and settlements still go through a `pending_action` row with one-tap confirm or cancel. Idempotency keys prevent double-charging on LINE webhook retries.
- **Mobile LIFF dashboard** — Next.js 16 App Router + React 19 + Tailwind v4. Charts via Recharts, period budgets, recurring templates (rent, Netflix…), CSV bank import, recent-decision history, and a read-only agent-rules card.
- **Accountant AI on demand** — same chat can ask for category cleanup, anomaly detection, and month-over-month reports; the runner persists report/run rows even when the LLM hallucinates a field.
- **Self-hosted, no third-party finance SaaS** — your Supabase Postgres, your Vercel project, your Gemini key. No ads, no vendor lock-in.
- **Three-layer verification** — `pnpm test` (174 unit, no DB), `pnpm test:e2e` (2 Playwright), `pnpm smoke:*` (live DB, with cleanup).

## v1 limits

- **Images do not record an expense.** A photo is acknowledged with a fixed `image_rejected` reply and a write-behind `agent_events` row. Vision-based receipt parsing is out of scope for v1.
- **Shared text needs a group name.** "晚餐 500 我付" alone is rejected; the user must name a group (e.g. "共同生活 晚餐 500 我付") or be on the LIFF active group. Voice notes do not get a free pass.
- **Edits, deletes, and settlements** still use the one-tap confirm flow.

## Quickstart

> Prereqs: Node 22.x, pnpm 9+, a Supabase project, a LINE Messaging API channel + LINE Login channel in the **same** provider, a Google AI Studio (Gemini) key.

```bash
# 1. Clone and install
git clone https://github.com/nnnc8/line-couple-ledger-bot.git
cd line-couple-ledger-bot
pnpm install

# 2. Generate a local .env (browser-only, never uploaded)
#    Or open setup.html in your browser for a guided form.
cp .env.example .env.local
# fill in DATABASE_URL, LINE_*, SUPABASE_*, GEMINI_API_KEY, COUPLE_SETUP_CODE (>=20 chars),
# LIFF_SESSION_SECRET (>=32 chars), CRON_SECRET (>=16 chars), APP_URL

# 3. Apply database schema
pnpm dlx supabase login
pnpm dlx supabase link --project-ref <your-project-ref>
pnpm dlx supabase db push

# 4. Verify before you run anything for real
pnpm typecheck && pnpm test && pnpm test:e2e && pnpm build

# 5. Local dev (expose with ngrok / localtunnel to point LINE webhooks at it)
pnpm dev
```

Full env-var reference: [docs/env-vars.md](docs/env-vars.md). LINE/LIFF wiring: [docs/deploy-vercel.md](docs/deploy-vercel.md).

## Architecture

```
┌────────────────────────────────────────────────────────┐
│                      LINE Client                       │
└───────────┬────────────────────────────────┬───────────┘
            │ message / image / voice        │ tap → LIFF WebView
            ▼                                ▼
┌───────────────────────┐        ┌───────────────────────┐
│  LINE Messaging API   │        │   LINE Login (LIFF)   │
└───────────┬───────────┘        └───────────┬───────────┘
            │ webhook                        │ REST/hooks
            ▼                                ▼
┌────────────────────────────────────────────────────────┐
│              Next.js App Router (Vercel)               │
│                                                        │
│  ┌──────────────────────┐  ┌───────────────────────┐   │
│  │  Secretary Agent     │  │  Accountant Agent     │   │
│  │  (shared chat loop)  │  │  (analytics + cleanup)│   │
│  └──────────┬───────────┘  └──────────┬────────────┘   │
│             └────────────┬─────────────┘                │
│                          ▼                              │
│              pending_action → single tx commit          │
└──────────────────────────┬─────────────────────────────┘
                           │ DATABASE_URL
                           ▼
┌────────────────────────────────────────────────────────┐
│              Supabase Postgres (your data)             │
└────────────────────────────────────────────────────────┘
```

Key invariants:

- **ACID via direct Postgres** — every multi-row write goes through one `pg` transaction, not a Supabase PostgREST roundtrip.
- **No double processing** — webhook events carry a `sourceEventId`; the `pending_action` table uses idempotency keys.
- **Group membership is locked** — only the first two users who type `join <COUPLE_SETUP_CODE>` are bound; everyone else is rejected.
- **Public/private separation** — private entries never appear in the partner's ledger, but they still roll up into personal totals.

## Commands

| In LINE                       | Effect                                                   |
| :---------------------------- | :------------------------------------------------------- |
| `<group> dinner 860 I paid`   | Record a shared expense to that group; secretary infers `food` |
| `晚餐 500 我付`                | Shared text without a group name → `needs_group` reply   |
| `私人 lunch 120`              | Private entry, never shared with partner                 |
| `settle up`                   | Draft a settlement; partner must confirm                 |
| `who owes who`                | Net balance between the two members                      |
| `this month shared`           | Text report: totals + category breakdown                 |
| `this month private`          | Your private totals only                                 |
| `update the last one`         | Propose an edit to the most recent commit (LIFF confirm) |
| `delete the last one`         | Propose a delete of the most recent commit (LIFF confirm) |
| `[image]`                     | Rejected with a fixed reply; no expense is created       |
| `[voice]`                     | Transcribed, then routed through the text pipeline       |
| `join <COUPLE_SETUP_CODE>`    | Bind yourself to the group (first two only)              |
| `help`                        | Inline command sheet                                     |

Full handbook: [docs/commands.md](docs/commands.md).

## Verification

| Layer | Command | Needs DB? | Notes |
| :---- | :------ | :-------- | :---- |
| 1     | `pnpm typecheck` | no | strict TypeScript, no emit |
| 1     | `pnpm build`     | no | Next.js production build |
| 2     | `pnpm test`      | no | 174 unit tests with in-memory `FakeTxClient` |
| 2     | `pnpm test:e2e`  | no | 2 Playwright scenarios against the LIFF shell |
| 3     | `pnpm smoke:local` / `:recurring` / `:cron` | yes | Real Postgres; `SMOKE_CLEANUP_MODE` controls teardown |

> `pnpm lint` is currently being stabilized. The CI workflow does not gate on it yet — see [CONTRIBUTING.md](./CONTRIBUTING.md).

## Deploy

End-to-end Vercel + LINE + Supabase wiring: [docs/deploy-vercel.md](docs/deploy-vercel.md). The included `vercel.json` schedules `/api/cron/daily` at 17:15 UTC (01:15 TPE) to generate recurring entries and pending reminders.

## Repo metadata (one-time setup checklist)

When you fork or public-ize this repo, set these on GitHub:

- **Description**: `Self-hosted, LINE-first AI expense tracker for couples, roommates, and small households.`
- **Homepage**: your Vercel deployment URL
- **Topics**: `line-bot`, `liff`, `self-hosted`, `personal-finance`, `expense-tracker`, `ai-agent`, `supabase`, `nextjs`, `typescript`, `vercel`
- **Social preview**: upload `docs/assets/social-preview.png` (1280×640)
- **License**: MIT — this repo now ships a `LICENSE` file

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). For security issues, see [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE) © 2026 nnnc8 and contributors.
