-- Drop the legacy PL/pgSQL function apply_pending_action_plan since
-- we have cut over to the TypeScript transaction executor.
DROP FUNCTION IF EXISTS public.apply_pending_action_plan(uuid, jsonb);
