import { isLocalDataMode } from '@/hooks/use-network-status';
import { assertCurrencyUsable } from '../money-engine';
import { getPendingOperations } from '../sync-queue';
import { isOperationCancelled } from '../cancellation-registry';
// Cloud Debts Store - Supabase-backed debts management
import {
  fetchFromSupabase,
  updateInSupabase,
  deleteFromSupabase,
  getCurrentUserId,
  setCurrentUserId,
  isCashierUser
} from '../supabase-store';
import { emitEvent, EVENTS } from '../events';
import { isGuestDemoMode } from '../demo-data';
import { triggerAutoBackup } from '../local-auto-backup';
import { updateInvoiceCloud } from './invoices-cloud';
import { supabase } from '@/integrations/supabase/client';
import { addToQueue } from '../sync-queue';
import { round8 } from '../utils';
import { applyLocalDebtSettlement } from '../debt-settlement';
import { toLocalDateString, getLocalDayUtcRange } from '../date-utils';

import { submitManualDebt, ManualDebtRefusedError } from './manual-debt-rpc';
export { ManualDebtRefusedError };

const sb = supabase;
export type DebtStatus = 'due' | 'partially_paid' | 'overdue' | 'fully_paid';

export interface CloudDebt {
  id: string;
  user_id: string;
  invoice_id: string | null;
  customer_name: string;
  customer_phone: string | null;
  total_debt: number;
  total_paid: number;
  remaining_debt: number;
  due_date: string | null;
  status: string;
  notes: string | null;
  is_cash_debt: boolean;
  created_at: string;
  updated_at: string;
}

export interface Debt {
  pending_sync?: boolean;
  sync_failed?: boolean;
  customerId?: string;
  id: string;
  invoiceId: string;
  customerName: string;
  customerPhone: string;
  totalDebt: number;
  totalPaid: number;
  remainingDebt: number;
  dueDate: string;
  status: DebtStatus;
  createdAt: string;
  updatedAt: string;
  notes?: string;
  isCashDebt?: boolean;
  cashierId?: string;
  cashierName?: string;
  /** دين مشطوب كمعدوم: الحالة تُعرض «مسدد» لإغلاقه، وهذا الحقل يميّزه في التقارير */
  isWrittenOff?: boolean;
  /** المبلغ الذي شُطب (المتبقي لحظة الشطب) */
  writtenOffAmount?: number;
}

// Cache for cashier names
const cashierNamesCache: Record<string, string> = {};

// Transform cloud to legacy
function toDebt(cloud: CloudDebt & { cashier_name?: string }): Debt {
  const today = new Date().toISOString().split('T')[0];
  let status = cloud.status as DebtStatus;
  // الدين المشطوب أو الملغى مُغلق: لا يظهر كمتأخر أو مستحق
  const isClosed = (cloud.status as string) === 'written_off' || (cloud.status as string) === 'cancelled';
  if (isClosed) {
    status = 'fully_paid';
  }

  // Update status if overdue
  if (status !== 'fully_paid' && cloud.due_date && cloud.due_date < today) {
    status = 'overdue';
  }

  return {
    id: cloud.id,
    invoiceId: cloud.invoice_id || '',
    customerName: cloud.customer_name,
    customerPhone: cloud.customer_phone || '',
    totalDebt: Number(cloud.total_debt) || 0,
    totalPaid: Number(cloud.total_paid) || 0,
    remainingDebt: isClosed ? 0 : (Number(cloud.remaining_debt) || 0),
    isWrittenOff: (cloud.status as string) === 'written_off',
    writtenOffAmount: (cloud.status as string) === 'written_off' ? (Number(cloud.remaining_debt) || 0) : 0,
    dueDate: cloud.due_date || '',
    status,
    notes: cloud.notes || undefined,
    isCashDebt: cloud.is_cash_debt,
    createdAt: cloud.created_at,
    updatedAt: cloud.updated_at,
    cashierId: (cloud as { cashier_id?: string }).cashier_id || undefined,
    cashierName: cloud.cashier_name || cashierNamesCache[(cloud as { cashier_id?: string }).cashier_id || ''] || undefined,
  };
}

// Local storage cache helpers
const LOCAL_CACHE_KEY = 'posflow_debts_cache';

