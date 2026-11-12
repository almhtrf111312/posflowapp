-- Live snapshot of public schema (tables, columns, constraints, indexes, RLS status)

CREATE TYPE public.app_role AS ENUM ('admin', 'cashier', 'boss');

-- ===== public.account_encryption_keys (RLS enabled: True, forced: False) =====
CREATE TABLE public.account_encryption_keys (
  user_id uuid NOT NULL,
  key_material text NOT NULL,
  key_version integer NOT NULL DEFAULT 1,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT account_encryption_keys_pkey PRIMARY KEY (user_id),
  CONSTRAINT account_encryption_keys_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);
ALTER TABLE public.account_encryption_keys ENABLE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX account_encryption_keys_pkey ON public.account_encryption_keys USING btree (user_id);

-- ===== public.accounting_period_closures (RLS enabled: True, forced: False) =====
CREATE TABLE public.accounting_period_closures (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  total_revenue numeric NOT NULL DEFAULT 0,
  total_cogs numeric NOT NULL DEFAULT 0,
  gross_profit numeric NOT NULL DEFAULT 0,
  total_expenses numeric NOT NULL DEFAULT 0,
  net_profit numeric NOT NULL DEFAULT 0,
  partner_distributions jsonb NOT NULL DEFAULT '[]'::jsonb,
  closed_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  realized_profit numeric,
  pending_profit numeric,
  bad_debt_loss numeric,
  closing_timezone text,
  CONSTRAINT accounting_period_closures_pkey PRIMARY KEY (id)
);
ALTER TABLE public.accounting_period_closures ENABLE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX accounting_period_closures_pkey ON public.accounting_period_closures USING btree (id);

-- ===== public.activation_codes (RLS enabled: True, forced: False) =====
CREATE TABLE public.activation_codes (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  code text NOT NULL,
  duration_days integer NOT NULL,
  max_uses integer DEFAULT 1,
  current_uses integer DEFAULT 0,
  is_active boolean DEFAULT true,
  note text,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now(),
  expires_at timestamp with time zone,
  max_cashiers integer DEFAULT 1,
  license_tier text DEFAULT 'basic'::text,
  assigned_user_id uuid,
  assigned_email text,
  used_by uuid,
  used_at timestamp with time zone,
  locked_device_id text,
  CONSTRAINT activation_codes_code_key UNIQUE (code),
  CONSTRAINT activation_codes_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT activation_codes_current_uses_check CHECK ((current_uses >= 0)),
  CONSTRAINT activation_codes_duration_days_check CHECK ((duration_days > 0)),
  CONSTRAINT activation_codes_max_uses_check CHECK ((max_uses > 0)),
  CONSTRAINT activation_codes_pkey PRIMARY KEY (id)
);
ALTER TABLE public.activation_codes ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_activation_codes_assigned_user ON public.activation_codes USING btree (assigned_user_id);
CREATE INDEX idx_activation_codes_code ON public.activation_codes USING btree (code);
CREATE UNIQUE INDEX activation_codes_code_key ON public.activation_codes USING btree (code);
CREATE UNIQUE INDEX activation_codes_pkey ON public.activation_codes USING btree (id);

-- ===== public.activity_log (RLS enabled: True, forced: False) =====
CREATE TABLE public.activity_log (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  actor_id uuid,
  actor_name text,
  actor_role text,
  action_type text NOT NULL,
  entity_type text,
  entity_id text,
  entity_name text,
  description text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT activity_log_pkey PRIMARY KEY (id)
);
ALTER TABLE public.activity_log ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_activity_log_action ON public.activity_log USING btree (user_id, action_type, created_at DESC);
CREATE INDEX idx_activity_log_entity ON public.activity_log USING btree (user_id, entity_type, entity_id);
CREATE INDEX idx_activity_log_user_date ON public.activity_log USING btree (user_id, created_at DESC);
CREATE UNIQUE INDEX activity_log_pkey ON public.activity_log USING btree (id);

-- ===== public.app_broadcasts (RLS enabled: True, forced: False) =====
CREATE TABLE public.app_broadcasts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  title text NOT NULL,
  body text NOT NULL DEFAULT ''::text,
  kind text NOT NULL DEFAULT 'info'::text,
  link_url text,
  is_active boolean NOT NULL DEFAULT true,
  expires_at timestamp with time zone,
  created_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  target_version_code integer,
  CONSTRAINT app_broadcasts_pkey PRIMARY KEY (id)
);
ALTER TABLE public.app_broadcasts ENABLE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX app_broadcasts_pkey ON public.app_broadcasts USING btree (id);

-- ===== public.app_licenses (RLS enabled: True, forced: False) =====
CREATE TABLE public.app_licenses (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  device_id text,
  activation_code_id uuid,
  activated_at timestamp with time zone DEFAULT now(),
  expires_at timestamp with time zone NOT NULL,
  is_trial boolean DEFAULT false,
  created_at timestamp with time zone DEFAULT now(),
  max_cashiers integer DEFAULT 1,
  current_cashiers integer DEFAULT 0,
  license_tier text DEFAULT 'basic'::text,
  is_revoked boolean DEFAULT false,
  revoked_at timestamp with time zone,
  revoked_reason text,
  allow_multi_device boolean DEFAULT false,
  updated_at timestamp with time zone DEFAULT now(),
  max_offline_days integer DEFAULT 15,
  max_offline_invoices integer DEFAULT 100,
  offline_lease_secret text DEFAULT md5((((random())::text || (clock_timestamp())::text) || (gen_random_uuid())::text)),
  last_lease_issued_at timestamp with time zone DEFAULT now(),
  last_device_reset_at timestamp with time zone,
  device_reset_count integer DEFAULT 0,
  plan_id uuid,
  plan_name text DEFAULT 'فترة تجريبية'::text,
  plan_audience text DEFAULT 'individual'::text,
  total_days integer DEFAULT 30,
  max_products integer DEFAULT 100,
  device_bound_at timestamp with time zone,
  CONSTRAINT app_licenses_activation_code_id_fkey FOREIGN KEY (activation_code_id) REFERENCES activation_codes(id) ON DELETE SET NULL,
  CONSTRAINT app_licenses_pkey PRIMARY KEY (id),
  CONSTRAINT app_licenses_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT app_licenses_user_id_key UNIQUE (user_id)
);
ALTER TABLE public.app_licenses ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_app_licenses_device_id ON public.app_licenses USING btree (device_id);
CREATE INDEX idx_app_licenses_expires_at ON public.app_licenses USING btree (expires_at);
CREATE INDEX idx_app_licenses_user_id ON public.app_licenses USING btree (user_id);
CREATE UNIQUE INDEX app_licenses_pkey ON public.app_licenses USING btree (id);
CREATE UNIQUE INDEX app_licenses_user_id_key ON public.app_licenses USING btree (user_id);

