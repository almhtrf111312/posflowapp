-- PosFlow: full SQL of the public schema logic (functions, views, triggers), generated from supabase/migrations.
-- Generated 2026-11-26 by docs/ACCOUNTING_AUDIT_PLAN.md step A2. Verified equal to the live database the same day
-- (npm run -s db:drift-sql -- --summary: functions, columns, triggers and indexes hashes identical).
-- Each function has a "normalized md5" (body without comments and whitespace) to compare with any other copy.
-- READ-ONLY reference: never run this file against a database.

-- =========================== VIEWS (5) ===========================

-- VIEW _invoice_accounting_state
CREATE OR REPLACE VIEW public._invoice_accounting_state AS
 SELECT i.id AS invoice_id,
    i.user_id,
        CASE
            WHEN s.active_invoice THEN COALESCE(i.total, 0::numeric) - COALESCE(i.tax_amount, 0::numeric)
            ELSE 0::numeric
        END AS net_revenue,
        CASE
            WHEN s.active_invoice THEN COALESCE(cost.cogs, 0::numeric)
            ELSE 0::numeric
        END AS cogs,
        CASE
            WHEN NOT s.active_invoice THEN 0::numeric
            WHEN s.is_credit THEN round(COALESCE(i.profit, 0::numeric) * s.collected / i.total, 8)
            ELSE COALESCE(i.profit, 0::numeric)
        END AS realized_profit,
        CASE
            WHEN s.active_invoice AND s.is_credit AND i.status IS DISTINCT FROM 'written_off'::text THEN round(COALESCE(i.profit, 0::numeric) * (i.total - s.collected) / i.total, 8)
            ELSE 0::numeric
        END AS pending_profit
   FROM invoices i
     CROSS JOIN LATERAL ( SELECT (COALESCE(i.status, ''::text) <> ALL (ARRAY['cancelled'::text, 'refunded'::text])) AND (COALESCE(i.invoice_type, 'sale'::text) = ANY (ARRAY['sale'::text, 'maintenance'::text])) AS active_invoice,
            NOT i.payment_type IS DISTINCT FROM 'debt'::text AND COALESCE(i.total, 0::numeric) > 0::numeric AS is_credit,
            LEAST(GREATEST(COALESCE(i.debt_paid, i.paid_at_sale, 0::numeric), 0::numeric), GREATEST(COALESCE(i.total, 0::numeric), 0::numeric)) AS collected) s
     LEFT JOIN LATERAL ( SELECT sum(COALESCE(ii.cost_price, 0::numeric) * COALESCE(ii.quantity, 0::numeric)) AS cogs
           FROM invoice_items ii
          WHERE ii.invoice_id = i.id AND s.active_invoice) cost ON true;

-- VIEW boss_owners_view
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

-- VIEW customer_credit_balances
CREATE OR REPLACE VIEW public.customer_credit_balances AS
 SELECT c.id AS customer_id,
    c.user_id,
    c.name,
    c.credit_limit,
    c.total_debt,
    round(COALESCE(sum(l.amount), 0::numeric), 8) AS store_credit
   FROM customers c
     LEFT JOIN customer_credit_ledger l ON l.customer_id = c.id
  GROUP BY c.id;

-- VIEW partner_ledger_reconciliation
CREATE OR REPLACE VIEW public.partner_ledger_reconciliation AS
 SELECT p.id AS partner_id,
    p.user_id,
    p.name,
    p.current_balance,
    COALESCE(sum(l.d_current_balance), 0::numeric) AS ledger_balance,
    p.pending_profit,
    COALESCE(sum(l.d_pending_profit), 0::numeric) AS ledger_pending,
    p.confirmed_profit,
    COALESCE(sum(l.d_confirmed_profit), 0::numeric) AS ledger_confirmed,
    p.total_withdrawn,
    COALESCE(sum(l.d_total_withdrawn), 0::numeric) AS ledger_withdrawn,
    abs(COALESCE(p.current_balance, 0::numeric) - COALESCE(sum(l.d_current_balance), 0::numeric)) > 0.01 OR abs(COALESCE(p.pending_profit, 0::numeric) - COALESCE(sum(l.d_pending_profit), 0::numeric)) > 0.01 OR abs(COALESCE(p.confirmed_profit, 0::numeric) - COALESCE(sum(l.d_confirmed_profit), 0::numeric)) > 0.01 OR abs(COALESCE(p.total_withdrawn, 0::numeric) - COALESCE(sum(l.d_total_withdrawn), 0::numeric)) > 0.01 AS mismatch
   FROM partners p
     LEFT JOIN partner_ledger_entries l ON l.partner_id = p.id
  GROUP BY p.id;

-- VIEW supplier_balances
CREATE OR REPLACE VIEW public.supplier_balances AS
 SELECT s.id,
    s.user_id,
    s.name,
    s.company,
    s.phone,
    s.is_active,
    round(COALESCE(sum(l.amount), 0::numeric), 8) AS balance_due
   FROM suppliers s
     LEFT JOIN supplier_ledger_entries l ON l.supplier_id = s.id
  GROUP BY s.id;

-- =========================== TRIGGERS (87) ===========================

CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.accounting_period_closures FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();
CREATE TRIGGER trg_activation_code_strength BEFORE INSERT OR UPDATE OF code ON public.activation_codes FOR EACH ROW EXECUTE FUNCTION validate_activation_code_strength();
CREATE TRIGGER trg_push_app_broadcast AFTER INSERT ON public.app_broadcasts FOR EACH ROW EXECUTE FUNCTION push_app_broadcast();
CREATE TRIGGER trg_prevent_license_self_upgrade BEFORE UPDATE ON public.app_licenses FOR EACH ROW EXECUTE FUNCTION prevent_license_self_upgrade();
CREATE TRIGGER trg_track_license_device_binding BEFORE INSERT OR UPDATE OF device_id ON public.app_licenses FOR EACH ROW EXECUTE FUNCTION track_license_device_binding();
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.book_loans FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();
CREATE TRIGGER update_book_loans_updated_at BEFORE UPDATE ON public.book_loans FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.cash_shifts FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();
CREATE TRIGGER trg_cash_shifts_updated_at BEFORE UPDATE ON public.cash_shifts FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trg_snapshot_shift_opening_exchange_rates BEFORE INSERT ON public.cash_shifts FOR EACH ROW EXECUTE FUNCTION snapshot_shift_opening_exchange_rates();
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.categories FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.customers FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();
CREATE TRIGGER set_customers_updated_at BEFORE UPDATE ON public.customers FOR EACH ROW EXECUTE FUNCTION handle_updated_at();
CREATE TRIGGER trg_prevent_customer_deletion BEFORE DELETE ON public.customers FOR EACH ROW EXECUTE FUNCTION prevent_customer_deletion_with_dues();
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.debt_payments FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.debt_writeoffs FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();
CREATE TRIGGER z_block_direct_debt_writeoff_delete BEFORE DELETE ON public.debt_writeoffs FOR EACH ROW EXECUTE FUNCTION prevent_direct_debt_delete();
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.debts FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();
CREATE TRIGGER b_guard_debt_writeoff_status BEFORE INSERT OR UPDATE OF status ON public.debts FOR EACH ROW EXECUTE FUNCTION guard_debt_writeoff_status();
CREATE TRIGGER c_guard_written_off_debt BEFORE UPDATE ON public.debts FOR EACH ROW WHEN ((old.status = 'written_off'::text)) EXECUTE FUNCTION guard_written_off_debt();
CREATE TRIGGER set_debts_updated_at BEFORE UPDATE ON public.debts FOR EACH ROW EXECUTE FUNCTION handle_updated_at();
CREATE TRIGGER trg_normalize_debt_row BEFORE INSERT OR UPDATE ON public.debts FOR EACH ROW EXECUTE FUNCTION normalize_debt_row();
CREATE TRIGGER z_block_direct_debt_delete BEFORE DELETE ON public.debts FOR EACH ROW EXECUTE FUNCTION prevent_direct_debt_delete();
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.expenses FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();
CREATE TRIGGER trg_expenses_assert_period_open BEFORE INSERT OR DELETE OR UPDATE ON public.expenses FOR EACH ROW EXECUTE FUNCTION trg_expenses_assert_period_open();
CREATE TRIGGER trg_guard_expenses_direct_reverse BEFORE UPDATE ON public.expenses FOR EACH ROW EXECUTE FUNCTION guard_expenses_direct_reverse();
CREATE TRIGGER trg_guard_inventory_valuation_posting BEFORE INSERT ON public.inventory_valuation_adjustments FOR EACH ROW EXECUTE FUNCTION _guard_inventory_valuation_posting();
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.invoice_items FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();
CREATE TRIGGER aa_invoice_item_accounting_lock BEFORE INSERT OR DELETE OR UPDATE ON public.invoice_items FOR EACH ROW EXECUTE FUNCTION _hold_invoice_accounting_lock();
CREATE CONSTRAINT TRIGGER recalc_pos_invoice_profit_trigger AFTER INSERT ON public.invoice_items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION trg_recalc_pos_invoice_profit();
CREATE CONSTRAINT TRIGGER zz_invoice_item_accounting_journal AFTER INSERT OR DELETE OR UPDATE ON public.invoice_items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((current_setting('app.purge_context'::text, true) IS DISTINCT FROM 'owner_purge'::text)) EXECUTE FUNCTION _journal_invoice_accounting_change();
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.invoice_sequences FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.invoices FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();
CREATE TRIGGER aa_invoice_accounting_lock BEFORE INSERT OR DELETE OR UPDATE ON public.invoices FOR EACH ROW EXECUTE FUNCTION _hold_invoice_accounting_lock();
CREATE TRIGGER c_set_invoice_paid_at_sale BEFORE INSERT ON public.invoices FOR EACH ROW EXECUTE FUNCTION set_invoice_paid_at_sale();
CREATE TRIGGER d_guard_written_off_invoice BEFORE UPDATE ON public.invoices FOR EACH ROW WHEN ((old.status = 'written_off'::text)) EXECUTE FUNCTION guard_written_off_invoice();
CREATE TRIGGER guard_refunded_invoice_status_trigger BEFORE UPDATE OF status ON public.invoices FOR EACH ROW EXECUTE FUNCTION guard_refunded_invoice_status();
CREATE TRIGGER set_invoices_updated_at BEFORE UPDATE ON public.invoices FOR EACH ROW EXECUTE FUNCTION handle_updated_at();
CREATE TRIGGER trg_release_serials_on_refund AFTER UPDATE OF status ON public.invoices FOR EACH ROW EXECUTE FUNCTION _release_serials_on_invoice_refund();
CREATE TRIGGER z_block_direct_invoice_delete BEFORE DELETE ON public.invoices FOR EACH ROW EXECUTE FUNCTION block_direct_invoice_delete();
CREATE CONSTRAINT TRIGGER zz_invoice_accounting_journal AFTER INSERT OR DELETE OR UPDATE ON public.invoices DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((current_setting('app.purge_context'::text, true) IS DISTINCT FROM 'owner_purge'::text)) EXECUTE FUNCTION _journal_invoice_accounting_change();
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.library_members FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();
CREATE TRIGGER update_library_members_updated_at BEFORE UPDATE ON public.library_members FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.maintenance_services FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();
CREATE TRIGGER trg_partner_ledger_immutable BEFORE DELETE OR UPDATE ON public.partner_ledger_entries FOR EACH ROW EXECUTE FUNCTION _partner_ledger_immutable();
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.partners FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();
CREATE TRIGGER guard_partners_financial_direct_write BEFORE UPDATE ON public.partners FOR EACH ROW EXECUTE FUNCTION guard_partners_financial_direct_write();
CREATE TRIGGER set_partners_updated_at BEFORE UPDATE ON public.partners FOR EACH ROW EXECUTE FUNCTION handle_updated_at();
CREATE TRIGGER trg_partner_ledger_capture AFTER INSERT OR UPDATE ON public.partners FOR EACH ROW EXECUTE FUNCTION _partner_ledger_capture();
CREATE TRIGGER trg_partners_trim_history BEFORE UPDATE ON public.partners FOR EACH ROW EXECUTE FUNCTION _partners_trim_history();
CREATE TRIGGER trg_partners_validate_shares BEFORE INSERT OR UPDATE ON public.partners FOR EACH ROW EXECUTE FUNCTION validate_partner_shares();
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.products FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();
CREATE TRIGGER log_product_price_change_trigger AFTER UPDATE OF cost_price, sale_price ON public.products FOR EACH ROW EXECUTE FUNCTION log_product_price_change();
CREATE TRIGGER record_main_stock_movement_trigger AFTER INSERT OR UPDATE OF quantity ON public.products FOR EACH ROW EXECUTE FUNCTION record_main_stock_movement();
CREATE TRIGGER set_products_updated_at BEFORE UPDATE ON public.products FOR EACH ROW EXECUTE FUNCTION handle_updated_at();
CREATE TRIGGER sync_product_typed_fields_trigger BEFORE INSERT OR UPDATE OF custom_fields ON public.products FOR EACH ROW EXECUTE FUNCTION sync_product_typed_fields();
CREATE TRIGGER trg_normalize_profile_phone BEFORE INSERT OR UPDATE OF phone ON public.profiles FOR EACH ROW EXECUTE FUNCTION trigger_normalize_profile_phone();
CREATE TRIGGER update_profiles_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.profit_records FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.purchase_invoice_items FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.purchase_invoices FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();
CREATE TRIGGER update_purchase_invoices_updated_at BEFORE UPDATE ON public.purchase_invoices FOR EACH ROW EXECUTE FUNCTION update_purchase_invoice_updated_at();
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.recurring_expenses FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();
CREATE TRIGGER set_recurring_expenses_updated_at BEFORE UPDATE ON public.recurring_expenses FOR EACH ROW EXECUTE FUNCTION handle_updated_at();
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.shift_transactions FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.stock_count_items FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.stock_counts FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();
CREATE TRIGGER trg_stock_counts_updated BEFORE UPDATE ON public.stock_counts FOR EACH ROW EXECUTE FUNCTION handle_updated_at();
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.stock_damages FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.stock_movements FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.stock_transfer_items FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.stock_transfers FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();
CREATE TRIGGER update_stock_transfers_timestamp BEFORE UPDATE ON public.stock_transfers FOR EACH ROW EXECUTE FUNCTION update_warehouse_timestamp();
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.store_settings FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();
CREATE TRIGGER set_store_settings_updated_at BEFORE UPDATE ON public.store_settings FOR EACH ROW EXECUTE FUNCTION set_store_settings_updated_at();
CREATE TRIGGER trg_guard_store_settings_fx_during_open_shift BEFORE UPDATE ON public.store_settings FOR EACH ROW EXECUTE FUNCTION guard_fx_change_during_open_shift();
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.stores FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();
CREATE TRIGGER set_stores_updated_at BEFORE UPDATE ON public.stores FOR EACH ROW EXECUTE FUNCTION handle_updated_at();
CREATE TRIGGER trg_guard_stores_fx_during_open_shift BEFORE UPDATE ON public.stores FOR EACH ROW EXECUTE FUNCTION guard_fx_change_during_open_shift();
CREATE TRIGGER trg_sync_stores_to_store_settings AFTER INSERT OR UPDATE ON public.stores FOR EACH ROW EXECUTE FUNCTION sync_stores_to_store_settings();
CREATE TRIGGER trg_notify_boss_subscription_request AFTER INSERT ON public.subscription_requests FOR EACH ROW EXECUTE FUNCTION notify_boss_on_subscription_request();
CREATE TRIGGER trg_notify_support_message AFTER INSERT ON public.support_messages FOR EACH ROW EXECUTE FUNCTION notify_on_support_message();
CREATE TRIGGER trg_push_customer_message AFTER INSERT ON public.support_messages FOR EACH ROW EXECUTE FUNCTION push_customer_message();
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.warehouse_stock FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();
CREATE TRIGGER record_warehouse_stock_movement_trigger AFTER INSERT OR UPDATE OF quantity ON public.warehouse_stock FOR EACH ROW EXECUTE FUNCTION record_warehouse_stock_movement();
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.warehouses FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();
CREATE TRIGGER update_warehouses_timestamp BEFORE UPDATE ON public.warehouses FOR EACH ROW EXECUTE FUNCTION update_warehouse_timestamp();

-- =========================== FUNCTIONS (182) ===========================

-- FUNCTION _allocate_sales_refund | normalized md5 f0917fe072ba8484a17a4ce740f57abb
CREATE OR REPLACE FUNCTION public._allocate_sales_refund(_inv invoices, _kind text, _operation text, _wanted numeric, _shift uuid, _mode text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  _receipts jsonb := '[]'::jsonb;
  _receipt record;
  _take numeric;
  _pending numeric := greatest(round(coalesce(_wanted, 0), 8), 0);
  _available numeric := 0;
  _previous numeric;
  _previous_usd numeric;
  _previous_original numeric;
  _net_usd numeric;
  _net_original numeric;
  _cash numeric := 0;
  _digital numeric := 0;
  _drawer numeric := 0;
  _drawer_recorded boolean := false;
  _allocations jsonb := '[]'::jsonb;
  _sale_settled numeric;
  _sale_shift public.shift_transactions%ROWTYPE;
  _sale_matches integer;
  _sale_method text;
  _sale_currency text;
  _sale_rate numeric;
  _sale_original numeric;
  _payment record;
BEGIN
  IF _pending <= 0 THEN
    RETURN jsonb_build_object('cash', 0, 'digital', 0, 'drawer', 0, 'allocations', _allocations);
  END IF;
  IF _mode NOT IN ('drawer', 'external_cash') THEN RAISE EXCEPTION 'وضع تسوية المرتجع غير صالح'; END IF;

  IF EXISTS (
    SELECT 1 FROM public.activity_log l
     WHERE l.user_id = _inv.user_id AND l.entity_id = _inv.id::text AND l.action_type = 'partial_refund'
       AND COALESCE((l.metadata->>'cash_to_refund')::numeric, 0)
           + COALESCE((l.metadata->>'digital_to_refund')::numeric, 0) > 0
       AND NOT COALESCE((l.metadata->>'receipt_allocation')::boolean, false)
  ) THEN
    RAISE EXCEPTION 'يلزم مطابقة المرتجع السابق مع إيصالات القبض قبل تسجيل رد إضافي';
  END IF;

  _sale_settled := CASE WHEN _inv.payment_type = 'debt' THEN COALESCE(_inv.paid_at_sale, 0)
    ELSE COALESCE(NULLIF(_inv.paid_at_sale, 0), _inv.total + COALESCE((
      SELECT sum(a.settled_amount) FROM public.sales_refund_allocations a
       WHERE a.user_id = _inv.user_id AND a.invoice_id = _inv.id AND a.receipt_key = 'sale'
    ), 0)) END;
  IF _sale_settled > 0 THEN
    -- Cash receipts must be traceable when refunding a debt invoice. Paid-at-sale was historically inferred.
    _sale_method := CASE _inv.payment_method WHEN 'digital' THEN 'transfer' WHEN 'cash' THEN 'cash' END;
    _sale_currency := upper(COALESCE(NULLIF(trim(_inv.currency), ''), 'USD'));
    _sale_rate := CASE WHEN _sale_currency = 'USD' THEN 1 ELSE _inv.exchange_rate END;
    IF _sale_method IS NULL OR COALESCE(_sale_rate, 0) <= 0 THEN
      RAISE EXCEPTION 'وسيلة قبض البيع الأصلي أو عملته غير موثقة';
    END IF;

    SELECT count(*) INTO _sale_matches FROM public.shift_transactions t
     WHERE t.user_id = _inv.user_id AND t.reference_id IN (_inv.operation_id, _inv.invoice_number, _inv.id::text)
       AND t.type IN ('sale', 'digital_sale');
    IF _sale_matches = 1 THEN
      SELECT t.* INTO _sale_shift FROM public.shift_transactions t
       WHERE t.user_id = _inv.user_id AND t.reference_id IN (_inv.operation_id, _inv.invoice_number, _inv.id::text)
         AND t.type IN ('sale', 'digital_sale');
      IF (CASE _sale_shift.type WHEN 'sale' THEN 'cash' ELSE 'transfer' END) <> _sale_method
         OR upper(COALESCE(_sale_shift.currency, 'USD')) <> _sale_currency
         OR abs(_sale_shift.amount - _sale_settled) > 0.005 THEN
        RAISE EXCEPTION 'حركة قبض البيع الأصلي لا تطابق الفاتورة';
      END IF;
      _sale_original := CASE WHEN _sale_currency = 'USD' THEN _sale_shift.amount ELSE _sale_shift.currency_amount END;
      IF COALESCE(_sale_original, 0) <= 0 OR abs(_sale_original / _sale_rate - _sale_shift.amount) > 0.005 THEN
        RAISE EXCEPTION 'مبلغ عملة حركة البيع الأصلية غير موثق';
      END IF;
    ELSIF _sale_matches <> 0 OR _inv.payment_type = 'debt' THEN
      RAISE EXCEPTION 'تعذّر تحديد حركة الدفعة الأولى الأصلية';
    ELSE
      _sale_original := round(_sale_settled * _sale_rate, 4);
    END IF;
    _receipts := _receipts || jsonb_build_object('key', 'sale', 'method', _sale_method,
      'ccy', _sale_currency, 'rate', _sale_rate, 'settled', _sale_settled,
      'usd', CASE WHEN _sale_matches = 1 THEN _sale_shift.amount ELSE round(_sale_settled, 2) END,
      'original', _sale_original);
  END IF;

  IF _inv.payment_type = 'debt' THEN
    FOR _payment IN
      SELECT p.*, (SELECT count(*) FROM public.shift_transactions t
               WHERE t.shift_id = p.shift_id AND t.user_id = p.user_id AND t.type = 'debt_payment'
                 AND t.reference_id = p.operation_id) AS movements,
             (SELECT t.currency_amount FROM public.shift_transactions t
               WHERE t.shift_id = p.shift_id AND t.user_id = p.user_id AND t.type = 'debt_payment'
                 AND t.reference_id = p.operation_id
                 AND t.amount = p.amount AND upper(t.currency) = upper(p.currency) AND t.exchange_rate = p.exchange_rate
               LIMIT 1) AS movement_currency_amount
        FROM public.debt_payments p JOIN public.debts d ON d.id = p.debt_id AND d.user_id = p.user_id
       WHERE p.user_id = _inv.user_id AND NOT COALESCE(d.is_cash_debt, false)
         AND d.invoice_id IN (_inv.invoice_number, _inv.id::text)
         -- the sale-time down payment (operation id '<sale op>:down', migration 20261125170000) is the sale receipt,
         -- already counted through invoices.paid_at_sale and its 'sale' drawer movement
         AND p.operation_id NOT LIKE '%:down'
       ORDER BY p.created_at, p.id
    LOOP
      IF COALESCE(_payment.settled_amount, 0) <= 0 OR COALESCE(_payment.amount, -1) < 0
         OR COALESCE(_payment.payment_method, '') NOT IN ('cash', 'transfer')
         OR NULLIF(trim(_payment.currency), '') IS NULL OR COALESCE(_payment.exchange_rate, 0) <= 0
         OR (_payment.payment_method = 'cash' AND _payment.amount > 0
             AND (_payment.movements <> 1 OR _payment.movement_currency_amount IS NULL))
         OR (_payment.payment_method = 'transfer' AND _payment.shift_id IS NOT NULL) THEN
        RAISE EXCEPTION 'إحدى دفعات الدين الأصلية غير موثقة بما يكفي للرد';
      END IF;
      _sale_original := CASE WHEN upper(_payment.currency) = 'USD' THEN _payment.amount
                        ELSE COALESCE(_payment.currency_amount, _payment.movement_currency_amount) END;
      IF _sale_original IS NULL OR _sale_original < 0
          OR (_payment.amount > 0 AND _sale_original <= 0)
          OR abs(_sale_original / _payment.exchange_rate - _payment.amount) > 0.005 THEN
        RAISE EXCEPTION 'مبلغ العملة الأصلية لإحدى الدفعات غير موثق';
      END IF;
      _receipts := _receipts || jsonb_build_object('key', 'debt:' || _payment.id::text,
        'method', _payment.payment_method, 'ccy', upper(_payment.currency), 'rate', _payment.exchange_rate,
        'settled', _payment.settled_amount, 'usd', _payment.amount, 'original', _sale_original);
    END LOOP;
  END IF;

  SELECT COALESCE(sum(s.settled - COALESCE(previous.used, 0)), 0) INTO _available
    FROM jsonb_to_recordset(_receipts) AS s(key text, settled numeric)
    LEFT JOIN LATERAL (SELECT sum(a.settled_amount) AS used FROM public.sales_refund_allocations a
      WHERE a.user_id = _inv.user_id AND a.invoice_id = _inv.id AND a.receipt_key = s.key) previous ON true;
  IF _pending > _available + 0.0001
       OR (_inv.payment_type = 'debt' AND abs(_available - COALESCE(_inv.debt_paid, 0)) > 0.0001) THEN
    RAISE EXCEPTION 'مبلغ الرد لا يطابق المتبقي من إيصالات القبض الأصلية';
  END IF;
  _pending := LEAST(_pending, _available);

  IF _mode = 'drawer' AND EXISTS (SELECT 1 FROM jsonb_to_recordset(_receipts) AS s(method text) WHERE s.method = 'cash') THEN
    IF _shift IS NOT NULL THEN
      PERFORM 1 FROM public.cash_shifts WHERE id = _shift AND user_id = _inv.user_id AND closed_at IS NULL FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'وردية الرد غير موجودة أو مغلقة أو لا تتبع لهذا المتجر'; END IF;
    END IF;
  END IF;

  FOR _receipt IN
    SELECT s.* FROM jsonb_array_elements(_receipts) WITH ORDINALITY r(value, ordinal)
      CROSS JOIN LATERAL jsonb_to_record(r.value)
        AS s(key text, method text, ccy text, rate numeric, settled numeric, usd numeric, original numeric)
      ORDER BY r.ordinal
  LOOP
    EXIT WHEN _pending <= 0;
    SELECT COALESCE(sum(a.settled_amount), 0), COALESCE(sum(a.tender_usd), 0), COALESCE(sum(a.currency_amount), 0)
      INTO _previous, _previous_usd, _previous_original
      FROM public.sales_refund_allocations a
     WHERE a.user_id = _inv.user_id AND a.invoice_id = _inv.id AND a.receipt_key = _receipt.key;
    _take := LEAST(_pending, _receipt.settled - _previous);
    CONTINUE WHEN _take <= 0;
    _net_usd := round(_receipt.usd * (_previous + _take) / _receipt.settled, 8) - _previous_usd;
    _net_original := round(_receipt.original * (_previous + _take) / _receipt.settled,
      CASE WHEN _receipt.ccy = 'USD' THEN 2 ELSE 4 END) - _previous_original;
    IF _net_usd < 0 OR _net_original < 0 THEN RAISE EXCEPTION 'تعارض في رصيد إيصال القبض التاريخي'; END IF;

    IF _receipt.method = 'cash' THEN
      _cash := _cash + _net_usd;
      IF _mode = 'drawer' AND (_net_usd > 0 OR _net_original > 0) THEN
        IF _shift IS NULL THEN RAISE EXCEPTION 'الرد النقدي يتطلب وردية تسوية صريحة ومفتوحة'; END IF;
        INSERT INTO public.shift_transactions(shift_id, user_id, type, amount, reference_id, notes, currency, currency_amount, exchange_rate)
        VALUES (_shift, _inv.user_id, 'refund', _net_usd, 'receipt-refund:' || _kind || ':' || _operation || ':' || _receipt.key,
          'رد إيصال قبض للفاتورة ' || _inv.invoice_number, _receipt.ccy, _net_original, _receipt.rate);
        _drawer := _drawer + _net_usd;
        _drawer_recorded := true;
      END IF;
    ELSE
      _digital := _digital + _net_usd;
    END IF;

    INSERT INTO public.sales_refund_allocations(user_id, invoice_id, kind, operation_id, receipt_key,
      method, currency, exchange_rate, settled_amount, tender_usd, currency_amount, shift_id, settlement_mode)
    VALUES (_inv.user_id, _inv.id, _kind, _operation, _receipt.key, _receipt.method, _receipt.ccy, _receipt.rate,
      _take, _net_usd, _net_original, CASE WHEN _receipt.method = 'cash' AND _mode = 'drawer' THEN _shift END, _mode);
    _allocations := _allocations || jsonb_build_object('method', _receipt.method, 'currency', _receipt.ccy, 'exchange_rate', _receipt.rate,
      'currency_amount', _net_original, 'tender_usd', _net_usd, 'settled_amount', _take);
    _pending := _pending - _take;
  END LOOP;

  IF _drawer > 0 THEN
    UPDATE public.cash_shifts SET expected_balance = round(COALESCE(expected_balance, 0) - _drawer, 8), updated_at = now()
     WHERE id = _shift AND user_id = _inv.user_id AND closed_at IS NULL;
  END IF;

  RETURN jsonb_build_object('cash', _cash, 'digital', _digital, 'drawer', _drawer,
    'drawer_recorded', _drawer_recorded, 'allocations', _allocations);
END;
$function$
;

-- FUNCTION _assert_accounting_posting_open | normalized md5 f44fb21ea86da5b1637e815d6681c59a
CREATE OR REPLACE FUNCTION public._assert_accounting_posting_open(_owner uuid, _posted_at timestamp with time zone, _label text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext('close_accounting_period:' || _owner::text));
  IF EXISTS (
    SELECT 1 FROM public.accounting_period_closures c
     WHERE c.user_id = _owner
       AND (_posted_at AT TIME ZONE COALESCE(c.closing_timezone, 'UTC'))::date
           BETWEEN c.period_start AND c.period_end
  ) THEN
    RAISE EXCEPTION '% مرفوضة: وقت الترحيل ضمن فترة مقفلة', _label;
  END IF;
END;
$function$
;

-- FUNCTION _assert_sales_refund_currency | normalized md5 8b25c9d142824cb286cee7cee3f64411
CREATE OR REPLACE FUNCTION public._assert_sales_refund_currency(_settlement jsonb, _currency text, _currency_amount numeric, _rate numeric)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  _original_amount numeric;
  _matches boolean;
BEGIN
  IF (_settlement->>'cash')::numeric <= 0 OR
      (_currency IS NULL AND _currency_amount IS NULL AND _rate IS NULL) THEN RETURN; END IF;
  SELECT COALESCE(bool_and((_currency IS NULL OR s.currency = upper(trim(_currency))) AND
      (_rate IS NULL OR s.exchange_rate = _rate)), false), sum(s.currency_amount)
    INTO _matches, _original_amount
    FROM jsonb_to_recordset(_settlement->'allocations')
      AS s(method text, currency text, exchange_rate numeric, currency_amount numeric)
   WHERE s.method = 'cash';
  IF NOT _matches OR (_currency_amount IS NOT NULL AND abs(_original_amount - _currency_amount) > 0.0001) THEN
    RAISE EXCEPTION 'بيانات العملة المرسلة لا تطابق إيصالات القبض. استخدم النسخة التي تعتمد تخصيص الإيصالات';
  END IF;
END;
$function$
;

-- FUNCTION _capture_invoice_accounting_state | normalized md5 54785824aca2250594b8eab4cff25ff9
CREATE OR REPLACE FUNCTION public._capture_invoice_accounting_state(_invoice_id uuid, _owner_hint uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _previous public.invoice_accounting_events%ROWTYPE;
  _state record;
  _owner uuid;
  _txid bigint := txid_current();
  _revenue numeric;
  _cogs numeric;
  _realized numeric;
  _pending numeric;
BEGIN
  SELECT * INTO _state FROM public._invoice_accounting_state WHERE invoice_id = _invoice_id;
  IF FOUND THEN
    _owner := _state.user_id;
    _revenue := _state.net_revenue;
    _cogs := _state.cogs;
    _realized := _state.realized_profit;
    _pending := _state.pending_profit;
  ELSE
    _owner := _owner_hint;
    _revenue := 0;
    _cogs := 0;
    _realized := 0;
    _pending := 0;
  END IF;

  SELECT * INTO _previous
    FROM public.invoice_accounting_events
   WHERE invoice_id = _invoice_id AND txid <> _txid
   ORDER BY id DESC
   LIMIT 1;

  _owner := COALESCE(_owner, _previous.user_id);
  IF _owner IS NULL THEN RETURN; END IF;
  IF _previous.user_id IS NOT NULL AND _previous.user_id <> _owner THEN
    RAISE EXCEPTION 'لا يمكن نقل فاتورة مرحّلة بين حسابات المتاجر';
  END IF;

  IF ROW(_revenue, _cogs, _realized, _pending) IS NOT DISTINCT FROM
     ROW(COALESCE(_previous.net_revenue, 0), COALESCE(_previous.cogs, 0),
         COALESCE(_previous.realized_profit, 0), COALESCE(_previous.pending_profit, 0)) THEN
    DELETE FROM public.invoice_accounting_events WHERE invoice_id = _invoice_id AND txid = _txid;
    RETURN;
  END IF;

  INSERT INTO public.invoice_accounting_events(
    user_id, invoice_id, txid, posted_at, net_revenue, cogs, realized_profit, pending_profit,
    revenue_delta, cogs_delta, realized_delta
  ) VALUES (
    _owner, _invoice_id, _txid, clock_timestamp(), _revenue, _cogs, _realized, _pending,
    _revenue - COALESCE(_previous.net_revenue, 0), _cogs - COALESCE(_previous.cogs, 0),
    _realized - COALESCE(_previous.realized_profit, 0)
  )
  ON CONFLICT (invoice_id, txid) DO UPDATE SET
    net_revenue = EXCLUDED.net_revenue,
    cogs = EXCLUDED.cogs,
    realized_profit = EXCLUDED.realized_profit,
    pending_profit = EXCLUDED.pending_profit,
    revenue_delta = EXCLUDED.revenue_delta,
    cogs_delta = EXCLUDED.cogs_delta,
    realized_delta = EXCLUDED.realized_delta;
END;
$function$
;

-- FUNCTION _credit_actor | normalized md5 3c2aa3e1d7e22d73733183dc4cb6cd21
CREATE OR REPLACE FUNCTION public._credit_actor(_need_refund boolean DEFAULT true)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _c uuid := auth.uid(); _o uuid;
BEGIN
  IF _c IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  _o := public.get_owner_id(_c);
  IF _o IS NULL THEN RAISE EXCEPTION 'Owner context is required'; END IF;
  IF _need_refund AND NOT (public.is_store_owner(_c) OR public.can_refund_invoices(_c)) THEN
    RAISE EXCEPTION 'ليس لديك صلاحية التعامل مع رصيد العملاء' USING ERRCODE='42501';
  END IF;
  RETURN _o;
END $function$
;

-- FUNCTION _guard_inventory_valuation_posting | normalized md5 59edf19810ce96ed5e11ec15fe4c0aa4
CREATE OR REPLACE FUNCTION public._guard_inventory_valuation_posting()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.variance_usd::text IN ('NaN', 'Infinity', '-Infinity') THEN
    RAISE EXCEPTION 'فرق تقييم المخزون غير صالح';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtext('close_accounting_period:' || NEW.user_id::text));
  IF EXISTS (
    SELECT 1 FROM public.accounting_period_closures p
     WHERE p.user_id = NEW.user_id
       AND (NEW.created_at AT TIME ZONE COALESCE(p.closing_timezone, 'UTC'))::date
           BETWEEN p.period_start AND p.period_end
  ) THEN
    RAISE EXCEPTION 'فرق تقييم المخزون يقع في فترة محاسبية مغلقة';
  END IF;
  RETURN NEW;
END;
$function$
;

-- FUNCTION _hold_invoice_accounting_lock | normalized md5 84d5cb5729ab0f771e910262424a227a
CREATE OR REPLACE FUNCTION public._hold_invoice_accounting_lock()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _invoice_id uuid;
  _owner uuid;
BEGIN
  IF TG_TABLE_NAME = 'invoices' THEN
    IF TG_OP = 'DELETE' THEN _owner := OLD.user_id;
    ELSE _owner := NEW.user_id; END IF;
  ELSE
    IF TG_OP = 'UPDATE' AND OLD.invoice_id IS DISTINCT FROM NEW.invoice_id THEN
      RAISE EXCEPTION 'لا يمكن نقل بند مرحّل من فاتورة إلى أخرى';
    END IF;
    IF TG_OP = 'DELETE' THEN _invoice_id := OLD.invoice_id;
    ELSE _invoice_id := NEW.invoice_id; END IF;
    SELECT user_id INTO _owner FROM public.invoices WHERE id = _invoice_id FOR NO KEY UPDATE;
  END IF;
  IF _owner IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock_shared(hashtext('close_accounting_period:' || _owner::text));
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$
;

-- FUNCTION _inventory_valuation_for_period | normalized md5 2299a235c5ea3afe21622d25822d1254
CREATE OR REPLACE FUNCTION public._inventory_valuation_for_period(_owner uuid, _period_start date, _period_end date, _timezone text)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT round(COALESCE(SUM(a.variance_usd), 0), 8)
    FROM public.inventory_valuation_adjustments a
   WHERE a.user_id = _owner
     AND a.source_type IN ('purchase_return', 'purchase_cancel', 'purchase_edit')
     AND a.created_at >= (_period_start::timestamp AT TIME ZONE _timezone)
     AND a.created_at < ((_period_end + 1)::timestamp AT TIME ZONE _timezone);
$function$
;

-- FUNCTION _journal_invoice_accounting_change | normalized md5 4db73bf95a06bc585d340b95f1357b46
CREATE OR REPLACE FUNCTION public._journal_invoice_accounting_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_TABLE_NAME = 'invoices' THEN
    IF TG_OP = 'DELETE' THEN PERFORM public._capture_invoice_accounting_state(OLD.id, OLD.user_id);
    ELSE PERFORM public._capture_invoice_accounting_state(NEW.id, NEW.user_id); END IF;
  ELSE
    IF TG_OP = 'DELETE' THEN
      PERFORM public._capture_invoice_accounting_state(OLD.invoice_id, NULL);
    ELSE
      PERFORM public._capture_invoice_accounting_state(NEW.invoice_id, NULL);
      IF TG_OP = 'UPDATE' AND OLD.invoice_id IS DISTINCT FROM NEW.invoice_id THEN
        PERFORM public._capture_invoice_accounting_state(OLD.invoice_id, NULL);
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END;
$function$
;

-- FUNCTION _owner_purge_allowed | normalized md5 732cc882782600613559216b9882fac9
CREATE OR REPLACE FUNCTION public._owner_purge_allowed()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(current_setting('app.purge_context', true), '') = 'owner_purge'
     AND auth.uid() IS NOT NULL
     AND (public.is_boss(auth.uid()) OR public.is_store_owner(auth.uid()));
$function$
;

-- FUNCTION _partner_ledger_capture | normalized md5 622f8c1758e9dbb0abb5575a51ca0a9f
CREATE OR REPLACE FUNCTION public._partner_ledger_capture()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _src text := COALESCE(NULLIF(current_setting('app.partner_source', true),''), NULLIF(current_setting('app.stock_source', true),''), TG_OP);
        _ref text := NULLIF(current_setting('app.partner_ref', true),'');
        _type text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.partner_ledger_entries(user_id,partner_id,entry_type,d_current_balance,d_pending_profit,d_confirmed_profit,d_total_profit_earned,d_total_withdrawn,d_current_capital,source,reference,actor)
    VALUES (NEW.user_id,NEW.id,'opening',COALESCE(NEW.current_balance,0),COALESCE(NEW.pending_profit,0),COALESCE(NEW.confirmed_profit,0),COALESCE(NEW.total_profit_earned,0),COALESCE(NEW.total_withdrawn,0),COALESCE(NEW.current_capital,0),_src,_ref,auth.uid());
    RETURN NEW;
  END IF;
  IF COALESCE(NEW.current_balance,0)=COALESCE(OLD.current_balance,0) AND COALESCE(NEW.pending_profit,0)=COALESCE(OLD.pending_profit,0)
     AND COALESCE(NEW.confirmed_profit,0)=COALESCE(OLD.confirmed_profit,0) AND COALESCE(NEW.total_profit_earned,0)=COALESCE(OLD.total_profit_earned,0)
     AND COALESCE(NEW.total_withdrawn,0)=COALESCE(OLD.total_withdrawn,0) AND COALESCE(NEW.current_capital,0)=COALESCE(OLD.current_capital,0) THEN
    RETURN NEW;
  END IF;
  _type := CASE
    WHEN COALESCE(NEW.total_withdrawn,0) > COALESCE(OLD.total_withdrawn,0) THEN 'withdrawal'
    WHEN COALESCE(NEW.current_capital,0) <> COALESCE(OLD.current_capital,0) THEN 'capital'
    WHEN COALESCE(NEW.pending_profit,0) <> COALESCE(OLD.pending_profit,0) AND COALESCE(NEW.confirmed_profit,0) = COALESCE(OLD.confirmed_profit,0) THEN 'pending_profit'
    WHEN COALESCE(NEW.confirmed_profit,0) > COALESCE(OLD.confirmed_profit,0) THEN 'profit'
    WHEN COALESCE(NEW.confirmed_profit,0) < COALESCE(OLD.confirmed_profit,0) OR COALESCE(NEW.total_profit_earned,0) < COALESCE(OLD.total_profit_earned,0) THEN 'reversal'
    ELSE 'adjustment' END;
  INSERT INTO public.partner_ledger_entries(user_id,partner_id,entry_type,d_current_balance,d_pending_profit,d_confirmed_profit,d_total_profit_earned,d_total_withdrawn,d_current_capital,source,reference,actor)
  VALUES (NEW.user_id,NEW.id,_type,
    COALESCE(NEW.current_balance,0)-COALESCE(OLD.current_balance,0), COALESCE(NEW.pending_profit,0)-COALESCE(OLD.pending_profit,0),
    COALESCE(NEW.confirmed_profit,0)-COALESCE(OLD.confirmed_profit,0), COALESCE(NEW.total_profit_earned,0)-COALESCE(OLD.total_profit_earned,0),
    COALESCE(NEW.total_withdrawn,0)-COALESCE(OLD.total_withdrawn,0), COALESCE(NEW.current_capital,0)-COALESCE(OLD.current_capital,0),
    _src,_ref,auth.uid());
  RETURN NEW;
END $function$
;

-- FUNCTION _partner_ledger_immutable | normalized md5 82d87e2eb122e17272e3d50604209a07
CREATE OR REPLACE FUNCTION public._partner_ledger_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' AND public._owner_purge_allowed() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'سجل الشركاء غير قابل للتعديل أو الحذف';
END
$function$
;

-- FUNCTION _partners_trim_history | normalized md5 7babc05dd5543daa17053477152c4713
CREATE OR REPLACE FUNCTION public._partners_trim_history()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE _cut timestamptz := now() - interval '400 days';
BEGIN
  IF jsonb_typeof(NEW.profit_history)='array' AND jsonb_array_length(NEW.profit_history) > 1500 THEN
    NEW.profit_history := COALESCE((SELECT jsonb_agg(x) FROM jsonb_array_elements(NEW.profit_history) x WHERE COALESCE(x->>'createdAt','') !~ '^\d{4}-' OR (x->>'createdAt')::timestamptz >= _cut), '[]'::jsonb);
  END IF;
  IF jsonb_typeof(NEW.expense_history)='array' AND jsonb_array_length(NEW.expense_history) > 1500 THEN
    NEW.expense_history := COALESCE((SELECT jsonb_agg(x) FROM jsonb_array_elements(NEW.expense_history) x WHERE COALESCE(x->>'createdAt','') !~ '^\d{4}-' OR (x->>'createdAt')::timestamptz >= _cut), '[]'::jsonb);
  END IF;
  IF jsonb_typeof(NEW.withdrawal_history)='array' AND jsonb_array_length(NEW.withdrawal_history) > 1500 THEN
    NEW.withdrawal_history := COALESCE((SELECT jsonb_agg(x) FROM jsonb_array_elements(NEW.withdrawal_history) x WHERE COALESCE(x->>'createdAt',x->>'date','') !~ '^\d{4}-' OR COALESCE(x->>'createdAt',x->>'date')::timestamptz >= _cut), '[]'::jsonb);
  END IF;
  RETURN NEW;
END $function$
;

-- FUNCTION _posflow_integrity_core | normalized md5 7f009d3ebfe9c202fbb1edf87dd16c5b
CREATE OR REPLACE FUNCTION public._posflow_integrity_core(_owner uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _res jsonb := '[]'::jsonb; _cnt int; _sample jsonb;
BEGIN
  SELECT count(*), COALESCE(jsonb_agg(x.id) FILTER (WHERE x.rn<=10),'[]') INTO _cnt,_sample FROM (SELECT p.id, row_number() over() rn FROM products p WHERE p.user_id=_owner AND p.quantity<0) x;
  _res := _res || jsonb_build_object('check','negative_stock','severity','high','count',_cnt,'sample',_sample);

  SELECT count(*), COALESCE(jsonb_agg(x.id) FILTER (WHERE x.rn<=10),'[]') INTO _cnt,_sample FROM (
    SELECT c.id, row_number() over() rn FROM customers c
     WHERE c.user_id=_owner AND abs(COALESCE(c.total_debt,0) - COALESCE((SELECT SUM(d.remaining_debt) FROM debts d WHERE d.user_id=_owner AND COALESCE(d.status,'') NOT IN ('fully_paid','written_off','cancelled') AND (d.customer_id=c.id OR (d.customer_id IS NULL AND d.customer_name=c.name))),0)) > 0.01) x;
  _res := _res || jsonb_build_object('check','customer_debt_mismatch','severity','high','count',_cnt,'sample',_sample);

  SELECT count(*), COALESCE(jsonb_agg(x.id) FILTER (WHERE x.rn<=10),'[]') INTO _cnt,_sample FROM (
    SELECT d.id, row_number() over() rn FROM debts d JOIN invoices i ON i.user_id=d.user_id AND (d.invoice_id=i.invoice_number OR d.invoice_id=i.id::text)
     WHERE d.user_id=_owner AND COALESCE(d.status,'') NOT IN ('fully_paid','written_off','cancelled') AND d.remaining_debt>0 AND i.status IN ('refunded','cancelled')) x;
  _res := _res || jsonb_build_object('check','open_debt_on_refunded_invoice','severity','high','count',_cnt,'sample',_sample);

  SELECT count(*), COALESCE(jsonb_agg(x.id) FILTER (WHERE x.rn<=10),'[]') INTO _cnt,_sample FROM (
    SELECT i.id, row_number() over() rn FROM invoices i
     WHERE i.user_id=_owner AND i.payment_type='debt' AND i.status NOT IN ('refunded','cancelled')
       AND abs(COALESCE(i.debt_remaining,0) - COALESCE((SELECT SUM(d.remaining_debt) FROM debts d WHERE d.user_id=_owner AND COALESCE(d.status,'') NOT IN ('cancelled') AND (d.invoice_id=i.invoice_number OR d.invoice_id=i.id::text)),0)) > 0.01) x;
  _res := _res || jsonb_build_object('check','invoice_debt_vs_debts','severity','high','count',_cnt,'sample',_sample);

  SELECT count(*), COALESCE(jsonb_agg(x.id) FILTER (WHERE x.rn<=10),'[]') INTO _cnt,_sample FROM (
    SELECT d.id, row_number() over() rn FROM debts d
     WHERE d.user_id=_owner AND COALESCE(d.status,'') NOT IN ('cancelled','written_off')
       AND abs(COALESCE(d.total_debt,0)-COALESCE(d.total_paid,0)-COALESCE(d.remaining_debt,0)) > 0.01) x;
  _res := _res || jsonb_build_object('check','debt_math','severity','medium','count',_cnt,'sample',_sample);

  SELECT count(*), COALESCE(jsonb_agg(x.id) FILTER (WHERE x.rn<=10),'[]') INTO _cnt,_sample FROM (
    SELECT i.id, row_number() over() rn FROM invoices i
     WHERE i.user_id=_owner AND i.status NOT IN ('refunded','cancelled')
       AND EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.invoice_id=i.id)
       AND abs(COALESCE(i.profit,0) - (SELECT COALESCE(SUM(ii.profit),0) FROM invoice_items ii WHERE ii.invoice_id=i.id)) > 0.05) x;
  _res := _res || jsonb_build_object('check','invoice_profit_vs_items','severity','medium','count',_cnt,'sample',_sample);

  SELECT count(*), COALESCE(jsonb_agg(x.id) FILTER (WHERE x.rn<=10),'[]') INTO _cnt,_sample FROM (
    SELECT p.id, row_number() over() rn FROM partners p
     WHERE p.user_id=_owner AND abs(COALESCE(p.pending_profit,0) - COALESCE((SELECT SUM((e->>'amount')::numeric) FROM jsonb_array_elements(COALESCE(p.pending_profit_details,'[]'::jsonb)) e),0)) > 0.01) x;
  _res := _res || jsonb_build_object('check','partner_pending_vs_details','severity','medium','count',_cnt,'sample',_sample);

  RETURN jsonb_build_object('checked_at', now(), 'issues_total', (SELECT COALESCE(SUM((e->>'count')::int),0) FROM jsonb_array_elements(_res) e), 'checks', _res);
END $function$
;

-- FUNCTION _purchase_drawer_payment_for_cancellation | normalized md5 fd0350f7d8986216e17625c52d7a1723
CREATE OR REPLACE FUNCTION public._purchase_drawer_payment_for_cancellation(_owner uuid, _invoice_id uuid, _paid_amount numeric)
 RETURNS SETOF shift_transactions
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  _invoice_ids text[];
  _requires_drawer boolean;
  _payments public.shift_transactions[];
  _payment public.shift_transactions%ROWTYPE;
  _currency text;
BEGIN
  WITH RECURSIVE invoice_family AS (
    SELECT id, paid_from, amount_paid FROM public.purchase_invoices
     WHERE user_id = _owner AND id = _invoice_id
    UNION
    SELECT p.id, p.paid_from, p.amount_paid
      FROM public.purchase_invoices p JOIN invoice_family f ON p.replaced_by = f.id
     WHERE p.user_id = _owner
  )
  SELECT array_agg('purchase:' || id::text), bool_or(paid_from = 'drawer' AND amount_paid > 0)
    INTO _invoice_ids, _requires_drawer
    FROM invoice_family;

  SELECT array_agg(t ORDER BY t.id) INTO _payments
    FROM public.shift_transactions t
   WHERE t.user_id = _owner AND t.type = 'supplier_payment' AND t.reference_id = ANY(_invoice_ids);

  IF COALESCE(cardinality(_payments), 0) = 0 AND _requires_drawer IS NOT TRUE THEN RETURN; END IF;
  IF COALESCE(cardinality(_payments), 0) <> 1 THEN
    RAISE EXCEPTION 'حركة دفعة المورد الأصلية مفقودة أو ملتبسة. يجب تسويتها قبل الإلغاء';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.shift_transactions t
     WHERE t.user_id = _owner AND t.type = 'supplier_refund'
       AND t.reference_id IN (SELECT replace(ref, 'purchase:', 'purchase_cancel:') FROM unnest(_invoice_ids) ref)
  ) THEN
    RAISE EXCEPTION 'دفعة الشراء لها قيد استرداد سابق. يجب مطابقته قبل الإلغاء';
  END IF;
  _payment := _payments[1];
  IF _payment.shift_id IS NULL OR _payment.amount <= 0
     OR _payment.amount::text IN ('NaN', 'Infinity', '-Infinity')
     OR _payment.amount IS DISTINCT FROM COALESCE(_paid_amount, 0) THEN
    RAISE EXCEPTION 'مبلغ أو مرجع دفعة المورد الأصلية لا يطابق الفاتورة';
  END IF;

  _currency := upper(COALESCE(NULLIF(trim(_payment.currency), ''), 'USD'));
  IF _currency = 'USD' THEN
    IF _payment.currency_amount IS NOT NULL AND _payment.currency_amount <> _payment.amount THEN
      RAISE EXCEPTION 'مبلغ العملة في دفعة المورد الأصلية غير متسق';
    END IF;
    _payment.currency_amount := _payment.amount;
    _payment.exchange_rate := 1;
  ELSIF _payment.currency_amount IS NULL OR _payment.currency_amount <= 0
      OR _payment.exchange_rate IS NULL OR _payment.exchange_rate <= 0
      OR _payment.currency_amount::text IN ('NaN', 'Infinity', '-Infinity')
      OR _payment.exchange_rate::text IN ('NaN', 'Infinity', '-Infinity')
      OR abs(_payment.currency_amount / _payment.exchange_rate - _payment.amount) > 0.005 THEN
    RAISE EXCEPTION 'بيانات الصرف في دفعة المورد الأصلية تحتاج إلى تسوية';
  END IF;
  _payment.currency := _currency;
  RETURN NEXT _payment;
END;
$function$
;

-- FUNCTION _read_sales_settlement_replay | normalized md5 220c16699859bf5e06792da0be833952
CREATE OR REPLACE FUNCTION public._read_sales_settlement_replay(_owner uuid, _kind text, _operation text, _request jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  _saved public.sales_settlement_replays%ROWTYPE;
BEGIN
  IF _owner IS NULL OR NULLIF(trim(_operation), '') IS NULL THEN
    RAISE EXCEPTION 'معرّف العملية غير صالح';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(_owner::text || ':' || _kind || ':' || _operation, 0));
  SELECT * INTO _saved FROM public.sales_settlement_replays
   WHERE user_id = _owner AND kind = _kind AND operation_id = _operation;
  IF FOUND AND _saved.request IS DISTINCT FROM _request THEN
    RAISE EXCEPTION 'معرّف العملية مستخدم مسبقاً لبيانات تسوية مختلفة' USING ERRCODE = '23505';
  END IF;
  RETURN _saved.response;
END;
$function$
;

-- FUNCTION _register_serials | normalized md5 520104e24efd9f73536f53d3e83cc894
CREATE OR REPLACE FUNCTION public._register_serials(_owner uuid, _product uuid, _serials text[], _cost numeric, _invoice uuid, _qty numeric)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _clean text[]; _s text; _id uuid; _n int := 0; _track boolean; _name text;
BEGIN
  SELECT track_serials, name INTO _track, _name FROM public.products WHERE id=_product AND user_id=_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'المنتج غير موجود'; END IF;
  SELECT COALESCE(array_agg(DISTINCT trim(x)) FILTER (WHERE trim(x) <> ''), '{}') INTO _clean FROM unnest(COALESCE(_serials,'{}')) x;
  IF cardinality(_clean) <> cardinality(COALESCE(_serials,'{}')) THEN RAISE EXCEPTION 'أرقام تسلسلية مكررة أو فارغة للمنتج %', _name; END IF;
  IF _qty IS NOT NULL AND cardinality(_clean) > 0 AND cardinality(_clean) <> _qty THEN
    RAISE EXCEPTION 'عدد الأرقام التسلسلية (%) لا يطابق الكمية (%) للمنتج %', cardinality(_clean), _qty, _name;
  END IF;
  FOREACH _s IN ARRAY _clean LOOP
    IF EXISTS (SELECT 1 FROM public.product_serials WHERE user_id=_owner AND product_id=_product AND lower(serial)=lower(_s) AND status='in_stock') THEN
      RAISE EXCEPTION 'الرقم التسلسلي % مسجّل مسبقاً ومتوفر في المخزون', _s;
    END IF;
    SELECT id INTO _id FROM public.product_serials WHERE user_id=_owner AND product_id=_product AND lower(serial)=lower(_s);
    IF _id IS NULL THEN
      INSERT INTO public.product_serials(user_id,product_id,serial,status,cost_price,purchase_invoice_id) VALUES (_owner,_product,_s,'in_stock',_cost,_invoice) RETURNING id INTO _id;
    ELSE
      UPDATE public.product_serials SET status='in_stock', cost_price=_cost, purchase_invoice_id=_invoice, sold_invoice_id=NULL, sold_invoice_number=NULL, sold_at=NULL, customer_name=NULL, warranty_until=NULL, updated_at=now() WHERE id=_id;
    END IF;
    INSERT INTO public.product_serial_events(user_id,serial_id,event,ref,actor) VALUES (_owner,_id,'received',_invoice::text,auth.uid());
    _n := _n + 1;
  END LOOP;
  RETURN _n;
END $function$
;

-- FUNCTION _release_serials_on_invoice_refund | normalized md5 772132ae5a2c95c53804941dcfc64759
CREATE OR REPLACE FUNCTION public._release_serials_on_invoice_refund()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _r record;
BEGIN
  IF NEW.status IN ('refunded','cancelled') AND OLD.status IS DISTINCT FROM NEW.status THEN
    FOR _r IN SELECT id, user_id FROM public.product_serials WHERE sold_invoice_id = NEW.id AND status='sold' LOOP
      UPDATE public.product_serials SET status='in_stock', sold_invoice_id=NULL, sold_invoice_number=NULL, sold_at=NULL, customer_name=NULL, warranty_until=NULL, updated_at=now() WHERE id=_r.id;
      INSERT INTO public.product_serial_events(user_id,serial_id,event,ref,actor) VALUES (_r.user_id,_r.id,'customer_return',NEW.invoice_number,auth.uid());
    END LOOP;
  END IF;
  RETURN NEW;
END $function$
;

-- FUNCTION _split_reversal_by_category | normalized md5 cddb7cda2fc33cda99bab56081b45d3b
CREATE OR REPLACE FUNCTION public._split_reversal_by_category(_rec jsonb, _history jsonb, _invoice_number text)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE _tot numeric := 0; _out jsonb := '[]'::jsonb; _x record; _w numeric; _n int := 0; _cnt int;
BEGIN
  SELECT COALESCE(SUM(ABS(COALESCE((x->>'amount')::numeric,0))),0), COUNT(DISTINCT COALESCE(NULLIF(x->>'category',''),'-')) INTO _tot, _cnt
    FROM jsonb_array_elements(COALESCE(_history,'[]'::jsonb)) x
   WHERE x->>'invoiceId' = _invoice_number AND COALESCE((x->>'isReversal')::boolean,false)=false AND COALESCE((x->>'isRelease')::boolean,false)=false
     AND COALESCE(x->>'id','') NOT LIKE '%-rel' AND COALESCE(x->>'category','') <> 'تحرير دفعة دين';
  IF _tot = 0 THEN RETURN jsonb_build_array(_rec); END IF;
  FOR _x IN
    SELECT COALESCE(NULLIF(x->>'category',''),'مرتجع فاتورة') cat, SUM(ABS(COALESCE((x->>'amount')::numeric,0))) amt
      FROM jsonb_array_elements(COALESCE(_history,'[]'::jsonb)) x
     WHERE x->>'invoiceId' = _invoice_number AND COALESCE((x->>'isReversal')::boolean,false)=false AND COALESCE((x->>'isRelease')::boolean,false)=false
       AND COALESCE(x->>'id','') NOT LIKE '%-rel' AND COALESCE(x->>'category','') <> 'تحرير دفعة دين' GROUP BY 1
  LOOP
    _w := _x.amt / _tot; _n := _n + 1;
    _out := _out || jsonb_build_array(_rec || jsonb_build_object('id', (_rec->>'id')||'-'||_n::text, 'category', _x.cat,
           'amount', round((_rec->>'amount')::numeric * _w, 8),
           'pendingReverted', round(COALESCE((_rec->>'pendingReverted')::numeric,0) * _w, 8),
           'confirmedReverted', round(COALESCE((_rec->>'confirmedReverted')::numeric,0) * _w, 8)));
  END LOOP;
  RETURN _out;
END $function$
;

-- FUNCTION _supplier_drawer_tx | normalized md5 3837db560996062508178b48d9e7a9a6
CREATE OR REPLACE FUNCTION public._supplier_drawer_tx(_owner uuid, _shift uuid, _type text, _amount numeric, _ccy text, _ccy_amount numeric, _rate numeric, _ref text, _note text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _inserted int := 0;
  _delta numeric := 0;
BEGIN
  IF _shift IS NULL THEN
    RAISE EXCEPTION 'يجب تحديد وردية مفتوحة صالحة لتسجيل حركة صندوق المورد';
  END IF;

  PERFORM 1
    FROM public.cash_shifts
   WHERE id = _shift
     AND user_id = _owner
     AND closed_at IS NULL
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'الوردية المحددة غير موجودة أو مغلقة أو لا تتبع لهذا المتجر';
  END IF;

  INSERT INTO public.shift_transactions(
    shift_id, user_id, type, amount, reference_id, notes, currency, currency_amount, exchange_rate
  )
  VALUES (
    _shift, _owner, _type, round(_amount, 4), _ref, _note,
    COALESCE(_ccy, 'USD'), COALESCE(_ccy_amount, _amount), _rate
  )
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS _inserted = ROW_COUNT;
  IF _inserted > 0 THEN
    _delta := CASE WHEN _type = 'supplier_refund' THEN round(_amount, 4) ELSE -round(_amount, 4) END;
    UPDATE public.cash_shifts
       SET expected_balance = round(COALESCE(expected_balance, 0) + _delta, 8),
           updated_at = now()
     WHERE id = _shift AND user_id = _owner AND closed_at IS NULL;
  END IF;
END;
$function$
;

-- FUNCTION _supplier_owner | normalized md5 d31371ee34a3304bd24d13f8e9427a6e
CREATE OR REPLACE FUNCTION public._supplier_owner()
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _c uuid := auth.uid();
BEGIN
  IF _c IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF NOT public.is_store_owner(_c) THEN RAISE EXCEPTION 'إدارة الموردين لمالك المتجر ومديره فقط' USING ERRCODE='42501'; END IF;
  RETURN public.get_owner_id(_c);
END $function$
;

-- FUNCTION activate_code_strict | normalized md5 bc38c3bf64c42971dea46131263ef6a1
CREATE OR REPLACE FUNCTION public.activate_code_strict(p_code text, p_user_id uuid, p_user_email text, p_device_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (auth.uid() IS NULL OR auth.uid() = p_user_id OR public.is_boss(auth.uid())) THEN
    RETURN jsonb_build_object('success', false, 'error', 'غير مصرح بتفعيل كود لحساب آخر');
  END IF;
  RETURN public.activate_code_strict__impl(p_code, p_user_id, p_user_email, p_device_id);
END;$function$
;

-- FUNCTION activate_code_strict__impl | normalized md5 9ecac324902a7bbe8f0defdd8b24ad5a
CREATE OR REPLACE FUNCTION public.activate_code_strict__impl(p_code text, p_user_id uuid, p_user_email text, p_device_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _code_rec record; _new_expires_at timestamptz;
BEGIN
  SELECT * INTO _code_rec FROM public.activation_codes WHERE upper(trim(code)) = upper(trim(p_code)) AND is_active = true FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'كود التفعيل غير صالح أو غير موجود'); END IF;
  IF _code_rec.current_uses >= _code_rec.max_uses THEN RETURN jsonb_build_object('success', false, 'error', 'تم استخدام هذا الكود وتفعيله مسبقاً'); END IF;
  IF _code_rec.assigned_email IS NOT NULL AND lower(trim(_code_rec.assigned_email)) <> lower(trim(p_user_email)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'هذا الكود مخصص لبريد إلكتروني آخر ولا يمكن استخدامه لهذا الحساب');
  END IF;
  IF _code_rec.assigned_user_id IS NOT NULL AND _code_rec.assigned_user_id <> p_user_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'هذا الكود مخصص لحساب آخر');
  END IF;
  _new_expires_at := now() + (_code_rec.duration_days || ' days')::interval;
  INSERT INTO public.app_licenses (user_id, activation_code_id, activated_at, expires_at, is_trial, is_revoked, max_cashiers, license_tier, device_id, allow_multi_device)
  VALUES (p_user_id, _code_rec.id, now(), _new_expires_at, false, false, COALESCE(_code_rec.max_cashiers, 1), COALESCE(_code_rec.license_tier, 'basic'), p_device_id, false)
  ON CONFLICT (user_id) DO UPDATE SET
    activation_code_id = EXCLUDED.activation_code_id, activated_at = EXCLUDED.activated_at, expires_at = EXCLUDED.expires_at,
    is_trial = false, is_revoked = false, max_cashiers = EXCLUDED.max_cashiers, license_tier = EXCLUDED.license_tier,
    device_id = CASE WHEN app_licenses.allow_multi_device THEN app_licenses.device_id ELSE p_device_id END,
    revoked_at = NULL, revoked_reason = NULL;
  UPDATE public.activation_codes SET current_uses = current_uses + 1, is_active = false, used_by = p_user_id, used_at = now(), locked_device_id = p_device_id WHERE id = _code_rec.id;
  RETURN jsonb_build_object('success', true, 'expires_at', _new_expires_at, 'duration_days', _code_rec.duration_days, 'max_cashiers', _code_rec.max_cashiers);
END;
$function$
;

-- FUNCTION add_expense_atomic | normalized md5 6bebd2d63e0851657ffd9ffbae274845
CREATE OR REPLACE FUNCTION public.add_expense_atomic(_operation_id text, _expense_type text, _amount numeric, _description text DEFAULT NULL::text, _date date DEFAULT CURRENT_DATE, _notes text DEFAULT NULL::text, _shift_id uuid DEFAULT NULL::uuid, _paid_from text DEFAULT NULL::text, _original_currency text DEFAULT 'USD'::text, _original_amount numeric DEFAULT NULL::numeric, _exchange_rate numeric DEFAULT 1)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _uid uuid := auth.uid();
  _owner uuid;
  _op_uuid uuid;
  _amt numeric := round(coalesce(_amount, 0), 8);
  _orig_ccy text := upper(COALESCE(NULLIF(trim(_original_currency), ''), 'USD'));
  _orig_rate numeric;
  _orig_amt numeric;
  _target_shift_id uuid := NULL;
  _dist jsonb := '[]'::jsonb;
  p record;
  _pct numeric;
  _part numeric;
  _pct_before numeric := 0;
  _cat_total numeric := 0;
  _remaining_amt numeric := 0;
  _drawer boolean := _shift_id IS NOT NULL OR lower(COALESCE(trim(_paid_from), '')) = 'drawer';
  _request jsonb;
  _previous_request jsonb;
  _result jsonb;
BEGIN
  PERFORM set_config('app.partner_source', 'add_expense_atomic', true);
  IF _uid IS NULL THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  IF _amt <= 0 OR _amt::text IN ('NaN', 'Infinity', '-Infinity') THEN RAISE EXCEPTION 'المبلغ يجب أن يكون أكبر من الصفر'; END IF;

  _owner := public.get_owner_id(_uid);
  IF _owner IS NULL THEN RAISE EXCEPTION 'لم يتم العثور على حساب المالك'; END IF;

  IF NULLIF(trim(COALESCE(_operation_id, '')), '') IS NULL THEN
    RAISE EXCEPTION 'معرّف العملية مطلوب';
  END IF;

  BEGIN
    _op_uuid := trim(_operation_id)::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    -- Deterministic UUID so retries with a non-UUID _operation_id remain idempotent
    _op_uuid := md5(_owner::text || ':expense:' || trim(_operation_id))::uuid;
  END;

  IF _original_amount::text IN ('NaN', 'Infinity', '-Infinity')
     OR _exchange_rate::text IN ('NaN', 'Infinity', '-Infinity') THEN
    RAISE EXCEPTION 'مبلغ المصروف أو سعر الصرف غير صالح';
  END IF;

  -- Resolve currency metadata
  IF _orig_ccy = 'USD' THEN
    _orig_rate := 1;
    _orig_amt := COALESCE(NULLIF(_original_amount, 0), _amt);
  ELSE
    _orig_rate := COALESCE(_exchange_rate, 0);
    IF _orig_rate <= 0 THEN
      RAISE EXCEPTION 'سعر الصرف غير صالح للعملة %', _orig_ccy;
    END IF;
    _orig_amt := COALESCE(NULLIF(_original_amount, 0), round(_amt * _orig_rate, 4));
  END IF;

  IF _orig_amt <= 0 OR abs(_orig_amt / _orig_rate - _amt) > 0.005 + 0.00005 / _orig_rate THEN
    RAISE EXCEPTION 'مبلغ المصروف الأصلي لا يطابق القيمة الدفترية وسعر الصرف';
  END IF;
  IF _drawer AND _shift_id IS NULL THEN
    RAISE EXCEPTION 'يجب تحديد الوردية الأصلية لتسجيل مصروف من الصندوق';
  END IF;
  IF _shift_id IS NOT NULL AND NULLIF(trim(_paid_from), '') IS NOT NULL AND lower(trim(_paid_from)) <> 'drawer' THEN
    RAISE EXCEPTION 'مصدر المصروف لا يطابق الوردية';
  END IF;

  _request := jsonb_build_object(
    'expense_type', _expense_type, 'amount', _amt, 'description', _description,
    'date', COALESCE(_date, CURRENT_DATE), 'notes', _notes, 'shift_id', _shift_id,
    'original_currency', _orig_ccy, 'original_amount', _orig_amt, 'exchange_rate', _orig_rate
  );
  PERFORM pg_advisory_xact_lock(hashtext('expense_op:' || _op_uuid::text));
  SELECT request, result INTO _previous_request, _result
    FROM public.accounting_rpc_receipts
   WHERE user_id = _owner AND kind = 'expense_add' AND operation_id = _op_uuid::text;
  IF FOUND THEN
    IF _previous_request IS DISTINCT FROM _request THEN
      RAISE EXCEPTION 'معرّف المصروف مرتبط بطلب مختلف';
    END IF;
    RETURN _result || jsonb_build_object('already_processed', true);
  END IF;
  IF EXISTS (SELECT 1 FROM public.expenses WHERE id = _op_uuid AND user_id = _owner) THEN
    RAISE EXCEPTION 'تم ترحيل معرّف المصروف سابقاً دون إيصال كامل. راجع سجل المصروف قبل إعادة المحاولة';
  END IF;

  PERFORM public.assert_period_open(_owner, COALESCE(_date, CURRENT_DATE), 'تسجيل مصروف');
  IF _drawer THEN
    SELECT id INTO _target_shift_id FROM public.cash_shifts
     WHERE id = _shift_id AND user_id = _owner AND closed_at IS NULL
       AND (cashier_id = _uid OR public.is_store_owner(_uid))
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'الوردية غير موجودة أو مغلقة أو لا تتبع لهذا المستخدم';
    END IF;
  END IF;

  PERFORM 1 FROM public.partners WHERE user_id = _owner ORDER BY id FOR UPDATE;

  -- KD-08 / D-09 (owner decision, 2026-11-23), applies to NEW expenses only.
  -- Step 1: category partners (access_all = false) pay their expense share of the TOTAL, taken off the top.
  FOR p IN
    SELECT * FROM public.partners
    WHERE user_id = _owner AND COALESCE(access_all, false) = false AND COALESCE(expense_share_percentage, 0) > 0
    ORDER BY id
  LOOP
    _pct := p.expense_share_percentage;
    _part := round(_amt * _pct / 100, 4);
    IF _part > 0 THEN
      _cat_total := _cat_total + _part;
      _dist := _dist || jsonb_build_object(
        'partnerId', p.id,
        'partnerName', p.name,
        'amount', _part,
        'percentage', _pct,
        'pool', 'category'
      );

        UPDATE public.partners SET
          current_balance = round(coalesce(current_balance, 0) - _part, 4),
          expense_history = coalesce(expense_history, '[]'::jsonb) || jsonb_build_object(
            'expenseId', _op_uuid::text,
            'type', _expense_type,
            'amount', _part,
            'date', coalesce(_date, CURRENT_DATE),
            'notes', coalesce(_notes, _description, ''),
            'createdAt', now()
          ),
          updated_at = now()
        WHERE id = p.id;
    END IF;
  END LOOP;

  -- Step 2: general partners (access_all = true) pay their percentage of what REMAINS after step 1.
  -- The store owner keeps the rest (no partner row); general percentages sum to at most 100.
  _remaining_amt := _amt - _cat_total;
  FOR p IN
    SELECT * FROM public.partners
    WHERE user_id = _owner AND COALESCE(access_all, false) = true AND COALESCE(expense_share_percentage, 0) > 0
    ORDER BY id
  LOOP
    _pct := p.expense_share_percentage;
    _part := round(_remaining_amt * (_pct_before + _pct) / 100, 4)
           - round(_remaining_amt * _pct_before / 100, 4);
    _pct_before := _pct_before + _pct;

    IF _part > 0 THEN
      _dist := _dist || jsonb_build_object(
        'partnerId', p.id,
        'partnerName', p.name,
        'amount', _part,
        'percentage', _pct,
        'pool', 'general'
      );

        UPDATE public.partners SET
          current_balance = round(coalesce(current_balance, 0) - _part, 4),
          expense_history = coalesce(expense_history, '[]'::jsonb) || jsonb_build_object(
            'expenseId', _op_uuid::text,
            'type', _expense_type,
            'amount', _part,
            'date', coalesce(_date, CURRENT_DATE),
            'notes', coalesce(_notes, _description, ''),
            'createdAt', now()
          ),
          updated_at = now()
        WHERE id = p.id;
    END IF;
  END LOOP;

  INSERT INTO public.expenses(
    id, user_id, expense_type, amount, description, date, notes, distributions, cashier_id,
    original_currency, original_amount, exchange_rate
  ) VALUES (
    _op_uuid, _owner, _expense_type, _amt, _description, coalesce(_date, CURRENT_DATE), _notes, _dist, _uid,
    _orig_ccy, _orig_amt, _orig_rate
  );

  IF _target_shift_id IS NOT NULL THEN
    INSERT INTO public.shift_transactions(
      shift_id, user_id, type, amount, currency, currency_amount, exchange_rate, reference_id, notes
    ) VALUES (
      _target_shift_id, _owner, 'expense', _amt,
      _orig_ccy, _orig_amt, _orig_rate,
      _op_uuid::text,
      COALESCE(NULLIF(trim(_notes), ''), NULLIF(trim(_description), ''), _expense_type)
    );

    IF FOUND THEN
      UPDATE public.cash_shifts
         SET expected_balance = round(COALESCE(expected_balance, 0) - _amt, 8),
             updated_at = now()
       WHERE id = _target_shift_id
         AND user_id = _owner
         AND closed_at IS NULL;
    END IF;
  END IF;

  _result := jsonb_build_object(
    'success', true,
    'already_processed', false,
    'id', _op_uuid,
    'distributions', _dist,
    'shift_id', _target_shift_id
  );
  INSERT INTO public.accounting_rpc_receipts(user_id, kind, operation_id, request, result)
  VALUES (_owner, 'expense_add', _op_uuid::text, _request, _result);
  RETURN _result;
END;
$function$
;

-- FUNCTION add_product_quantity | normalized md5 7f65878441d7a17a9717a9280d76654e
CREATE OR REPLACE FUNCTION public.add_product_quantity(_product_id uuid, _amount integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _new_qty integer;
  _owner uuid := public.get_owner_id(auth.uid());
BEGIN
  IF auth.uid() IS NULL OR _amount <= 0 THEN
    RAISE EXCEPTION 'Invalid stock adjustment';
  END IF;

  PERFORM set_config('app.stock_movement_type', 'adjustment_in', true);
  PERFORM set_config('app.stock_actor_id', auth.uid()::text, true);
  PERFORM set_config('app.stock_source', 'authenticated_rpc', true);

  UPDATE public.products
  SET quantity = COALESCE(quantity, 0) + _amount
  WHERE id = _product_id AND user_id = _owner
  RETURNING quantity INTO _new_qty;

  IF _new_qty IS NULL THEN RAISE EXCEPTION 'Product not found'; END IF;
  RETURN _new_qty;
END;
$function$
;

-- FUNCTION apply_store_credit_to_debt_atomic | normalized md5 14e673ad5d898129d1676f5cee23aec1
CREATE OR REPLACE FUNCTION public.apply_store_credit_to_debt_atomic(_debt_id uuid, _amount numeric, _operation_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _o uuid := public._credit_actor(false); _d public.debts%ROWTYPE; _bal numeric; _res jsonb; _existing uuid;
BEGIN
  IF COALESCE(_amount,0) <= 0 THEN RAISE EXCEPTION 'المبلغ يجب أن يكون أكبر من الصفر'; END IF;
  IF COALESCE(length(_operation_id),0) < 8 THEN RAISE EXCEPTION 'معرّف العملية غير صالح'; END IF;
  SELECT * INTO _d FROM public.debts WHERE id=_debt_id AND user_id=_o FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'الدين غير موجود'; END IF;
  IF _d.customer_id IS NULL THEN RAISE EXCEPTION 'الدين غير مرتبط بعميل مسجّل'; END IF;
  PERFORM 1 FROM public.customers WHERE id=_d.customer_id FOR UPDATE;
  SELECT id INTO _existing FROM public.customer_credit_ledger WHERE user_id=_o AND operation_id=_operation_id AND entry_type='spend';
  IF _existing IS NOT NULL THEN RETURN jsonb_build_object('success',true,'already_processed',true); END IF;
  SELECT COALESCE(SUM(amount),0) INTO _bal FROM public.customer_credit_ledger WHERE customer_id=_d.customer_id;
  IF round(_amount, 8) > round(_bal, 8) THEN RAISE EXCEPTION 'رصيد العميل (%) أقل من المبلغ المطلوب', round(_bal,2); END IF;
  _res := public.record_debt_payment_atomic(_debt_id, _amount, 'credit:'||_operation_id, NULL, NULL, NULL, NULL, 'transfer');
  INSERT INTO public.customer_credit_ledger(user_id,customer_id,entry_type,amount,debt_id,reason,operation_id,created_by)
  VALUES (_o,_d.customer_id,'spend',-round(_amount,8),_debt_id,'تسديد دين من رصيد العميل',_operation_id,auth.uid());
  PERFORM public.recalc_customer_open_debt(_o,_d.customer_id);
  RETURN _res;
END $function$
;

-- FUNCTION approve_subscription_request_atomic | normalized md5 3ecf84d7cbe3ccb20f90816abec15286
CREATE OR REPLACE FUNCTION public.approve_subscription_request_atomic(p_request_id uuid, p_admin_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN public.boss_activate_license(NULL, NULL, NULL, 'extend', p_request_id, p_admin_note);
END;
$function$
;

-- FUNCTION assert_period_open | normalized md5 3f74ecd7f1912a7754f782a713b7b5ef
CREATE OR REPLACE FUNCTION public.assert_period_open(_owner uuid, _date date, _what text DEFAULT 'العملية'::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.caller_can_query_account(_owner) THEN
    RAISE EXCEPTION 'غير مصرح بالاستعلام عن بيانات حساب آخر' USING ERRCODE = '42501';
  END IF;
  PERFORM public.assert_period_open__impl(_owner, _date, _what);
END;$function$
;

-- FUNCTION assert_period_open__impl | normalized md5 26fc438b1bbee9175f3866bfaa9641ff
CREATE OR REPLACE FUNCTION public.assert_period_open__impl(_owner uuid, _date date, _what text DEFAULT 'العملية'::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r record;
BEGIN
  IF _owner IS NULL OR _date IS NULL THEN
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock_shared(hashtext('close_accounting_period:' || _owner::text));

  SELECT c.period_start, c.period_end INTO r
    FROM public.accounting_period_closures c
   WHERE c.user_id = _owner
     AND _date BETWEEN c.period_start AND c.period_end
   ORDER BY c.period_end DESC
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION '% مرفوضة: التاريخ % ضمن فترة محاسبية مغلقة (من % إلى %)', _what, _date, r.period_start, r.period_end;
  END IF;
END;
$function$
;

-- FUNCTION assign_store_and_profile_phone | normalized md5 79d69a26aba49a8197bbfb93f39dc401
CREATE OR REPLACE FUNCTION public.assign_store_and_profile_phone(_phone text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
DECLARE _caller UUID := auth.uid(); _normalized_phone TEXT; _other_user UUID;
BEGIN
  IF _caller IS NULL THEN RAISE EXCEPTION 'غير مصرح: يجب تسجيل الدخول'; END IF;
  IF _phone IS NULL OR trim(_phone) = '' THEN
    UPDATE public.profiles SET phone = NULL, updated_at = now() WHERE user_id = _caller;
    UPDATE public.stores SET phone = NULL WHERE user_id = _caller;
    RETURN jsonb_build_object('ok', true, 'status', 'cleared');
  END IF;
  _normalized_phone := public.normalize_phone_number(_phone);
  SELECT user_id INTO _other_user FROM public.profiles WHERE phone = _normalized_phone AND user_id <> _caller LIMIT 1;
  IF _other_user IS NOT NULL THEN RAISE EXCEPTION 'الرقم مسجل بالفعل لحساب مستخدم آخر، يتطلب التحقق عبر تيليجرام'; END IF;
  UPDATE public.profiles SET phone = _normalized_phone, updated_at = now() WHERE user_id = _caller;
  UPDATE public.stores SET phone = _normalized_phone WHERE user_id = _caller;
  RETURN jsonb_build_object('ok', true, 'status', 'assigned', 'normalized_phone', _normalized_phone);
END;
$function$
;

-- FUNCTION auto_confirm_user_email | normalized md5 87f0d2ab4e247f34c280c6c5e69f7e33
CREATE OR REPLACE FUNCTION public.auto_confirm_user_email()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
BEGIN
  NEW.email_confirmed_at := COALESCE(NEW.email_confirmed_at, now());
  RETURN NEW;
END;
$function$
;

-- FUNCTION block_direct_invoice_delete | normalized md5 4235bfcef8cfd31e8a822b05a4b97690
CREATE OR REPLACE FUNCTION public.block_direct_invoice_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NOT NULL
     AND COALESCE(current_setting('app.invoice_delete_context', true), '') <> 'allowed' THEN
    RAISE EXCEPTION 'حذف الفواتير مباشرة غير مسموح. استخدم الاسترداد' USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END $function$
;

-- FUNCTION boss_activate_license | normalized md5 8efee91a9681ccbeb508d9dc69cbf678
CREATE OR REPLACE FUNCTION public.boss_activate_license(p_target_user_id uuid DEFAULT NULL::uuid, p_plan_id uuid DEFAULT NULL::uuid, p_custom_days integer DEFAULT NULL::integer, p_mode text DEFAULT 'extend'::text, p_request_id uuid DEFAULT NULL::uuid, p_admin_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller        uuid := auth.uid();
  v_mode          text := lower(trim(COALESCE(p_mode, 'extend')));
  v_req           public.subscription_requests%ROWTYPE;
  v_has_req       boolean := false;
  v_plan          public.subscription_plans%ROWTYPE;
  v_has_plan      boolean := false;
  v_lic           public.app_licenses%ROWTYPE;
  v_has_lic       boolean := false;
  v_target        uuid := p_target_user_id;
  v_requester     uuid;
  v_owner         uuid;
  v_plan_id       uuid := p_plan_id;
  v_days          integer;
  v_max_prod      integer;
  v_max_cashiers  integer;
  v_plan_name     text;
  v_audience      text;
  v_msg           text;
  v_old_expires   timestamptz;
  v_new_expires   timestamptz;
  v_total_days    integer;
BEGIN
  -- أ) الصلاحية: المالك (Boss) حصراً
  IF NOT public.is_boss(v_caller) THEN
    RETURN jsonb_build_object('success', false, 'error', 'غير مصرح: هذا الإجراء مخصص للمدير العام فقط');
  END IF;

  IF v_mode NOT IN ('extend', 'reset') THEN
    RETURN jsonb_build_object('success', false, 'error', 'طريقة التفعيل غير صحيحة (extend أو reset)');
  END IF;

  -- ب) طلب التجديد (اختياري): قفل السجل ومنع التأكيد المكرر
  IF p_request_id IS NOT NULL THEN
    SELECT * INTO v_req FROM public.subscription_requests WHERE id = p_request_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'error', 'طلب الاشتراك غير موجود');
    END IF;
    IF v_req.status IN ('confirmed', 'approved') THEN
      RETURN jsonb_build_object('success', false, 'error', 'هذا الطلب تم تأكيده وتفعيله مسبقاً');
    END IF;
    v_has_req   := true;
    v_requester := v_req.user_id;
    v_target    := COALESCE(v_target, v_req.user_id);
    -- إن لم يحدد المالك باقة أو أياماً، تُستخدم باقة الطلب نفسه
    IF v_plan_id IS NULL AND p_custom_days IS NULL THEN
      v_plan_id := v_req.plan_id;
    END IF;
  END IF;

  IF v_target IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'لم يتم تحديد الحساب المطلوب تفعيله');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = v_target) THEN
    RETURN jsonb_build_object('success', false, 'error', 'الحساب المطلوب تفعيله غير موجود');
  END IF;

  -- ج) الترخيص يُسجَّل على صاحب المتجر: إن كان الحساب كاشيراً نفعّل مالكه
  SELECT ur.owner_id INTO v_owner
  FROM public.user_roles ur
  WHERE ur.user_id = v_target AND ur.role::text = 'cashier' AND ur.owner_id IS NOT NULL
  LIMIT 1;
  IF v_owner IS NOT NULL THEN
    v_target := v_owner;
  END IF;

  -- د) الترخيص الحالي (مع القفل)
  SELECT * INTO v_lic FROM public.app_licenses WHERE user_id = v_target FOR UPDATE;
  v_has_lic := FOUND;
  IF v_has_lic THEN
    v_old_expires := v_lic.expires_at;
  END IF;

  -- هـ) الباقة
  IF v_plan_id IS NOT NULL THEN
    SELECT * INTO v_plan FROM public.subscription_plans WHERE id = v_plan_id;
    v_has_plan := FOUND;
    IF NOT v_has_plan AND NOT v_has_req THEN
      RETURN jsonb_build_object('success', false, 'error', 'الباقة المختارة غير موجودة');
    END IF;
  END IF;

  -- و) المدة والحدود
  IF v_has_plan THEN
    -- باقة جاهزة: تُطبَّق مدتها وحدودها كاملة
    v_days         := COALESCE(p_custom_days, v_plan.duration_days, 180);
    v_max_prod     := COALESCE(v_plan.max_products, 600);
    v_max_cashiers := COALESCE(v_plan.max_cashiers, 1);
    v_plan_name    := v_plan.name;
    v_audience     := COALESCE(v_plan.audience, 'standard');
    v_msg          := COALESCE(NULLIF(trim(v_plan.activation_message), ''),
                               'تم تفعيل باقة ' || v_plan.name || ' لحسابك بنجاح!');
  ELSIF v_has_req AND p_custom_days IS NULL THEN
    -- طلب تجديد بباقة افتراضية غير مخزنة: نعتمد بيانات الطلب نفسه
    v_days         := COALESCE(v_req.plan_days, 180);
    v_audience     := COALESCE(v_req.plan_audience, 'standard');
    v_plan_name    := COALESCE(v_req.plan_name, 'اشتراك');
    v_max_prod     := CASE v_audience
                        WHEN 'institution' THEN 5000
                        WHEN 'pro'         THEN 1000
                        WHEN 'standard'    THEN 600
                        ELSE 100
                      END;
    v_max_cashiers := COALESCE(v_lic.max_cashiers, 1);
    v_msg          := 'تم تفعيل ' || v_plan_name || ' بنجاح! شكراً لاشتراكك مع POS Flow App.';
  ELSE
    -- أيام مخصصة بدون باقة: نحافظ على حدود واسم باقة العميل الحالية ولا نغيّرها
    v_days         := p_custom_days;
    v_max_prod     := COALESCE(v_lic.max_products, 600);
    v_max_cashiers := COALESCE(v_lic.max_cashiers, 1);
    v_audience     := COALESCE(v_lic.plan_audience, v_lic.license_tier, 'standard');
    v_plan_name    := COALESCE(v_lic.plan_name, 'تفعيل مباشر مخصص');
    v_plan_id      := v_lic.plan_id;
    v_msg          := 'تم تفعيل ترخيص حسابك لمدة ' || COALESCE(v_days, 0) || ' يوم بنجاح!';
  END IF;

  IF v_days IS NULL OR v_days < 1 OR v_days > 3650 THEN
    RETURN jsonb_build_object('success', false, 'error', 'عدد الأيام غير صحيح (بين 1 و 3650)');
  END IF;

  -- ز) تاريخ الانتهاء الجديد
  IF v_mode = 'extend' AND v_old_expires IS NOT NULL AND v_old_expires > now() THEN
    v_new_expires := v_old_expires + make_interval(days => v_days);
  ELSE
    v_new_expires := now() + make_interval(days => v_days);
  END IF;
  -- إجمالي مدة الاشتراك من اليوم حتى الانتهاء (يُستخدم لشريط المدة المتبقية في الإعدادات)
  v_total_days := GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_new_expires - now())) / 86400.0)::integer);

  -- ح) كتابة الترخيص (سجل واحد لكل مستخدم)
  IF v_has_lic THEN
    UPDATE public.app_licenses
    SET expires_at     = v_new_expires,
        is_trial       = false,
        is_revoked     = false,
        revoked_at     = NULL,
        revoked_reason = NULL,
        plan_id        = v_plan_id,
        plan_name      = v_plan_name,
        plan_audience  = v_audience,
        license_tier   = v_audience,
        max_products   = v_max_prod,
        max_cashiers   = v_max_cashiers,
        total_days     = v_total_days,
        activated_at   = now(),
        updated_at     = now()
    WHERE id = v_lic.id;
  ELSE
    INSERT INTO public.app_licenses (
      user_id, expires_at, is_trial, is_revoked, plan_id, plan_name,
      plan_audience, license_tier, max_products, max_cashiers, total_days, activated_at
    ) VALUES (
      v_target, v_new_expires, false, false, v_plan_id, v_plan_name,
      v_audience, v_audience, v_max_prod, v_max_cashiers, v_total_days, now()
    );
  END IF;

  -- ط) إغلاق طلب التجديد
  IF v_has_req THEN
    UPDATE public.subscription_requests
    SET status       = 'confirmed',
        confirmed_by = v_caller,
        confirmed_at = now(),
        admin_note   = COALESCE(p_admin_note, admin_note)
    WHERE id = p_request_id;
  END IF;

  -- ي) إشعار العميل (صاحب المتجر، ومقدّم الطلب إن كان حساباً آخر)
  INSERT INTO public.user_notifications (user_id, title, message, type, action_url, is_read, is_archived)
  SELECT u, '🎉 تم تفعيل اشتراكك بنجاح!',
         v_msg || ' (صالح حتى: ' || to_char(v_new_expires, 'YYYY-MM-DD') || ')',
         'license_renewed', '/settings?tab=license', false, false
  FROM (SELECT v_target AS u
        UNION
        SELECT v_requester WHERE v_requester IS NOT NULL) t;

  RETURN jsonb_build_object(
    'success',             true,
    'mode',                v_mode,
    'target_user_id',      v_target,
    'previous_expires_at', v_old_expires,
    'expires_at',          v_new_expires,
    'new_expires_at',      v_new_expires,
    'plan_name',           v_plan_name,
    'duration_days',       v_days,
    'total_days',          v_total_days,
    'max_products',        v_max_prod,
    'max_cashiers',        v_max_cashiers
  );
END;
$function$
;

-- FUNCTION boss_ban_user | normalized md5 ea66c105f1df43ba6324fddfcca4404a
CREATE OR REPLACE FUNCTION public.boss_ban_user(p_target_user_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_lic public.app_licenses%ROWTYPE; v_email text; v_reason text := NULLIF(trim(COALESCE(p_reason, '')), ''); v_device text;
BEGIN
  IF NOT public.is_boss(auth.uid()) THEN RETURN jsonb_build_object('success', false, 'error', 'غير مصرح: هذا الإجراء مخصص للمدير العام فقط'); END IF;
  IF p_target_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_target_user_id) THEN RETURN jsonb_build_object('success', false, 'error', 'الحساب غير موجود'); END IF;
  IF public.is_boss(p_target_user_id) THEN RETURN jsonb_build_object('success', false, 'error', 'لا يمكن حظر حساب مدير عام'); END IF;
  IF EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = p_target_user_id AND role::text = 'cashier') THEN RETURN jsonb_build_object('success', false, 'error', 'الحظر يُطبَّق على حساب المالك فقط'); END IF;
  SELECT email INTO v_email FROM auth.users WHERE id = p_target_user_id;
  SELECT * INTO v_lic FROM public.app_licenses WHERE user_id = p_target_user_id FOR UPDATE;
  v_device := NULLIF(trim(COALESCE(v_lic.device_id, '')), '');
  INSERT INTO public.banned_devices (device_id, banned_user_id, banned_email, reason, banned_by, revoked_license)
  VALUES ('user:' || p_target_user_id::text, p_target_user_id, v_email, v_reason, auth.uid(), true)
  ON CONFLICT (device_id) DO UPDATE SET reason = EXCLUDED.reason, banned_at = now(), revoked_license = true;
  IF v_device IS NOT NULL THEN
    INSERT INTO public.banned_devices (device_id, banned_user_id, banned_email, reason, banned_by, revoked_license)
    VALUES (v_device, p_target_user_id, v_email, v_reason, auth.uid(), true)
    ON CONFLICT (device_id) DO UPDATE SET banned_user_id = EXCLUDED.banned_user_id, banned_email = EXCLUDED.banned_email, reason = EXCLUDED.reason, banned_by = EXCLUDED.banned_by, banned_at = now(), revoked_license = true;
  END IF;
  IF v_lic.user_id IS NOT NULL THEN
    UPDATE public.app_licenses SET is_revoked = true, revoked_at = now(), revoked_reason = 'حظر: ' || COALESCE(v_reason, 'بقرار الإدارة'), updated_at = now() WHERE user_id = p_target_user_id;
  END IF;
  RETURN jsonb_build_object('success', true, 'device_banned', v_device IS NOT NULL, 'device_id', v_device,
    'message', CASE WHEN v_device IS NULL THEN 'أُوقف الترخيص، لكن لا يوجد رقم جهاز مرتبط بهذا الحساب ليُحظر' ELSE 'تم حظر الجهاز وإيقاف الترخيص' END);
END;
$function$
;

-- FUNCTION boss_change_user_password | normalized md5 d43f379afea897697c89287d44a95a9a
CREATE OR REPLACE FUNCTION public.boss_change_user_password(_target_user_id uuid, _new_password text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth', 'extensions'
AS $function$
BEGIN
  IF NOT public.is_boss(auth.uid()) THEN RAISE EXCEPTION 'غير مصرح: هذه العملية مخصصة لحساب المطور / Boss فقط'; END IF;
  IF _new_password IS NULL OR length(trim(_new_password)) < 6 THEN RAISE EXCEPTION 'كلمة المرور يجب أن لا تقل عن 6 أحرف'; END IF;
  UPDATE auth.users SET encrypted_password = extensions.crypt(_new_password, extensions.gen_salt('bf')), updated_at = now() WHERE id = _target_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'المستخدم غير موجود'; END IF;
  RETURN jsonb_build_object('success', true, 'message', 'تم تحديث كلمة المرور بنجاح');
END;
$function$
;

-- FUNCTION boss_direct_activate_by_plan | normalized md5 517b20e21873e62e5f4c863f2bf74fdf
CREATE OR REPLACE FUNCTION public.boss_direct_activate_by_plan(p_target_user_id uuid, p_plan_id uuid DEFAULT NULL::uuid, p_custom_days integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN public.boss_activate_license(
    p_target_user_id, p_plan_id,
    CASE WHEN p_plan_id IS NULL THEN COALESCE(p_custom_days, 90) ELSE NULL END,
    'extend', NULL, NULL
  );
END;
$function$
;

-- FUNCTION boss_expired_trials | normalized md5 cdd0ed4e9685555bab347f4b54b36045
CREATE OR REPLACE FUNCTION public.boss_expired_trials(_min_days integer DEFAULT 0)
 RETURNS TABLE(user_id uuid, email text, full_name text, phone text, store_name text, trial_expired_at timestamp with time zone, days_since_expired integer, products_count bigint, invoices_count bigint, customers_count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_boss(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    t.user_id,
    u.email::text,
    p.full_name,
    p.phone,
    (SELECT s.name FROM public.stores s WHERE s.user_id = t.user_id ORDER BY s.created_at LIMIT 1),
    t.expires_at,
    GREATEST(0, floor(extract(epoch FROM (now() - t.expires_at)) / 86400))::integer,
    (SELECT count(*) FROM public.products x WHERE x.user_id = t.user_id),
    (SELECT count(*) FROM public.invoices x WHERE x.user_id = t.user_id),
    (SELECT count(*) FROM public.customers x WHERE x.user_id = t.user_id)
  FROM (
    SELECT DISTINCT ON (al.user_id) al.user_id, al.expires_at
    FROM public.app_licenses al
    WHERE COALESCE(al.is_trial, false) = true
      AND COALESCE(al.is_revoked, false) = false
      AND al.expires_at < now() - make_interval(days => GREATEST(_min_days, 0))
    ORDER BY al.user_id, al.expires_at DESC
  ) t
  JOIN auth.users u ON u.id = t.user_id
  LEFT JOIN public.profiles p ON p.user_id = t.user_id
  JOIN public.user_roles r ON r.user_id = t.user_id AND r.role = 'admin'
  WHERE NOT EXISTS (
    SELECT 1 FROM public.app_licenses a2
    WHERE a2.user_id = t.user_id
      AND COALESCE(a2.is_trial, false) = false
      AND COALESCE(a2.is_revoked, false) = false
      AND a2.expires_at > now()
  )
  ORDER BY t.expires_at ASC;
END;
$function$
;

-- FUNCTION boss_hard_delete_user | normalized md5 01f89f476d0f8404b4664a07ed16653d
CREATE OR REPLACE FUNCTION public.boss_hard_delete_user(_target_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
BEGIN
  IF NOT public.is_boss(auth.uid()) THEN RAISE EXCEPTION 'غير مصرح: العملية مخصصة لحساب Boss فقط'; END IF;
  IF _target_user_id IS NULL THEN RAISE EXCEPTION 'معرف المستخدم غير صالح'; END IF;
  DELETE FROM public.user_roles WHERE user_id = _target_user_id OR owner_id = _target_user_id;
  DELETE FROM public.profiles WHERE user_id = _target_user_id;
  DELETE FROM public.app_licenses WHERE user_id = _target_user_id;
  DELETE FROM public.stores WHERE user_id = _target_user_id;
  DELETE FROM auth.users WHERE id = _target_user_id;
  RETURN jsonb_build_object('success', true, 'message', 'تم حذف الحساب بالكامل من النظام ومنعه من الدخول');
END;
$function$
;

-- FUNCTION boss_reactivate_user_license | normalized md5 792d8cd791edd661c7c6c53365a98395
CREATE OR REPLACE FUNCTION public.boss_reactivate_user_license(_target_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.is_boss(auth.uid()) THEN RAISE EXCEPTION 'غير مصرح: مخصص لحساب Boss فقط'; END IF;
  UPDATE public.app_licenses SET is_revoked = false, revoked_at = NULL, updated_at = now() WHERE user_id = _target_user_id;
  UPDATE public.user_roles SET is_active = true WHERE user_id = _target_user_id OR owner_id = _target_user_id;
  RETURN jsonb_build_object('success', true, 'message', 'تمت إعادة تفعيل الترخيص وتنشيط الحساب بنجاح');
END;
$function$
;

-- FUNCTION boss_revoke_user_license | normalized md5 bbdcf7edcdbe9b95bfa2fd9cb9df5e83
CREATE OR REPLACE FUNCTION public.boss_revoke_user_license(_target_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.is_boss(auth.uid()) THEN RAISE EXCEPTION 'غير مصرح: مخصص لحساب Boss فقط'; END IF;
  UPDATE public.app_licenses SET is_revoked = true, revoked_at = now(), updated_at = now() WHERE user_id = _target_user_id;
  UPDATE public.user_roles SET is_active = false WHERE user_id = _target_user_id OR owner_id = _target_user_id;
  RETURN jsonb_build_object('success', true, 'message', 'تم إلغاء الترخيص وتعطيل الحساب فورياً');
END;
$function$
;

-- FUNCTION boss_set_single_device | normalized md5 2bc41602aa34311b6273815ebd6d05ef
CREATE OR REPLACE FUNCTION public.boss_set_single_device(p_target_email text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
DECLARE v_target_user_id UUID;
BEGIN
  IF NOT public.is_boss(auth.uid()) THEN RAISE EXCEPTION 'غير مصرح: هذه العملية لحساب Boss فقط'; END IF;
  SELECT id INTO v_target_user_id FROM auth.users WHERE email = trim(p_target_email) LIMIT 1;
  IF v_target_user_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'المستخدم غير موجود'); END IF;
  UPDATE public.app_licenses SET allow_multi_device = false, device_id = NULL, updated_at = now() WHERE user_id = v_target_user_id;
  RETURN jsonb_build_object('success', true, 'message', 'تم إلغاء التعدد وجاهز للربط على أول جهاز فقط');
END;
$function$
;

-- FUNCTION boss_unban_user | normalized md5 5f638414808b04c4ecf25a08ee2c3c96
CREATE OR REPLACE FUNCTION public.boss_unban_user(p_target_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_deleted integer;
BEGIN
  IF NOT public.is_boss(auth.uid()) THEN RETURN jsonb_build_object('success', false, 'error', 'غير مصرح: هذا الإجراء مخصص للمدير العام فقط'); END IF;
  DELETE FROM public.banned_devices WHERE banned_user_id = p_target_user_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  UPDATE public.app_licenses SET is_revoked = false, revoked_at = NULL, revoked_reason = NULL, updated_at = now()
  WHERE user_id = p_target_user_id AND is_revoked = true AND revoked_reason LIKE 'حظر:%';
  RETURN jsonb_build_object('success', true, 'devices_unbanned', v_deleted);
END;
$function$
;

-- FUNCTION boss_update_license | normalized md5 1079d057f4fae3e3a7a91221788a06ff
CREATE OR REPLACE FUNCTION public.boss_update_license(p_target_user_id uuid, p_add_days integer DEFAULT 0, p_max_products integer DEFAULT NULL::integer, p_max_cashiers integer DEFAULT NULL::integer, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_lic     public.app_licenses%ROWTYPE;
  v_add     integer := COALESCE(p_add_days, 0);
  v_expires timestamptz;
BEGIN
  IF NOT public.is_boss(auth.uid()) THEN
    RETURN jsonb_build_object('success', false, 'error', 'غير مصرح: هذا الإجراء مخصص للمدير العام فقط');
  END IF;
  IF v_add < -3650 OR v_add > 3650 THEN
    RETURN jsonb_build_object('success', false, 'error', 'عدد الأيام خارج المدى المسموح');
  END IF;
  IF p_max_products IS NOT NULL AND (p_max_products < 1 OR p_max_products > 1000000) THEN
    RETURN jsonb_build_object('success', false, 'error', 'حد المنتجات غير صحيح');
  END IF;
  IF p_max_cashiers IS NOT NULL AND (p_max_cashiers < 1 OR p_max_cashiers > 1000) THEN
    RETURN jsonb_build_object('success', false, 'error', 'حد الكاشيرات غير صحيح');
  END IF;

  SELECT * INTO v_lic FROM public.app_licenses WHERE user_id = p_target_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'لا يوجد ترخيص لهذا الحساب. فعّله أولاً ثم عدّل');
  END IF;

  v_expires := v_lic.expires_at;
  IF v_add > 0 THEN
    v_expires := GREATEST(v_lic.expires_at, now()) + make_interval(days => v_add);
  ELSIF v_add < 0 THEN
    v_expires := v_lic.expires_at + make_interval(days => v_add);
  END IF;

  UPDATE public.app_licenses
     SET expires_at   = v_expires,
         total_days   = CASE WHEN v_add > 0 THEN COALESCE(total_days, 0) + v_add ELSE total_days END,
         max_products = COALESCE(p_max_products, max_products),
         max_cashiers = COALESCE(p_max_cashiers, max_cashiers),
         updated_at   = now()
   WHERE id = v_lic.id;

  RETURN jsonb_build_object(
    'success', true,
    'old_expires_at', v_lic.expires_at,
    'new_expires_at', v_expires,
    'max_products', COALESCE(p_max_products, v_lic.max_products),
    'max_cashiers', COALESCE(p_max_cashiers, v_lic.max_cashiers)
  );
END;
$function$
;

-- FUNCTION caller_can_query_account | normalized md5 f4a50cc5791c6c316b1ffe5b8d0d3f5e
CREATE OR REPLACE FUNCTION public.caller_can_query_account(_target uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _caller uuid := auth.uid();
BEGIN
  -- بدون مستخدم = الخادم (service_role) أو trigger داخلي: مسموح كما كان
  IF _caller IS NULL THEN
    RETURN true;
  END IF;
  IF _target IS NULL THEN
    RETURN false;
  END IF;
  RETURN _caller = _target
      OR public.get_owner_id(_caller) = _target
      OR public.get_owner_id(_caller) = public.get_owner_id(_target)
      OR public.is_boss(_caller);
END;
$function$
;

-- FUNCTION can_add_cashier | normalized md5 ba1a1973aea36ed0128d6b1d638ada21
CREATE OR REPLACE FUNCTION public.can_add_cashier(_owner_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.caller_can_query_account(_owner_id) THEN
    RETURN false;
  END IF;
  RETURN public.can_add_cashier__impl(_owner_id);
END;$function$
;

-- FUNCTION can_add_cashier__impl | normalized md5 947379d12b14b3f98cc4c43fd72f0b3e
CREATE OR REPLACE FUNCTION public.can_add_cashier__impl(_owner_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _max_cashiers integer; _current_cashiers integer; _is_revoked boolean; _expires_at timestamptz;
BEGIN
  SELECT max_cashiers, is_revoked, expires_at INTO _max_cashiers, _is_revoked, _expires_at
  FROM public.app_licenses WHERE user_id = _owner_id ORDER BY created_at DESC LIMIT 1;
  IF _max_cashiers IS NULL OR _is_revoked IS TRUE OR (_expires_at IS NOT NULL AND _expires_at < now()) THEN RETURN false; END IF;
  SELECT count(*) INTO _current_cashiers FROM public.user_roles WHERE owner_id = _owner_id AND role = 'cashier';
  RETURN _current_cashiers < _max_cashiers;
END;
$function$
;

-- FUNCTION can_refund_invoices | normalized md5 e4599d12a6ddda73d9a01810b90326de
CREATE OR REPLACE FUNCTION public.can_refund_invoices(_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.caller_can_query_account(_user_id) THEN
    RETURN false;
  END IF;
  RETURN public.can_refund_invoices__impl(_user_id);
END;$function$
;

-- FUNCTION can_refund_invoices__impl | normalized md5 658a83c674066a599547157f970c14cc
CREATE OR REPLACE FUNCTION public.can_refund_invoices__impl(_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    _user_id IS NOT NULL
    AND (
      public.get_owner_id(_user_id) = _user_id      -- مالك المتجر
      OR public.is_boss(_user_id)
      OR EXISTS (
        SELECT 1 FROM public.user_roles ur
        WHERE ur.user_id = _user_id AND ur.can_refund = true
      )
    );
$function$
;

-- FUNCTION cancel_debt_atomic | normalized md5 343a9fc6d46fdbd1fef43437b8652bba
CREATE OR REPLACE FUNCTION public.cancel_debt_atomic(_debt_id uuid, _reason text DEFAULT 'إلغاء الدين'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_owner uuid := public.get_owner_id(auth.uid());
  v_debt public.debts%ROWTYPE;
  v_resolved_customer_id uuid;
BEGIN
  IF v_caller IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'غير مصرح';
  END IF;

  IF NOT public.is_store_owner(v_caller) THEN
    RAISE EXCEPTION 'إلغاء الدين مخصص لمالك المتجر فقط' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_debt FROM public.debts WHERE id = _debt_id FOR UPDATE;
  IF NOT FOUND OR v_debt.user_id <> v_owner THEN
    RAISE EXCEPTION 'الدين غير موجود';
  END IF;

  IF v_debt.status IN ('cancelled', 'written_off') THEN
    RETURN jsonb_build_object('success', true, 'already_closed', true, 'debt_id', _debt_id);
  END IF;

  IF v_debt.status = 'fully_paid' OR COALESCE(v_debt.total_paid, 0) > 0 THEN
    RAISE EXCEPTION 'لا يمكن إلغاء دين تم تسديده كلياً أو جزئياً';
  END IF;

  PERFORM public.assert_period_open(v_owner, CURRENT_DATE, 'إلغاء دين');

  IF v_debt.invoice_id IS NOT NULL AND NOT COALESCE(v_debt.is_cash_debt, false)
     AND EXISTS (SELECT 1 FROM public.invoices i
                  WHERE i.user_id = v_owner
                    AND (i.invoice_number = v_debt.invoice_id OR i.id::text = v_debt.invoice_id)
                    AND COALESCE(i.status, '') NOT IN ('refunded', 'cancelled')) THEN
    RAISE EXCEPTION 'هذا الدين مرتبط بالفاتورة %: استخدم «تسديد» إذا دفع العميل، أو «استرداد الفاتورة» إذا أُلغي البيع، أو «شطب الدين» إذا تعذر التحصيل', v_debt.invoice_id;
  END IF;

  UPDATE public.debts
     SET status = 'cancelled',
         notes = concat_ws(E'\n', notes, '[ملغى] ' || COALESCE(_reason, 'إلغاء الدين')),
         updated_at = now()
   WHERE id = _debt_id;

  v_resolved_customer_id := v_debt.customer_id;
  IF v_resolved_customer_id IS NULL THEN
    IF NULLIF(trim(COALESCE(v_debt.customer_phone, '')), '') IS NOT NULL THEN
      SELECT CASE WHEN count(*) = 1 THEN (array_agg(id))[1] ELSE NULL END
        INTO v_resolved_customer_id
        FROM public.customers
       WHERE user_id = v_owner
         AND trim(COALESCE(phone, '')) = trim(v_debt.customer_phone);
    END IF;
    IF v_resolved_customer_id IS NULL AND NULLIF(trim(COALESCE(v_debt.customer_name, '')), '') IS NOT NULL THEN
      SELECT id INTO v_resolved_customer_id
        FROM public.customers
       WHERE user_id = v_owner
         AND name = v_debt.customer_name
       ORDER BY created_at ASC
       LIMIT 1;
    END IF;
  END IF;

  IF v_resolved_customer_id IS NOT NULL THEN
    PERFORM public.recalc_customer_open_debt(v_owner, v_resolved_customer_id);
  END IF;

  RETURN jsonb_build_object('success', true, 'debt_id', _debt_id, 'cancelled_amount', COALESCE(v_debt.remaining_debt, 0));
END;
$function$
;

-- FUNCTION cancel_purchase_invoice_atomic | normalized md5 979df12c1eaf1c2e30a5d70f0e1a8a13
CREATE OR REPLACE FUNCTION public.cancel_purchase_invoice_atomic(_invoice_id uuid, _reason text DEFAULT 'إلغاء فاتورة شراء'::text)
 RETURNS boolean
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.cancel_purchase_invoice_atomic(_invoice_id, _reason, NULL::uuid);
$function$
;

-- FUNCTION cancel_purchase_invoice_atomic | normalized md5 357fdf9f6925223b3b4adb6f684d8e70
CREATE OR REPLACE FUNCTION public.cancel_purchase_invoice_atomic(_invoice_id uuid, _reason text, _settlement_shift_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _caller uuid := auth.uid();
  _owner uuid := public.get_owner_id(_caller);
  _orig_inv record;
  _old_item record;
  _no_inventory boolean := false;
  _cur_stock numeric;
  _cur_cost numeric;
  _new_stock numeric;
  _new_cost numeric;
  _calc_cost numeric;
  _rem_val numeric;
  v_variance numeric := 0;
  _has_subsequent_sale boolean := false;
  _has_newer_purchase boolean := false;
  _original_payment public.shift_transactions%ROWTYPE;
  _target_shift_id uuid;
BEGIN
  IF _caller IS NULL OR _owner IS NULL THEN
    RAISE EXCEPTION 'غير مصرح';
  END IF;

  IF NOT public.is_store_owner(_caller) THEN
    RAISE EXCEPTION 'إلغاء فاتورة الشراء مخصص لمالك المتجر فقط' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _orig_inv
    FROM public.purchase_invoices
   WHERE id = _invoice_id AND user_id = _owner
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'فاتورة المشتريات غير موجودة';
  END IF;

  IF _orig_inv.status = 'cancelled' OR _orig_inv.payment_status = 'cancelled' THEN
    RETURN true;
  END IF;

  PERFORM public.assert_period_open(_owner, _orig_inv.invoice_date, 'إلغاء فاتورة الشراء');

  -- Draft / reconciled invoices never modified stock, WAC, serials, or supplier ledger
  IF COALESCE(_orig_inv.status, 'draft') IN ('draft', 'reconciled') THEN
    UPDATE public.purchase_invoices
       SET status = 'cancelled',
           payment_status = 'cancelled',
           notes = concat_ws(E'\n', notes, '[ملغاة] ' || COALESCE(_reason, 'إلغاء الفاتورة')),
           updated_at = now()
     WHERE id = _invoice_id;
    RETURN true;
  END IF;

  PERFORM public.assert_period_open(_owner, CURRENT_DATE, 'ترحيل إلغاء فاتورة شراء');
  IF EXISTS (SELECT 1 FROM public.purchase_returns WHERE invoice_id = _invoice_id AND user_id = _owner) THEN
    RAISE EXCEPTION 'لا يمكن إلغاء فاتورة لها مرتجعات';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.product_serials
     WHERE purchase_invoice_id = _invoice_id
       AND user_id = _owner
       AND status <> 'in_stock'
  ) THEN
    RAISE EXCEPTION 'لا يمكن إلغاء الفاتورة: بعض أرقامها التسلسلية بيعت أو أُخرجت';
  END IF;

  SELECT COALESCE(s.store_type, 'general') IN ('bakery', 'repair')
    INTO _no_inventory
    FROM public.stores s
   WHERE s.user_id = _owner
   LIMIT 1;
  _no_inventory := COALESCE(_no_inventory, false);

  FOR _old_item IN
    SELECT * FROM public.purchase_invoice_items
     WHERE invoice_id = _invoice_id
     ORDER BY created_at DESC, id DESC
  LOOP
    IF _old_item.product_id IS NOT NULL THEN
      SELECT quantity, cost_price
        INTO _cur_stock, _cur_cost
        FROM public.products
       WHERE id = _old_item.product_id AND user_id = _owner
         FOR UPDATE;

      IF FOUND THEN
        IF _no_inventory THEN
          SELECT EXISTS (
            SELECT 1
              FROM public.purchase_invoice_items pii
              JOIN public.purchase_invoices pi ON pi.id = pii.invoice_id
             WHERE pii.product_id = _old_item.product_id
               AND pi.user_id = _owner
               AND pi.id <> _invoice_id
               AND pi.replaced_by IS NULL
               AND COALESCE(pi.status, '') IN ('finalized', 'completed')
               AND COALESCE(pi.payment_status, '') <> 'cancelled'
               AND COALESCE(pi.finalized_at, pi.created_at) > COALESCE(_orig_inv.finalized_at, _orig_inv.created_at)
          ) INTO _has_newer_purchase;

          IF NOT _has_newer_purchase AND _old_item.cost_price_before IS NOT NULL THEN
            UPDATE public.products
               SET cost_price = _old_item.cost_price_before,
                   updated_at = now()
             WHERE id = _old_item.product_id;
          END IF;
        ELSE
          IF COALESCE(_cur_stock, 0) < COALESCE(_old_item.quantity, 0) THEN
            RAISE EXCEPTION 'لا يمكن إلغاء الفاتورة: جزء من كمية "%" بيع أو أُخرج من المخزون', _old_item.product_name;
          END IF;

          _new_stock := round(COALESCE(_cur_stock, 0) - COALESCE(_old_item.quantity, 0), 3);
          _rem_val := (COALESCE(_cur_stock, 0) * COALESCE(_cur_cost, 0))
                    - (COALESCE(_old_item.quantity, 0) * COALESCE(_old_item.cost_price, 0));

          SELECT EXISTS (
            SELECT 1
              FROM public.invoice_items ii
              JOIN public.invoices inv ON inv.id = ii.invoice_id
             WHERE ii.product_id = _old_item.product_id
               AND inv.user_id = _owner
               AND COALESCE(inv.status, '') NOT IN ('cancelled', 'refunded', 'void', 'voided')
               AND inv.created_at > COALESCE(_orig_inv.finalized_at, _orig_inv.created_at)
          ) INTO _has_subsequent_sale;

          IF _has_subsequent_sale THEN
            -- Perpetual moving average (IAS 2): keep current WAC when intervening sales expensed COGS
            _new_cost := COALESCE(_cur_cost, 0);
          ELSIF _new_stock > 0 AND _rem_val > 0 THEN
            _calc_cost := round(_rem_val / _new_stock, 8);
            IF _calc_cost > GREATEST(COALESCE(_cur_cost, 0), COALESCE(_old_item.cost_price_before, COALESCE(_cur_cost, 0)))
               OR _calc_cost < LEAST(COALESCE(_cur_cost, 0), COALESCE(_old_item.cost_price_before, COALESCE(_cur_cost, 0))) THEN
              _new_cost := COALESCE(_cur_cost, 0);
            ELSE
              _new_cost := _calc_cost;
            END IF;
          ELSIF _new_stock > 0 AND _rem_val <= 0 THEN
            _new_cost := COALESCE(_cur_cost, 0);
          ELSIF _old_item.cost_price_before IS NOT NULL THEN
            _new_cost := _old_item.cost_price_before;
          ELSE
            _new_cost := COALESCE(_cur_cost, 0);
          END IF;

          v_variance := round((_new_stock * _new_cost) - _rem_val, 4);
          IF v_variance <> 0 THEN
            INSERT INTO public.inventory_valuation_adjustments(
              user_id, source_type, source_id, product_id, variance_usd, notes
            ) VALUES (
              _owner,
              'purchase_cancel',
              _invoice_id,
              _old_item.product_id,
              v_variance,
              'فرق تقييم مخزون عند إلغاء فاتورة الشراء ' || COALESCE(_orig_inv.invoice_number, '')
            );
          END IF;

          PERFORM set_config('app.stock_movement_type', 'purchase_reversal', true);
          PERFORM set_config('app.stock_source', 'cancel_purchase_invoice', true);
          UPDATE public.products
             SET quantity = _new_stock,
                 cost_price = _new_cost,
                 updated_at = now()
           WHERE id = _old_item.product_id;
        END IF;
      END IF;
    END IF;
  END LOOP;

  INSERT INTO public.supplier_ledger_entries(user_id, supplier_id, entry_type, amount, reference_type, reference_id, note, created_by)
  SELECT user_id, supplier_id, 'adjustment', -amount, 'purchase_cancel', reference_id, 'عكس بسبب إلغاء الفاتورة', _caller
    FROM public.supplier_ledger_entries
   WHERE user_id = _owner
     AND reference_type = 'purchase_invoice'
     AND reference_id = _invoice_id::text
     AND entry_type IN ('purchase', 'payment');

  SELECT * INTO _original_payment
    FROM public._purchase_drawer_payment_for_cancellation(_owner, _invoice_id, _orig_inv.amount_paid);
  IF FOUND THEN
    _target_shift_id := COALESCE(_settlement_shift_id, _original_payment.shift_id);
    IF _target_shift_id IS DISTINCT FROM _original_payment.shift_id
       AND (NULLIF(trim(_reason), '') IS NULL OR trim(_reason) = 'إلغاء فاتورة شراء') THEN
      RAISE EXCEPTION 'يجب تسجيل سبب التسوية في وردية أخرى';
    END IF;

    PERFORM 1 FROM public.cash_shifts
     WHERE id = _target_shift_id AND user_id = _owner AND closed_at IS NULL
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'حدد وردية تسوية مفتوحة بعد إغلاق وردية دفعة المورد الأصلية';
    END IF;

    PERFORM public._supplier_drawer_tx(
      _owner, _target_shift_id, 'supplier_refund', _original_payment.amount, _original_payment.currency,
      _original_payment.currency_amount, _original_payment.exchange_rate, 'purchase_cancel:' || _invoice_id::text,
      concat_ws(' | ', 'إلغاء فاتورة شراء ' || COALESCE(_orig_inv.invoice_number, ''),
        'حركة المورد الأصلية ' || _original_payment.id::text, 'الوردية الأصلية ' || _original_payment.shift_id::text,
        NULLIF(trim(_reason), ''))
    );
  END IF;

  UPDATE public.product_serials
     SET status = 'returned_to_supplier', updated_at = now()
   WHERE purchase_invoice_id = _invoice_id AND user_id = _owner AND status = 'in_stock';

  UPDATE public.purchase_invoices
     SET status = 'cancelled',
         payment_status = 'cancelled',
         notes = concat_ws(E'\n', notes, '[ملغاة] ' || COALESCE(_reason, 'إلغاء الفاتورة')),
         updated_at = now()
   WHERE id = _invoice_id;

  RETURN true;
END;
$function$
;

-- FUNCTION check_and_bind_device | normalized md5 10093bcb108d9dd95ff883987164fc12
CREATE OR REPLACE FUNCTION public.check_and_bind_device(p_device_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
DECLARE v_user_id UUID := auth.uid(); v_user_role TEXT; v_owner_id UUID; v_license RECORD; v_clean_device_id TEXT;
BEGIN
  IF v_user_id IS NULL THEN RETURN jsonb_build_object('success', false, 'blocked', true, 'error', 'المستخدم غير مسجل'); END IF;
  SELECT role INTO v_user_role FROM public.user_roles WHERE user_id = v_user_id LIMIT 1;
  IF v_user_role = 'boss' THEN RETURN jsonb_build_object('success', true, 'blocked', false, 'is_boss', true); END IF;
  v_owner_id := public.get_owner_id(v_user_id);
  IF v_owner_id IS NULL THEN v_owner_id := v_user_id; END IF;
  SELECT id, device_id, allow_multi_device, is_revoked, expires_at INTO v_license
  FROM public.app_licenses WHERE user_id = v_owner_id ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'blocked', true, 'error', 'لا يوجد ترخيص فعال لهذا الحساب'); END IF;
  IF v_license.is_revoked = true THEN RETURN jsonb_build_object('success', false, 'blocked', true, 'error', 'الترخيص موقوف أو ملغى'); END IF;
  IF v_license.allow_multi_device = true THEN RETURN jsonb_build_object('success', true, 'blocked', false, 'allow_multi_device', true); END IF;
  v_clean_device_id := trim(COALESCE(p_device_id, ''));
  IF v_clean_device_id = '' THEN RETURN jsonb_build_object('success', false, 'blocked', true, 'error', 'معرّف الجهاز مفقود'); END IF;
  IF v_license.device_id IS NULL OR trim(v_license.device_id) = '' THEN
    UPDATE public.app_licenses SET device_id = v_clean_device_id, updated_at = now() WHERE id = v_license.id;
    RETURN jsonb_build_object('success', true, 'blocked', false, 'bound_now', true, 'registered_device_id', v_clean_device_id);
  END IF;
  IF trim(v_license.device_id) = v_clean_device_id THEN
    RETURN jsonb_build_object('success', true, 'blocked', false, 'matched', true);
  ELSE
    RETURN jsonb_build_object('success', false, 'blocked', true, 'error', 'هذا الحساب مرتبط بجهاز آخر، ولا يمكن استخدامه على هذا الجهاز', 'registered_device_id', v_license.device_id);
  END IF;
END;
$function$
;

-- FUNCTION check_boss_push_secret | normalized md5 52655527a581e2bee9b6ac8067b13f0e
CREATE OR REPLACE FUNCTION public.check_boss_push_secret(p_secret text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'vault'
AS $function$
  SELECT p_secret IS NOT NULL
     AND p_secret = (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'boss_push_secret' LIMIT 1);
$function$
;

-- FUNCTION check_phone_email_availability | normalized md5 864225da10b5e3e32e0622faaca56441
CREATE OR REPLACE FUNCTION public.check_phone_email_availability(_phone text, _email text, _exclude_user_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
DECLARE
    _normalized_phone TEXT;
    _normalized_email TEXT;
    _phone_exists BOOLEAN := FALSE;
    _email_exists BOOLEAN := FALSE;
    _conflicting_user_name TEXT;
BEGIN
    _normalized_phone := public.normalize_phone_number(_phone);
    _normalized_email := lower(trim(COALESCE(_email, '')));

    -- 1. فحص البريد الإلكتروني في auth.users
    IF _normalized_email <> '' THEN
        SELECT EXISTS (
            SELECT 1 FROM auth.users
            WHERE lower(email) = _normalized_email
              AND (_exclude_user_id IS NULL OR id <> _exclude_user_id)
        ) INTO _email_exists;

        IF _email_exists THEN
            RETURN jsonb_build_object(
                'available', false,
                'field', 'email',
                'error', 'البريد الإلكتروني مسجل بالفعل لحساب آخر ولا يمكن استخدامه'
            );
        END IF;
    END IF;

    -- 2. فحص رقم الهاتف في جدول profiles
    IF _normalized_phone IS NOT NULL THEN
        SELECT full_name INTO _conflicting_user_name
        FROM public.profiles
        WHERE phone = _normalized_phone
          AND (_exclude_user_id IS NULL OR user_id <> _exclude_user_id)
        LIMIT 1;

        IF _conflicting_user_name IS NOT NULL THEN
            RETURN jsonb_build_object(
                'available', false,
                'field', 'phone',
                'error', 'رقم الهاتف (' || _normalized_phone || ') مسجل بالفعل لحساب مستخدم آخر ولا يمكن استخدامه'
            );
        END IF;
    END IF;

    -- في حال كان كلاهما متاحاً
    RETURN jsonb_build_object(
        'available', true,
        'normalized_phone', _normalized_phone,
        'normalized_email', _normalized_email
    );
END;
$function$
;

-- FUNCTION check_product_addition_limit | normalized md5 1b69045eb103b0f722fc7aa202d27eae
CREATE OR REPLACE FUNCTION public.check_product_addition_limit(p_owner_id uuid, p_has_image boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.caller_can_query_account(p_owner_id) THEN
    RAISE EXCEPTION 'غير مصرح بالاستعلام عن بيانات حساب آخر' USING ERRCODE = '42501';
  END IF;
  RETURN public.check_product_addition_limit__impl(p_owner_id, p_has_image);
END;$function$
;

-- FUNCTION check_product_addition_limit__impl | normalized md5 8545cb3a6f73c8040b90f97078735769
CREATE OR REPLACE FUNCTION public.check_product_addition_limit__impl(p_owner_id uuid, p_has_image boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_license record; v_count integer; v_max_allowed integer := 100; v_tier text := 'trial';
BEGIN
  SELECT * INTO v_license FROM public.app_licenses WHERE user_id = p_owner_id;
  IF v_license.id IS NOT NULL THEN
    v_tier := COALESCE(v_license.license_tier, CASE WHEN v_license.is_trial THEN 'trial' ELSE 'standard' END);
    v_max_allowed := COALESCE(v_license.max_products, CASE WHEN v_tier = 'institution' THEN 5000 WHEN v_tier = 'pro' THEN 1000 WHEN v_tier = 'standard' THEN 600 ELSE 100 END);
  END IF;
  SELECT count(*) INTO v_count FROM public.products WHERE user_id = p_owner_id;
  IF v_count >= v_max_allowed THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'product_limit_reached', 'current_count', v_count, 'max_allowed', v_max_allowed, 'tier', v_tier,
      'message', 'لقد بلغت الحد الأقصى للمنتجات المسموحة في باقتك الحالية (' || v_max_allowed || ' منتج). يُرجى ترقية الاشتراك لإضافة المزيد.');
  END IF;
  IF v_tier = 'pro' AND v_count >= 600 AND p_has_image THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'image_not_allowed_above_limit', 'current_count', v_count, 'max_allowed', v_max_allowed, 'tier', v_tier,
      'message', 'في الباقة الاحترافية (Pro)، يُسمح بإضافة المنتجات بعد 600 منتج بدون صور فقط (حتى 1000 منتج).');
  END IF;
  RETURN jsonb_build_object('allowed', true, 'current_count', v_count, 'max_allowed', v_max_allowed, 'tier', v_tier);
END;
$function$
;

-- FUNCTION check_store_phone_status | normalized md5 450d4f4a395fc8daef3263e8970266b3
CREATE OR REPLACE FUNCTION public.check_store_phone_status(_phone text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
DECLARE
    _caller UUID := auth.uid();
    _normalized_phone TEXT;
    _current_user_phone TEXT;
    _existing_profile RECORD;
BEGIN
    IF _caller IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'يجب تسجيل الدخول أولاً');
    END IF;

    IF _phone IS NULL OR trim(_phone) = '' THEN
        RETURN jsonb_build_object(
            'ok', true,
            'status', 'empty',
            'normalized_phone', NULL
        );
    END IF;

    _normalized_phone := public.normalize_phone_number(_phone);

    SELECT phone INTO _current_user_phone
    FROM public.profiles
    WHERE user_id = _caller;

    IF _current_user_phone IS NOT NULL AND _current_user_phone = _normalized_phone THEN
        RETURN jsonb_build_object(
            'ok', true,
            'status', 'same_user',
            'normalized_phone', _normalized_phone,
            'message', 'الرقم مطابق لرقم حسابك الحالي'
        );
    END IF;

    SELECT user_id, full_name, telegram_chat_id INTO _existing_profile
    FROM public.profiles
    WHERE phone = _normalized_phone
      AND user_id <> _caller
    LIMIT 1;

    IF _existing_profile.user_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', true,
            'status', 'available',
            'normalized_phone', _normalized_phone,
            'message', 'الرقم متاح ويتطلب تأكيد كلمة مرور الحساب لحفظه كافتراضي'
        );
    END IF;

    IF _existing_profile.telegram_chat_id IS NOT NULL AND trim(_existing_profile.telegram_chat_id::text) <> '' THEN
        RETURN jsonb_build_object(
            'ok', true,
            'status', 'requires_telegram_verification',
            'normalized_phone', _normalized_phone,
            'has_telegram', true,
            'message', 'الرقم مرتبط بحساب آخر، يلزم تأكيد النقل عبر رمز يصل لبوت Telegram للحساب الأصلي'
        );
    END IF;

    RETURN jsonb_build_object(
        'ok', false,
        'status', 'conflict_no_telegram',
        'normalized_phone', _normalized_phone,
        'has_telegram', false,
        'error', 'هذا الرقم مرتبط بحساب مستخدم آخر وغير مفعل لديه التيليجرام لنقل الملكية. تواصل مع الدعم الفني.'
    );
END;
$function$
;

-- FUNCTION clean_old_error_logs | normalized md5 62c7783bf8a42a31ef434ef32597f792
CREATE OR REPLACE FUNCTION public.clean_old_error_logs()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE deleted_count integer;
BEGIN
  DELETE FROM public.error_logs WHERE (is_resolved = true AND occurred_at < NOW() - INTERVAL '14 days') OR (occurred_at < NOW() - INTERVAL '60 days');
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$function$
;

-- FUNCTION clear_user_pin | normalized md5 7651c8e96de99e453409c6939c085cdf
CREATE OR REPLACE FUNCTION public.clear_user_pin(_target_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
    _caller UUID := auth.uid();
    _is_authorized BOOLEAN := FALSE;
BEGIN
    IF _caller IS NULL THEN
        RAISE EXCEPTION 'غير مصرح: يجب تسجيل الدخول أولاً';
    END IF;

    SELECT (
        _caller = _target_user_id 
        OR public.is_boss(_caller) 
        OR EXISTS (
            SELECT 1 FROM public.user_roles 
            WHERE user_id = _target_user_id 
              AND owner_id = _caller
        )
    ) INTO _is_authorized;

    IF NOT _is_authorized THEN
        RAISE EXCEPTION 'غير مصرح: لا يمكنك إلغاء رمز أمان مستخدم لا يتبع لمتجرك';
    END IF;

    UPDATE public.profiles
    SET pin_hash = NULL,
        updated_at = now()
    WHERE user_id = _target_user_id;

    RETURN TRUE;
END;
$function$
;

-- FUNCTION close_accounting_period_atomic | normalized md5 d5d6be3f95bade178876476fed2f73e2
CREATE OR REPLACE FUNCTION public.close_accounting_period_atomic(_period_start date, _period_end date, _timezone text DEFAULT 'UTC'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _caller uuid := auth.uid();
  _owner uuid := public.get_owner_id(_caller);
  _tz text := COALESCE(NULLIF(trim(_timezone), ''), 'UTC');
  _rev numeric := 0;
  _cogs numeric := 0;
  _exp numeric := 0;
  _gross numeric := 0;
  _realized numeric := 0;
  _pending numeric := 0;
  _bad_debt numeric := 0;
  _net numeric := 0;
  _inventory_valuation numeric := 0;
  _fx numeric := 0;
  _net_after_fx numeric := 0;
  _range_start timestamptz;
  _range_end timestamptz;
  _installed_at timestamptz;
  _partner_summary jsonb := '[]'::jsonb;
  _closure_id uuid;
  p record;
BEGIN
  IF _caller IS NULL OR _owner IS NULL THEN
    RAISE EXCEPTION 'غير مصرح';
  END IF;

  IF NOT public.is_store_owner(_caller) THEN
    RAISE EXCEPTION 'إقفال الفترة مخصص لمالك المتجر فقط' USING ERRCODE = '42501';
  END IF;

  BEGIN
    PERFORM now() AT TIME ZONE _tz;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'المنطقة الزمنية غير صحيحة: %', _tz;
  END;

  IF _period_start IS NULL OR _period_end IS NULL OR _period_start > _period_end THEN
    RAISE EXCEPTION 'تواريخ الفترة غير صحيحة';
  END IF;
  IF _period_end >= (now() AT TIME ZONE _tz)::date THEN
    RAISE EXCEPTION 'لا يمكن إقفال فترة لم تنتهِ بعد';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('close_accounting_period:' || _owner::text));

  IF EXISTS (
    SELECT 1 FROM public.accounting_period_closures c
    WHERE c.user_id = _owner
      AND c.period_start <= _period_end
      AND c.period_end >= _period_start
  ) THEN
    RAISE EXCEPTION 'هذه الفترة تتداخل مع فترة مقفلة سابقاً';
  END IF;

  _range_start := _period_start::timestamp AT TIME ZONE _tz;
  _range_end := (_period_end + 1)::timestamp AT TIME ZONE _tz;
  SELECT installed_at INTO _installed_at FROM public.invoice_accounting_cutover;
  IF _range_start < _installed_at AND EXISTS (
    SELECT 1 FROM public.invoice_accounting_events
     WHERE user_id = _owner AND is_opening
  ) THEN
    RAISE EXCEPTION 'تحتاج الفترة إلى تسوية موثقة لأنها تبدأ قبل تفعيل سجل حركات الفواتير';
  END IF;

  SELECT COALESCE(SUM(revenue_delta), 0), COALESCE(SUM(cogs_delta), 0), COALESCE(SUM(realized_delta), 0)
    INTO _rev, _cogs, _realized
    FROM public.invoice_accounting_events
   WHERE user_id = _owner AND NOT is_opening
     AND posted_at >= _range_start AND posted_at < _range_end;

  SELECT COALESCE(SUM(e.pending_profit), 0) INTO _pending
    FROM (
      SELECT DISTINCT ON (invoice_id) pending_profit
        FROM public.invoice_accounting_events
       WHERE user_id = _owner AND posted_at < _range_end
       ORDER BY invoice_id, posted_at DESC, id DESC
    ) e;

  IF EXISTS (
    SELECT 1 FROM public.expenses
     WHERE user_id = _owner AND is_reversed AND reversed_at IS NULL
       AND date BETWEEN _period_start AND _period_end
  ) THEN
    RAISE EXCEPTION 'تحتاج مصاريف الفترة المعكوسة بدون تاريخ انعكاس إلى تسوية موثقة';
  END IF;
  SELECT COALESCE(SUM(
    CASE WHEN date BETWEEN _period_start AND _period_end THEN amount ELSE 0 END
    - CASE WHEN is_reversed AND reversed_at >= _range_start AND reversed_at < _range_end
           THEN amount ELSE 0 END
  ), 0) INTO _exp
    FROM public.expenses
   WHERE user_id = _owner
     AND (date BETWEEN _period_start AND _period_end
          OR (is_reversed AND reversed_at >= _range_start AND reversed_at < _range_end));

  IF EXISTS (
    SELECT 1 FROM public.debt_writeoffs
     WHERE user_id = _owner AND loss_amount IS NULL
       AND written_off_at >= _range_start AND written_off_at < _range_end
  ) THEN
    RAISE EXCEPTION 'تحتاج قيود الشطب بدون قيمة خسارة موثقة إلى تسوية قبل الإقفال';
  END IF;
  SELECT COALESCE(SUM(loss_amount), 0) INTO _bad_debt
    FROM public.debt_writeoffs
   WHERE user_id = _owner AND written_off_at >= _range_start AND written_off_at < _range_end;

  _inventory_valuation := public._inventory_valuation_for_period(_owner, _period_start, _period_end, _tz);

  _rev := round(_rev, 8);
  _cogs := round(_cogs, 8);
  _exp := round(_exp, 8);
  _gross := round(_rev - _cogs, 8);
  _realized := round(_realized, 8);
  _pending := round(_pending, 8);
  _bad_debt := round(_bad_debt, 8);
  _net := round(_realized - _exp - _bad_debt + _inventory_valuation, 8);

  -- F4 (audit 2026-11-24): the FX difference of debt collections in the period is its own line below the net result
  -- (never sales profit, never shared with partners).
  SELECT COALESCE(SUM(dp.fx_difference_usd), 0) INTO _fx
    FROM public.debt_payments dp
   WHERE dp.user_id = _owner
     AND dp.created_at >= _range_start AND dp.created_at < _range_end;
  _fx := round(_fx, 8);
  _net_after_fx := round(_net + _fx, 8);

  FOR p IN
    SELECT balances.partner_id AS id, COALESCE(pr.name, '') AS name,
           round(balances.current_balance, 8) AS current_balance,
           round(balances.confirmed_profit, 8) AS confirmed_profit,
           round(balances.total_profit_earned, 8) AS total_profit_earned
      FROM (
        SELECT le.partner_id,
               SUM(le.d_current_balance) AS current_balance,
               SUM(le.d_confirmed_profit) AS confirmed_profit,
               SUM(le.d_total_profit_earned) AS total_profit_earned
          FROM public.partner_ledger_entries le
         WHERE le.user_id = _owner AND le.created_at < _range_end
         GROUP BY le.partner_id
        HAVING BOOL_OR(le.entry_type = 'opening')
      ) balances
      LEFT JOIN public.partners pr ON pr.id = balances.partner_id AND pr.user_id = _owner
     ORDER BY balances.partner_id
  LOOP
    _partner_summary := _partner_summary || jsonb_build_object(
      'partner_id', p.id,
      'partner_name', p.name,
      'current_balance', p.current_balance,
      'confirmed_profit', p.confirmed_profit,
      'total_earned', p.total_profit_earned
    );
  END LOOP;

  INSERT INTO public.accounting_period_closures (
    user_id, period_start, period_end, total_revenue, total_cogs,
    gross_profit, total_expenses, net_profit, partner_distributions, closed_by,
    realized_profit, pending_profit, bad_debt_loss, closing_timezone, inventory_valuation_adjustment, fx_difference, net_after_fx
  ) VALUES (
    _owner, _period_start, _period_end, _rev, _cogs,
    _gross, _exp, _net, _partner_summary, _caller,
    _realized, _pending, _bad_debt, _tz, _inventory_valuation, _fx, _net_after_fx
  ) RETURNING id INTO _closure_id;

  RETURN jsonb_build_object(
    'success', true,
    'closure_id', _closure_id,
    'period_start', _period_start,
    'period_end', _period_end,
    'timezone', _tz,
    'revenue', _rev,
    'cogs', _cogs,
    'gross_profit', _gross,
    'realized_profit', _realized,
    'pending_profit', _pending,
    'expenses', _exp,
    'bad_debt_loss', _bad_debt,
    'inventory_valuation_adjustment', _inventory_valuation,
    'net_profit', _net,
    'fx_difference', _fx,
    'net_after_fx', _net_after_fx,
    'partners', _partner_summary
  );
END;
$function$
;

-- FUNCTION close_cash_shift_atomic | normalized md5 9311660e1dd8953491715fc4ab529be8
CREATE OR REPLACE FUNCTION public.close_cash_shift_atomic(_shift_id uuid, _actual_balance numeric, _variance_reason text DEFAULT NULL::text, _decision text DEFAULT 'accept'::text, _counts jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _caller uuid := auth.uid();
  _owner uuid := public.get_owner_id(_caller);
  _shift record;
  _tol numeric := 1;
  _open jsonb;
  _codes text[];
  _c text; _opening_rate numeric; _stored_rate numeric; _rate numeric; _exp numeric; _cnt numeric; _var numeric; _var_usd numeric;
  _details jsonb := '[]'::jsonb;
  _tot_exp_usd numeric := 0; _tot_cnt_usd numeric := 0; _tot_var_usd numeric := 0;
  _beyond boolean := false;
  _inflow numeric := 0; _outflow numeric := 0; _calc_expected numeric := 0; _variance numeric := 0;
  _status text := 'matched'; _dec text := 'none'; _has_counts boolean := (_counts IS NOT NULL AND jsonb_typeof(_counts)='array' AND jsonb_array_length(_counts) > 0);
  _d jsonb;
BEGIN
  IF _caller IS NULL OR _owner IS NULL THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  SELECT * INTO _shift FROM public.cash_shifts WHERE id = _shift_id AND user_id = _owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'الوردية غير موجودة أو لا تتبع للمتجر'; END IF;
  IF _shift.closed_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', true, 'already_closed', true, 'shift_id', _shift_id);
  END IF;
  SELECT COALESCE(shift_variance_tolerance_usd, 1) INTO _tol FROM public.store_settings WHERE user_id = _owner LIMIT 1;
  _tol := COALESCE(_tol, 1);
  _open := COALESCE(_shift.opening_by_currency, jsonb_build_object('USD', COALESCE(_shift.opening_balance,0)));

  IF _has_counts THEN
    _codes := ARRAY(SELECT DISTINCT c FROM (
        SELECT jsonb_object_keys(_open) AS c
        UNION SELECT upper(COALESCE(currency,'USD')) FROM public.shift_transactions WHERE shift_id = _shift_id
        UNION SELECT upper(e->>'code') FROM jsonb_array_elements(_counts) e) s WHERE c IS NOT NULL);
    FOREACH _c IN ARRAY _codes LOOP
      _rate := NULLIF((SELECT (e->>'rate')::numeric FROM jsonb_array_elements(_counts) e WHERE upper(e->>'code') = _c LIMIT 1), 0);
      -- Prefer shift opening_exchange_rates snapshot over live store_settings.exchange_rates
      _opening_rate := NULLIF((_shift.opening_exchange_rates->>_c)::numeric, 0);
      IF _opening_rate IS NOT NULL AND _opening_rate > 0 THEN
        _rate := _opening_rate;
      ELSE
        SELECT NULLIF((ss.exchange_rates->>_c)::numeric, 0)
          INTO _stored_rate
          FROM public.store_settings ss
         WHERE ss.user_id = _shift.user_id
         LIMIT 1;
        IF _stored_rate IS NOT NULL AND _stored_rate > 0 THEN
          _rate := _stored_rate;
        END IF;
      END IF;
      IF _c = 'USD' THEN _rate := 1; END IF;
      IF _rate IS NULL THEN
        SELECT exchange_rate INTO _rate FROM public.shift_transactions WHERE shift_id=_shift_id AND upper(COALESCE(currency,'USD'))=_c AND exchange_rate > 0 ORDER BY created_at DESC LIMIT 1;
      END IF;
      IF _rate IS NULL OR _rate <= 0 THEN RAISE EXCEPTION 'سعر صرف العملة % غير متوفر', _c; END IF;
      _exp := COALESCE((_open->>_c)::numeric, 0) + COALESCE((
        SELECT SUM(CASE
            WHEN type IN ('sale','deposit','deposit_capital','deposit_revenue','deposit_purchase_cover','debt_payment','surplus','expense_refund','supplier_refund','fx_in','transfer_in') THEN COALESCE(currency_amount, amount)
            WHEN type IN ('expense','refund','withdrawal','supplier_payment','store_credit_refund','shortage','fx_out','transfer_out') THEN -COALESCE(currency_amount, amount)
            ELSE 0 END)
        FROM public.shift_transactions WHERE shift_id = _shift_id AND upper(COALESCE(currency,'USD')) = _c), 0);
      _cnt := COALESCE((SELECT (e->>'counted')::numeric FROM jsonb_array_elements(_counts) e WHERE upper(e->>'code') = _c LIMIT 1), 0);
      _var := round(_cnt - _exp, 4);
      _var_usd := round(_var / _rate, 4);
      _tot_exp_usd := _tot_exp_usd + _exp / _rate; _tot_cnt_usd := _tot_cnt_usd + _cnt / _rate; _tot_var_usd := _tot_var_usd + _var_usd;
      IF abs(_var_usd) > _tol THEN _beyond := true; END IF;
      _details := _details || jsonb_build_object('code', _c, 'rate', _rate, 'expected', round(_exp,4), 'counted', round(_cnt,4), 'variance', _var, 'variance_usd', _var_usd);
    END LOOP;
    IF abs(_tot_var_usd) > _tol THEN _beyond := true; END IF;
    _calc_expected := round(_tot_exp_usd, 2);
    _variance := round(_tot_var_usd, 2);
  ELSE
    SELECT COALESCE(SUM(amount),0) INTO _inflow FROM public.shift_transactions WHERE shift_id=_shift_id AND type IN ('sale','deposit','deposit_capital','deposit_revenue','deposit_purchase_cover','debt_payment','surplus','expense_refund','supplier_refund','fx_in','transfer_in');
    SELECT COALESCE(SUM(amount),0) INTO _outflow FROM public.shift_transactions WHERE shift_id=_shift_id AND type IN ('expense','refund','withdrawal','supplier_payment','store_credit_refund','shortage','fx_out','transfer_out');
    _calc_expected := round(COALESCE(_shift.opening_balance,0) + _inflow - _outflow, 2);
    _variance := round(COALESCE(_actual_balance,0) - _calc_expected, 2);
    _beyond := abs(_variance) > _tol;
    _details := jsonb_build_array(jsonb_build_object('code','USD','rate',1,'expected',_calc_expected,'counted',round(COALESCE(_actual_balance,0),2),'variance',_variance,'variance_usd',_variance));
  END IF;

  IF NOT _beyond THEN
    _dec := CASE WHEN abs(_variance) >= 0.01 OR _has_counts AND _tot_var_usd <> 0 THEN 'within_tolerance' ELSE 'none' END;
    _status := 'matched';
  ELSIF _decision = 'defer' THEN
    _dec := 'deferred'; _status := 'pending';
  ELSE
    _dec := 'accepted';
    _status := CASE WHEN _variance_reason IS NOT NULL AND length(trim(_variance_reason)) > 0 THEN 'matched' ELSE 'unmatched' END;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(_details) d WHERE (d->>'variance')::numeric <> 0) THEN
      PERFORM public.assert_period_open(_owner, CURRENT_DATE, 'إقفال الوردية');
    END IF;
    FOR _d IN SELECT * FROM jsonb_array_elements(_details) LOOP
      IF (_d->>'variance')::numeric <> 0 THEN
        INSERT INTO public.shift_transactions(shift_id,user_id,type,amount,currency,currency_amount,exchange_rate,notes,created_at)
        VALUES (_shift_id,_owner, CASE WHEN (_d->>'variance')::numeric > 0 THEN 'surplus' ELSE 'shortage' END,
                abs((_d->>'variance_usd')::numeric), _d->>'code', abs((_d->>'variance')::numeric), (_d->>'rate')::numeric,
                CASE WHEN (_d->>'variance')::numeric > 0 THEN 'فائض صندوق عند الإقفال: ' ELSE 'عجز صندوق عند الإقفال: ' END || COALESCE(_variance_reason,''), now());
      END IF;
    END LOOP;
  END IF;

  UPDATE public.cash_shifts SET closed_at = now(), expected_balance = _calc_expected,
         actual_balance = CASE WHEN _has_counts THEN round(_tot_cnt_usd,2) ELSE round(COALESCE(_actual_balance,0),2) END,
         variance = _variance, variance_reason = _variance_reason, reconciliation_status = _status,
         currency_counts = _details, variance_decision = _dec, updated_at = now()
   WHERE id = _shift_id;

  RETURN jsonb_build_object('success', true, 'shift_id', _shift_id, 'expected_balance', _calc_expected,
    'variance', _variance, 'status', _status, 'decision', _dec, 'tolerance_usd', _tol, 'currencies', _details);
END;
$function$
;

-- FUNCTION complete_phone_transfer | normalized md5 306a71356e95cce2f68f640923cf5e21
CREATE OR REPLACE FUNCTION public.complete_phone_transfer(_request_id uuid, _entered_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth', 'extensions'
AS $function$
DECLARE _caller UUID := auth.uid(); _req RECORD;
BEGIN
  IF _caller IS NULL THEN RAISE EXCEPTION 'غير مصرح: يجب تسجيل الدخول'; END IF;
  SELECT * INTO _req FROM public.phone_transfer_requests WHERE id = _request_id AND target_user_id = _caller FOR UPDATE;
  IF _req.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'طلب التحقق غير موجود أو منتهي الصلاحية'); END IF;
  IF _req.expires_at < now() THEN
    DELETE FROM public.phone_transfer_requests WHERE id = _request_id;
    RETURN jsonb_build_object('ok', false, 'error', 'انتهت صلاحية رمز التحقق، يرجى طلب رمز جديد');
  END IF;
  IF _req.attempts >= 3 THEN
    DELETE FROM public.phone_transfer_requests WHERE id = _request_id;
    RETURN jsonb_build_object('ok', false, 'error', 'تم تجاوز الحد الأقصى للمحاولات الخاطئة. اطلب رمزاً جديداً');
  END IF;
  IF _req.code_hash <> encode(digest(trim(_entered_code), 'sha256'), 'hex') THEN
    UPDATE public.phone_transfer_requests SET attempts = attempts + 1 WHERE id = _request_id;
    RETURN jsonb_build_object('ok', false, 'error', 'رمز التحقق غير صحيح، المحاولات المتبقية: ' || (2 - _req.attempts));
  END IF;
  UPDATE public.profiles SET phone = NULL, updated_at = now() WHERE user_id = _req.source_user_id;
  UPDATE public.profiles SET phone = _req.phone, updated_at = now() WHERE user_id = _caller;
  UPDATE public.stores SET phone = _req.phone WHERE user_id = _caller;
  DELETE FROM public.phone_transfer_requests WHERE id = _request_id;
  RETURN jsonb_build_object('ok', true, 'status', 'transferred', 'normalized_phone', _req.phone, 'message', 'تم نقل الرقم وربطه بحسابك وبمتجرك بنجاح');
END;
$function$
;

-- FUNCTION confirm_partner_debt_profit_atomic | normalized md5 53a4eb74e817ec5e89f2d14f315547ce
CREATE OR REPLACE FUNCTION public.confirm_partner_debt_profit_atomic(_invoice_id text, _payment_ratio numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _owner uuid := public.get_owner_id(auth.uid());
  p record;
  _updated_details jsonb;
  _updated_history jsonb;
  _total_confirmed numeric := 0;
  _item jsonb;
  _item_amt numeric;
  _confirm_amt numeric;
BEGIN
  IF _owner IS NULL OR _payment_ratio <= 0 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid_params');
  END IF;

  FOR p IN 
    SELECT * FROM public.partners 
    WHERE user_id = _owner 
      AND pending_profit > 0 
    FOR UPDATE 
  LOOP
    _updated_details := '[]'::jsonb;
    _total_confirmed := 0;

    -- مراجعة تفاصيل الأرباح المعلقة للفاتورة المسددة
    FOR _item IN SELECT * FROM jsonb_array_elements(COALESCE(p.pending_profit_details, '[]'::jsonb))
    LOOP
      IF (_item->>'invoiceId') = _invoice_id THEN
        _item_amt := (_item->>'amount')::numeric;
        _confirm_amt := round(_item_amt * LEAST(_payment_ratio, 1.0), 8);
        _total_confirmed := _total_confirmed + _confirm_amt;

        -- الاحتفاظ بالمتبقي إن وجد
        IF (_item_amt - _confirm_amt) > 0.01 THEN
          _updated_details := _updated_details || jsonb_set(_item, '{amount}', to_jsonb(round(_item_amt - _confirm_amt, 8)));
        END IF;
      ELSE
        _updated_details := _updated_details || _item;
      END IF;
    END LOOP;

    -- إذا وجد ربح معلق لهذه الفاتورة، يُحرر فوراً إلى الرصيد المؤكد
    IF _total_confirmed > 0 THEN
      -- تحديث السجل التاريخي للأرباح
      _updated_history := '[]'::jsonb;
      FOR _item IN SELECT * FROM jsonb_array_elements(COALESCE(p.profit_history, '[]'::jsonb))
      LOOP
        IF (_item->>'invoiceId') = _invoice_id AND (_item->>'isDebt')::boolean = true THEN
          _updated_history := _updated_history || jsonb_set(_item, '{isDebt}', 'false'::jsonb);
        ELSE
          _updated_history := _updated_history || _item;
        END IF;
      END LOOP;

      UPDATE public.partners
      SET
        pending_profit = GREATEST(0, round(COALESCE(pending_profit, 0) - _total_confirmed, 8)),
        confirmed_profit = round(COALESCE(confirmed_profit, 0) + _total_confirmed, 8),
        current_balance = round(COALESCE(current_balance, 0) + _total_confirmed, 8),
        total_profit_earned = round(COALESCE(total_profit_earned, 0) + _total_confirmed, 8),
        pending_profit_details = _updated_details,
        profit_history = _updated_history,
        updated_at = now()
      WHERE id = p.id;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'invoice_id', _invoice_id);
END;
$function$
;

-- FUNCTION confirm_subscription_request | normalized md5 85de89024a764b615cde3cb940245301
CREATE OR REPLACE FUNCTION public.confirm_subscription_request(p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.boss_activate_license(NULL, NULL, NULL, 'extend', p_request_id, NULL);
  IF NOT COALESCE((v_result->>'success')::boolean, false) THEN
    RAISE EXCEPTION '%', COALESCE(v_result->>'error', 'فشل تأكيد الطلب');
  END IF;
  RETURN v_result;
END;
$function$
;

-- FUNCTION count_owner_cashiers | normalized md5 36513f8bb33d5e88ec532bab12186904
CREATE OR REPLACE FUNCTION public.count_owner_cashiers(_owner_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.caller_can_query_account(_owner_id) THEN
    RETURN NULL;
  END IF;
  RETURN public.count_owner_cashiers__impl(_owner_id);
END;$function$
;

-- FUNCTION count_owner_cashiers__impl | normalized md5 4316d1f74691a2f29f5f0a7285876ccd
CREATE OR REPLACE FUNCTION public.count_owner_cashiers__impl(_owner_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _count integer;
BEGIN
  SELECT COUNT(*) INTO _count
  FROM public.user_roles
  WHERE owner_id = _owner_id
    AND role = 'cashier'
    AND is_active = true;
  
  RETURN _count;
END;
$function$
;

-- FUNCTION create_subscription_request | normalized md5 1c95acbdafbdbe5fc63736b3099031b0
CREATE OR REPLACE FUNCTION public.create_subscription_request(p_plan_id uuid, p_method_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_user_id uuid := auth.uid(); v_plan record; v_method record; v_ref_code text; v_request_id uuid;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'المستخدم غير مسجل الدخول'; END IF;
  IF EXISTS (SELECT 1 FROM public.subscription_requests WHERE user_id = v_user_id AND status IN ('pending', 'paid_claimed')) THEN
    RAISE EXCEPTION 'لديك طلب تجديد قيد المراجعة بالفعل، يمكنك تعديله أو إلغاؤه';
  END IF;
  SELECT * INTO v_plan FROM public.subscription_plans WHERE id = p_plan_id AND enabled = true;
  IF NOT FOUND THEN RAISE EXCEPTION 'باقة الاشتراك المحددة غير متوفرة أو معطلة'; END IF;
  SELECT * INTO v_method FROM public.payment_methods WHERE id = p_method_id AND enabled = true;
  IF NOT FOUND THEN RAISE EXCEPTION 'طريقة الدفع المحددة غير متوفرة'; END IF;
  v_ref_code := 'FP-' || upper(substr(md5(random()::text), 1, 5));
  INSERT INTO public.subscription_requests (user_id, ref_code, plan_id, plan_name, plan_audience, plan_days, price_usd, equivalents_snapshot, method_id, method_name, status)
  VALUES (v_user_id, v_ref_code, v_plan.id, v_plan.name, v_plan.audience, v_plan.duration_days, v_plan.price_usd, v_plan.equivalents, v_method.id, v_method.name, 'pending')
  RETURNING id INTO v_request_id;
  RETURN jsonb_build_object('success', true, 'request_id', v_request_id, 'ref_code', v_ref_code);
END;
$function$
;

-- FUNCTION create_supplier_atomic | normalized md5 c8d97a5b537088757cf0eaa787b09e39
CREATE OR REPLACE FUNCTION public.create_supplier_atomic(_name text, _company text DEFAULT NULL::text, _phone text DEFAULT NULL::text, _notes text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _o uuid := public._supplier_owner(); _id uuid;
BEGIN
  IF COALESCE(trim(_name),'') = '' THEN RAISE EXCEPTION 'اسم المورد مطلوب'; END IF;
  SELECT id INTO _id FROM public.suppliers WHERE user_id=_o AND lower(name)=lower(trim(_name));
  IF _id IS NOT NULL THEN RETURN _id; END IF;
  INSERT INTO public.suppliers(user_id,name,company,phone,notes,created_by) VALUES (_o,trim(_name),_company,_phone,_notes,auth.uid()) RETURNING id INTO _id;
  RETURN _id;
END $function$
;

-- FUNCTION deduct_product_quantity | normalized md5 6b9d2a9753977547b845ea13aae4189d
CREATE OR REPLACE FUNCTION public.deduct_product_quantity(_product_id uuid, _amount integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _current_qty integer;
  _new_qty integer;
  _owner uuid := public.get_owner_id(auth.uid());
BEGIN
  IF auth.uid() IS NULL OR _amount <= 0 THEN
    RAISE EXCEPTION 'Invalid stock adjustment';
  END IF;

  SELECT quantity INTO _current_qty
  FROM public.products
  WHERE id = _product_id AND user_id = _owner
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;
  IF COALESCE(_current_qty, 0) < _amount THEN RAISE EXCEPTION 'Insufficient stock'; END IF;

  PERFORM set_config('app.stock_movement_type', 'sale', true);
  PERFORM set_config('app.stock_actor_id', auth.uid()::text, true);
  PERFORM set_config('app.stock_source', 'authenticated_rpc', true);

  _new_qty := _current_qty - _amount;
  UPDATE public.products SET quantity = _new_qty WHERE id = _product_id AND user_id = _owner;
  RETURN _new_qty;
END;
$function$
;

-- FUNCTION delete_debt_atomic | normalized md5 5ab7e4de04ee4edacd5bf498263037c8
CREATE OR REPLACE FUNCTION public.delete_debt_atomic(_debt_id uuid, _reason text DEFAULT 'إلغاء الدين'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN public.cancel_debt_atomic(_debt_id, _reason);
END;
$function$
;

-- FUNCTION delete_expense_atomic | normalized md5 68a61d0149ff40ea77209ab94fb2c2ec
CREATE OR REPLACE FUNCTION public.delete_expense_atomic(_expense_id uuid, _reason text DEFAULT 'إلغاء مصروف'::text, _shift_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _caller uuid := auth.uid();
  _owner uuid := public.get_owner_id(_caller);
  _exp public.expenses%ROWTYPE;
  _item jsonb;
  _partner_id uuid;
  _part_amount numeric;
  _active_shift_id uuid;
  _orig_tx record;
  _refund_amt numeric;
  _cash_refunded boolean := false;
  _posted_at timestamptz;
BEGIN
  PERFORM set_config('app.partner_source', 'delete_expense_atomic', true);
  IF _caller IS NULL OR _owner IS NULL THEN RAISE EXCEPTION 'غير مصرح'; END IF;

  SELECT * INTO _exp FROM public.expenses WHERE id = _expense_id AND user_id = _owner FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'المصروف غير موجود', 'cash_refunded', false);
  END IF;

  IF COALESCE(_exp.is_reversed, false) = true THEN
    RETURN jsonb_build_object('success', true, 'already_reversed', true, 'cash_refunded', false);
  END IF;

  _posted_at := clock_timestamp();
  PERFORM public._assert_accounting_posting_open(_owner, _posted_at, 'عكس مصروف');

  -- Look up original shift expense transaction to preserve original currency & require an open shift for drawer expenses
  SELECT st.amount, st.currency, st.currency_amount, st.exchange_rate
    INTO _orig_tx
    FROM public.shift_transactions st
   WHERE st.user_id = _owner
     AND st.type = 'expense'
     AND st.reference_id = _expense_id::text
   ORDER BY st.created_at DESC
   LIMIT 1;

  IF FOUND THEN
    IF _shift_id IS NULL THEN
      RAISE EXCEPTION 'يجب تحديد الوردية المفتوحة لاسترجاع مصروف مدفوع من الصندوق';
    END IF;
    SELECT id INTO _active_shift_id
      FROM public.cash_shifts
     WHERE id = _shift_id AND user_id = _owner AND closed_at IS NULL
       AND (cashier_id = _caller OR public.is_store_owner(_caller))
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'الوردية المحددة غير موجودة أو مغلقة أو لا تتبع لهذا المستخدم';
    END IF;

    _refund_amt := COALESCE(_orig_tx.amount, _exp.amount);

    INSERT INTO public.shift_transactions(
      shift_id, user_id, type, amount, currency, currency_amount, exchange_rate, reference_id, notes
    ) VALUES (
      _active_shift_id, _owner, 'expense_refund',
      _refund_amt,
      COALESCE(_orig_tx.currency, 'USD'),
      COALESCE(_orig_tx.currency_amount, _orig_tx.amount, _exp.amount),
      COALESCE(_orig_tx.exchange_rate, 1),
      _expense_id::text,
      'إلغاء واسترجاع مصروف: ' || COALESCE(_reason, '')
    )
    ON CONFLICT (shift_id, type, reference_id) DO NOTHING;

    IF FOUND THEN
      UPDATE public.cash_shifts
         SET expected_balance = round(COALESCE(expected_balance, 0) + _refund_amt, 8),
             updated_at = now()
       WHERE id = _active_shift_id AND user_id = _owner AND closed_at IS NULL;
      _cash_refunded := true;
    END IF;
  END IF;

  IF _exp.distributions IS NOT NULL AND jsonb_array_length(_exp.distributions) > 0 THEN
    FOR _item IN
      SELECT value FROM jsonb_array_elements(_exp.distributions)
       ORDER BY (value->>'partnerId')::uuid
    LOOP
      _partner_id := (_item->>'partnerId')::uuid;
      _part_amount := COALESCE((_item->>'amount')::numeric, 0);

      IF _partner_id IS NOT NULL AND _part_amount > 0 THEN
        UPDATE public.partners SET
          current_balance = round(COALESCE(current_balance, 0) + _part_amount, 4),
          expense_history = (
            SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
            FROM jsonb_array_elements(COALESCE(expense_history, '[]'::jsonb)) elem
            WHERE elem->>'expenseId' <> _expense_id::text
          ),
          updated_at = now()
        WHERE id = _partner_id AND user_id = _owner;
      END IF;
    END LOOP;
  END IF;

  PERFORM set_config('app.internal_expense_reverse', '1', true);

  UPDATE public.expenses SET
    is_reversed = true,
    reversed_at = _posted_at,
    reversed_by = _caller,
    reversed_reason = _reason
  WHERE id = _expense_id;

  RETURN jsonb_build_object(
    'success', true,
    'expense_id', _expense_id,
    'amount', _exp.amount,
    'expense_type', _exp.expense_type,
    'cash_refunded', _cash_refunded,
    'shift_id', _active_shift_id,
    'cash_amount', CASE WHEN _cash_refunded THEN _refund_amt END,
    'cash_currency', CASE WHEN _cash_refunded THEN COALESCE(_orig_tx.currency, 'USD') END,
    'cash_currency_amount', CASE WHEN _cash_refunded THEN COALESCE(_orig_tx.currency_amount, _orig_tx.amount, _exp.amount) END
  );
END;
$function$
;

-- FUNCTION delete_owner_cascade | normalized md5 5eedf3dd05b8e8eed367c1f8b1f79aee
CREATE OR REPLACE FUNCTION public.delete_owner_cascade(_owner_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Only boss can delete owners
  IF NOT public.is_boss(auth.uid()) THEN
    RETURN false;
  END IF;
  PERFORM public.purge_owner_data(_owner_id);
  RETURN true;
END;
$function$
;

-- FUNCTION distribute_invoice_partner_profits_atomic | normalized md5 03a4f8c78b5058280d4dd5da702b625e
CREATE OR REPLACE FUNCTION public.distribute_invoice_partner_profits_atomic(_invoice_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _inv public.invoices%ROWTYPE;
  _owner uuid;
  _is_debt boolean;
  _cat_profit record;
  _remaining_profit numeric;
  _partner record;
  _partner_share numeric;
  _cat_share jsonb;
  _pct numeric;
  _eff_pct numeric;
  _cat_pct_used numeric;
  _all_pct_used numeric;
  _profit_record jsonb;
  _pending_detail jsonb;
  _total_distributed numeric := 0;
  _distributions jsonb := '[]'::jsonb;
BEGIN
  PERFORM set_config('app.partner_source', 'distribute_invoice_partner_profits_atomic', true);

  -- Lock invoice row BEFORE advisory lock to avoid AB/BA deadlocks with callers holding invoice row lock
  SELECT * INTO _inv FROM public.invoices WHERE id = _invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invoice not found');
  END IF;

  -- Serialize concurrent distribution calls for the same invoice BEFORE already_processed check
  PERFORM pg_advisory_xact_lock(hashtext('partner_dist:' || _invoice_id::text));

  _owner := _inv.user_id;

  IF auth.uid() IS NOT NULL AND public.get_owner_id(auth.uid()) IS DISTINCT FROM _owner THEN
    RAISE EXCEPTION 'غير مصرح' USING ERRCODE = '42501';
  END IF;
  _is_debt := (_inv.payment_type = 'debt' AND COALESCE(_inv.debt_remaining, 0) > 0);

  IF EXISTS (
    SELECT 1 FROM public.partners p,
    jsonb_array_elements(COALESCE(p.profit_history, '[]'::jsonb)) ph
    WHERE p.user_id = _owner AND ph->>'invoiceId' = _inv.invoice_number
  ) THEN
    RETURN jsonb_build_object('success', true, 'already_processed', true, 'invoice_number', _inv.invoice_number);
  END IF;

  IF COALESCE(_inv.created_at, now()) < now() - interval '1 hour' THEN
    RETURN jsonb_build_object('success', true, 'already_processed', true, 'invoice_number', _inv.invoice_number, 'skipped', 'stale_invoice');
  END IF;

  FOR _cat_profit IN
    SELECT
      COALESCE(NULLIF(trim(ii.category_snapshot), ''), NULLIF(trim(p.category), ''), 'عام') AS category_name,
      round(SUM(COALESCE(ii.profit, 0)), 8) AS total_category_profit
    FROM public.invoice_items ii
    LEFT JOIN public.products p ON p.id = ii.product_id AND p.user_id = _owner
    WHERE ii.invoice_id = _invoice_id
    GROUP BY COALESCE(NULLIF(trim(ii.category_snapshot), ''), NULLIF(trim(p.category), ''), 'عام')
    HAVING SUM(COALESCE(ii.profit, 0)) <> 0
  LOOP
    _remaining_profit := _cat_profit.total_category_profit;
    _cat_pct_used := 0;

    FOR _partner IN
      SELECT * FROM public.partners
      WHERE user_id = _owner
        AND COALESCE(access_all, false) = false
        AND category_shares IS NOT NULL
      ORDER BY id
      FOR UPDATE
    LOOP
      SELECT cs INTO _cat_share
      FROM jsonb_array_elements(_partner.category_shares) cs
      WHERE (cs->>'enabled')::boolean = true
        AND trim(COALESCE(cs->>'categoryName', '')) = _cat_profit.category_name
      LIMIT 1;

      IF _cat_share IS NOT NULL AND COALESCE((_cat_share->>'percentage')::numeric, 0) > 0 THEN
        _pct := (_cat_share->>'percentage')::numeric;
        -- Defense-in-depth: cap cumulative category share percentage at 100%
        _eff_pct := LEAST(_pct, GREATEST(100.0 - _cat_pct_used, 0.0));
        IF _eff_pct <= 0 THEN
          CONTINUE;
        END IF;
        _cat_pct_used := _cat_pct_used + _eff_pct;
        _partner_share := round((_cat_profit.total_category_profit * _eff_pct / 100.0), 4);

        IF _partner_share <> 0 THEN
          _remaining_profit := _remaining_profit - _partner_share;
          _total_distributed := _total_distributed + _partner_share;

          _profit_record := jsonb_build_object(
            'id', extract(epoch from now())::text || _partner.id::text || _cat_profit.category_name,
            'invoiceId', _inv.invoice_number,
            'amount', _partner_share,
            'category', _cat_profit.category_name,
            'isDebt', _is_debt,
            'createdAt', now()
          );

          IF _is_debt THEN
            _pending_detail := jsonb_build_object(
              'invoiceId', _inv.invoice_number,
              'amount', _partner_share,
              'customerName', COALESCE(_inv.customer_name, 'عميل بيع مؤجل'),
              'createdAt', now()
            );

            UPDATE public.partners SET
              pending_profit = round(COALESCE(pending_profit, 0) + _partner_share, 4),
              pending_profit_details = COALESCE(pending_profit_details, '[]'::jsonb) || _pending_detail,
              profit_history = COALESCE(profit_history, '[]'::jsonb) || _profit_record,
              updated_at = now()
            WHERE id = _partner.id;
          ELSE
            UPDATE public.partners SET
              confirmed_profit = round(COALESCE(confirmed_profit, 0) + _partner_share, 4),
              current_balance = round(COALESCE(current_balance, 0) + _partner_share, 4),
              total_profit_earned = round(COALESCE(total_profit_earned, 0) + _partner_share, 4),
              profit_history = COALESCE(profit_history, '[]'::jsonb) || _profit_record,
              updated_at = now()
            WHERE id = _partner.id;
          END IF;

          _distributions := _distributions || jsonb_build_object(
            'partnerId', _partner.id,
            'partnerName', _partner.name,
            'amount', _partner_share,
            'category', _cat_profit.category_name
          );
        END IF;
      END IF;
    END LOOP;

    -- Same-sign guard: never debit a fake loss (or credit fake profit) if category shares reached 100%
    IF (_cat_profit.total_category_profit > 0 AND _remaining_profit > 0)
       OR (_cat_profit.total_category_profit < 0 AND _remaining_profit < 0) THEN
      _all_pct_used := 0;
      FOR _partner IN
        SELECT * FROM public.partners
        WHERE user_id = _owner
          AND COALESCE(access_all, false) = true
          AND COALESCE(share_percentage, 0) > 0
        ORDER BY id
        FOR UPDATE
      LOOP
        _eff_pct := LEAST(_partner.share_percentage, GREATEST(100.0 - _all_pct_used, 0.0));
        IF _eff_pct <= 0 THEN
          CONTINUE;
        END IF;
        _all_pct_used := _all_pct_used + _eff_pct;
        _partner_share := round((_remaining_profit * _eff_pct / 100.0), 4);

        IF _partner_share <> 0 THEN
          _total_distributed := _total_distributed + _partner_share;

          _profit_record := jsonb_build_object(
            'id', extract(epoch from now())::text || _partner.id::text || _cat_profit.category_name,
            'invoiceId', _inv.invoice_number,
            'amount', _partner_share,
            'category', _cat_profit.category_name,
            'isDebt', _is_debt,
            'createdAt', now()
          );

          IF _is_debt THEN
            _pending_detail := jsonb_build_object(
              'invoiceId', _inv.invoice_number,
              'amount', _partner_share,
              'customerName', COALESCE(_inv.customer_name, 'عميل بيع مؤجل'),
              'createdAt', now()
            );

            UPDATE public.partners SET
              pending_profit = round(COALESCE(pending_profit, 0) + _partner_share, 4),
              pending_profit_details = COALESCE(pending_profit_details, '[]'::jsonb) || _pending_detail,
              profit_history = COALESCE(profit_history, '[]'::jsonb) || _profit_record,
              updated_at = now()
            WHERE id = _partner.id;
          ELSE
            UPDATE public.partners SET
              confirmed_profit = round(COALESCE(confirmed_profit, 0) + _partner_share, 4),
              current_balance = round(COALESCE(current_balance, 0) + _partner_share, 4),
              total_profit_earned = round(COALESCE(total_profit_earned, 0) + _partner_share, 4),
              profit_history = COALESCE(profit_history, '[]'::jsonb) || _profit_record,
              updated_at = now()
            WHERE id = _partner.id;
          END IF;

          _distributions := _distributions || jsonb_build_object(
            'partnerId', _partner.id,
            'partnerName', _partner.name,
            'amount', _partner_share,
            'category', _cat_profit.category_name
          );
        END IF;
      END LOOP;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'invoice_id', _invoice_id,
    'total_distributed', _total_distributed,
    'distributions', _distributions
  );
END;
$function$
;

-- FUNCTION distribute_sale_profit_to_partners_atomic | normalized md5 b8e2071f82022f3f1c4cd2d559cde3fe
CREATE OR REPLACE FUNCTION public.distribute_sale_profit_to_partners_atomic(_invoice_id text, _customer_name text, _is_debt boolean, _category_profits jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _uid uuid := auth.uid(); _owner uuid; _cat_record record; _partner record; _cat_profit numeric; _cat_name text;
  _remaining numeric; _partner_share numeric; _dist_result jsonb := '[]'::jsonb; _profit_record jsonb;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'المستخدم غير مسجل'; END IF;
  _owner := public.get_owner_id(_uid);
  IF _owner IS NULL THEN RAISE EXCEPTION 'لم يتم العثور على حساب المالك'; END IF;
  IF _category_profits IS NULL OR jsonb_array_length(_category_profits) = 0 THEN
    RETURN jsonb_build_object('success', true, 'distributed_count', 0);
  END IF;
  FOR _cat_record IN SELECT * FROM jsonb_to_recordset(_category_profits) AS x(category text, profit numeric) LOOP
    _cat_name := COALESCE(_cat_record.category, 'عام');
    _cat_profit := round(COALESCE(_cat_record.profit, 0), 8);
    IF _cat_profit > 0 THEN
      _remaining := _cat_profit;
      FOR _partner IN SELECT * FROM public.partners WHERE user_id = _owner AND access_all = false FOR UPDATE LOOP
        SELECT (x->>'percentage')::numeric INTO _partner_share
          FROM jsonb_array_elements(COALESCE(_partner.category_shares, '[]'::jsonb)) AS x
          WHERE (x->>'enabled')::boolean = true AND (x->>'categoryName') = _cat_name LIMIT 1;
        IF _partner_share IS NOT NULL AND _partner_share > 0 THEN
          DECLARE _calc_share numeric := round((_cat_profit * _partner_share) / 100, 8);
          BEGIN
            _remaining := _remaining - _calc_share;
            _profit_record := jsonb_build_object('id', gen_random_uuid()::text, 'invoiceId', _invoice_id, 'amount', _calc_share, 'category', _cat_name, 'isDebt', _is_debt, 'createdAt', now());
            IF _is_debt THEN
              UPDATE public.partners SET
                pending_profit = round(COALESCE(pending_profit, 0) + _calc_share, 8),
                profit_history = COALESCE(profit_history, '[]'::jsonb) || _profit_record,
                pending_profit_details = COALESCE(pending_profit_details, '[]'::jsonb) || jsonb_build_object('invoiceId', _invoice_id, 'amount', _calc_share, 'customerName', _customer_name, 'createdAt', now()),
                updated_at = now() WHERE id = _partner.id;
            ELSE
              UPDATE public.partners SET
                confirmed_profit = round(COALESCE(confirmed_profit, 0) + _calc_share, 8),
                current_balance = round(COALESCE(current_balance, 0) + _calc_share, 8),
                total_profit_earned = round(COALESCE(total_profit_earned, 0) + _calc_share, 8),
                profit_history = COALESCE(profit_history, '[]'::jsonb) || _profit_record,
                updated_at = now() WHERE id = _partner.id;
            END IF;
            _dist_result := _dist_result || jsonb_build_object('partnerId', _partner.id, 'partnerName', _partner.name, 'amount', _calc_share, 'category', _cat_name);
          END;
        END IF;
      END LOOP;
      IF _remaining > 0 THEN
        FOR _partner IN SELECT * FROM public.partners WHERE user_id = _owner AND access_all = true AND COALESCE(share_percentage, 0) > 0 FOR UPDATE LOOP
          DECLARE _full_share numeric := round((_remaining * _partner.share_percentage) / 100, 8);
          BEGIN
            IF _full_share > 0 THEN
              _profit_record := jsonb_build_object('id', gen_random_uuid()::text, 'invoiceId', _invoice_id, 'amount', _full_share, 'category', _cat_name, 'isDebt', _is_debt, 'createdAt', now());
              IF _is_debt THEN
                UPDATE public.partners SET
                  pending_profit = round(COALESCE(pending_profit, 0) + _full_share, 8),
                  profit_history = COALESCE(profit_history, '[]'::jsonb) || _profit_record,
                  pending_profit_details = COALESCE(pending_profit_details, '[]'::jsonb) || jsonb_build_object('invoiceId', _invoice_id, 'amount', _full_share, 'customerName', _customer_name, 'createdAt', now()),
                  updated_at = now() WHERE id = _partner.id;
              ELSE
                UPDATE public.partners SET
                  confirmed_profit = round(COALESCE(confirmed_profit, 0) + _full_share, 8),
                  current_balance = round(COALESCE(current_balance, 0) + _full_share, 8),
                  total_profit_earned = round(COALESCE(total_profit_earned, 0) + _full_share, 8),
                  profit_history = COALESCE(profit_history, '[]'::jsonb) || _profit_record,
                  updated_at = now() WHERE id = _partner.id;
              END IF;
              _dist_result := _dist_result || jsonb_build_object('partnerId', _partner.id, 'partnerName', _partner.name, 'amount', _full_share, 'category', _cat_name);
            END IF;
          END;
        END LOOP;
      END IF;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('success', true, 'invoice_id', _invoice_id, 'distributions', _dist_result);
END;
$function$
;

-- FUNCTION edit_purchase_invoice_atomic | normalized md5 366cefed086c7ee162b48e16ac422d4c
CREATE OR REPLACE FUNCTION public.edit_purchase_invoice_atomic(_invoice_id uuid, _new_lines jsonb, _op_id text, _reason text DEFAULT 'Purchase invoice edit'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _caller uuid := auth.uid();
  _owner uuid;
  _orig_inv record;
  _existing_id uuid;
  _new_invoice_id uuid;
  _old_item record;
  _line jsonb;
  _prod_id uuid;
  _prod_qty numeric;
  _prod_cost numeric;
  _prod_name text;
  _prod_barcode text;
  _prod_cat text;
  _cur_stock numeric;
  _cur_cost numeric;
  _new_stock numeric;
  _new_cost numeric;
  _calc_cost numeric;
  _rem_val numeric;
  v_variance numeric := 0;
  _no_inventory boolean := false;
  _has_subsequent_sale boolean := false;
  _has_newer_purchase boolean := false;
  _items_count int := 0;
  _total_qty numeric := 0;
  _grand_total numeric := 0;
BEGIN
  IF _caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  _owner := public.get_owner_id(_caller);
  IF _owner IS NULL THEN
    RAISE EXCEPTION 'owner not found';
  END IF;

  SELECT id INTO _existing_id
    FROM public.purchase_invoices
   WHERE operation_id = _op_id AND user_id = _owner;
  IF _existing_id IS NOT NULL THEN
    RETURN _existing_id;
  END IF;

  IF _new_lines IS NULL OR jsonb_typeof(_new_lines) <> 'array' OR jsonb_array_length(_new_lines) = 0 THEN
    RAISE EXCEPTION 'لا توجد بنود صالحة لتعديل الفاتورة';
  END IF;

  SELECT * INTO _orig_inv
    FROM public.purchase_invoices
   WHERE id = _invoice_id AND user_id = _owner
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Original invoice not found';
  END IF;

  IF COALESCE(_orig_inv.status, '') = 'cancelled'
     OR COALESCE(_orig_inv.payment_status, '') = 'cancelled'
     OR _orig_inv.replaced_by IS NOT NULL THEN
    RAISE EXCEPTION 'الفاتورة ملغاة أو سبق استبدالها';
  END IF;

  -- Guard upfront before any mutation
  IF EXISTS (SELECT 1 FROM public.purchase_returns WHERE invoice_id = _invoice_id) THEN
    RAISE EXCEPTION 'لا يمكن تعديل فاتورة لها مرتجعات';
  END IF;

  PERFORM public.assert_period_open(_owner, _orig_inv.invoice_date::date, 'تعديل فاتورة الشراء');

  -- --------------------------------------------------------------------------
  -- Path A: Draft / Reconciled — edit invoice items & header totals ONLY
  --         (never touch inventory, cost_price, serials, or supplier ledger)
  -- --------------------------------------------------------------------------
  IF COALESCE(_orig_inv.status, 'draft') IN ('draft', 'reconciled') THEN
    DELETE FROM public.purchase_invoice_items
     WHERE invoice_id = _invoice_id;

    FOR _line IN SELECT * FROM jsonb_array_elements(_new_lines) LOOP
      _prod_id := NULLIF(_line->>'product_id', '')::uuid;
      _prod_qty := GREATEST(0, COALESCE((_line->>'quantity')::numeric, 0));
      _prod_cost := GREATEST(0, COALESCE((_line->>'cost_price')::numeric, 0));
      _prod_name := COALESCE(NULLIF(trim(_line->>'product_name'), ''), 'صنف');
      _prod_barcode := NULLIF(trim(_line->>'barcode'), '');
      _prod_cat := NULLIF(trim(_line->>'category'), '');

      INSERT INTO public.purchase_invoice_items(
        invoice_id, product_id, product_name, barcode, category,
        quantity, cost_price, sale_price, total_cost, serials
      )
      VALUES (
        _invoice_id,
        _prod_id,
        _prod_name,
        _prod_barcode,
        _prod_cat,
        _prod_qty,
        _prod_cost,
        NULLIF(_line->>'sale_price', '')::numeric,
        round(_prod_qty * _prod_cost, 4),
        CASE
          WHEN jsonb_typeof(_line->'serials') = 'array' THEN
            ARRAY(SELECT trim(x) FROM jsonb_array_elements_text(_line->'serials') x WHERE trim(x) <> '')
          ELSE NULL
        END
      );

      _items_count := _items_count + 1;
      _total_qty := _total_qty + _prod_qty;
      _grand_total := _grand_total + round(_prod_qty * _prod_cost, 4);
    END LOOP;

    UPDATE public.purchase_invoices
       SET actual_items_count = _items_count,
           actual_total_quantity = _total_qty,
           actual_grand_total = round(_grand_total, 4),
           expected_items_count = _items_count,
           expected_total_quantity = _total_qty,
           expected_grand_total = round(_grand_total, 4),
           operation_id = _op_id,
           edit_reason = _reason,
           updated_at = now()
     WHERE id = _invoice_id;

    RETURN _invoice_id;
  END IF;

  -- --------------------------------------------------------------------------
  -- Path B: Finalized / Completed — controlled reversal & replacement
  -- --------------------------------------------------------------------------
  IF COALESCE(_orig_inv.status, 'draft') NOT IN ('finalized', 'completed') THEN
    RAISE EXCEPTION 'لا يمكن تعديل فاتورة شراء بحالة %', _orig_inv.status;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.product_serials
     WHERE purchase_invoice_id = _invoice_id
       AND user_id = _owner
       AND status <> 'in_stock'
  ) THEN
    RAISE EXCEPTION 'لا يمكن تعديل الفاتورة: بعض أرقامها التسلسلية بيعت أو أُخرجت';
  END IF;

  SELECT COALESCE(s.store_type, 'general') IN ('bakery', 'repair')
    INTO _no_inventory
    FROM public.stores s
   WHERE s.user_id = _owner
   LIMIT 1;
  _no_inventory := COALESCE(_no_inventory, false);

  PERFORM set_config('app.stock_movement_type', 'purchase_edit', true);
  PERFORM set_config('app.stock_actor_id', _caller::text, true);
  PERFORM set_config('app.stock_source', 'edit_purchase_invoice_atomic', true);

  FOR _old_item IN
    SELECT * FROM public.purchase_invoice_items WHERE invoice_id = _invoice_id
  LOOP
    IF _old_item.product_id IS NULL THEN
      CONTINUE;
    END IF;

    SELECT quantity, cost_price
      INTO _cur_stock, _cur_cost
      FROM public.products
     WHERE id = _old_item.product_id AND user_id = _owner
       FOR UPDATE;

    IF FOUND THEN
      IF _no_inventory THEN
        SELECT EXISTS (
          SELECT 1
            FROM public.purchase_invoice_items pii
            JOIN public.purchase_invoices pi ON pi.id = pii.invoice_id
           WHERE pii.product_id = _old_item.product_id
             AND pi.user_id = _owner
             AND pi.id <> _invoice_id
             AND pi.replaced_by IS NULL
             AND COALESCE(pi.status, '') IN ('finalized', 'completed')
             AND COALESCE(pi.payment_status, '') <> 'cancelled'
             AND COALESCE(pi.finalized_at, pi.created_at) > COALESCE(_orig_inv.finalized_at, _orig_inv.created_at)
        ) INTO _has_newer_purchase;

        IF NOT _has_newer_purchase AND _old_item.cost_price_before IS NOT NULL THEN
          UPDATE public.products
             SET cost_price = _old_item.cost_price_before,
                 updated_at = now()
           WHERE id = _old_item.product_id;
        END IF;
      ELSE
        IF COALESCE(_cur_stock, 0) < COALESCE(_old_item.quantity, 0) THEN
          RAISE EXCEPTION 'لا يمكن تعديل الفاتورة: جزء من كمية "%" بيع أو أُخرج من المخزون', _old_item.product_name;
        END IF;

        _new_stock := round(COALESCE(_cur_stock, 0) - COALESCE(_old_item.quantity, 0), 3);
        _rem_val := (COALESCE(_cur_stock, 0) * COALESCE(_cur_cost, 0))
                  - (COALESCE(_old_item.quantity, 0) * COALESCE(_old_item.cost_price, 0));

        SELECT EXISTS (
          SELECT 1
            FROM public.invoice_items ii
            JOIN public.invoices inv ON inv.id = ii.invoice_id
           WHERE ii.product_id = _old_item.product_id
             AND inv.user_id = _owner
             AND COALESCE(inv.status, '') NOT IN ('cancelled', 'refunded', 'void', 'voided')
             AND inv.created_at > COALESCE(_orig_inv.finalized_at, _orig_inv.created_at)
        ) INTO _has_subsequent_sale;

        IF _has_subsequent_sale THEN
          _new_cost := COALESCE(_cur_cost, 0);
        ELSIF _new_stock > 0 AND _rem_val > 0 THEN
          _calc_cost := round(_rem_val / _new_stock, 8);
          IF _calc_cost <= 0
             OR _calc_cost > GREATEST(COALESCE(_cur_cost, 0), COALESCE(_old_item.cost_price_before, COALESCE(_cur_cost, 0)))
             OR _calc_cost < LEAST(COALESCE(_cur_cost, 0), COALESCE(_old_item.cost_price_before, COALESCE(_cur_cost, 0))) THEN
            _new_cost := COALESCE(_cur_cost, 0);
          ELSE
            _new_cost := _calc_cost;
          END IF;
        ELSIF _new_stock > 0 AND _rem_val <= 0 THEN
          _new_cost := COALESCE(_cur_cost, 0);
        ELSIF _old_item.cost_price_before IS NOT NULL THEN
          _new_cost := _old_item.cost_price_before;
        ELSE
          _new_cost := COALESCE(_cur_cost, 0);
        END IF;

        v_variance := round((_new_stock * _new_cost) - _rem_val, 4);
        IF v_variance <> 0 THEN
          INSERT INTO public.inventory_valuation_adjustments(
            user_id, source_type, source_id, product_id, variance_usd, notes
          ) VALUES (
            _owner,
            'purchase_edit',
            _invoice_id,
            _old_item.product_id,
            v_variance,
            'فرق تقييم مخزون عند تعديل فاتورة الشراء ' || COALESCE(_orig_inv.invoice_number, '')
          );
        END IF;

        UPDATE public.products
           SET quantity = _new_stock,
               cost_price = _new_cost,
               updated_at = now()
         WHERE id = _old_item.product_id;
      END IF;
    END IF;
  END LOOP;

  INSERT INTO public.purchase_invoices (
    user_id, invoice_number, supplier_name, supplier_company, invoice_date, status,
    finalized_at, notes, payment_status, payment_method, operation_id, edit_reason
  )
  VALUES (
    _owner,
    _orig_inv.invoice_number || '-E',
    _orig_inv.supplier_name,
    _orig_inv.supplier_company,
    _orig_inv.invoice_date,
    COALESCE(_orig_inv.status, 'finalized'),
    now(),
    COALESCE(_reason, 'تعديل الفاتورة ' || _orig_inv.invoice_number),
    _orig_inv.payment_status,
    _orig_inv.payment_method,
    _op_id,
    _reason
  )
  RETURNING id INTO _new_invoice_id;

  UPDATE public.product_serials
     SET purchase_invoice_id = _new_invoice_id,
         updated_at = now()
   WHERE purchase_invoice_id = _invoice_id
     AND user_id = _owner
     AND status = 'in_stock';

  FOR _line IN SELECT * FROM jsonb_array_elements(_new_lines) LOOP
    _prod_id := (_line->>'product_id')::uuid;
    _prod_qty := GREATEST(0, (_line->>'quantity')::numeric);
    _prod_cost := GREATEST(0, (_line->>'cost_price')::numeric);
    _prod_name := COALESCE(_line->>'product_name', 'صنف');
    _prod_barcode := _line->>'barcode';
    _prod_cat := _line->>'category';

    SELECT quantity, cost_price
      INTO _cur_stock, _cur_cost
      FROM public.products
     WHERE id = _prod_id AND user_id = _owner
       FOR UPDATE;

    IF FOUND THEN
      IF _no_inventory THEN
        UPDATE public.products
           SET cost_price = _prod_cost,
               updated_at = now()
         WHERE id = _prod_id;
      ELSE
        _new_stock := round(COALESCE(_cur_stock, 0) + _prod_qty, 3);
        _new_cost := CASE
          WHEN _new_stock > 0 THEN
            ((COALESCE(_cur_stock, 0) * COALESCE(_cur_cost, 0)) + (_prod_qty * _prod_cost)) / _new_stock
          ELSE _prod_cost
        END;
        UPDATE public.products
           SET quantity = _new_stock,
               cost_price = _new_cost,
               updated_at = now()
         WHERE id = _prod_id;
      END IF;

      INSERT INTO public.purchase_invoice_items(
        invoice_id, product_id, product_name, barcode, category,
        quantity, cost_price, cost_price_before, sale_price, total_cost, serials
      )
      VALUES (
        _new_invoice_id,
        _prod_id,
        _prod_name,
        _prod_barcode,
        _prod_cat,
        _prod_qty,
        _prod_cost,
        _cur_cost,
        (_line->>'sale_price')::numeric,
        round(_prod_qty * _prod_cost, 4),
        CASE
          WHEN jsonb_typeof(_line->'serials') = 'array' THEN
            ARRAY(SELECT trim(x) FROM jsonb_array_elements_text(_line->'serials') x WHERE trim(x) <> '')
          ELSE NULL
        END
      );

      IF jsonb_typeof(_line->'serials') = 'array' THEN
        DECLARE
          _ns text[];
          _missing text[];
        BEGIN
          SELECT COALESCE(array_agg(DISTINCT trim(x)), '{}'::text[]) INTO _ns
            FROM jsonb_array_elements_text(_line->'serials') x
           WHERE trim(x) <> '';

          INSERT INTO public.product_serial_events(user_id, serial_id, event, ref, actor)
          SELECT _owner, ps.id, 'returned_to_supplier', 'edit:' || _orig_inv.invoice_number, _caller
            FROM public.product_serials ps
           WHERE ps.user_id = _owner
             AND ps.product_id = _prod_id
             AND ps.purchase_invoice_id = _new_invoice_id
             AND ps.status = 'in_stock'
             AND lower(ps.serial) <> ALL(SELECT lower(u) FROM unnest(_ns) u);

          UPDATE public.product_serials
             SET status = 'returned_to_supplier',
                 updated_at = now()
           WHERE user_id = _owner
             AND product_id = _prod_id
             AND purchase_invoice_id = _new_invoice_id
             AND status = 'in_stock'
             AND lower(serial) <> ALL(SELECT lower(u) FROM unnest(_ns) u);

          SELECT COALESCE(array_agg(s), '{}'::text[]) INTO _missing
            FROM unnest(_ns) s
           WHERE NOT EXISTS (
             SELECT 1
               FROM public.product_serials ps
              WHERE ps.user_id = _owner
                AND ps.product_id = _prod_id
                AND lower(ps.serial) = lower(s)
           );

          IF cardinality(_missing) > 0 THEN
            PERFORM public._register_serials(_owner, _prod_id, _missing, _prod_cost, _new_invoice_id, cardinality(_missing));
          END IF;
        END;
      END IF;

      _items_count := _items_count + 1;
      _total_qty := _total_qty + _prod_qty;
      _grand_total := _grand_total + round(_prod_qty * _prod_cost, 4);
    END IF;
  END LOOP;

  UPDATE public.purchase_invoices
     SET actual_items_count = _items_count,
         actual_total_quantity = _total_qty,
         actual_grand_total = round(_grand_total, 4),
         expected_items_count = _items_count,
         expected_total_quantity = _total_qty,
         expected_grand_total = round(_grand_total, 4),
         updated_at = now()
   WHERE id = _new_invoice_id;

  IF _orig_inv.supplier_id IS NOT NULL THEN
    INSERT INTO public.supplier_ledger_entries(user_id, supplier_id, entry_type, amount, reference_type, reference_id, note, created_by)
    SELECT user_id, supplier_id, 'adjustment', -amount, 'purchase_cancel', reference_id, 'عكس بسبب تعديل الفاتورة', _caller
      FROM public.supplier_ledger_entries
     WHERE reference_type = 'purchase_invoice'
       AND reference_id = _invoice_id::text
       AND entry_type IN ('purchase', 'payment');

    INSERT INTO public.supplier_ledger_entries(user_id, supplier_id, entry_type, amount, reference_type, reference_id, note, created_by)
    VALUES (_owner, _orig_inv.supplier_id, 'purchase', round(_grand_total, 4), 'purchase_invoice', _new_invoice_id::text, 'فاتورة معدّلة ', _caller);

    IF COALESCE(_orig_inv.amount_paid, 0) + COALESCE(_orig_inv.supplier_credit, 0) > 0 THEN
      INSERT INTO public.supplier_ledger_entries(user_id, supplier_id, entry_type, amount, reference_type, reference_id, note, created_by)
      VALUES (_owner, _orig_inv.supplier_id, 'payment', -round(COALESCE(_orig_inv.amount_paid, 0) + COALESCE(_orig_inv.supplier_credit, 0), 4), 'purchase_invoice', _new_invoice_id::text, 'دفعة منقولة من الفاتورة الأصلية', _caller);
    END IF;

    UPDATE public.purchase_invoices
       SET supplier_id = _orig_inv.supplier_id,
           amount_paid = LEAST(COALESCE(_orig_inv.amount_paid, 0) + COALESCE(_orig_inv.supplier_credit, 0), round(_grand_total, 4))
     WHERE id = _new_invoice_id;
  END IF;

  -- F8 (audit 2026-11-24): the replacement keeps the drawer reference of the original payment, and shows the
  -- supplier credit (paid above the new total) that the supplier ledger already records.
  UPDATE public.purchase_invoices
     SET paid_from = _orig_inv.paid_from,
         paid_shift_id = _orig_inv.paid_shift_id,
         paid_currency = _orig_inv.paid_currency,
         paid_currency_amount = _orig_inv.paid_currency_amount,
         paid_rate = _orig_inv.paid_rate,
         supplier_credit = GREATEST(COALESCE(_orig_inv.amount_paid, 0) + COALESCE(_orig_inv.supplier_credit, 0) - round(_grand_total, 4), 0)
   WHERE id = _new_invoice_id;

  UPDATE public.purchase_invoices
     SET payment_status = 'cancelled',
         replaced_by = _new_invoice_id,
         edit_reason = _reason,
         updated_at = now(),
         notes = COALESCE(notes, '') || ' [تم استبدالها بـ ' || _orig_inv.invoice_number || '-E]'
   WHERE id = _invoice_id;

  RETURN _new_invoice_id;
END;
$function$
;

-- FUNCTION enforce_paid_write_access | normalized md5 14b634ebd1af97d14fa5a3f4e5cb297f
CREATE OR REPLACE FUNCTION public.enforce_paid_write_access()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.has_paid_write_access(auth.uid()) THEN
    RAISE EXCEPTION 'subscription_required' USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$
;

-- FUNCTION finalize_purchase_invoice_atomic | normalized md5 091c9855ac991b3c978f9cb764b2c6cc
CREATE OR REPLACE FUNCTION public.finalize_purchase_invoice_atomic(_invoice_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _caller uuid := auth.uid();
  _owner uuid;
  _inv public.purchase_invoices%ROWTYPE;
  _it record;
  _pid uuid;
  _old_cost numeric;
  _no_inventory boolean := false;
  _hist jsonb;
  _count integer := 0;
  _total_qty numeric := 0;
  _grand_total numeric := 0;
BEGIN
  IF _caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF NOT public.is_store_owner(_caller) THEN
    RAISE EXCEPTION 'اعتماد فاتورة الشراء مخصص لمالك المتجر فقط' USING ERRCODE = '42501';
  END IF;

  _owner := public.get_owner_id(_caller);
  IF _owner IS NULL THEN
    RAISE EXCEPTION 'Owner context is required';
  END IF;

  SELECT * INTO _inv
    FROM public.purchase_invoices
   WHERE id = _invoice_id AND user_id = _owner
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Purchase invoice not found';
  END IF;

  IF _inv.status = 'finalized' THEN
    RETURN jsonb_build_object('success', true, 'already_finalized', true, 'invoice_id', _invoice_id);
  END IF;

  IF COALESCE(_inv.status, 'draft') NOT IN ('draft', 'reconciled') THEN
    RAISE EXCEPTION 'Purchase invoice cannot be finalized from status %', _inv.status;
  END IF;

  PERFORM public.assert_period_open(_owner, COALESCE(_inv.invoice_date::date, CURRENT_DATE), 'اعتماد فاتورة شراء');

  -- FX tolerance cross-check for non-USD payments (drawer or external)
  IF COALESCE(_inv.amount_paid, 0) > 0
     AND upper(COALESCE(NULLIF(trim(_inv.paid_currency), ''), 'USD')) <> 'USD'
     AND COALESCE(_inv.paid_currency_amount, 0) > 0 THEN
    IF COALESCE(_inv.paid_rate, 0) <= 0 THEN
      RAISE EXCEPTION 'سعر صرف عملة الدفع (%) غير صالح', _inv.paid_currency;
    END IF;
    IF abs(_inv.paid_currency_amount - (_inv.amount_paid * _inv.paid_rate))
         > GREATEST(0.05, (_inv.amount_paid * _inv.paid_rate) * 0.01) THEN
      RAISE EXCEPTION 'مبلغ العملة المدفوعة (%) لا يتطابق مع المبلغ بالدولار وسعر الصرف (المتوقع %)',
        round(_inv.paid_currency_amount, 4),
        round(_inv.amount_paid * _inv.paid_rate, 4);
    END IF;
  END IF;

  SELECT COALESCE(s.store_type, 'general') IN ('bakery', 'repair')
    INTO _no_inventory
    FROM public.stores s
   WHERE s.user_id = _owner
   LIMIT 1;
  _no_inventory := COALESCE(_no_inventory, false);

  FOR _it IN
    SELECT * FROM public.purchase_invoice_items
     WHERE invoice_id = _invoice_id
     ORDER BY created_at, id
  LOOP
    _count := _count + 1;
    _total_qty := _total_qty + COALESCE(_it.quantity, 0);
    _grand_total := _grand_total + (COALESCE(_it.quantity, 0) * COALESCE(_it.cost_price, 0));
    _pid := _it.product_id;

    PERFORM set_config('app.stock_movement_type', 'purchase', true);
    PERFORM set_config('app.stock_source', 'finalize_purchase_invoice', true);
    PERFORM set_config('app.stock_invoice_number', COALESCE(_inv.invoice_number, ''), true);

    _hist := jsonb_build_array(jsonb_build_object(
      'invoice_id', _invoice_id,
      'invoice_number', _inv.invoice_number,
      'supplier_name', _inv.supplier_name,
      'date', _inv.invoice_date,
      'quantity', _it.quantity,
      'cost_price', _it.cost_price,
      'added_at', now()
    ));

    IF _pid IS NOT NULL THEN
      PERFORM 1 FROM public.products p WHERE p.id = _pid AND p.user_id = _owner;
      IF NOT FOUND THEN
        _pid := NULL;
      END IF;
    END IF;

    IF _pid IS NULL AND NULLIF(trim(_it.barcode), '') IS NOT NULL THEN
      SELECT p.id INTO _pid
        FROM public.products p
       WHERE p.user_id = _owner AND p.barcode = trim(_it.barcode)
       ORDER BY p.created_at
       LIMIT 1;
    END IF;

    IF _pid IS NULL AND NULLIF(trim(_it.product_name), '') IS NOT NULL THEN
      SELECT p.id INTO _pid
        FROM public.products p
       WHERE p.user_id = _owner AND lower(trim(p.name)) = lower(trim(_it.product_name))
       ORDER BY p.created_at
       LIMIT 1;
    END IF;

    IF _pid IS NULL THEN
      INSERT INTO public.products(
        user_id, name, barcode, category, quantity, cost_price, sale_price, min_stock_level, purchase_history
      ) VALUES (
        _owner, _it.product_name, NULLIF(trim(_it.barcode), ''), _it.category,
        CASE WHEN _no_inventory THEN 99999 ELSE _it.quantity END,
        COALESCE(_it.cost_price, 0),
        COALESCE(NULLIF(_it.sale_price, 0), _it.cost_price, 0),
        5, _hist
      )
      RETURNING id INTO _pid;

      UPDATE public.purchase_invoice_items
         SET product_id = _pid, cost_price_before = 0
       WHERE id = _it.id;
    ELSE
      SELECT COALESCE(p.cost_price, 0) INTO _old_cost
        FROM public.products p
       WHERE p.id = _pid
         FOR UPDATE;

      UPDATE public.purchase_invoice_items
         SET product_id = _pid, cost_price_before = _old_cost
       WHERE id = _it.id;

      IF _no_inventory THEN
        UPDATE public.products
           SET cost_price = COALESCE(_it.cost_price, 0), updated_at = now()
         WHERE id = _pid;
      ELSE
        PERFORM public.receive_stock_wac(
          _pid,
          _it.quantity::numeric,
          COALESCE(_it.cost_price, 0)::numeric,
          'purchase_invoice:' || COALESCE(_inv.invoice_number, '')
        );
      END IF;

      UPDATE public.products
         SET purchase_history = (CASE WHEN jsonb_typeof(purchase_history) = 'array' THEN purchase_history ELSE '[]'::jsonb END) || _hist
       WHERE id = _pid;
    END IF;
  END LOOP;

  IF _count = 0 THEN
    RAISE EXCEPTION 'Purchase invoice has no items';
  END IF;

  UPDATE public.purchase_invoices
     SET status = 'finalized',
         finalized_at = now(),
         actual_items_count = _count,
         actual_total_quantity = _total_qty,
         actual_grand_total = round(_grand_total, 4),
         updated_at = now()
   WHERE id = _invoice_id;

  DECLARE _sr record;
  BEGIN
    FOR _sr IN
      SELECT i.product_id, i.quantity, i.cost_price, i.serials, p.track_serials, p.name
        FROM public.purchase_invoice_items i
        JOIN public.products p ON p.id = i.product_id
       WHERE i.invoice_id = _invoice_id
         AND (p.track_serials OR cardinality(COALESCE(i.serials, '{}'::text[])) > 0)
    LOOP
      IF _sr.track_serials AND cardinality(COALESCE(_sr.serials, '{}'::text[])) = 0 THEN
        RAISE EXCEPTION 'المنتج % يتطلب إدخال أرقام تسلسلية', _sr.name;
      END IF;
      PERFORM public._register_serials(_owner, _sr.product_id, _sr.serials, _sr.cost_price, _invoice_id, _sr.quantity);
      UPDATE public.products SET track_serials = true WHERE id = _sr.product_id AND NOT track_serials;
    END LOOP;
  END;

  IF _inv.supplier_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.supplier_ledger_entries
        WHERE reference_type = 'purchase_invoice'
          AND reference_id = _invoice_id::text
          AND entry_type = 'purchase'
     ) THEN
    DECLARE
      _tot numeric := round(_grand_total, 4);
      _paid numeric := COALESCE(_inv.amount_paid, 0);
    BEGIN
      IF _paid > _tot + 0.0001 THEN
        RAISE EXCEPTION 'المدفوع أكبر من إجمالي الفاتورة';
      END IF;
      IF _paid > 0 AND _inv.paid_from = 'drawer' THEN
        PERFORM public._supplier_drawer_tx(
          _owner,
          _inv.paid_shift_id,
          'supplier_payment',
          _paid,
          _inv.paid_currency,
          _inv.paid_currency_amount,
          _inv.paid_rate,
          'purchase:' || _invoice_id::text,
          'دفعة فاتورة شراء ' || COALESCE(_inv.invoice_number, '')
        );
      END IF;
      IF _tot > 0 THEN
        INSERT INTO public.supplier_ledger_entries(user_id, supplier_id, entry_type, amount, reference_type, reference_id, note, created_by)
        VALUES (_owner, _inv.supplier_id, 'purchase', _tot, 'purchase_invoice', _invoice_id::text, 'فاتورة شراء ' || COALESCE(_inv.invoice_number, ''), _caller);
      END IF;
      IF _paid > 0 THEN
        INSERT INTO public.supplier_ledger_entries(user_id, supplier_id, entry_type, amount, reference_type, reference_id, payment_method, payment_source, shift_id, note, created_by)
        VALUES (
          _owner,
          _inv.supplier_id,
          'payment',
          -round(_paid, 4),
          'purchase_invoice',
          _invoice_id::text,
          _inv.payment_method,
          COALESCE(_inv.paid_from, 'external'),
          CASE WHEN _inv.paid_from = 'drawer' THEN _inv.paid_shift_id ELSE NULL END,
          'دفعة عند الشراء ' || COALESCE(_inv.invoice_number, ''),
          _caller
        );
      END IF;
    END;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'already_finalized', false,
    'invoice_id', _invoice_id,
    'items', _count,
    'actual_grand_total', round(_grand_total, 4)
  );
END;
$function$
;

-- FUNCTION get_boss_owners | normalized md5 29f50e2a907ff68d905101933f8b8d3c
CREATE OR REPLACE FUNCTION public.get_boss_owners()
 RETURNS SETOF boss_owners_view
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.is_boss(auth.uid()) THEN
    RAISE EXCEPTION 'Access denied: boss role required';
  END IF;
  RETURN QUERY SELECT * FROM public.boss_owners_view;
END;
$function$
;

-- FUNCTION get_boss_telegram_alert_config | normalized md5 a02b607d8a99efe83340a8bff7853744
CREATE OR REPLACE FUNCTION public.get_boss_telegram_alert_config()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_val text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_boss(auth.uid()) THEN
    RETURN NULL;
  END IF;

  SELECT value INTO v_val
  FROM public.app_settings
  WHERE key = 'telegram_boss_alert_config';

  IF v_val IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN v_val::jsonb;
END;
$function$
;

-- FUNCTION get_inventory_value | normalized md5 562621c347ddb171cb68f3a608e35042
CREATE OR REPLACE FUNCTION public.get_inventory_value(_owner_id uuid)
 RETURNS TABLE(total_cost numeric, total_sale numeric, total_units bigint, total_skus bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF _owner_id IS DISTINCT FROM public.get_owner_id(auth.uid())
     AND NOT public.is_boss(auth.uid()) THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  RETURN QUERY
  SELECT
    COALESCE(SUM(COALESCE(p.quantity,0) * COALESCE(p.cost_price,0)), 0)::numeric,
    COALESCE(SUM(COALESCE(p.quantity,0) * COALESCE(p.sale_price,0)), 0)::numeric,
    COALESCE(SUM(COALESCE(p.quantity,0)), 0)::bigint,
    COUNT(*)::bigint
  FROM public.products p
  WHERE p.user_id = _owner_id AND COALESCE(p.archived,false) = false;
END;
$function$
;

-- FUNCTION get_next_invoice_number | normalized md5 1320523a6158d51728fbdf588c854ead
CREATE OR REPLACE FUNCTION public.get_next_invoice_number(_user_id uuid DEFAULT NULL::uuid)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _owner uuid;
  _next bigint;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  _owner := public.get_owner_id(auth.uid());
  IF _owner IS NULL THEN
    RAISE EXCEPTION 'No owner context';
  END IF;

  IF _user_id IS NOT NULL AND _user_id <> _owner THEN
    IF NOT public.is_boss(auth.uid()) THEN
      RAISE EXCEPTION 'Access denied';
    END IF;
    _owner := _user_id;
  END IF;

  INSERT INTO public.invoice_sequences (user_id, last_number)
  VALUES (_owner, 1)
  ON CONFLICT (user_id) DO UPDATE
    SET last_number = public.invoice_sequences.last_number + 1,
        updated_at = now()
  RETURNING last_number INTO _next;

  RETURN _next;
END;
$function$
;

-- FUNCTION get_owner_id | normalized md5 19773a7cc964f276f7df4bb2b3a1d801
CREATE OR REPLACE FUNCTION public.get_owner_id(_user_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _caller uuid := auth.uid();
  _res uuid;
BEGIN
  _res := public.get_owner_id__resolve(_user_id);
  -- الخادم، أو السؤال عن النفس (كل سياسات الأمان): كما كان تماماً
  IF _caller IS NULL OR _user_id = _caller THEN
    RETURN _res;
  END IF;
  -- البوس، أو عضو من نفس المتجر
  IF public.is_boss(_caller) OR _res IS NOT DISTINCT FROM public.get_owner_id__resolve(_caller) THEN
    RETURN _res;
  END IF;
  RETURN NULL;
END;
$function$
;

-- FUNCTION get_owner_id__resolve | normalized md5 6cb2edd7dd01d59eb95b489f9b518d98
CREATE OR REPLACE FUNCTION public.get_owner_id__resolve(_user_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _role app_role;
  _owner_id uuid;
  _is_active boolean;
  _owner_active boolean;
BEGIN
  IF _user_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- استخراج الدور وحالة النشاط ومعرف المالك
  SELECT role, owner_id, COALESCE(is_active, true)
    INTO _role, _owner_id, _is_active
  FROM public.user_roles
  WHERE user_id = _user_id
  LIMIT 1;

  -- إذا كان الحساب غير نشط (معطل) يتم قطع الوصول فوراً
  IF _is_active IS FALSE THEN
    RETURN NULL;
  END IF;

  -- إذا كان كاشيراً، يجب التحقق أيضاً من أن متجر المالك ليس معطلاً
  IF _role = 'cashier' AND _owner_id IS NOT NULL THEN
    SELECT COALESCE(is_active, true) INTO _owner_active
    FROM public.user_roles
    WHERE user_id = _owner_id
    LIMIT 1;

    IF _owner_active IS FALSE THEN
      RETURN NULL;
    END IF;

    RETURN _owner_id;
  END IF;

  -- إذا كان مديراً أو Boss ونشطاً، فهو صاحب المتجر
  IF _role IN ('admin', 'boss') OR _owner_id IS NULL THEN
    RETURN _user_id;
  END IF;

  RETURN _owner_id;
END;
$function$
;

-- FUNCTION get_public_contact_links | normalized md5 f0b75ccae3887df4f25c624a0cc29971
CREATE OR REPLACE FUNCTION public.get_public_contact_links()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(value::jsonb, '{}'::jsonb)
  FROM public.app_settings
  WHERE key = 'contact_links'
  LIMIT 1;
$function$
;

-- FUNCTION get_sales_full_refund_settlement | normalized md5 52f55292983fa58b85d9cb3f50d648e3
CREATE OR REPLACE FUNCTION public.get_sales_full_refund_settlement(_invoice_number text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _owner uuid := public.get_owner_id(auth.uid());
BEGIN
  IF _owner IS NULL OR public.can_refund_invoices(auth.uid()) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'ليست لديك صلاحية قراءة تسوية المرتجع';
  END IF;
  RETURN (SELECT response FROM public.sales_settlement_replays WHERE user_id = _owner
    AND kind = 'full_refund' AND operation_id = _invoice_number);
END;
$function$
;

-- FUNCTION get_stock_discrepancies | normalized md5 8b54a009d3db735d4d540794fe7b7e4e
CREATE OR REPLACE FUNCTION public.get_stock_discrepancies()
 RETURNS TABLE(product_id uuid, product_name text, warehouse_id uuid, warehouse_name text, actual_quantity integer, expected_quantity bigint, variance bigint, unit_cost numeric, variance_value numeric, last_movement_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH actual AS (
    SELECT p.user_id, p.id AS product_id, p.name AS product_name,
           NULL::uuid AS warehouse_id, 'المخزون الرئيسي'::text AS warehouse_name,
           COALESCE(p.quantity, 0)::integer AS actual_quantity, COALESCE(p.cost_price, 0)::numeric AS unit_cost
    FROM public.products p
    WHERE p.user_id = public.get_owner_id(auth.uid()) AND COALESCE(p.archived, false) = false
    UNION ALL
    SELECT w.user_id, ws.product_id, p.name, w.id, w.name,
           COALESCE(ws.quantity, 0)::integer, COALESCE(p.cost_price, 0)::numeric
    FROM public.warehouse_stock ws
    JOIN public.warehouses w ON w.id = ws.warehouse_id
    JOIN public.products p ON p.id = ws.product_id
    WHERE w.user_id = public.get_owner_id(auth.uid()) AND COALESCE(w.is_active, true) = true
  ), ledger AS (
    SELECT sm.user_id, sm.product_id, sm.warehouse_id,
           SUM(sm.quantity_delta)::bigint AS expected_quantity,
           MAX(sm.created_at) AS last_movement_at
    FROM public.stock_movements sm
    WHERE sm.user_id = public.get_owner_id(auth.uid())
    GROUP BY sm.user_id, sm.product_id, sm.warehouse_id
  )
  SELECT a.product_id, a.product_name, a.warehouse_id, a.warehouse_name,
         a.actual_quantity, COALESCE(l.expected_quantity, 0),
         a.actual_quantity::bigint - COALESCE(l.expected_quantity, 0),
         a.unit_cost,
         (a.actual_quantity::numeric - COALESCE(l.expected_quantity, 0)::numeric) * a.unit_cost,
         l.last_movement_at
  FROM actual a
  LEFT JOIN ledger l ON l.user_id = a.user_id AND l.product_id = a.product_id
    AND l.warehouse_id IS NOT DISTINCT FROM a.warehouse_id
  ORDER BY ABS(a.actual_quantity::bigint - COALESCE(l.expected_quantity, 0)) DESC, a.product_name;
$function$
;

-- FUNCTION get_user_role | normalized md5 9c4bbdc1e2d617edfbdb3c9472c9bac2
CREATE OR REPLACE FUNCTION public.get_user_role(_user_id uuid)
 RETURNS app_role
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _role app_role;
  _caller_id uuid;
  _caller_is_admin boolean;
BEGIN
  -- Get the calling user's ID
  _caller_id := auth.uid();
  
  -- If no authenticated user, return null
  IF _caller_id IS NULL THEN
    RETURN NULL;
  END IF;
  
  -- Allow users to query their own role
  IF _caller_id = _user_id THEN
    SELECT role INTO _role FROM public.user_roles WHERE user_id = _user_id LIMIT 1;
    RETURN _role;
  END IF;
  
  -- Check if caller is admin (direct query to avoid recursion)
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = _caller_id AND role = 'admin'
  ) INTO _caller_is_admin;
  
  -- Only admins can query other users' roles
  IF _caller_is_admin THEN
    SELECT role INTO _role FROM public.user_roles WHERE user_id = _user_id LIMIT 1;
    RETURN _role;
  END IF;
  
  -- Non-admins cannot query other users' roles
  RETURN NULL;
END;
$function$
;

-- FUNCTION get_user_storage_stats | normalized md5 54ce9436fe77b52458c1086c8b47acdf
CREATE OR REPLACE FUNCTION public.get_user_storage_stats(_target_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'storage'
AS $function$
DECLARE
  _caller UUID := auth.uid();
  _is_boss BOOLEAN := false;
  _caller_role TEXT;
  _categories_count BIGINT := 0;
  _products_count BIGINT := 0;
  _storage_bytes BIGINT := 0;
  _storage_formatted TEXT := '0 KB';
BEGIN
  IF _caller IS NULL THEN
    RAISE EXCEPTION 'المستخدم غير مسجل الدخول';
  END IF;

  -- 1. فحص الرتبة
  SELECT role INTO _caller_role FROM public.user_roles WHERE user_id = _caller LIMIT 1;
  _is_boss := (_caller_role = 'boss');

  -- السماح للـ Boss دائماً، أو للمالك بفحص حسابه وحسابات كاشيراته
  IF NOT _is_boss AND _caller <> _target_user_id AND public.get_owner_id(_target_user_id) <> _caller THEN
    RAISE EXCEPTION 'غير مصرح: هذا الإجراء مخصص للمدير العام أو مالك الحساب فقط';
  END IF;

  -- 2. حساب عدد الأصناف
  SELECT count(*) INTO _categories_count
  FROM public.categories
  WHERE user_id = _target_user_id;

  -- 3. حساب عدد المنتجات النشطة غير المؤرشفة
  SELECT count(*) INTO _products_count
  FROM public.products
  WHERE user_id = _target_user_id AND (archived IS NULL OR archived = false);

  -- 4. حساب المساحة التخزينية المستخدمة من storage.objects بأمان كامل
  SELECT coalesce(sum((metadata->>'size')::bigint), 0) INTO _storage_bytes
  FROM storage.objects
  WHERE (storage.foldername(name))[1] = _target_user_id::text 
     OR name LIKE _target_user_id::text || '/%'
     OR owner = _target_user_id
     OR owner_id = _target_user_id::text;

  -- 5. التنسيق
  IF _storage_bytes >= 1073741824 THEN
    _storage_formatted := round((_storage_bytes / 1073741824.0)::numeric, 2) || ' GB';
  ELSIF _storage_bytes >= 1048576 THEN
    _storage_formatted := round((_storage_bytes / 1048576.0)::numeric, 2) || ' MB';
  ELSIF _storage_bytes >= 1024 THEN
    _storage_formatted := round((_storage_bytes / 1024.0)::numeric, 2) || ' KB';
  ELSE
    _storage_formatted := _storage_bytes || ' B';
  END IF;

  RETURN jsonb_build_object(
    'categories_count', _categories_count,
    'products_count', _products_count,
    'storage_bytes', _storage_bytes,
    'storage_formatted', _storage_formatted
  );
END;
$function$
;

-- FUNCTION guard_debt_writeoff_status | normalized md5 7926f128f79f1c4878ce10a850461eb7
CREATE OR REPLACE FUNCTION public.guard_debt_writeoff_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status = 'written_off'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'written_off')
     AND auth.uid() IS NOT NULL
     AND COALESCE(current_setting('app.debt_writeoff_internal', true), '') <> '1' THEN
    RAISE EXCEPTION 'شطب الدين يتم من شاشة الديون بصلاحية مالك المتجر فقط' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$
;

-- FUNCTION guard_expenses_direct_reverse | normalized md5 30fafac4f7a055628818e3933399fd72
CREATE OR REPLACE FUNCTION public.guard_expenses_direct_reverse()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.is_reversed IS DISTINCT FROM OLD.is_reversed THEN
    IF COALESCE(current_setting('app.internal_expense_reverse', true), '') <> '1' THEN
      RAISE EXCEPTION 'لا يمكن تعديل حالة عكس المصروف مباشرة؛ يجب استخدام delete_expense_atomic'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$
;

-- FUNCTION guard_fx_change_during_open_shift | normalized md5 6640aa1bda4677c38c5c0572cc08234b
CREATE OR REPLACE FUNCTION public.guard_fx_change_during_open_shift()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _owner uuid := COALESCE(NEW.user_id, OLD.user_id);
BEGIN
  IF (NEW.primary_currency IS DISTINCT FROM OLD.primary_currency)
     OR (NEW.exchange_rates IS DISTINCT FROM OLD.exchange_rates)
     OR (NEW.sync_settings->'primaryCurrency' IS DISTINCT FROM OLD.sync_settings->'primaryCurrency')
     OR (NEW.sync_settings->'enabledCurrencies' IS DISTINCT FROM OLD.sync_settings->'enabledCurrencies')
     OR (NEW.sync_settings->'slot1Code' IS DISTINCT FROM OLD.sync_settings->'slot1Code')
     OR (NEW.sync_settings->'slot2Code' IS DISTINCT FROM OLD.sync_settings->'slot2Code')
     OR (NEW.sync_settings->'exchangeRates' IS DISTINCT FROM OLD.sync_settings->'exchangeRates') THEN
    IF _owner IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock(hashtext('shift_fx:' || _owner::text));
      IF EXISTS (
        SELECT 1
          FROM public.cash_shifts
         WHERE user_id = _owner
           AND closed_at IS NULL
      ) THEN
        RAISE EXCEPTION 'لا يمكن تغيير العملة الأساسية أو أسعار الصرف ما دامت هناك وردية نقدية مفتوحة؛ يرجى إغلاق الوردية أولاً'
          USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$
;

-- FUNCTION guard_partners_financial_direct_write | normalized md5 b0849572d80b6575c27e55adb8489bc0
CREATE OR REPLACE FUNCTION public.guard_partners_financial_direct_write()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NULLIF(current_setting('app.partner_source', true), '') IS NULL
     AND current_user IN ('authenticated', 'anon') THEN
    IF NEW.current_balance IS DISTINCT FROM OLD.current_balance
       OR NEW.pending_profit IS DISTINCT FROM OLD.pending_profit
       OR NEW.confirmed_profit IS DISTINCT FROM OLD.confirmed_profit
       OR NEW.total_profit_earned IS DISTINCT FROM OLD.total_profit_earned
       OR NEW.total_withdrawn IS DISTINCT FROM OLD.total_withdrawn
       OR NEW.initial_capital IS DISTINCT FROM OLD.initial_capital
       OR NEW.current_capital IS DISTINCT FROM OLD.current_capital
       OR NEW.profit_history IS DISTINCT FROM OLD.profit_history
       OR NEW.expense_history IS DISTINCT FROM OLD.expense_history
       OR NEW.withdrawal_history IS DISTINCT FROM OLD.withdrawal_history
       OR NEW.capital_history IS DISTINCT FROM OLD.capital_history
       OR NEW.pending_profit_details IS DISTINCT FROM OLD.pending_profit_details THEN
      RAISE EXCEPTION 'لا يُسمح بتعديل الحقول المالية للشركاء مباشرة؛ استخدم الدوال المخصصة لذلك'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$
;

-- FUNCTION guard_refunded_invoice_status | normalized md5 18d218b08943079176f0f9ef9b5789f2
CREATE OR REPLACE FUNCTION public.guard_refunded_invoice_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND (NEW.status = 'refunded' OR OLD.status = 'refunded')
     AND COALESCE(current_setting('app.refund_context', true), '') <> 'allowed'
  THEN
    RAISE EXCEPTION 'Refund status can only be changed by the protected refund operation';
  END IF;
  RETURN NEW;
END;
$function$
;

-- FUNCTION guard_written_off_debt | normalized md5 4f72a7e51b9c1f0727de94d08da3865e
CREATE OR REPLACE FUNCTION public.guard_written_off_debt()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NOT NULL
     AND (NEW.status IS DISTINCT FROM OLD.status
          OR NEW.total_paid IS DISTINCT FROM OLD.total_paid
          OR NEW.remaining_debt IS DISTINCT FROM OLD.remaining_debt
          OR NEW.total_debt IS DISTINCT FROM OLD.total_debt) THEN
    RAISE EXCEPTION 'هذا الدين مشطوب ولا يقبل دفعات أو تعديلات' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$
;

-- FUNCTION guard_written_off_invoice | normalized md5 63dee8eeb65c63d7623156d76369e17c
CREATE OR REPLACE FUNCTION public.guard_written_off_invoice()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NOT NULL
     AND (NEW.status IS DISTINCT FROM OLD.status
          OR NEW.total IS DISTINCT FROM OLD.total
          OR NEW.profit IS DISTINCT FROM OLD.profit
          OR NEW.debt_paid IS DISTINCT FROM OLD.debt_paid
          OR NEW.debt_remaining IS DISTINCT FROM OLD.debt_remaining) THEN
    RAISE EXCEPTION 'هذه الفاتورة دينها مشطوب ولا يمكن استردادها أو تعديل مبالغها' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$
;

-- FUNCTION handle_new_user | normalized md5 3d4b1174b32f8c58299b7b9025989859
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _full_name text;
  _phone text;
BEGIN
  -- Sanitize full_name
  _full_name := NEW.raw_user_meta_data->>'full_name';
  IF _full_name IS NOT NULL THEN
    _full_name := trim(_full_name);
    _full_name := left(_full_name, 100);
    _full_name := regexp_replace(_full_name, '<[^>]+>', '', 'g');
  END IF;

  -- Extract phone
  _phone := NEW.raw_user_meta_data->>'phone';
  IF _phone IS NOT NULL THEN
    _phone := trim(_phone);
    _phone := left(_phone, 20);
    _phone := regexp_replace(_phone, '<[^>]+>', '', 'g');
  END IF;
  
  INSERT INTO public.profiles (user_id, full_name, phone)
  VALUES (NEW.id, _full_name, _phone);
  
  RETURN NEW;
END;
$function$
;

-- FUNCTION handle_new_user_role | normalized md5 de29ece49f7ae4c1d46df3d5ae397dd3
CREATE OR REPLACE FUNCTION public.handle_new_user_role()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = NEW.id) THEN
    INSERT INTO public.user_roles (user_id, role, owner_id, is_active)
    VALUES (NEW.id, 'admin', NEW.id, true)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$function$
;

-- FUNCTION handle_updated_at | normalized md5 a3a8dcc15e232b73d3f5c4abfa43f3d8
CREATE OR REPLACE FUNCTION public.handle_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$
;

-- FUNCTION hard_delete_product_atomic | normalized md5 942aa79072afb20170fe19dae06a5da5
CREATE OR REPLACE FUNCTION public.hard_delete_product_atomic(_product_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _owner uuid := public.get_owner_id(auth.uid());
BEGIN
  IF auth.uid() IS NULL OR _owner IS NULL THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  DELETE FROM public.warehouse_stock WHERE product_id = _product_id;
  DELETE FROM public.products WHERE id = _product_id AND user_id = _owner;
  RETURN jsonb_build_object('success', true, 'deleted_id', _product_id);
END;
$function$
;

-- FUNCTION has_paid_write_access | normalized md5 36cbc5c35850b40e365594b0eca66be8
CREATE OR REPLACE FUNCTION public.has_paid_write_access(_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    public.is_boss(_user_id)
    OR EXISTS (
      SELECT 1
      FROM public.app_licenses al
      WHERE al.user_id = public.get_owner_id(_user_id)
        AND COALESCE(al.is_revoked, false) = false
        AND al.expires_at > now()
        AND (
          COALESCE(al.is_trial, false) = false
          OR EXISTS (
            SELECT 1 FROM public.profiles p
            WHERE p.user_id = al.user_id
              AND NULLIF(btrim(p.phone), '') IS NOT NULL
          )
        )
    );
$function$
;

-- FUNCTION has_role | normalized md5 5fee9f9f1565a63d5f7e21324e7f96e3
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Validate that _user_id is not null
  IF _user_id IS NULL THEN
    RETURN false;
  END IF;
  
  RETURN EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = _user_id
      AND role = _role
  );
END;
$function$
;

-- FUNCTION is_boss | normalized md5 004cd9fcd380a15d7a3d6e234eb1560a
CREATE OR REPLACE FUNCTION public.is_boss(_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF _user_id IS NULL THEN
    RETURN false;
  END IF;
  
  RETURN EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = _user_id
      AND role = 'boss'
  );
END;
$function$
;

-- FUNCTION is_device_banned | normalized md5 428286ab90d42c3c000023a5f7c25450
CREATE OR REPLACE FUNCTION public.is_device_banned(p_device_id text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.banned_devices
    WHERE device_id = NULLIF(trim(p_device_id), '')
  );
$function$
;

-- FUNCTION is_first_user | normalized md5 5b1341634c938da85700854390431d6d
CREATE OR REPLACE FUNCTION public.is_first_user()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT NOT EXISTS (SELECT 1 FROM public.user_roles)
$function$
;

-- FUNCTION is_license_valid | normalized md5 24ccab0e07c310c56d7662facfd9c646
CREATE OR REPLACE FUNCTION public.is_license_valid(_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _owner_id uuid;
  _license_valid boolean;
BEGIN
  -- Get the owner id (self if owner, or owner_id if cashier)
  _owner_id := public.get_owner_id(_user_id);
  
  IF _owner_id IS NULL THEN
    RETURN false;
  END IF;
  
  -- Check if license exists and is valid
  SELECT EXISTS (
    SELECT 1
    FROM public.app_licenses
    WHERE user_id = _owner_id
      AND expires_at > now()
      AND is_revoked = false
  ) INTO _license_valid;
  
  RETURN _license_valid;
END;
$function$
;

-- FUNCTION is_store_owner | normalized md5 9a7ded0ed8a35bb6743b045a79b63351
CREATE OR REPLACE FUNCTION public.is_store_owner(_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT _user_id IS NOT NULL
     AND (public.get_owner_id(_user_id) = _user_id OR public.is_boss(_user_id));
$function$
;

-- FUNCTION issue_offline_lease | normalized md5 6a69f9213b77f9a4f0f36bbf887e8ab7
CREATE OR REPLACE FUNCTION public.issue_offline_lease(p_device_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth', 'extensions'
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_owner_id uuid;
  v_license record;
  v_expires_at timestamptz;
  v_valid_until_epoch bigint;
  v_payload text;
  v_secret text;
  v_signature text;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Unauthorized: User not authenticated'; END IF;
  v_owner_id := public.get_owner_id(v_user_id);
  SELECT * INTO v_license FROM public.app_licenses WHERE user_id = v_owner_id AND (is_revoked IS FALSE OR is_revoked IS NULL) LIMIT 1;
  IF v_license IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'NO_ACTIVE_LICENSE'); END IF;
  IF v_license.device_id IS NOT NULL AND v_license.allow_multi_device IS NOT TRUE AND v_license.device_id <> p_device_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'DEVICE_MISMATCH');
  END IF;
  v_expires_at := LEAST(v_license.expires_at, now() + (COALESCE(v_license.max_offline_days, 15) || ' days')::interval);
  v_valid_until_epoch := EXTRACT(EPOCH FROM v_expires_at)::bigint;
  v_secret := COALESCE(v_license.offline_lease_secret, 'FLOWPOS_PRO_FALLBACK_SALT_2026');
  v_payload := v_license.id || ':' || p_device_id || ':' || v_valid_until_epoch || ':' || COALESCE(v_license.max_offline_invoices, 100);
  v_signature := encode(sha256((v_payload || ':' || v_secret)::bytea), 'hex');
  PERFORM set_config('app.internal_lease_issue', '1', true);
  UPDATE public.app_licenses SET last_lease_issued_at = now() WHERE id = v_license.id;
  RETURN jsonb_build_object('success', true, 'license_id', v_license.id, 'device_id', p_device_id, 'valid_until_epoch', v_valid_until_epoch,
    'max_offline_invoices', COALESCE(v_license.max_offline_invoices, 100), 'signature', v_signature, 'issued_at_epoch', EXTRACT(EPOCH FROM now())::bigint);
END;
$function$
;

-- FUNCTION issue_store_credit_atomic | normalized md5 618bb61818900d4d45ca2f74fa230b99
CREATE OR REPLACE FUNCTION public.issue_store_credit_atomic(_customer_id uuid, _amount numeric, _reason text, _invoice_number text, _operation_id text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _o uuid := public._credit_actor(true); _id uuid;
BEGIN
  IF COALESCE(_amount,0) <= 0 THEN RAISE EXCEPTION 'المبلغ يجب أن يكون أكبر من الصفر'; END IF;
  IF COALESCE(_operation_id,'') = '' THEN RAISE EXCEPTION 'معرّف العملية مطلوب'; END IF;
  PERFORM 1 FROM public.customers WHERE id=_customer_id AND user_id=_o FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'العميل غير موجود'; END IF;
  SELECT id INTO _id FROM public.customer_credit_ledger WHERE user_id=_o AND operation_id=_operation_id AND entry_type='issue';
  IF _id IS NOT NULL THEN RETURN _id; END IF;
  PERFORM public.assert_period_open(_o, CURRENT_DATE, 'إصدار رصيد عميل');
  INSERT INTO public.customer_credit_ledger(user_id,customer_id,entry_type,amount,invoice_number,reason,operation_id,created_by)
  VALUES (_o,_customer_id,'issue',round(_amount,8),_invoice_number,_reason,_operation_id,auth.uid()) RETURNING id INTO _id;
  RETURN _id;
END $function$
;

-- FUNCTION link_purchase_to_supplier_atomic | normalized md5 e77abcbb843451a002208b5ceb7d3116
CREATE OR REPLACE FUNCTION public.link_purchase_to_supplier_atomic(_invoice_id uuid, _supplier_id uuid, _paid_amount numeric DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _o uuid := public._supplier_owner();
  _inv record;
  _items_count int := 0;
  _total_qty numeric := 0;
  _items_total numeric := 0;
  _total numeric;
  _paid numeric := GREATEST(COALESCE(_paid_amount, 0), 0);
BEGIN
  SELECT * INTO _inv
    FROM public.purchase_invoices
   WHERE id = _invoice_id AND user_id = _o
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'فاتورة الشراء غير موجودة';
  END IF;

  PERFORM 1
    FROM public.suppliers
   WHERE id = _supplier_id AND user_id = _o AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'المورد غير موجود أو غير فعّال';
  END IF;

  IF _inv.supplier_id IS NOT NULL THEN
    RETURN jsonb_build_object('success', true, 'already_linked', true);
  END IF;

  IF COALESCE(_inv.payment_status, '') = 'cancelled' OR COALESCE(_inv.status, '') = 'cancelled' THEN
    RAISE EXCEPTION 'الفاتورة ملغاة';
  END IF;

  IF COALESCE(_inv.status, 'draft') NOT IN ('finalized', 'completed') THEN
    RAISE EXCEPTION 'يجب اعتماد فاتورة الشراء قبل ربطها بمورد';
  END IF;

  PERFORM public.assert_period_open(_o, _inv.invoice_date::date, 'ربط فاتورة شراء بمورد');

  SELECT COUNT(*)::int,
         COALESCE(SUM(quantity), 0),
         COALESCE(SUM(quantity * COALESCE(cost_price, 0)), 0)
    INTO _items_count, _total_qty, _items_total
    FROM public.purchase_invoice_items
   WHERE invoice_id = _invoice_id;

  _total := CASE
    WHEN _items_count > 0 THEN round(_items_total, 4)
    ELSE round(COALESCE(_inv.actual_grand_total, _inv.expected_grand_total, 0), 4)
  END;

  IF _total <= 0 THEN
    RAISE EXCEPTION 'إجمالي الفاتورة صفر';
  END IF;

  IF _paid > _total + 0.0001 THEN
    RAISE EXCEPTION 'المدفوع أكبر من إجمالي الفاتورة';
  END IF;

  INSERT INTO public.supplier_ledger_entries(user_id, supplier_id, entry_type, amount, reference_type, reference_id, note, created_by)
  VALUES (_o, _supplier_id, 'purchase', _total, 'purchase_invoice', _invoice_id::text, 'فاتورة شراء ' || _inv.invoice_number, auth.uid());

  IF _paid > 0 THEN
    INSERT INTO public.supplier_ledger_entries(user_id, supplier_id, entry_type, amount, reference_type, reference_id, payment_method, note, created_by)
    VALUES (_o, _supplier_id, 'payment', -round(_paid, 4), 'purchase_invoice', _invoice_id::text, _inv.payment_method, 'دفعة عند الشراء ' || _inv.invoice_number, auth.uid());
  END IF;

  UPDATE public.purchase_invoices
     SET supplier_id = _supplier_id,
         amount_paid = _paid,
         actual_items_count = CASE WHEN _items_count > 0 THEN _items_count ELSE actual_items_count END,
         actual_total_quantity = CASE WHEN _items_count > 0 THEN _total_qty ELSE actual_total_quantity END,
         actual_grand_total = CASE WHEN _items_count > 0 THEN _total ELSE actual_grand_total END,
         updated_at = now()
   WHERE id = _invoice_id;

  RETURN jsonb_build_object('success', true, 'total', _total, 'paid', _paid, 'due', _total - _paid);
END;
$function$
;

-- FUNCTION log_product_price_change | normalized md5 0dc379be36068430ea060fc1fe7dd824
CREATE OR REPLACE FUNCTION public.log_product_price_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.cost_price IS DISTINCT FROM OLD.cost_price OR NEW.sale_price IS DISTINCT FROM OLD.sale_price THEN
    INSERT INTO public.activity_log(user_id, actor_id, action_type, entity_type, entity_id, entity_name, description, metadata)
    VALUES (NEW.user_id, auth.uid(), 'product_price_changed', 'product', NEW.id::text, NEW.name,
      'تغيير سعر المنتج ' || NEW.name,
      jsonb_build_object('old_cost',OLD.cost_price,'new_cost',NEW.cost_price,'old_sale',OLD.sale_price,'new_sale',NEW.sale_price,
        'source', COALESCE(NULLIF(current_setting('app.stock_source', true),''),'direct_update')));
  END IF;
  RETURN NEW;
END $function$
;

-- FUNCTION lookup_serial | normalized md5 7c15606723aa61554bea0a78dda3d178
CREATE OR REPLACE FUNCTION public.lookup_serial(_serial text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _o uuid := public.get_owner_id(auth.uid());
BEGIN
  IF auth.uid() IS NULL OR _o IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'serial', s.serial, 'status', s.status, 'product_id', s.product_id, 'product_name', p.name,
      'sold_invoice_number', s.sold_invoice_number, 'sold_at', s.sold_at, 'customer_name', s.customer_name,
      'warranty_until', s.warranty_until, 'cost_price', s.cost_price,
      'events', (SELECT COALESCE(jsonb_agg(jsonb_build_object('event',e.event,'ref',e.ref,'at',e.created_at) ORDER BY e.created_at),'[]'::jsonb) FROM public.product_serial_events e WHERE e.serial_id=s.id)))
    FROM public.product_serials s JOIN public.products p ON p.id=s.product_id
    WHERE s.user_id=_o AND lower(s.serial)=lower(trim(_serial))), '[]'::jsonb);
END $function$
;

-- FUNCTION mark_all_support_messages_read | normalized md5 df3d693e5a32063cb014903c0927f7b3
CREATE OR REPLACE FUNCTION public.mark_all_support_messages_read()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_updated integer := 0;
BEGIN
  -- التحقق من أن المستدعي هو المدير العام حصراً
  IF NOT public.is_boss(v_caller) THEN
    RETURN jsonb_build_object('success', false, 'error', 'غير مصرح: هذا الإجراء مخصص للمدير العام فقط');
  END IF;

  -- تحديث كافة رسائل العملاء غير المقروءة إلى مقروءة
  UPDATE public.support_messages
  SET is_read = true
  WHERE is_read = false AND sender_role = 'user';

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  RETURN jsonb_build_object('success', true, 'updated_count', v_updated);
END;
$function$
;

-- FUNCTION mark_invoice_digital | normalized md5 c52382cdb4c18f30c714b8c67497e651
CREATE OR REPLACE FUNCTION public.mark_invoice_digital(_invoice_number text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _caller uuid := auth.uid();
  _owner uuid;
  _inv public.invoices%ROWTYPE;
  _sale_tx public.shift_transactions%ROWTYPE;
  _shift public.cash_shifts%ROWTYPE;
BEGIN
  IF _caller IS NULL THEN
    RAISE EXCEPTION 'غير مصرح';
  END IF;
  _owner := public.get_owner_id(_caller);
  IF _owner IS NULL THEN
    RAISE EXCEPTION 'لم يتم العثور على سياق المتجر';
  END IF;

  SELECT * INTO _inv
    FROM public.invoices
   WHERE invoice_number = _invoice_number
     AND user_id = _owner
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF COALESCE(_inv.status, '') IN ('refunded', 'cancelled', 'written_off') THEN
    RAISE EXCEPTION 'لا يمكن تعديل طريقة الدفع لفاتورة مستردة أو ملغاة أو مشطوبة';
  END IF;

  PERFORM public.assert_period_open(_owner, _inv.date, 'تعديل طريقة الدفع');

  IF COALESCE(_inv.payment_method, 'cash') = 'digital' THEN
    RETURN false;
  END IF;

  -- Lock any cash sale transaction(s) linked to this invoice and their shift(s)
  FOR _sale_tx IN
    SELECT st.*
      FROM public.shift_transactions st
     WHERE st.user_id = _owner
       AND st.type = 'sale'
       AND st.reference_id IN (_inv.invoice_number, _inv.id::text)
     ORDER BY st.created_at ASC
     FOR UPDATE
  LOOP
    SELECT * INTO _shift
      FROM public.cash_shifts
     WHERE id = _sale_tx.shift_id
       AND user_id = _owner
     FOR UPDATE;

    IF FOUND THEN
      IF _shift.closed_at IS NOT NULL THEN
        RAISE EXCEPTION 'لا يمكن تحويل فاتورة مرتبطة بوردية مغلقة إلى دفع إلكتروني مباشرة';
      END IF;

      -- Record reversing settlement entry to remove the sale from cash drawer
      INSERT INTO public.shift_transactions (
        shift_id, user_id, type, amount, currency, currency_amount, exchange_rate, reference_id, notes
      ) VALUES (
        _sale_tx.shift_id,
        _owner,
        'transfer_out',
        COALESCE(_sale_tx.amount, 0),
        COALESCE(_sale_tx.currency, 'USD'),
        COALESCE(_sale_tx.currency_amount, _sale_tx.amount, 0),
        COALESCE(_sale_tx.exchange_rate, 1),
        'digital_reclass:' || _sale_tx.id::text,
        'تسوية تحويل الفاتورة ' || _inv.invoice_number || ' إلى دفع إلكتروني'
      )
      ON CONFLICT (shift_id, type, reference_id) DO NOTHING;

      IF FOUND THEN
        UPDATE public.cash_shifts
           SET expected_balance = round(COALESCE(expected_balance, 0) - COALESCE(_sale_tx.amount, 0), 8),
               updated_at = now()
         WHERE id = _sale_tx.shift_id
           AND user_id = _owner
           AND closed_at IS NULL;
      END IF;
    END IF;
  END LOOP;

  UPDATE public.invoices
     SET payment_method = 'digital',
         updated_at = now()
   WHERE id = _inv.id;

  RETURN true;
END $function$
;

-- FUNCTION normalize_debt_row | normalized md5 0934aae7c7908cdaeeee1b46ac43f1ea
CREATE OR REPLACE FUNCTION public.normalize_debt_row()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  NEW.total_debt := round(coalesce(NEW.total_debt, 0)::numeric, 8);
  NEW.total_paid := round(greatest(coalesce(NEW.total_paid, 0), 0)::numeric, 8);
  NEW.remaining_debt := round(greatest(NEW.total_debt - NEW.total_paid, 0)::numeric, 8);
  -- الحالات النهائية (مشطوب / ملغى): لا مستحق متبقٍ ولا تُعاد الحالة إلى مفتوح
  IF NEW.status IN ('written_off', 'cancelled') THEN
    NEW.remaining_debt := 0;
    RETURN NEW;
  END IF;
  IF NEW.remaining_debt <= 0.00000001 THEN
    NEW.status := 'fully_paid';
    NEW.remaining_debt := 0;
  ELSIF NEW.total_paid > 0 THEN
    NEW.status := 'partially_paid';
  ELSIF NEW.status IS NULL OR NEW.status IN ('fully_paid','partially_paid') THEN
    NEW.status := 'due';
  END IF;
  RETURN NEW;
END $function$
;

-- FUNCTION normalize_phone_number | normalized md5 1e01be044ad2f1628737c9a2aced4d51
CREATE OR REPLACE FUNCTION public.normalize_phone_number(p_phone text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_clean TEXT;
BEGIN
    IF p_phone IS NULL OR trim(p_phone) = '' THEN
        RETURN NULL;
    END IF;

    -- إزالة كافة الرموز والمسافات والأقواس والإبقاء على الأرقام فقط وعلامة الزائد
    v_clean := regexp_replace(trim(p_phone), '[^\+0-9]', '', 'g');

    -- تحويل 00 في بداية الرقم الدولي إلى +
    IF v_clean ~ '^00' THEN
        v_clean := '+' || substring(v_clean from 3);
    END IF;

    -- إذا كان الرقم السوري يبدأ بـ 09 ننسقه إلى +9639
    IF v_clean ~ '^09[0-9]{8}$' THEN
        v_clean := '+963' || substring(v_clean from 2);
    -- إذا كان الرقم التركي يبدأ بـ 05 ننسقه إلى +905
    ELSIF v_clean ~ '^05[0-9]{9}$' THEN
        v_clean := '+90' || substring(v_clean from 2);
    END IF;

    -- إذا لم يحمل علامة + وكان رقماً محلياً، نتركه نظيفاً من المسافات
    IF v_clean = '' THEN
        RETURN NULL;
    END IF;

    RETURN v_clean;
END;
$function$
;

-- FUNCTION notify_boss_on_subscription_request | normalized md5 10008aaa87c4c3355a55828abcb65638
CREATE OR REPLACE FUNCTION public.notify_boss_on_subscription_request()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  BEGIN
    INSERT INTO public.user_notifications (user_id, title, message, type, action_url, metadata, is_read, is_archived)
    SELECT DISTINCT ur.user_id,
           '🧾 طلب تجديد اشتراك جديد',
           COALESCE(NEW.payer_name, 'عميل') || ' — ' || COALESCE(NEW.plan_name, 'باقة')
             || COALESCE(' ($' || NEW.price_usd::text || ')', '')
             || ' — مرجع: ' || COALESCE(NEW.ref_code, '-'),
           'subscription_request',
           '/boss?request=' || NEW.id::text,
           jsonb_build_object('request_id', NEW.id, 'requester_id', NEW.user_id),
           false, false
    FROM public.user_roles ur
    WHERE ur.role::text = 'boss';
  EXCEPTION WHEN OTHERS THEN
    -- لا نمنع حفظ طلب العميل بسبب فشل الإشعار
    NULL;
  END;
  RETURN NEW;
END;
$function$
;

-- FUNCTION notify_on_support_message | normalized md5 1e8eeb8678287d342b3560ac0be32018
CREATE OR REPLACE FUNCTION public.notify_on_support_message()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_conv record; v_target_user uuid; v_title text; v_body text;
BEGIN
  SELECT * INTO v_conv FROM public.support_conversations WHERE id = NEW.conversation_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF NEW.sender_role IN ('boss', 'admin') THEN
    v_target_user := v_conv.user_id;
    v_title := '💬 رسالة جديدة من الدعم الفني';
    v_body := substring(NEW.message from 1 for 100);
    INSERT INTO public.user_notifications (user_id, title, message, type, action_url)
    VALUES (v_target_user, v_title, v_body, 'support_reply', '/contact');
  END IF;
  RETURN NEW;
END;
$function$
;

-- FUNCTION partner_deposit_atomic | normalized md5 a9e7b1e1bd8c1e4c6434b8fb6c5c203c
CREATE OR REPLACE FUNCTION public.partner_deposit_atomic(_partner_id uuid, _amount_usd numeric, _deposit_target text DEFAULT 'capital'::text, _notes text DEFAULT NULL::text, _shift_id uuid DEFAULT NULL::uuid, _currency text DEFAULT 'USD'::text, _original_amount numeric DEFAULT NULL::numeric, _exchange_rate numeric DEFAULT 1.0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _uid uuid := auth.uid();
  _owner uuid;
  _partner record;
  _tx_id text := gen_random_uuid()::text;
  _amt_usd numeric := round(COALESCE(_amount_usd, 0), 4);
  _ccy text := upper(COALESCE(NULLIF(trim(_currency), ''), 'USD'));
  _orig_amt numeric;
  _rate numeric;
  _cap_record jsonb;
  _tx_note text;
BEGIN
  PERFORM set_config('app.partner_source', 'partner_deposit_atomic', true);
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'المستخدم غير مسجل الدخول';
  END IF;

  IF NOT public.is_store_owner(_uid) THEN
    RAISE EXCEPTION 'هذه العملية مخصصة لمالك المتجر فقط' USING ERRCODE = '42501';
  END IF;

  _owner := public.get_owner_id(_uid);
  IF _owner IS NULL THEN
    RAISE EXCEPTION 'لم يتم العثور على حساب المالك';
  END IF;

  IF _deposit_target IS NULL OR _deposit_target NOT IN ('capital', 'balance') THEN
    RAISE EXCEPTION 'وجهة الإيداع غير صالحة: %', COALESCE(_deposit_target, 'NULL');
  END IF;

  IF _amt_usd <= 0 OR _amt_usd::text IN ('NaN','Infinity','-Infinity') THEN
    RAISE EXCEPTION 'مبلغ الإيداع يجب أن يكون أكبر من الصفر';
  END IF;

  IF _original_amount::text IN ('NaN','Infinity','-Infinity')
     OR _exchange_rate::text IN ('NaN','Infinity','-Infinity') THEN
    RAISE EXCEPTION 'المبلغ أو سعر الصرف غير صالح';
  END IF;
  IF _ccy = 'USD' THEN
    _rate := 1.0;
    _orig_amt := round(_amt_usd, 8);
  ELSE
    _rate := COALESCE(_exchange_rate, 0);
    IF _rate <= 0 THEN
      RAISE EXCEPTION 'سعر الصرف غير صالح';
    END IF;
    _orig_amt := round(COALESCE(_original_amount, _amt_usd * _rate), 2);
    IF _orig_amt <= 0 THEN
      RAISE EXCEPTION 'المبلغ الأصلي غير صالح';
    END IF;
    IF _original_amount IS NOT NULL AND _original_amount > 0 THEN
      IF abs(_orig_amt - round(_amt_usd * _rate, 2)) > (0.005 + 0.005 * _rate) THEN
        RAISE EXCEPTION 'تعارض في تحويل العملة: المبلغ الأصلي (%) لا يطابق المبلغ بالدولار (%) × سعر الصرف (%)',
          _orig_amt, _amt_usd, _rate;
      END IF;
    END IF;
  END IF;

  PERFORM public.assert_period_open(_owner, CURRENT_DATE, 'إيداع شريك');

  IF _shift_id IS NOT NULL THEN
    PERFORM 1 FROM public.cash_shifts
    WHERE id = _shift_id AND user_id = _owner AND closed_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'الوردية غير موجودة أو مغلقة أو لا تتبع لهذا المتجر';
    END IF;
  END IF;

  SELECT * INTO _partner
  FROM public.partners
  WHERE id = _partner_id AND user_id = _owner
  FOR UPDATE;

  IF _partner IS NULL THEN
    RAISE EXCEPTION 'الشريك غير موجود أو غير تابع لهذا المتجر';
  END IF;

  _tx_note := COALESCE(_notes, CASE WHEN _deposit_target = 'balance' THEN 'إيداع رصيد للشريك' ELSE 'إيداع رأس مال' END);
  IF _ccy <> 'USD' AND _orig_amt IS NOT NULL THEN
    _tx_note := _tx_note || ' (' || _orig_amt::text || ' ' || _ccy || ')';
  END IF;

  _cap_record := jsonb_build_object(
    'id', _tx_id,
    'amount', _amt_usd,
    'type', 'deposit',
    'target', _deposit_target,
    'currency', _ccy,
    'originalAmount', _orig_amt,
    'exchangeRate', _rate,
    'date', now(),
    'notes', _tx_note
  );

  IF _deposit_target = 'balance' THEN
    UPDATE public.partners SET
      current_balance = round(COALESCE(current_balance, 0) + _amt_usd, 4),
      capital_history = COALESCE(capital_history, '[]'::jsonb) || _cap_record,
      updated_at = now()
    WHERE id = _partner_id;
  ELSE
    UPDATE public.partners SET
      initial_capital = round(COALESCE(initial_capital, 0) + _amt_usd, 4),
      current_capital = round(COALESCE(current_capital, 0) + _amt_usd, 4),
      capital_history = COALESCE(capital_history, '[]'::jsonb) || _cap_record,
      updated_at = now()
    WHERE id = _partner_id;
  END IF;

  IF _shift_id IS NOT NULL THEN
    INSERT INTO public.shift_transactions (
      shift_id, user_id, type, amount, currency_amount, currency, exchange_rate, notes, reference_id
    ) VALUES (
      _shift_id, _owner, 'deposit_capital', _amt_usd, _orig_amt, _ccy, _rate,
      _tx_note || ' - الشريك: ' || _partner.name,
      _partner_id::text || ':' || gen_random_uuid()::text
    );

    UPDATE public.cash_shifts
       SET expected_balance = round(COALESCE(expected_balance, 0) + _amt_usd, 8),
           updated_at = now()
     WHERE id = _shift_id AND user_id = _owner AND closed_at IS NULL;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'partner_id', _partner_id,
    'amount_usd', _amt_usd,
    'currency', _ccy,
    'original_amount', _orig_amt,
    'deposit_target', _deposit_target,
    'new_balance', CASE WHEN _deposit_target = 'balance' THEN round(COALESCE(_partner.current_balance, 0) + _amt_usd, 4) ELSE _partner.current_balance END,
    'new_capital', CASE WHEN _deposit_target = 'capital' THEN round(COALESCE(_partner.current_capital, 0) + _amt_usd, 4) ELSE _partner.current_capital END
  );
END;
$function$
;

-- FUNCTION partner_withdrawal_atomic | normalized md5 1ad111af6a8f66e00187532478dd65e4
CREATE OR REPLACE FUNCTION public.partner_withdrawal_atomic(_partner_id uuid, _amount numeric, _withdrawal_type text, _notes text DEFAULT NULL::text, _shift_id uuid DEFAULT NULL::uuid, _currency text DEFAULT 'USD'::text, _original_amount numeric DEFAULT NULL::numeric, _exchange_rate numeric DEFAULT 1.0, _operation_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_owner uuid := public.get_owner_id(v_caller);
  v_partner public.partners%ROWTYPE;
  v_amt numeric := round(COALESCE(_amount, 0)::numeric, 4);
  v_ccy text := upper(COALESCE(NULLIF(trim(_currency), ''), 'USD'));
  v_op_id text := NULLIF(trim(COALESCE(_operation_id, '')), '');
  v_orig_amt numeric;
  v_rate numeric;
  v_avail_profit numeric := 0;
  v_avail_capital numeric := 0;
  v_profit_part numeric := 0;
  v_capital_part numeric := 0;
  v_new_balance numeric;
  v_new_capital numeric;
  v_withdrawals jsonb := '[]'::jsonb;
  v_capital_entries jsonb := '[]'::jsonb;
  v_note_text text;
  v_shift_label text;
  v_request jsonb;
  v_recorded_request jsonb;
  v_result jsonb;
  v_profit_original numeric;
  v_capital_original numeric;
  v_cap_rate numeric;
BEGIN
  PERFORM set_config('app.partner_source', 'partner_withdrawal_atomic', true);
  IF v_op_id IS NOT NULL THEN
    PERFORM set_config('app.partner_ref', v_op_id, true);
  END IF;

  IF v_caller IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'غير مصرح';
  END IF;

  IF NOT public.is_store_owner(v_caller) THEN
    RAISE EXCEPTION 'هذه العملية مخصصة لمالك المتجر فقط' USING ERRCODE = '42501';
  END IF;

  IF _withdrawal_type IS NULL OR _withdrawal_type NOT IN ('profit', 'capital', 'auto') THEN
    RAISE EXCEPTION 'نوع السحب غير صالح: %', COALESCE(_withdrawal_type, 'NULL');
  END IF;

  IF v_amt <= 0 OR v_amt::text IN ('NaN', 'Infinity', '-Infinity') THEN
    RAISE EXCEPTION 'المبلغ يجب أن يكون أكبر من الصفر';
  END IF;

  IF v_op_id IS NOT NULL AND length(v_op_id) > 128 THEN
    RAISE EXCEPTION 'معرّف العملية غير صالح';
  END IF;

  IF _original_amount::text IN ('NaN', 'Infinity', '-Infinity')
     OR _exchange_rate::text IN ('NaN', 'Infinity', '-Infinity') THEN
    RAISE EXCEPTION 'المبلغ أو سعر الصرف غير صالح';
  END IF;

  -- KD-08 / D-10: a capital withdrawal in a foreign currency is valued at the ORIGINAL deposit rate
  -- (weighted over the partner's capital deposits). The server computes the USD amount itself.
  IF _withdrawal_type = 'capital' AND v_ccy <> 'USD' THEN
    IF _original_amount IS NULL OR _original_amount <= 0 THEN
      RAISE EXCEPTION 'المبلغ الأصلي مطلوب لسحب رأس المال بعملة أجنبية';
    END IF;
    SELECT * INTO v_partner FROM public.partners WHERE id = _partner_id AND user_id = v_owner;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'الشريك غير موجود أو غير تابع للمتجر';
    END IF;
    SELECT COALESCE(SUM((h->>'originalAmount')::numeric) / NULLIF(SUM((h->>'amount')::numeric), 0), 0)
      INTO v_cap_rate
      FROM jsonb_array_elements(COALESCE(v_partner.capital_history, '[]'::jsonb)) h
     WHERE h->>'type' = 'deposit'
       AND COALESCE((h->>'amount')::numeric, 0) > 0
       AND COALESCE((h->>'originalAmount')::numeric, 0) > 0;
    IF COALESCE(v_cap_rate, 0) <= 0 THEN
      RAISE EXCEPTION 'لا يمكن حساب سعر الإيداع الأصلي لرأس مال الشريك';
    END IF;
    v_amt := round(_original_amount / v_cap_rate, 4);
  END IF;

  -- Strict FX validation
  IF v_ccy = 'USD' THEN
    IF _exchange_rate IS NOT NULL AND abs(_exchange_rate - 1.0) > 0.0001 THEN
      RAISE EXCEPTION 'سعر الصرف لعملة USD يجب أن يساوي 1 (المستلم: %)', _exchange_rate;
    END IF;
    v_rate := 1.0;
    IF _original_amount IS NOT NULL THEN
      IF _original_amount <= 0 THEN
        RAISE EXCEPTION 'المبلغ الأصلي غير صالح';
      END IF;
      v_orig_amt := round(_original_amount, 2);
      IF abs(v_orig_amt - round(v_amt, 2)) > 0.005 THEN
        RAISE EXCEPTION 'تعارض في المبلغ بالدولار: المبلغ الأصلي (%) لا يطابق المبلغ (%)',
          v_orig_amt, round(v_amt, 2);
      END IF;
    ELSE
      v_orig_amt := round(v_amt, 2);
    END IF;
  ELSE
    IF _withdrawal_type = 'capital' THEN
      v_rate := v_cap_rate;
    ELSE
      v_rate := COALESCE(_exchange_rate, 0);
    END IF;
    IF v_rate <= 0 THEN
      RAISE EXCEPTION 'سعر الصرف غير صالح لعملة %', v_ccy;
    END IF;
    IF _original_amount IS NOT NULL AND _original_amount <= 0 THEN
      RAISE EXCEPTION 'المبلغ الأصلي غير صالح';
    END IF;
    v_orig_amt := round(COALESCE(_original_amount, v_amt * v_rate), 2);
    IF v_orig_amt <= 0 THEN
      RAISE EXCEPTION 'المبلغ الأصلي غير صالح';
    END IF;
    IF _original_amount IS NOT NULL THEN
      IF abs(v_orig_amt - round(v_amt * v_rate, 2)) > (0.005 + 0.005 * v_rate) THEN
        RAISE EXCEPTION 'تعارض في تحويل العملة: المبلغ الأصلي (%) لا يطابق المبلغ بالدولار (%) × سعر الصرف (%)',
          v_orig_amt, v_amt, v_rate;
      END IF;
    END IF;
  END IF;

  -- KD-08 / D-10: automatic split (profit first, then capital) is for USD only. A foreign-currency withdrawal
  -- is sent as two separate rows (profit row, capital row), each valued at its own rate.
  IF _withdrawal_type = 'auto' AND v_ccy <> 'USD' THEN
    RAISE EXCEPTION 'السحب التلقائي بعملة أجنبية غير مدعوم: اسحب الربح ورأس المال في سطرين منفصلين';
  END IF;

  IF v_op_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('partner_withdraw_op:' || v_owner::text || ':' || v_op_id));
    v_request := jsonb_build_object(
      'partner_id', _partner_id, 'amount', v_amt, 'withdrawal_type', _withdrawal_type,
      'currency', v_ccy, 'original_amount', v_orig_amt, 'exchange_rate', v_rate,
      'shift_id', _shift_id, 'notes', NULLIF(trim(_notes), '')
    );
    SELECT request, result INTO v_recorded_request, v_result
      FROM public.accounting_rpc_receipts
     WHERE user_id = v_owner AND kind = 'partner_withdrawal' AND operation_id = v_op_id;
    IF FOUND THEN
      IF v_recorded_request IS DISTINCT FROM v_request THEN
        RAISE EXCEPTION 'معرّف السحب مرتبط بطلب مختلف';
      END IF;
      RETURN v_result || jsonb_build_object('already_processed', true);
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.partner_ledger_entries ple
       WHERE ple.user_id = v_owner AND ple.source = 'partner_withdrawal_atomic' AND ple.reference = v_op_id
    ) OR EXISTS (
      SELECT 1 FROM public.partners p
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(p.withdrawal_history, '[]'::jsonb)) h
       WHERE p.user_id = v_owner AND h->>'operationId' = v_op_id
    ) THEN
      RAISE EXCEPTION 'تم ترحيل معرّف السحب سابقاً دون إيصال كامل. راجع دفتر الشريك قبل إعادة المحاولة';
    END IF;
  END IF;

  PERFORM public.assert_period_open(v_owner, CURRENT_DATE, 'سحب شريك');

  IF _shift_id IS NOT NULL THEN
    PERFORM 1 FROM public.cash_shifts
    WHERE id = _shift_id AND user_id = v_owner AND closed_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'الوردية غير موجودة أو مغلقة أو لا تتبع لهذا المتجر';
    END IF;
  END IF;

  SELECT * INTO v_partner FROM public.partners WHERE id = _partner_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'الشريك غير موجود أو غير تابع للمتجر';
  END IF;

  v_note_text := COALESCE(_notes, '');
  IF v_ccy <> 'USD' AND v_orig_amt IS NOT NULL THEN
    v_note_text := v_note_text || ' (' || v_orig_amt::text || ' ' || v_ccy || ')';
  END IF;

  IF _withdrawal_type = 'profit' THEN
    IF v_amt > COALESCE(v_partner.current_balance, 0) THEN
      RAISE EXCEPTION 'رصيد أرباح الشريك لا يكفي (المتاح: %)', v_partner.current_balance;
    END IF;
    v_profit_part := v_amt;
    v_capital_part := 0;

    v_withdrawals := jsonb_build_array(
      jsonb_strip_nulls(jsonb_build_object(
        'id', gen_random_uuid()::text,
        'operationId', v_op_id,
        'amount', v_profit_part,
        'currency', v_ccy,
        'originalAmount', v_orig_amt,
        'exchangeRate', v_rate,
        'type', 'profit',
        'date', now()::text,
        'notes', v_note_text
      ))
    );

  ELSIF _withdrawal_type = 'capital' THEN
    IF v_amt > COALESCE(v_partner.current_capital, 0) THEN
      RAISE EXCEPTION 'رأس مال الشريك لا يكفي (المتاح: %)', v_partner.current_capital;
    END IF;
    v_profit_part := 0;
    v_capital_part := v_amt;

    v_withdrawals := jsonb_build_array(
      jsonb_strip_nulls(jsonb_build_object(
        'id', gen_random_uuid()::text,
        'operationId', v_op_id,
        'amount', v_capital_part,
        'currency', v_ccy,
        'originalAmount', v_orig_amt,
        'exchangeRate', v_rate,
        'type', 'capital',
        'date', now()::text,
        'notes', v_note_text
      ))
    );

    v_capital_entries := jsonb_build_array(
      jsonb_strip_nulls(jsonb_build_object(
        'id', gen_random_uuid()::text || '_cap',
        'operationId', v_op_id,
        'amount', v_capital_part,
        'currency', v_ccy,
        'originalAmount', v_orig_amt,
        'exchangeRate', v_rate,
        'type', 'withdrawal',
        'date', now()::text,
        'notes', v_note_text
      ))
    );

  ELSE
    -- _withdrawal_type = 'auto': deduct available profit first, remainder from capital
    v_avail_profit := GREATEST(COALESCE(v_partner.current_balance, 0), 0);
    v_avail_capital := GREATEST(COALESCE(v_partner.current_capital, 0), 0);

    IF v_amt > round(v_avail_profit + v_avail_capital, 4) THEN
      RAISE EXCEPTION 'الرصيد الإجمالي للشريك لا يكفي (أرباح متاحة: %، رأس مال متاح: %)',
        v_avail_profit, v_avail_capital;
    END IF;

    v_profit_part := round(LEAST(v_amt, v_avail_profit), 4);
    v_capital_part := round(v_amt - v_profit_part, 4);
    v_profit_original := round(v_orig_amt * v_profit_part / v_amt, 2);
    v_capital_original := v_orig_amt - v_profit_original;

    IF v_profit_part > 0 THEN
      v_withdrawals := v_withdrawals || jsonb_build_array(
        jsonb_strip_nulls(jsonb_build_object(
          'id', gen_random_uuid()::text,
          'operationId', v_op_id,
          'amount', v_profit_part,
          'currency', v_ccy,
          'originalAmount', v_profit_original,
          'exchangeRate', v_rate,
          'type', 'profit',
          'autoSplit', (v_capital_part > 0),
          'date', now()::text,
          'notes', v_note_text
        ))
      );
    END IF;

    IF v_capital_part > 0 THEN
      v_withdrawals := v_withdrawals || jsonb_build_array(
        jsonb_strip_nulls(jsonb_build_object(
          'id', gen_random_uuid()::text,
          'operationId', v_op_id,
          'amount', v_capital_part,
          'currency', v_ccy,
          'originalAmount', v_capital_original,
          'exchangeRate', v_rate,
          'type', 'capital',
          'autoSplit', (v_profit_part > 0),
          'date', now()::text,
          'notes', v_note_text
        ))
      );

      v_capital_entries := jsonb_build_array(
        jsonb_strip_nulls(jsonb_build_object(
          'id', gen_random_uuid()::text || '_cap',
          'operationId', v_op_id,
          'amount', v_capital_part,
          'currency', v_ccy,
          'originalAmount', v_capital_original,
          'exchangeRate', v_rate,
          'type', 'withdrawal',
          'autoSplit', (v_profit_part > 0),
          'date', now()::text,
          'notes', v_note_text
        ))
      );
    END IF;
  END IF;

  v_new_balance := round(COALESCE(v_partner.current_balance, 0) - v_profit_part, 4);
  v_new_capital := round(COALESCE(v_partner.current_capital, 0) - v_capital_part, 4);

  UPDATE public.partners
     SET current_balance = v_new_balance,
         current_capital = v_new_capital,
         total_withdrawn = round(COALESCE(total_withdrawn, 0) + v_amt, 4),
         withdrawal_history = COALESCE(withdrawal_history, '[]'::jsonb) || v_withdrawals,
         capital_history = CASE
           WHEN jsonb_array_length(v_capital_entries) > 0
           THEN COALESCE(capital_history, '[]'::jsonb) || v_capital_entries
           ELSE capital_history
         END,
         updated_at = now()
   WHERE id = _partner_id;

  IF _shift_id IS NOT NULL THEN
    v_shift_label := CASE
      WHEN _withdrawal_type = 'capital' THEN 'رأس مال'
      WHEN _withdrawal_type = 'auto' THEN
        CASE
          WHEN v_profit_part > 0 AND v_capital_part > 0 THEN 'أرباح ورأس مال (تلقائي)'
          WHEN v_capital_part > 0 THEN 'رأس مال (تلقائي)'
          ELSE 'أرباح (تلقائي)'
        END
      ELSE 'أرباح'
    END;

    INSERT INTO public.shift_transactions (
      shift_id, user_id, type, amount, currency_amount, currency, exchange_rate, notes, reference_id
    ) VALUES (
      _shift_id, v_owner, 'withdrawal', v_amt, v_orig_amt, v_ccy, v_rate,
      'سحب ' || v_shift_label || ' للشريك: ' || v_partner.name || CASE WHEN v_note_text <> '' THEN ' - ' || v_note_text ELSE '' END,
      COALESCE(v_op_id, _partner_id::text || ':' || gen_random_uuid()::text)
    );

    UPDATE public.cash_shifts
       SET expected_balance = round(COALESCE(expected_balance, 0) - v_amt, 8),
           updated_at = now()
     WHERE id = _shift_id AND user_id = v_owner AND closed_at IS NULL;
  END IF;

  v_result := jsonb_build_object(
    'success', true,
    'already_processed', false,
    'partner_id', _partner_id,
    'operation_id', v_op_id,
    'amount', v_amt,
    'currency', v_ccy,
    'original_amount', v_orig_amt,
    'exchange_rate', v_rate,
    'withdrawal_type', _withdrawal_type,
    'profit_deducted', v_profit_part,
    'capital_deducted', v_capital_part,
    'new_balance', v_new_balance,
    'new_capital', v_new_capital
  );
  IF v_op_id IS NOT NULL THEN
    INSERT INTO public.accounting_rpc_receipts(user_id, kind, operation_id, request, result)
    VALUES (v_owner, 'partner_withdrawal', v_op_id, v_request, v_result);
  END IF;
  RETURN v_result;
END;
$function$
;

-- FUNCTION pay_supplier_atomic | normalized md5 aba81448679c1b19c3b522d4f5c8c6e1
CREATE OR REPLACE FUNCTION public.pay_supplier_atomic(_supplier_id uuid, _amount numeric, _method text, _note text, _operation_id text, _source text DEFAULT 'external'::text, _shift_id uuid DEFAULT NULL::uuid, _currency text DEFAULT 'USD'::text, _currency_amount numeric DEFAULT NULL::numeric, _rate numeric DEFAULT NULL::numeric)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _o uuid := public._supplier_owner();
  _id uuid;
  _ccy text := upper(COALESCE(NULLIF(trim(_currency), ''), 'USD'));
  _eff_rate numeric;
  _eff_ccy_amt numeric;
BEGIN
  IF COALESCE(_amount,0) <= 0 THEN RAISE EXCEPTION 'المبلغ يجب أن يكون أكبر من الصفر'; END IF;
  IF COALESCE(_operation_id,'') = '' THEN RAISE EXCEPTION 'معرّف العملية مطلوب'; END IF;
  IF _source NOT IN ('drawer','external') THEN RAISE EXCEPTION 'مصدر الدفع غير صالح'; END IF;
  IF _source = 'drawer' AND _shift_id IS NULL THEN RAISE EXCEPTION 'الدفع من الصندوق يتطلب وردية مفتوحة'; END IF;

  IF _ccy = 'USD' THEN
    _eff_rate := 1;
    _eff_ccy_amt := round(_amount, 4);
  ELSE
    _eff_rate := COALESCE(_rate, (SELECT NULLIF((ss.exchange_rates->>_ccy)::numeric, 0) FROM public.store_settings ss WHERE ss.user_id = _o LIMIT 1));
    IF _eff_rate IS NULL OR _eff_rate <= 0 THEN RAISE EXCEPTION 'سعر صرف العملة % غير صالح', _ccy; END IF;
    _eff_ccy_amt := round(COALESCE(NULLIF(_currency_amount, 0), _amount * _eff_rate), 4);
    IF _eff_ccy_amt <= 0 THEN RAISE EXCEPTION 'مبلغ العملة % غير صالح', _ccy; END IF;
    IF _currency_amount IS NOT NULL AND _currency_amount > 0 THEN
      IF abs(_eff_ccy_amt - (_amount * _eff_rate)) > GREATEST(0.05, (_amount * _eff_rate) * 0.01) THEN
        RAISE EXCEPTION 'مبلغ العملة (%) لا يطابق القيمة المحوّلة (% × %)', _eff_ccy_amt, _amount, _eff_rate;
      END IF;
    END IF;
  END IF;

  PERFORM 1 FROM public.suppliers WHERE id=_supplier_id AND user_id=_o FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'المورد غير موجود'; END IF;
  SELECT id INTO _id FROM public.supplier_ledger_entries WHERE user_id=_o AND operation_id=_operation_id AND entry_type='payment';
  IF _id IS NOT NULL THEN RETURN _id; END IF;
  PERFORM public.assert_period_open(_o, CURRENT_DATE, 'دفعة لمورد');
  IF _amount > COALESCE((SELECT SUM(amount) FROM public.supplier_ledger_entries WHERE supplier_id=_supplier_id),0) + 0.0001 THEN
    RAISE EXCEPTION 'الدفعة أكبر من المستحق للمورد';
  END IF;
  IF _source = 'drawer' THEN
    PERFORM 1 FROM public.cash_shifts WHERE id = _shift_id AND user_id = _o AND closed_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'الوردية غير موجودة أو مغلقة أو لا تتبع لهذا المتجر'; END IF;
    PERFORM public._supplier_drawer_tx(_o,_shift_id,'supplier_payment',_amount,_ccy,_eff_ccy_amt,_eff_rate,_operation_id,'دفعة مورد من الصندوق');
  END IF;
  INSERT INTO public.supplier_ledger_entries(user_id,supplier_id,entry_type,amount,reference_type,payment_method,payment_source,shift_id,note,operation_id,created_by)
  VALUES (_o,_supplier_id,'payment',-round(_amount,4),'supplier_payment',_method,_source,CASE WHEN _source='drawer' THEN _shift_id END,_note,_operation_id,auth.uid()) RETURNING id INTO _id;
  RETURN _id;
END
$function$
;

-- FUNCTION payout_store_credit_atomic | normalized md5 179a04ada8d1eb840879a454f6ff2a07
CREATE OR REPLACE FUNCTION public.payout_store_credit_atomic(_customer_id uuid, _amount numeric, _shift_id uuid, _operation_id text, _currency text DEFAULT 'USD'::text, _currency_amount numeric DEFAULT NULL::numeric, _rate numeric DEFAULT NULL::numeric)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _o uuid := public._credit_actor(true);
  _id uuid;
  _bal numeric;
  _amt numeric := round(COALESCE(_amount, 0), 8);
  _ccy text := upper(COALESCE(NULLIF(trim(_currency), ''), 'USD'));
  _eff_rate numeric;
  _eff_ccy_amt numeric;
BEGIN
  IF _amt <= 0 THEN RAISE EXCEPTION 'المبلغ يجب أن يكون أكبر من الصفر'; END IF;
  IF _shift_id IS NULL THEN RAISE EXCEPTION 'صرف الرصيد نقداً يتطلب وردية مفتوحة'; END IF;
  IF COALESCE(_operation_id,'') = '' THEN RAISE EXCEPTION 'معرّف العملية مطلوب'; END IF;

  PERFORM public.assert_period_open(_o, CURRENT_DATE, 'صرف رصيد عميل');

  IF _ccy = 'USD' THEN
    _eff_rate := 1;
    _eff_ccy_amt := _amt;
  ELSE
    _eff_rate := COALESCE(_rate, (SELECT NULLIF((ss.exchange_rates->>_ccy)::numeric, 0) FROM public.store_settings ss WHERE ss.user_id = _o LIMIT 1));
    IF _eff_rate IS NULL OR _eff_rate <= 0 THEN
      RAISE EXCEPTION 'سعر صرف العملة % غير صالح', _ccy;
    END IF;
    _eff_ccy_amt := round(COALESCE(NULLIF(_currency_amount, 0), _amt * _eff_rate), 8);
    IF _eff_ccy_amt <= 0 THEN
      RAISE EXCEPTION 'مبلغ العملة % غير صالح', _ccy;
    END IF;
    IF _currency_amount IS NOT NULL AND _currency_amount > 0 THEN
      IF abs(_eff_ccy_amt - (_amount * _eff_rate)) > GREATEST(0.05, (_amount * _eff_rate) * 0.01) THEN
        RAISE EXCEPTION 'مبلغ العملة (%) لا يطابق القيمة المحوّلة (% × %)', _eff_ccy_amt, _amount, _eff_rate;
      END IF;
    END IF;
  END IF;

  PERFORM 1 FROM public.customers WHERE id=_customer_id AND user_id=_o FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'العميل غير موجود'; END IF;
  SELECT id INTO _id FROM public.customer_credit_ledger WHERE user_id=_o AND operation_id=_operation_id AND entry_type='payout';
  IF _id IS NOT NULL THEN RETURN _id; END IF;

  SELECT round(COALESCE(SUM(amount),0), 8) INTO _bal FROM public.customer_credit_ledger WHERE customer_id=_customer_id;
  IF _amt > _bal THEN RAISE EXCEPTION 'رصيد العميل (%) أقل من المبلغ المطلوب', round(_bal,2); END IF;

  PERFORM 1 FROM public.cash_shifts WHERE id=_shift_id AND user_id=_o AND closed_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'لا توجد وردية مفتوحة'; END IF;

  INSERT INTO public.shift_transactions(shift_id,user_id,type,amount,reference_id,notes,currency,currency_amount,exchange_rate)
  VALUES (_shift_id,_o,'store_credit_refund',_amt,_operation_id,'صرف رصيد عميل نقداً',_ccy,_eff_ccy_amt,_eff_rate);

  UPDATE public.cash_shifts
     SET expected_balance = round(COALESCE(expected_balance, 0) - _amt, 8),
         updated_at = now()
   WHERE id = _shift_id AND user_id = _o AND closed_at IS NULL;

  INSERT INTO public.customer_credit_ledger(user_id,customer_id,entry_type,amount,shift_id,reason,operation_id,created_by)
  VALUES (_o,_customer_id,'payout',-_amt,_shift_id,'صرف رصيد نقداً',_operation_id,auth.uid()) RETURNING id INTO _id;
  RETURN _id;
END
$function$
;

-- FUNCTION posflow_integrity_check | normalized md5 c78507045ae4f1b8617088aa7bf7e619
CREATE OR REPLACE FUNCTION public.posflow_integrity_check()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _caller uuid := auth.uid(); _owner uuid;
BEGIN
  IF _caller IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF NOT public.is_store_owner(_caller) THEN RAISE EXCEPTION 'فحص النزاهة مخصص لمالك المتجر فقط' USING ERRCODE='42501'; END IF;
  _owner := public.get_owner_id(_caller);
  RETURN public._posflow_integrity_core(_owner);
END $function$
;

-- FUNCTION post_shift_sale_atomic | normalized md5 d3e82b71fb0056063ce85094f0bcfda2
CREATE OR REPLACE FUNCTION public.post_shift_sale_atomic(_shift_id uuid, _operation_id text, _amount_usd numeric, _currency text DEFAULT 'USD'::text, _currency_amount numeric DEFAULT NULL::numeric, _exchange_rate numeric DEFAULT 1, _notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_owner uuid;
  v_amount numeric := round(COALESCE(_amount_usd, 0), 4);
  v_ccy text := upper(COALESCE(NULLIF(trim(_currency), ''), 'USD'));
  v_rate numeric;
  v_orig numeric;
  v_existing public.shift_transactions%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'المستخدم غير مسجل الدخول'; END IF;
  v_owner := public.get_owner_id(v_uid);
  IF v_owner IS NULL THEN RAISE EXCEPTION 'لم يتم العثور على حساب المالك'; END IF;
  IF _operation_id IS NULL OR length(_operation_id) < 8 THEN RAISE EXCEPTION 'رقم العملية غير صالح'; END IF;
  IF v_amount <= 0 OR v_amount::text IN ('NaN','Infinity','-Infinity') THEN
    RAISE EXCEPTION 'مبلغ البيع النقدي يجب أن يكون أكبر من الصفر';
  END IF;
  IF v_ccy = 'USD' THEN
    v_rate := 1; v_orig := round(v_amount, 8);
  ELSE
    v_rate := COALESCE(_exchange_rate, 0);
    IF v_rate <= 0 OR v_rate::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'سعر الصرف غير صالح'; END IF;
    v_orig := round(COALESCE(_currency_amount, v_amount * v_rate), 2);
  END IF;

  -- Same lock order as the other drawer RPCs: shift row first.
  PERFORM 1 FROM public.cash_shifts WHERE id = _shift_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'الوردية غير موجودة أو لا تتبع لهذا المتجر'; END IF;

  SELECT * INTO v_existing FROM public.shift_transactions
   WHERE shift_id = _shift_id AND type = 'sale' AND reference_id = _operation_id;
  IF FOUND THEN
    IF abs(v_existing.amount - round(v_amount, 8)) > 0.01 THEN
      RAISE EXCEPTION 'تعارض في معرّف العملية (%): مبلغ مختلف عن الحركة المسجلة', _operation_id USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object('success', true, 'already_processed', true, 'amount', v_existing.amount);
  END IF;

  -- A sale can only be posted into an OPEN shift (a closed shift is immutable, F-20).
  PERFORM 1 FROM public.cash_shifts WHERE id = _shift_id AND user_id = v_owner AND closed_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'الوردية مغلقة: لا يمكن ترحيل بيع نقدي إليها'; END IF;

  INSERT INTO public.shift_transactions (shift_id, user_id, type, amount, currency, currency_amount, exchange_rate, notes, reference_id)
  VALUES (_shift_id, v_owner, 'sale', round(v_amount, 8), v_ccy, v_orig, v_rate, COALESCE(_notes, 'مبيعات نقدية'), _operation_id);

  UPDATE public.cash_shifts
     SET expected_balance = round(COALESCE(expected_balance, 0) + round(v_amount, 8), 8)
   WHERE id = _shift_id;

  RETURN jsonb_build_object('success', true, 'already_processed', false, 'amount', round(v_amount, 8));
END;
$function$
;

-- FUNCTION prevent_customer_deletion_with_dues | normalized md5 a96276c8c533009068d321a80857ad00
CREATE OR REPLACE FUNCTION public.prevent_customer_deletion_with_dues()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public, pg_temp'
AS $function$
BEGIN
  IF public._owner_purge_allowed() THEN
    RETURN OLD;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.debts
    WHERE user_id = OLD.user_id
      AND customer_name = OLD.name
      AND remaining_debt > 0.001
  ) THEN
    RAISE EXCEPTION 'لا يمكن حذف العميل: توجد ديون وذمم مالية قائمة ومستحقة';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.invoices
    WHERE user_id = OLD.user_id
      AND customer_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'لا يمكن حذف العميل: توجد فواتير مبيعات سابقة مسجلة باسمه';
  END IF;
  RETURN OLD;
END;
$function$
;

-- FUNCTION prevent_direct_debt_delete | normalized md5 b1b96660ca92812775ac9466eb7f0881
CREATE OR REPLACE FUNCTION public.prevent_direct_debt_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL OR current_setting('role', true) = 'service_role' THEN
    RETURN OLD;
  END IF;
  IF public._owner_purge_allowed() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'الحذف المباشر لسجلات الديون والشطب ممنوع محاسبياً' USING ERRCODE = '42501';
END;
$function$
;

-- FUNCTION prevent_license_self_upgrade | normalized md5 9aefb5a8d7e0f541032dfeaa73de34b3
CREATE OR REPLACE FUNCTION public.prevent_license_self_upgrade()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_internal_lease boolean := (current_setting('app.internal_lease_issue', true) = '1');
BEGIN
  IF auth.uid() IS NULL OR current_setting('role', true) = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF public.is_boss(auth.uid()) THEN
    RETURN NEW;
  END IF;

  IF NEW.expires_at           IS DISTINCT FROM OLD.expires_at
  OR NEW.is_revoked           IS DISTINCT FROM OLD.is_revoked
  OR NEW.license_tier         IS DISTINCT FROM OLD.license_tier
  OR NEW.max_cashiers         IS DISTINCT FROM OLD.max_cashiers
  OR NEW.allow_multi_device   IS DISTINCT FROM OLD.allow_multi_device
  OR NEW.is_trial             IS DISTINCT FROM OLD.is_trial
  OR NEW.activation_code_id   IS DISTINCT FROM OLD.activation_code_id
  OR NEW.user_id              IS DISTINCT FROM OLD.user_id
  OR NEW.max_offline_days     IS DISTINCT FROM OLD.max_offline_days
  OR NEW.max_offline_invoices IS DISTINCT FROM OLD.max_offline_invoices
  OR NEW.device_reset_count   IS DISTINCT FROM OLD.device_reset_count
  OR NEW.offline_lease_secret IS DISTINCT FROM OLD.offline_lease_secret
  OR NEW.activated_at         IS DISTINCT FROM OLD.activated_at
  OR NEW.current_cashiers     IS DISTINCT FROM OLD.current_cashiers
  OR NEW.max_products         IS DISTINCT FROM OLD.max_products
  OR NEW.total_days           IS DISTINCT FROM OLD.total_days
  OR NEW.plan_id              IS DISTINCT FROM OLD.plan_id
  OR NEW.plan_name            IS DISTINCT FROM OLD.plan_name
  OR NEW.plan_audience        IS DISTINCT FROM OLD.plan_audience
  OR NEW.revoked_at           IS DISTINCT FROM OLD.revoked_at
  OR NEW.revoked_reason       IS DISTINCT FROM OLD.revoked_reason
  OR NEW.bound_device_id      IS DISTINCT FROM OLD.bound_device_id
  OR NEW.last_reset_at        IS DISTINCT FROM OLD.last_reset_at
  OR NEW.last_device_reset_at IS DISTINCT FROM OLD.last_device_reset_at
  OR (NOT v_internal_lease AND NEW.last_lease_issued_at IS DISTINCT FROM OLD.last_lease_issued_at)
  OR NEW.license_key          IS DISTINCT FROM OLD.license_key
  OR (
    OLD.device_id IS NOT NULL
    AND NEW.device_id IS DISTINCT FROM OLD.device_id
    AND NOT (
      NEW.device_id IS NOT NULL
      AND OLD.device_id NOT LIKE 'CAP-%'
      AND NEW.device_id LIKE 'CAP-%'
    )
  )
  THEN
    RAISE EXCEPTION 'انتهاك أمني: غير مصرح لك بتعديل بيانات أو حدود ترخيص النظام';
  END IF;

  RETURN NEW;
END;
$function$
;

-- FUNCTION process_pos_sale_atomic | normalized md5 37fd5cfa26c680d1f5d23b49a4fc7104
CREATE OR REPLACE FUNCTION public.process_pos_sale_atomic(_operation_id text, _payment_type text, _customer_name text, _customer_phone text, _subtotal numeric, _discount numeric, _discount_percentage numeric, _tax_rate numeric, _tax_amount numeric, _total numeric, _profit numeric, _currency text, _warehouse_id uuid, _items jsonb, _down_payment numeric DEFAULT 0, _exchange_rate numeric DEFAULT NULL::numeric, _tax_mode text DEFAULT NULL::text, _sale_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(success boolean, already_processed boolean, invoice_id uuid, invoice_number text, subtotal numeric, discount numeric, tax_amount numeric, total numeric, cogs numeric, profit numeric, debt_paid numeric, debt_remaining numeric, stock_shortage boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _caller uuid := auth.uid();
  _sale_ts timestamptz;
  _inv_date date;
  _inv_time time;
  _owner uuid;
  _existing public.invoices%ROWTYPE;
  _new_invoice public.invoices%ROWTYPE;
  _new_debt_id uuid;
  _next bigint;
  _number text;
  _item jsonb;
  _product_id uuid;
  _quantity numeric;
  _available numeric;
  _product_name text;
  _warehouse_name text;
  _track_inventory boolean := true;
  _src uuid;
  _dp numeric := 0;
  _sub numeric;
  _disc numeric;
  _applied_tax_rate numeric := 0;
  _tax numeric;
  _tot numeric;
  _tax_enabled boolean;
  _store_tax_rate numeric;
  _shortage boolean := false;
  _cust uuid;
  _cname text;
  _remaining numeric;
  _cogs numeric;
  _clean_exchange_rate numeric;
  _clean_currency text;
  _inclusive boolean := false;
  _kind text := 'exact';
  _diff numeric := 0;
  _unit text;
  _conv numeric;
  _need numeric;
BEGIN
  IF _caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  _owner := public.get_owner_id(_caller);
  IF _owner IS NULL THEN
    RAISE EXCEPTION 'Owner context is required';
  END IF;

  IF _operation_id IS NULL OR length(trim(_operation_id)) < 8 OR length(_operation_id) > 128 THEN
    RAISE EXCEPTION 'Invalid operation id';
  END IF;

  IF _payment_type NOT IN ('cash', 'debt') THEN
    RAISE EXCEPTION 'Invalid payment type';
  END IF;

  IF COALESCE(_discount, 0) < 0 OR COALESCE(_down_payment, 0) < 0 THEN
    RAISE EXCEPTION 'Invalid financial values';
  END IF;

  IF _items IS NULL OR jsonb_typeof(_items) <> 'array' OR jsonb_array_length(_items) = 0 THEN
    RAISE EXCEPTION 'Sale items are required';
  END IF;

  _clean_currency := COALESCE(NULLIF(trim(_currency), ''), 'USD');

  IF _clean_currency = 'USD' THEN
    _clean_exchange_rate := COALESCE(_exchange_rate, 1.0);
  ELSE
    IF _exchange_rate IS NOT NULL AND _exchange_rate > 0 THEN
      _clean_exchange_rate := _exchange_rate;
    ELSE
      RAISE EXCEPTION 'Valid exchange rate is required for non-USD currency (%)', _clean_currency;
    END IF;
  END IF;

  -- فحص التكرار (Idempotency)
  SELECT i.* INTO _existing
  FROM public.invoices i
  WHERE i.user_id = _owner AND i.operation_id = trim(_operation_id)
  LIMIT 1;

  IF FOUND THEN
    RETURN QUERY SELECT
      true, true, _existing.id, _existing.invoice_number, _existing.subtotal,
      _existing.discount, _existing.tax_amount, _existing.total,
      (SELECT COALESCE(SUM(ii.cost_price * ii.quantity), 0) FROM public.invoice_items ii WHERE ii.invoice_id = _existing.id),
      _existing.profit, _existing.debt_paid, _existing.debt_remaining, false;
    RETURN;
  END IF;

  SELECT
    NOT (COALESCE(s.store_type, 'general') IN ('bakery', 'repair', 'restaurant')),
    COALESCE(s.tax_enabled, false),
    COALESCE(s.tax_rate, 0)
  INTO _track_inventory, _tax_enabled, _store_tax_rate
  FROM public.stores s WHERE s.user_id = _owner LIMIT 1;

  _track_inventory := COALESCE(_track_inventory, true);

  IF _warehouse_id IS NOT NULL THEN
    SELECT w.name INTO _warehouse_name
    FROM public.warehouses w
    WHERE w.id = _warehouse_id AND w.user_id = _owner AND COALESCE(w.is_active, true);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Warehouse not found or inactive';
    END IF;
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS pg_temp.pos_sale_items(
    product_id uuid PRIMARY KEY,
    product_name text NOT NULL,
    quantity numeric(14,3) NOT NULL,
    unit_price numeric,
    cost_price numeric,
    amount_original numeric,
    amount_usd numeric,
    profit numeric,
    unit text,
    conversion_factor numeric,
    source_warehouse_id uuid
  ) ON COMMIT DROP;
  TRUNCATE pg_temp.pos_sale_items;

  FOR _item IN SELECT value FROM jsonb_array_elements(_items) LOOP
    BEGIN
      _product_id := (_item->>'product_id')::uuid;
      IF (_item->>'quantity') IS NULL OR (_item->>'quantity') !~ '^[0-9]+([.][0-9]+)?$' THEN
        RAISE EXCEPTION 'Invalid item quantity format';
      END IF;
      _quantity := round((_item->>'quantity')::numeric, 3);
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'Invalid sale item structure';
    END;

    IF _product_id IS NULL OR _quantity <= 0 THEN
      RAISE EXCEPTION 'Invalid item quantity';
    END IF;

    IF COALESCE(NULLIF(_item->>'unit_price','')::numeric, 0) < 0 OR COALESCE(NULLIF(_item->>'amount_usd','')::numeric, 0) < 0 THEN
      RAISE EXCEPTION 'Invalid item price';
    END IF;

    INSERT INTO pg_temp.pos_sale_items(product_id, product_name, quantity, unit_price, cost_price, amount_original, amount_usd, profit, unit, conversion_factor, source_warehouse_id)
    VALUES (
      _product_id,
      COALESCE(NULLIF(_item->>'product_name', ''), 'Product'),
      _quantity,
      round(COALESCE(NULLIF(_item->>'unit_price', '')::numeric, 0), 8),
      0,
      round(COALESCE(NULLIF(_item->>'amount_original', '')::numeric, 0), 8),
      round(COALESCE(NULLIF(_item->>'amount_usd', '')::numeric, 0), 8),
      0,
      COALESCE(NULLIF(_item->>'unit', ''), 'piece'),
      GREATEST(COALESCE(NULLIF(_item->>'conversion_factor', '')::numeric, 1), 1),
      NULL
    )
    ON CONFLICT(product_id) DO UPDATE SET
      quantity = CASE WHEN pg_temp.pos_sale_items.unit = EXCLUDED.unit AND pg_temp.pos_sale_items.conversion_factor = EXCLUDED.conversion_factor THEN pg_temp.pos_sale_items.quantity + EXCLUDED.quantity ELSE (CASE WHEN pg_temp.pos_sale_items.unit = 'bulk' THEN pg_temp.pos_sale_items.quantity * pg_temp.pos_sale_items.conversion_factor ELSE pg_temp.pos_sale_items.quantity END) + (CASE WHEN EXCLUDED.unit = 'bulk' THEN EXCLUDED.quantity * EXCLUDED.conversion_factor ELSE EXCLUDED.quantity END) END, /* mixed_unit_merge */
      unit_price = CASE WHEN pg_temp.pos_sale_items.unit = EXCLUDED.unit AND pg_temp.pos_sale_items.conversion_factor = EXCLUDED.conversion_factor THEN pg_temp.pos_sale_items.unit_price ELSE round((pg_temp.pos_sale_items.amount_usd + EXCLUDED.amount_usd) / NULLIF((CASE WHEN pg_temp.pos_sale_items.unit = 'bulk' THEN pg_temp.pos_sale_items.quantity * pg_temp.pos_sale_items.conversion_factor ELSE pg_temp.pos_sale_items.quantity END) + (CASE WHEN EXCLUDED.unit = 'bulk' THEN EXCLUDED.quantity * EXCLUDED.conversion_factor ELSE EXCLUDED.quantity END), 0), 8) END,
      unit = CASE WHEN pg_temp.pos_sale_items.unit = EXCLUDED.unit AND pg_temp.pos_sale_items.conversion_factor = EXCLUDED.conversion_factor THEN pg_temp.pos_sale_items.unit ELSE 'piece' END,
      conversion_factor = CASE WHEN pg_temp.pos_sale_items.unit = EXCLUDED.unit AND pg_temp.pos_sale_items.conversion_factor = EXCLUDED.conversion_factor THEN pg_temp.pos_sale_items.conversion_factor ELSE 1 END,
      amount_original = pg_temp.pos_sale_items.amount_original + EXCLUDED.amount_original,
      amount_usd = pg_temp.pos_sale_items.amount_usd + EXCLUDED.amount_usd;
  END LOOP;

  -- فحص المخزون والكرتونة
  FOR _product_id, _product_name, _quantity, _unit, _conv IN SELECT psi.product_id, psi.product_name, psi.quantity, psi.unit, psi.conversion_factor FROM pg_temp.pos_sale_items psi LOOP
    PERFORM 1 FROM public.products p
    WHERE p.id = _product_id AND p.user_id = _owner AND COALESCE(p.archived, false) = false;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product not found or archived (%)', _product_id;
    END IF;

    IF NOT _track_inventory THEN CONTINUE; END IF;

    _src := NULL;
    _available := NULL;

    IF _warehouse_id IS NOT NULL THEN
      SELECT ws.quantity INTO _available
      FROM public.warehouse_stock ws
      WHERE ws.warehouse_id = _warehouse_id AND ws.product_id = _product_id FOR UPDATE;
      IF FOUND THEN _src := _warehouse_id; END IF;
    END IF;

    IF _src IS NULL THEN
      SELECT p.quantity INTO _available
      FROM public.products p
      WHERE p.id = _product_id AND p.user_id = _owner FOR UPDATE;
    END IF;

    -- ضرب الكرتونة في معامل التحويل
    _need := CASE WHEN _unit = 'bulk' THEN _quantity * GREATEST(COALESCE(_conv, 1), 1) ELSE _quantity END;
    IF COALESCE(_available, 0) < _need THEN
      -- F-11: stock never goes below zero unless the owner's allow-negative setting is on
      IF NOT COALESCE((SELECT st.allow_negative_stock FROM public.stores st WHERE st.user_id = _owner ORDER BY st.created_at LIMIT 1), false) THEN
        RAISE EXCEPTION 'الكمية المطلوبة أكبر من المخزون المتاح للمنتج %', _product_name;
      END IF;
      _shortage := true;
    END IF;

    UPDATE pg_temp.pos_sale_items SET source_warehouse_id = _src WHERE product_id = _product_id;
  END LOOP;

  SELECT round(COALESCE(SUM(amount_usd), 0), 8) INTO _sub FROM pg_temp.pos_sale_items;
  _disc := round(LEAST(GREATEST(COALESCE(_discount, 0), 0), _sub), 8);

  IF _tax_enabled THEN
    _applied_tax_rate := LEAST(GREATEST(COALESCE(_store_tax_rate, 0), 0), 100);
  ELSE
    _applied_tax_rate := 0;
  END IF;

  -- معالجة الضريبة الشاملة
  _inclusive := _applied_tax_rate > 0 AND (
    lower(COALESCE(_tax_mode, '')) IN ('inclusive', 'gross')
    OR (COALESCE(_tax_mode, '') = '' AND _total IS NOT NULL
        AND abs(_total - (COALESCE(_subtotal, _sub) - COALESCE(_discount, 0))) <= 0.0001)
  );
  IF _inclusive THEN
    _tax := round((_sub - _disc) * _applied_tax_rate / (100 + _applied_tax_rate), 8);
    _tot := round(_sub - _disc, 8);
  ELSE
    _tax := round((_sub - _disc) * _applied_tax_rate / 100, 8);
    _tot := round(_sub - _disc + _tax, 8);
  END IF;

  _dp := round(COALESCE(_down_payment, 0), 8);
  IF _payment_type <> 'debt' THEN _dp := 0; END IF;
  _dp := LEAST(_dp, _tot);
  _remaining := CASE WHEN _payment_type = 'debt' THEN round(_tot - _dp, 8) ELSE 0 END;

  IF _remaining > 0 THEN _kind := 'debt'; _diff := _remaining;
  ELSIF _disc > 0 THEN _kind := 'discount'; _diff := _disc;
  END IF;

  _cname := NULLIF(trim(_customer_name), '');
  IF _cname IS NOT NULL AND _cname NOT IN ('عميل نقدي', 'عميل بيع مؤجل') THEN
    SELECT c.id INTO _cust
    FROM public.customers c
    WHERE c.user_id = _owner AND lower(trim(c.name)) = lower(_cname)
    ORDER BY c.created_at LIMIT 1 FOR UPDATE;

    IF _cust IS NULL THEN
      INSERT INTO public.customers(user_id, name, phone, cashier_id)
      VALUES(_owner, _cname, NULLIF(trim(_customer_phone), ''), _caller)
      RETURNING id INTO _cust;
    END IF;
  END IF;

  -- Sale time (2026-11-24): a queued offline sale keeps the time it was made, never later than now.
  -- If that day falls inside a closed accounting period, the sale takes its real posting time instead.
  _sale_ts := LEAST(COALESCE(_sale_at, now()), now());
  IF EXISTS (SELECT 1 FROM public.accounting_period_closures c WHERE c.user_id = _owner
             AND (_sale_ts AT TIME ZONE 'UTC')::date BETWEEN c.period_start AND c.period_end) THEN
    _sale_ts := now();
  END IF;
  _inv_date := (_sale_ts AT TIME ZONE 'UTC')::date;
  _inv_time := (_sale_ts AT TIME ZONE 'UTC')::time;

  _next := public.get_next_invoice_number(_owner);
  PERFORM public.assert_period_open(_owner, _inv_date, 'إنشاء فاتورة بيع');
  _number := to_char(_inv_date, 'YYYYMMDD') || '-' || lpad(_next::text, 5, '0');

  INSERT INTO public.invoices(
    user_id, invoice_number, invoice_sequence, operation_id, invoice_type,
    date, time, cashier_id, cashier_name, customer_id, customer_name, customer_phone,
    subtotal, discount, discount_percentage, tax_rate, tax_amount, total, profit,
    currency, exchange_rate, payment_type, status, debt_paid, debt_remaining, warehouse_id,
    tax_inclusive, settlement_kind, settlement_diff_usd, created_at
  )
  SELECT
    _owner, _number, _next, trim(_operation_id), 'sale',
    _inv_date, _inv_time, _caller::text, p.full_name, _cust, _cname, NULLIF(trim(_customer_phone), ''),
    _sub, _disc, COALESCE(_discount_percentage, 0), _applied_tax_rate, _tax, _tot, 0,
    _clean_currency, _clean_exchange_rate, _payment_type,
    CASE WHEN _remaining > 0 THEN 'pending' ELSE 'paid' END,
    CASE WHEN _payment_type = 'debt' THEN _dp ELSE 0 END,
    _remaining, _warehouse_id,
    _inclusive, _kind, _diff, _sale_ts
  FROM (SELECT 1) seed
  LEFT JOIN public.profiles p ON p.user_id = _caller
  LIMIT 1
  RETURNING * INTO _new_invoice;

  INSERT INTO public.invoice_items(
    invoice_id, product_id, product_name, quantity, unit_price, cost_price,
    currency, amount_original, amount_usd, profit, unit, conversion_factor, stock_warehouse_id,
    category_snapshot
  )
  SELECT
    _new_invoice.id, psi.product_id, psi.product_name, psi.quantity, psi.unit_price,
    0, _clean_currency, psi.amount_original, psi.amount_usd, 0, psi.unit, psi.conversion_factor,
    CASE WHEN _track_inventory THEN psi.source_warehouse_id ELSE NULL END,
    NULLIF(trim(p.category), '')
  FROM pg_temp.pos_sale_items psi
  LEFT JOIN public.products p ON p.id = psi.product_id AND p.user_id = _owner;

  DECLARE _sv record; _ser text[]; _cnt int;
  BEGIN
    FOR _sv IN SELECT psi.product_id, (psi.quantity * CASE WHEN psi.unit = 'bulk' THEN GREATEST(COALESCE(psi.conversion_factor,1),1) ELSE 1 END) AS quantity, p.name, COALESCE(p.warranty_months,0) AS wm FROM pg_temp.pos_sale_items psi JOIN public.products p ON p.id=psi.product_id WHERE p.track_serials LOOP
      SELECT COALESCE(array_agg(x),'{}'::text[]) INTO _ser FROM jsonb_array_elements(_items) it, LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(it.value->'serials')='array' THEN it.value->'serials' ELSE '[]'::jsonb END) x WHERE (it.value->>'product_id')::uuid=_sv.product_id;
      IF cardinality(_ser) <> _sv.quantity OR cardinality(_ser) <> (SELECT count(DISTINCT lower(trim(y))) FROM unnest(_ser) y) THEN RAISE EXCEPTION 'المنتج % يتطلب اختيار % رقم تسلسلي مختلف', _sv.name, _sv.quantity; END IF;
      UPDATE public.product_serials ps SET status='sold', sold_invoice_id=_new_invoice.id, sold_invoice_number=_new_invoice.invoice_number, sold_at=now(), customer_name=_cname, warranty_until=CASE WHEN _sv.wm>0 THEN (CURRENT_DATE + (_sv.wm||' months')::interval)::date END, updated_at=now() WHERE ps.user_id=_owner AND ps.product_id=_sv.product_id AND ps.status='in_stock' AND lower(ps.serial)=ANY(SELECT lower(trim(y)) FROM unnest(_ser) y);
      GET DIAGNOSTICS _cnt = ROW_COUNT;
      IF _cnt <> cardinality(_ser) THEN RAISE EXCEPTION 'رقم تسلسلي غير متوفر في المخزون للمنتج %', _sv.name; END IF;
      INSERT INTO public.product_serial_events(user_id,serial_id,event,ref,actor) SELECT _owner, ps.id, 'sold', _new_invoice.invoice_number, _caller FROM public.product_serials ps WHERE ps.sold_invoice_id=_new_invoice.id AND ps.product_id=_sv.product_id;
    END LOOP;
  END;

  -- 1) حساب الأرباح آلياً بدقة 8 منازل واستبعاد الضريبة
  PERFORM public.recalc_pos_invoice_profit(_new_invoice.id);

  -- 2) ✅ توزيع أرباح الشركاء ذرياً في نفس المعاملة
  PERFORM public.distribute_invoice_partner_profits_atomic(_new_invoice.id);

  IF _track_inventory THEN
    PERFORM set_config('app.stock_movement_type', 'sale', true);
    PERFORM set_config('app.stock_invoice_id', _new_invoice.id::text, true);
    PERFORM set_config('app.stock_invoice_number', _new_invoice.invoice_number, true);
    PERFORM set_config('app.stock_actor_id', _caller::text, true);
    PERFORM set_config('app.stock_source', 'atomic_pos_sale', true);

    UPDATE public.warehouse_stock ws
    SET quantity = ws.quantity - (CASE WHEN psi.unit = 'bulk' THEN psi.quantity * GREATEST(COALESCE(psi.conversion_factor, 1), 1) ELSE psi.quantity END), last_updated = now()
    FROM pg_temp.pos_sale_items psi
    WHERE psi.source_warehouse_id IS NOT NULL
      AND ws.warehouse_id = psi.source_warehouse_id
      AND ws.product_id = psi.product_id;

    UPDATE public.products p
    SET quantity = COALESCE(p.quantity, 0) - (CASE WHEN psi.unit = 'bulk' THEN psi.quantity * GREATEST(COALESCE(psi.conversion_factor, 1), 1) ELSE psi.quantity END), updated_at = now()
    FROM pg_temp.pos_sale_items psi
    WHERE psi.source_warehouse_id IS NULL
      AND p.id = psi.product_id
      AND p.user_id = _owner;
  END IF;

  IF _remaining > 0 AND _cust IS NOT NULL THEN
    DECLARE _lim numeric; _open numeric;
    BEGIN
      SELECT c.credit_limit, COALESCE(c.total_debt,0) INTO _lim, _open FROM public.customers c WHERE c.id=_cust;
      IF _lim IS NOT NULL AND _open + _remaining > _lim + 0.0001 THEN
        RAISE EXCEPTION 'تجاوز حد الائتمان للعميل: الحد %، الدين الحالي %، المطلوب %', round(_lim,2), round(_open,2), round(_remaining,2);
      END IF;
    END;
  END IF;

  IF _remaining > 0 THEN
    INSERT INTO public.debts(
      user_id, invoice_id, customer_id, customer_name, customer_phone, total_debt,
      total_paid, remaining_debt, due_date, status, is_cash_debt, cashier_id
    )
    VALUES(
      _owner, _new_invoice.invoice_number, _cust, COALESCE(_cname, 'عميل بيع مؤجل'),
      NULLIF(trim(_customer_phone), ''), _tot, _dp, _remaining,
      CURRENT_DATE + 30, CASE WHEN _dp > 0 THEN 'partial' ELSE 'due' END, false, _caller
    )
    RETURNING id INTO _new_debt_id;

    -- M-3: الدفعة المقدمة تُسجَّل كدفعة فعلية على الدين، فيتطابق دفتر الدفعات مع total_paid
    IF _dp > 0 THEN
      INSERT INTO public.debt_payments(
        user_id, debt_id, operation_id, amount, settled_amount,
        currency, exchange_rate, payment_method, paid_by
      )
      VALUES(
        _owner, _new_debt_id, trim(_operation_id) || ':down', _dp, _dp,
        'USD', 1, 'cash', _caller
      );
    END IF;
  END IF;

  IF _cust IS NOT NULL THEN
    UPDATE public.customers c SET
      total_purchases = round(COALESCE(c.total_purchases, 0) + _tot, 8),
      total_debt = round(COALESCE(c.total_debt, 0) + _remaining, 8),
      invoice_count = COALESCE(c.invoice_count, 0) + 1,
      last_purchase = now(),
      updated_at = now()
    WHERE c.id = _cust;
  END IF;

  SELECT i.* INTO _new_invoice FROM public.invoices i WHERE i.id = _new_invoice.id;
  SELECT COALESCE(SUM(ii.cost_price * ii.quantity), 0) INTO _cogs FROM public.invoice_items ii WHERE ii.invoice_id = _new_invoice.id;

  RETURN QUERY SELECT
    true, false, _new_invoice.id, _new_invoice.invoice_number, _sub, _disc, _tax, _tot,
    round(_cogs, 8), _new_invoice.profit, _new_invoice.debt_paid, _new_invoice.debt_remaining, _shortage;

EXCEPTION WHEN unique_violation THEN
  SELECT i.* INTO _existing
  FROM public.invoices i
  WHERE i.user_id = _owner AND i.operation_id = trim(_operation_id)
  LIMIT 1;

  IF FOUND THEN
    RETURN QUERY SELECT
      true, true, _existing.id, _existing.invoice_number, _existing.subtotal,
      _existing.discount, _existing.tax_amount, _existing.total, 0::numeric,
      _existing.profit, _existing.debt_paid, _existing.debt_remaining, false;
    RETURN;
  END IF;

  RAISE;
END;
$function$
;

-- FUNCTION process_pos_sale_with_drawer_atomic | normalized md5 989dce1f4578b95160d9df0cea26465d
CREATE OR REPLACE FUNCTION public.process_pos_sale_with_drawer_atomic(_operation_id text, _payment_type text, _customer_name text, _customer_phone text, _subtotal numeric, _discount numeric, _discount_percentage numeric, _tax_rate numeric, _tax_amount numeric, _total numeric, _profit numeric, _currency text, _warehouse_id uuid, _items jsonb, _down_payment numeric DEFAULT 0, _exchange_rate numeric DEFAULT NULL::numeric, _tax_mode text DEFAULT NULL::text, _shift_id uuid DEFAULT NULL::uuid, _currency_amount numeric DEFAULT NULL::numeric, _sale_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(success boolean, already_processed boolean, invoice_id uuid, invoice_number text, subtotal numeric, discount numeric, tax_amount numeric, total numeric, cogs numeric, profit numeric, debt_paid numeric, debt_remaining numeric, stock_shortage boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r record;
  v_owner uuid := public.get_owner_id(auth.uid());
  v_ccy text := upper(COALESCE(NULLIF(trim(_currency), ''), 'USD'));
  v_rate numeric;
  v_amt numeric;
  v_orig numeric;
  v_inserted integer := 0;
  v_sale_ts timestamptz;
  v_expected numeric;
  v_tol numeric;
BEGIN
  SELECT * INTO r
  FROM public.process_pos_sale_atomic(
    _operation_id, _payment_type, _customer_name, _customer_phone, _subtotal, _discount,
    _discount_percentage, _tax_rate, _tax_amount, _total, _profit, _currency, _warehouse_id,
    _items, _down_payment, _exchange_rate, _tax_mode, _sale_at
  );

  IF NOT COALESCE(r.already_processed, false) AND _payment_type = 'cash' AND _shift_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.cash_shifts cs
       WHERE cs.id = _shift_id AND cs.user_id = v_owner AND cs.closed_at IS NULL
    ) THEN
      RAISE EXCEPTION 'الوردية مغلقة أو غير موجودة: لا يمكن ترحيل بيع نقدي إليها';
    END IF;

    v_rate := CASE WHEN v_ccy = 'USD' THEN 1 ELSE _exchange_rate END;
    v_amt := round(r.total, 8);
    v_expected := round(v_amt * COALESCE(v_rate, 1), 8);
    -- N3: a received amount that does not match the sale value (at the sale rate) is refused
    v_tol := CASE WHEN v_ccy = 'USD' THEN 0.01 ELSE GREATEST(1, abs(v_expected) * 0.001) END;
    IF _currency_amount IS NOT NULL AND abs(_currency_amount - v_expected) > v_tol THEN
      RAISE EXCEPTION 'مبلغ العملة المستلمة لا يطابق قيمة البيع بسعر الصرف المحدد';
    END IF;
    v_orig := COALESCE(_currency_amount, v_expected);

    -- The movement takes the sale's time (the invoice's created_at), so an offline sale lands on its own day.
    SELECT i.created_at INTO v_sale_ts FROM public.invoices i WHERE i.id = r.invoice_id;

    INSERT INTO public.shift_transactions (
      shift_id, user_id, type, amount, currency, currency_amount, exchange_rate, notes, reference_id, created_at
    ) VALUES (
      _shift_id, v_owner, 'sale', v_amt, v_ccy, v_orig, COALESCE(v_rate, 1), 'مبيعات نقدية', _operation_id, COALESCE(v_sale_ts, now())
    )
    ON CONFLICT (shift_id, type, reference_id) DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;

    IF v_inserted = 1 THEN
      UPDATE public.cash_shifts
         SET expected_balance = round(COALESCE(expected_balance, 0) + v_amt, 8),
             updated_at = now()
       WHERE id = _shift_id AND user_id = v_owner AND closed_at IS NULL;
    END IF;
  END IF;

  RETURN QUERY SELECT r.success, r.already_processed, r.invoice_id, r.invoice_number, r.subtotal,
    r.discount, r.tax_amount, r.total, r.cogs, r.profit, r.debt_paid, r.debt_remaining, r.stock_shortage;
END;
$function$
;

-- FUNCTION process_quick_purchase_atomic | normalized md5 584f1cc5173cea513dd0eecee25c7ae0
CREATE OR REPLACE FUNCTION public.process_quick_purchase_atomic(_operation_id uuid, _purchase jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  _caller uuid := auth.uid();
  _owner uuid;
  _existing public.purchase_invoices%ROWTYPE;
  _product_id uuid := NULLIF(_purchase->>'productId', '')::uuid;
  _shift_id uuid := NULLIF(_purchase->>'shiftId', '')::uuid;
  _supplier_id uuid := NULLIF(_purchase->>'supplierId', '')::uuid;
  _name text := NULLIF(btrim(_purchase->>'productName'), '');
  _barcode text := NULLIF(btrim(_purchase->>'barcode'), '');
  _category text := NULLIF(btrim(_purchase->>'category'), '');
  _image text := NULLIF(_purchase->>'imageUrl', '');
  _method text := _purchase->>'paymentMethod';
  _qty numeric := (_purchase->>'quantity')::numeric;
  _cost numeric := (_purchase->>'costPrice')::numeric;
  _price numeric := COALESCE((_purchase->>'salePrice')::numeric, _cost);
  _total numeric;
  _invoice_number text := 'QP-' || _operation_id::text;
  _result jsonb;
  _cash_amount numeric;
  _cash_shift_id uuid;
  _creates_product boolean;
BEGIN
  IF _caller IS NULL OR _operation_id IS NULL THEN
    RAISE EXCEPTION 'Authentication and operation ID are required';
  END IF;
  _owner := public.get_owner_id(_caller);
  IF _owner IS NULL THEN
    RAISE EXCEPTION 'Store context is required';
  END IF;
  IF _name IS NULL OR _method IS NULL OR _method NOT IN ('cash', 'credit')
     OR _qty IS NULL OR NOT (_qty > 0 AND _qty < 1000000000)
     OR _cost IS NULL OR NOT (_cost >= 0 AND _cost < 1000000000)
     OR _price IS NULL OR NOT (_price >= 0 AND _price < 1000000000) THEN
    RAISE EXCEPTION 'Invalid quick purchase input';
  END IF;
  _total := round(_qty * _cost, 8);

  -- F7 (audit 2026-11-24): a credit quick purchase must name an active supplier of this store.
  IF _method = 'credit' THEN
    IF _supplier_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.suppliers sp WHERE sp.id = _supplier_id AND sp.user_id = _owner AND COALESCE(sp.is_active, true)
    ) THEN
      RAISE EXCEPTION 'يلزم اختيار مورد للشراء الآجل';
    END IF;
  END IF;

  -- Serialize duplicate requests and product resolution for quick purchases within the same store.
  PERFORM pg_advisory_xact_lock(hashtextextended('flowpos-quick-purchase:' || _owner::text, 0));
  SELECT * INTO _existing FROM public.purchase_invoices
    WHERE id = _operation_id AND user_id = _owner;
  IF FOUND THEN
    IF _existing.invoice_number <> _invoice_number OR _existing.status IS DISTINCT FROM 'finalized' THEN
      RAISE EXCEPTION 'Operation ID is already used by a different purchase';
    END IF;
    SELECT amount, shift_id INTO _cash_amount, _cash_shift_id FROM public.shift_transactions
      WHERE user_id = _owner AND type = 'withdrawal' AND reference_id = _operation_id::text
      LIMIT 1;
    RETURN jsonb_build_object('success', true, 'already_processed', true, 'invoice_id', _existing.id,
      'cash_amount', _cash_amount, 'shift_id', _cash_shift_id);
  END IF;

  -- Lock the specific drawer before writing stock. Closure and payment must agree on the shift.
  IF _method = 'cash' AND _total > 0 THEN
    PERFORM 1 FROM public.cash_shifts
    WHERE id = _shift_id AND user_id = _owner AND closed_at IS NULL
      AND (cashier_id::text = _caller::text OR _caller = _owner)
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'An open cash shift for this purchase is required';
    END IF;
  END IF;

  IF _product_id IS NOT NULL THEN
    PERFORM 1 FROM public.products
      WHERE id = _product_id AND user_id = _owner AND NOT COALESCE(archived, false);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product is not available in this store';
    END IF;
  ELSE
    IF _barcode IS NOT NULL THEN
      SELECT id INTO _product_id FROM public.products WHERE user_id = _owner AND barcode = _barcode
        ORDER BY created_at, id LIMIT 1;
    END IF;
    IF _product_id IS NULL THEN
      SELECT id INTO _product_id FROM public.products
        WHERE user_id = _owner AND lower(btrim(name)) = lower(_name)
        ORDER BY created_at, id LIMIT 1;
    END IF;
    IF _product_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.products WHERE id = _product_id AND COALESCE(archived, false)
    ) THEN
      RAISE EXCEPTION 'Matching product is archived';
    END IF;
  END IF;
  _creates_product := _product_id IS NULL;

  INSERT INTO public.purchase_invoices (
    id, user_id, invoice_number, supplier_name, invoice_date, status, payment_method, image_url, supplier_id,
    expected_items_count, expected_total_quantity, expected_grand_total,
    actual_items_count, actual_total_quantity, actual_grand_total
  ) VALUES (
    _operation_id, _owner, _invoice_number, CASE WHEN _method = 'credit' THEN (SELECT sp.name FROM public.suppliers sp WHERE sp.id = _supplier_id) ELSE _name END, CURRENT_DATE, 'draft', _method, _image, CASE WHEN _method = 'credit' THEN _supplier_id ELSE NULL END,
    1, _qty, _total, 1, _qty, _total
  );
  INSERT INTO public.purchase_invoice_items (
    invoice_id, product_id, product_name, barcode, category, quantity, cost_price, sale_price, total_cost
  ) VALUES (_operation_id, _product_id, _name, _barcode, _category, _qty, _cost, _price, _total);

  _result := public.finalize_purchase_invoice_atomic(_operation_id);
  IF NOT COALESCE((_result->>'success')::boolean, false) THEN
    RAISE EXCEPTION 'Purchase finalization failed';
  END IF;
  SELECT product_id INTO STRICT _product_id FROM public.purchase_invoice_items WHERE invoice_id = _operation_id;

  UPDATE public.products
  SET sale_price = CASE WHEN _price > 0 THEN _price ELSE sale_price END,
      barcode = COALESCE(_barcode, barcode),
      category = COALESCE(_category, category),
      expiry_date = COALESCE(NULLIF(_purchase->>'expiryDate', '')::date, expiry_date),
      image_url = COALESCE(_image, image_url),
      custom_fields = CASE WHEN _purchase ? 'wholesalePrice'
        THEN COALESCE(custom_fields, '{}'::jsonb) || jsonb_build_object('wholesalePrice', (_purchase->>'wholesalePrice')::numeric)
        ELSE custom_fields END,
      min_stock_level = CASE WHEN _creates_product THEN COALESCE((_purchase->>'minStockLevel')::integer, min_stock_level) ELSE min_stock_level END,
      track_by_unit = CASE WHEN _creates_product AND _purchase->>'trackByUnit' IN ('piece','bulk') THEN _purchase->>'trackByUnit' ELSE track_by_unit END,
      bulk_unit = CASE WHEN _creates_product THEN COALESCE(_purchase->>'bulkUnit', bulk_unit) ELSE bulk_unit END,
      small_unit = CASE WHEN _creates_product THEN COALESCE(_purchase->>'smallUnit', small_unit) ELSE small_unit END,
      conversion_factor = CASE WHEN _creates_product THEN GREATEST(COALESCE((_purchase->>'conversionFactor')::numeric, 1), 1) ELSE conversion_factor END,
      bulk_cost_price = CASE WHEN _creates_product THEN COALESCE((_purchase->>'bulkCostPrice')::numeric, bulk_cost_price) ELSE bulk_cost_price END,
      bulk_sale_price = CASE WHEN _creates_product THEN COALESCE((_purchase->>'bulkSalePrice')::numeric, bulk_sale_price) ELSE bulk_sale_price END,
      updated_at = now()
  WHERE id = _product_id AND user_id = _owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unable to update product details';
  END IF;

  IF _method = 'cash' AND _total > 0 THEN
    INSERT INTO public.shift_transactions (
      shift_id, user_id, type, amount, currency, currency_amount, exchange_rate, reference_id, notes
    ) VALUES (
      _shift_id, _owner, 'withdrawal', _total, 'USD', _total, 1, _operation_id::text, 'Quick purchase'
    );
    -- Keep the drawer cache in step with the movement (the row is already locked above; replays return earlier)
    UPDATE public.cash_shifts
       SET expected_balance = round(COALESCE(expected_balance, 0) - _total, 8)
     WHERE id = _shift_id AND user_id = _owner;
  END IF;

  RETURN jsonb_build_object('success', true, 'already_processed', false, 'invoice_id', _operation_id,
    'cash_amount', CASE WHEN _method = 'cash' THEN _total END,
    'shift_id', CASE WHEN _method = 'cash' AND _total > 0 THEN _shift_id END);
END;
$function$
;

-- FUNCTION purchase_return_atomic | normalized md5 aba840ce9006a3815286f3a74a80c4a6
CREATE OR REPLACE FUNCTION public.purchase_return_atomic(_invoice_id uuid, _lines jsonb, _reason text, _operation_id text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _o uuid := public._supplier_owner();
  _inv record;
  _rid uuid;
  _l jsonb;
  _it record;
  _qty numeric;
  _returned numeric;
  _stock numeric;
  _cur_cost numeric;
  _new_stock numeric;
  _new_cost numeric;
  _calc_cost numeric;
  _rem_val numeric;
  v_variance numeric := 0;
  _no_inventory boolean := false;
  _has_subsequent_sale boolean := false;
  _total numeric := 0;
  _num text;
BEGIN
  IF COALESCE(_operation_id, '') = '' THEN
    RAISE EXCEPTION 'معرّف العملية مطلوب';
  END IF;

  SELECT id INTO _rid
    FROM public.purchase_returns
   WHERE user_id = _o AND operation_id = _operation_id;
  IF _rid IS NOT NULL THEN
    RETURN _rid;
  END IF;

  IF _lines IS NULL OR jsonb_typeof(_lines) <> 'array' OR jsonb_array_length(_lines) = 0 THEN
    RAISE EXCEPTION 'لا توجد بنود للمرتجع';
  END IF;

  SELECT * INTO _inv
    FROM public.purchase_invoices
   WHERE id = _invoice_id AND user_id = _o
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'فاتورة الشراء غير موجودة';
  END IF;

  IF COALESCE(_inv.payment_status, '') = 'cancelled' OR COALESCE(_inv.status, '') = 'cancelled' THEN
    RAISE EXCEPTION 'الفاتورة ملغاة';
  END IF;

  IF COALESCE(_inv.status, 'draft') NOT IN ('finalized', 'completed') THEN
    RAISE EXCEPTION 'لا يمكن عمل مرتجع لفاتورة شراء غير معتمدة';
  END IF;

  IF _inv.replaced_by IS NOT NULL THEN
    RAISE EXCEPTION 'الفاتورة استُبدلت بفاتورة معدّلة';
  END IF;

  PERFORM public.assert_period_open(_o, CURRENT_DATE, 'مرتجع مشتريات');

  SELECT COALESCE(s.store_type, 'general') IN ('bakery', 'repair')
    INTO _no_inventory
    FROM public.stores s
   WHERE s.user_id = _o
   LIMIT 1;
  _no_inventory := COALESCE(_no_inventory, false);

  _num := 'PR-' || to_char(now(), 'YYYYMMDD') || '-' || substr(gen_random_uuid()::text, 1, 6);
  INSERT INTO public.purchase_returns(user_id, invoice_id, supplier_id, return_number, total_amount, reason, operation_id, created_by)
  VALUES (_o, _invoice_id, _inv.supplier_id, _num, 0, _reason, _operation_id, auth.uid())
  RETURNING id INTO _rid;

  PERFORM set_config('app.stock_movement_type', 'purchase_return', true);
  PERFORM set_config('app.stock_actor_id', auth.uid()::text, true);
  PERFORM set_config('app.stock_source', 'purchase_return_atomic', true);

  FOR _l IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    _qty := round((_l->>'quantity')::numeric, 3);
    IF _qty IS NULL OR _qty <= 0 THEN
      RAISE EXCEPTION 'كمية غير صالحة';
    END IF;

    SELECT * INTO _it
      FROM public.purchase_invoice_items
     WHERE id = (_l->>'item_id')::uuid AND invoice_id = _invoice_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'بند غير تابع للفاتورة';
    END IF;

    SELECT COALESCE(SUM(quantity), 0) INTO _returned
      FROM public.purchase_return_items
     WHERE invoice_item_id = _it.id;
    IF _returned + _qty > _it.quantity THEN
      RAISE EXCEPTION 'كمية المرتجع من "%" تتجاوز المشتراة (المتبقي %)', _it.product_name, _it.quantity - _returned;
    END IF;

    IF _it.product_id IS NOT NULL AND NOT _no_inventory THEN
      SELECT quantity, cost_price INTO _stock, _cur_cost
        FROM public.products
       WHERE id = _it.product_id AND user_id = _o
         FOR UPDATE;
      IF FOUND THEN
        IF COALESCE(_stock, 0) < _qty THEN
          RAISE EXCEPTION 'مخزون "%" أقل من كمية المرتجع (بيع جزء منه)', _it.product_name;
        END IF;

        _new_stock := round(COALESCE(_stock, 0) - _qty, 3);
        _rem_val := (COALESCE(_stock, 0) * COALESCE(_cur_cost, 0))
                  - (_qty * COALESCE(_it.cost_price, 0));

        SELECT EXISTS (
          SELECT 1
            FROM public.invoice_items ii
            JOIN public.invoices inv ON inv.id = ii.invoice_id
           WHERE ii.product_id = _it.product_id
             AND inv.user_id = _o
             AND COALESCE(inv.status, '') NOT IN ('cancelled', 'refunded', 'void', 'voided')
             AND inv.created_at > COALESCE(_inv.finalized_at, _inv.created_at)
        ) INTO _has_subsequent_sale;

        IF _has_subsequent_sale THEN
          -- Perpetual moving average (IAS 2): do not distort remaining inventory cost after intervening sales
          _new_cost := COALESCE(_cur_cost, 0);
        ELSIF _new_stock > 0 AND _rem_val > 0 THEN
          _calc_cost := round(_rem_val / _new_stock, 8);
          IF _calc_cost <= 0
             OR _calc_cost > GREATEST(COALESCE(_cur_cost, 0), COALESCE(_it.cost_price, 0), COALESCE(_it.cost_price_before, COALESCE(_cur_cost, 0)))
             OR _calc_cost < LEAST(COALESCE(_cur_cost, 0), COALESCE(_it.cost_price, 0), COALESCE(_it.cost_price_before, COALESCE(_cur_cost, 0))) THEN
            _new_cost := COALESCE(_cur_cost, 0);
          ELSE
            _new_cost := _calc_cost;
          END IF;
        ELSE
          _new_cost := COALESCE(_cur_cost, 0);
        END IF;

        v_variance := round((_new_stock * _new_cost) - _rem_val, 4);
        IF v_variance <> 0 THEN
          INSERT INTO public.inventory_valuation_adjustments(
            user_id, source_type, source_id, product_id, variance_usd, notes
          ) VALUES (
            _o,
            'purchase_return',
            _rid,
            _it.product_id,
            v_variance,
            'فرق تقييم مخزون عند مرتجع الشراء ' || _num || ' للفاتورة ' || COALESCE(_inv.invoice_number, '')
          );
        END IF;

        UPDATE public.products
           SET cost_price = _new_cost,
               quantity = _new_stock,
               updated_at = now()
         WHERE id = _it.product_id;
      END IF;
    END IF;

    IF _it.product_id IS NOT NULL AND (SELECT track_serials FROM public.products WHERE id = _it.product_id) THEN
      DECLARE
        _ser text[];
        _cnt int;
      BEGIN
        SELECT COALESCE(array_agg(x), '{}'::text[]) INTO _ser
          FROM jsonb_array_elements_text(
            CASE WHEN jsonb_typeof(_l->'serials') = 'array' THEN _l->'serials' ELSE '[]'::jsonb END
          ) x;

        IF cardinality(_ser) <> _qty THEN
          RAISE EXCEPTION 'المنتج "%" يتطلب تحديد % رقم تسلسلي للمرتجع', _it.product_name, _qty;
        END IF;

        UPDATE public.product_serials ps
           SET status = 'returned_to_supplier', updated_at = now()
         WHERE ps.user_id = _o
           AND ps.product_id = _it.product_id
           AND ps.status = 'in_stock'
           AND ps.purchase_invoice_id = _invoice_id
           AND lower(ps.serial) = ANY(SELECT lower(trim(y)) FROM unnest(_ser) y);
        GET DIAGNOSTICS _cnt = ROW_COUNT;
        IF _cnt <> cardinality(_ser) THEN
          RAISE EXCEPTION 'رقم تسلسلي غير متوفر في المخزون أو غير تابع لهذه الفاتورة للمنتج "%"', _it.product_name;
        END IF;

        INSERT INTO public.product_serial_events(user_id, serial_id, event, ref, actor)
        SELECT _o, ps.id, 'returned_to_supplier', _num, auth.uid()
          FROM public.product_serials ps
         WHERE ps.user_id = _o
           AND ps.product_id = _it.product_id
           AND ps.status = 'returned_to_supplier'
           AND ps.purchase_invoice_id = _invoice_id
           AND lower(ps.serial) = ANY(SELECT lower(trim(y)) FROM unnest(_ser) y);
      END;
    END IF;

    INSERT INTO public.purchase_return_items(return_id, invoice_item_id, product_id, product_name, quantity, unit_cost, total_cost)
    VALUES (_rid, _it.id, _it.product_id, _it.product_name, _qty, COALESCE(_it.cost_price, 0), round(_qty * COALESCE(_it.cost_price, 0), 4));

    _total := _total + round(_qty * COALESCE(_it.cost_price, 0), 4);
  END LOOP;

  UPDATE public.purchase_returns SET total_amount = _total WHERE id = _rid;

  IF _inv.supplier_id IS NOT NULL AND _total > 0 THEN
    INSERT INTO public.supplier_ledger_entries(user_id, supplier_id, entry_type, amount, reference_type, reference_id, note, operation_id, created_by)
    VALUES (_o, _inv.supplier_id, 'purchase_return', -_total, 'purchase_return', _rid::text, 'مرتجع ' || _num || ' للفاتورة ' || _inv.invoice_number, _operation_id, auth.uid());
  END IF;

  RETURN _rid;
END;
$function$
;

-- FUNCTION purge_owner_data | normalized md5 38e6f5fa66ced976a3c1c5ec7d46a86a
CREATE OR REPLACE FUNCTION public.purge_owner_data(_owner_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _ids uuid[];
  _pending text[];
  _tbl text;
  _n bigint;
  _pass integer;
  _progress boolean;
  _result jsonb := '{}'::jsonb;
  _keep text[] := ARRAY['user_roles', 'profiles', 'app_licenses'];
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_boss(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF _owner_id IS NULL OR public.is_boss(_owner_id) THEN
    RAISE EXCEPTION 'cannot purge a boss or empty id';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.user_roles r
    WHERE r.user_id = _owner_id AND r.owner_id IS NOT NULL AND r.owner_id <> r.user_id
  ) THEN
    RAISE EXCEPTION 'target is a sub-account, not an owner';
  END IF;

  -- transaction-local switches that let the guard triggers (invoices / customers / partner ledger) allow this purge
  PERFORM set_config('app.invoice_delete_context', 'allowed', true);
  PERFORM set_config('app.purge_context', 'owner_purge', true);

  -- the owner + every cashier account that belongs to him
  _ids := ARRAY[_owner_id] || COALESCE(
    ARRAY(SELECT r.user_id FROM public.user_roles r WHERE r.owner_id = _owner_id AND r.user_id <> _owner_id),
    ARRAY[]::uuid[]
  );

  -- child rows that have no user_id and RESTRICT their parent
  DELETE FROM public.purchase_return_items i
  USING public.purchase_returns pr
  WHERE i.return_id = pr.id AND pr.user_id = ANY(_ids);
  GET DIAGNOSTICS _n = ROW_COUNT;
  _result := _result || jsonb_build_object('purchase_return_items', _n);

  -- support conversations are keyed by owner_id as well
  DELETE FROM public.support_conversations WHERE user_id = ANY(_ids) OR owner_id = ANY(_ids);
  GET DIAGNOSTICS _n = ROW_COUNT;
  _result := _result || jsonb_build_object('support_conversations', _n);

  -- every other table that carries a user_id column (roles / profile / license are removed last)
  SELECT array_agg(c.table_name ORDER BY c.table_name) INTO _pending
  FROM information_schema.columns c
  JOIN information_schema.tables t
    ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
  WHERE c.table_schema = 'public'
    AND c.column_name = 'user_id'
    AND NOT (c.table_name = ANY(_keep));

  FOR _pass IN 1..8 LOOP
    _progress := false;
    FOREACH _tbl IN ARRAY COALESCE(_pending, ARRAY[]::text[]) LOOP
      BEGIN
        EXECUTE format('DELETE FROM public.%I WHERE user_id = ANY($1)', _tbl) USING _ids;
        GET DIAGNOSTICS _n = ROW_COUNT;
        IF _n > 0 THEN
          _result := _result || jsonb_build_object(_tbl, _n);
        END IF;
        _pending := array_remove(_pending, _tbl);
        _progress := true;
      EXCEPTION WHEN foreign_key_violation THEN
        NULL; -- a child table still references it: retry on the next pass
      END;
    END LOOP;
    EXIT WHEN COALESCE(cardinality(_pending), 0) = 0 OR NOT _progress;
  END LOOP;

  IF COALESCE(cardinality(_pending), 0) > 0 THEN
    RAISE EXCEPTION 'purge incomplete, blocked tables: %', array_to_string(_pending, ', ');
  END IF;

  DELETE FROM public.app_licenses WHERE user_id = ANY(_ids);
  DELETE FROM public.profiles WHERE user_id = ANY(_ids);
  DELETE FROM public.user_roles WHERE user_id = ANY(_ids) OR owner_id = _owner_id;

  PERFORM set_config('app.invoice_delete_context', '', true);
  PERFORM set_config('app.purge_context', '', true);

  RETURN _result;
END;
$function$
;

-- FUNCTION push_app_broadcast | normalized md5 e3c7892e8d6f98a6e074a3541934982d
CREATE OR REPLACE FUNCTION public.push_app_broadcast()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'vault'
AS $function$
begin
  perform net.http_post(
    url := 'https://bwlqfxfvchjvehnbvwaz.supabase.co/functions/v1/send-boss-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-push-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'boss_push_secret' LIMIT 1)
    ),
    body := jsonb_build_object('broadcast_id', NEW.id)
  );
  return NEW;
exception when others then
  return NEW;
end $function$
;

-- FUNCTION push_customer_message | normalized md5 63a1b91a6ea07b96d46c814de1e7d32d
CREATE OR REPLACE FUNCTION public.push_customer_message()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'vault'
AS $function$
begin
  perform net.http_post(
    url := 'https://bwlqfxfvchjvehnbvwaz.supabase.co/functions/v1/send-boss-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-push-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'boss_push_secret' LIMIT 1)
    ),
    body := jsonb_build_object('message_id', NEW.id)
  );
  return NEW;
exception when others then
  return NEW;
end $function$
;

-- FUNCTION recalc_customer_open_debt | normalized md5 d0f02c9ae58680310e4b2aa8da9a0751
CREATE OR REPLACE FUNCTION public.recalc_customer_open_debt(_owner uuid, _customer uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  UPDATE public.customers c SET total_debt = COALESCE((
      SELECT SUM(d.remaining_debt) FROM public.debts d
       WHERE d.user_id = _owner
         AND COALESCE(d.status,'') NOT IN ('fully_paid','written_off','cancelled')
         AND (d.customer_id = c.id OR (d.customer_id IS NULL AND d.customer_name = c.name))
    ), 0), updated_at = now()
  WHERE c.id = _customer AND c.user_id = _owner;
$function$
;

-- FUNCTION recalc_pos_invoice_profit | normalized md5 54b3015d54a517692c6433e62488993d
CREATE OR REPLACE FUNCTION public.recalc_pos_invoice_profit(_invoice_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _inv public.invoices%ROWTYPE;
  _cogs numeric;
  _sub numeric;
  _f numeric := 1;
BEGIN
  SELECT * INTO _inv FROM public.invoices WHERE id = _invoice_id;
  IF NOT FOUND THEN RETURN; END IF;

  IF COALESCE(_inv.tax_inclusive, false) AND COALESCE(_inv.tax_rate, 0) > 0 THEN
    _f := 1 / (1 + _inv.tax_rate / 100);
  END IF;

  UPDATE public.invoice_items ii
     SET cost_price = CASE
           WHEN COALESCE(ii.cost_price, 0) <> 0 THEN ii.cost_price
           WHEN COALESCE(ii.unit, 'piece') = 'bulk' THEN
             CASE
               WHEN COALESCE(p.bulk_cost_price, 0) > 0 THEN round(p.bulk_cost_price, 8)
               ELSE round(COALESCE(p.cost_price, 0) * GREATEST(COALESCE(ii.conversion_factor, 1), 1), 8)
             END
           ELSE round(COALESCE(p.cost_price, 0), 8)
         END,
         warranty_until = COALESCE(
           ii.warranty_until,
           CASE WHEN p.warranty_months IS NOT NULL THEN (_inv.date + make_interval(months => p.warranty_months))::date ELSE NULL END
         )
    FROM public.products p
   WHERE ii.invoice_id = _invoice_id AND p.id = ii.product_id AND p.user_id = _inv.user_id;

  SELECT COALESCE(SUM(COALESCE(cost_price, 0) * COALESCE(quantity, 0)), 0),
         COALESCE(SUM(COALESCE(unit_price, 0) * COALESCE(quantity, 0)), 0)
    INTO _cogs, _sub FROM public.invoice_items WHERE invoice_id = _invoice_id;

  UPDATE public.invoice_items
     SET profit = round(((COALESCE(unit_price, 0) * COALESCE(quantity, 0))
                  - CASE WHEN _sub > 0 THEN COALESCE(_inv.discount, 0) * (COALESCE(unit_price, 0) * COALESCE(quantity, 0)) / _sub ELSE 0 END) * _f
                  - COALESCE(cost_price, 0) * COALESCE(quantity, 0), 8)
   WHERE invoice_id = _invoice_id;

  UPDATE public.invoices
     SET profit = round((COALESCE(subtotal, _sub) - COALESCE(discount, 0)) * _f - _cogs, 8)
   WHERE id = _invoice_id;
END;
$function$
;

-- FUNCTION receive_stock_wac | normalized md5 cbee608bc18401a20ae8ee9371c3033c
CREATE OR REPLACE FUNCTION public.receive_stock_wac(_product_id uuid, _quantity numeric, _unit_cost numeric, _reference text DEFAULT NULL::text)
 RETURNS TABLE(new_quantity numeric, new_cost numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _caller uuid := auth.uid();
  _owner uuid;
  _cur_qty numeric;
  _cur_cost numeric;
  _pos_qty numeric;
  _calc_cost numeric;
BEGIN
  IF _caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  _owner := public.get_owner_id(_caller);
  IF _owner IS NULL THEN
    RAISE EXCEPTION 'Owner context is required';
  END IF;

  IF COALESCE(_quantity, 0) <= 0 OR COALESCE(_unit_cost, -1) < 0 THEN
    RAISE EXCEPTION 'Invalid stock quantity or unit cost';
  END IF;

  SELECT COALESCE(p.quantity, 0), COALESCE(p.cost_price, 0)
    INTO _cur_qty, _cur_cost
    FROM public.products p
   WHERE p.id = _product_id AND p.user_id = _owner
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product not found';
  END IF;

  _pos_qty := GREATEST(_cur_qty, 0);

  -- F-11: free goods (unit cost 0) never lower the weighted-average cost
  IF _unit_cost = 0 THEN
    _calc_cost := _cur_cost;
  ELSIF _pos_qty = 0 THEN
    _calc_cost := _unit_cost;
  ELSE
    _calc_cost := round(((_pos_qty * _cur_cost) + (_quantity * _unit_cost)) / (_pos_qty + _quantity), 8);
  END IF;

  PERFORM set_config('app.stock_movement_type', 'purchase', true);
  PERFORM set_config('app.stock_source', 'receive_stock_wac', true);
  PERFORM set_config('app.stock_invoice_number', COALESCE(_reference, ''), true);

  UPDATE public.products
     SET quantity = _cur_qty + _quantity,
         cost_price = _calc_cost,
         updated_at = now()
   WHERE id = _product_id;

  RETURN QUERY SELECT (_cur_qty + _quantity), _calc_cost;
END;
$function$
;

-- FUNCTION record_debt_payment_atomic | normalized md5 344df7b206172caef1e0c7c48a8a0010
CREATE OR REPLACE FUNCTION public.record_debt_payment_atomic(_debt_id uuid, _amount numeric, _operation_id text, _shift_id uuid DEFAULT NULL::uuid, _currency text DEFAULT NULL::text, _currency_amount numeric DEFAULT NULL::numeric, _exchange_rate numeric DEFAULT NULL::numeric, _payment_method text DEFAULT 'cash'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_owner uuid := public.get_owner_id(auth.uid());
  v_debt public.debts%ROWTYPE;
  v_existing_payment public.debt_payments%ROWTYPE;
  v_request jsonb;
  v_response jsonb;
  v_legacy_currency_amount numeric;
  v_amount numeric := round(COALESCE(_amount, 0)::numeric, 8);
  v_cash_amount numeric := round(COALESCE(_amount, 0)::numeric, 8);
  v_settlement numeric;
  v_rounding_adjustment numeric := 0;
  v_prev_remaining numeric;
  v_new_remaining numeric;
  v_new_total_paid numeric;
  v_rounding_note text := '';
  v_payment_method text := COALESCE(NULLIF(lower(trim(_payment_method)), ''), 'cash');
  v_tx_currency text := 'USD';
  v_tx_currency_amount numeric := 0;
  v_tx_exchange_rate numeric := 1;
  v_resolved_customer_id uuid;
  v_installment_ratio numeric := 1.0;
  v_inv_currency text;
  v_inv_rate numeric;
  v_pay_currency text;
  v_fx_credit_rate numeric := NULL;
  v_credit numeric;
  v_fx_difference numeric := 0;
  p record;
  _updated_details jsonb;
  _updated_history jsonb;
  _total_confirmed numeric := 0;
  _item jsonb;
  _item_amt numeric;
  _confirm_amt numeric;
BEGIN
  PERFORM set_config('app.partner_source', 'record_debt_payment_atomic', true);
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'غير مصرح';
  END IF;

  IF _operation_id IS NULL OR length(_operation_id) < 8 THEN
    RAISE EXCEPTION 'رقم العملية غير صالح';
  END IF;

  IF v_payment_method NOT IN ('cash', 'transfer') THEN RAISE EXCEPTION 'طريقة قبض الدين غير صالحة'; END IF;
  v_request := jsonb_build_object('debt_id', _debt_id, 'amount', _amount, 'shift_id', _shift_id,
    'currency', upper(COALESCE(NULLIF(trim(_currency), ''), 'USD')), 'currency_amount', _currency_amount,
    'exchange_rate', _exchange_rate, 'payment_method', v_payment_method);
  v_response := public._read_sales_settlement_replay(v_owner, 'debt_payment', _operation_id, v_request);
  IF v_response IS NOT NULL THEN RETURN v_response || jsonb_build_object('already_processed', true); END IF;

  -- A refund locks the invoice first. Debt collection takes the same lock order.
  PERFORM 1 FROM public.invoices i
    JOIN public.debts d ON d.user_id = i.user_id AND d.id = _debt_id
   WHERE i.user_id = v_owner AND NOT COALESCE(d.is_cash_debt, false)
     AND d.invoice_id IN (i.invoice_number, i.id::text)
   ORDER BY i.id FOR UPDATE OF i;
  SELECT * INTO v_debt FROM public.debts WHERE id = _debt_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND OR v_debt.user_id <> v_owner THEN
    RAISE EXCEPTION 'الدين غير موجود أو لا يتبع للمتجر';
  END IF;

  -- FINANCE LAW F-27 / D-04: a debt paid in the SAME foreign currency as its invoice is credited at the INVOICE's
  -- original rate. _amount stays the cash value in USD at the payment-day rate (it feeds the drawer);
  -- the difference between the two is the FX difference (D-06), kept apart from sales profit.
  v_pay_currency := upper(COALESCE(NULLIF(trim(_currency), ''), 'USD'));
  IF v_pay_currency <> 'USD' AND COALESCE(_currency_amount, 0) > 0
     AND v_debt.invoice_id IS NOT NULL AND NOT COALESCE(v_debt.is_cash_debt, false) THEN
    SELECT upper(NULLIF(trim(i.currency), '')), i.exchange_rate
      INTO v_inv_currency, v_inv_rate
      FROM public.invoices i
     WHERE i.user_id = v_owner
       AND (i.invoice_number = v_debt.invoice_id OR i.id::text = v_debt.invoice_id)
     LIMIT 1;
    IF v_inv_currency = v_pay_currency AND COALESCE(v_inv_rate, 0) > 0 THEN
      v_fx_credit_rate := v_inv_rate;
    END IF;
  END IF;
  v_credit := CASE WHEN v_fx_credit_rate IS NOT NULL THEN round(_currency_amount / v_fx_credit_rate, 8) ELSE v_amount END;

  -- Only an exactly corroborated historical payment may satisfy a new replay request.
  SELECT dp.*
    INTO v_existing_payment
    FROM public.debt_payments dp
   WHERE dp.user_id = v_owner
     AND dp.operation_id = _operation_id
   LIMIT 1;

  IF FOUND THEN
    v_legacy_currency_amount := CASE WHEN v_existing_payment.currency = 'USD' THEN v_existing_payment.amount
      ELSE v_existing_payment.currency_amount END;
    IF v_legacy_currency_amount IS NULL AND v_existing_payment.shift_id IS NOT NULL THEN
      SELECT t.currency_amount INTO v_legacy_currency_amount
        FROM public.shift_transactions t
       WHERE t.user_id = v_owner AND t.shift_id = v_existing_payment.shift_id
         AND t.type = 'debt_payment' AND t.reference_id = _operation_id
         AND t.amount = v_existing_payment.amount AND t.currency = v_existing_payment.currency
         AND t.exchange_rate = v_existing_payment.exchange_rate;
    END IF;
    IF v_existing_payment.debt_id IS DISTINCT FROM _debt_id
       OR v_existing_payment.shift_id IS DISTINCT FROM _shift_id
       OR v_existing_payment.payment_method IS DISTINCT FROM v_payment_method
       OR v_existing_payment.currency IS DISTINCT FROM (v_request->>'currency')
       OR v_existing_payment.exchange_rate IS DISTINCT FROM
          (CASE WHEN v_request->>'currency' = 'USD' THEN 1 ELSE _exchange_rate END)
       OR v_existing_payment.amount IS DISTINCT FROM v_cash_amount
       OR v_existing_payment.settled_amount IS DISTINCT FROM v_credit
       OR v_legacy_currency_amount IS NULL
       OR v_legacy_currency_amount IS DISTINCT FROM COALESCE(round(_currency_amount, 4),
          round(v_cash_amount * v_existing_payment.exchange_rate, 4)) THEN
      RAISE EXCEPTION 'تعارض في معرّف العملية (%): تعذّر إثبات تطابق بيانات الدفعة السابقة', _operation_id
        USING ERRCODE = '23505';
    END IF;

    RETURN jsonb_build_object(
      'success', true,
      'already_processed', true,
      'total_debt', v_debt.total_debt,
      'total_paid', v_debt.total_paid,
      'remaining_debt', v_debt.remaining_debt,
      'status', v_debt.status,
      'amount', v_existing_payment.amount,
      'settled_amount', v_existing_payment.settled_amount,
      'rounding_adjustment', v_existing_payment.rounding_adjustment
    );
  END IF;

  IF COALESCE(v_debt.status, '') IN ('fully_paid', 'cancelled', 'written_off') THEN
    RAISE EXCEPTION 'لا يمكن تسديد دين مغلق';
  END IF;
  IF v_payment_method NOT IN ('cash', 'transfer') THEN
    RAISE EXCEPTION 'طريقة قبض الدين غير صالحة';
  END IF;
  IF (v_payment_method = 'cash' AND _shift_id IS NULL)
     OR (v_payment_method = 'transfer' AND _shift_id IS NOT NULL) THEN
    RAISE EXCEPTION 'القبض النقدي يتطلب وردية أصلية، والتحويل لا يُرحّل إلى الصندوق';
  END IF;

  PERFORM public.assert_period_open(v_owner, CURRENT_DATE, 'تسديد دين');

  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'أدخل مبلغًا صحيحًا أكبر من الصفر';
  END IF;

  v_prev_remaining := round(COALESCE(v_debt.remaining_debt, v_debt.total_debt - COALESCE(v_debt.total_paid, 0))::numeric, 8);

  IF v_credit > v_prev_remaining + 0.005 THEN
    RAISE EXCEPTION 'المبلغ المدخل (%) أكبر من المتبقي (%)', v_credit, v_prev_remaining;
  END IF;

  -- Separate cash tendered (2 decimals) from debt settlement (snapping within 0.005 USD)
  IF abs(v_prev_remaining - v_credit) <= 0.005 THEN
    v_settlement := v_prev_remaining;
    v_new_remaining := 0;
    v_new_total_paid := v_debt.total_debt;
    v_rounding_adjustment := round(v_settlement - v_cash_amount, 8);
    IF abs(v_rounding_adjustment) > 0 THEN
      v_rounding_note := ' (تعديل تقريب: ' || v_rounding_adjustment::text || ' USD)';
    END IF;
  ELSE
    v_settlement := v_credit;
    v_rounding_adjustment := round(v_settlement - v_cash_amount, 8);
    v_new_remaining := GREATEST(round(v_prev_remaining - v_credit, 8), 0);
    v_new_total_paid := round(COALESCE(v_debt.total_paid, 0) + v_credit, 8);
  END IF;

  IF v_fx_credit_rate IS NOT NULL THEN
    v_fx_difference := round(v_cash_amount - v_settlement, 8);   -- > 0 gain, < 0 loss
    v_rounding_adjustment := 0;
    v_rounding_note := CASE WHEN v_fx_difference <> 0 THEN ' (فرق صرف: ' || v_fx_difference::text || ' USD)' ELSE '' END;
  END IF;

  v_tx_currency := upper(COALESCE(NULLIF(trim(_currency), ''), 'USD'));
  v_tx_exchange_rate := CASE WHEN v_tx_currency = 'USD' THEN 1 ELSE _exchange_rate END;
  IF COALESCE(v_tx_exchange_rate, 0) <= 0 THEN RAISE EXCEPTION 'سعر صرف الدفعة غير صالح'; END IF;
  v_tx_currency_amount := COALESCE(round(_currency_amount, 8), round(v_cash_amount * v_tx_exchange_rate, 8));
  IF v_tx_currency_amount < 0 OR abs(v_tx_currency_amount / v_tx_exchange_rate - v_cash_amount) > 0.005
     OR (v_cash_amount > 0 AND v_tx_currency_amount <= 0) THEN
    RAISE EXCEPTION 'مبلغ العملة الأصلية لا يطابق مبلغ الدفعة';
  END IF;

  IF _shift_id IS NOT NULL THEN
    PERFORM 1 FROM public.cash_shifts
     WHERE id = _shift_id AND user_id = v_owner AND closed_at IS NULL
       FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'الوردية غير موجودة أو مغلقة أو لا تتبع لهذا المتجر';
    END IF;
  END IF;

  UPDATE public.debts
     SET total_paid = v_new_total_paid,
         remaining_debt = v_new_remaining,
         status = CASE WHEN v_new_remaining <= 0 THEN 'fully_paid' ELSE 'partially_paid' END,
         notes = CASE WHEN v_rounding_note <> '' THEN concat_ws(E'\n', NULLIF(notes, ''), 'تسديد دين' || v_rounding_note) ELSE notes END,
         updated_at = now()
   WHERE id = _debt_id
  RETURNING * INTO v_debt;

  INSERT INTO public.debt_payments(
    user_id, debt_id, operation_id, amount,
    settled_amount, rounding_adjustment,
    currency, currency_amount, exchange_rate, payment_method,
    paid_by, shift_id, fx_difference_usd, fx_credit_rate
  ) VALUES (
    v_owner, _debt_id, _operation_id, v_cash_amount,
    v_settlement, v_rounding_adjustment,
    v_tx_currency, v_tx_currency_amount, v_tx_exchange_rate, v_payment_method,
    auth.uid(), _shift_id, v_fx_difference, v_fx_credit_rate
  );

  IF _shift_id IS NOT NULL AND v_cash_amount > 0 THEN
    INSERT INTO public.shift_transactions(
      shift_id, user_id, type, amount, currency, currency_amount, exchange_rate, reference_id, notes
    ) VALUES (
      _shift_id, v_owner, 'debt_payment', v_cash_amount,
      v_tx_currency, v_tx_currency_amount, v_tx_exchange_rate,
      _operation_id,
      'تسديد دين للعميل: ' || COALESCE(v_debt.customer_name, '') || v_rounding_note
    );

    IF FOUND THEN
      UPDATE public.cash_shifts
         SET expected_balance = round(COALESCE(expected_balance, 0) + v_cash_amount, 8),
             updated_at = now()
       WHERE id = _shift_id AND user_id = v_owner AND closed_at IS NULL;
    END IF;
  END IF;

  IF v_debt.invoice_id IS NOT NULL AND NOT COALESCE(v_debt.is_cash_debt, false) THEN
    UPDATE public.invoices i
       SET debt_paid = v_debt.total_paid,
           debt_remaining = v_debt.remaining_debt,
           status = CASE
             WHEN i.status IN ('refunded', 'cancelled') THEN i.status
             WHEN v_debt.remaining_debt <= 0 THEN 'paid'
             ELSE 'pending'
           END,
           updated_at = now()
     WHERE i.user_id = v_owner
       AND (i.invoice_number = v_debt.invoice_id OR i.id::text = v_debt.invoice_id);

    IF v_prev_remaining > 0 THEN
      IF v_new_remaining <= 0 THEN
        v_installment_ratio := 1.0;
      ELSE
        v_installment_ratio := LEAST(1.0, round(v_settlement / v_prev_remaining, 6));
      END IF;

      FOR p IN
        SELECT * FROM public.partners
         WHERE user_id = v_owner
           AND pending_profit_details @> jsonb_build_array(jsonb_build_object('invoiceId', v_debt.invoice_id))
         FOR UPDATE
      LOOP
        _updated_details := '[]'::jsonb;
        _total_confirmed := 0;

        FOR _item IN SELECT * FROM jsonb_array_elements(COALESCE(p.pending_profit_details, '[]'::jsonb))
        LOOP
          IF (_item->>'invoiceId') = v_debt.invoice_id THEN
            _item_amt := (_item->>'amount')::numeric;

            IF v_new_remaining <= 0 THEN
              _confirm_amt := _item_amt;
            ELSE
              _confirm_amt := round(_item_amt * v_installment_ratio, 8);
              IF abs(_item_amt - _confirm_amt) > 0.0001 THEN
                _updated_details := _updated_details || jsonb_set(_item, '{amount}', to_jsonb(round(_item_amt - _confirm_amt, 8)));
              END IF;
            END IF;

            _total_confirmed := _total_confirmed + _confirm_amt;
          ELSE
            _updated_details := _updated_details || _item;
          END IF;
        END LOOP;

        IF _total_confirmed <> 0 THEN
          _updated_history := '[]'::jsonb;
          FOR _item IN SELECT * FROM jsonb_array_elements(COALESCE(p.profit_history, '[]'::jsonb))
          LOOP
            IF (_item->>'invoiceId') = v_debt.invoice_id AND (_item->>'isDebt')::boolean = true AND v_new_remaining <= 0 THEN
              _updated_history := _updated_history || jsonb_set(_item, '{isDebt}', 'false'::jsonb);
            ELSIF (_item->>'invoiceId') = v_debt.invoice_id AND v_new_remaining <= 0
                  AND (COALESCE((_item->>'isRelease')::boolean, false) OR COALESCE(_item->>'id', '') LIKE '%-rel')
                  AND NOT COALESCE((_item->>'superseded')::boolean, false) THEN
              _updated_history := _updated_history || jsonb_set(_item, '{superseded}', 'true'::jsonb);
            ELSE
              _updated_history := _updated_history || _item;
            END IF;
          END LOOP;

          IF v_new_remaining > 0 THEN
            _updated_history := _updated_history || jsonb_build_object(
              'id', extract(epoch from now())::text || p.id::text || '-rel',
              'invoiceId', v_debt.invoice_id,
              'amount', _total_confirmed,
              'category', 'تحرير دفعة دين',
              'isRelease', true,
              'isDebt', false,
              'createdAt', now()
            );
          END IF;

          UPDATE public.partners
             SET pending_profit = round((SELECT COALESCE(SUM((x->>'amount')::numeric), 0) FROM jsonb_array_elements(_updated_details) x), 8),
                 confirmed_profit = round(COALESCE(confirmed_profit, 0) + _total_confirmed, 8),
                 current_balance = round(COALESCE(current_balance, 0) + _total_confirmed, 8),
                 total_profit_earned = round(COALESCE(total_profit_earned, 0) + _total_confirmed, 8),
                 pending_profit_details = _updated_details,
                 profit_history = _updated_history,
                 updated_at = now()
           WHERE id = p.id;
        END IF;
      END LOOP;
    END IF;
  END IF;

  -- Deterministic single-customer lookup (strict uniqueness for both phone and name)
  v_resolved_customer_id := v_debt.customer_id;
  IF v_resolved_customer_id IS NULL THEN
    IF NULLIF(trim(COALESCE(v_debt.customer_phone, '')), '') IS NOT NULL THEN
      SELECT CASE WHEN count(*) = 1 THEN (array_agg(id))[1] ELSE NULL END
        INTO v_resolved_customer_id
        FROM public.customers
       WHERE user_id = v_owner
         AND trim(COALESCE(phone, '')) = trim(v_debt.customer_phone);
    END IF;
    IF v_resolved_customer_id IS NULL AND NULLIF(trim(COALESCE(v_debt.customer_name, '')), '') IS NOT NULL THEN
      SELECT CASE WHEN count(*) = 1 THEN (array_agg(id))[1] ELSE NULL END
        INTO v_resolved_customer_id
        FROM public.customers
       WHERE user_id = v_owner
         AND trim(COALESCE(name, '')) = trim(v_debt.customer_name);
    END IF;
  END IF;

  IF v_resolved_customer_id IS NOT NULL THEN
    PERFORM public.recalc_customer_open_debt(v_owner, v_resolved_customer_id);
  END IF;

  v_response := jsonb_build_object(
    'success', true,
    'total_debt', v_debt.total_debt,
    'total_paid', v_debt.total_paid,
    'remaining_debt', v_debt.remaining_debt,
    'status', v_debt.status,
    'amount', v_cash_amount,
    'settled_amount', v_settlement,
    'rounding_adjustment', v_rounding_adjustment,
    'fx_difference_usd', v_fx_difference,
    'fx_credit_rate', v_fx_credit_rate,
    'confirmed_profit', _total_confirmed
  );
  INSERT INTO public.sales_settlement_replays(user_id, kind, operation_id, request, response)
  VALUES (v_owner, 'debt_payment', _operation_id, v_request, v_response);
  RETURN v_response;
END;
$function$
;

-- FUNCTION record_main_stock_movement | normalized md5 97da0714dc4fb5cbcafdbb213838c118
CREATE OR REPLACE FUNCTION public.record_main_stock_movement()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _before numeric;
  _after numeric;
  _movement_type text;
  _invoice_id uuid;
  _invoice_number text;
  _actor uuid;
  _source text;
  _key text;
BEGIN
  _before := CASE WHEN TG_OP = 'INSERT' THEN 0 ELSE COALESCE(OLD.quantity, 0) END;
  _after := COALESCE(NEW.quantity, 0);
  IF _before = _after THEN RETURN NEW; END IF;

  _movement_type := COALESCE(NULLIF(current_setting('app.stock_movement_type', true), ''),
    CASE WHEN TG_OP = 'INSERT' THEN 'opening_balance' WHEN _after > _before THEN 'adjustment_in' ELSE 'adjustment_out' END);
  _invoice_id := NULLIF(current_setting('app.stock_invoice_id', true), '')::uuid;
  _invoice_number := NULLIF(current_setting('app.stock_invoice_number', true), '');
  _actor := COALESCE(NULLIF(current_setting('app.stock_actor_id', true), '')::uuid, auth.uid());
  _source := COALESCE(NULLIF(current_setting('app.stock_source', true), ''), 'database_trigger');
  _key := CASE
    WHEN _movement_type = 'refund' AND _invoice_id IS NOT NULL
      THEN 'refund:' || _invoice_id::text || ':' || NEW.id::text || ':main'
    ELSE 'movement:' || gen_random_uuid()::text
  END;

  INSERT INTO public.stock_movements (
    user_id, invoice_id, invoice_number, product_id, product_name,
    warehouse_id, warehouse_name, movement_type, quantity_delta,
    quantity_before, quantity_after, unit_cost, created_by, source,
    idempotency_key, metadata
  ) VALUES (
    NEW.user_id, _invoice_id, _invoice_number, NEW.id, NEW.name,
    NULL, 'المخزون الرئيسي', _movement_type, _after - _before,
    _before, _after, COALESCE(NEW.cost_price, 0), _actor, _source,
    _key, '{}'::jsonb
  );
  RETURN NEW;
END;
$function$
;

-- FUNCTION record_shift_fx_atomic | normalized md5 44e0b3ccc7cd5d27b63b83278002efa1
CREATE OR REPLACE FUNCTION public.record_shift_fx_atomic(_shift_id uuid, _from_ccy text, _from_amount numeric, _from_usd numeric, _to_ccy text, _to_amount numeric, _to_usd numeric, _operation_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _c uuid := auth.uid(); _o uuid;
BEGIN
  IF _c IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  _o := public.get_owner_id(_c);
  IF _o IS NULL THEN RAISE EXCEPTION 'Owner context is required'; END IF;
  IF COALESCE(length(_operation_id),0) < 8 THEN RAISE EXCEPTION 'معرّف العملية غير صالح'; END IF;
  IF COALESCE(_from_ccy,'') = '' OR COALESCE(_to_ccy,'') = '' OR upper(_from_ccy) = upper(_to_ccy) THEN RAISE EXCEPTION 'اختر عملتين مختلفتين'; END IF;
  IF COALESCE(_from_amount,0) <= 0 OR COALESCE(_to_amount,0) <= 0 OR COALESCE(_from_usd,0) <= 0 OR COALESCE(_to_usd,0) <= 0 THEN RAISE EXCEPTION 'المبالغ يجب أن تكون أكبر من الصفر'; END IF;
  PERFORM 1 FROM public.cash_shifts WHERE id=_shift_id AND user_id=_o AND closed_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'لا توجد وردية مفتوحة'; END IF;
  PERFORM public.assert_period_open(_o, CURRENT_DATE, 'تحويل عملة في الوردية');
  INSERT INTO public.shift_transactions(shift_id,user_id,type,amount,reference_id,notes,currency,currency_amount,exchange_rate)
  VALUES (_shift_id,_o,'fx_out',round(_from_usd,4),_operation_id,'تحويل عملة (خارج)',upper(_from_ccy),round(_from_amount,4),round(_from_amount/_from_usd,8))
  ON CONFLICT (shift_id,type,reference_id) DO NOTHING;
  INSERT INTO public.shift_transactions(shift_id,user_id,type,amount,reference_id,notes,currency,currency_amount,exchange_rate)
  VALUES (_shift_id,_o,'fx_in',round(_to_usd,4),_operation_id,'تحويل عملة (داخل)',upper(_to_ccy),round(_to_amount,4),round(_to_amount/_to_usd,8))
  ON CONFLICT (shift_id,type,reference_id) DO NOTHING;
END $function$
;

-- FUNCTION record_stock_damage_atomic | normalized md5 0310c170ddaaf5dac2d05f4c300ff966
CREATE OR REPLACE FUNCTION public.record_stock_damage_atomic(_product_id uuid, _warehouse_id uuid, _quantity numeric, _unit_cost numeric DEFAULT NULL::numeric, _reason text DEFAULT NULL::text, _notes text DEFAULT NULL::text, _apply_to_stock boolean DEFAULT true, _source text DEFAULT 'manual'::text, _source_ref text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _caller uuid := auth.uid();
  _owner uuid;
  _p record;
  _qty numeric;
  _ws_qty numeric;
  _cost numeric;
  _id uuid;
  _name text;
  _ref_uuid uuid;
BEGIN
  IF _caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  _owner := public.get_owner_id(_caller);
  IF _owner IS NULL THEN
    RAISE EXCEPTION 'owner not found';
  END IF;

  _qty := round(COALESCE(_quantity, 0), 3);
  IF _qty <= 0 THEN
    RAISE EXCEPTION 'الكمية يجب أن تكون أكبر من الصفر';
  END IF;

  PERFORM public.assert_period_open(_owner, CURRENT_DATE, 'تسجيل تالف');

  IF _warehouse_id IS NOT NULL THEN
    PERFORM 1 FROM public.warehouses WHERE id = _warehouse_id AND user_id = _owner;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'المستودع غير موجود أو لا يتبع لهذا المتجر';
    END IF;
  END IF;

  SELECT id, name, quantity, cost_price
    INTO _p
    FROM public.products
   WHERE id = _product_id AND user_id = _owner
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'المنتج غير موجود';
  END IF;

  _cost := COALESCE(_unit_cost, _p.cost_price, 0);
  IF _cost < 0 THEN
    RAISE EXCEPTION 'التكلفة غير صالحة';
  END IF;

  IF COALESCE(_apply_to_stock, true) THEN
    PERFORM set_config('app.stock_movement_type', 'damage', true);
    PERFORM set_config('app.stock_actor_id', _caller::text, true);
    PERFORM set_config('app.stock_source', 'record_stock_damage_atomic', true);

    IF _warehouse_id IS NOT NULL THEN
      SELECT quantity
        INTO _ws_qty
        FROM public.warehouse_stock
       WHERE warehouse_id = _warehouse_id AND product_id = _product_id
         FOR UPDATE;

      IF NOT FOUND OR COALESCE(_ws_qty, 0) < _qty THEN
        RAISE EXCEPTION 'الكمية التالفة (%) أكبر من المخزون المتاح في المستودع (%)', _qty, COALESCE(_ws_qty, 0);
      END IF;

      UPDATE public.warehouse_stock
         SET quantity = round(_ws_qty - _qty, 3),
             last_updated = now()
       WHERE warehouse_id = _warehouse_id AND product_id = _product_id;
    ELSE
      IF COALESCE(_p.quantity, 0) < _qty THEN
        RAISE EXCEPTION 'الكمية التالفة (%) أكبر من المخزون المتاح (%)', _qty, COALESCE(_p.quantity, 0);
      END IF;

      UPDATE public.products
         SET quantity = round(quantity - _qty, 3),
             updated_at = now()
       WHERE id = _product_id;
    END IF;
  END IF;

  SELECT COALESCE(full_name, 'مستخدم') INTO _name
    FROM public.profiles
   WHERE user_id = _caller;

  _ref_uuid := CASE
    WHEN _source_ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN _source_ref::uuid
    ELSE NULL
  END;

  INSERT INTO public.stock_damages(
    user_id, product_id, product_name, warehouse_id, quantity, unit_cost, cost_value,
    reason, notes, damaged_at, recorded_by, recorded_by_name, source, source_ref
  ) VALUES (
    _owner, _product_id, _p.name, _warehouse_id, _qty, _cost, round(_qty * _cost, 8),
    _reason, _notes, now(), _caller, COALESCE(_name, 'مستخدم'), COALESCE(_source, 'manual'), _ref_uuid
  ) RETURNING id INTO _id;

  RETURN _id;
END;
$function$
;

-- FUNCTION record_warehouse_stock_movement | normalized md5 7ba9137f50a6b388bfebc87add631e6d
CREATE OR REPLACE FUNCTION public.record_warehouse_stock_movement()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _before numeric;
  _after numeric;
  _owner uuid;
  _product_name text;
  _warehouse_name text;
  _unit_cost numeric;
  _movement_type text;
  _invoice_id uuid;
  _invoice_number text;
  _actor uuid;
  _source text;
  _key text;
BEGIN
  _before := CASE WHEN TG_OP = 'INSERT' THEN 0 ELSE COALESCE(OLD.quantity, 0) END;
  _after := COALESCE(NEW.quantity, 0);
  IF _before = _after THEN RETURN NEW; END IF;

  SELECT w.user_id, w.name INTO _owner, _warehouse_name
  FROM public.warehouses w WHERE w.id = NEW.warehouse_id;
  SELECT p.name, COALESCE(p.cost_price, 0) INTO _product_name, _unit_cost
  FROM public.products p WHERE p.id = NEW.product_id;

  IF _owner IS NULL THEN RAISE EXCEPTION 'Warehouse owner not found'; END IF;

  _movement_type := COALESCE(NULLIF(current_setting('app.stock_movement_type', true), ''),
    CASE WHEN TG_OP = 'INSERT' THEN 'opening_balance' WHEN _after > _before THEN 'adjustment_in' ELSE 'adjustment_out' END);
  _invoice_id := NULLIF(current_setting('app.stock_invoice_id', true), '')::uuid;
  _invoice_number := NULLIF(current_setting('app.stock_invoice_number', true), '');
  _actor := COALESCE(NULLIF(current_setting('app.stock_actor_id', true), '')::uuid, auth.uid());
  _source := COALESCE(NULLIF(current_setting('app.stock_source', true), ''), 'database_trigger');
  _key := CASE
    WHEN _movement_type = 'refund' AND _invoice_id IS NOT NULL
      THEN 'refund:' || _invoice_id::text || ':' || NEW.product_id::text || ':' || NEW.warehouse_id::text
    ELSE 'movement:' || gen_random_uuid()::text
  END;

  INSERT INTO public.stock_movements (
    user_id, invoice_id, invoice_number, product_id, product_name,
    warehouse_id, warehouse_name, movement_type, quantity_delta,
    quantity_before, quantity_after, unit_cost, created_by, source,
    idempotency_key, metadata
  ) VALUES (
    _owner, _invoice_id, _invoice_number, NEW.product_id, _product_name,
    NEW.warehouse_id, _warehouse_name, _movement_type, _after - _before,
    _before, _after, COALESCE(_unit_cost, 0), _actor, _source,
    _key, '{}'::jsonb
  );
  RETURN NEW;
END;
$function$
;

-- FUNCTION refund_invoice_atomic | normalized md5 1d2e9a20630b307937a507a48e254b85
CREATE OR REPLACE FUNCTION public.refund_invoice_atomic(_invoice_number text, _source text DEFAULT 'online'::text, _shift_id uuid DEFAULT NULL::uuid, _currency text DEFAULT NULL::text, _currency_amount numeric DEFAULT NULL::numeric, _exchange_rate numeric DEFAULT NULL::numeric, _settlement_mode text DEFAULT 'drawer'::text)
 RETURNS TABLE(success boolean, already_refunded boolean, invoice_id uuid, invoice_number text, invoice_total numeric, invoice_currency text, restored_item_count integer, restored_unit_count numeric, deleted_debt_amount numeric, customer_name text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _caller uuid := auth.uid();
  _owner uuid;
  _invoice public.invoices%ROWTYPE;
  _restored_items integer := 0;
  _restored_units numeric := 0;
  _deleted_debt numeric := 0;
  _has_refund boolean := false;
  _track_inventory boolean := true;
  _store_type text;
  _row record;
  _main constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  _settlement jsonb;
  _request jsonb;
  _response jsonb;
  _norm_settlement_mode text := lower(COALESCE(NULLIF(trim(_settlement_mode), ''), 'drawer'));

BEGIN
  IF _caller IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  _owner := public.get_owner_id(_caller);

  IF public.can_refund_invoices(auth.uid()) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'ليست لديك صلاحية الاسترداد. اطلبها من مالك المتجر' USING ERRCODE = '42501';
  END IF;

  IF _norm_settlement_mode NOT IN ('drawer', 'external_cash') THEN
    RAISE EXCEPTION 'وضع التسوية غير صالح: %', _settlement_mode;
  END IF;

  _request := jsonb_build_object('invoice_number', _invoice_number, 'shift_id', _shift_id,
    'currency', _currency, 'currency_amount', _currency_amount, 'exchange_rate', _exchange_rate, 'settlement_mode', _norm_settlement_mode);
  _response := public._read_sales_settlement_replay(_owner, 'full_refund', _invoice_number, _request);

  SELECT i.* INTO _invoice
  FROM public.invoices i
  WHERE i.invoice_number = _invoice_number AND i.user_id = _owner
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, false, NULL::uuid, _invoice_number, 0::numeric, NULL::text, 0, 0::numeric, 0::numeric, NULL::text;
    RETURN;
  END IF;

  IF COALESCE(_invoice.status, '') IN ('cancelled', 'written_off') THEN
    RAISE EXCEPTION 'لا يمكن استرداد فاتورة ملغاة أو مشطوبة';
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM public.stock_movements sm
    WHERE sm.user_id = _owner AND sm.invoice_id = _invoice.id AND sm.movement_type = 'refund'
  ) INTO _has_refund;

  -- Idempotent retry: return previously recorded result only (never create a new drawer tx)
  IF _invoice.status = 'refunded' OR _has_refund THEN
    RETURN QUERY SELECT false, true, _invoice.id, _invoice.invoice_number, COALESCE(_invoice.total, 0)::numeric, _invoice.currency::text, 0, 0::numeric, 0::numeric, _invoice.customer_name::text;
    RETURN;
  END IF;

  PERFORM public.assert_period_open(_owner, CURRENT_DATE, 'استرداد الفاتورة');

  _settlement := public._allocate_sales_refund(_invoice, 'full_refund', _invoice_number,
    CASE WHEN _invoice.payment_type = 'debt' THEN _invoice.debt_paid ELSE _invoice.total END,
    _shift_id, _norm_settlement_mode);
  PERFORM public._assert_sales_refund_currency(_settlement, _currency, _currency_amount, _exchange_rate);

  SELECT s.store_type INTO _store_type FROM public.stores s WHERE s.user_id = _owner ORDER BY s.created_at LIMIT 1;
  _track_inventory := NOT (COALESCE(_store_type, 'general') IN ('bakery', 'repair', 'restaurant'));

  CREATE TEMP TABLE IF NOT EXISTS pg_temp.refund_items(
    product_id uuid NOT NULL,
    warehouse_key uuid NOT NULL,
    quantity numeric(14,3) NOT NULL,
    PRIMARY KEY(product_id, warehouse_key)
  ) ON COMMIT DROP;
  TRUNCATE pg_temp.refund_items;

  INSERT INTO pg_temp.refund_items(product_id, warehouse_key, quantity)
  SELECT
    ii.product_id,
    COALESCE(ii.stock_warehouse_id, _main),
    SUM(GREATEST(COALESCE(ii.quantity, 0), 0) * (CASE WHEN ii.unit = 'bulk' THEN GREATEST(COALESCE(ii.conversion_factor, 1), 1) ELSE 1 END))
  FROM public.invoice_items ii
  WHERE ii.invoice_id = _invoice.id AND ii.product_id IS NOT NULL
  GROUP BY ii.product_id, COALESCE(ii.stock_warehouse_id, _main)
  ON CONFLICT(product_id, warehouse_key) DO UPDATE SET quantity = pg_temp.refund_items.quantity + EXCLUDED.quantity;

  PERFORM set_config('app.stock_movement_type', 'refund', true);
  PERFORM set_config('app.stock_invoice_id', _invoice.id::text, true);
  PERFORM set_config('app.stock_invoice_number', _invoice.invoice_number, true);
  PERFORM set_config('app.stock_actor_id', _caller::text, true);
  PERFORM set_config('app.stock_source', CASE WHEN _source = 'offline-sync' THEN 'offline-sync' ELSE 'online' END, true);
  PERFORM set_config('app.refund_context', 'allowed', true);

  IF _track_inventory THEN
    FOR _row IN SELECT * FROM pg_temp.refund_items WHERE quantity > 0 LOOP
      IF _row.warehouse_key = _main THEN
        UPDATE public.products SET quantity = COALESCE(quantity, 0) + _row.quantity WHERE id = _row.product_id AND user_id = _owner;
      ELSE
        UPDATE public.warehouse_stock ws SET quantity = COALESCE(ws.quantity, 0) + _row.quantity, last_updated = now()
        WHERE ws.warehouse_id = _row.warehouse_key AND ws.product_id = _row.product_id;
        IF NOT FOUND THEN
          UPDATE public.products SET quantity = COALESCE(quantity, 0) + _row.quantity WHERE id = _row.product_id AND user_id = _owner;
        END IF;
      END IF;
    END LOOP;
    SELECT COUNT(*)::integer, COALESCE(SUM(quantity), 0)::numeric INTO _restored_items, _restored_units FROM pg_temp.refund_items WHERE quantity > 0;
  END IF;

  SELECT COALESCE(SUM(d.remaining_debt), 0)::numeric INTO _deleted_debt FROM public.debts d WHERE d.user_id = _owner AND (d.invoice_id = _invoice.invoice_number OR d.invoice_id = _invoice.id::text);

  UPDATE public.debts d SET status = 'cancelled', remaining_debt = 0, notes = concat_ws(E'\n', NULLIF(d.notes,''), 'ملغى بسبب مرتجع الفاتورة '||now()::text), updated_at = now() WHERE d.user_id = _owner AND (d.invoice_id = _invoice.invoice_number OR d.invoice_id = _invoice.id::text);

  IF _invoice.customer_id IS NOT NULL THEN
    UPDATE public.customers c SET total_purchases = s.total_purchases, total_debt = s.total_debt, invoice_count = s.invoice_count
    FROM (
      SELECT
        COALESCE(SUM(i.total) FILTER(WHERE i.id <> _invoice.id AND COALESCE(i.status, '') NOT IN ('refunded', 'cancelled')), 0)::numeric AS total_purchases,
        COALESCE(SUM(i.debt_remaining) FILTER(WHERE i.id <> _invoice.id AND COALESCE(i.status, '') NOT IN ('refunded', 'cancelled', 'paid') AND i.payment_type = 'debt'), 0)::numeric AS total_debt,
        COUNT(*) FILTER(WHERE i.id <> _invoice.id AND COALESCE(i.status, '') NOT IN ('refunded', 'cancelled'))::integer AS invoice_count
      FROM public.invoices i
      WHERE i.user_id = _owner AND i.customer_id = _invoice.customer_id
    ) s
    WHERE c.id = _invoice.customer_id AND c.user_id = _owner;
    PERFORM public.recalc_customer_open_debt(_owner, _invoice.customer_id);
  END IF;

  UPDATE public.invoice_items ii SET profit = 0 WHERE ii.invoice_id = _invoice.id;

  UPDATE public.invoices
  SET status = 'refunded',
      profit = 0,
      debt_remaining = 0,
      notes = concat_ws(E'\n', NULLIF(_invoice.notes, ''), 'Refunded at ' || now()::text),
      updated_at = now()
  WHERE id = _invoice.id;

  PERFORM public.revert_invoice_partner_profits_atomic(_invoice.id, 1.0);

  -- Atomically reverse profit_records within the same transaction
  UPDATE public.profit_records
     SET is_reversed = true,
         reversed_at = now()
   WHERE user_id = _owner
     AND profit_records.invoice_id IN (_invoice.invoice_number, _invoice.id::text)
     AND is_reversed = false;

  INSERT INTO public.activity_log(user_id, actor_id, actor_name, actor_role, action_type, entity_type, entity_id, entity_name, description, metadata)
  SELECT
    _owner, _caller, COALESCE(p.full_name, _invoice.cashier_name, 'مستخدم'), ur.role::text,
    'invoice_refunded', 'invoice', _invoice.id::text, _invoice.invoice_number,
    'تم استرداد الفاتورة ' || _invoice.invoice_number,
    jsonb_build_object(
      'invoice_number', _invoice.invoice_number,
      'invoice_total', COALESCE(_invoice.total, 0),
      'invoice_currency', _invoice.currency,
      'cash_refund_amount', (_settlement->>'cash')::numeric,
      'digital_to_refund', (_settlement->>'digital')::numeric,
      'receipt_allocation', true,
      'settlement_allocations', _settlement->'allocations',
      'shift_id', _shift_id,
      'settlement_mode', _norm_settlement_mode,
      'restored_items', _restored_items,
      'restored_units', _restored_units,
      'deleted_debt_amount', _deleted_debt,
      'source', CASE WHEN _source = 'offline-sync' THEN 'offline-sync' ELSE 'online' END
    )
  FROM (SELECT 1) seed
  LEFT JOIN public.profiles p ON p.user_id = _caller
  LEFT JOIN public.user_roles ur ON ur.user_id = _caller
  LIMIT 1;

  _response := _settlement || jsonb_build_object('invoice_id', _invoice.id, 'invoice_number', _invoice.invoice_number,
    'restored_item_count', _restored_items, 'restored_unit_count', _restored_units, 'deleted_debt_amount', _deleted_debt);
  INSERT INTO public.sales_settlement_replays(user_id, kind, operation_id, request, response)
  VALUES (_owner, 'full_refund', _invoice_number, _request, _response);

  RETURN QUERY SELECT true, false, _invoice.id, _invoice.invoice_number, COALESCE(_invoice.total, 0)::numeric, _invoice.currency::text, _restored_items, _restored_units, _deleted_debt, _invoice.customer_name::text;
END;
$function$
;

-- FUNCTION refund_invoice_partial_atomic | normalized md5 0bd411ad5eb71ec8c8e28fdbb05477ca
CREATE OR REPLACE FUNCTION public.refund_invoice_partial_atomic(_invoice_number text, _items jsonb, _operation_id text, _shift_id uuid DEFAULT NULL::uuid, _currency text DEFAULT NULL::text, _currency_amount numeric DEFAULT NULL::numeric, _exchange_rate numeric DEFAULT NULL::numeric, _settlement_mode text DEFAULT 'drawer'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _inv public.invoices%ROWTYPE; _owner uuid; _item jsonb; _pid uuid; _pname text; _qty numeric; _avail numeric;
  _line record; _take numeric; _factor numeric;
  _gross numeric := 0; _refund numeric := 0; _cogs numeric := 0; _restored numeric := 0;
  _new_sub numeric; _new_disc numeric; _new_tax numeric; _new_total numeric; _new_profit numeric;
  _remaining_units numeric; _full boolean; _debt_red numeric := 0; _cash numeric := 0; _paid_red numeric := 0; _new_debt numeric;
  _digital_to_refund numeric := 0;
  _drawer_tx_recorded boolean := false;
  _drawer_refund_usd numeric := 0;
  _norm_settlement_mode text := lower(COALESCE(NULLIF(trim(_settlement_mode), ''), 'drawer'));
  _profit_ratio numeric := 0;
  _f numeric := 1;
  _disc_ratio numeric := 0;
  _profit_red numeric := 0;
  _unit_factor numeric := 1;
  _track_inventory boolean := true;
  _store_type text;
  _category_profits jsonb := '{}'::jsonb;
  _line_cat text;
  _line_profit_red numeric;
  _prev_meta jsonb;
  _prev_cash numeric := 0;
  _ccy text;
  _rate numeric;
  _ccy_amt numeric;
  _shift_ref text;
  _inserted int := 0;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  _owner := public.get_owner_id(auth.uid());

  IF NOT public.can_refund_invoices(auth.uid()) THEN
    RAISE EXCEPTION 'ليست لديك صلاحية الاسترداد. اطلبها من مالك المتجر' USING ERRCODE = '42501';
  END IF;

  IF _norm_settlement_mode NOT IN ('drawer', 'external_cash') THEN
    RAISE EXCEPTION 'وضع التسوية غير صالح: %', _settlement_mode;
  END IF;

  SELECT * INTO _inv FROM public.invoices WHERE invoice_number=_invoice_number AND user_id=_owner FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'error','invoice_not_found'); END IF;
  IF COALESCE(_inv.status, '') IN ('cancelled', 'written_off') THEN
    RAISE EXCEPTION 'لا يمكن استرداد فاتورة ملغاة أو مشطوبة';
  END IF;
  IF _inv.status='refunded' THEN
    SELECT COALESCE((al.metadata->>'cash_to_refund')::numeric, 0)
      INTO _prev_cash
    FROM public.activity_log al
    WHERE al.user_id = _owner
      AND al.action_type = 'partial_refund'
      AND al.entity_id = _inv.id::text
    ORDER BY al.created_at DESC
    LIMIT 1;
    RETURN jsonb_build_object(
      'success', true,
      'already_refunded', true,
      'already_processed', true,
      'invoice_id', _inv.id,
      'invoice_number', _inv.invoice_number,
      'new_total', _inv.total,
      'cash_to_refund', COALESCE(_prev_cash, 0),
      'drawer_tx_recorded', false,
      'drawer_refund_usd', 0,
      'digital_to_refund', 0
    );
  END IF;
  IF _operation_id IS NOT NULL THEN
    SELECT al.metadata INTO _prev_meta
    FROM public.activity_log al
    WHERE al.user_id = _owner
      AND al.action_type = 'partial_refund'
      AND al.metadata->>'operation_id' = _operation_id
    ORDER BY al.created_at DESC
    LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'success', true,
        'already_processed', true,
        'invoice_id', _inv.id,
        'invoice_number', _inv.invoice_number,
        'new_total', _inv.total,
        'new_profit', _inv.profit,
        'new_debt_remaining', _inv.debt_remaining,
        'cash_to_refund', COALESCE((_prev_meta->>'cash_to_refund')::numeric, 0),
        'drawer_tx_recorded', false,
        'drawer_refund_usd', 0,
        'digital_to_refund', COALESCE((_prev_meta->>'digital_to_refund')::numeric, 0)
      );
    END IF;
  END IF;

  PERFORM public.assert_period_open(_owner, _inv.date, 'الاسترداد الجزئي');

  SELECT s.store_type INTO _store_type FROM public.stores s WHERE s.user_id = _owner ORDER BY s.created_at LIMIT 1;
  _track_inventory := NOT (COALESCE(_store_type, 'general') IN ('bakery', 'repair', 'restaurant'));

  _factor := CASE WHEN COALESCE(_inv.subtotal,0) > 0 THEN COALESCE(_inv.total,0)/_inv.subtotal ELSE 1 END;
  IF COALESCE(_inv.tax_inclusive, false) AND COALESCE(_inv.tax_rate, 0) > 0 THEN
    _f := 1 / (1 + _inv.tax_rate / 100);
  END IF;
  IF COALESCE(_inv.subtotal,0) > 0 THEN
    _disc_ratio := LEAST(GREATEST(COALESCE(_inv.discount,0) / _inv.subtotal, 0), 1);
  END IF;

  PERFORM set_config('app.stock_movement_type','partial_refund',true);
  PERFORM set_config('app.stock_invoice_id',_inv.id::text,true);
  PERFORM set_config('app.stock_invoice_number',_inv.invoice_number,true);
  PERFORM set_config('app.stock_actor_id',auth.uid()::text,true);
  PERFORM set_config('app.stock_source','partial_refund',true);

  FOR _item IN SELECT * FROM jsonb_array_elements(COALESCE(_items,'[]'::jsonb)) LOOP
    _pid := NULLIF(_item->>'product_id','')::uuid;
    _pname := NULLIF(regexp_replace(trim(COALESCE(_item->>'product_name','')),'\s+',' ','g'),'');
    _qty := round(COALESCE(NULLIF(_item->>'quantity','')::numeric,0),3);
    IF _qty <= 0 THEN CONTINUE; END IF;

    SELECT COALESCE(SUM(quantity),0) INTO _avail FROM public.invoice_items ii
    WHERE ii.invoice_id=_inv.id AND ((_pid IS NOT NULL AND ii.product_id=_pid) OR (_pid IS NULL AND regexp_replace(trim(ii.product_name),'\s+',' ','g')=_pname));
    IF _avail < _qty THEN RAISE EXCEPTION 'Refund quantity % exceeds remaining % for %',_qty,_avail,COALESCE(_pname,'item'); END IF;

    FOR _line IN SELECT * FROM public.invoice_items ii
      WHERE ii.invoice_id=_inv.id AND ii.quantity>0 AND ((_pid IS NOT NULL AND ii.product_id=_pid) OR (_pid IS NULL AND regexp_replace(trim(ii.product_name),'\s+',' ','g')=_pname))
      ORDER BY ii.id FOR UPDATE
    LOOP
      EXIT WHEN _qty <= 0;
      _take := LEAST(_qty, _line.quantity);
      UPDATE public.invoice_items SET quantity=quantity-_take,
        amount_original=CASE
          WHEN COALESCE(_line.quantity, 0) > 0 AND COALESCE(_line.amount_original, 0) <> 0
            THEN round(_line.amount_original * (quantity - _take) / _line.quantity, 8)
          ELSE round(COALESCE(unit_price, 0) * (quantity - _take) * COALESCE(_inv.exchange_rate, 1), 8)
        END,
        amount_usd=round(COALESCE(unit_price,0)*(quantity-_take),8),
        profit=round(COALESCE(unit_price,0)*(quantity-_take)*(1-_disc_ratio)*_f - COALESCE(cost_price,0)*(quantity-_take),8)
      WHERE id=_line.id;
      _unit_factor := CASE WHEN COALESCE(_line.unit,'piece') = 'bulk' THEN GREATEST(COALESCE(_line.conversion_factor,1),1) ELSE 1 END;
      _gross := _gross + _take*COALESCE(_line.unit_price,0);
      _cogs := _cogs + _take*COALESCE(_line.cost_price,0);

      -- Accumulate per-category refunded profit for exact category partner reversal
      -- Prefer category_snapshot frozen at sale time; fall back to current product category
      _line_cat := NULLIF(trim(_line.category_snapshot), '');
      IF _line_cat IS NULL AND _line.product_id IS NOT NULL THEN
        SELECT NULLIF(trim(p.category), '')
          INTO _line_cat
        FROM public.products p
        WHERE p.id = _line.product_id AND p.user_id = _owner;
      END IF;
      _line_cat := COALESCE(_line_cat, 'عام');
      _line_profit_red := round(_take * COALESCE(_line.unit_price, 0) * (1 - _disc_ratio) * _f - _take * COALESCE(_line.cost_price, 0), 8);
      IF _line_profit_red <> 0 THEN
        _category_profits := jsonb_set(
          _category_profits,
          ARRAY[_line_cat],
          to_jsonb(round(COALESCE((_category_profits->>_line_cat)::numeric, 0) + _line_profit_red, 8)),
          true
        );
      END IF;

      IF _track_inventory AND _line.product_id IS NOT NULL THEN
        IF _line.stock_warehouse_id IS NOT NULL THEN
          UPDATE public.warehouse_stock SET quantity=COALESCE(quantity,0)+_take*_unit_factor,last_updated=now()
          WHERE warehouse_id=_line.stock_warehouse_id AND product_id=_line.product_id;
          IF NOT FOUND THEN
            UPDATE public.products SET quantity=COALESCE(quantity,0)+_take*_unit_factor WHERE id=_line.product_id AND user_id=_owner;
          END IF;
        ELSE
          UPDATE public.products SET quantity=COALESCE(quantity,0)+_take*_unit_factor WHERE id=_line.product_id AND user_id=_owner;
        END IF;
      END IF;
      _restored := _restored + _take;
      _qty := _qty - _take;
    END LOOP;
  END LOOP;

  IF _restored <= 0 THEN RAISE EXCEPTION 'No items selected for refund'; END IF;

  -- Run explicit serial validation/release BEFORE updating invoices.status to 'refunded'
  -- so trg_release_serials_on_refund does not pre-release serials and break final partial refunds.
  DECLARE _ri record; _sid uuid; _released int; -- _refund_serial_release_v2
  BEGIN
    FOR _ri IN
      SELECT (e->>'product_id')::uuid AS pid,
             floor(COALESCE((e->>'quantity')::numeric,0) * COALESCE((SELECT CASE WHEN ii.unit='bulk' THEN GREATEST(COALESCE(ii.conversion_factor,1),1) ELSE 1 END FROM public.invoice_items ii WHERE ii.invoice_id=_inv.id AND ii.product_id=(e->>'product_id')::uuid LIMIT 1),1))::int AS q,
             CASE WHEN jsonb_typeof(e->'serials') = 'array' THEN ARRAY(SELECT lower(trim(x)) FROM jsonb_array_elements_text(e->'serials') x WHERE trim(x) <> '') ELSE NULL END AS req_serials
      FROM jsonb_array_elements(_items) e
      WHERE NULLIF(e->>'product_id','') IS NOT NULL
    LOOP
      IF _ri.q > 0 AND EXISTS (SELECT 1 FROM public.products WHERE id=_ri.pid AND track_serials) THEN
        IF _ri.req_serials IS NOT NULL AND cardinality(_ri.req_serials) > 0 THEN
          IF cardinality(_ri.req_serials) <> _ri.q THEN
            RAISE EXCEPTION 'عدد الأرقام التسلسلية المحددة للاسترداد (%) لا يطابق الكمية (%)', cardinality(_ri.req_serials), _ri.q;
          END IF;
          _released := 0;
          FOR _sid IN
            SELECT id FROM public.product_serials
             WHERE user_id=_owner AND sold_invoice_id=_inv.id AND product_id=_ri.pid AND status='sold'
               AND lower(serial) = ANY(_ri.req_serials)
             FOR UPDATE
          LOOP
            UPDATE public.product_serials SET status='in_stock', sold_invoice_id=NULL, sold_invoice_number=NULL, sold_at=NULL, customer_name=NULL, warranty_until=NULL, updated_at=now() WHERE id=_sid;
            INSERT INTO public.product_serial_events(user_id,serial_id,event,ref,actor) VALUES (_owner,_sid,'customer_return',_inv.invoice_number,auth.uid());
            _released := _released + 1;
          END LOOP;
          IF _released <> cardinality(_ri.req_serials) THEN
            RAISE EXCEPTION 'بعض الأرقام التسلسلية المحددة غير مرتبطة بهذه الفاتورة أو سبق إرجاعها';
          END IF;
        ELSE
          FOR _sid IN SELECT id FROM public.product_serials WHERE user_id=_owner AND sold_invoice_id=_inv.id AND product_id=_ri.pid AND status='sold' ORDER BY sold_at DESC, id LIMIT _ri.q FOR UPDATE LOOP
            UPDATE public.product_serials SET status='in_stock', sold_invoice_id=NULL, sold_invoice_number=NULL, sold_at=NULL, customer_name=NULL, warranty_until=NULL, updated_at=now() WHERE id=_sid;
            INSERT INTO public.product_serial_events(user_id,serial_id,event,ref,actor) VALUES (_owner,_sid,'customer_return',_inv.invoice_number,auth.uid());
          END LOOP;
        END IF;
      END IF;
    END LOOP;
  END;

  _refund := round(_gross*_factor,8);
  _profit_red := round(_gross*(1-_disc_ratio)*_f - _cogs, 8);
  _new_sub := GREATEST(round(COALESCE(_inv.subtotal,0)-_gross,8),0);
  IF COALESCE(_inv.subtotal,0) > 0 THEN
    _new_disc := round(COALESCE(_inv.discount,0)*_new_sub/_inv.subtotal,8);
    _new_tax := round(COALESCE(_inv.tax_amount,0)*_new_sub/_inv.subtotal,8);
  ELSE _new_disc := 0; _new_tax := 0; END IF;
  _new_total := GREATEST(round(COALESCE(_inv.total,0)-_refund,8),0);
  _new_profit := round(COALESCE(_inv.profit,0)-_profit_red,8);

  SELECT COALESCE(SUM(quantity),0) INTO _remaining_units FROM public.invoice_items WHERE invoice_id=_inv.id;
  _full := _remaining_units <= 0;
  IF _full THEN _new_total := 0; _new_profit := 0; _new_sub := 0; _new_disc := 0; _new_tax := 0; END IF;

  IF _full THEN
    _profit_ratio := 1.0;
  ELSIF COALESCE(_inv.profit, 0) <> 0 THEN
    _profit_ratio := LEAST(GREATEST(_profit_red / _inv.profit, 0.0), 1.0);
  ELSE
    _profit_ratio := LEAST(GREATEST(_refund / GREATEST(COALESCE(_inv.total, 0.0001), 0.0001), 0.0), 1.0);
  END IF;

  IF _inv.payment_type='debt' THEN
    _debt_red := LEAST(_refund, GREATEST(COALESCE(_inv.debt_remaining,0),0));
    _paid_red := round(_refund-_debt_red,8);
  ELSE
    _debt_red := 0;
    _paid_red := 0;
  END IF;

  IF COALESCE(_inv.payment_method, 'cash') = 'digital' THEN
    _cash := 0;
    _digital_to_refund := CASE WHEN _inv.payment_type='debt' THEN _paid_red ELSE _refund END;
  ELSIF _inv.payment_type='debt' THEN
    _cash := _paid_red;
    _digital_to_refund := 0;
  ELSE
    _cash := _refund;
    _digital_to_refund := 0;
  END IF;

  _new_debt := CASE WHEN _inv.payment_type='debt' THEN GREATEST(round(COALESCE(_inv.debt_remaining,0)-_debt_red,8),0) ELSE COALESCE(_inv.debt_remaining,0) END;

  -- Drawer shift guard & atomic cash drawer refund when _cash > 0
  IF _cash > 0 AND COALESCE(_inv.payment_method, 'cash') = 'cash' AND _norm_settlement_mode <> 'external_cash' THEN
    IF _shift_id IS NULL THEN
      RAISE EXCEPTION 'يجب فتح وردية صندوق نشطة لتنفيذ الاسترداد النقدي أو اختيار التسوية النقدية الخارجية';
    END IF;

    PERFORM 1 FROM public.cash_shifts
    WHERE id = _shift_id AND user_id = _owner AND closed_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'الوردية غير موجودة أو مغلقة أو لا تتبع لهذا المتجر';
    END IF;

    _ccy := upper(COALESCE(NULLIF(trim(_currency), ''), NULLIF(trim(_inv.currency), ''), 'USD'));
    IF _ccy = 'USD' THEN
      _rate := 1.0;
      _ccy_amt := round(_cash, 2);
    ELSE
      _rate := COALESCE(_exchange_rate, NULLIF(_inv.exchange_rate, 0), 0);
      IF _rate <= 0 THEN
        RAISE EXCEPTION 'سعر الصرف غير صالح';
      END IF;
      _ccy_amt := round(COALESCE(_currency_amount, _cash * _rate), 2);
      IF _ccy_amt <= 0 THEN
        RAISE EXCEPTION 'المبلغ الأصلي غير صالح';
      END IF;
      IF _currency_amount IS NOT NULL AND _currency_amount > 0 THEN
        IF abs(_ccy_amt - round(_cash * _rate, 2)) > GREATEST(0.05, _ccy_amt * 0.01) THEN
          RAISE EXCEPTION 'تعارض في تحويل العملة: المبلغ الأصلي (%) لا يطابق المبلغ بالدولار (%) × سعر الصرف (%)',
            _ccy_amt, round(_cash, 2), _rate;
        END IF;
      END IF;
    END IF;

    _shift_ref := COALESCE(NULLIF(trim(_operation_id), ''), _inv.invoice_number || ':' || gen_random_uuid()::text);
    INSERT INTO public.shift_transactions (
      shift_id, user_id, type, amount, currency_amount, currency, exchange_rate, notes, reference_id
    ) VALUES (
      _shift_id, _owner, 'refund', round(_cash, 4), _ccy_amt, _ccy, _rate,
      'استرداد جزئي للفاتورة ' || _inv.invoice_number,
      _shift_ref
    )
    ON CONFLICT (shift_id, type, reference_id) DO NOTHING;

    GET DIAGNOSTICS _inserted = ROW_COUNT;
    IF _inserted > 0 THEN
      UPDATE public.cash_shifts
      SET expected_balance = round(COALESCE(expected_balance, 0) - _cash, 4),
          updated_at = now()
      WHERE id = _shift_id;
      _drawer_tx_recorded := true;
      _drawer_refund_usd := round(_cash, 4);
    END IF;
  END IF;

  IF _full THEN PERFORM set_config('app.refund_context','allowed',true); END IF;
  UPDATE public.invoices SET subtotal=_new_sub, discount=_new_disc, tax_amount=_new_tax, total=_new_total, profit=_new_profit,
    debt_remaining=_new_debt, debt_paid=CASE WHEN payment_type='debt' THEN GREATEST(round(COALESCE(debt_paid,0)-_paid_red,8),0) ELSE debt_paid END,
    status=CASE WHEN _full THEN 'refunded' WHEN payment_type='debt' AND _new_debt<=0 THEN 'paid' ELSE status END,
    notes=concat_ws(E'\n',NULLIF(notes,''),'Partial refund '||_refund::text||' at '||now()::text),
    updated_at=now()
  WHERE id=_inv.id;

  IF _profit_ratio > 0 OR (_category_profits IS NOT NULL AND _category_profits <> '{}'::jsonb) THEN
    PERFORM public.revert_invoice_partner_profits_atomic(
      _inv.id,
      _profit_ratio,
      CASE WHEN _full THEN NULL ELSE NULLIF(_category_profits, '{}'::jsonb) END
    );
  END IF;
  IF _inv.payment_type='debt' AND NOT _full AND _new_debt<=0 THEN
    PERFORM public.release_pending_partner_profits_for_invoice(_inv.id);
  END IF;

  -- Record profit_records reversal atomically (no physical delete)
  IF _full THEN
    UPDATE public.profit_records
       SET is_reversed = true,
           reversed_at = now()
     WHERE user_id = _owner
       AND invoice_id IN (_inv.invoice_number, _inv.id::text)
       AND is_reversed = false;
  ELSIF _profit_red > 0 THEN
    INSERT INTO public.profit_records (
      user_id, invoice_id, gross_profit, cogs, revenue, currency, recorded_at, is_reversed
    ) VALUES (
      _owner,
      _inv.invoice_number,
      -round(_profit_red, 4),
      -round(_cogs, 4),
      -round(_refund, 4),
      COALESCE(_inv.currency, 'USD'),
      now(),
      false
    );
  END IF;

  IF _inv.payment_type='debt' THEN
    IF _full THEN
      UPDATE public.debts SET status='cancelled', remaining_debt=0, notes=concat_ws(E'\n',NULLIF(notes,''),'ملغى بسبب مرتجع كامل '||now()::text), updated_at=now() WHERE user_id=_owner AND (invoice_id=_inv.invoice_number OR invoice_id=_inv.id::text);
    ELSIF _debt_red > 0 OR _paid_red > 0 THEN
      UPDATE public.debts SET total_debt=GREATEST(round(COALESCE(total_debt,0)-_refund,8),0), total_paid=GREATEST(round(COALESCE(total_paid,0)-_paid_red,8),0),
        remaining_debt=GREATEST(round(COALESCE(remaining_debt,0)-_debt_red,8),0),
        status=CASE WHEN GREATEST(round(COALESCE(remaining_debt,0)-_debt_red,8),0)<=0 THEN 'fully_paid' ELSE status END,
        updated_at=now()
      WHERE user_id=_owner AND (invoice_id=_inv.invoice_number OR invoice_id=_inv.id::text);
    END IF;
  END IF;

  IF _inv.customer_id IS NOT NULL THEN
    UPDATE public.customers c SET total_purchases=s.tp,total_debt=s.td,invoice_count=s.ic,updated_at=now()
    FROM (SELECT COALESCE(SUM(i.total) FILTER (WHERE i.status NOT IN ('refunded','cancelled')),0)::numeric tp,
      COALESCE(SUM(i.debt_remaining) FILTER (WHERE i.status NOT IN ('refunded','cancelled','paid') AND i.payment_type='debt'),0)::numeric td,
      COUNT(*) FILTER (WHERE i.status NOT IN ('refunded','cancelled'))::int ic
      FROM public.invoices i WHERE i.user_id=_owner AND i.customer_id=_inv.customer_id) s
    WHERE c.id=_inv.customer_id AND c.user_id=_owner;
    PERFORM public.recalc_customer_open_debt(_owner, _inv.customer_id);
  END IF;

  INSERT INTO public.activity_log(user_id, actor_id, actor_name, actor_role, action_type, entity_type, entity_id, entity_name, description, metadata)
  SELECT _owner, auth.uid(), COALESCE(p.full_name, 'مستخدم'), ur.role::text,
    'partial_refund', 'invoice', _inv.id::text, _inv.invoice_number,
    'استرداد جزئي للفاتورة ' || _inv.invoice_number,
    jsonb_build_object(
      'operation_id', _operation_id,
      'invoice_number', _inv.invoice_number,
      'refund_amount', _refund,
      'profit_reduction', _profit_red,
      'cash_to_refund', _cash,
      'drawer_tx_recorded', _drawer_tx_recorded,
      'drawer_refund_usd', _drawer_refund_usd,
      'digital_to_refund', _digital_to_refund,
      'settlement_mode', _norm_settlement_mode,
      'debt_reduced', _debt_red,
      'restored_units', _restored
    )
  FROM (SELECT 1) seed
  LEFT JOIN public.profiles p ON p.user_id = auth.uid()
  LEFT JOIN public.user_roles ur ON ur.user_id = auth.uid()
  LIMIT 1;

  RETURN jsonb_build_object(
    'success', true,
    'invoice_id', _inv.id,
    'invoice_number', _inv.invoice_number,
    'refund_amount', _refund,
    'restored_units', _restored,
    'new_total', _new_total,
    'new_profit', _new_profit,
    'new_debt_remaining', _new_debt,
    'cash_to_refund', _cash,
    'debt_reduced', _debt_red,
    'is_fully_refunded', _full,
    'drawer_tx_recorded', _drawer_tx_recorded,
    'drawer_refund_usd', _drawer_refund_usd,
    'digital_to_refund', _digital_to_refund
  );
END;
$function$
;

-- FUNCTION register_boss_push_token | normalized md5 4c6b14b30f790b91b4f885051bfabf28
CREATE OR REPLACE FUNCTION public.register_boss_push_token(p_token text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.uid() is null or not public.is_boss(auth.uid()) then
    raise exception 'Access denied: boss role required';
  end if;
  if p_token is null or length(p_token) < 20 then raise exception 'invalid token'; end if;
  insert into public.boss_push_tokens(token, user_id, updated_at)
  values (p_token, auth.uid(), now())
  on conflict (token) do update set user_id = excluded.user_id, updated_at = now();
end $function$
;

-- FUNCTION register_push_token | normalized md5 2098bece85ae109e1f35319b9699f02d
CREATE OR REPLACE FUNCTION public.register_push_token(p_token text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if p_token is null or length(p_token) < 20 then raise exception 'invalid token'; end if;
  insert into public.user_push_tokens(token, user_id, updated_at)
  values (p_token, auth.uid(), now())
  on conflict (token) do update set user_id = excluded.user_id, updated_at = now();
end $function$
;

-- FUNCTION register_serials_atomic | normalized md5 d55a01123c1e2ddf314211cd7045540e
CREATE OR REPLACE FUNCTION public.register_serials_atomic(_product_id uuid, _serials text[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _o uuid := public.get_owner_id(auth.uid()); _cost numeric; _n int;
BEGIN
  IF auth.uid() IS NULL OR _o IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT cost_price INTO _cost FROM public.products WHERE id=_product_id AND user_id=_o;
  IF NOT FOUND THEN RAISE EXCEPTION 'المنتج غير موجود'; END IF;
  _n := public._register_serials(_o,_product_id,_serials,_cost,NULL,NULL);
  UPDATE public.products SET track_serials=true WHERE id=_product_id AND NOT track_serials;
  RETURN _n;
END $function$
;

-- FUNCTION release_pending_partner_profits_for_invoice | normalized md5 985843038b6442ed5d7080aa4f9e1d89
CREATE OR REPLACE FUNCTION public.release_pending_partner_profits_for_invoice(_invoice_id uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _inv public.invoices%ROWTYPE;
  _p record;
  _sum numeric;
  _tot numeric := 0;
  _keep jsonb;
  _hist jsonb;
  _it jsonb;
BEGIN
  PERFORM set_config('app.partner_source', 'release_pending_partner_profits_for_invoice', true);
  SELECT * INTO _inv FROM public.invoices WHERE id = _invoice_id;
  IF NOT FOUND THEN RETURN 0; END IF;

  FOR _p IN
    SELECT * FROM public.partners
     WHERE user_id = _inv.user_id
       AND (
         pending_profit_details @> jsonb_build_array(jsonb_build_object('invoiceId', _inv.invoice_number))
         OR profit_history @> jsonb_build_array(jsonb_build_object('invoiceId', _inv.invoice_number, 'isDebt', true))
       )
     FOR UPDATE
  LOOP
    _sum := 0;
    _keep := '[]'::jsonb;
    FOR _it IN SELECT * FROM jsonb_array_elements(COALESCE(_p.pending_profit_details, '[]'::jsonb)) LOOP
      IF _it->>'invoiceId' = _inv.invoice_number THEN
        _sum := _sum + COALESCE((_it->>'amount')::numeric, 0);
      ELSE
        _keep := _keep || _it;
      END IF;
    END LOOP;

    _hist := '[]'::jsonb;
    FOR _it IN SELECT * FROM jsonb_array_elements(COALESCE(_p.profit_history, '[]'::jsonb)) LOOP
      IF (_it->>'invoiceId') = _inv.invoice_number
         AND COALESCE((_it->>'isDebt')::boolean, false) = true
         AND COALESCE((_it->>'isReversal')::boolean, false) = false THEN
        _hist := _hist || jsonb_set(_it, '{isDebt}', 'false'::jsonb);
      ELSIF (_it->>'invoiceId') = _inv.invoice_number
            AND (COALESCE((_it->>'isRelease')::boolean, false) OR COALESCE(_it->>'id', '') LIKE '%-rel')
            AND NOT COALESCE((_it->>'superseded')::boolean, false) THEN
        _hist := _hist || jsonb_set(_it, '{superseded}', 'true'::jsonb);
      ELSE
        _hist := _hist || _it;
      END IF;
    END LOOP;

    UPDATE public.partners
       SET pending_profit = round((SELECT COALESCE(SUM((x->>'amount')::numeric), 0) FROM jsonb_array_elements(_keep) x), 4),
           confirmed_profit = round(COALESCE(confirmed_profit, 0) + _sum, 4),
           current_balance = round(COALESCE(current_balance, 0) + _sum, 4),
           total_profit_earned = round(COALESCE(total_profit_earned, 0) + _sum, 4),
           pending_profit_details = _keep,
           profit_history = _hist,
           updated_at = now()
     WHERE id = _p.id;

    _tot := _tot + _sum;
  END LOOP;

  RETURN _tot;
END $function$
;

-- FUNCTION release_serials_atomic | normalized md5 748fbdde7116d97c74cc03ecf67fe976
CREATE OR REPLACE FUNCTION public.release_serials_atomic(_invoice_number text, _serials text[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _o uuid := public.get_owner_id(auth.uid()); _n int := 0; _r record;
BEGIN
  IF auth.uid() IS NULL OR _o IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  FOR _r IN SELECT id FROM public.product_serials WHERE user_id=_o AND sold_invoice_number=_invoice_number AND status='sold' AND lower(serial)=ANY(SELECT lower(x) FROM unnest(_serials) x) FOR UPDATE LOOP
    UPDATE public.product_serials SET status='in_stock', sold_invoice_id=NULL, sold_invoice_number=NULL, sold_at=NULL, customer_name=NULL, warranty_until=NULL, updated_at=now() WHERE id=_r.id;
    INSERT INTO public.product_serial_events(user_id,serial_id,event,ref,actor) VALUES (_o,_r.id,'customer_return',_invoice_number,auth.uid());
    _n := _n + 1;
  END LOOP;
  IF _n <> cardinality(_serials) THEN RAISE EXCEPTION 'بعض الأرقام غير مرتبطة بهذه الفاتورة'; END IF;
  RETURN _n;
END $function$
;

-- FUNCTION request_device_reset_secure | normalized md5 422d80732c664e7855557cb08f5c8079
CREATE OR REPLACE FUNCTION public.request_device_reset_secure(_license_key text, _user_email text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _clean_key text := upper(replace(trim(_license_key), ' ', ''));
  _clean_email text := lower(trim(_user_email));
  _lic record;
  _since timestamptz;
  _available_at timestamptz;
  _left interval;
BEGIN
  IF _clean_key IS NULL OR _clean_key = '' OR _clean_email IS NULL OR _clean_email = '' THEN
    RETURN jsonb_build_object(
      'success', false,
      'message', 'يرجى تزويد مفتاح الترخيص والبريد الإلكتروني بشكل صحيح.'
    );
  END IF;

  SELECT l.id, l.user_id, l.activation_code_id, l.is_revoked, l.device_id,
         l.allow_multi_device, l.device_bound_at, l.last_device_reset_at,
         l.activated_at, l.created_at
    INTO _lic
    FROM public.app_licenses l
    LEFT JOIN auth.users u ON u.id = l.user_id
    LEFT JOIN public.activation_codes ac ON ac.id = l.activation_code_id
   WHERE (
     upper(replace(COALESCE(l.license_key, ''), ' ', '')) = _clean_key
     OR (ac.code IS NOT NULL AND upper(replace(ac.code, ' ', '')) = _clean_key)
   )
   AND (
     (u.email IS NOT NULL AND lower(trim(u.email)) = _clean_email)
     OR (ac.assigned_email IS NOT NULL AND lower(trim(ac.assigned_email)) = _clean_email)
   )
   ORDER BY l.created_at DESC
   LIMIT 1
   FOR UPDATE OF l;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'message', 'بيانات الترخيص أو البريد الإلكتروني غير صحيحة.'
    );
  END IF;

  IF COALESCE(_lic.is_revoked, false) THEN
    RETURN jsonb_build_object(
      'success', false,
      'message', 'تم إلغاء ترخيص هذا الحساب، يرجى التواصل مع الإدارة.'
    );
  END IF;

  IF _lic.device_id IS NULL OR COALESCE(_lic.allow_multi_device, false) THEN
    RETURN jsonb_build_object(
      'success', true,
      'already_free', true,
      'message', 'الحساب غير مرتبط بجهاز حالياً. يمكنك تسجيل الدخول مباشرة.'
    );
  END IF;

  _since := COALESCE(_lic.device_bound_at, _lic.last_device_reset_at, _lic.activated_at, _lic.created_at, now());
  _available_at := _since + interval '1 day';

  IF now() < _available_at THEN
    _left := _available_at - now();
    RETURN jsonb_build_object(
      'success', false,
      'cooldown', true,
      'available_at', _available_at,
      'message', format(
        'لا يمكن نقل الحساب ذاتياً قبل مرور يوم على ربط الجهاز الحالي (متبقٍ %s يوم و%s ساعة). لنقل الحساب الآن تواصل مع الدعم عبر بوت تيليجرام.',
        extract(day FROM _left)::int,
        extract(hour FROM _left)::int
      )
    );
  END IF;

  UPDATE public.app_licenses
     SET device_id = NULL,
         bound_device_id = NULL,
         last_reset_at = now(),
         last_device_reset_at = now(),
         device_reset_count = COALESCE(device_reset_count, 0) + 1,
         updated_at = now()
   WHERE id = _lic.id;

  IF _lic.activation_code_id IS NOT NULL THEN
    UPDATE public.activation_codes
       SET locked_device_id = NULL
     WHERE id = _lic.activation_code_id;
  END IF;

  PERFORM public.revoke_user_sessions(_lic.user_id);

  RETURN jsonb_build_object(
    'success', true,
    'message', 'تم فك ربط الجهاز بنجاح. يمكنك الآن تسجيل الدخول من جهازك الجديد.'
  );
END;
$function$
;

-- FUNCTION request_device_reset_secure | normalized md5 8be5cf7f3e6ceac1894f3939ffcb6fca
CREATE OR REPLACE FUNCTION public.request_device_reset_secure(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _lic public.app_licenses%ROWTYPE;
  _since timestamptz;
  _available_at timestamptz;
  _left interval;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id AND NOT public.is_boss(auth.uid()) THEN
    RETURN jsonb_build_object('success', false, 'error', 'غير مصرح');
  END IF;

  SELECT * INTO _lic FROM public.app_licenses WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'لا يوجد ترخيص مرتبط بهذا الحساب');
  END IF;

  IF _lic.device_id IS NULL OR COALESCE(_lic.allow_multi_device, false) THEN
    IF auth.uid() IS NULL THEN PERFORM public.revoke_user_sessions(p_user_id); END IF;
    RETURN jsonb_build_object('success', true, 'already_free', true, 'reset_at', now(), 'signed_out', auth.uid() IS NULL);
  END IF;

  _since := COALESCE(_lic.device_bound_at, _lic.last_device_reset_at, _lic.activated_at, _lic.created_at, now());
  _available_at := _since + interval '1 day';

  IF now() < _available_at THEN
    _left := _available_at - now();
    RETURN jsonb_build_object(
      'success', false,
      'available_at', _available_at,
      'error', format(
        'لا يمكن نقل الحساب ذاتياً قبل مرور يوم على ربط الجهاز الحالي (متبقٍ %s يوم و%s ساعة). لنقل الحساب الآن تواصل مع الدعم عبر بوت تيليجرام.',
        extract(day FROM _left)::int,
        extract(hour FROM _left)::int
      )
    );
  END IF;

  UPDATE public.app_licenses
     SET device_id = NULL,
         last_device_reset_at = now(),
         device_reset_count = COALESCE(device_reset_count, 0) + 1,
         updated_at = now()
   WHERE id = _lic.id;

  IF auth.uid() IS NULL THEN PERFORM public.revoke_user_sessions(p_user_id); END IF;
  RETURN jsonb_build_object('success', true, 'reset_at', now(), 'signed_out', auth.uid() IS NULL);
END;
$function$
;

-- FUNCTION reset_device_for_user | normalized md5 42eaee1493ddbd28cfe759f09ed96224
CREATE OR REPLACE FUNCTION public.reset_device_for_user(p_target_email text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
DECLARE v_caller_role TEXT; v_target_user_id UUID;
BEGIN
  SELECT role INTO v_caller_role FROM public.user_roles WHERE user_id = auth.uid() LIMIT 1;
  IF v_caller_role != 'boss' THEN RAISE EXCEPTION 'غير مصرح: هذه العملية مخصصة لحساب Boss فقط'; END IF;
  SELECT id INTO v_target_user_id FROM auth.users WHERE email = p_target_email LIMIT 1;
  IF v_target_user_id IS NULL THEN RAISE EXCEPTION 'المستخدم غير موجود'; END IF;
  UPDATE public.app_licenses SET device_id = NULL, updated_at = now() WHERE user_id = v_target_user_id;
  RETURN TRUE;
END;
$function$
;

-- FUNCTION reset_user_device | normalized md5 e9c70291bae3488f8e61686e50b3048f
CREATE OR REPLACE FUNCTION public.reset_user_device(_target_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Verify caller is boss
  IF NOT public.is_boss(auth.uid()) THEN
    RAISE EXCEPTION 'Only boss can reset device';
  END IF;
  
  -- Reset device_id for the target user's license
  UPDATE public.app_licenses
  SET device_id = NULL
  WHERE user_id = _target_user_id;
  
  RETURN TRUE;
END;
$function$
;

-- FUNCTION reset_user_store_data | normalized md5 aafa42cf505cd6c2d81ed039c49a3bc9
CREATE OR REPLACE FUNCTION public.reset_user_store_data()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_owner_id uuid;
  v_is_boss boolean;
  v_n integer;
  v_counts jsonb := '{}'::jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'يجب تسجيل الدخول أولاً' USING ERRCODE = '42501';
  END IF;

  v_is_boss := public.is_boss(v_uid);
  v_owner_id := public.get_owner_id(v_uid);
  IF NOT v_is_boss AND (v_owner_id IS NULL OR v_owner_id <> v_uid) THEN
    RAISE EXCEPTION 'صلاحية غير كافية: العملية تتطلب مالك المتجر أو Boss' USING ERRCODE = '42501';
  END IF;
  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION 'لم يتم العثور على حساب المتجر';
  END IF;

  -- Transaction-local contexts read by the guards above. They end with the transaction.
  PERFORM set_config('app.invoice_delete_context', 'allowed', true);
  PERFORM set_config('app.purge_context', 'owner_purge', true);

  -- 1. Serials and stock history (children first)
  DELETE FROM public.product_serial_events WHERE user_id = v_owner_id;
  DELETE FROM public.product_serials WHERE user_id = v_owner_id;
  DELETE FROM public.stock_count_items WHERE count_id IN (SELECT id FROM public.stock_counts WHERE user_id = v_owner_id);
  DELETE FROM public.stock_counts WHERE user_id = v_owner_id;
  DELETE FROM public.stock_damages WHERE user_id = v_owner_id;
  DELETE FROM public.stock_transfer_items WHERE transfer_id IN (SELECT id FROM public.stock_transfers WHERE user_id = v_owner_id);
  DELETE FROM public.stock_transfers WHERE user_id = v_owner_id;
  DELETE FROM public.stock_movements WHERE user_id = v_owner_id;

  -- 2. Sales and their accounting records
  DELETE FROM public.invoice_accounting_events WHERE user_id = v_owner_id;
  DELETE FROM public.sales_refund_allocations WHERE user_id = v_owner_id;
  DELETE FROM public.sales_settlement_replays WHERE user_id = v_owner_id;
  DELETE FROM public.accounting_rpc_receipts WHERE user_id = v_owner_id;
  DELETE FROM public.invoice_items WHERE invoice_id IN (SELECT id FROM public.invoices WHERE user_id = v_owner_id);
  DELETE FROM public.profit_records WHERE user_id = v_owner_id;
  DELETE FROM public.invoices WHERE user_id = v_owner_id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('invoices', v_n);

  -- 3. Purchases and suppliers
  DELETE FROM public.purchase_return_items WHERE return_id IN (SELECT id FROM public.purchase_returns WHERE user_id = v_owner_id);
  DELETE FROM public.purchase_returns WHERE user_id = v_owner_id;
  DELETE FROM public.purchase_invoice_items WHERE invoice_id IN (SELECT id FROM public.purchase_invoices WHERE user_id = v_owner_id);
  DELETE FROM public.purchase_invoices WHERE user_id = v_owner_id;
  DELETE FROM public.purchase_audit_logs WHERE user_id = v_owner_id;
  DELETE FROM public.supplier_ledger_entries WHERE user_id = v_owner_id;
  DELETE FROM public.suppliers WHERE user_id = v_owner_id;

  -- 4. Debts and customers
  DELETE FROM public.debt_payments WHERE user_id = v_owner_id;
  DELETE FROM public.debt_writeoffs WHERE user_id = v_owner_id;
  DELETE FROM public.debts WHERE user_id = v_owner_id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('debts', v_n);
  DELETE FROM public.customer_credit_ledger WHERE user_id = v_owner_id;
  DELETE FROM public.customers WHERE user_id = v_owner_id;

  -- 5. Drawer, expenses, partners, periods
  DELETE FROM public.shift_transactions WHERE user_id = v_owner_id
     OR shift_id IN (SELECT id FROM public.cash_shifts WHERE user_id = v_owner_id);
  DELETE FROM public.cash_shifts WHERE user_id = v_owner_id;
  DELETE FROM public.expenses WHERE user_id = v_owner_id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('expenses', v_n);
  DELETE FROM public.recurring_expenses WHERE user_id = v_owner_id;
  DELETE FROM public.maintenance_services WHERE user_id = v_owner_id;
  DELETE FROM public.partner_ledger_entries WHERE user_id = v_owner_id;
  DELETE FROM public.partners WHERE user_id = v_owner_id;
  DELETE FROM public.inventory_valuation_adjustments WHERE user_id = v_owner_id;
  DELETE FROM public.accounting_period_closures WHERE user_id = v_owner_id;

  -- 6. Library
  DELETE FROM public.book_loans WHERE user_id = v_owner_id;
  DELETE FROM public.library_members WHERE user_id = v_owner_id;

  -- 7. KEPT, but their stock is reset: products (prices, names, settings) and warehouse rows
  UPDATE public.warehouse_stock SET quantity = 0
   WHERE warehouse_id IN (SELECT id FROM public.warehouses WHERE user_id = v_owner_id);
  UPDATE public.products SET quantity = 0 WHERE user_id = v_owner_id;

  INSERT INTO public.activity_log(user_id, actor_id, action_type, entity_type, description, metadata)
  VALUES (v_owner_id, v_uid, 'store_reset', 'store', 'تصفير بيانات المتجر (مع الإبقاء على المنتجات)',
          jsonb_build_object('deleted', v_counts));

  RETURN jsonb_build_object(
    'success', true,
    'message', 'تم تصفير بيانات المتجر بنجاح',
    'deleted', v_counts,
    'kept_products', (SELECT count(*) FROM public.products WHERE user_id = v_owner_id)
  );
END;
$function$
;

-- FUNCTION resolve_shift_variance_atomic | normalized md5 56b0d35b561d0edec192c11d149c06b3
CREATE OR REPLACE FUNCTION public.resolve_shift_variance_atomic(_shift_id uuid, _decision text, _note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _caller uuid := auth.uid(); _owner uuid := public.get_owner_id(_caller); _shift record; _d jsonb;
BEGIN
  IF _caller IS NULL OR _owner IS NULL THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  IF NOT public.is_store_owner(_caller) THEN RAISE EXCEPTION 'قرار الفروقات لمالك المتجر فقط' USING ERRCODE='42501'; END IF;
  IF _decision NOT IN ('accept','dismiss') THEN RAISE EXCEPTION 'قرار غير صالح'; END IF;
  IF _decision = 'dismiss' AND COALESCE(trim(_note),'') = '' THEN RAISE EXCEPTION 'ملاحظة الإغلاق إلزامية'; END IF;
  SELECT * INTO _shift FROM public.cash_shifts WHERE id=_shift_id AND user_id=_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'الوردية غير موجودة'; END IF;
  IF _shift.variance_decision <> 'deferred' THEN
    RETURN jsonb_build_object('success', true, 'already_resolved', true, 'decision', _shift.variance_decision);
  END IF;
  IF _decision = 'accept' THEN
    PERFORM public.assert_period_open(_owner, CURRENT_DATE, 'تسجيل فرق وردية');
    FOR _d IN SELECT * FROM jsonb_array_elements(COALESCE(_shift.currency_counts,'[]'::jsonb)) LOOP
      IF (_d->>'variance')::numeric <> 0 THEN
        INSERT INTO public.shift_transactions(shift_id,user_id,type,amount,currency,currency_amount,exchange_rate,notes,created_at)
        VALUES (_shift_id,_owner, CASE WHEN (_d->>'variance')::numeric > 0 THEN 'surplus' ELSE 'shortage' END,
                abs((_d->>'variance_usd')::numeric), _d->>'code', abs((_d->>'variance')::numeric), (_d->>'rate')::numeric,
                CASE WHEN (_d->>'variance')::numeric > 0 THEN 'فائض صندوق (قرار المالك): ' ELSE 'عجز صندوق (قرار المالك): ' END || COALESCE(_note,''), now());
      END IF;
    END LOOP;
  END IF;
  UPDATE public.cash_shifts SET variance_decision = CASE WHEN _decision='accept' THEN 'accepted' ELSE 'dismissed' END,
         reconciliation_status='matched', variance_resolved_by=_caller, variance_resolved_at=now(), variance_note=_note, updated_at=now()
   WHERE id=_shift_id;
  RETURN jsonb_build_object('success', true, 'decision', _decision);
END $function$
;

-- FUNCTION reverse_expense_atomic | normalized md5 df426ef92f1dcf3e3295a8a06e40e1a6
CREATE OR REPLACE FUNCTION public.reverse_expense_atomic(p_expense_id uuid, p_reason text DEFAULT 'تراجع بواسطة المستخدم'::text, p_shift_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_res jsonb;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'يجب تسجيل الدخول أولاً', 'cash_refunded', false);
  END IF;

  v_res := public.delete_expense_atomic(p_expense_id, p_reason, p_shift_id);

  IF COALESCE((v_res->>'success')::boolean, false) = false THEN
    RETURN jsonb_build_object(
      'success', false,
      'message', COALESCE(v_res->>'error', 'تعذر التراجع عن المصروف'),
      'cash_refunded', false
    );
  END IF;

  IF COALESCE((v_res->>'already_reversed')::boolean, false) = true THEN
    RETURN jsonb_build_object(
      'success', true,
      'already_reversed', true,
      'cash_refunded', false,
      'message', 'تم التراجع عن هذا المصروف مسبقاً'
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'amount', (v_res->>'amount')::numeric,
    'expense_type', v_res->>'expense_type',
    'cash_refunded', COALESCE((v_res->>'cash_refunded')::boolean, false),
    'message', 'تم التراجع عن المصروف بنجاح'
  );
END;
$function$
;

-- FUNCTION revert_invoice_partner_profits_atomic | normalized md5 27f0179d17597ddea5daf5fd557589eb
CREATE OR REPLACE FUNCTION public.revert_invoice_partner_profits_atomic(_invoice_id uuid, _revert_ratio numeric DEFAULT 1.0, _category_profits jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _inv public.invoices%ROWTYPE;
  _owner uuid;
  _partner record;
  _ratio numeric := LEAST(GREATEST(COALESCE(_revert_ratio, 1.0), 0.0), 1.0);
  _full boolean;
  _use_cat_map boolean;
  _updated_details jsonb;
  _revert_record jsonb;
  _rev_entries jsonb;
  _pending_reverted numeric;
  _confirmed_reverted numeric;
  _orig_share numeric;
  _pending_now numeric;
  _already_reverted numeric;
  _confirmed_net numeric;
  _avail_total numeric;
  _target_rev numeric;
  _pending_scale numeric;
  _item jsonb;
  _amt numeric;
  _total_reverted numeric := 0;
  _rem_by_cat jsonb;
  _cat_entry record;
  _cat_share jsonb;
  _pct numeric;
  _cat_amt numeric;
  _orig_cat_profit numeric;
  _cat_rev_list jsonb;
  _rev_item jsonb;
  _scale numeric;
  _idx int;
BEGIN
  PERFORM set_config('app.partner_source', 'revert_invoice_partner_profits_atomic', true);
  PERFORM pg_advisory_xact_lock(hashtext('partner_dist:' || _invoice_id::text));

  SELECT * INTO _inv FROM public.invoices WHERE id = _invoice_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invoice not found');
  END IF;

  _owner := _inv.user_id;
  _full := _ratio >= 0.9999;
  _use_cat_map := (_category_profits IS NOT NULL AND jsonb_typeof(_category_profits) = 'object' AND _category_profits <> '{}'::jsonb);

  IF _use_cat_map THEN
    _rem_by_cat := _category_profits;

    FOR _partner IN
      SELECT * FROM public.partners
      WHERE user_id = _owner
        AND COALESCE(access_all, false) = false
        AND (
          profit_history @> jsonb_build_array(jsonb_build_object('invoiceId', _inv.invoice_number))
          OR pending_profit_details @> jsonb_build_array(jsonb_build_object('invoiceId', _inv.invoice_number))
        )
      ORDER BY id
      FOR UPDATE
    LOOP
      _target_rev := 0;
      _cat_rev_list := '[]'::jsonb;

      IF _partner.category_shares IS NOT NULL AND jsonb_typeof(_partner.category_shares) = 'array' THEN
        FOR _cat_entry IN
          SELECT key AS cat_name, COALESCE(NULLIF(value, '')::numeric, 0) AS cat_profit
          FROM jsonb_each_text(_category_profits)
        LOOP
          IF _cat_entry.cat_profit = 0 THEN
            CONTINUE;
          END IF;

          SELECT cs INTO _cat_share
          FROM jsonb_array_elements(_partner.category_shares) cs
          WHERE COALESCE((cs->>'enabled')::boolean, false) = true
            AND trim(COALESCE(cs->>'categoryName', '')) = trim(_cat_entry.cat_name)
          LIMIT 1;

          IF _cat_share IS NOT NULL AND COALESCE((_cat_share->>'percentage')::numeric, 0) > 0 THEN
            _pct := (_cat_share->>'percentage')::numeric;
            _cat_amt := round((_cat_entry.cat_profit * _pct / 100.0), 4);
            IF _cat_amt <> 0 THEN
              _target_rev := _target_rev + _cat_amt;
              _rem_by_cat := jsonb_set(
                _rem_by_cat,
                ARRAY[_cat_entry.cat_name],
                to_jsonb(round(COALESCE((_rem_by_cat->>_cat_entry.cat_name)::numeric, 0) - _cat_amt, 8)),
                true
              );
              _cat_rev_list := _cat_rev_list || jsonb_build_object('category', _cat_entry.cat_name, 'amount', _cat_amt);
            END IF;
          END IF;
        END LOOP;
      END IF;

      IF _target_rev = 0 THEN
        CONTINUE;
      END IF;

      SELECT COALESCE(SUM(COALESCE((x->>'amount')::numeric, 0)), 0) INTO _pending_now
        FROM jsonb_array_elements(COALESCE(_partner.pending_profit_details, '[]'::jsonb)) x
       WHERE x->>'invoiceId' = _inv.invoice_number;

      SELECT COALESCE(SUM(COALESCE((x->>'amount')::numeric, 0)), 0) INTO _orig_share
        FROM jsonb_array_elements(COALESCE(_partner.profit_history, '[]'::jsonb)) x
       WHERE x->>'invoiceId' = _inv.invoice_number
         AND COALESCE((x->>'isReversal')::boolean, false) = false
         AND COALESCE((x->>'isRelease')::boolean, false) = false
         AND COALESCE(x->>'id', '') NOT LIKE '%-rel'
         AND COALESCE(x->>'category', '') <> 'تحرير دفعة دين';

      SELECT COALESCE(SUM(-COALESCE((x->>'amount')::numeric, 0)), 0) INTO _already_reverted
        FROM jsonb_array_elements(COALESCE(_partner.profit_history, '[]'::jsonb)) x
       WHERE x->>'invoiceId' = _inv.invoice_number
         AND COALESCE((x->>'isReversal')::boolean, false) = true;

      _confirmed_net := round(_orig_share - _pending_now - _already_reverted, 8);
      _confirmed_net := CASE WHEN _orig_share >= 0 THEN GREATEST(_confirmed_net, 0) ELSE LEAST(_confirmed_net, 0) END;
      _avail_total := round(_pending_now + _confirmed_net, 8);

      IF _orig_share >= 0 AND _target_rev > 0 THEN
        _target_rev := LEAST(_target_rev, GREATEST(_avail_total, 0));
      ELSIF _orig_share < 0 AND _target_rev < 0 THEN
        _target_rev := GREATEST(_target_rev, LEAST(_avail_total, 0));
      END IF;

      IF _target_rev = 0 THEN
        CONTINUE;
      END IF;

      _pending_reverted := 0;
      IF _pending_now <> 0 AND ((_target_rev > 0 AND _pending_now > 0) OR (_target_rev < 0 AND _pending_now < 0)) THEN
        IF abs(_target_rev) >= abs(_pending_now) THEN
          _pending_reverted := _pending_now;
        ELSE
          _pending_reverted := round(_target_rev, 8);
        END IF;
      END IF;

      _confirmed_reverted := round(_target_rev - _pending_reverted, 8);
      IF _orig_share >= 0 AND _confirmed_reverted > 0 THEN
        _confirmed_reverted := LEAST(_confirmed_reverted, GREATEST(_confirmed_net, 0));
      ELSIF _orig_share < 0 AND _confirmed_reverted < 0 THEN
        _confirmed_reverted := GREATEST(_confirmed_reverted, LEAST(_confirmed_net, 0));
      END IF;

      _updated_details := '[]'::jsonb;
      _pending_scale := CASE WHEN _pending_now <> 0 THEN 1.0 - (_pending_reverted / _pending_now) ELSE 1.0 END;
      FOR _item IN SELECT * FROM jsonb_array_elements(COALESCE(_partner.pending_profit_details, '[]'::jsonb)) LOOP
        IF _item->>'invoiceId' = _inv.invoice_number THEN
          _amt := COALESCE((_item->>'amount')::numeric, 0);
          IF abs(round(_amt * _pending_scale, 8)) > 0.00005 THEN
            _updated_details := _updated_details || jsonb_set(_item, '{amount}', to_jsonb(round(_amt * _pending_scale, 8)));
          END IF;
        ELSE
          _updated_details := _updated_details || _item;
        END IF;
      END LOOP;

      IF _pending_reverted <> 0 OR _confirmed_reverted <> 0 THEN
        _rev_entries := '[]'::jsonb;
        _scale := CASE WHEN _target_rev <> 0 THEN (_pending_reverted + _confirmed_reverted) / _target_rev ELSE 1.0 END;
        _idx := 0;
        FOR _rev_item IN SELECT * FROM jsonb_array_elements(_cat_rev_list) LOOP
          _idx := _idx + 1;
          _cat_amt := round((_rev_item->>'amount')::numeric * _scale, 8);
          IF _cat_amt <> 0 THEN
            _rev_entries := _rev_entries || jsonb_build_array(jsonb_build_object(
              'id', extract(epoch from now())::text || _partner.id::text || '-rev-' || _idx::text,
              'invoiceId', _inv.invoice_number,
              'amount', -_cat_amt,
              'pendingReverted', round(_pending_reverted * (_cat_amt / NULLIF(_pending_reverted + _confirmed_reverted, 0)), 8),
              'confirmedReverted', round(_confirmed_reverted * (_cat_amt / NULLIF(_pending_reverted + _confirmed_reverted, 0)), 8),
              'category', _rev_item->>'category',
              'isReversal', true,
              'createdAt', now()
            ));
          END IF;
        END LOOP;

        UPDATE public.partners SET
          pending_profit = round((SELECT COALESCE(SUM((x->>'amount')::numeric), 0) FROM jsonb_array_elements(_updated_details) x), 4),
          confirmed_profit = round(COALESCE(confirmed_profit, 0) - _confirmed_reverted, 4),
          current_balance = round(COALESCE(current_balance, 0) - _confirmed_reverted, 4),
          total_profit_earned = round(COALESCE(total_profit_earned, 0) - _confirmed_reverted, 4),
          pending_profit_details = _updated_details,
          profit_history = COALESCE(profit_history, '[]'::jsonb) || _rev_entries,
          updated_at = now()
        WHERE id = _partner.id;

        _total_reverted := _total_reverted + _pending_reverted + _confirmed_reverted;
      END IF;
    END LOOP;

    FOR _partner IN
      SELECT * FROM public.partners
      WHERE user_id = _owner
        AND COALESCE(access_all, false) = true
        AND COALESCE(share_percentage, 0) > 0
        AND (
          profit_history @> jsonb_build_array(jsonb_build_object('invoiceId', _inv.invoice_number))
          OR pending_profit_details @> jsonb_build_array(jsonb_build_object('invoiceId', _inv.invoice_number))
        )
      ORDER BY id
      FOR UPDATE
    LOOP
      _target_rev := 0;
      _cat_rev_list := '[]'::jsonb;

      FOR _cat_entry IN
        SELECT key AS cat_name, COALESCE(NULLIF(value, '')::numeric, 0) AS rem_profit
        FROM jsonb_each_text(_rem_by_cat)
      LOOP
        _orig_cat_profit := COALESCE((_category_profits->>_cat_entry.cat_name)::numeric, 0);
        IF (_orig_cat_profit > 0 AND _cat_entry.rem_profit > 0)
           OR (_orig_cat_profit < 0 AND _cat_entry.rem_profit < 0) THEN
          _cat_amt := round((_cat_entry.rem_profit * _partner.share_percentage / 100.0), 4);
          IF _cat_amt <> 0 THEN
            _target_rev := _target_rev + _cat_amt;
            _cat_rev_list := _cat_rev_list || jsonb_build_object('category', _cat_entry.cat_name, 'amount', _cat_amt);
          END IF;
        END IF;
      END LOOP;

      IF _target_rev = 0 THEN
        CONTINUE;
      END IF;

      SELECT COALESCE(SUM(COALESCE((x->>'amount')::numeric, 0)), 0) INTO _pending_now
        FROM jsonb_array_elements(COALESCE(_partner.pending_profit_details, '[]'::jsonb)) x
       WHERE x->>'invoiceId' = _inv.invoice_number;

      SELECT COALESCE(SUM(COALESCE((x->>'amount')::numeric, 0)), 0) INTO _orig_share
        FROM jsonb_array_elements(COALESCE(_partner.profit_history, '[]'::jsonb)) x
       WHERE x->>'invoiceId' = _inv.invoice_number
         AND COALESCE((x->>'isReversal')::boolean, false) = false
         AND COALESCE((x->>'isRelease')::boolean, false) = false
         AND COALESCE(x->>'id', '') NOT LIKE '%-rel'
         AND COALESCE(x->>'category', '') <> 'تحرير دفعة دين';

      SELECT COALESCE(SUM(-COALESCE((x->>'amount')::numeric, 0)), 0) INTO _already_reverted
        FROM jsonb_array_elements(COALESCE(_partner.profit_history, '[]'::jsonb)) x
       WHERE x->>'invoiceId' = _inv.invoice_number
         AND COALESCE((x->>'isReversal')::boolean, false) = true;

      _confirmed_net := round(_orig_share - _pending_now - _already_reverted, 8);
      _confirmed_net := CASE WHEN _orig_share >= 0 THEN GREATEST(_confirmed_net, 0) ELSE LEAST(_confirmed_net, 0) END;
      _avail_total := round(_pending_now + _confirmed_net, 8);

      IF _orig_share >= 0 AND _target_rev > 0 THEN
        _target_rev := LEAST(_target_rev, GREATEST(_avail_total, 0));
      ELSIF _orig_share < 0 AND _target_rev < 0 THEN
        _target_rev := GREATEST(_target_rev, LEAST(_avail_total, 0));
      END IF;

      IF _target_rev = 0 THEN
        CONTINUE;
      END IF;

      _pending_reverted := 0;
      IF _pending_now <> 0 AND ((_target_rev > 0 AND _pending_now > 0) OR (_target_rev < 0 AND _pending_now < 0)) THEN
        IF abs(_target_rev) >= abs(_pending_now) THEN
          _pending_reverted := _pending_now;
        ELSE
          _pending_reverted := round(_target_rev, 8);
        END IF;
      END IF;

      _confirmed_reverted := round(_target_rev - _pending_reverted, 8);
      IF _orig_share >= 0 AND _confirmed_reverted > 0 THEN
        _confirmed_reverted := LEAST(_confirmed_reverted, GREATEST(_confirmed_net, 0));
      ELSIF _orig_share < 0 AND _confirmed_reverted < 0 THEN
        _confirmed_reverted := GREATEST(_confirmed_reverted, LEAST(_confirmed_net, 0));
      END IF;

      _updated_details := '[]'::jsonb;
      _pending_scale := CASE WHEN _pending_now <> 0 THEN 1.0 - (_pending_reverted / _pending_now) ELSE 1.0 END;
      FOR _item IN SELECT * FROM jsonb_array_elements(COALESCE(_partner.pending_profit_details, '[]'::jsonb)) LOOP
        IF _item->>'invoiceId' = _inv.invoice_number THEN
          _amt := COALESCE((_item->>'amount')::numeric, 0);
          IF abs(round(_amt * _pending_scale, 8)) > 0.00005 THEN
            _updated_details := _updated_details || jsonb_set(_item, '{amount}', to_jsonb(round(_amt * _pending_scale, 8)));
          END IF;
        ELSE
          _updated_details := _updated_details || _item;
        END IF;
      END LOOP;

      IF _pending_reverted <> 0 OR _confirmed_reverted <> 0 THEN
        _rev_entries := '[]'::jsonb;
        _scale := CASE WHEN _target_rev <> 0 THEN (_pending_reverted + _confirmed_reverted) / _target_rev ELSE 1.0 END;
        _idx := 0;
        FOR _rev_item IN SELECT * FROM jsonb_array_elements(_cat_rev_list) LOOP
          _idx := _idx + 1;
          _cat_amt := round((_rev_item->>'amount')::numeric * _scale, 8);
          IF _cat_amt <> 0 THEN
            _rev_entries := _rev_entries || jsonb_build_array(jsonb_build_object(
              'id', extract(epoch from now())::text || _partner.id::text || '-rev-' || _idx::text,
              'invoiceId', _inv.invoice_number,
              'amount', -_cat_amt,
              'pendingReverted', round(_pending_reverted * (_cat_amt / NULLIF(_pending_reverted + _confirmed_reverted, 0)), 8),
              'confirmedReverted', round(_confirmed_reverted * (_cat_amt / NULLIF(_pending_reverted + _confirmed_reverted, 0)), 8),
              'category', _rev_item->>'category',
              'isReversal', true,
              'createdAt', now()
            ));
          END IF;
        END LOOP;

        UPDATE public.partners SET
          pending_profit = round((SELECT COALESCE(SUM((x->>'amount')::numeric), 0) FROM jsonb_array_elements(_updated_details) x), 4),
          confirmed_profit = round(COALESCE(confirmed_profit, 0) - _confirmed_reverted, 4),
          current_balance = round(COALESCE(current_balance, 0) - _confirmed_reverted, 4),
          total_profit_earned = round(COALESCE(total_profit_earned, 0) - _confirmed_reverted, 4),
          pending_profit_details = _updated_details,
          profit_history = COALESCE(profit_history, '[]'::jsonb) || _rev_entries,
          updated_at = now()
        WHERE id = _partner.id;

        _total_reverted := _total_reverted + _pending_reverted + _confirmed_reverted;
      END IF;
    END LOOP;

    RETURN jsonb_build_object(
      'success', true,
      'invoice_number', _inv.invoice_number,
      'total_reverted', round(_total_reverted, 8)
    );
  END IF;

  FOR _partner IN
    SELECT * FROM public.partners
    WHERE user_id = _owner
      AND (
        profit_history @> jsonb_build_array(jsonb_build_object('invoiceId', _inv.invoice_number))
        OR pending_profit_details @> jsonb_build_array(jsonb_build_object('invoiceId', _inv.invoice_number))
      )
    ORDER BY id
    FOR UPDATE
  LOOP
    _pending_reverted := 0;
    _updated_details := '[]'::jsonb;

    FOR _item IN SELECT * FROM jsonb_array_elements(COALESCE(_partner.pending_profit_details, '[]'::jsonb)) LOOP
      IF _item->>'invoiceId' = _inv.invoice_number THEN
        _amt := COALESCE((_item->>'amount')::numeric, 0);
        IF _full THEN
          _pending_reverted := _pending_reverted + _amt;
        ELSE
          _pending_reverted := _pending_reverted + round(_amt * _ratio, 8);
          IF abs(round(_amt * (1.0 - _ratio), 8)) > 0.00005 THEN
            _updated_details := _updated_details || jsonb_set(_item, '{amount}', to_jsonb(round(_amt * (1.0 - _ratio), 8)));
          END IF;
        END IF;
      ELSE
        _updated_details := _updated_details || _item;
      END IF;
    END LOOP;

    SELECT COALESCE(SUM(COALESCE((x->>'amount')::numeric, 0)), 0) INTO _pending_now
      FROM jsonb_array_elements(COALESCE(_partner.pending_profit_details, '[]'::jsonb)) x
     WHERE x->>'invoiceId' = _inv.invoice_number;

    SELECT COALESCE(SUM(COALESCE((x->>'amount')::numeric, 0)), 0) INTO _orig_share
      FROM jsonb_array_elements(COALESCE(_partner.profit_history, '[]'::jsonb)) x
     WHERE x->>'invoiceId' = _inv.invoice_number
       AND COALESCE((x->>'isReversal')::boolean, false) = false
       AND COALESCE((x->>'isRelease')::boolean, false) = false
       AND COALESCE(x->>'id', '') NOT LIKE '%-rel'
       AND COALESCE(x->>'category', '') <> 'تحرير دفعة دين';

    SELECT COALESCE(SUM(-COALESCE((x->>'amount')::numeric, 0)), 0) INTO _already_reverted
      FROM jsonb_array_elements(COALESCE(_partner.profit_history, '[]'::jsonb)) x
     WHERE x->>'invoiceId' = _inv.invoice_number
       AND COALESCE((x->>'isReversal')::boolean, false) = true;

    _confirmed_net := round(_orig_share - _pending_now - _already_reverted, 8);
    _confirmed_net := CASE WHEN _orig_share >= 0 THEN GREATEST(_confirmed_net, 0) ELSE LEAST(_confirmed_net, 0) END;
    _confirmed_reverted := CASE WHEN _full THEN _confirmed_net ELSE round(_confirmed_net * _ratio, 8) END;

    IF _pending_reverted <> 0 OR _confirmed_reverted <> 0 THEN
      _revert_record := jsonb_build_object(
        'id', extract(epoch from now())::text || _partner.id::text || '-rev',
        'invoiceId', _inv.invoice_number,
        'amount', -round(_pending_reverted + _confirmed_reverted, 8),
        'pendingReverted', round(_pending_reverted, 8),
        'confirmedReverted', round(_confirmed_reverted, 8),
        'category', 'مرتجع فاتورة',
        'isReversal', true,
        'createdAt', now()
      );

      UPDATE public.partners SET
        pending_profit = round((SELECT COALESCE(SUM((x->>'amount')::numeric), 0) FROM jsonb_array_elements(_updated_details) x), 4),
        confirmed_profit = round(COALESCE(confirmed_profit, 0) - _confirmed_reverted, 4),
        current_balance = round(COALESCE(current_balance, 0) - _confirmed_reverted, 4),
        total_profit_earned = round(COALESCE(total_profit_earned, 0) - _confirmed_reverted, 4),
        pending_profit_details = _updated_details,
        profit_history = COALESCE(profit_history, '[]'::jsonb) || public._split_reversal_by_category(_revert_record, profit_history, _inv.invoice_number),
        updated_at = now()
      WHERE id = _partner.id;

      _total_reverted := _total_reverted + _pending_reverted + _confirmed_reverted;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'invoice_number', _inv.invoice_number,
    'total_reverted', round(_total_reverted, 8)
  );
END;
$function$
;

-- FUNCTION revoke_license | normalized md5 8155e1c57bd30eadd3d4d7768ea68348
CREATE OR REPLACE FUNCTION public.revoke_license(_license_id uuid, _reason text DEFAULT 'Revoked by admin'::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Only boss can revoke
  IF NOT is_boss(auth.uid()) THEN
    RETURN false;
  END IF;
  
  UPDATE public.app_licenses
  SET is_revoked = true,
      revoked_at = now(),
      revoked_reason = _reason
  WHERE id = _license_id;
  
  RETURN true;
END;
$function$
;

-- FUNCTION revoke_user_sessions | normalized md5 7e77c7e1e375ef6d455a7d86b501dd1e
CREATE OR REPLACE FUNCTION public.revoke_user_sessions(p_user_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
DECLARE n integer;
BEGIN
  DELETE FROM auth.sessions WHERE user_id = p_user_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  DELETE FROM auth.refresh_tokens WHERE user_id::text = p_user_id::text;
  RETURN n;
END;
$function$
;

-- FUNCTION save_store_appearance | normalized md5 426e8762b14cd826a7ea21c81ff9960a
CREATE OR REPLACE FUNCTION public.save_store_appearance(_font_family text, _theme text DEFAULT NULL::text, _appearance jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _uid uuid := auth.uid(); _owner uuid;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  _owner := public.get_owner_id(_uid);
  IF _owner IS NULL THEN RAISE EXCEPTION 'لم يتم العثور على مالك المتجر'; END IF;
  UPDATE public.stores SET
    font_family = COALESCE(NULLIF(trim(_font_family), ''), font_family, 'Cairo'),
    theme = COALESCE(_theme, theme),
    appearance_settings = COALESCE(_appearance, appearance_settings),
    updated_at = now()
  WHERE user_id = _owner;
  RETURN jsonb_build_object('success', true, 'font_family', _font_family, 'theme', _theme);
END;
$function$
;

-- FUNCTION send_support_message | normalized md5 7d582cf4a4344faa8561c39da32b5e06
CREATE OR REPLACE FUNCTION public.send_support_message(_message text, _conversation_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _uid uuid := auth.uid(); _owner uuid; _conv_id uuid := _conversation_id; _is_boss_user boolean; _user_email text; _user_phone text; _user_name text; _store_name text; _msg_id uuid; _role text;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  IF trim(COALESCE(_message, '')) = '' THEN RAISE EXCEPTION 'لا يمكن إرسال رسالة فارغة'; END IF;
  _is_boss_user := public.is_boss(_uid);
  _owner := public.get_owner_id(_uid);
  IF _is_boss_user AND _conv_id IS NOT NULL THEN
    _role := 'boss';
  ELSE
    _role := 'user';
    IF _conv_id IS NULL THEN
      SELECT id INTO _conv_id FROM public.support_conversations WHERE user_id = _uid ORDER BY created_at DESC LIMIT 1;
      IF _conv_id IS NULL THEN
        SELECT email INTO _user_email FROM auth.users WHERE id = _uid;
        SELECT full_name, phone INTO _user_name, _user_phone FROM public.profiles WHERE user_id = _uid;
        SELECT name INTO _store_name FROM public.stores WHERE user_id = COALESCE(_owner, _uid) LIMIT 1;
        INSERT INTO public.support_conversations (user_id, owner_id, user_name, user_email, user_phone, store_name)
        VALUES (_uid, _owner, _user_name, _user_email, _user_phone, _store_name)
        RETURNING id INTO _conv_id;
      END IF;
    END IF;
  END IF;
  INSERT INTO public.support_messages (conversation_id, sender_id, sender_role, message)
  VALUES (_conv_id, _uid, _role, trim(_message)) RETURNING id INTO _msg_id;
  UPDATE public.support_conversations SET last_message_at = now(), updated_at = now(), status = 'open' WHERE id = _conv_id;
  RETURN jsonb_build_object('success', true, 'message_id', _msg_id, 'conversation_id', _conv_id, 'role', _role, 'created_at', now());
END;
$function$
;

-- FUNCTION set_customer_credit_limit_atomic | normalized md5 c7f8930bbaa5a66649be0a0dbae3a555
CREATE OR REPLACE FUNCTION public.set_customer_credit_limit_atomic(_customer_id uuid, _limit numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _o uuid := public._credit_actor(false);
BEGIN
  IF NOT public.is_store_owner(auth.uid()) THEN RAISE EXCEPTION 'تحديد حد الائتمان لمالك المتجر ومديره فقط' USING ERRCODE='42501'; END IF;
  IF _limit IS NOT NULL AND _limit < 0 THEN RAISE EXCEPTION 'حد الائتمان لا يمكن أن يكون سالباً'; END IF;
  UPDATE public.customers SET credit_limit = _limit, updated_at = now() WHERE id=_customer_id AND user_id=_o;
  IF NOT FOUND THEN RAISE EXCEPTION 'العميل غير موجود'; END IF;
END $function$
;

-- FUNCTION set_invoice_paid_at_sale | normalized md5 a89c7d39986a19c8974cd80acf8b4685
CREATE OR REPLACE FUNCTION public.set_invoice_paid_at_sale()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.paid_at_sale IS NULL THEN
    NEW.paid_at_sale := CASE
      WHEN NEW.payment_type = 'debt'
        THEN LEAST(GREATEST(COALESCE(NEW.debt_paid, 0), 0), COALESCE(NEW.total, 0))
      ELSE COALESCE(NEW.total, 0)
    END;
  END IF;
  RETURN NEW;
END;
$function$
;

-- FUNCTION set_store_settings_updated_at | normalized md5 15ebcf54049284f3662a5b46e11e124e
CREATE OR REPLACE FUNCTION public.set_store_settings_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$
;

-- FUNCTION set_user_pin | normalized md5 b56b95be367704b432935a60afc2278d
CREATE OR REPLACE FUNCTION public.set_user_pin(_target_user_id uuid, _raw_pin text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
    _caller UUID := auth.uid();
    _is_authorized BOOLEAN := FALSE;
BEGIN
    -- التحقق من وجود جلسة مصادقة نشطة
    IF _caller IS NULL THEN
        RAISE EXCEPTION 'غير مصرح: يجب تسجيل الدخول أولاً';
    END IF;

    -- التحقق الصارم من الملكية وعزل المتجر:
    -- يُسمح فقط إذا كان:
    -- 1) المستخدم يغير رمز PIN الخاص به شخصياً
    -- 2) أو المستدعي هو المدير العام (Boss)
    -- 3) أو المستدعي هو المالك المباشر (owner_id) للمستخدم المستهدف في جدول user_roles
    SELECT (
        _caller = _target_user_id 
        OR public.is_boss(_caller) 
        OR EXISTS (
            SELECT 1 FROM public.user_roles 
            WHERE user_id = _target_user_id 
              AND owner_id = _caller
        )
    ) INTO _is_authorized;

    IF NOT _is_authorized THEN
        RAISE EXCEPTION 'غير مصرح: لا يمكنك تعيين رمز أمان لمستخدم لا يتبع لمتجرك';
    END IF;

    -- التحقق من طول رمز الـ PIN (من 4 إلى 8 أرقام)
    IF length(trim(_raw_pin)) < 4 OR length(trim(_raw_pin)) > 8 THEN
        RAISE EXCEPTION 'رمز الـ PIN يجب أن يتكون من 4 إلى 8 خانات رقمية';
    END IF;

    -- تشفير وتخزين الهاش الآمن مع Salt عشوائي
    UPDATE public.profiles
    SET pin_hash = crypt(trim(_raw_pin), gen_salt('bf', 10)),
        updated_at = now()
    WHERE user_id = _target_user_id;

    RETURN TRUE;
END;
$function$
;

-- FUNCTION snapshot_shift_opening_exchange_rates | normalized md5 3e62470b90a64bd48ef6edc4b4e1df3c
CREATE OR REPLACE FUNCTION public.snapshot_shift_opening_exchange_rates()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _rates jsonb;
BEGIN
  IF NEW.user_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('shift_fx:' || NEW.user_id::text));
    IF NEW.opening_exchange_rates IS NULL OR NEW.opening_exchange_rates = '{}'::jsonb THEN
      SELECT NULLIF(ss.exchange_rates, '{}'::jsonb)
        INTO _rates
        FROM public.store_settings ss
       WHERE ss.user_id = NEW.user_id
       LIMIT 1;

      IF _rates IS NULL THEN
        SELECT NULLIF(s.exchange_rates, '{}'::jsonb)
          INTO _rates
          FROM public.stores s
         WHERE s.user_id = NEW.user_id
         LIMIT 1;
      END IF;

      NEW.opening_exchange_rates := COALESCE(_rates, '{"USD": 1}'::jsonb);
    END IF;
  END IF;
  RETURN NEW;
END;
$function$
;

-- FUNCTION supplier_refund_atomic | normalized md5 1b123f5272c0e8e081cdb9b594222dc5
CREATE OR REPLACE FUNCTION public.supplier_refund_atomic(_supplier_id uuid, _amount numeric, _method text, _note text, _operation_id text, _source text DEFAULT 'external'::text, _shift_id uuid DEFAULT NULL::uuid, _currency text DEFAULT 'USD'::text, _currency_amount numeric DEFAULT NULL::numeric, _rate numeric DEFAULT NULL::numeric)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _o uuid := public._supplier_owner();
  _id uuid;
  _bal numeric;
  _ccy text := upper(COALESCE(NULLIF(trim(_currency), ''), 'USD'));
  _eff_rate numeric;
  _eff_ccy_amt numeric;
BEGIN
  IF COALESCE(_amount,0) <= 0 THEN RAISE EXCEPTION 'المبلغ يجب أن يكون أكبر من الصفر'; END IF;
  IF COALESCE(_operation_id,'') = '' THEN RAISE EXCEPTION 'معرّف العملية مطلوب'; END IF;
  IF _source NOT IN ('drawer','external') THEN RAISE EXCEPTION 'جهة الاستلام غير صالحة'; END IF;
  IF _source = 'drawer' AND _shift_id IS NULL THEN RAISE EXCEPTION 'الاستلام في الصندوق يتطلب وردية مفتوحة'; END IF;

  IF _ccy = 'USD' THEN
    _eff_rate := 1;
    _eff_ccy_amt := round(_amount, 4);
  ELSE
    _eff_rate := COALESCE(_rate, (SELECT NULLIF((ss.exchange_rates->>_ccy)::numeric, 0) FROM public.store_settings ss WHERE ss.user_id = _o LIMIT 1));
    IF _eff_rate IS NULL OR _eff_rate <= 0 THEN RAISE EXCEPTION 'سعر صرف العملة % غير صالح', _ccy; END IF;
    _eff_ccy_amt := round(COALESCE(NULLIF(_currency_amount, 0), _amount * _eff_rate), 4);
    IF _eff_ccy_amt <= 0 THEN RAISE EXCEPTION 'مبلغ العملة % غير صالح', _ccy; END IF;
    IF _currency_amount IS NOT NULL AND _currency_amount > 0 THEN
      IF abs(_eff_ccy_amt - (_amount * _eff_rate)) > GREATEST(0.05, (_amount * _eff_rate) * 0.01) THEN
        RAISE EXCEPTION 'مبلغ العملة (%) لا يطابق القيمة المحوّلة (% × %)', _eff_ccy_amt, _amount, _eff_rate;
      END IF;
    END IF;
  END IF;

  PERFORM 1 FROM public.suppliers WHERE id=_supplier_id AND user_id=_o FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'المورد غير موجود'; END IF;
  SELECT id INTO _id FROM public.supplier_ledger_entries WHERE user_id=_o AND operation_id=_operation_id AND entry_type='refund';
  IF _id IS NOT NULL THEN RETURN _id; END IF;
  PERFORM public.assert_period_open(_o, CURRENT_DATE, 'استرداد من مورد');
  SELECT COALESCE(SUM(amount),0) INTO _bal FROM public.supplier_ledger_entries WHERE supplier_id=_supplier_id;
  IF _amount > -_bal + 0.0001 THEN RAISE EXCEPTION 'الاسترداد أكبر من الرصيد الدائن لنا عند المورد (%)', round(-_bal,2); END IF;
  IF _source = 'drawer' THEN
    PERFORM 1 FROM public.cash_shifts WHERE id = _shift_id AND user_id = _o AND closed_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'الوردية غير موجودة أو مغلقة أو لا تتبع لهذا المتجر'; END IF;
    PERFORM public._supplier_drawer_tx(_o,_shift_id,'supplier_refund',_amount,_ccy,_eff_ccy_amt,_eff_rate,_operation_id,'استرداد من مورد إلى الصندوق');
  END IF;
  INSERT INTO public.supplier_ledger_entries(user_id,supplier_id,entry_type,amount,reference_type,payment_method,payment_source,shift_id,note,operation_id,created_by)
  VALUES (_o,_supplier_id,'refund',round(_amount,4),'supplier_refund',_method,_source,CASE WHEN _source='drawer' THEN _shift_id END,_note,_operation_id,auth.uid()) RETURNING id INTO _id;
  RETURN _id;
END
$function$
;

-- FUNCTION sync_product_typed_fields | normalized md5 4cdd0c57d9990928abfc04ebcd187e37
CREATE OR REPLACE FUNCTION public.sync_product_typed_fields()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE cf jsonb := COALESCE(NEW.custom_fields,'{}'::jsonb); _w text; _wp text;
BEGIN
  NEW.serial_number := NULLIF(left(trim(COALESCE(cf->>'serialNumber','')),64),'');
  NEW.batch_number  := NULLIF(left(trim(COALESCE(cf->>'batchNumber','')),64),'');
  NEW.weight        := NULLIF(left(trim(COALESCE(cf->>'weight','')),32),'');
  NEW.size          := NULLIF(left(trim(COALESCE(cf->>'size','')),32),'');
  NEW.color         := NULLIF(left(trim(COALESCE(cf->>'color','')),32),'');
  NEW.fabric_type   := NULLIF(left(trim(COALESCE(cf->>'fabricType','')),64),'');
  NEW.author        := NULLIF(left(trim(COALESCE(cf->>'author','')),120),'');
  NEW.publisher     := NULLIF(left(trim(COALESCE(cf->>'publisher','')),120),'');
  NEW.table_number  := NULLIF(left(trim(COALESCE(cf->>'tableNumber','')),16),'');
  NEW.order_notes   := NULLIF(left(trim(COALESCE(cf->>'orderNotes','')),500),'');
  _w := substring(COALESCE(cf->>'warranty','') from '([0-9]+)');
  NEW.warranty_months := CASE WHEN _w IS NULL THEN NULL
    WHEN COALESCE(cf->>'warranty','') ~* '(سنة|سنوات|year)' THEN LEAST(_w::int*12,600)
    ELSE LEAST(_w::int,600) END;
  _wp := COALESCE(cf->>'wholesalePrice','');
  NEW.wholesale_price := CASE WHEN _wp ~ '^[0-9]+([.][0-9]+)?$' AND _wp::numeric > 0 THEN round(_wp::numeric,2) ELSE NULL END;
  RETURN NEW;
END $function$
;

-- FUNCTION sync_stores_to_store_settings | normalized md5 960804121d7a6bb15f372332056b75fa
CREATE OR REPLACE FUNCTION public.sync_stores_to_store_settings()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.store_settings (
    user_id, name, store_type, phone, email, address, logo_url,
    primary_currency, exchange_rates, tax_enabled, tax_rate, sync_settings,
    shift_variance_tolerance_usd, surplus_as_profit, updated_at
  )
  VALUES (
    NEW.user_id,
    COALESCE(NULLIF(trim(NEW.name), ''), 'متجري'),
    NEW.store_type,
    NEW.phone,
    NEW.email,
    NEW.address,
    NEW.logo_url,
    NEW.primary_currency,
    NEW.exchange_rates,
    NEW.tax_enabled,
    NEW.tax_rate,
    NEW.sync_settings,
    COALESCE(NEW.shift_variance_tolerance_usd, 1),
    COALESCE(NEW.surplus_as_profit, true),
    now()
  )
  ON CONFLICT (user_id) DO UPDATE SET
    name = EXCLUDED.name,
    store_type = EXCLUDED.store_type,
    phone = EXCLUDED.phone,
    email = EXCLUDED.email,
    address = EXCLUDED.address,
    logo_url = EXCLUDED.logo_url,
    primary_currency = EXCLUDED.primary_currency,
    exchange_rates = EXCLUDED.exchange_rates,
    tax_enabled = EXCLUDED.tax_enabled,
    tax_rate = EXCLUDED.tax_rate,
    sync_settings = EXCLUDED.sync_settings,
    shift_variance_tolerance_usd = EXCLUDED.shift_variance_tolerance_usd,
    surplus_as_profit = EXCLUDED.surplus_as_profit,
    updated_at = now();

  RETURN NEW;
END;
$function$
;

-- FUNCTION track_license_device_binding | normalized md5 eb15994b39f833e938acce329ae0c59a
CREATE OR REPLACE FUNCTION public.track_license_device_binding()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.device_id IS NULL THEN
    NEW.device_bound_at := NULL;
  ELSIF TG_OP = 'INSERT' OR NEW.device_id IS DISTINCT FROM OLD.device_id THEN
    NEW.device_bound_at := now();
  END IF;
  RETURN NEW;
END;
$function$
;

-- FUNCTION trg_expenses_assert_period_open | normalized md5 d88f4ece76fbb60522392c97dc6d9184
CREATE OR REPLACE FUNCTION public.trg_expenses_assert_period_open()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT public._owner_purge_allowed() THEN
      PERFORM public.assert_period_open(OLD.user_id, OLD.date, 'تعديل المصروفات');
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF current_setting('app.internal_expense_reverse', true) = '1'
       AND NOT COALESCE(OLD.is_reversed, false) AND NEW.is_reversed
       AND (to_jsonb(OLD) - ARRAY['is_reversed','reversed_at','reversed_by','reversed_reason'])
         = (to_jsonb(NEW) - ARRAY['is_reversed','reversed_at','reversed_by','reversed_reason']) THEN
      PERFORM public._assert_accounting_posting_open(NEW.user_id, NEW.reversed_at, 'عكس مصروف');
      RETURN NEW;
    END IF;
    IF OLD.date IS DISTINCT FROM NEW.date THEN
      PERFORM public.assert_period_open(OLD.user_id, OLD.date, 'تعديل المصروفات');
    END IF;
  END IF;

  PERFORM public.assert_period_open(NEW.user_id, NEW.date, 'تعديل المصروفات');
  RETURN NEW;
END;
$function$
;

-- FUNCTION trg_recalc_pos_invoice_profit | normalized md5 1298f748c6d2daf88f43065d38ccbd41
CREATE OR REPLACE FUNCTION public.trg_recalc_pos_invoice_profit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM public.invoices i WHERE i.id=NEW.invoice_id AND i.operation_id IS NOT NULL
             AND COALESCE(i.status,'') <> 'refunded') THEN
    PERFORM public.recalc_pos_invoice_profit(NEW.invoice_id);
  END IF;
  RETURN NULL;
END $function$
;

-- FUNCTION trigger_normalize_profile_phone | normalized md5 fb516f9dafdaba5ae24c4d83c98ccdfc
CREATE OR REPLACE FUNCTION public.trigger_normalize_profile_phone()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    NEW.phone := public.normalize_phone_number(NEW.phone);
    RETURN NEW;
END;
$function$
;

-- FUNCTION unregister_boss_push_token | normalized md5 f46f685c827eeeabaeb26a7420c04b58
CREATE OR REPLACE FUNCTION public.unregister_boss_push_token(p_token text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Access denied: authentication required';
  END IF;
  IF p_token IS NULL OR length(p_token) < 20 THEN
    RETURN;
  END IF;
  -- A user can only remove their own device token (no cross-user deletes).
  DELETE FROM public.boss_push_tokens
   WHERE token = p_token
     AND user_id = auth.uid();
END
$function$
;

-- FUNCTION unregister_push_token | normalized md5 1cd4580f9ee7e322470332e43974ad42
CREATE OR REPLACE FUNCTION public.unregister_push_token(p_token text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.uid() is null then return; end if;
  delete from public.user_push_tokens where token = p_token and user_id = auth.uid();
end $function$
;

-- FUNCTION update_category_atomic | normalized md5 9fe84c6161a44c071be18588954e7efe
CREATE OR REPLACE FUNCTION public.update_category_atomic(_category_id uuid, _new_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _owner uuid := public.get_owner_id(auth.uid()); _old_name text; _partner record; _updated_shares jsonb; _item jsonb;
BEGIN
  IF auth.uid() IS NULL OR _owner IS NULL THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  _new_name := trim(_new_name);
  IF _new_name IS NULL OR length(_new_name) = 0 THEN RAISE EXCEPTION 'اسم التصنيف لا يمكن أن يكون فارغاً'; END IF;
  SELECT name INTO _old_name FROM public.categories WHERE id = _category_id AND user_id = _owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'التصنيف غير موجود'; END IF;
  IF _old_name = _new_name THEN RETURN jsonb_build_object('success', true, 'updated', false); END IF;
  UPDATE public.categories SET name = _new_name, updated_at = now() WHERE id = _category_id;
  UPDATE public.products SET category = _new_name, updated_at = now() WHERE user_id = _owner AND category = _old_name;
  FOR _partner IN SELECT id, category_shares FROM public.partners WHERE user_id = _owner AND category_shares IS NOT NULL FOR UPDATE LOOP
    _updated_shares := '[]'::jsonb;
    FOR _item IN SELECT * FROM jsonb_array_elements(_partner.category_shares) LOOP
      IF (_item->>'categoryName') = _old_name THEN
        _updated_shares := _updated_shares || jsonb_set(_item, '{categoryName}', to_jsonb(_new_name));
      ELSE
        _updated_shares := _updated_shares || _item;
      END IF;
    END LOOP;
    UPDATE public.partners SET category_shares = _updated_shares, updated_at = now() WHERE id = _partner.id;
  END LOOP;
  RETURN jsonb_build_object('success', true, 'old_name', _old_name, 'new_name', _new_name);
END;
$function$
;

-- FUNCTION update_purchase_invoice_updated_at | normalized md5 a3a8dcc15e232b73d3f5c4abfa43f3d8
CREATE OR REPLACE FUNCTION public.update_purchase_invoice_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$
;

-- FUNCTION update_updated_at_column | normalized md5 a3a8dcc15e232b73d3f5c4abfa43f3d8
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$
;

-- FUNCTION update_warehouse_timestamp | normalized md5 a3a8dcc15e232b73d3f5c4abfa43f3d8
CREATE OR REPLACE FUNCTION public.update_warehouse_timestamp()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$
;

-- FUNCTION validate_activation_code_strength | normalized md5 4f7211c2135a7bb975206389f1c377ac
CREATE OR REPLACE FUNCTION public.validate_activation_code_strength()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.code IS NULL OR length(regexp_replace(NEW.code, '[^A-Za-z0-9]', '', 'g')) < 12 THEN
    RAISE EXCEPTION 'Activation code must contain at least 12 letters or digits';
  END IF;
  RETURN NEW;
END $function$
;

-- FUNCTION validate_partner_shares | normalized md5 60d297c61a142ba9e70693253b2f63fc
CREATE OR REPLACE FUNCTION public.validate_partner_shares()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _total_pct numeric := 0;
  _other_pct numeric := 0;
  _total_exp_pct numeric := 0;
  _new_exp_pct numeric := 0;
  _cat record;
BEGIN
  -- Skip validation on updates that do not touch share configuration or owner
  IF TG_OP = 'UPDATE'
     AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
     AND NEW.access_all IS NOT DISTINCT FROM OLD.access_all
     AND NEW.share_percentage IS NOT DISTINCT FROM OLD.share_percentage
     AND NEW.expense_share_percentage IS NOT DISTINCT FROM OLD.expense_share_percentage
     AND NEW.category_shares IS NOT DISTINCT FROM OLD.category_shares THEN
    RETURN NEW;
  END IF;

  -- Serialize concurrent share edits for the same store owner
  PERFORM pg_advisory_xact_lock(hashtext('partner_shares:' || NEW.user_id::text));

  -- KD-08 / D-09: whole percentages only (the owner's share is the remainder, never a fraction)
  IF (NEW.share_percentage IS NOT NULL AND NEW.share_percentage <> trunc(NEW.share_percentage))
     OR (NEW.expense_share_percentage IS NOT NULL AND NEW.expense_share_percentage <> trunc(NEW.expense_share_percentage))
     OR EXISTS (
       SELECT 1
       FROM jsonb_array_elements(
         CASE WHEN jsonb_typeof(NEW.category_shares) = 'array' THEN NEW.category_shares ELSE '[]'::jsonb END
       ) cs
       WHERE COALESCE((cs->>'percentage')::numeric, 0) <> trunc(COALESCE((cs->>'percentage')::numeric, 0))
     ) THEN
    RAISE EXCEPTION 'نسب الشركاء يجب أن تكون أعداداً صحيحة بدون فواصل'
      USING ERRCODE = '22023';
  END IF;

  -- Expense share: non-negative
  IF NEW.expense_share_percentage IS NOT NULL AND NEW.expense_share_percentage < 0 THEN
    RAISE EXCEPTION 'نسبة مشاركة المصاريف للشريك لا يمكن أن تكون سالبة'
      USING ERRCODE = '22023';
  END IF;

  -- KD-08 / D-09: expense pools are separate. General partners share what remains after category partners,
  -- so their expense percentages sum to at most 100 (the owner keeps the rest). Category partners' expense
  -- percentages are of the total and also sum to at most 100 on their own.
  _new_exp_pct := COALESCE(NEW.expense_share_percentage, 0);
  IF COALESCE(NEW.access_all, false) = true THEN
    SELECT COALESCE(SUM(COALESCE(expense_share_percentage, 0)), 0)
      INTO _total_exp_pct
    FROM public.partners
    WHERE user_id = NEW.user_id
      AND COALESCE(access_all, false) = true
      AND (TG_OP = 'INSERT' OR id <> OLD.id);
    IF round(_total_exp_pct + _new_exp_pct, 4) > 100 THEN
      RAISE EXCEPTION 'إجمالي مصاريف الشركاء العامين يتجاوز 100%% (الإجمالي: %%%)',
        round(_total_exp_pct + _new_exp_pct, 2)
        USING ERRCODE = '22023';
    END IF;
  ELSE
    SELECT COALESCE(SUM(COALESCE(expense_share_percentage, 0)), 0)
      INTO _total_exp_pct
    FROM public.partners
    WHERE user_id = NEW.user_id
      AND COALESCE(access_all, false) = false
      AND (TG_OP = 'INSERT' OR id <> OLD.id);
    IF round(_total_exp_pct + _new_exp_pct, 4) > 100 THEN
      RAISE EXCEPTION 'إجمالي مصاريف شركاء الصنف يتجاوز 100%% (الإجمالي: %%%)',
        round(_total_exp_pct + _new_exp_pct, 2)
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF COALESCE(NEW.access_all, false) = true THEN
    IF COALESCE(NEW.share_percentage, 0) < 0 THEN
      RAISE EXCEPTION 'نسبة الشريك لا يمكن أن تكون سالبة'
        USING ERRCODE = '22023';
    END IF;

    SELECT COALESCE(SUM(COALESCE(share_percentage, 0)), 0)
      INTO _total_pct
    FROM public.partners
    WHERE user_id = NEW.user_id
      AND COALESCE(access_all, false) = true
      AND (TG_OP = 'INSERT' OR id <> OLD.id);

    IF round(_total_pct + COALESCE(NEW.share_percentage, 0), 4) > 100 THEN
      RAISE EXCEPTION 'إجمالي نسب الشركاء العامين يتجاوز 100%% (الإجمالي: %%%)',
        round(_total_pct + COALESCE(NEW.share_percentage, 0), 2)
        USING ERRCODE = '22023';
    END IF;
  ELSIF NEW.category_shares IS NOT NULL AND jsonb_typeof(NEW.category_shares) = 'array' THEN
    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements(NEW.category_shares) cs
      WHERE COALESCE((cs->>'enabled')::boolean, false) = true
        AND COALESCE((cs->>'percentage')::numeric, 0) < 0
    ) THEN
      RAISE EXCEPTION 'نسبة الشريك في الفئة لا يمكن أن تكون سالبة'
        USING ERRCODE = '22023';
    END IF;

    FOR _cat IN
      SELECT
        trim(cs->>'categoryName') AS category_name,
        SUM(COALESCE((cs->>'percentage')::numeric, 0)) AS new_pct
      FROM jsonb_array_elements(NEW.category_shares) cs
      WHERE COALESCE((cs->>'enabled')::boolean, false) = true
        AND NULLIF(trim(COALESCE(cs->>'categoryName', '')), '') IS NOT NULL
        AND COALESCE((cs->>'percentage')::numeric, 0) > 0
      GROUP BY trim(cs->>'categoryName')
    LOOP
      SELECT COALESCE(SUM(COALESCE((cs->>'percentage')::numeric, 0)), 0)
        INTO _other_pct
      FROM public.partners p,
           jsonb_array_elements(
             CASE
               WHEN p.category_shares IS NOT NULL AND jsonb_typeof(p.category_shares) = 'array'
               THEN p.category_shares
               ELSE '[]'::jsonb
             END
           ) cs
      WHERE p.user_id = NEW.user_id
        AND COALESCE(p.access_all, false) = false
        AND (TG_OP = 'INSERT' OR p.id <> OLD.id)
        AND COALESCE((cs->>'enabled')::boolean, false) = true
        AND trim(COALESCE(cs->>'categoryName', '')) = _cat.category_name
        AND COALESCE((cs->>'percentage')::numeric, 0) > 0;

      IF round(_other_pct + _cat.new_pct, 4) > 100 THEN
        RAISE EXCEPTION 'إجمالي نسب الشركاء للفئة "%" يتجاوز 100%% (الإجمالي: %%%)',
          _cat.category_name,
          round(_other_pct + _cat.new_pct, 2)
          USING ERRCODE = '22023';
      END IF;
    END LOOP;
  END IF;

  RETURN NEW;
END;
$function$
;

-- FUNCTION verify_user_pin | normalized md5 9a61e858b1140a80fac6b3e2bfabdf5a
CREATE OR REPLACE FUNCTION public.verify_user_pin(_user_id uuid, _entered_pin text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE _stored_hash TEXT;
BEGIN
  SELECT pin_hash INTO _stored_hash FROM public.profiles WHERE user_id = _user_id;
  IF _stored_hash IS NULL THEN RETURN FALSE; END IF;
  RETURN (_stored_hash = crypt(trim(_entered_pin), _stored_hash));
END;
$function$
;

-- FUNCTION writeoff_debt_atomic | normalized md5 535e70f5c595df739e9434e0fcb6d000
CREATE OR REPLACE FUNCTION public.writeoff_debt_atomic(_debt_id uuid, _reason text, _operation_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _caller uuid := auth.uid();
  _owner uuid := public.get_owner_id(_caller);
  _debt public.debts%ROWTYPE;
  _partner record;
  _clean_details jsonb;
  _item jsonb;
  _inv_id uuid;
  _inv_total numeric := 0;
  _inv_profit numeric := 0;
  _inv_tax numeric := 0;
  _has_inv boolean := false;
  _amount numeric := 0;
  _pending_cancelled numeric := 0;
  _tax_cancelled numeric := 0;
  _loss numeric := 0;
  _total_cost numeric := 0;
  _cat record;
  _cat_loss numeric;
  _remaining_loss numeric;
  _cat_share jsonb;
  _part numeric;
  _impact jsonb := '[]'::jsonb;
  _partners_total numeric := 0;
  _wo_key text;
  _resolved_customer_id uuid;
BEGIN
  PERFORM set_config('app.partner_source', 'writeoff_debt_atomic', true);
  IF _caller IS NULL OR _owner IS NULL THEN
    RAISE EXCEPTION 'غير مصرح';
  END IF;

  IF NOT public.is_store_owner(_caller) THEN
    RAISE EXCEPTION 'شطب الدين مخصص لمالك المتجر فقط' USING ERRCODE = '42501';
  END IF;

  IF _operation_id IS NULL OR length(_operation_id) < 8 THEN
    RAISE EXCEPTION 'معرف العملية غير صالح';
  END IF;

  SELECT * INTO _debt
    FROM public.debts
   WHERE id = _debt_id AND user_id = _owner
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'الدين غير موجود أو لا يتبع لهذا المتجر';
  END IF;

  IF _debt.status = 'written_off' THEN
    RETURN jsonb_build_object('success', true, 'already_written_off', true, 'debt_id', _debt_id);
  END IF;

  IF COALESCE(_debt.status, '') IN ('cancelled', 'fully_paid') THEN
    RAISE EXCEPTION 'لا يمكن شطب دين ملغى أو مسدد بالكامل';
  END IF;

  PERFORM public.assert_period_open(_owner, CURRENT_DATE, 'شطب دين');

  _amount := round(GREATEST(COALESCE(_debt.remaining_debt, 0), 0), 8);
  IF _amount <= 0 THEN
    RAISE EXCEPTION 'لا يوجد مبلغ متبقٍ لشطبه';
  END IF;
  _wo_key := 'WO-' || COALESCE(_debt.invoice_id, _debt_id::text);

  IF _debt.invoice_id IS NOT NULL AND NOT COALESCE(_debt.is_cash_debt, false) THEN
    SELECT i.id, COALESCE(i.total, 0), COALESCE(i.profit, 0), COALESCE(i.tax_amount, 0)
      INTO _inv_id, _inv_total, _inv_profit, _inv_tax
      FROM public.invoices i
     WHERE i.user_id = _owner
       AND (i.invoice_number = _debt.invoice_id OR i.id::text = _debt.invoice_id)
     ORDER BY i.created_at
     LIMIT 1;
    _has_inv := FOUND;
  END IF;

  IF _has_inv AND _inv_total > 0 THEN
    _pending_cancelled := round(_inv_profit * LEAST(_amount, _inv_total) / _inv_total, 8);
    _tax_cancelled := round(_inv_tax * LEAST(_amount, _inv_total) / _inv_total, 8);
  END IF;
  _loss := GREATEST(round(_amount - _pending_cancelled - _tax_cancelled, 8), 0);

  PERFORM set_config('app.debt_writeoff_internal', '1', true);

  UPDATE public.debts
     SET status = 'written_off',
         notes = concat_ws(E'\n', notes, '[شطب دين]: ' || COALESCE(_reason, 'شطب إداري')),
         updated_at = now()
   WHERE id = _debt_id;

  IF _debt.invoice_id IS NOT NULL AND NOT COALESCE(_debt.is_cash_debt, false) THEN
    UPDATE public.invoices
       SET status = 'written_off',
           debt_remaining = 0,
           notes = concat_ws(E'\n', notes, '[دين مشطوب]: ' || COALESCE(_reason, '')),
           updated_at = now()
     WHERE user_id = _owner
       AND (invoice_number = _debt.invoice_id OR id::text = _debt.invoice_id);
  END IF;

  _resolved_customer_id := _debt.customer_id;
  IF _resolved_customer_id IS NULL THEN
    IF NULLIF(trim(COALESCE(_debt.customer_phone, '')), '') IS NOT NULL THEN
      SELECT CASE WHEN count(*) = 1 THEN (array_agg(id))[1] ELSE NULL END
        INTO _resolved_customer_id
        FROM public.customers
       WHERE user_id = _owner
         AND trim(COALESCE(phone, '')) = trim(_debt.customer_phone);
    END IF;
    IF _resolved_customer_id IS NULL AND NULLIF(trim(COALESCE(_debt.customer_name, '')), '') IS NOT NULL THEN
      SELECT id INTO _resolved_customer_id
        FROM public.customers
       WHERE user_id = _owner
         AND name = _debt.customer_name
       ORDER BY created_at ASC
       LIMIT 1;
    END IF;
  END IF;

  IF _resolved_customer_id IS NOT NULL THEN
    PERFORM public.recalc_customer_open_debt(_owner, _resolved_customer_id);
  END IF;

  IF _debt.invoice_id IS NOT NULL THEN
    FOR _partner IN
      SELECT * FROM public.partners
       WHERE user_id = _owner
         AND pending_profit_details @> jsonb_build_array(jsonb_build_object('invoiceId', _debt.invoice_id))
       FOR UPDATE
    LOOP
      _clean_details := '[]'::jsonb;
      FOR _item IN SELECT * FROM jsonb_array_elements(COALESCE(_partner.pending_profit_details, '[]'::jsonb))
      LOOP
        IF (_item->>'invoiceId') <> _debt.invoice_id THEN
          _clean_details := _clean_details || _item;
        END IF;
      END LOOP;

      UPDATE public.partners
         SET pending_profit_details = _clean_details,
             pending_profit = (
               SELECT COALESCE(SUM((x->>'amount')::numeric), 0)
                 FROM jsonb_array_elements(_clean_details) AS x
             ),
             updated_at = now()
       WHERE id = _partner.id;
    END LOOP;
  END IF;

  IF _loss > 0 AND _has_inv THEN
    SELECT COALESCE(SUM(COALESCE(ii.cost_price, 0) * COALESCE(ii.quantity, 0)), 0)
      INTO _total_cost
      FROM public.invoice_items ii
     WHERE ii.invoice_id = _inv_id;

    FOR _cat IN
      SELECT c.category_name, c.cat_cost
        FROM (
          SELECT COALESCE(NULLIF(trim(p.category), ''), 'عام') AS category_name,
                 SUM(COALESCE(ii.cost_price, 0) * COALESCE(ii.quantity, 0)) AS cat_cost
            FROM public.invoice_items ii
            LEFT JOIN public.products p ON p.id = ii.product_id AND p.user_id = _owner
           WHERE _total_cost > 0 AND ii.invoice_id = _inv_id
           GROUP BY COALESCE(NULLIF(trim(p.category), ''), 'عام')
          HAVING SUM(COALESCE(ii.cost_price, 0) * COALESCE(ii.quantity, 0)) > 0
          UNION ALL
          SELECT 'عام'::text, 1::numeric WHERE NOT (_total_cost > 0)
        ) c
    LOOP
      _cat_loss := CASE WHEN _total_cost > 0
                        THEN round(_loss * _cat.cat_cost / _total_cost, 8)
                        ELSE _loss END;
      _remaining_loss := _cat_loss;

      BEGIN
        FOR _partner IN
          SELECT * FROM public.partners
           WHERE user_id = _owner
             AND COALESCE(access_all, false) = false
             AND category_shares IS NOT NULL
           FOR UPDATE
        LOOP
          SELECT cs INTO _cat_share
            FROM jsonb_array_elements(_partner.category_shares) cs
           WHERE (cs->>'enabled')::boolean = true
             AND cs->>'categoryName' = _cat.category_name
           LIMIT 1;

          IF _cat_share IS NOT NULL AND COALESCE((_cat_share->>'percentage')::numeric, 0) > 0 THEN
            _part := round(_cat_loss * (_cat_share->>'percentage')::numeric / 100.0, 4);
            IF _part > 0 THEN
              _remaining_loss := _remaining_loss - _part;
              _partners_total := _partners_total + _part;

              UPDATE public.partners SET
                confirmed_profit = round(COALESCE(confirmed_profit, 0) - _part, 4),
                current_balance = round(COALESCE(current_balance, 0) - _part, 4),
                total_profit_earned = round(COALESCE(total_profit_earned, 0) - _part, 4),
                profit_history = COALESCE(profit_history, '[]'::jsonb) || jsonb_build_object(
                  'id', 'wo-' || _debt_id::text || '-' || _partner.id::text || '-' || _cat.category_name,
                  'invoiceId', _wo_key,
                  'amount', -_part,
                  'category', 'خسارة دين معدوم',
                  'isDebt', false,
                  'isWriteoff', true,
                  'createdAt', now()
                ),
                updated_at = now()
              WHERE id = _partner.id;

              _impact := _impact || jsonb_build_object(
                'partnerId', _partner.id,
                'partnerName', _partner.name,
                'amount', _part,
                'category', _cat.category_name
              );
            END IF;
          END IF;
        END LOOP;
      END;

      IF _remaining_loss > 0 THEN
        FOR _partner IN
          SELECT * FROM public.partners
           WHERE user_id = _owner
             AND COALESCE(access_all, false) = true
             AND COALESCE(share_percentage, 0) > 0
           FOR UPDATE
        LOOP
          _part := round(_remaining_loss * _partner.share_percentage / 100.0, 4);
          IF _part > 0 THEN
            _partners_total := _partners_total + _part;

            UPDATE public.partners SET
              confirmed_profit = round(COALESCE(confirmed_profit, 0) - _part, 4),
              current_balance = round(COALESCE(current_balance, 0) - _part, 4),
              total_profit_earned = round(COALESCE(total_profit_earned, 0) - _part, 4),
              profit_history = COALESCE(profit_history, '[]'::jsonb) || jsonb_build_object(
                'id', 'wo-' || _debt_id::text || '-' || _partner.id::text || '-' || _cat.category_name,
                'invoiceId', _wo_key,
                'amount', -_part,
                'category', 'خسارة دين معدوم',
                'isDebt', false,
                'isWriteoff', true,
                'createdAt', now()
              ),
              updated_at = now()
            WHERE id = _partner.id;

            _impact := _impact || jsonb_build_object(
              'partnerId', _partner.id,
              'partnerName', _partner.name,
              'amount', _part,
              'category', _cat.category_name
            );
          END IF;
        END LOOP;
      END IF;
    END LOOP;
  END IF;

  INSERT INTO public.debt_writeoffs(
    user_id, debt_id, customer_name, amount, reason, written_off_at, written_off_by, notes,
    loss_amount, pending_profit_cancelled, partner_impact, capital_impact
  ) VALUES (
    _owner, _debt_id, _debt.customer_name, _amount, COALESCE(_reason, 'شطب إداري'), now(), _caller, _debt.invoice_id,
    _loss, _pending_cancelled, _impact, round(_loss - _partners_total, 8)
  );

  RETURN jsonb_build_object(
    'success', true,
    'debt_id', _debt_id,
    'written_off_amount', _amount,
    'pending_profit_cancelled', _pending_cancelled,
    'loss_amount', _loss,
    'partners_loss', _partners_total,
    'owner_loss', round(_loss - _partners_total, 8),
    'partner_impact', _impact,
    'status', 'written_off'
  );
END;
$function$
;

