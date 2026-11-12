# Database functions (105)

| file | signature | SECURITY DEFINER |
|---|---|---|
| [activate_code_strict.sql](activate_code_strict.sql) | `activate_code_strict(p_code text, p_user_id uuid, p_user_email text, p_device_id text)` | yes |
| [add_expense_atomic.sql](add_expense_atomic.sql) | `add_expense_atomic(_operation_id text, _expense_type text, _amount numeric, _description text, _date date, _notes text)` | yes |
| [add_product_quantity.sql](add_product_quantity.sql) | `add_product_quantity(_product_id uuid, _amount integer)` | yes |
| [approve_subscription_request_atomic.sql](approve_subscription_request_atomic.sql) | `approve_subscription_request_atomic(p_request_id uuid, p_admin_note text)` | yes |
| [assert_period_open.sql](assert_period_open.sql) | `assert_period_open(_owner uuid, _date date, _what text)` | yes |
| [assign_store_and_profile_phone.sql](assign_store_and_profile_phone.sql) | `assign_store_and_profile_phone(_phone text)` | yes |
| [auto_confirm_user_email.sql](auto_confirm_user_email.sql) | `auto_confirm_user_email()` | yes |
| [boss_activate_license.sql](boss_activate_license.sql) | `boss_activate_license(p_target_user_id uuid, p_plan_id uuid, p_custom_days integer, p_mode text, p_request_id uuid, p_admin_note text)` | yes |
| [boss_change_user_password.sql](boss_change_user_password.sql) | `boss_change_user_password(_target_user_id uuid, _new_password text)` | yes |
| [boss_direct_activate_by_plan.sql](boss_direct_activate_by_plan.sql) | `boss_direct_activate_by_plan(p_target_user_id uuid, p_plan_id uuid, p_custom_days integer)` | yes |
| [boss_hard_delete_user.sql](boss_hard_delete_user.sql) | `boss_hard_delete_user(_target_user_id uuid)` | yes |
| [boss_reactivate_user_license.sql](boss_reactivate_user_license.sql) | `boss_reactivate_user_license(_target_user_id uuid)` | yes |
| [boss_revoke_user_license.sql](boss_revoke_user_license.sql) | `boss_revoke_user_license(_target_user_id uuid)` | yes |
| [boss_set_single_device.sql](boss_set_single_device.sql) | `boss_set_single_device(p_target_email text)` | yes |
| [can_add_cashier.sql](can_add_cashier.sql) | `can_add_cashier(_owner_id uuid)` | yes |
| [can_refund_invoices.sql](can_refund_invoices.sql) | `can_refund_invoices(_user_id uuid)` | yes |
| [cancel_debt_atomic.sql](cancel_debt_atomic.sql) | `cancel_debt_atomic(_debt_id uuid, _reason text)` | yes |
| [cancel_purchase_invoice_atomic.sql](cancel_purchase_invoice_atomic.sql) | `cancel_purchase_invoice_atomic(_invoice_id uuid, _reason text)` | yes |
| [check_and_bind_device.sql](check_and_bind_device.sql) | `check_and_bind_device(p_device_id text)` | yes |
| [check_phone_email_availability.sql](check_phone_email_availability.sql) | `check_phone_email_availability(_phone text, _email text, _exclude_user_id uuid)` | yes |
| [check_product_addition_limit.sql](check_product_addition_limit.sql) | `check_product_addition_limit(p_owner_id uuid, p_has_image boolean)` | yes |
| [check_store_phone_status.sql](check_store_phone_status.sql) | `check_store_phone_status(_phone text)` | yes |
| [clean_old_error_logs.sql](clean_old_error_logs.sql) | `clean_old_error_logs()` | yes |
| [clear_user_pin.sql](clear_user_pin.sql) | `clear_user_pin(_target_user_id uuid)` | yes |
| [close_accounting_period_atomic.sql](close_accounting_period_atomic.sql) | `close_accounting_period_atomic(_period_start date, _period_end date, _timezone text)` | yes |
| [close_cash_shift_atomic.sql](close_cash_shift_atomic.sql) | `close_cash_shift_atomic(_shift_id uuid, _actual_balance numeric, _variance_reason text)` | yes |
| [complete_phone_transfer.sql](complete_phone_transfer.sql) | `complete_phone_transfer(_request_id uuid, _entered_code text)` | yes |
| [confirm_partner_debt_profit_atomic.sql](confirm_partner_debt_profit_atomic.sql) | `confirm_partner_debt_profit_atomic(_invoice_id text, _payment_ratio numeric)` | yes |
| [confirm_subscription_request.sql](confirm_subscription_request.sql) | `confirm_subscription_request(p_request_id uuid)` | yes |
| [count_owner_cashiers.sql](count_owner_cashiers.sql) | `count_owner_cashiers(_owner_id uuid)` | yes |
| [create_subscription_request.sql](create_subscription_request.sql) | `create_subscription_request(p_plan_id uuid, p_method_id uuid)` | yes |
| [deduct_product_quantity.sql](deduct_product_quantity.sql) | `deduct_product_quantity(_product_id uuid, _amount integer)` | yes |
| [delete_debt_atomic.sql](delete_debt_atomic.sql) | `delete_debt_atomic(_debt_id uuid, _reason text)` | yes |
| [delete_expense_atomic.sql](delete_expense_atomic.sql) | `delete_expense_atomic(_expense_id uuid, _reason text)` | yes |
| [delete_owner_cascade.sql](delete_owner_cascade.sql) | `delete_owner_cascade(_owner_id uuid)` | yes |
| [distribute_invoice_partner_profits_atomic.sql](distribute_invoice_partner_profits_atomic.sql) | `distribute_invoice_partner_profits_atomic(_invoice_id uuid)` | yes |
| [distribute_sale_profit_to_partners_atomic.sql](distribute_sale_profit_to_partners_atomic.sql) | `distribute_sale_profit_to_partners_atomic(_invoice_id text, _customer_name text, _is_debt boolean, _category_profits jsonb)` | yes |
| [edit_purchase_invoice_atomic.sql](edit_purchase_invoice_atomic.sql) | `edit_purchase_invoice_atomic(_invoice_id uuid, _new_lines jsonb, _op_id text, _reason text)` | yes |
| [enforce_paid_write_access.sql](enforce_paid_write_access.sql) | `enforce_paid_write_access()` | yes |
| [get_boss_owners.sql](get_boss_owners.sql) | `get_boss_owners()` | yes |
| [get_boss_telegram_alert_config.sql](get_boss_telegram_alert_config.sql) | `get_boss_telegram_alert_config()` | yes |
| [get_inventory_value.sql](get_inventory_value.sql) | `get_inventory_value(_owner_id uuid)` | yes |
| [get_next_invoice_number.sql](get_next_invoice_number.sql) | `get_next_invoice_number(_user_id uuid)` | yes |
| [get_owner_id.sql](get_owner_id.sql) | `get_owner_id(_user_id uuid)` | yes |
| [get_public_contact_links.sql](get_public_contact_links.sql) | `get_public_contact_links()` | yes |
| [get_stock_discrepancies.sql](get_stock_discrepancies.sql) | `get_stock_discrepancies()` | yes |
| [get_user_role.sql](get_user_role.sql) | `get_user_role(_user_id uuid)` | yes |
| [get_user_storage_stats.sql](get_user_storage_stats.sql) | `get_user_storage_stats(_target_user_id uuid)` | yes |
| [guard_debt_writeoff_status.sql](guard_debt_writeoff_status.sql) | `guard_debt_writeoff_status()` | yes |
| [guard_refunded_invoice_status.sql](guard_refunded_invoice_status.sql) | `guard_refunded_invoice_status()` | no |
| [guard_written_off_debt.sql](guard_written_off_debt.sql) | `guard_written_off_debt()` | yes |
| [guard_written_off_invoice.sql](guard_written_off_invoice.sql) | `guard_written_off_invoice()` | yes |
| [handle_new_user.sql](handle_new_user.sql) | `handle_new_user()` | yes |
| [handle_new_user_role.sql](handle_new_user_role.sql) | `handle_new_user_role()` | yes |
| [handle_updated_at.sql](handle_updated_at.sql) | `handle_updated_at()` | no |
| [hard_delete_product_atomic.sql](hard_delete_product_atomic.sql) | `hard_delete_product_atomic(_product_id uuid)` | yes |
| [has_paid_write_access.sql](has_paid_write_access.sql) | `has_paid_write_access(_user_id uuid)` | yes |
| [has_role.sql](has_role.sql) | `has_role(_user_id uuid, _role app_role)` | yes |
| [is_boss.sql](is_boss.sql) | `is_boss(_user_id uuid)` | yes |
| [is_first_user.sql](is_first_user.sql) | `is_first_user()` | yes |
| [is_license_valid.sql](is_license_valid.sql) | `is_license_valid(_user_id uuid)` | yes |
| [is_store_owner.sql](is_store_owner.sql) | `is_store_owner(_user_id uuid)` | yes |
| [issue_offline_lease.sql](issue_offline_lease.sql) | `issue_offline_lease(p_device_id text)` | yes |
| [log_product_price_change.sql](log_product_price_change.sql) | `log_product_price_change()` | yes |
| [mark_all_support_messages_read.sql](mark_all_support_messages_read.sql) | `mark_all_support_messages_read()` | yes |
| [normalize_debt_row.sql](normalize_debt_row.sql) | `normalize_debt_row()` | no |
| [normalize_phone_number.sql](normalize_phone_number.sql) | `normalize_phone_number(p_phone text)` | no |
| [notify_boss_on_subscription_request.sql](notify_boss_on_subscription_request.sql) | `notify_boss_on_subscription_request()` | yes |
| [notify_on_support_message.sql](notify_on_support_message.sql) | `notify_on_support_message()` | yes |
| [partner_deposit_atomic.sql](partner_deposit_atomic.sql) | `partner_deposit_atomic(_partner_id uuid, _amount_usd numeric, _deposit_target text, _notes text, _shift_id uuid, _currency text, _original_amount numeric)` | yes |
| [partner_deposit_atomic__overload2.sql](partner_deposit_atomic__overload2.sql) | `partner_deposit_atomic(_partner_id uuid, _amount_usd numeric, _deposit_target text, _notes text, _shift_id uuid, _currency text, _original_amount numeric, _exchange_rate numeric)` | yes |
| [partner_withdrawal_atomic.sql](partner_withdrawal_atomic.sql) | `partner_withdrawal_atomic(_partner_id uuid, _amount numeric, _withdrawal_type text, _notes text, _shift_id uuid, _currency text, _original_amount numeric, _exchange_rate numeric)` | yes |
| [prevent_customer_deletion_with_dues.sql](prevent_customer_deletion_with_dues.sql) | `prevent_customer_deletion_with_dues()` | no |
| [prevent_license_self_upgrade.sql](prevent_license_self_upgrade.sql) | `prevent_license_self_upgrade()` | yes |
| [process_pos_sale_atomic.sql](process_pos_sale_atomic.sql) | `process_pos_sale_atomic(_operation_id text, _payment_type text, _customer_name text, _customer_phone text, _subtotal numeric, _discount numeric, _discount_percentage numeric, _tax_rate numeric, _tax_amount numeric, _total numeric, _profit numeric, _currency text, _warehouse_id uuid, _items jsonb, _down_payment numeric, _exchange_rate numeric, _tax_mode text)` | yes |
| [recalc_pos_invoice_profit.sql](recalc_pos_invoice_profit.sql) | `recalc_pos_invoice_profit(_invoice_id uuid)` | yes |
| [receive_stock_wac.sql](receive_stock_wac.sql) | `receive_stock_wac(_product_id uuid, _quantity numeric, _unit_cost numeric, _reference text)` | yes |
| [record_debt_payment_atomic.sql](record_debt_payment_atomic.sql) | `record_debt_payment_atomic(_debt_id uuid, _amount numeric, _operation_id text, _shift_id uuid)` | yes |
| [record_main_stock_movement.sql](record_main_stock_movement.sql) | `record_main_stock_movement()` | yes |
| [record_warehouse_stock_movement.sql](record_warehouse_stock_movement.sql) | `record_warehouse_stock_movement()` | yes |
| [refund_invoice_atomic.sql](refund_invoice_atomic.sql) | `refund_invoice_atomic(_invoice_number text, _source text)` | yes |
| [refund_invoice_partial_atomic.sql](refund_invoice_partial_atomic.sql) | `refund_invoice_partial_atomic(_invoice_number text, _items jsonb, _operation_id text)` | yes |
| [request_device_reset_secure.sql](request_device_reset_secure.sql) | `request_device_reset_secure(_license_key text, _user_email text)` | yes |
| [request_device_reset_secure__overload2.sql](request_device_reset_secure__overload2.sql) | `request_device_reset_secure(p_user_id uuid)` | yes |
| [reset_device_for_user.sql](reset_device_for_user.sql) | `reset_device_for_user(p_target_email text)` | yes |
| [reset_user_device.sql](reset_user_device.sql) | `reset_user_device(_target_user_id uuid)` | yes |
| [reset_user_store_data.sql](reset_user_store_data.sql) | `reset_user_store_data()` | yes |
| [reverse_expense_atomic.sql](reverse_expense_atomic.sql) | `reverse_expense_atomic(p_expense_id uuid, p_reason text)` | yes |
| [revert_invoice_partner_profits_atomic.sql](revert_invoice_partner_profits_atomic.sql) | `revert_invoice_partner_profits_atomic(_invoice_id uuid, _revert_ratio numeric)` | yes |
| [revoke_license.sql](revoke_license.sql) | `revoke_license(_license_id uuid, _reason text)` | yes |
| [save_store_appearance.sql](save_store_appearance.sql) | `save_store_appearance(_font_family text, _theme text, _appearance jsonb)` | yes |
| [send_support_message.sql](send_support_message.sql) | `send_support_message(_message text, _conversation_id uuid)` | yes |
| [set_invoice_paid_at_sale.sql](set_invoice_paid_at_sale.sql) | `set_invoice_paid_at_sale()` | no |
| [set_user_pin.sql](set_user_pin.sql) | `set_user_pin(_target_user_id uuid, _raw_pin text)` | yes |
| [sync_product_typed_fields.sql](sync_product_typed_fields.sql) | `sync_product_typed_fields()` | no |
| [track_license_device_binding.sql](track_license_device_binding.sql) | `track_license_device_binding()` | no |
| [trg_recalc_pos_invoice_profit.sql](trg_recalc_pos_invoice_profit.sql) | `trg_recalc_pos_invoice_profit()` | yes |
| [trigger_normalize_profile_phone.sql](trigger_normalize_profile_phone.sql) | `trigger_normalize_profile_phone()` | no |
| [update_category_atomic.sql](update_category_atomic.sql) | `update_category_atomic(_category_id uuid, _new_name text)` | yes |
| [update_purchase_invoice_updated_at.sql](update_purchase_invoice_updated_at.sql) | `update_purchase_invoice_updated_at()` | no |
| [update_updated_at_column.sql](update_updated_at_column.sql) | `update_updated_at_column()` | no |
| [update_warehouse_timestamp.sql](update_warehouse_timestamp.sql) | `update_warehouse_timestamp()` | no |
| [validate_activation_code_strength.sql](validate_activation_code_strength.sql) | `validate_activation_code_strength()` | no |
| [verify_user_pin.sql](verify_user_pin.sql) | `verify_user_pin(_user_id uuid, _entered_pin text)` | yes |
| [writeoff_debt_atomic.sql](writeoff_debt_atomic.sql) | `writeoff_debt_atomic(_debt_id uuid, _reason text, _operation_id text)` | yes |