-- ===== public.app_settings (RLS enabled: True, forced: False) =====
CREATE TABLE public.app_settings (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  key text NOT NULL,
  value text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT app_settings_key_key UNIQUE (key),
  CONSTRAINT app_settings_pkey PRIMARY KEY (id)
);
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX app_settings_key_key ON public.app_settings USING btree (key);
CREATE UNIQUE INDEX app_settings_pkey ON public.app_settings USING btree (id);

-- ===== public.auth_recovery_codes (RLS enabled: True, forced: False) =====
CREATE TABLE public.auth_recovery_codes (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  code_hash text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  expires_at timestamp with time zone NOT NULL DEFAULT (now() + '00:10:00'::interval),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT auth_recovery_codes_pkey PRIMARY KEY (id),
  CONSTRAINT auth_recovery_codes_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);
ALTER TABLE public.auth_recovery_codes ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_recovery_codes_user_id ON public.auth_recovery_codes USING btree (user_id);
CREATE UNIQUE INDEX auth_recovery_codes_pkey ON public.auth_recovery_codes USING btree (id);

-- ===== public.book_loans (RLS enabled: True, forced: False) =====
CREATE TABLE public.book_loans (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  product_id uuid NOT NULL,
  member_id uuid NOT NULL,
  loan_date date DEFAULT CURRENT_DATE,
  due_date date NOT NULL,
  return_date date,
  status text DEFAULT 'active'::text,
  late_fee numeric DEFAULT 0,
  notes text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT book_loans_member_id_fkey FOREIGN KEY (member_id) REFERENCES library_members(id) ON DELETE CASCADE,
  CONSTRAINT book_loans_pkey PRIMARY KEY (id),
  CONSTRAINT book_loans_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);
ALTER TABLE public.book_loans ENABLE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX book_loans_pkey ON public.book_loans USING btree (id);

-- ===== public.broadcast_reads (RLS enabled: True, forced: False) =====
CREATE TABLE public.broadcast_reads (
  user_id uuid NOT NULL,
  broadcast_id uuid NOT NULL,
  read_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT broadcast_reads_pkey PRIMARY KEY (user_id, broadcast_id)
);
ALTER TABLE public.broadcast_reads ENABLE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX broadcast_reads_pkey ON public.broadcast_reads USING btree (user_id, broadcast_id);

-- ===== public.cash_shifts (RLS enabled: True, forced: False) =====
CREATE TABLE public.cash_shifts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  cashier_id uuid,
  cashier_name text,
  opened_at timestamp with time zone NOT NULL DEFAULT now(),
  closed_at timestamp with time zone,
  opening_balance numeric NOT NULL DEFAULT 0,
  expected_balance numeric NOT NULL DEFAULT 0,
  actual_balance numeric,
  variance numeric DEFAULT 0,
  variance_reason text,
  reconciliation_status text NOT NULL DEFAULT 'open'::text,
  notes text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT cash_shifts_pkey PRIMARY KEY (id),
  CONSTRAINT cash_shifts_reconciliation_status_check CHECK ((reconciliation_status = ANY (ARRAY['open'::text, 'matched'::text, 'unmatched'::text, 'pending'::text])))
);
ALTER TABLE public.cash_shifts ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_cash_shifts_user ON public.cash_shifts USING btree (user_id);
CREATE UNIQUE INDEX cash_shifts_pkey ON public.cash_shifts USING btree (id);

-- ===== public.categories (RLS enabled: True, forced: False) =====
CREATE TABLE public.categories (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT categories_pkey PRIMARY KEY (id)
);
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_categories_user_id ON public.categories USING btree (user_id);
CREATE UNIQUE INDEX categories_pkey ON public.categories USING btree (id);

-- ===== public.client_versions (RLS enabled: True, forced: False) =====
CREATE TABLE public.client_versions (
  user_id uuid NOT NULL,
  version_name text NOT NULL,
  version_code integer NOT NULL DEFAULT 0,
  platform text,
  last_seen_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT client_versions_pkey PRIMARY KEY (user_id)
);
ALTER TABLE public.client_versions ENABLE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX client_versions_pkey ON public.client_versions USING btree (user_id);

-- ===== public.customers (RLS enabled: True, forced: False) =====
CREATE TABLE public.customers (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NOT NULL,
  phone text,
  email text,
  address text,
  total_purchases numeric DEFAULT 0,
  total_debt numeric DEFAULT 0,
  invoice_count integer DEFAULT 0,
  last_purchase timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  cashier_id uuid,
  CONSTRAINT customers_cashier_id_fkey FOREIGN KEY (cashier_id) REFERENCES auth.users(id),
  CONSTRAINT customers_pkey PRIMARY KEY (id)
);
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_customers_cashier_id ON public.customers USING btree (cashier_id);
CREATE INDEX idx_customers_user_id ON public.customers USING btree (user_id);
CREATE UNIQUE INDEX customers_pkey ON public.customers USING btree (id);

-- ===== public.debt_payments (RLS enabled: True, forced: False) =====
CREATE TABLE public.debt_payments (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  debt_id uuid NOT NULL,
  operation_id text NOT NULL,
  amount numeric NOT NULL,
  paid_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  shift_id uuid,
  CONSTRAINT debt_payments_pkey PRIMARY KEY (id),
  CONSTRAINT debt_payments_user_id_operation_id_key UNIQUE (user_id, operation_id)
);
ALTER TABLE public.debt_payments ENABLE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX debt_payments_pkey ON public.debt_payments USING btree (id);
CREATE UNIQUE INDEX debt_payments_user_id_operation_id_key ON public.debt_payments USING btree (user_id, operation_id);

