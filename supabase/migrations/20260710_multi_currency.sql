-- Multi-currency support for expenses
-- currency: the original currency code (TWD, USD, JPY, etc.)
-- original_amount: the amount in the original currency (NULL for TWD)
-- amount_twd always stores the TWD-converted amount

ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'TWD';
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS original_amount numeric;

-- Index for filtering by currency if needed in the future
CREATE INDEX IF NOT EXISTS expenses_currency_idx ON public.expenses (currency) WHERE deleted_at IS NULL;
