-- Align function EXECUTE grants and overloads with the live database.
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.boss_change_user_password(uuid,text)',
    'public.boss_hard_delete_user(uuid)',
    'public.boss_reactivate_user_license(uuid)',
    'public.boss_revoke_user_license(uuid)',
    'public.boss_set_single_device(text)',
    'public.check_product_addition_limit(uuid,boolean)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
  END LOOP;
  EXECUTE 'REVOKE ALL ON FUNCTION public.check_product_addition_limit__impl(uuid,boolean) FROM PUBLIC, anon, authenticated';
  EXECUTE 'REVOKE ALL ON FUNCTION public.clean_old_error_logs() FROM PUBLIC, anon, authenticated';
END $$;
DROP FUNCTION IF EXISTS public.add_expense_atomic(uuid, text, numeric, text, date, text);
DROP FUNCTION IF EXISTS public.partner_withdrawal_atomic(uuid, numeric, text, text, uuid, text, numeric);