-- ===== public.debt_writeoffs (RLS enabled: True, forced: False) =====
CREATE TABLE public.debt_writeoffs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  debt_id uuid NOT NULL,
  customer_name text,
  amount numeric NOT NULL DEFAULT 0,
  reason text,
  capital_impact numeric DEFAULT 0,
  partner_impact jsonb DEFAULT '[]'::jsonb,
  written_off_at timestamp with time zone NOT NULL DEFAULT now(),
  written_off_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  notes text,
  loss_amount numeric,
  pending_profit_cancelled numeric,
  CONSTRAINT debt_writeoffs_pkey PRIMARY KEY (id)
);
ALTER TABLE public.debt_writeoffs ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_debt_writeoffs_user ON public.debt_writeoffs USING btree (user_id);
CREATE UNIQUE INDEX debt_writeoffs_pkey ON public.debt_writeoffs USING btree (id);

-- ===== public.debts (RLS enabled: True, forced: False) =====
CREATE TABLE public.debts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  invoice_id text,
  customer_name text NOT NULL,
  customer_phone text,
  total_debt numeric DEFAULT 0,
  total_paid numeric DEFAULT 0,
  remaining_debt numeric DEFAULT 0,
  due_date date,
  status text DEFAULT 'due'::text,
  notes text,
  is_cash_debt boolean DEFAULT false,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  cashier_id uuid,
  CONSTRAINT debts_pkey PRIMARY KEY (id)
);
ALTER TABLE public.debts ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_debts_cashier_id ON public.debts USING btree (cashier_id);
CREATE INDEX idx_debts_user_id ON public.debts USING btree (user_id);
CREATE INDEX idx_debts_user_status ON public.debts USING btree (user_id, status);
CREATE UNIQUE INDEX debts_pkey ON public.debts USING btree (id);

-- ===== public.error_logs (RLS enabled: True, forced: False) =====
CREATE TABLE public.error_logs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  occurred_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  user_id uuid,
  user_email text,
  error_type text DEFAULT 'React ErrorBoundary'::text,
  error_message text NOT NULL,
  error_stack text,
  component_stack text,
  platform text,
  page_url text,
  device_language text,
  timezone text,
  screen_resolution text,
  was_online boolean DEFAULT true,
  was_queued_offline boolean DEFAULT false,
  user_agent text,
  extra_context jsonb DEFAULT '{}'::jsonb,
  is_resolved boolean DEFAULT false,
  CONSTRAINT error_logs_pkey PRIMARY KEY (id),
  CONSTRAINT error_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL
);
ALTER TABLE public.error_logs ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_error_logs_is_resolved ON public.error_logs USING btree (is_resolved);
CREATE INDEX idx_error_logs_occurred_at ON public.error_logs USING btree (occurred_at DESC);
CREATE INDEX idx_error_logs_platform ON public.error_logs USING btree (platform);
CREATE UNIQUE INDEX error_logs_pkey ON public.error_logs USING btree (id);

-- ===== public.expenses (RLS enabled: True, forced: False) =====
CREATE TABLE public.expenses (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  expense_type text NOT NULL,
  amount numeric DEFAULT 0,
  description text,
  date date DEFAULT CURRENT_DATE,
  notes text,
  distributions jsonb DEFAULT '[]'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  cashier_id uuid,
  status text DEFAULT 'completed'::text,
  is_reversed boolean DEFAULT false,
  reversed_at timestamp with time zone,
  reversed_by uuid,
  reversal_reason text,
  reversed_reason text,
  CONSTRAINT expenses_pkey PRIMARY KEY (id)
);
ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_expenses_cashier_id ON public.expenses USING btree (cashier_id);
CREATE INDEX idx_expenses_is_reversed ON public.expenses USING btree (is_reversed);
CREATE INDEX idx_expenses_user_id ON public.expenses USING btree (user_id);
CREATE UNIQUE INDEX expenses_pkey ON public.expenses USING btree (id);

-- ===== public.invoice_items (RLS enabled: True, forced: False) =====
CREATE TABLE public.invoice_items (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  invoice_id uuid,
  product_id uuid,
  product_name text NOT NULL,
  variant_id text,
  variant_name text,
  quantity numeric DEFAULT 1,
  unit_price numeric DEFAULT 0,
  cost_price numeric DEFAULT 0,
  currency text DEFAULT 'USD'::text,
  exchange_rate numeric DEFAULT 1,
  amount_original numeric DEFAULT 0,
  amount_usd numeric DEFAULT 0,
  profit numeric DEFAULT 0,
  unit text,
  conversion_factor numeric NOT NULL DEFAULT 1,
  stock_warehouse_id uuid,
  warranty_until date,
  CONSTRAINT invoice_items_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
  CONSTRAINT invoice_items_pkey PRIMARY KEY (id),
  CONSTRAINT invoice_items_stock_warehouse_id_fkey FOREIGN KEY (stock_warehouse_id) REFERENCES warehouses(id) ON DELETE SET NULL
);
ALTER TABLE public.invoice_items ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_invoice_items_invoice_id ON public.invoice_items USING btree (invoice_id);
CREATE INDEX invoice_items_stock_warehouse_idx ON public.invoice_items USING btree (invoice_id, product_id, stock_warehouse_id);
CREATE UNIQUE INDEX invoice_items_pkey ON public.invoice_items USING btree (id);

-- ===== public.invoice_sequences (RLS enabled: True, forced: False) =====
CREATE TABLE public.invoice_sequences (
  user_id uuid NOT NULL,
  last_number bigint NOT NULL DEFAULT 0,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT invoice_sequences_pkey PRIMARY KEY (user_id)
);
ALTER TABLE public.invoice_sequences ENABLE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX invoice_sequences_pkey ON public.invoice_sequences USING btree (user_id);

