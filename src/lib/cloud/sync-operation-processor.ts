import { supabase } from '@/integrations/supabase/client';
import type { Database } from '@/integrations/supabase/types';
import type { QueuedOperation } from '@/lib/sync-queue';
import { filterTablePayload, getOwnerIdForInsert } from '@/lib/supabase-store';
import { invalidatePartnersCache } from './partners-cloud';
import { writeShiftTransactionRow } from './cashbox-cloud';

const sb = supabase;

type Tables = Database['public']['Tables'];
type RpcArgs<F extends keyof Database['public']['Functions']> = Database['public']['Functions'][F]['Args'];

// Queued payloads are untyped JSON that filterTablePayload has already reduced to the table's known columns,
// so these two helpers are the single place where the queue's data is read as a typed table row.
const asInsert = <T extends keyof Tables>(row: Record<string, unknown>) => row as unknown as Tables[T]['Insert'];
const asUpdate = <T extends keyof Tables>(row: Record<string, unknown>) => row as unknown as Tables[T]['Update'];

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

// A queued shift open that the server refuses (a shift is already open for this cashier) must not retry forever:
// the operation is treated as handled and the local copy is dropped, so the device adopts the server's open shift.
async function dropRejectedShiftOpen(shiftId: string, error: unknown): Promise<boolean> {
  const { isShiftAlreadyOpenError } = await import('../shift-adopt');
  if (!isShiftAlreadyOpenError(error)) throw error;
  try {
    const { dropLocalShift } = await import('../cashbox-store');
    if (shiftId) dropLocalShift(shiftId);
  } catch { /* best-effort */ }
  return true;
}

// A refusal because the operation's shift is closed (text of the server messages in add_expense_atomic and friends).
export function isClosedShiftRefusal(message: string | undefined | null): boolean {
  return /الوردية[^\n]*مغلقة/.test(String(message || ''));
}

function notifyClosedShiftPending(what: string): void {
  import('@/hooks/use-smart-toast').then(({ showSmartToast }) => showSmartToast({
    type: 'warning',
    title: `${what} معلّق: ورديته أُغلقت قبل المزامنة`,
    description: 'لم يُرحَّل إلى وردية أخرى ولم يُسجَّل تلقائيًا. راجعه في العمليات المعلقة وطابقه يدويًا.',
  } as never)).catch(() => {});
}

