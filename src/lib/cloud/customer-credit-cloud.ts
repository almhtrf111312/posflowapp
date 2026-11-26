import { supabase } from '@/integrations/supabase/client';
import { assertCurrencyUsable } from '../money-engine';
import { emitEvent, EVENTS } from '@/lib/events';
import { addUniqueOperation } from '@/lib/sync-queue';
import { isAppOffline } from '@/hooks/use-network-status';
import { submitCreditOperation, STORE_CREDIT_QUEUE_TYPE, type CreditOpData, type CreditOpResult } from '@/lib/store-credit-op';

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
// Store-credit writes (plan T-1): the caller passes ONE operation id per user action and reuses it on retry; offline or when the
// request never reached the server the operation is queued with that same id (sync-queue type 'store_credit_op').
function creditDeps(onLocalPayout?: (d: CreditOpData) => void) {
  return {
    offline: () => isAppOffline(),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      const { error } = await (supabase.rpc as unknown as (f: string, a: Record<string, unknown>) => Promise<{ error: unknown }>)(fn, args);
      return { error };
    },
    enqueue: (d: CreditOpData) => { addUniqueOperation(STORE_CREDIT_QUEUE_TYPE, { ...d }, `store_credit:${d.operationId}`); },
    onLocalPayout,
  };
}
export async function issueStoreCredit(customerId: string, amount: number, reason: string, invoiceNumber: string | undefined, operationId: string): Promise<CreditOpResult> {
  const r = await submitCreditOperation({ kind: 'issue', operationId, customerId, amount, reason: reason || null, invoiceNumber: invoiceNumber || null }, creditDeps());
  done();
  return r;
}
export async function applyCreditToDebt(debtId: string, amount: number, operationId: string): Promise<CreditOpResult> {
  const r = await submitCreditOperation({ kind: 'apply', operationId, debtId, amount }, creditDeps());
  done();
  return r;
}
export async function payoutStoreCredit(customerId: string, amount: number, shiftId: string, operationId: string, currency = 'USD', currencyAmount?: number, onLocalPayout?: (d: CreditOpData) => void): Promise<CreditOpResult> {
  assertCurrencyUsable(currency); // F-05
  const r = await submitCreditOperation({ kind: 'payout', operationId, customerId, amount, shiftId, currency, currencyAmount: currencyAmount ?? amount }, creditDeps(onLocalPayout));
  done();
  return r;
}
