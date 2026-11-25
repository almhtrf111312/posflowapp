import { supabase } from '@/integrations/supabase/client';
import { emitEvent, EVENTS } from '@/lib/events';

export interface CreditSummary { storeCredit: number; creditLimit: number | null; totalDebt: number }
export interface CreditLedgerRow { id: string; entry_type: 'issue' | 'spend' | 'payout' | 'adjustment'; amount: number; reason?: string | null; invoice_number?: string | null; created_at: string }
export interface OpenDebt { id: string; invoice_id: string | null; remaining_debt: number }

export async function loadCreditSummary(customerId: string): Promise<CreditSummary> {
  const { data } = await supabase.from('customer_credit_balances').select('store_credit, credit_limit, total_debt').eq('customer_id', customerId).maybeSingle();
  return { storeCredit: Number(data?.store_credit) || 0, creditLimit: data?.credit_limit == null ? null : Number(data.credit_limit), totalDebt: Number(data?.total_debt) || 0 };
}

export async function loadCreditLedger(customerId: string): Promise<CreditLedgerRow[]> {
  const { data } = await supabase.from('customer_credit_ledger').select('id, entry_type, amount, reason, invoice_number, created_at').eq('customer_id', customerId).order('created_at', { ascending: false }).limit(100);
  return (data || []).map((r) => ({ ...r, amount: Number(r.amount) || 0 })) as CreditLedgerRow[];
}

export async function loadOpenDebts(customerId: string): Promise<OpenDebt[]> {
  const { data } = await supabase.from('debts').select('id, invoice_id, remaining_debt').eq('customer_id', customerId).gt('remaining_debt', 0).not('status', 'in', '(cancelled,written_off,fully_paid)');
  return (data || []).map((r) => ({ ...r, remaining_debt: Number(r.remaining_debt) || 0 }));
}

const done = () => { emitEvent(EVENTS.DEBTS_UPDATED, null); emitEvent(EVENTS.CUSTOMERS_UPDATED, null); };

export async function setCreditLimit(customerId: string, limit: number | null) {
  const { error } = await supabase.rpc('set_customer_credit_limit_atomic', { _customer_id: customerId, _limit: limit });
  if (error) throw error;
  done();
}
export async function issueStoreCredit(customerId: string, amount: number, reason: string, invoiceNumber?: string) {
  const { error } = await supabase.rpc('issue_store_credit_atomic', { _customer_id: customerId, _amount: amount, _reason: reason || null, _invoice_number: invoiceNumber || null, _operation_id: crypto.randomUUID() });
  if (error) throw error;
  done();
}
export async function applyCreditToDebt(debtId: string, amount: number) {
  const { error } = await supabase.rpc('apply_store_credit_to_debt_atomic', { _debt_id: debtId, _amount: amount, _operation_id: crypto.randomUUID() });
  if (error) throw error;
  done();
}
export async function payoutStoreCredit(customerId: string, amount: number, shiftId: string, currency = 'USD', currencyAmount?: number) {
  const { error } = await supabase.rpc('payout_store_credit_atomic', { _customer_id: customerId, _amount: amount, _shift_id: shiftId, _operation_id: crypto.randomUUID(), _currency: currency, _currency_amount: currencyAmount ?? amount, _rate: currencyAmount && amount > 0 ? currencyAmount / amount : null });
  if (error) throw error;
  done();
}
