-- Remove legacy confirmation tasks now that all writes auto-confirm.
delete from public.assistant_tasks
where type = 'confirm_expense';

alter table public.assistant_tasks drop constraint if exists assistant_tasks_type_check;
alter table public.assistant_tasks add constraint assistant_tasks_type_check
  check (type in (
    'fix_uncertain_receipt',
    'review_unmatched_bank_items',
    'settlement_suggestion',
    'duplicate_expense_review',
    'merchant_rule_suggestion',
    'missing_daily_entry',
    'tag_cleanup',
    'recurring_expense_review'
  ));
