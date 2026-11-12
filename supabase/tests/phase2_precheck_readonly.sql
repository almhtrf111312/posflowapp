SELECT 'column' AS kind,
       c.table_name || '.' || c.column_name AS name,
       c.data_type
         || CASE WHEN c.is_nullable = 'NO' THEN ' NOT NULL' ELSE '' END
         || COALESCE(' DEFAULT ' || c.column_default, '') AS info
  FROM information_schema.columns c
 WHERE c.table_schema = 'public'
   AND (c.table_name IN ('debt_writeoffs', 'accounting_period_closures', 'debt_payments')
        OR (c.table_name = 'invoices' AND c.column_name IN ('invoice_type', 'paid_at_sale', 'debt_paid', 'tax_amount', 'created_at', 'payment_type'))
        OR (c.table_name = 'partners' AND c.column_name IN ('access_all', 'category_shares', 'share_percentage', 'confirmed_profit', 'current_balance', 'total_profit_earned', 'profit_history'))
        OR (c.table_name = 'invoice_items' AND c.column_name IN ('invoice_id', 'product_id', 'cost_price', 'quantity')))
UNION ALL
SELECT 'trigger', t.tgrelid::regclass::text || '.' || t.tgname, pg_get_triggerdef(t.oid)
  FROM pg_trigger t
 WHERE t.tgrelid IN ('public.invoices'::regclass, 'public.debt_writeoffs'::regclass, 'public.accounting_period_closures'::regclass)
   AND NOT t.tgisinternal
UNION ALL SELECT 'count', 'debt_writeoffs', count(*)::text FROM public.debt_writeoffs
UNION ALL SELECT 'count', 'accounting_period_closures', count(*)::text FROM public.accounting_period_closures
UNION ALL SELECT 'count', 'debt_payments', count(*)::text FROM public.debt_payments
UNION ALL SELECT 'count', 'credit_invoices', count(*)::text FROM public.invoices WHERE payment_type = 'debt'
UNION ALL SELECT 'count', 'written_off_invoices', count(*)::text FROM public.invoices WHERE status = 'written_off'
UNION ALL SELECT 'function', p.oid::regprocedure::text, 'exists'
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname IN ('close_accounting_period_atomic', 'writeoff_debt_atomic', 'is_store_owner')
ORDER BY 1, 2;
