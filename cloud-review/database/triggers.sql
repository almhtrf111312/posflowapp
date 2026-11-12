-- auth.users
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- auth.users
CREATE TRIGGER on_auth_user_created_role AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION handle_new_user_role();

-- auth.users
CREATE TRIGGER trg_auto_confirm_user_email BEFORE INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION auto_confirm_user_email();

-- public.accounting_period_closures
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.accounting_period_closures FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();

-- public.activation_codes
CREATE TRIGGER trg_activation_code_strength BEFORE INSERT OR UPDATE OF code ON public.activation_codes FOR EACH ROW EXECUTE FUNCTION validate_activation_code_strength();

-- public.app_licenses
CREATE TRIGGER trg_prevent_license_self_upgrade BEFORE UPDATE ON public.app_licenses FOR EACH ROW EXECUTE FUNCTION prevent_license_self_upgrade();

-- public.app_licenses
CREATE TRIGGER trg_track_license_device_binding BEFORE INSERT OR UPDATE OF device_id ON public.app_licenses FOR EACH ROW EXECUTE FUNCTION track_license_device_binding();

-- public.book_loans
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.book_loans FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();

-- public.book_loans
CREATE TRIGGER update_book_loans_updated_at BEFORE UPDATE ON public.book_loans FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- public.cash_shifts
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.cash_shifts FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();

-- public.cash_shifts
CREATE TRIGGER trg_cash_shifts_updated_at BEFORE UPDATE ON public.cash_shifts FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- public.categories
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.categories FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();

-- public.customers
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.customers FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();

-- public.customers
CREATE TRIGGER set_customers_updated_at BEFORE UPDATE ON public.customers FOR EACH ROW EXECUTE FUNCTION handle_updated_at();

-- public.customers
CREATE TRIGGER trg_prevent_customer_deletion BEFORE DELETE ON public.customers FOR EACH ROW EXECUTE FUNCTION prevent_customer_deletion_with_dues();

-- public.debt_payments
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.debt_payments FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();

-- public.debt_writeoffs
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.debt_writeoffs FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();

-- public.debts
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.debts FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();

-- public.debts
CREATE TRIGGER b_guard_debt_writeoff_status BEFORE UPDATE OF status ON public.debts FOR EACH ROW EXECUTE FUNCTION guard_debt_writeoff_status();

-- public.debts
CREATE TRIGGER c_guard_written_off_debt BEFORE UPDATE ON public.debts FOR EACH ROW WHEN ((old.status = 'written_off'::text)) EXECUTE FUNCTION guard_written_off_debt();

-- public.debts
CREATE TRIGGER set_debts_updated_at BEFORE UPDATE ON public.debts FOR EACH ROW EXECUTE FUNCTION handle_updated_at();

-- public.debts
CREATE TRIGGER trg_normalize_debt_row BEFORE INSERT OR UPDATE ON public.debts FOR EACH ROW EXECUTE FUNCTION normalize_debt_row();

-- public.expenses
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.expenses FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();

-- public.invoice_items
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.invoice_items FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();

-- public.invoice_items
CREATE CONSTRAINT TRIGGER recalc_pos_invoice_profit_trigger AFTER INSERT ON public.invoice_items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION trg_recalc_pos_invoice_profit();

-- public.invoice_sequences
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.invoice_sequences FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();

-- public.invoices
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.invoices FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();

-- public.invoices
CREATE TRIGGER c_set_invoice_paid_at_sale BEFORE INSERT ON public.invoices FOR EACH ROW EXECUTE FUNCTION set_invoice_paid_at_sale();

-- public.invoices
CREATE TRIGGER d_guard_written_off_invoice BEFORE UPDATE ON public.invoices FOR EACH ROW WHEN ((old.status = 'written_off'::text)) EXECUTE FUNCTION guard_written_off_invoice();

-- public.invoices
CREATE TRIGGER guard_refunded_invoice_status_trigger BEFORE UPDATE OF status ON public.invoices FOR EACH ROW EXECUTE FUNCTION guard_refunded_invoice_status();

-- public.invoices
CREATE TRIGGER set_invoices_updated_at BEFORE UPDATE ON public.invoices FOR EACH ROW EXECUTE FUNCTION handle_updated_at();

-- public.library_members
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.library_members FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();

-- public.library_members
CREATE TRIGGER update_library_members_updated_at BEFORE UPDATE ON public.library_members FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- public.maintenance_services
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.maintenance_services FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();

