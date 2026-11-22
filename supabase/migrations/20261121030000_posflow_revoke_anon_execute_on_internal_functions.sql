-- =============================================================================
-- Migration: 20261121030000_posflow_revoke_anon_execute_on_internal_functions.sql
-- Rollback:  supabase/live-snapshots/rollbacks/ROLLBACK_revoke_anon_execute.sql
--
-- Audit finding (Supabase linter 0028): 35 SECURITY DEFINER functions in
-- `public` were executable by the `anon` role (and PUBLIC).
--
-- This migration removes EXECUTE from PUBLIC/anon for the 27 functions that are
-- only meant to run for signed-in users, or as triggers. It deliberately KEEPS
-- anon access to the 8 functions that run before login:
--   get_public_contact_links, is_device_banned, issue_offline_lease,
--   lookup_serial, request_device_reset_secure, reset_device_for_user,
--   complete_phone_transfer, assign_store_and_profile_phone
--
-- Trigger functions do not need EXECUTE at fire time, so they get no new grant.
-- Non-trigger functions are re-granted to authenticated + service_role.
-- Idempotent.
-- =============================================================================

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig,
           (p.prorettype = 'trigger'::regtype) AS is_trigger
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
      AND p.proname = ANY (ARRAY[
        '_partner_ledger_capture',
        '_release_serials_on_invoice_refund',
        'add_expense_atomic',
        'auto_confirm_user_email',
        'create_subscription_request',
        'delete_expense_atomic',
        'enforce_paid_write_access',
        'guard_debt_writeoff_status',
        'guard_written_off_debt',
        'guard_written_off_invoice',
        'hard_delete_product_atomic',
        'mark_all_support_messages_read',
        'notify_on_support_message',
        'partner_deposit_atomic',
        'partner_withdrawal_atomic',
        'payout_store_credit_atomic',
        'push_app_broadcast',
        'push_customer_message',
        'record_debt_payment_atomic',
        'refund_invoice_atomic',
        'register_serials_atomic',
        'release_serials_atomic',
        'reset_user_store_data',
        'reverse_expense_atomic',
        'save_store_appearance',
        'send_support_message',
        'update_category_atomic'
      ])
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', r.sig);
    IF NOT r.is_trigger THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', r.sig);
    END IF;
  END LOOP;
END
$$;

NOTIFY pgrst, 'reload schema';
