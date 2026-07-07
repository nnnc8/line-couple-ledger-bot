# Contributing

Thanks for considering a contribution. This project is an English-first AI LINE finance starter kit; the original couple-ledger use case is the strongest demo scenario, not the only one.

## Local setup

1. Install Node 22.x (a `.nvmrc` is provided; run `nvm use`).
2. `pnpm install`
3. Copy `.env.example` to `.env.local` and fill in at minimum: `DATABASE_URL`, `LINE_*`, `SUPABASE_*`, `GEMINI_API_KEY`, `COUPLE_SETUP_CODE` (≥20 chars), `LIFF_SESSION_SECRET` (≥32 chars), `CRON_SECRET` (≥16 chars), `APP_URL`.
4. Apply schema: `pnpm dlx supabase db push`.

## Required checks (CI gates)

Before opening a PR, all four must pass locally:

```bash
pnpm typecheck
pnpm test           # 170 unit tests, no DB needed
pnpm test:e2e       # Playwright against the LIFF shell
pnpm build
```

`pnpm lint` is **not yet a required CI gate**. We're stabilizing the rule set; please run it locally and fix what you can, but don't let lint failures block a useful PR. Track lint cleanup in issues labeled `lint`.

## Code conventions

- TypeScript strict, no `any` in production code. Tests may use `any` for fake-DB ergonomics.
- Prefer small, named modules under `src/lib/`. The current `ledger-query`, `accountant`, `secretary`, and `pending-action` splits are deliberate — keep new code inside the right submodule.
- All multi-row writes go through `pg` transactions, not Supabase PostgREST.
- Every webhook handler must use the `sourceEventId` idempotency pattern.
- Add or update tests in the same change. Unit tests live next to code (`*.test.ts`); E2E lives in `tests/`.

## Commit and PR

- Branch from `main` with a descriptive name (`feature/recurring-rules-ui`, `fix/settlement-rounding`).
- Commit messages: short imperative summary, blank line, optional body. No emoji unless asked.
- PR description should include: what changed, why, how you tested, screenshots for UI.
- One topic per PR. Keep it small enough to review in 15 minutes.

## Reporting bugs / requesting features

Use the issue templates in `.github/ISSUE_TEMPLATE/`. For security issues, **do not** file a public issue — see [SECURITY.md](./SECURITY.md).

## Code of conduct

Be respectful. Assume good faith. This is a hobby-scale project; maintainers may take time to respond.