-- ===== public.invoices (RLS enabled: True, forced: False) =====
CREATE TABLE public.invoices (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  invoice_number text NOT NULL,
  invoice_type text DEFAULT 'sale'::text,
  date date NOT NULL DEFAULT CURRENT_DATE,
  time time without time zone NOT NULL DEFAULT CURRENT_TIME,
  cashier_id text,
  cashier_name text,
  customer_id uuid,
  customer_name text,
  customer_phone text,
  subtotal numeric DEFAULT 0,
  discount numeric DEFAULT 0,
  discount_percentage numeric DEFAULT 0,
  tax_rate numeric DEFAULT 0,
  tax_amount numeric DEFAULT 0,
  total numeric DEFAULT 0,
  profit numeric DEFAULT 0,
  currency text DEFAULT 'USD'::text,
  exchange_rate numeric DEFAULT 1,
  payment_type text DEFAULT 'cash'::text,
  status text DEFAULT 'completed'::text,
  debt_paid numeric DEFAULT 0,
  debt_remaining numeric DEFAULT 0,
  notes text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  warehouse_id uuid,
  invoice_sequence bigint,
  operation_id text,
  total_in_currency numeric DEFAULT 0,
  currency_code text DEFAULT 'USD'::text,
  currency_symbol text DEFAULT '$'::text,
  tax_inclusive boolean NOT NULL DEFAULT false,
  settlement_kind text NOT NULL DEFAULT 'exact'::text,
  settlement_diff_usd numeric NOT NULL DEFAULT 0,
  tax_mode text DEFAULT 'exclusive'::text,
  paid_at_sale numeric,
  CONSTRAINT invoices_pkey PRIMARY KEY (id),
  CONSTRAINT invoices_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES warehouses(id)
);
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_invoices_customer_id ON public.invoices USING btree (customer_id);
CREATE INDEX idx_invoices_date ON public.invoices USING btree (date);
CREATE INDEX idx_invoices_user_created ON public.invoices USING btree (user_id, created_at DESC);
CREATE INDEX idx_invoices_user_id ON public.invoices USING btree (user_id);
CREATE UNIQUE INDEX invoices_pkey ON public.invoices USING btree (id);
CREATE UNIQUE INDEX invoices_user_operation_id_unique ON public.invoices USING btree (user_id, operation_id) WHERE (operation_id IS NOT NULL);

-- ===== public.library_members (RLS enabled: True, forced: False) =====
CREATE TABLE public.library_members (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NOT NULL,
  phone text,
  email text,
  registration_date date DEFAULT CURRENT_DATE,
  membership_status text DEFAULT 'active'::text,
  late_fees numeric DEFAULT 0,
  notes text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT library_members_pkey PRIMARY KEY (id)
);
ALTER TABLE public.library_members ENABLE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX library_members_pkey ON public.library_members USING btree (id);

-- ===== public.maintenance_services (RLS enabled: True, forced: False) =====
CREATE TABLE public.maintenance_services (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  customer_name text NOT NULL,
  customer_phone text,
  description text,
  service_price numeric DEFAULT 0,
  parts_cost numeric DEFAULT 0,
  profit numeric DEFAULT 0,
  payment_type text DEFAULT 'cash'::text,
  status text DEFAULT 'pending'::text,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT maintenance_services_pkey PRIMARY KEY (id)
);
ALTER TABLE public.maintenance_services ENABLE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX maintenance_services_pkey ON public.maintenance_services USING btree (id);

-- ===== public.partners (RLS enabled: True, forced: False) =====
CREATE TABLE public.partners (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NOT NULL,
  phone text,
  email text,
  initial_capital numeric DEFAULT 0,
  current_capital numeric DEFAULT 0,
  share_percentage numeric DEFAULT 0,
  expense_share_percentage numeric DEFAULT 0,
  access_all boolean DEFAULT true,
  category_shares jsonb DEFAULT '[]'::jsonb,
  total_profit_earned numeric DEFAULT 0,
  total_withdrawn numeric DEFAULT 0,
  current_balance numeric DEFAULT 0,
  pending_profit numeric DEFAULT 0,
  confirmed_profit numeric DEFAULT 0,
  pending_profit_details jsonb DEFAULT '[]'::jsonb,
  profit_history jsonb DEFAULT '[]'::jsonb,
  expense_history jsonb DEFAULT '[]'::jsonb,
  capital_history jsonb DEFAULT '[]'::jsonb,
  withdrawal_history jsonb DEFAULT '[]'::jsonb,
  joined_date date DEFAULT CURRENT_DATE,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT partners_pkey PRIMARY KEY (id),
  CONSTRAINT unique_partner_name_per_user UNIQUE (user_id, name)
);
ALTER TABLE public.partners ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_partners_user_id ON public.partners USING btree (user_id);
CREATE UNIQUE INDEX partners_pkey ON public.partners USING btree (id);
CREATE UNIQUE INDEX unique_partner_name_per_user ON public.partners USING btree (user_id, name);

-- ===== public.payment_methods (RLS enabled: True, forced: False) =====
CREATE TABLE public.payment_methods (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  holder_name text,
  account_number text,
  qr_image_path text,
  logo_path text,
  link_url text,
  link_label text,
  instructions text,
  enabled boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  button_label text DEFAULT 'فتح الرابط المباشر'::text,
  badge text,
  qr_image_url text,
  CONSTRAINT payment_methods_pkey PRIMARY KEY (id)
);
ALTER TABLE public.payment_methods ENABLE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX payment_methods_pkey ON public.payment_methods USING btree (id);