const saveDebtsLocally = (debts: Debt[]) => {
  try {
    localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(debts));
  } catch { /* ignore */ }
};

export const loadDebtsLocally = (): Debt[] | null => {
  try {
    const data = localStorage.getItem(LOCAL_CACHE_KEY);
    return data ? JSON.parse(data) : null;
  } catch { return null; }
};

// Cache
let debtsCache: Debt[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 30000;

// Generate manual debt ID
export const getNextManualDebtId = async (): Promise<string> => {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  const datePrefix = `DBT-${year}${month}${day}`;

  const debts = await loadDebtsCloud();

  // Count manual debts from today
  const todayDebts = debts.filter(d =>
    d.invoiceId && d.invoiceId.startsWith(datePrefix)
  );

  const nextNumber = todayDebts.length + 1;
  return `${datePrefix}-${String(nextNumber).padStart(3, '0')}`;
};

// Load debts
// ✅ Owners see all debts, cashiers see only their own
const fetchFresh_loadDebtsCloud = async (): Promise<Debt[]> => {
  if (isGuestDemoMode()) {
    const local = loadDebtsLocally() || [];
    debtsCache = local;
    return local;
  }
  // 1. Offline fast-path
  if (typeof navigator !== 'undefined' && isLocalDataMode()) {
    const local = loadDebtsLocally();
    if (local) {
      debtsCache = local;
      cacheTimestamp = Date.now();
      return mergeSyncQueueDebts(local);
    }
    return mergeSyncQueueDebts(debtsCache || []);
  }

  // 2. Safe userId retrieval using local session
  let userId = getCurrentUserId();
  if (!userId) {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user?.id) {
        userId = session.user.id;
        setCurrentUserId(session.user.id);
      }
    } catch { /* ignore */ }
  }

  if (!userId) {
    const local = loadDebtsLocally();
    return mergeSyncQueueDebts(local || debtsCache || []);
  }

  if (debtsCache && Date.now() - cacheTimestamp < CACHE_TTL) {
    return mergeSyncQueueDebts(debtsCache);
  }

  try {
    // Check if current user is a cashier
    const isCashier = await isCashierUser();

    let cloudDebts = await fetchFromSupabase<CloudDebt & { cashier_id?: string }>('debts', {
      column: 'created_at',
      ascending: false,
    });

    if (cloudDebts.length === 0) {
      const local = loadDebtsLocally();
      if (local && local.length > 0) {
        debtsCache = local;
        cacheTimestamp = Date.now();
        return debtsCache;
      }
    }

    // ✅ If cashier, filter to only show their own debts
    if (isCashier) {
      cloudDebts = cloudDebts.filter(d => d.cashier_id === userId);
    }

    // Fetch cashier names for debts with cashier_id safely
    const cashierIds = [...new Set(cloudDebts.filter(d => (d as { cashier_id?: string }).cashier_id).map(d => (d as { cashier_id: string }).cashier_id))];
    if (cashierIds.length > 0) {
      try {
        const { data: profiles } = await sb
          .from('profiles')
          .select('user_id, full_name')
          .in('user_id', cashierIds);

        if (profiles) {
          const nameMap: Record<string, string> = {};
          profiles.forEach((p: { user_id: string; full_name: string }) => {
            nameMap[p.user_id] = p.full_name;
            cashierNamesCache[p.user_id] = p.full_name;
          });

          cloudDebts = cloudDebts.map(d => ({
            ...d,
            cashier_name: (d as { cashier_id?: string }).cashier_id ? nameMap[(d as { cashier_id: string }).cashier_id] : undefined,
          }));
        }
      } catch (err) {
        console.warn('[debts-cloud] cashier names lookup failed:', err);
      }
    }

    debtsCache = cloudDebts.map(d => toDebt(d as CloudDebt & { cashier_name?: string }));
    cacheTimestamp = Date.now();
    saveDebtsLocally(debtsCache);

    return debtsCache;
  } catch (err) {
    console.warn('[debts-cloud] fetch failed, falling back to local cache:', err);
    const local = loadDebtsLocally();
    return local || debtsCache || [];
  }
};

