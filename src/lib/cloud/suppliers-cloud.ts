import { supabase } from '@/integrations/supabase/client';
import { emitEvent, EVENTS } from '@/lib/events';

export interface SupplierBalance {
  id: string;
  name: string;
  company?: string | null;
  phone?: string | null;
  balance_due: number; // موجب = علينا للمورد، سالب = له رصيد دائن لنا
}

export interface SupplierLedgerRow {
  id: string;
  entry_type: 'purchase' | 'payment' | 'purchase_return' | 'adjustment' | 'refund';
  amount: number;
  payment_method?: string | null;
  payment_source?: 'drawer' | 'external' | null;
  note?: string | null;
  created_at: string;
}

export type SupplierMoneySource = 'drawer' | 'external';

const db = supabase as any;

export async function loadSuppliersCloud(): Promise<SupplierBalance[]> {
  const { data, error } = await db.from('supplier_balances').select('*').order('name');
  if (error) {
    console.error('loadSuppliersCloud', error);
    return [];
  }
  return (data || []).map((r: any) => ({
    id: r.supplier_id ?? r.id,
    name: r.name,
    company: r.company,
    phone: r.phone,
    balance_due: Number(r.balance_due) || 0,
  }));
}

export async function createSupplierCloud(input: { name: string; company?: string; phone?: string; notes?: string }): Promise<string> {
  const { data, error } = await db.rpc('create_supplier_atomic', {
    _name: input.name.trim(),
    _company: input.company?.trim() || null,
    _phone: input.phone?.trim() || null,
    _notes: input.notes?.trim() || null,
  });
  if (error) throw error;
  emitEvent(EVENTS.PURCHASES_UPDATED);
  return data as string;
}

export async function loadSupplierLedgerCloud(supplierId: string): Promise<SupplierLedgerRow[]> {
  const { data, error } = await db
    .from('supplier_ledger_entries')
    .select('id, entry_type, amount, payment_method, payment_source, note, created_at')
    .eq('supplier_id', supplierId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) {
    console.error('loadSupplierLedgerCloud', error);
    return [];
  }
  return (data || []).map((r: any) => ({ ...r, amount: Number(r.amount) || 0 }));
}

interface MoneyArgs {
  supplierId: string;
  amount: number;
  method?: string;
  note?: string;
  source: SupplierMoneySource;
  shiftId?: string | null;
  currency?: string;
  currencyAmount?: number;
  rate?: number;
  operationId?: string;
}

const moneyParams = (a: MoneyArgs) => ({
  _supplier_id: a.supplierId,
  _amount: a.amount,
  _method: a.method || 'cash',
  _note: a.note || null,
  _operation_id: a.operationId || crypto.randomUUID(),
  _source: a.source,
  _shift_id: a.source === 'drawer' ? a.shiftId || null : null,
  _currency: a.currency || 'USD',
  _currency_amount: a.currencyAmount ?? null,
  _rate: a.rate ?? null,
});

export async function paySupplierCloud(a: MoneyArgs): Promise<string> {
  const { data, error } = await db.rpc('pay_supplier_atomic', moneyParams(a));
  if (error) throw error;
  emitEvent(EVENTS.PURCHASES_UPDATED);
  return data as string;
}

export async function refundFromSupplierCloud(a: MoneyArgs): Promise<string> {
  const { data, error } = await db.rpc('supplier_refund_atomic', moneyParams(a));
  if (error) throw error;
  emitEvent(EVENTS.PURCHASES_UPDATED);
  return data as string;
}

export async function purchaseReturnCloud(invoiceId: string, lines: Array<{ item_id: string; quantity: number }>, reason: string, operationId?: string): Promise<unknown> {
  const { data, error } = await db.rpc('purchase_return_atomic', {
    _invoice_id: invoiceId,
    _lines: lines,
    _reason: reason,
    _operation_id: operationId || crypto.randomUUID(),
  });
  if (error) throw error;
  emitEvent(EVENTS.PURCHASES_UPDATED);
  emitEvent(EVENTS.PRODUCTS_UPDATED);
  return data;
}


export interface ShiftSupplierMoney {
  drawerPaid: number;
  drawerRefunded: number;
  externalPaid: number;
  externalRefunded: number;
}

/** دفعات/استردادات الموردين خلال وردية: ما خرج/دخل الصندوق مقابل ما تمّ خارجه */
export async function loadShiftSupplierMoney(shiftId: string, openedAt: string): Promise<ShiftSupplierMoney> {
  const out: ShiftSupplierMoney = { drawerPaid: 0, drawerRefunded: 0, externalPaid: 0, externalRefunded: 0 };
  const [{ data: tx }, { data: led }] = await Promise.all([
    db.from('shift_transactions').select('type, amount').eq('shift_id', shiftId).in('type', ['supplier_payment', 'supplier_refund']),
    db.from('supplier_ledger_entries').select('entry_type, amount').eq('payment_source', 'external').in('entry_type', ['payment', 'refund']).gte('created_at', openedAt),
  ]);
  for (const r of tx || []) {
    if (r.type === 'supplier_payment') out.drawerPaid += Number(r.amount) || 0;
    else out.drawerRefunded += Number(r.amount) || 0;
  }
  for (const r of led || []) {
    const a = Math.abs(Number(r.amount) || 0);
    if (r.entry_type === 'payment') out.externalPaid += a; else out.externalRefunded += a;
  }
  return out;
}