export async function processGenericQueuedOperation(operation: QueuedOperation): Promise<boolean> {
  const data = operation.data;

  switch (operation.type) {
    case 'profit_record': {
      const cleanData = filterTablePayload('profit_records', data);
      return assertSuccess(sb.from('profit_records').insert(asInsert<'profit_records'>(cleanData)));
    }
    case 'profit_snapshot': {
      if (!data.invoiceId) throw new Error('Missing invoice for profit snapshot');
      const { error } = await (sb.rpc as unknown as (f: string, a: Record<string, unknown>) => Promise<{ error: { message?: string } | null }>)(
        'record_sale_profit_snapshot', { _invoice_number: String(data.invoiceId) });
      if (error) throw new Error(error.message || 'فشل تسجيل ربح الفاتورة');
      return true;
    }
    case 'profit_reverse':
      return assertSuccess(sb.from('profit_records').update({
        is_reversed: true,
        reversed_at: new Date().toISOString(),
      }).eq('invoice_id', String(data.invoiceId || '')).eq('is_reversed', false));
    case 'shift_open':
    case 'cash_shift_upsert': {
      // W-2: opened through open_cash_shift_atomic (same id, idempotent); "already open" is dropped as before.
      const { openShiftFromPayload } = await import('./cashbox-cloud');
      try {
        await openShiftFromPayload(data as Record<string, unknown>);
        return true;
      } catch (e) {
        return dropRejectedShiftOpen(String(data.id ?? ''), e);
      }
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
        _decision: data.decision === 'defer' ? 'defer' : 'accept',
        _counts: Array.isArray(data.counts) && data.counts.length > 0 ? data.counts : null,
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
      // نوع قديم: لا إدخال مباشر على جدول expenses. يمرّ عبر الدالة الذرية (قفل الفترة، حصص الشركاء، منع التكرار).
      const amount = Number(data.amount);
      if (!(amount > 0)) throw new Error('Invalid legacy expense operation');
      const { error } = await sb.rpc('add_expense_atomic', {
        _operation_id: String(data.id || data.operationId || operation.id),
        _expense_type: String(data.expense_type || data.type || 'other'),
        _amount: amount,
        _description: (data.description as string | undefined) ?? null,
        ...(data.date ? { _date: String(data.date) } : {}),
        _notes: (data.notes as string | undefined) ?? null,
        ...(data.original_currency ? {
          _original_currency: String(data.original_currency),
          _original_amount: data.original_amount != null ? Number(data.original_amount) : null,
          _exchange_rate: data.exchange_rate != null ? Number(data.exchange_rate) : null,
        } : {}),
      });
      if (error) throw new Error(error.message);
      return true;
    }
    case 'debt': {
      // F-25: replay through the atomic RPC with the same client id (idempotent), never a direct insert into debts.
      if (!data.id) throw new Error('دين مؤجل بلا معرّف. يلزم مطابقته يدويًا.');
      const { createManualDebtRpc } = await import('./debts-cloud');
      await createManualDebtRpc(data as Record<string, unknown>);
      return true;
    }
    case 'expense_atomic': {
      const { uniqueKey: _u, ...args } = data;
      const { error } = await sb.rpc('add_expense_atomic', args as unknown as RpcArgs<'add_expense_atomic'>);
      if (error && args._shift_id && isClosedShiftRefusal(error.message)) {
        // F-20: the drawer shift was closed before this offline expense synced. It is NOT moved to another drawer and NOT
        // recorded without a drawer on its own: it stays pending (same operation id) for the owner's manual reconciliation.
        notifyClosedShiftPending('مصروف');
        throw new Error('مصروف مؤجل وورديته أُغلقت قبل المزامنة. يبقى معلقًا للمطابقة اليدوية من المالك (F-20).');
      }
      if (error) throw new Error(error.message);
      return true;
    }
    case 'debt_payment': {
      if (!data.debtId || !data.operationId) throw new Error('Invalid debt payment');
      // استخدام الوردية المحفوظة وقت الدفع أولاً، وإلا الوردية المفتوحة الحالية عند المزامنة. التحويل البنكي لا يدخل الصندوق.
      const paymentMethod = data.method === 'transfer' ? 'transfer' : 'cash';
      let replayShiftId: string | null = null;
      if (paymentMethod === 'cash') {
        if (typeof data.shiftId === 'string' && data.shiftId.trim().length > 0) {
          replayShiftId = data.shiftId.trim();
        } else {
          throw new Error('دفعة نقدية مؤجلة بلا وردية أصلية. يلزم مطابقتها قبل ترحيلها.');
        }
      }
      const { error } = await sb.rpc('record_debt_payment_atomic', {
        _debt_id: String(data.debtId),
        _amount: Number(data.amount),
        _operation_id: String(data.operationId),
        _shift_id: replayShiftId,
        _currency: data.currency ? String(data.currency) : 'USD',
        _currency_amount: data.currencyAmount != null ? Number(data.currencyAmount) : null,
        _exchange_rate: data.exchangeRate != null ? Number(data.exchangeRate) : null,
        _payment_method: paymentMethod,
      });
      if (error) throw new Error(error.message);
      return true;
    }
    case 'store_credit_op': {
      // Replays the user's store-credit action with its ORIGINAL operation id: the server returns the first result for a repeated id.
      const { creditRpcCall } = await import('../store-credit-op');
      const call = creditRpcCall(data as unknown as import('../store-credit-op').CreditOpData);
      const { error } = await (sb.rpc as unknown as (f: string, a: Record<string, unknown>) => Promise<{ error: { message?: string } | null }>)(call.fn, call.args);
      if (error) throw new Error(error.message || 'فشلت عملية رصيد العميل');
      return true;
    }
    case 'partner_withdrawal': {
      if (!data.partnerId || !data.operationId) throw new Error('Invalid partner withdrawal');
      // _operation_id يمنع تكرار السحب إن أُعيدت المحاولة (الخادم يرد already_processed)
      const { data: wRes, error } = await sb.rpc('partner_withdrawal_atomic', {
        _partner_id: String(data.partnerId),
        _amount: Number(data.amount),
        _withdrawal_type: String(data.withdrawalType),
        _notes: (data.notes as string | undefined) ?? null,
        _shift_id: typeof data.shiftId === 'string' && data.shiftId.trim().length > 0 ? data.shiftId.trim() : null,
        _currency: data.currency ? String(data.currency) : 'USD',
        _original_amount: data.originalAmount != null ? Number(data.originalAmount) : null,
        _exchange_rate: data.exchangeRate != null ? Number(data.exchangeRate) : null,
        _operation_id: String(data.operationId),
      });
      if (error) throw new Error(error.message);
      const wr = (wRes || {}) as { success?: boolean; error?: string; message?: string };
      if (!wr.success) throw new Error(wr.error || wr.message || 'رفض الخادم عملية السحب');
      invalidatePartnersCache();
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
      return assertSuccess(sb.from('customers').upsert(asInsert<'customers'>({ ...cleanData, user_id: ownerId }), { onConflict: 'id', ignoreDuplicates: true }));
    }
    case 'customer_delete': {
      if (!data.id) throw new Error('Missing customer id');
      return assertSuccess(sb.from('customers').delete().eq('id', String(data.id)));
    }
    case 'customer_update': {
      const { id, ...updates } = data;
      if (!id) throw new Error('Missing customer id');
      const cleanUpdates = filterTablePayload('customers', updates);
      return assertSuccess(sb.from('customers').update(asUpdate<'customers'>(cleanUpdates)).eq('id', String(id)));
    }
    case 'sale': {
      if (data._operation === 'product_add') {
        const product = data.product;
        if (!product || typeof product !== 'object') throw new Error('Invalid offline product');
        const ownerId = await getOwnerIdForInsert();
        if (!ownerId) throw new Error('No owner id');
        const cleanProduct = filterTablePayload('products', product as Record<string, unknown>);
        return assertSuccess(
          sb.from('products').upsert(asInsert<'products'>({ ...cleanProduct, user_id: ownerId }), { onConflict: 'id' })
        );
      }
      if (data._operation === 'product_update') {
        if (!data.id || !data.updates || typeof data.updates !== 'object') throw new Error('Invalid product update');
        const cleanUpdates = filterTablePayload('products', data.updates as Record<string, unknown>);
        return assertSuccess(sb.from('products').update(asUpdate<'products'>(cleanUpdates)).eq('id', String(data.id)));
      }
      if (data._operation === 'product_delete') {
        if (!data.id) throw new Error('Missing product id for deletion');
        const { error } = await sb.rpc('hard_delete_product_atomic', { _product_id: String(data.id) });
        if (error) {
          if (error.message?.includes('not found') || (error as typeof error & { code?: string }).code === 'P0002') return true;
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
      return assertSuccess(sb.from('recurring_expenses').upsert(asInsert<'recurring_expenses'>({ ...cleanData, user_id: ownerId }), { onConflict: 'id', ignoreDuplicates: true }));
    }
    case 'recurring_expense_update': {
      const { id, ...updates } = data;
      if (!id) throw new Error('Missing recurring expense id');
      const cleanUpdates = filterTablePayload('recurring_expenses', updates);
      return assertSuccess(sb.from('recurring_expenses').update(asUpdate<'recurring_expenses'>(cleanUpdates)).eq('id', String(id)));
    }
    case 'recurring_expense_delete': {
      if (!data.id) throw new Error('Missing recurring expense id');
      return assertSuccess(sb.from('recurring_expenses').delete().eq('id', String(data.id)));
    }
    case 'category_create': {
      const ownerId = await getOwnerIdForInsert();
      if (!ownerId) throw new Error('No owner id');
      const cleanData = filterTablePayload('categories', data);
      return assertSuccess(sb.from('categories').upsert(asInsert<'categories'>({ ...cleanData, user_id: ownerId }), { onConflict: 'id', ignoreDuplicates: true }));
    }
    case 'category_update': {
      const { id, ...updates } = data;
      if (!id) throw new Error('Missing category id');
      const cleanUpdates = filterTablePayload('categories', updates);
      return assertSuccess(sb.from('categories').update(asUpdate<'categories'>(cleanUpdates)).eq('id', String(id)));
    }
    case 'category_delete': {
      if (!data.id) throw new Error('Missing category id');
      return assertSuccess(sb.from('categories').delete().eq('id', String(data.id)));
    }
    case 'expense_reverse': {
      if (!data.id) throw new Error('Missing expense id');
      const { data: revResult, error } = await sb.rpc('delete_expense_atomic', {
        _expense_id: String(data.id),
        _reason: String(data.reason || 'تراجع بواسطة المستخدم'),
        _shift_id: typeof data.shiftId === 'string' && data.shiftId.trim().length > 0 ? data.shiftId.trim() : null,
      });
      if (error) throw new Error(error.message);
      const serverResult = (revResult || {}) as { success?: boolean; error?: string };
      if (!serverResult.success) {
        throw new Error(serverResult.error || 'رفض الخادم التراجع عن المصروف');
      }
      invalidatePartnersCache();
      return true;
    }
    case 'maintenance_upsert': {
      const ownerId = await getOwnerIdForInsert();
      if (!ownerId) throw new Error('No owner id');
      const cleanData = filterTablePayload('maintenance_services', data);
      return assertSuccess(
        sb.from('maintenance_services').upsert(asInsert<'maintenance_services'>({ ...cleanData, user_id: ownerId }), { onConflict: 'id' })
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
