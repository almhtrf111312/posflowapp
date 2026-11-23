-- ONE-OFF SCRIPT (owner request, 2026-11-23). NOT a migration: it is never replayed by the migration tooling.
--
-- Wipes ALL business data inside every account (test data): products, warehouses, categories, invoices and their
-- items/profit/accounting events, sales settlements, stock history, purchases and suppliers, customers, debts and
-- payments, drawer shifts and movements, expenses, partners and their ledger, library, period closures, activity log,
-- invoice numbering.
--
-- KEEPS: accounts (auth.users), profiles, user roles, licences and activation codes, stores, store settings,
-- app settings, subscription data, support conversations, user notifications, push tokens, encryption keys,
-- banned devices, security and error logs, client versions, broadcasts, invoice_accounting_cutover.
--
-- TRUNCATE is used on purpose: it bypasses the row guards (the owner confirmed a full wipe of test data).
-- It is irreversible. Take a backup first if anything must be kept.

TRUNCATE TABLE
  public.accounting_period_closures,
  public.accounting_rpc_receipts,
  public.activity_log,
  public.book_loans,
  public.cash_shifts,
  public.categories,
  public.customer_credit_ledger,
  public.customers,
  public.debt_payments,
  public.debt_writeoffs,
  public.debts,
  public.expenses,
  public.inventory_valuation_adjustments,
  public.invoice_accounting_events,
  public.invoice_items,
  public.invoice_sequences,
  public.invoices,
  public.library_members,
  public.maintenance_services,
  public.partner_ledger_entries,
  public.partners,
  public.product_serial_events,
  public.product_serials,
  public.products,
  public.profit_records,
  public.purchase_audit_logs,
  public.purchase_invoice_items,
  public.purchase_invoices,
  public.purchase_return_items,
  public.purchase_returns,
  public.recurring_expenses,
  public.sales_refund_allocations,
  public.sales_settlement_replays,
  public.shift_transactions,
  public.stock_count_items,
  public.stock_counts,
  public.stock_damages,
  public.stock_movements,
  public.stock_transfer_items,
  public.stock_transfers,
  public.supplier_ledger_entries,
  public.suppliers,
  public.warehouse_stock,
  public.warehouses;
