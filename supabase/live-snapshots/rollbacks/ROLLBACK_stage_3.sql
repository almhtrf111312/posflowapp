DROP TRIGGER IF EXISTS trg_partner_ledger_capture ON public.partners;
DROP FUNCTION IF EXISTS public._partner_ledger_capture();
DROP VIEW IF EXISTS public.partner_ledger_reconciliation;
-- Keep the ledger for history; to remove: DROP TRIGGER trg_partner_ledger_immutable ON public.partner_ledger_entries; DROP TABLE public.partner_ledger_entries;
-- The 'app.partner_source' set_config line injected into partner functions is harmless; remove by re-applying prior bodies if desired.