// Local-first boot: first load after app start shows the saved copy instantly, refreshes silently
let debtsDirty = false;
let debtsBgInflight = false;
let lastDebtsBgAt = 0;
export const loadDebtsCloud = async (): Promise<Debt[]> => {
  // If offline, return immediately from local cache
  if (typeof navigator !== 'undefined' && isLocalDataMode()) {
    const local = loadDebtsLocally();
    if (local) {
      debtsCache = local;
      cacheTimestamp = Date.now();
      return mergeSyncQueueDebts(local);
    }
    return mergeSyncQueueDebts(debtsCache || []);
  }

  // Stale-while-revalidate (instant open on a weak network): the saved copy is shown at once and a fresh copy is fetched
  // in the background at most every CACHE_TTL. Right after an action on this device (invalidateDebtsCache) the fresh copy
  // is awaited instead, so a debt just paid never shows as still open.
  if (!debtsDirty) {
    const local = debtsCache ?? loadDebtsLocally();
    if (local && local.length > 0) {
      debtsCache = local;
      if (!isLocalDataMode() && !debtsBgInflight && Date.now() - lastDebtsBgAt >= CACHE_TTL) {
        debtsBgInflight = true;
        lastDebtsBgAt = Date.now();
        setTimeout(() => {
          cacheTimestamp = 0;
          fetchFresh_loadDebtsCloud()
            .then(() => emitEvent(EVENTS.DEBTS_UPDATED, null))
            .catch(() => {})
            .finally(() => { debtsBgInflight = false; });
        }, 0);
      }
      return mergeSyncQueueDebts(local);
    }
  }
  debtsDirty = false;
  return fetchFresh_loadDebtsCloud().then(mergeSyncQueueDebts);
};

export const invalidateDebtsCache = () => {
  debtsCache = null;
  cacheTimestamp = 0;
  debtsDirty = true; // the next load awaits the server (an action of this device just changed debts)
};

// Add debt
export const addDebtCloud = async (
  debtData: Omit<Debt, 'id' | 'createdAt' | 'updatedAt' | 'totalPaid' | 'remainingDebt' | 'status'>
): Promise<Debt | null> => {
  if (isGuestDemoMode()) {
    const today = new Date().toISOString().split('T')[0];
    const id = `demo_debt_${Date.now()}`;
    const nowIso = new Date().toISOString();
    const localDebt: Debt = {
      id,
      invoiceId: debtData.invoiceId || '',
      customerName: debtData.customerName,
      customerPhone: debtData.customerPhone || '',
      totalDebt: debtData.totalDebt,
      totalPaid: 0,
      remainingDebt: debtData.totalDebt,
      dueDate: debtData.dueDate || '',
      status: (debtData.dueDate && debtData.dueDate < today ? 'overdue' : 'due') as DebtStatus,
      notes: debtData.notes,
      isCashDebt: debtData.isCashDebt || false,
      createdAt: nowIso,
      updatedAt: nowIso,
      cashierId: 'guest-demo-user',
      cashierName: 'مستخدم تجريبي (Demo)',
    };
    const existing = debtsCache || loadDebtsLocally() || [];
    const list = [localDebt, ...existing.filter(d => d.id !== localDebt.id)];
    debtsCache = list;
    saveDebtsLocally(list);
    emitEvent(EVENTS.DEBTS_UPDATED, null);
    return localDebt;
  }
  const today = new Date().toISOString().split('T')[0];

  // ✅ جلب معرف المستخدم من المتغير أو مباشرة من supabase
  let cashierId = getCurrentUserId();
  if (!cashierId) {
    const { data: { user } } = await supabase.auth.getUser();
    cashierId = user?.id || null;
    console.log('[addDebtCloud] Fallback to supabase.auth.getUser:', cashierId);
  }

  const id = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  
  const payload = {
    id,
    invoice_id: debtData.invoiceId || null,
    customer_name: debtData.customerName,
    customer_phone: debtData.customerPhone || null,
    total_debt: debtData.totalDebt,
    total_paid: 0,
    remaining_debt: debtData.totalDebt,
    due_date: debtData.dueDate || null,
    status: debtData.dueDate && debtData.dueDate < today ? 'overdue' : 'due',
    notes: debtData.notes || null,
    is_cash_debt: debtData.isCashDebt || false,
    cashier_id: cashierId,
  };

  const localDebt = toDebt({ ...payload, user_id: '', created_at: nowIso, updated_at: nowIso } as CloudDebt);

  const saveToLocalAndQueue = () => {
    addToQueue('debt', payload, 10);
    const existing = debtsCache || loadDebtsLocally() || [];
    const list = [localDebt, ...existing.filter(d => d.id !== localDebt.id)];
    debtsCache = list;
    cacheTimestamp = Date.now();
    saveDebtsLocally(list);
    emitEvent(EVENTS.DEBTS_UPDATED, null);
    return localDebt;
  };

  if (isLocalDataMode()) {
    return saveToLocalAndQueue();
  }

  try {
    // F-25: the debt row is written by the atomic RPC (idempotent by the client id), never by a direct table insert.
    const inserted = await createManualDebtRpc(payload);

    if (inserted) {
      invalidateDebtsCache();
      emitEvent(EVENTS.DEBTS_UPDATED, null);
      triggerAutoBackup(`دين جديد: ${debtData.customerName}`);
      return toDebt(inserted);
    }
    
    // If inserted is null (e.g. server error), queue it locally
    return saveToLocalAndQueue();
  } catch (error) {
    if (error instanceof ManualDebtRefusedError) throw error; // shown to the user, never queued
    console.warn('[addDebtCloud] Exception, queueing locally:', error);
    return saveToLocalAndQueue();
  }
};