-- ===== public.phone_transfer_requests (RLS enabled: True, forced: False) =====
CREATE TABLE public.phone_transfer_requests (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  target_user_id uuid NOT NULL,
  source_user_id uuid NOT NULL,
  phone text NOT NULL,
  code_hash text NOT NULL,
  attempts integer DEFAULT 0,
  expires_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT phone_transfer_requests_pkey PRIMARY KEY (id),
  CONSTRAINT phone_transfer_requests_source_user_id_fkey FOREIGN KEY (source_user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT phone_transfer_requests_target_user_id_fkey FOREIGN KEY (target_user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);
ALTER TABLE public.phone_transfer_requests ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_phone_transfer_target ON public.phone_transfer_requests USING btree (target_user_id, phone);
CREATE UNIQUE INDEX phone_transfer_requests_pkey ON public.phone_transfer_requests USING btree (id);

-- ===== public.products (RLS enabled: True, forced: False) =====
CREATE TABLE public.products (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NOT NULL,
  barcode text,
  category text,
  description text,
  image_url text,
  cost_price numeric DEFAULT 0,
  sale_price numeric DEFAULT 0,
  quantity numeric DEFAULT 0,
  min_stock_level integer DEFAULT 5,
  unit text DEFAULT 'piece'::text,
  expiry_date date,
  supplier text,
  location text,
  notes text,
  custom_fields jsonb DEFAULT '{}'::jsonb,
  archived boolean DEFAULT false,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  bulk_unit text DEFAULT 'كرتونة'::text,
  small_unit text DEFAULT 'قطعة'::text,
  conversion_factor integer DEFAULT 1,
  bulk_cost_price numeric DEFAULT 0,
  bulk_sale_price numeric DEFAULT 0,
  track_by_unit text DEFAULT 'piece'::text,
  purchase_history jsonb DEFAULT '[]'::jsonb,
  barcode2 text,
  barcode3 text,
  variant_label text,
  labor_cost numeric DEFAULT 0,
  serial_number text,
  warranty_months integer,
  wholesale_price numeric,
  batch_number text,
  weight text,
  size text,
  color text,
  fabric_type text,
  author text,
  publisher text,
  table_number text,
  order_notes text,
  CONSTRAINT products_pkey PRIMARY KEY (id)
);
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_products_barcode ON public.products USING btree (barcode);
CREATE INDEX idx_products_user_id ON public.products USING btree (user_id);
CREATE UNIQUE INDEX products_owner_serial_unique ON public.products USING btree (user_id, serial_number) WHERE ((serial_number IS NOT NULL) AND (COALESCE(archived, false) = false));
CREATE UNIQUE INDEX products_pkey ON public.products USING btree (id);

-- ===== public.profiles (RLS enabled: True, forced: False) =====
CREATE TABLE public.profiles (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  full_name text,
  avatar_url text,
  preferred_language text DEFAULT 'ar'::text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  user_type text DEFAULT 'cashier'::text,
  phone text,
  allowed_pages jsonb,
  telegram_chat_id bigint,
  telegram_username text,
  telegram_linked_at timestamp with time zone,
  pin_hash text,
  CONSTRAINT profiles_pkey PRIMARY KEY (id),
  CONSTRAINT profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT profiles_user_id_key UNIQUE (user_id),
  CONSTRAINT profiles_user_type_check CHECK ((user_type = ANY (ARRAY['cashier'::text, 'distributor'::text, 'pos'::text])))
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_profiles_phone ON public.profiles USING btree (phone);
CREATE INDEX idx_profiles_telegram_chat_id ON public.profiles USING btree (telegram_chat_id);
CREATE UNIQUE INDEX idx_profiles_phone_unique ON public.profiles USING btree (phone) WHERE ((phone IS NOT NULL) AND (phone <> ''::text));
CREATE UNIQUE INDEX profiles_pkey ON public.profiles USING btree (id);
CREATE UNIQUE INDEX profiles_user_id_key ON public.profiles USING btree (user_id);

-- ===== public.profit_records (RLS enabled: True, forced: False) =====
CREATE TABLE public.profit_records (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  invoice_id text NOT NULL,
  gross_profit numeric NOT NULL DEFAULT 0,
  cogs numeric NOT NULL DEFAULT 0,
  revenue numeric NOT NULL DEFAULT 0,
  currency text DEFAULT 'USD'::text,
  recorded_at timestamp with time zone NOT NULL DEFAULT now(),
  is_reversed boolean NOT NULL DEFAULT false,
  reversed_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT profit_records_pkey PRIMARY KEY (id)
);
ALTER TABLE public.profit_records ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_profit_records_invoice ON public.profit_records USING btree (invoice_id);
CREATE INDEX idx_profit_records_user ON public.profit_records USING btree (user_id);
CREATE UNIQUE INDEX profit_records_pkey ON public.profit_records USING btree (id);

-- ===== public.purchase_invoice_items (RLS enabled: True, forced: False) =====
CREATE TABLE public.purchase_invoice_items (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL,
  product_id uuid,
  product_name text NOT NULL,
  barcode text,
  category text,
  quantity integer NOT NULL DEFAULT 1,
  cost_price numeric NOT NULL DEFAULT 0,
  sale_price numeric DEFAULT 0,
  total_cost numeric NOT NULL DEFAULT 0,
  created_at timestamp with time zone DEFAULT now(),
  cost_price_before numeric,
  CONSTRAINT purchase_invoice_items_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES purchase_invoices(id) ON DELETE CASCADE,
  CONSTRAINT purchase_invoice_items_pkey PRIMARY KEY (id),
  CONSTRAINT purchase_invoice_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
);
ALTER TABLE public.purchase_invoice_items ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_purchase_invoice_items_invoice_id ON public.purchase_invoice_items USING btree (invoice_id);
CREATE UNIQUE INDEX purchase_invoice_items_pkey ON public.purchase_invoice_items USING btree (id);

-- ===== public.purchase_invoices (RLS enabled: True, forced: False) =====
CREATE TABLE public.purchase_invoices (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  invoice_number text NOT NULL,
  supplier_name text NOT NULL,
  supplier_company text,
  invoice_date date NOT NULL DEFAULT CURRENT_DATE,
  expected_items_count integer NOT NULL DEFAULT 0,
  expected_total_quantity integer NOT NULL DEFAULT 0,
  expected_grand_total numeric NOT NULL DEFAULT 0,
  actual_items_count integer DEFAULT 0,
  actual_total_quantity integer DEFAULT 0,
  actual_grand_total numeric DEFAULT 0,
  status text DEFAULT 'draft'::text,
  notes text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  image_url text,
  payment_status text DEFAULT 'unpaid'::text,
  payment_method text DEFAULT 'cash'::text,
  CONSTRAINT purchase_invoices_pkey PRIMARY KEY (id)
);
ALTER TABLE public.purchase_invoices ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_purchase_invoices_status ON public.purchase_invoices USING btree (status);
CREATE INDEX idx_purchase_invoices_user_id ON public.purchase_invoices USING btree (user_id);
CREATE UNIQUE INDEX purchase_invoices_pkey ON public.purchase_invoices USING btree (id);

-- ===== public.recurring_expenses (RLS enabled: True, forced: False) =====
CREATE TABLE public.recurring_expenses (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  expense_type text NOT NULL,
  amount numeric DEFAULT 0,
  description text,
  interval text DEFAULT 'monthly'::text,
  next_due_date date,
  is_active boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  auto_pay boolean DEFAULT false,
  last_paid_date date,
  payment_method text DEFAULT 'cash'::text,
  auto_pay_account text DEFAULT 'cash'::text,
  name text,
  custom_type text,
  interval_days integer DEFAULT 30,
  notes text,
  CONSTRAINT recurring_expenses_pkey PRIMARY KEY (id)
);
ALTER TABLE public.recurring_expenses ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_recurring_expenses_user_id ON public.recurring_expenses USING btree (user_id);
CREATE UNIQUE INDEX recurring_expenses_pkey ON public.recurring_expenses USING btree (id);

-- ===== public.security_tamper_logs (RLS enabled: True, forced: False) =====
CREATE TABLE public.security_tamper_logs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid,
  device_id text NOT NULL,
  tamper_type text NOT NULL,
  client_timestamp timestamp with time zone,
  server_timestamp timestamp with time zone DEFAULT now(),
  metadata jsonb DEFAULT '{}'::jsonb,
  resolved boolean DEFAULT false,
  CONSTRAINT security_tamper_logs_pkey PRIMARY KEY (id),
  CONSTRAINT security_tamper_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);
ALTER TABLE public.security_tamper_logs ENABLE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX security_tamper_logs_pkey ON public.security_tamper_logs USING btree (id);

-- ===== public.shift_transactions (RLS enabled: True, forced: False) =====
CREATE TABLE public.shift_transactions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  shift_id uuid NOT NULL,
  user_id uuid NOT NULL,
  type text NOT NULL,
  amount numeric NOT NULL DEFAULT 0,
  reference_id text,
  notes text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  currency text DEFAULT 'USD'::text,
  currency_amount numeric,
  exchange_rate numeric DEFAULT 1,
  CONSTRAINT shift_transactions_pkey PRIMARY KEY (id),
  CONSTRAINT shift_transactions_type_check CHECK ((type = ANY (ARRAY['sale'::text, 'deposit_capital'::text, 'deposit_revenue'::text, 'deposit_purchase_cover'::text, 'debt_payment'::text, 'expense'::text, 'refund'::text, 'writeoff'::text, 'withdrawal'::text, 'surplus'::text, 'shortage'::text])))
);
ALTER TABLE public.shift_transactions ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_shift_tx_shift ON public.shift_transactions USING btree (shift_id);
CREATE INDEX idx_shift_tx_user ON public.shift_transactions USING btree (user_id);
CREATE UNIQUE INDEX shift_transactions_pkey ON public.shift_transactions USING btree (id);
CREATE UNIQUE INDEX shift_tx_ref_uniq ON public.shift_transactions USING btree (shift_id, type, reference_id);

-- ===== public.stock_count_items (RLS enabled: True, forced: False) =====
CREATE TABLE public.stock_count_items (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  count_id uuid NOT NULL,
  product_id uuid NOT NULL,
  product_name text,
  expected_qty integer NOT NULL DEFAULT 0,
  actual_qty integer NOT NULL DEFAULT 0,
  variance integer NOT NULL DEFAULT 0,
  unit_cost numeric DEFAULT 0,
  variance_value numeric DEFAULT 0,
  notes text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT stock_count_items_count_id_fkey FOREIGN KEY (count_id) REFERENCES stock_counts(id) ON DELETE CASCADE,
  CONSTRAINT stock_count_items_pkey PRIMARY KEY (id)
);
ALTER TABLE public.stock_count_items ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_stock_count_items_count ON public.stock_count_items USING btree (count_id);
CREATE INDEX idx_stock_count_items_product ON public.stock_count_items USING btree (product_id);
CREATE UNIQUE INDEX stock_count_items_pkey ON public.stock_count_items USING btree (id);

-- ===== public.stock_counts (RLS enabled: True, forced: False) =====
CREATE TABLE public.stock_counts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  warehouse_id uuid,
  count_date date NOT NULL DEFAULT CURRENT_DATE,
  status text NOT NULL DEFAULT 'draft'::text,
  notes text,
  counted_by uuid,
  counted_by_name text,
  total_variance_value numeric DEFAULT 0,
  items_count integer DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  completed_at timestamp with time zone,
  CONSTRAINT stock_counts_pkey PRIMARY KEY (id)
);
ALTER TABLE public.stock_counts ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_stock_counts_user_date ON public.stock_counts USING btree (user_id, created_at DESC);
CREATE UNIQUE INDEX stock_counts_pkey ON public.stock_counts USING btree (id);

