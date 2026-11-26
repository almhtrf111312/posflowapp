import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';
import type { CloudDebt } from './debts-cloud';

export class ManualDebtRefusedError extends Error {
  constructor(message: string) { super(message); this.name = 'ManualDebtRefusedError'; }
}

type ManualDebtArgs = Database['public']['Functions']['create_manual_debt_atomic']['Args'];

/** The online action and queued replay accept the same serialized payload. */
export async function submitManualDebt(client: Pick<SupabaseClient<Database>, 'rpc'>, payload: Record<string, unknown>) {
  const { data, error } = await client.rpc('create_manual_debt_atomic', {
    _id: payload.id,
    _invoice_id: payload.invoice_id ?? null,
    _customer_name: payload.customer_name,
    _customer_phone: payload.customer_phone ?? null,
    _total_debt: payload.total_debt,
    _due_date: payload.due_date || null,
    _notes: payload.notes ?? null,
    _is_cash_debt: payload.is_cash_debt ?? false,
  } as ManualDebtArgs);
  if (error?.code) throw new ManualDebtRefusedError(`دين مرفوض من الخادم: ${error.message || error.code}`);
  if (error) throw new Error(error.message || 'فشل إنشاء الدين');
  return data as unknown as CloudDebt | null;
}