/** Calls create_manual_debt_atomic with the client payload (same id online and on queue replay). Exported for the queue processor. */
export async function createManualDebtRpc(payload: Record<string, unknown>): Promise<CloudDebt | null> {
  return submitManualDebt(supabase, payload);
}

// Add debt from invoice
export const addDebtFromInvoiceCloud = async (
  invoiceId: string,
  customerName: string,
  customerPhone: string,
  amount: number,
  dueDate?: string
): Promise<Debt | null> => {
  const defaultDueDate = new Date();
  defaultDueDate.setDate(defaultDueDate.getDate() + 30);

  return addDebtCloud({
    invoiceId,
    customerName,
    customerPhone,
    totalDebt: amount,
    dueDate: dueDate || defaultDueDate.toISOString().split('T')[0],
    isCashDebt: false,
  });
};

// Record payment — atomic on the server (debt + linked invoice updated together, idempotent)
export const recordPaymentCloud = async (
  debtId: string,
  amount: number,
  operationId?: string,
  currency: string = 'USD',
  currencyAmount?: number,
  exchangeRate?: number,
  method: 'cash' | 'transfer' = 'cash',
  shiftId?: string,
  creditUsd?: number
): Promise<Debt | null> => {
  const amt = round8(amount);
  if (amt <= 0) throw new Error('أدخل مبلغًا صحيحًا أكبر من الصفر');
  if (isGuestDemoMode()) {
    const debts = debtsCache || loadDebtsLocally() || [];
    const target = debts.find(d => d.id === debtId);
    if (!target) throw new Error('الدين غير موجود');
    const updatedDebt: Debt = {
      ...target,
      ...applyLocalDebtSettlement(target, creditUsd ?? amt),
      updatedAt: new Date().toISOString(),
    };
    const list = debts.map(d => d.id === debtId ? updatedDebt : d);
    debtsCache = list;
    saveDebtsLocally(list);
    emitEvent(EVENTS.DEBTS_UPDATED, null);
    emitEvent(EVENTS.INVOICES_UPDATED, null);
    return updatedDebt;
  }
  const opId = operationId || `debtpay_${debtId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // حركة الصندوق سحابياً تُسجَّلها الدالة الذرية record_debt_payment_atomic داخل نفس المعاملة
  // (وتحدّث expected_balance وتفصل فرق التقريب). الحالة المحلية للوردية تحدَّثها الواجهة عبر processDebtPayment.
  const resolveCashShiftId = async (): Promise<string | null> => {
    if (method !== 'cash') return null; // التحويل البنكي لا يدخل الصندوق النقدي
    if (shiftId) return shiftId;
    const { getCashDrawerId } = await import('../cashbox-store');
    return getCashDrawerId();
  };

  const cashShiftId = await resolveCashShiftId();
  if (method === 'cash' && !cashShiftId) throw new Error('قبض دفعة نقدية يتطلب وردية أصلية مفتوحة');

  const queuePayment = (): Debt | null => {
    // الحالة المحلية فقط؛ الحركة السحابية تُسجَّل عند المزامنة عبر الدالة الذرية
    const list = (debtsCache || loadDebtsLocally() || []).map(d => {
      if (d.id !== debtId) return d;
      // F-27: a foreign-currency payment is credited at the invoice rate (creditUsd), not at the cash value
      return { ...d, ...applyLocalDebtSettlement(d, creditUsd ?? amt) };
    });
    addToQueue('debt_payment', { debtId, amount: amt, operationId: opId, currency, currencyAmount, exchangeRate, method, shiftId: cashShiftId }, 10);
    debtsCache = list; cacheTimestamp = Date.now(); saveDebtsLocally(list);
    emitEvent(EVENTS.DEBTS_UPDATED, null);
    return list.find(d => d.id === debtId) || null;
  };
  assertCurrencyUsable(currency); // F-05: refuse a currency that is not set up instead of converting at rate 1
  if (isLocalDataMode()) return queuePayment();
  const { data, error } = await sb.rpc('record_debt_payment_atomic', {
    _debt_id: debtId,
    _amount: amt,
    _operation_id: opId,
    _shift_id: cashShiftId,
    _currency: currency,
    _currency_amount: currencyAmount ?? null,
    _exchange_rate: exchangeRate ?? null,
    _payment_method: method,
  });
  const { logDirectSync } = await import('../sync-history');
  const payLabel = `سداد دين ${currency !== 'USD' && currencyAmount ? `${currencyAmount} ${currency}` : `${amt} USD`}`;
  if (error) {
    logDirectSync(`direct-${opId}`, 'debt_payment', payLabel, false, error.message, undefined, 'debt');
    throw new Error(error.message || 'فشل تسجيل الدفعة');
  }
  logDirectSync(`direct-${opId}`, 'debt_payment', payLabel, true, undefined, undefined, 'debt');
  const res = (data || {}) as Record<string, unknown>;
  invalidateDebtsCache();
  import('./partners-cloud').then(({ invalidatePartnersCache }) => {
    invalidatePartnersCache();
  }).catch(() => {});
  emitEvent(EVENTS.DEBTS_UPDATED, null);
  emitEvent(EVENTS.INVOICES_UPDATED, null);
  emitEvent(EVENTS.PARTNERS_UPDATED, null);
  const debts = await loadDebtsCloud();
  const fresh = debts.find(d => d.id === debtId);
  if (fresh?.customerId) {
    import('./customers-cloud').then(({ updateCustomerStatsCloud }) => {
      updateCustomerStatsCloud(fresh.customerId!).catch(() => {});
    });
  }



  if (fresh) return fresh;
  return {
    id: debtId,
    totalDebt: Number(res.total_debt) || 0,
    totalPaid: Number(res.total_paid) || 0,
    remainingDebt: Number(res.remaining_debt) || 0,
    status: (res.status as DebtStatus) || 'due',
  } as Debt;
};

// Kept for existing callers — the server now syncs the invoice itself
export const recordPaymentWithInvoiceSyncCloud = async (
  debtId: string,
  amount: number,
  operationId?: string,
  currency: string = 'USD',
  currencyAmount?: number,
  exchangeRate?: number,
  method: 'cash' | 'transfer' = 'cash',
  shiftId?: string,
  creditUsd?: number
): Promise<Debt | null> => recordPaymentCloud(debtId, amount, operationId, currency, currencyAmount, exchangeRate, method, shiftId, creditUsd);

/**
 * F-27 / KD-01: the FX policy for paying `debt` in `paymentCurrency`, from its invoice's rate snapshot.
 * null = legacy behaviour (credit = cash). Never throws: if the invoice cannot be read the legacy path stays in force
 * and the server (the authority) applies the policy itself.
 */
export const resolveDebtFxPolicyCloud = async (
  debt: Pick<Debt, 'invoiceId' | 'isCashDebt'>,
  paymentCurrency: string
): Promise<import('../debt-fx').DebtFxPolicy | null> => {
  try {
    if (!debt.invoiceId || debt.isCashDebt || String(paymentCurrency).toUpperCase() === 'USD') return null;
    const { getInvoiceByIdCloud } = await import('./invoices-cloud');
    const { resolveDebtFxPolicy } = await import('../debt-fx');
    const invoice = await getInvoiceByIdCloud(debt.invoiceId);
    return resolveDebtFxPolicy(invoice ? { currency: invoice.currency, exchangeRate: invoice.exchangeRate } : null, paymentCurrency, false);
  } catch (err) {
    console.warn('[debts-cloud] FX policy lookup failed, using legacy crediting:', err);
    return null;
  }
};

export type InvoiceDebtLookup =
  | { status: 'found'; debt: Debt }
  | { status: 'none' }
  | { status: 'unreachable' };

/**
 * يبحث في الخادم عن دين فاتورة قبل إنشاء دين جديد لها.
 * دالة البيع في الخادم تُنشئ دين الفاتورة الآجلة، فإنشاء دين ثانٍ من الواجهة يسجّل الدين مرتين.
 * 'unreachable' = تعذّر السؤال (بلا إنترنت أو خطأ): لا يجوز الإنشاء في هذه الحالة.
 */
export const findInvoiceDebtOnServer = async (invoiceId: string): Promise<InvoiceDebtLookup> => {
  if (!invoiceId || isGuestDemoMode() || isLocalDataMode()) return { status: 'unreachable' };
  try {
    const { data, error } = await sb
      .from('debts')
      .select('*')
      .eq('invoice_id', invoiceId)
      .order('created_at', { ascending: true });
    if (error) return { status: 'unreachable' };
    const rows = (data || []) as CloudDebt[];
    if (rows.length === 0) return { status: 'none' };
    // الأقدم هو الدين الذي أنشأته دالة البيع؛ يُفضَّل ما زال عليه رصيد
    const open = rows.find(r => (Number(r.remaining_debt) || 0) > 0);
    return { status: 'found', debt: toDebt(open || rows[0]) };
  } catch {
    return { status: 'unreachable' };
  }
};

// The server locks the invoice and posts its exact outstanding cash balance once.
export const settleDebtsByInvoiceIdCloud = async (invoiceId: string): Promise<number> => {
  const { getCashDrawerId } = await import('../cashbox-store');
  const shiftId = (getCashDrawerId() ?? undefined);
  if (!shiftId) throw new Error('قبض دفعة نقدية يتطلب وردية أصلية مفتوحة');
  const { data, error } = await sb.rpc('settle_invoice_debts_atomic', {
    _invoice_number: invoiceId,
    _shift_id: shiftId,
    _operation_id: crypto.randomUUID(),
  });
  if (error) throw new Error(error.message || 'فشل تسجيل الدفعة');
  invalidateDebtsCache();
  void import('./partners-cloud').then(m => m.invalidatePartnersCache()).catch(() => {});
  emitEvent(EVENTS.DEBTS_UPDATED, null);
  emitEvent(EVENTS.INVOICES_UPDATED, null);
  emitEvent(EVENTS.PARTNERS_UPDATED, null);
  emitEvent(EVENTS.CUSTOMERS_UPDATED, null);
  return Number(data);
};

// Delete / Cancel debt by ID ذرياً — عبر cancel_debt_atomic
export const deleteDebtCloud = async (debtId: string, reason = 'إلغاء الدين'): Promise<boolean> => {
  if (isGuestDemoMode()) {
    const currentList = (debtsCache || loadDebtsLocally() || []).filter(d => d.id !== debtId);
    debtsCache = currentList;
    saveDebtsLocally(currentList);
    emitEvent(EVENTS.DEBTS_UPDATED, null);
    return true;
  }

  try {
    const { error } = await sb.rpc('cancel_debt_atomic', {
      _debt_id: debtId,
      _reason: reason,
    });
    if (error) {
      // لا حذف احتياطي من الواجهة: الحذف المباشر كان يترك الفاتورة وأرباح الشركاء معلقة
      console.warn('[deleteDebtCloud] cancel_debt_atomic failed:', error);
      throw new Error(error.message || 'تعذر إلغاء الدين');
    }

    invalidateDebtsCache();
    emitEvent(EVENTS.DEBTS_UPDATED, null);
    emitEvent(EVENTS.CUSTOMERS_UPDATED, null);
    emitEvent(EVENTS.INVOICES_UPDATED, null);
    return true;
  } catch (err) {
    console.error('Error deleting/cancelling debt:', err);
    return false;
  }
};

/**
 * إتلاف / شطب الدين ذرياً عبر الخادم (writeoff_debt_atomic)
 * 1. تسجيل إتلاف الدين في debt_writeoffs
 * 2. تسجيل مصروف في expenses يخصم من رأس المال
 * 3. تحديث الدين كـ "fully_paid" مع توثيق السبب
 * 4. خفض مديونية العميل في customers
 * 5. عكس أرباح الشركاء المعلقة
 */
export const writeOffDebtCloud = async (
  debtId: string,
  reason: string
): Promise<boolean> => {
  if (isGuestDemoMode()) {
    const debts = loadDebtsLocally();
    const updated = debts.map(d => d.id === debtId ? { ...d, status: 'fully_paid' as const, remainingDebt: 0, notes: `${d.notes || ''}\n[إتلاف دين] ${reason}`.trim() } : d);
    saveDebtsLocally(updated);
    debtsCache = updated;
    emitEvent(EVENTS.DEBTS_UPDATED, null);
    return true;
  }

  const debts = await loadDebtsCloud();
  const debt = debts.find(d => d.id === debtId);
  if (!debt) return false;

  const operationId = `writeoff_${debtId}_${Date.now()}`;

  try {
    // 1. استدعاء الدالة الذرية السحابية لشطب الدين
    const { error } = await sb.rpc('writeoff_debt_atomic', {
      _debt_id: debtId,
      _reason: reason,
      _operation_id: operationId,
    });

    if (error) {
      // رفض الصلاحية (الشطب لمالك المتجر فقط) نهائي: لا يوضع في الطابور
      if ((error as { code?: string }).code === '42501') {
        console.warn('[writeOffDebtCloud] Not permitted:', error.message);
        return false;
      }
      console.warn('[writeOffDebtCloud] RPC failed, queuing for sync:', error);
      addToQueue('debt_writeoff', { debtId, reason, operationId });
    }

    // حصص الشركاء المعلّقة تعالجها دالة الشطب في الخادم داخل المعاملة نفسها؛ لا استدعاء من الواجهة

    invalidateDebtsCache();
    try {
      const { invalidatePartnersCache } = await import('./partners-cloud');
      invalidatePartnersCache();
    } catch { /* ignore */ }
    emitEvent(EVENTS.DEBTS_UPDATED, null);
    emitEvent(EVENTS.CUSTOMERS_UPDATED, null);
    emitEvent(EVENTS.EXPENSES_UPDATED, null);
    emitEvent(EVENTS.PARTNERS_UPDATED, null);
    return true;
  } catch (error) {
    console.error('Error in writeOffDebtCloud:', error);
    try {
      addToQueue('debt_writeoff', { debtId, reason, operationId });
      invalidateDebtsCache();
      emitEvent(EVENTS.DEBTS_UPDATED, null);
      return true;
    } catch {
      return false;
    }
  }
};

export const getDebtsStatsCloud = async () => {
  const debts = await loadDebtsCloud();
  return {
    total: debts.reduce((sum, d) => sum + d.totalDebt, 0),
    remaining: debts.reduce((sum, d) => sum + d.remainingDebt, 0),
    paid: debts.reduce((sum, d) => sum + d.totalPaid, 0),
    overdue: debts.filter(d => d.status === 'overdue').reduce((sum, d) => sum + d.remainingDebt, 0),
    count: debts.length,
    activeCount: debts.filter(d => d.status !== 'fully_paid').length,
  };
};

function mergeSyncQueueDebts(debts) {
  const pending = getPendingOperations();
  const queueDebts = [];
  for (const op of pending) {
    if (op.type === 'debt_sale_bundle') {
      const opKey = String(op.data.operationId || op.data.localId || op.data.uniqueKey || op.id);
      const bInv = (op.data?.bundle as { invoiceNumber?: string } | undefined)?.invoiceNumber || op.data?.invoiceNumber;
      if (isOperationCancelled(opKey) || (bInv && isOperationCancelled(String(bInv)))) {
        continue;
      }
      const data = op.data as Record<string, unknown>;
      // The queued bundle fields this replay reads; values are passed through as the original code did.
      const bundle = (data?.bundle || {}) as {
        total?: number; downPayment?: number; customerId?: string; customerName?: string; customerPhone?: string; dueDate?: string;
      };
      const remaining = (bundle.total || 0) - (bundle.downPayment || 0);
      if (remaining <= 0) continue;
      queueDebts.push({
        id: op.data.operationId || op.data.localId || op.id,
        invoiceId: op.data.operationId || op.data.localId || op.id,
        customerId: bundle.customerId,
        customerName: bundle.customerName || 'عميل',
        customerPhone: bundle.customerPhone || '',
        totalDebt: bundle.total || 0,
        totalPaid: bundle.downPayment || 0,
        remainingDebt: remaining,
        dueDate: bundle.dueDate || new Date().toISOString(),
        status: 'pending',
        createdAt: op.timestamp || op.createdAt || new Date().toISOString(),
        updatedAt: op.timestamp || op.createdAt || new Date().toISOString(),
        pending_sync: true,
        sync_failed: op.status === 'failed',
        isCashDebt: false,
      });
    }
  }
  const existingIds = new Set(debts.map(d => d.invoiceId));
  const uniqueQueue = queueDebts.filter(qd => !existingIds.has(qd.invoiceId));
  return [...uniqueQueue, ...debts];
}

/**
 * جلب مجموع تسديدات الديون الفعلية لتاريخ محدد (YYYY-MM-DD)
 * يضمن دقة إقفال اليوم وعدم الخلط بين الديون المنشأة والمسددة
 */
export const loadDebtPaymentsForDate = async (dateStr: string): Promise<number> => {
  if (!dateStr) return 0;
  let total = 0;
  let foundInCloud = false;

  const { startIso, endIso } = getLocalDayUtcRange(dateStr);

  // 1. Try Supabase debt_payments table
  if (!isLocalDataMode()) {
    try {
      const { data, error } = await sb
        .from('debt_payments')
        .select('amount, created_at')
        .gte('created_at', startIso)
        .lte('created_at', endIso);

      if (!error && data && data.length > 0) {
        total = data.reduce((s, p) => s + Number(p.amount || 0), 0);
        foundInCloud = true;
      }
    } catch (e) {
      console.warn('[loadDebtPaymentsForDate] cloud fetch failed:', e);
    }
  }

  // 2. Fallback: shift_transactions with type === 'debt_payment'
  if (!foundInCloud && !isLocalDataMode()) {
    try {
      const { data: shiftTx, error } = await sb
        .from('shift_transactions')
        .select('amount, created_at')
        .eq('type', 'debt_payment')
        .gte('created_at', startIso)
        .lte('created_at', endIso);

      if (!error && shiftTx && shiftTx.length > 0) {
        return round8(shiftTx.reduce((s, tx) => s + Number(tx.amount || 0), 0));
      }
    } catch { /* silent */ }
  }

  // 3. Fallback locally from activity log
  try {
    const { loadActivityLogs: getActivityLogs } = await import('@/lib/activity-log');
    const logs = getActivityLogs();
    const dayLogs = logs.filter(l => 
      (l.type === 'debt_payment' || l.type === 'debt_paid') &&
      toLocalDateString(l.timestamp) === dateStr
    );
    if (dayLogs.length > 0) {
      const localTotal = dayLogs.reduce((s, l) => s + Number((l.details as { amount?: unknown } | undefined)?.amount || 0), 0);
      if (localTotal > 0 && !foundInCloud) {
        return round8(localTotal);
      }
    }
  } catch { /* silent */ }

  return round8(total);
};


/** Non-USD currencies the payments of an invoice's debt were collected in (for the share note, no rates). Empty on error/offline. */
export const loadInvoicePaymentCurrencies = async (invoiceId: string): Promise<string[]> => {
  if (!invoiceId || isLocalDataMode()) return [];
  try {
    const { data: debts } = await supabase.from('debts').select('id').eq('invoice_id', invoiceId).limit(5);
    const ids = (debts || []).map(d => d.id);
    if (ids.length === 0) return [];
    const { data: pays } = await supabase.from('debt_payments').select('currency').in('debt_id', ids);
    return Array.from(new Set((pays || []).map(p => String(p.currency || 'USD')).filter(c => c && c !== 'USD')));
  } catch {
    return [];
  }
};
