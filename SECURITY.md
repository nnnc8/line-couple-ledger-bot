# Security

If you discover a vulnerability, **please do not open a public GitHub issue.** Use one of the private channels below instead.

## Reporting

- GitHub: open a private security advisory at `https://github.com/nnnc8/line-couple-ledger-bot/security/advisories/new`.
- Email: see the maintainer contact in the repo owner profile.

Include: reproduction steps, impact, affected commit/version, and (if available) a minimal PoC.

We aim to acknowledge reports within 72 hours and ship a fix or mitigation within 30 days for high-severity issues, sooner if exploitation is active.

## Scope

In scope for this project:

- LINE webhook signature validation (`LINE_CHANNEL_SECRET`).
- LIFF session cookie integrity (`LIFF_SESSION_SECRET`).
- Idempotency of webhook processing (double-charge, replay).
- RLS / SQL injection paths in `pg` queries.
- Cron endpoint auth (`CRON_SECRET`).
- Secrets handling in `setup.html` and any future client-side setup helpers.

Out of scope: the user's own Supabase project, the user's own Vercel deployment, the user's LINE channel configuration.

## Operational notes for self-hosters

- Never commit `.env.local`. It is git-ignored but worth double-checking.
- Rotate `LIFF_SESSION_SECRET`, `CRON_SECRET`, and `COUPLE_SETUP_CODE` if they leak.
- The included `next.config.ts` ships a baseline of `Strict-Transport-Security`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, and a minimal `Permissions-Policy`. Review before changing.
- `setup.html` runs entirely in the browser; nothing is uploaded. It still uses `crypto.getRandomValues` for the setup code and secrets.