-- ===== public.stock_damages (RLS enabled: True, forced: False) =====
CREATE TABLE public.stock_damages (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  product_id uuid NOT NULL,
  product_name text,
  warehouse_id uuid,
  quantity integer NOT NULL DEFAULT 0,
  unit_cost numeric DEFAULT 0,
  cost_value numeric DEFAULT 0,
  reason text,
  notes text,
  damaged_at timestamp with time zone NOT NULL DEFAULT now(),
  recorded_by uuid,
  recorded_by_name text,
  source text DEFAULT 'manual'::text,
  source_ref uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT stock_damages_pkey PRIMARY KEY (id)
);
ALTER TABLE public.stock_damages ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_stock_damages_product ON public.stock_damages USING btree (product_id);
CREATE INDEX idx_stock_damages_user_date ON public.stock_damages USING btree (user_id, damaged_at DESC);
CREATE UNIQUE INDEX stock_damages_pkey ON public.stock_damages USING btree (id);

-- ===== public.stock_movements (RLS enabled: True, forced: False) =====
CREATE TABLE public.stock_movements (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  invoice_id uuid,
  invoice_number text,
  product_id uuid NOT NULL,
  product_name text,
  warehouse_id uuid,
  warehouse_name text,
  movement_type text NOT NULL,
  quantity_delta numeric NOT NULL,
  quantity_before numeric NOT NULL,
  quantity_after numeric NOT NULL,
  unit_cost numeric NOT NULL DEFAULT 0,
  created_by uuid,
  source text NOT NULL DEFAULT 'database'::text,
  idempotency_key text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT stock_movements_idempotency_key_key UNIQUE (idempotency_key),
  CONSTRAINT stock_movements_pkey PRIMARY KEY (id)
);
ALTER TABLE public.stock_movements ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_stock_movements_invoice ON public.stock_movements USING btree (user_id, invoice_id, movement_type);
CREATE INDEX idx_stock_movements_owner_date ON public.stock_movements USING btree (user_id, created_at DESC);
CREATE INDEX idx_stock_movements_product_id ON public.stock_movements USING btree (product_id);
CREATE INDEX idx_stock_movements_product_location ON public.stock_movements USING btree (user_id, product_id, warehouse_id, created_at DESC);
CREATE UNIQUE INDEX stock_movements_idempotency_key_key ON public.stock_movements USING btree (idempotency_key);
CREATE UNIQUE INDEX stock_movements_pkey ON public.stock_movements USING btree (id);

