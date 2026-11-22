-- Rollback for 20261121030000_posflow_revoke_anon_execute_on_internal_functions.sql
-- Restores the previous (permissive) EXECUTE grants on the 27 affected functions.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
      AND p.proname = ANY (ARRAY[
        '_partner_ledger_capture','_release_serials_on_invoice_refund','add_expense_atomic',
        'auto_confirm_user_email','create_subscription_request','delete_expense_atomic',
        'enforce_paid_write_access','guard_debt_writeoff_status','guard_written_off_debt',
        'guard_written_off_invoice','hard_delete_product_atomic','mark_all_support_messages_read',
        'notify_on_support_message','partner_deposit_atomic','partner_withdrawal_atomic',
        'payout_store_credit_atomic','push_app_broadcast','push_customer_message',
        'record_debt_payment_atomic','refund_invoice_atomic','register_serials_atomic',
        'release_serials_atomic','reset_user_store_data','reverse_expense_atomic',
        'save_store_appearance','send_support_message','update_category_atomic'
      ])
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO PUBLIC, anon, authenticated, service_role', r.sig);
  END LOOP;
END
$$;
NOTIFY pgrst, 'reload schema';
