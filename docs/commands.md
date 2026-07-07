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
| `dinner 860, I paid` | Shared expense, default split (equal). |
| `groceries 1200, partner paid, equal` | Explicit payer + split method. |
| `rent 18000, I paid, all to me` | "I paid, all to me" — full reimbursement to payer. |
| `change last one to 900` | Update the most recent commit (within 5 min). |
| `delete the last one` | Withdraw the most recent commit (within 5 min). |

## Private ledger

| Command | Effect |
| :--- | :--- |
| `私人 lunch 120` | Private entry; never appears in partner's ledger. |
| `private groceries 600` | English equivalent. |
| `delete my private lunch` | Withdraw a private commit (within 5 min). |

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

## Memory and tasks

| Command | Effect |
| :--- | :--- |
| `remember partner prefers oat milk` | Persists a memory keyed to the user. |
| `remind me to pay electric on the 5th` | Schedules a recurring task; the daily cron surfaces it as a pending action. |

## Help

| Command | Effect |
| :--- | :--- |
| `help` / `說明` | Inline command sheet. |
