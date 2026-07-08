# Command handbook

The secretary AI is the only entry point; it picks the right tool based on intent. The list below is for users who want a deterministic path or are writing tests.

## Group binding

| Command | Effect |
| :--- | :--- |
| `join <COUPLE_SETUP_CODE>` | Bind the sender to the active group. First two callers only; third caller is rejected. |
| `who am i` | Echo your binding state. |

## Shared expenses

| Command | Effect |
| :--- | :--- |
| `<group> dinner 860, I paid` | Shared expense written directly to `<group>`, default split (equal). |
| `dinner 860, I paid` (no group) | If the user has only one group, it commits there. If the user has multiple groups, the bot replies with `needs_group` listing them. |
| `groceries 1200, partner paid, equal` | Explicit payer + split method. |
| `rent 18000, I paid, all to me` | "I paid, all to me" — full reimbursement to payer. |
| `change last one to 900` | Propose an edit to the most recent shared entry; the LIFF shows a one-tap confirm. |
| `delete the last one` | Propose a delete of the most recent shared entry; the LIFF shows a one-tap confirm. |

## Private ledger

| Command | Effect |
| :--- | :--- |
| `私人 lunch 120` | Private entry written directly; never appears in partner's ledger. |
| `private groceries 600` | English equivalent. |
| `delete my private lunch` | Propose a delete of a private entry; the LIFF shows a one-tap confirm. |

## Settlements

| Command | Effect |
| :--- | :--- |
| `settle up` | Draft a settlement. Partner must confirm; once both confirm, both ledgers zero out. |
| `cancel settlement` | Withdraw a pending settlement. |

## Reports and queries

| Command | Effect |
| :--- | :--- |
| `who owes who` | Net balance. |
| `this month shared` | Totals + category breakdown. |
| `this month private` | Your private totals only. |
| `last 6 months trend` | Series used by the dashboard chart. |
| `any anomalies?` | Runs the accountant anomaly detector. |
| `cleanup categories` | Suggests and applies a category merge plan. |

## Voice and images

| Input | Effect |
| :--- | :--- |
| Voice note | Transcribed to text, then routed through the same text pipeline (shared-with-group / private / chitchat). |
| Image | Rejected with the fixed reply `目前請直接用文字記帳，圖片暫不自動入帳 📝`. No expense is created. |

## Memory and tasks

| Command | Effect |
| :--- | :--- |
| `remember partner prefers oat milk` | Persists a memory keyed to the user. |
| `remind me to pay electric on the 5th` | Schedules a recurring task; the daily cron surfaces it as a pending action. |

## Help

| Command | Effect |
| :--- | :--- |
| `help` / `說明` | Inline command sheet. |