-- ===== public.stock_transfer_items (RLS enabled: True, forced: False) =====
CREATE TABLE public.stock_transfer_items (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  transfer_id uuid NOT NULL,
  product_id uuid NOT NULL,
  quantity integer NOT NULL,
  unit text DEFAULT 'piece'::text,
  quantity_in_pieces integer NOT NULL,
  CONSTRAINT stock_transfer_items_pkey PRIMARY KEY (id),
  CONSTRAINT stock_transfer_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id),
  CONSTRAINT stock_transfer_items_transfer_id_fkey FOREIGN KEY (transfer_id) REFERENCES stock_transfers(id) ON DELETE CASCADE
);
ALTER TABLE public.stock_transfer_items ENABLE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX stock_transfer_items_pkey ON public.stock_transfer_items USING btree (id);

-- ===== public.stock_transfers (RLS enabled: True, forced: False) =====
CREATE TABLE public.stock_transfers (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  from_warehouse_id uuid NOT NULL,
  to_warehouse_id uuid NOT NULL,
  transfer_number text NOT NULL,
  status text DEFAULT 'pending'::text,
  notes text,
  transferred_by uuid,
  transferred_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  transfer_type text NOT NULL DEFAULT 'outgoing'::text,
  parent_transfer_id uuid,
  CONSTRAINT stock_transfers_from_warehouse_id_fkey FOREIGN KEY (from_warehouse_id) REFERENCES warehouses(id),
  CONSTRAINT stock_transfers_parent_transfer_id_fkey FOREIGN KEY (parent_transfer_id) REFERENCES stock_transfers(id) ON DELETE SET NULL,
  CONSTRAINT stock_transfers_pkey PRIMARY KEY (id),
  CONSTRAINT stock_transfers_to_warehouse_id_fkey FOREIGN KEY (to_warehouse_id) REFERENCES warehouses(id)
);
ALTER TABLE public.stock_transfers ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_stock_transfers_parent ON public.stock_transfers USING btree (parent_transfer_id) WHERE (parent_transfer_id IS NOT NULL);
CREATE UNIQUE INDEX stock_transfers_pkey ON public.stock_transfers USING btree (id);

-- ===== public.store_settings (RLS enabled: True, forced: False) =====
CREATE TABLE public.store_settings (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid,
  name text NOT NULL DEFAULT ''::text,
  store_type text DEFAULT 'phones'::text,
  phone text,
  email text,
  address text,
  logo_url text,
  primary_currency text DEFAULT 'USD'::text,
  exchange_rates jsonb DEFAULT '{"SYP": 0, "TRY": 0}'::jsonb,
  tax_enabled boolean DEFAULT false,
  tax_rate numeric DEFAULT 0,
  sync_settings jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT store_settings_pkey PRIMARY KEY (id),
  CONSTRAINT store_settings_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT unique_store_user UNIQUE (user_id)
);
ALTER TABLE public.store_settings ENABLE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX store_settings_pkey ON public.store_settings USING btree (id);
CREATE UNIQUE INDEX unique_store_user ON public.store_settings USING btree (user_id);

-- ===== public.stores (RLS enabled: True, forced: False) =====
CREATE TABLE public.stores (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NOT NULL DEFAULT ''::text,
  phone text,
  address text,
  logo_url text,
  store_type text DEFAULT 'general'::text,
  theme text DEFAULT 'light'::text,
  language text DEFAULT 'ar'::text,
  currency_symbol text DEFAULT '$'::text,
  exchange_rates jsonb DEFAULT '{"SYP": 0, "TRY": 0, "USD": 1}'::jsonb,
  tax_enabled boolean DEFAULT false,
  tax_rate numeric DEFAULT 0,
  print_settings jsonb DEFAULT '{}'::jsonb,
  notification_settings jsonb DEFAULT '{}'::jsonb,
  sync_settings jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  theme_settings jsonb DEFAULT '{}'::jsonb,
  font_family text DEFAULT 'Cairo'::text,
  appearance_settings jsonb DEFAULT '{}'::jsonb,
  email text,
  primary_currency text DEFAULT 'USD'::text,
  tax_type text DEFAULT 'exclusive'::text,
  CONSTRAINT stores_pkey PRIMARY KEY (id)
);
ALTER TABLE public.stores ENABLE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX stores_pkey ON public.stores USING btree (id);

-- ===== public.subscription_plans (RLS enabled: True, forced: False) =====
CREATE TABLE public.subscription_plans (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  audience text NOT NULL DEFAULT 'individual'::text,
  duration_days integer NOT NULL,
  price_usd numeric NOT NULL,
  equivalents jsonb NOT NULL DEFAULT '[]'::jsonb,
  max_products integer NOT NULL DEFAULT 600,
  allow_images_above_limit boolean NOT NULL DEFAULT false,
  description text,
  features ARRAY NOT NULL DEFAULT '{}'::text[],
  badge text,
  enabled boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  max_cashiers integer NOT NULL DEFAULT 1,
  activation_message text,
  CONSTRAINT subscription_plans_duration_days_check CHECK ((duration_days > 0)),
  CONSTRAINT subscription_plans_pkey PRIMARY KEY (id),
  CONSTRAINT subscription_plans_price_usd_check CHECK ((price_usd >= (0)::numeric))
);
ALTER TABLE public.subscription_plans ENABLE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX subscription_plans_pkey ON public.subscription_plans USING btree (id);

-- ===== public.subscription_requests (RLS enabled: True, forced: False) =====
CREATE TABLE public.subscription_requests (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  ref_code text NOT NULL,
  plan_id uuid,
  plan_name text NOT NULL,
  plan_audience text NOT NULL,
  plan_days integer NOT NULL,
  price_usd numeric NOT NULL,
  equivalents_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  method_id uuid,
  method_name text NOT NULL,
  payer_name text,
  payer_ref text,
  proof_path text,
  status text NOT NULL DEFAULT 'pending'::text,
  admin_note text,
  confirmed_by uuid,
  confirmed_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT subscription_requests_method_id_fkey FOREIGN KEY (method_id) REFERENCES payment_methods(id) ON DELETE SET NULL,
  CONSTRAINT subscription_requests_pkey PRIMARY KEY (id),
  CONSTRAINT subscription_requests_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES subscription_plans(id) ON DELETE SET NULL,
  CONSTRAINT subscription_requests_ref_code_key UNIQUE (ref_code),
  CONSTRAINT subscription_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'paid_claimed'::text, 'confirmed'::text, 'rejected'::text, 'cancelled'::text, 'expired'::text])))
);
ALTER TABLE public.subscription_requests ENABLE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX idx_one_open_sub_request_per_user ON public.subscription_requests USING btree (user_id) WHERE (status = ANY (ARRAY['pending'::text, 'paid_claimed'::text]));
CREATE UNIQUE INDEX subscription_requests_pkey ON public.subscription_requests USING btree (id);
CREATE UNIQUE INDEX subscription_requests_ref_code_key ON public.subscription_requests USING btree (ref_code);

