-- تحذير: يحذف بيانات الصناديق وقيودها
DROP FUNCTION IF EXISTS public.cash_box_fx_exchange_atomic(uuid,uuid,numeric,numeric,text,text);
DROP FUNCTION IF EXISTS public.cash_box_transfer_atomic(uuid,uuid,numeric,text,text);
DROP FUNCTION IF EXISTS public.cash_box_manual_entry_atomic(uuid,numeric,text,text);
DROP FUNCTION IF EXISTS public.create_cash_box_atomic(text,text,text,numeric);
DROP FUNCTION IF EXISTS public._cash_box_balance(uuid);
DROP FUNCTION IF EXISTS public._cash_box_owner();
DROP VIEW IF EXISTS public.cash_box_balances;
DROP TABLE IF EXISTS public.cash_box_entries;
DROP TABLE IF EXISTS public.cash_boxes;
