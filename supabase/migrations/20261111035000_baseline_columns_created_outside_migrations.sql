-- Columns that exist on the live database but were added outside migration files.
ALTER TABLE public.accounting_period_closures
  ADD COLUMN IF NOT EXISTS bad_debt_loss numeric,
  ADD COLUMN IF NOT EXISTS closing_timezone text,
  ADD COLUMN IF NOT EXISTS pending_profit numeric,
  ADD COLUMN IF NOT EXISTS realized_profit numeric;

ALTER TABLE public.app_licenses
  ADD COLUMN IF NOT EXISTS device_bound_at timestamptz,
  ADD COLUMN IF NOT EXISTS device_reset_count integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_device_reset_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_lease_issued_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS max_offline_days integer DEFAULT 15,
  ADD COLUMN IF NOT EXISTS max_offline_invoices integer DEFAULT 100,
  ADD COLUMN IF NOT EXISTS max_products integer DEFAULT 100,
  ADD COLUMN IF NOT EXISTS offline_lease_secret text DEFAULT md5(random()::text || clock_timestamp()::text || gen_random_uuid()::text),
  ADD COLUMN IF NOT EXISTS plan_audience text DEFAULT 'individual',
  ADD COLUMN IF NOT EXISTS plan_id uuid,
  ADD COLUMN IF NOT EXISTS plan_name text DEFAULT 'فترة تجريبية',
  ADD COLUMN IF NOT EXISTS total_days integer DEFAULT 30;

ALTER TABLE public.debt_writeoffs
  ADD COLUMN IF NOT EXISTS loss_amount numeric,
  ADD COLUMN IF NOT EXISTS pending_profit_cancelled numeric;

ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS reversal_reason text,
  ADD COLUMN IF NOT EXISTS reversed_by uuid,
  ADD COLUMN IF NOT EXISTS status text DEFAULT 'completed';

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS currency_code text DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS currency_symbol text DEFAULT '$',
  ADD COLUMN IF NOT EXISTS paid_at_sale numeric,
  ADD COLUMN IF NOT EXISTS settlement_diff_usd numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS settlement_kind text NOT NULL DEFAULT 'exact',
  ADD COLUMN IF NOT EXISTS tax_inclusive boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS total_in_currency numeric DEFAULT 0;

ALTER TABLE public.payment_methods
  ADD COLUMN IF NOT EXISTS holder_name text,
  ADD COLUMN IF NOT EXISTS link_label text,
  ADD COLUMN IF NOT EXISTS logo_path text,
  ADD COLUMN IF NOT EXISTS qr_image_path text;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS telegram_linked_at timestamptz,
  ADD COLUMN IF NOT EXISTS telegram_username text;

ALTER TABLE public.recurring_expenses
  ADD COLUMN IF NOT EXISTS auto_pay_account text DEFAULT 'cash',
  ADD COLUMN IF NOT EXISTS custom_type text,
  ADD COLUMN IF NOT EXISTS interval_days integer DEFAULT 30,
  ADD COLUMN IF NOT EXISTS last_paid_date date,
  ADD COLUMN IF NOT EXISTS name text,
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS payment_method text DEFAULT 'cash';

ALTER TABLE public.stores
  ADD COLUMN IF NOT EXISTS appearance_settings jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS font_family text DEFAULT 'Cairo',
  ADD COLUMN IF NOT EXISTS primary_currency text DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS tax_type text DEFAULT 'exclusive';

ALTER TABLE public.subscription_plans
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS equivalents jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.user_roles
  ADD COLUMN IF NOT EXISTS can_refund boolean NOT NULL DEFAULT false;
