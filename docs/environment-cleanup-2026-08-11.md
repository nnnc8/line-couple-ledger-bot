# v1 environment cleanup — 2026-08-11

This is the current environment handoff. The project has one canonical v1
source, one production artifact, and one Supabase project.

## Canonical source

- GitHub repository: `nnnc8/line-couple-ledger-bot`
- Default branch: `main`
- Local branch: `main`
- Canonical commit: `3a255c5897dedbad4bbcdf139dac35f761a125e9`
- Remote branches: `main` only
- Tags and open pull requests: none
- Pre-cleanup Git bundle: `/Users/nc8/Backups/line-ledger/20260811-environment-cleanup/github-pre-cleanup.bundle`

The former `codex/line-couple-bot-mvp` and `codex/v1-transfer-flow` branches
were deleted after the bundle was created. The old Git objects remain only as
local unreachable objects; garbage collection is intentionally deferred until
the backup retention window is over.

## Vercel

- Project: `line-couple-ledger-bot`
- Production branch: `main`
- Remaining deployment: `dpl_wi7XXqrjUCkG37vRnYwhQ6B8wPrq`
- Deployment state: `READY`, target `production`
- Source ref/SHA: `main` / `3a255c5897dedbad4bbcdf139dac35f761a125e9`
- Production alias: `https://line-couple-ledger-bot.vercel.app`
- Live checks: root HTTP 200; unsigned LINE webhook HTTP 401

All 43 older preview and production deployments were removed. Production
environment variables were not copied to preview or development; those
non-production targets remain empty by design.

## Supabase

- Project ref: `alzzyweydblyyvnbiwpn`
- Project status: `ACTIVE_HEALTHY`
- Preview branches: one default branch named `main`, associated with GitHub
  `main`, `with_data=false`
- Migration history: local and remote match through
  `20260729030618_add_line_menu_amount_drafts`
- `finance` schema: absent
- `public.line_menu_amount_drafts` rows: 9
- Supabase advisors at warning level: no findings

No schema migration was needed for this cleanup. The existing
`20260712103630_finance_v2_p0_repairs` migration remains because it contains
required v1 privacy, mirror, and pending-action repairs; its filename is not
an indication that the abandoned finance schema still exists.

## Local CLI snapshot

- Node `v22.23.1`
- pnpm `11.1.2`
- GitHub CLI `2.93.0`
- Vercel CLI `54.17.1`
- Supabase CLI `2.108.0`

The Vercel and Supabase CLIs report newer versions. Updating those local
operator tools is separate from the environment unification and should be
done in a follow-up after confirming the installation method and release
compatibility.

## Security note

During the cleanup audit, an authenticated Supabase branch inspection command
printed a service credential in the local tool transcript. Treat that
credential as exposed: rotate the Supabase service key in the Supabase
dashboard, update the Vercel production secret, redeploy `main`, and verify
the LINE webhook before considering the credential incident closed. No key
values are stored in this document or committed to Git.