-- ===== public.support_conversations (RLS enabled: True, forced: False) =====
CREATE TABLE public.support_conversations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  owner_id uuid,
  user_name text,
  user_email text,
  user_phone text,
  store_name text,
  status text NOT NULL DEFAULT 'open'::text,
  last_message_at timestamp with time zone NOT NULL DEFAULT now(),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT support_conversations_pkey PRIMARY KEY (id),
  CONSTRAINT support_conversations_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);
ALTER TABLE public.support_conversations ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_support_conv_last_msg ON public.support_conversations USING btree (last_message_at DESC);
CREATE INDEX idx_support_conv_user ON public.support_conversations USING btree (user_id);
CREATE UNIQUE INDEX support_conversations_pkey ON public.support_conversations USING btree (id);

-- ===== public.support_messages (RLS enabled: True, forced: False) =====
CREATE TABLE public.support_messages (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL,
  sender_id uuid NOT NULL,
  sender_role text NOT NULL DEFAULT 'user'::text,
  message text NOT NULL,
  is_read boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  attachment_url text,
  notified_native boolean DEFAULT false,
  CONSTRAINT support_messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES support_conversations(id) ON DELETE CASCADE,
  CONSTRAINT support_messages_pkey PRIMARY KEY (id),
  CONSTRAINT support_messages_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES auth.users(id)
);
ALTER TABLE public.support_messages ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_support_msg_conv ON public.support_messages USING btree (conversation_id, created_at);
CREATE UNIQUE INDEX support_messages_pkey ON public.support_messages USING btree (id);

-- ===== public.user_notifications (RLS enabled: True, forced: False) =====
CREATE TABLE public.user_notifications (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  title text NOT NULL,
  message text NOT NULL,
  type text NOT NULL DEFAULT 'system'::text,
  is_read boolean NOT NULL DEFAULT false,
  is_archived boolean NOT NULL DEFAULT false,
  action_url text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT user_notifications_pkey PRIMARY KEY (id)
);
ALTER TABLE public.user_notifications ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_user_notifications_user ON public.user_notifications USING btree (user_id, is_archived, created_at DESC);
CREATE UNIQUE INDEX user_notifications_pkey ON public.user_notifications USING btree (id);

-- ===== public.user_roles (RLS enabled: True, forced: False) =====
CREATE TABLE public.user_roles (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  role USER-DEFINED NOT NULL DEFAULT 'cashier'::app_role,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  owner_id uuid,
  is_active boolean DEFAULT true,
  can_refund boolean NOT NULL DEFAULT false,
  CONSTRAINT user_roles_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT user_roles_pkey PRIMARY KEY (id),
  CONSTRAINT user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT user_roles_user_id_role_key UNIQUE (user_id, role),
  CONSTRAINT user_roles_user_id_unique UNIQUE (user_id)
);
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX user_roles_pkey ON public.user_roles USING btree (id);
CREATE UNIQUE INDEX user_roles_user_id_role_key ON public.user_roles USING btree (user_id, role);
CREATE UNIQUE INDEX user_roles_user_id_unique ON public.user_roles USING btree (user_id);

-- ===== public.warehouse_stock (RLS enabled: True, forced: False) =====
CREATE TABLE public.warehouse_stock (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  warehouse_id uuid NOT NULL,
  product_id uuid NOT NULL,
  quantity numeric DEFAULT 0,
  quantity_bulk integer DEFAULT 0,
  last_updated timestamp with time zone DEFAULT now(),
  CONSTRAINT warehouse_stock_pkey PRIMARY KEY (id),
  CONSTRAINT warehouse_stock_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  CONSTRAINT warehouse_stock_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE CASCADE,
  CONSTRAINT warehouse_stock_warehouse_id_product_id_key UNIQUE (warehouse_id, product_id)
);
ALTER TABLE public.warehouse_stock ENABLE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX warehouse_stock_pkey ON public.warehouse_stock USING btree (id);
CREATE UNIQUE INDEX warehouse_stock_warehouse_id_product_id_key ON public.warehouse_stock USING btree (warehouse_id, product_id);

-- ===== public.warehouses (RLS enabled: True, forced: False) =====
CREATE TABLE public.warehouses (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NOT NULL,
  type text DEFAULT 'main'::text,
  assigned_cashier_id uuid,
  address text,
  phone text,
  is_default boolean DEFAULT false,
  is_active boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT warehouses_pkey PRIMARY KEY (id)
);
ALTER TABLE public.warehouses ENABLE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX idx_unique_default_main_warehouse ON public.warehouses USING btree (user_id) WHERE ((type = 'main'::text) AND (is_default = true));
CREATE UNIQUE INDEX warehouses_pkey ON public.warehouses USING btree (id);

-- view
CREATE OR REPLACE VIEW public.boss_owners_view AS
 SELECT ur.user_id,
    ur.role,
    ur.created_at AS role_created_at,
    ur.is_active,
    p.full_name,
    al.expires_at AS license_expires,
    al.is_revoked AS license_revoked,
    al.max_cashiers,
    al.license_tier,
    al.device_id,
    COALESCE(( SELECT count(*) AS count
           FROM user_roles
          WHERE user_roles.owner_id = ur.user_id AND user_roles.role = 'cashier'::app_role), 0::bigint)::integer AS cashier_count
   FROM user_roles ur
     LEFT JOIN profiles p ON p.user_id = ur.user_id
     LEFT JOIN app_licenses al ON al.user_id = ur.user_id AND al.is_revoked = false
  WHERE ur.role = 'admin'::app_role
  ORDER BY ur.created_at DESC;
