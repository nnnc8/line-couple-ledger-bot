-- Cleanup legacy confirm functions that are no longer used by runtime
DROP FUNCTION IF EXISTS public.confirm_pending_action(uuid, text, boolean);
DROP FUNCTION IF EXISTS public.confirm_batch_create_expenses(uuid, text, boolean);
DROP FUNCTION IF EXISTS public.confirm_batch_update_expenses(uuid, text, boolean);
