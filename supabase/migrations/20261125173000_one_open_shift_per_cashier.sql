-- One open shift per cashier per store. The server decides: a device that tries to open a second
-- shift for the same cashier is refused (unique violation), so two devices can never hold two open
-- drawers for the same cashier. A different cashier may keep their own open shift at the same time.
-- Checked before applying: no store has more than one open shift per cashier.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cash_shifts_one_open_per_cashier
  ON public.cash_shifts (user_id, (COALESCE(cashier_id, user_id)))
  WHERE closed_at IS NULL;
