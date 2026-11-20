-- تحذير: يحذف الموردين وقيودهم ومرتجعات المشتريات. دوال cancel/edit_purchase_invoice_atomic تُعاد من هجرتيها السابقتين (20261024100000 و 20261120031000)
DROP FUNCTION IF EXISTS public.purchase_return_atomic(uuid,jsonb,text,text);
DROP FUNCTION IF EXISTS public.pay_supplier_atomic(uuid,numeric,text,text,text);
DROP FUNCTION IF EXISTS public.link_purchase_to_supplier_atomic(uuid,uuid,numeric);
DROP FUNCTION IF EXISTS public.create_supplier_atomic(text,text,text,text);
DROP FUNCTION IF EXISTS public._supplier_owner();
DROP VIEW IF EXISTS public.supplier_balances;
ALTER TABLE public.purchase_invoices DROP COLUMN IF EXISTS supplier_id, DROP COLUMN IF EXISTS amount_paid;
DROP TABLE IF EXISTS public.purchase_return_items;
DROP TABLE IF EXISTS public.purchase_returns;
DROP TABLE IF EXISTS public.supplier_ledger_entries;
DROP TABLE IF EXISTS public.suppliers;
