-- Triggers present on the live database but created outside migration files.
DROP TRIGGER IF EXISTS trg_auto_confirm_user_email ON auth.users;
CREATE TRIGGER trg_auto_confirm_user_email BEFORE INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.auto_confirm_user_email();

DROP TRIGGER IF EXISTS trg_activation_code_strength ON public.activation_codes;
CREATE TRIGGER trg_activation_code_strength BEFORE INSERT OR UPDATE OF code ON public.activation_codes
  FOR EACH ROW EXECUTE FUNCTION public.validate_activation_code_strength();

-- Live no longer has the debt -> invoice sync trigger/function.
DROP TRIGGER IF EXISTS trg_sync_invoice_from_debt ON public.debts;
DROP FUNCTION IF EXISTS public.sync_invoice_from_debt();