-- public.partners
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.partners FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();

-- public.partners
CREATE TRIGGER set_partners_updated_at BEFORE UPDATE ON public.partners FOR EACH ROW EXECUTE FUNCTION handle_updated_at();

-- public.products
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.products FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();

-- public.products
CREATE TRIGGER log_product_price_change_trigger AFTER UPDATE OF cost_price, sale_price ON public.products FOR EACH ROW EXECUTE FUNCTION log_product_price_change();

-- public.products
CREATE TRIGGER record_main_stock_movement_trigger AFTER INSERT OR UPDATE OF quantity ON public.products FOR EACH ROW EXECUTE FUNCTION record_main_stock_movement();

-- public.products
CREATE TRIGGER set_products_updated_at BEFORE UPDATE ON public.products FOR EACH ROW EXECUTE FUNCTION handle_updated_at();

-- public.products
CREATE TRIGGER sync_product_typed_fields_trigger BEFORE INSERT OR UPDATE OF custom_fields ON public.products FOR EACH ROW EXECUTE FUNCTION sync_product_typed_fields();

-- public.profiles
CREATE TRIGGER trg_normalize_profile_phone BEFORE INSERT OR UPDATE OF phone ON public.profiles FOR EACH ROW EXECUTE FUNCTION trigger_normalize_profile_phone();

-- public.profiles
CREATE TRIGGER update_profiles_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- public.profit_records
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.profit_records FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();

-- public.purchase_invoice_items
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.purchase_invoice_items FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();

-- public.purchase_invoices
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.purchase_invoices FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();

-- public.purchase_invoices
CREATE TRIGGER update_purchase_invoices_updated_at BEFORE UPDATE ON public.purchase_invoices FOR EACH ROW EXECUTE FUNCTION update_purchase_invoice_updated_at();

-- public.recurring_expenses
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.recurring_expenses FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();

-- public.recurring_expenses
CREATE TRIGGER set_recurring_expenses_updated_at BEFORE UPDATE ON public.recurring_expenses FOR EACH ROW EXECUTE FUNCTION handle_updated_at();

-- public.shift_transactions
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.shift_transactions FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();

-- public.stock_count_items
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.stock_count_items FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();

-- public.stock_counts
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.stock_counts FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();

-- public.stock_counts
CREATE TRIGGER trg_stock_counts_updated BEFORE UPDATE ON public.stock_counts FOR EACH ROW EXECUTE FUNCTION handle_updated_at();

-- public.stock_damages
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.stock_damages FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();

-- public.stock_movements
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.stock_movements FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();

-- public.stock_transfer_items
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.stock_transfer_items FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();

-- public.stock_transfers
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.stock_transfers FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();

-- public.stock_transfers
CREATE TRIGGER update_stock_transfers_timestamp BEFORE UPDATE ON public.stock_transfers FOR EACH ROW EXECUTE FUNCTION update_warehouse_timestamp();

-- public.store_settings
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.store_settings FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();

-- public.stores
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.stores FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();

-- public.stores
CREATE TRIGGER set_stores_updated_at BEFORE UPDATE ON public.stores FOR EACH ROW EXECUTE FUNCTION handle_updated_at();

-- public.subscription_requests
CREATE TRIGGER trg_notify_boss_subscription_request AFTER INSERT ON public.subscription_requests FOR EACH ROW EXECUTE FUNCTION notify_boss_on_subscription_request();

-- public.support_messages
CREATE TRIGGER trg_notify_support_message AFTER INSERT ON public.support_messages FOR EACH ROW EXECUTE FUNCTION notify_on_support_message();

-- public.warehouse_stock
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.warehouse_stock FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();

-- public.warehouse_stock
CREATE TRIGGER record_warehouse_stock_movement_trigger AFTER INSERT OR UPDATE OF quantity ON public.warehouse_stock FOR EACH ROW EXECUTE FUNCTION record_warehouse_stock_movement();

-- public.warehouses
CREATE TRIGGER a_paid_write_gate BEFORE INSERT OR DELETE OR UPDATE ON public.warehouses FOR EACH ROW EXECUTE FUNCTION enforce_paid_write_access();

-- public.warehouses
CREATE TRIGGER update_warehouses_timestamp BEFORE UPDATE ON public.warehouses FOR EACH ROW EXECUTE FUNCTION update_warehouse_timestamp();

