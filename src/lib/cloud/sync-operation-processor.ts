import { supabase } from '@/integrations/supabase/client';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { QueuedOperation } from '@/lib/sync-queue';
import { filterTablePayload, getOwnerIdForInsert } from '@/lib/supabase-store';
import { invalidatePartnersCache } from './partners-cloud';
import { writeShiftTransactionRow } from './cashbox-cloud';

type LooseSupabase = SupabaseClient<any, 'public', any>;
const sb = supabase as unknown as LooseSupabase;

async function assertSuccess(request: PromiseLike<{ error: { message?: string; details?: string; hint?: string; code?: string } | null }>): Promise<boolean> {
  const { error } = await request;
  if (error) {
    const code = error.code ? `[${error.code}] ` : '';
    const details = error.details ? ` (${error.details})` : '';
    const hint = error.hint ? ` [تلميح: ${error.hint}]` : '';
    throw new Error(`${code}${error.message || 'فشلت العملية السحابية'}${details}${hint}`.trim());
  }
  return true;
}

const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

export async function processGenericQueuedOperation(operation: QueuedOperation): Promise<boolean> {
  const data = operation.data;

  switch (operation.type) {
    case 'profit_record': {
      const cleanData = filterTablePayload('profit_records', data);
      return assertSuccess(sb.from('profit_records').insert(cleanData));
    }
    case 'profit_reverse':
      return assertSuccess(sb.from('profit_records').update({
        is_reversed: true,
        reversed_at: new Date().toISOString(),
      }).eq('invoice_id', String(data.invoiceId || '')).eq('is_reversed', false));
    case 'shift_open': {
      const cleanData = filterTablePayload('cash_shifts', data);
      const ownerId = await getOwnerIdForInsert();
      if (!ownerId) throw new Error('No owner id');
      return assertSuccess(sb.from('cash_shifts').insert({ ...cleanData, user_id: ownerId }));
    }
    case 'cash_shift_upsert': {
      const cleanData = filterTablePayload('cash_shifts', data);
      const ownerId = await getOwnerIdForInsert();
      if (!ownerId) throw new Error('No owner id');
      return assertSuccess(
        sb.from('cash_shifts').upsert(
          { ...cleanData, user_id: ownerId },
          { onConflict: 'id' }
        )
      );
    }
    case 'shift_close': {
      const shiftId = String(data.shiftId || '');
      if (!shiftId) throw new Error('Missing shift id');
      // Older queued payloads carried client-computed columns (actual_balance, variance_reason).
      // The close always goes through the atomic server function, which recomputes expected balance and variance.
      const actualBalance = Number(data.actualBalance ?? data.actual_balance ?? 0);
      const rawReason = data.varianceReason ?? data.variance_reason ?? null;
      const { data: closeResult, error: closeError } = await sb.rpc('close_cash_shift_atomic', {
        _shift_id: shiftId,
        _actual_balance: Number.isFinite(actualBalance) ? actualBalance : 0,
        _variance_reason: rawReason ? String(rawReason) : null,
      });
      if (closeError) throw new Error(closeError.message);
      if (!(closeResult as { success?: boolean } | null)?.success) {
        throw new Error('فشل إقفال الوردية على الخادم');
      }
      return true;
    }
    case 'shift_transaction': {
      const cleanData = filterTablePayload('shift_transactions', data);
      const ownerId = await getOwnerIdForInsert();
      if (!ownerId) throw new Error('No owner id');
      // Older queued rows have no id: the queue operation id keeps retries idempotent
      const rowId = isUuid(cleanData.id) ? cleanData.id : (isUuid(operation.id) ? operation.id : undefined);
      await writeShiftTransactionRow({ ...cleanData, ...(rowId ? { id: rowId } : {}), user_id: ownerId });
      return true;
    }
    case 'expense': {
      const cleanData = filterTablePayload('expenses', data);
      const ownerId = await getOwnerIdForInsert();
      return assertSuccess(sb.from('expenses').insert({ ...cleanData, user_id: ownerId }));
    }
    case 'debt': {
      const cleanData = filterTablePayload('debts', data);
      const ownerId = await getOwnerIdForInsert();
      if (!ownerId) throw new Error('No owner id');
      if (cleanData.id) {
        return assertSuccess(sb.from('debts').upsert({ ...cleanData, user_id: ownerId }, { onConflict: 'id', ignoreDuplicates: true }));
      }
      return assertSuccess(sb.from('debts').insert({ ...cleanData, user_id: ownerId }));
    }
    case 'expense_atomic': {
      const { uniqueKey: _u, ...args } = data;
      const { error } = await sb.rpc('add_expense_atomic', args);
      if (error) throw new Error(error.message);
      return true;
    }
    case 'debt_payment': {
      if (!data.debtId || !data.operationId) throw new Error('Invalid debt payment');
      const { error } = await sb.rpc('record_debt_payment_atomic', {
        _debt_id: String(data.debtId), _amount: Number(data.amount), _operation_id: String(data.operationId),
      });
      if (error) throw new Error(error.message);
      return true;
    }
    case 'debt_writeoff': {
      const debtId = String(data.debtId || data.id || '');
      const reason = String(data.reason || 'شطب دين عبر المزامنة');
      if (!debtId) throw new Error('Missing debt id for writeoff');
      
      // استدعاء المعالجة الذرية لشطب الدين سحابياً
      const { error } = await sb.rpc('writeoff_debt_atomic', {
        _debt_id: debtId,
        _reason: reason,
        _operation_id: String(data.operationId || operation.id)
      });
      if (error) {
        // لا شطب بتحديث مباشر للجدول: الشطب يمر بالدالة الذرية فقط (صلاحية المالك، قيد الدين المعدوم، حصص الشركاء)
        throw new Error(error.message);
      }
      invalidatePartnersCache();
      return true;
    }
    case 'customer_create': {
      const ownerId = await getOwnerIdForInsert();
      if (!ownerId) throw new Error('No owner id');
      const cleanData = filterTablePayload('customers', data);
      // Idempotent: same client UUID never inserted twice
      return assertSuccess(sb.from('customers').upsert({ ...cleanData, user_id: ownerId }, { onConflict: 'id', ignoreDuplicates: true }));
    }
    case 'customer_delete': {
      if (!data.id) throw new Error('Missing customer id');
      return assertSuccess(sb.from('customers').delete().eq('id', String(data.id)));
    }
    case 'customer_update': {
      const { id, ...updates } = data;
      if (!id) throw new Error('Missing customer id');
      const cleanUpdates = filterTablePayload('customers', updates);
      return assertSuccess(sb.from('customers').update(cleanUpdates).eq('id', String(id)));
    }
    case 'sale': {
      if (data._operation === 'product_add') {
        const product = data.product;
        if (!product || typeof product !== 'object') throw new Error('Invalid offline product');
        const ownerId = await getOwnerIdForInsert();
        if (!ownerId) throw new Error('No owner id');
        const cleanProduct = filterTablePayload('products', product as Record<string, unknown>);
        return assertSuccess(
          sb.from('products').upsert({ ...cleanProduct, user_id: ownerId }, { onConflict: 'id' })
        );
      }
      if (data._operation === 'product_update') {
        if (!data.id || !data.updates || typeof data.updates !== 'object') throw new Error('Invalid product update');
        const cleanUpdates = filterTablePayload('products', data.updates as Record<string, unknown>);
        return assertSuccess(sb.from('products').update(cleanUpdates).eq('id', String(data.id)));
      }
      if (data._operation === 'product_delete') {
        if (!data.id) throw new Error('Missing product id for deletion');
        const { error } = await sb.rpc('hard_delete_product_atomic', { _product_id: String(data.id) });
        if (error) {
          if (error.message?.includes('not found') || (error as any).code === 'P0002') return true;
          throw error;
        }
        return true;
      }
      // ✅ العمليات القديمة (legacy) — تمريرها بدون حجب الطابور
      console.warn('[SyncProcessor] Legacy sale queue item skipped (auto-cleaned):', operation.id, data);
      return true;
    }
    case 'store_settings_update': {
      const { saveStoreSettingsDirect } = await import('@/lib/supabase-store');
      return saveStoreSettingsDirect(data as Record<string, unknown>);
    }
    case 'recurring_expense_create': {
      const ownerId = await getOwnerIdForInsert();
      if (!ownerId) throw new Error('No owner id');
      const cleanData = filterTablePayload('recurring_expenses', data);
      return assertSuccess(sb.from('recurring_expenses').upsert({ ...cleanData, user_id: ownerId }, { onConflict: 'id', ignoreDuplicates: true }));
    }
    case 'recurring_expense_update': {
      const { id, ...updates } = data;
      if (!id) throw new Error('Missing recurring expense id');
      const cleanUpdates = filterTablePayload('recurring_expenses', updates);
      return assertSuccess(sb.from('recurring_expenses').update(cleanUpdates).eq('id', String(id)));
    }
    case 'recurring_expense_delete': {
      if (!data.id) throw new Error('Missing recurring expense id');
      return assertSuccess(sb.from('recurring_expenses').delete().eq('id', String(data.id)));
    }
    case 'category_create': {
      const ownerId = await getOwnerIdForInsert();
      if (!ownerId) throw new Error('No owner id');
      const cleanData = filterTablePayload('categories', data);
      return assertSuccess(sb.from('categories').upsert({ ...cleanData, user_id: ownerId }, { onConflict: 'id', ignoreDuplicates: true }));
    }
    case 'category_update': {
      const { id, ...updates } = data;
      if (!id) throw new Error('Missing category id');
      const cleanUpdates = filterTablePayload('categories', updates);
      return assertSuccess(sb.from('categories').update(cleanUpdates).eq('id', String(id)));
    }
    case 'category_delete': {
      if (!data.id) throw new Error('Missing category id');
      return assertSuccess(sb.from('categories').delete().eq('id', String(data.id)));
    }
    case 'expense_reverse': {
      if (!data.id) throw new Error('Missing expense id');
      return assertSuccess(
        sb.from('expenses').update({
          is_reversed: true,
          reversed_at: String(data.reversed_at || new Date().toISOString()),
          reversed_reason: String(data.reason || 'تراجع بواسطة المستخدم'),
        }).eq('id', String(data.id))
      );
    }
    case 'maintenance_upsert': {
      const ownerId = await getOwnerIdForInsert();
      if (!ownerId) throw new Error('No owner id');
      const cleanData = filterTablePayload('maintenance_services', data);
      return assertSuccess(
        sb.from('maintenance_services').upsert({ ...cleanData, user_id: ownerId }, { onConflict: 'id' })
      );
    }
    case 'maintenance_delete': {
      if (!data.id) throw new Error('Missing maintenance service id');
      return assertSuccess(sb.from('maintenance_services').delete().eq('id', String(data.id)));
    }
    default:
      throw new Error(`Unsupported sync operation: ${operation.type}`);
  }
}