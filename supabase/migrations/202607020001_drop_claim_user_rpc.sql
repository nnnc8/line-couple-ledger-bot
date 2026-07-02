-- Drop the legacy public.claim_user(text) RPC.
--
-- The TS helper `src/lib/claim-user.ts` is now the only path that
-- claims a user into the couple. It preserves the same
-- joined / already_joined / full contract and uses the
-- UNIQUE(line_user_id) and UNIQUE(couple_id, role) constraints
-- as the actual race guard.
--
-- The TS helper intentionally no longer relies on this RPC, so
-- removing it does not change application behavior.

revoke execute on function public.claim_user(text) from service_role;
drop function if exists public.claim_user(text);
