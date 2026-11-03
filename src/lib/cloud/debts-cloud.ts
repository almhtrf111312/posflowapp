import { getPendingOperations } from '../sync-queue';
import { isOperationCancelled } from '../cancellation-registry';
// Cloud Debts Store - Supabase-backed debts management
import {
  fetchFromSupabase,
  insertToSupabase,
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

import type { SupabaseClient } from '@supabase/supabase-js';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseSupabase = SupabaseClient<any, 'public', any>;
const sb = supabase as unknown as LooseSupabase;
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
}

// Cache for cashier names
const cashierNamesCache: Record<string, string> = {};

// Transform cloud to legacy
function toDebt(cloud: CloudDebt & { cashier_name?: string }): Debt {
  const today = new Date().toISOString().split('T')[0];
  let status = cloud.status as DebtStatus;

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
    remainingDebt: Number(cloud.remaining_debt) || 0,
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
const LOCAL_CACHE_KEY = 'hyperpos_debts_cache';

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
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
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
let bootServed_loadDebtsCloud = false;
export const loadDebtsCloud = async (): Promise<Debt[]> => {
  // If offline, return immediately from local cache
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    const local = loadDebtsLocally();
    if (local) {
      debtsCache = local;
      cacheTimestamp = Date.now();
      return mergeSyncQueueDebts(local);
    }
    return mergeSyncQueueDebts(debtsCache || []);
  }

  if (!bootServed_loadDebtsCloud) {
    bootServed_loadDebtsCloud = true;
    const local = loadDebtsLocally();
    if (local && local.length > 0) {
      debtsCache = local;
      cacheTimestamp = Date.now();
      if (navigator.onLine) {
        setTimeout(() => {
          debtsCache = null;
          cacheTimestamp = 0;
          fetchFresh_loadDebtsCloud().then(() => emitEvent(EVENTS.DEBTS_UPDATED, null)).catch(() => {});
        }, 0);
      }
      return mergeSyncQueueDebts(local);
    }
  }
  return fetchFresh_loadDebtsCloud().then(mergeSyncQueueDebts);
};

export const invalidateDebtsCache = () => {
  debtsCache = null;
  cacheTimestamp = 0;
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

  if (!navigator.onLine) {
    return saveToLocalAndQueue();
  }

  try {
    const inserted = await insertToSupabase<CloudDebt>('debts', payload);

    if (inserted) {
      invalidateDebtsCache();
      emitEvent(EVENTS.DEBTS_UPDATED, null);
      triggerAutoBackup(`دين جديد: ${debtData.customerName}`);
      return toDebt(inserted);
    }
    
    // If inserted is null (e.g. server error), queue it locally
    return saveToLocalAndQueue();
  } catch (error) {
    console.warn('[addDebtCloud] Exception, queueing locally:', error);
    return saveToLocalAndQueue();
  }
};

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
  method: 'cash' | 'transfer' = 'cash'
): Promise<Debt | null> => {
  if (isGuestDemoMode()) {
    const debts = debtsCache || loadDebtsLocally() || [];
    const target = debts.find(d => d.id === debtId);
    if (!target) throw new Error('الدين غير موجود');
    const newPaid = Math.min(target.totalDebt, round8((target.totalPaid || 0) + amount));
    const newRemaining = Math.max(0, round8(target.totalDebt - newPaid));
    const newStatus: DebtStatus = newRemaining === 0 ? 'fully_paid' : 'partially_paid';
    const updatedDebt: Debt = {
      ...target,
      totalPaid: newPaid,
      remainingDebt: newRemaining,
      status: newStatus,
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
  const amt = round8(amount);

  // تسجيل حركة النقدية في الصندوق للوردية النشطة (تدعم الأونلاين والأوفلاين تلقائياً)
  if (method === 'cash') {
    import('./cashbox-cloud').then(({ syncActiveShiftTransactionCloud }) => {
      void syncActiveShiftTransactionCloud(
        'debt_payment',
        amt,
        currency,
        currencyAmount,
        debtId,
        'قبض دفعة دين',
        exchangeRate
      );
    }).catch(() => {});
  }

  const queuePayment = (): Debt | null => {
    addToQueue('debt_payment', { debtId, amount: amt, operationId: opId, currency, currencyAmount, exchangeRate, method }, 10);
    const list = (debtsCache || loadDebtsLocally() || []).map(d => {
      if (d.id !== debtId) return d;
      const totalPaid = round8((d.totalPaid || 0) + amt);
      const remainingDebt = Math.max(0, round8(d.totalDebt - totalPaid));
      return { ...d, totalPaid, remainingDebt, status: (remainingDebt <= 0 ? 'fully_paid' : 'partially_paid') as DebtStatus };
    });
    debtsCache = list; cacheTimestamp = Date.now(); saveDebtsLocally(list);
    emitEvent(EVENTS.DEBTS_UPDATED, null);
    return list.find(d => d.id === debtId) || null;
  };
  if (!navigator.onLine) return queuePayment();
  const { data, error } = await sb.rpc('record_debt_payment_atomic', {
    _debt_id: debtId,
    _amount: amt,
    _operation_id: opId,
  });
  if (error) {
    throw new Error(error.message || 'فشل تسجيل الدفعة');
  }
  const res = (data || {}) as Record<string, unknown>;
  invalidateDebtsCache();
  emitEvent(EVENTS.DEBTS_UPDATED, null);
  emitEvent(EVENTS.INVOICES_UPDATED, null);
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
  method: 'cash' | 'transfer' = 'cash'
): Promise<Debt | null> => recordPaymentCloud(debtId, amount, operationId, currency, currencyAmount, exchangeRate, method);

const roundMoney = (n: number) => Math.round(n * 100) / 100;

const fetchOpenDebtsByInvoiceId = async (invoiceId: string): Promise<Array<{ id: string; remaining: number }>> => {
  const { data, error } = await sb
    .from('debts')
    .select('id, remaining_debt')
    .eq('invoice_id', invoiceId);
  if (error) throw new Error(error.message || 'فشل تحميل الدين');
  return ((data || []) as Array<{ id: string; remaining_debt: number | null }>)
    .map(d => ({ id: d.id, remaining: roundMoney(Number(d.remaining_debt) || 0) }))
    .filter(d => d.remaining > 0);
};

// Settle every open debt linked to an invoice via the atomic payment RPC; returns the total amount paid
export const settleDebtsByInvoiceIdCloud = async (invoiceId: string): Promise<number> => {
  let paid = 0;
  for (const debt of await fetchOpenDebtsByInvoiceId(invoiceId)) {
    await recordPaymentCloud(debt.id, debt.remaining);
    paid = roundMoney(paid + debt.remaining);
  }
  return paid;
};

// Delete debt by invoice ID - يدعم البحث بـ invoice_number أو UUID
// ⚠️ ملاحظة: لا نستخدم user_id فلتر هنا لأن getCurrentUserId() قد يُرجع cashier_id
// لكن الديون محفوظة بـ owner_id - RLS يتولى التصفية تلقائياً
export const deleteDebtByInvoiceIdCloud = async (invoiceId: string): Promise<boolean> => {
  try {
    // البحث أولاً بـ invoice_id ثم الحذف بـ UUID لضمان الدقة
    const { data: foundDebts } = await sb
      .from('debts')
      .select('id')
      .eq('invoice_id', invoiceId);

    if (foundDebts && foundDebts.length > 0) {
      for (const debt of foundDebts) {
        await sb.from('debts').delete().eq('id', debt.id);
      }
      invalidateDebtsCache();
      emitEvent(EVENTS.DEBTS_UPDATED, null);
      return true;
    }

    return false;
  } catch (e) {
    console.error('[deleteDebtByInvoiceIdCloud] Error:', e);
    return false;
  }
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
    const { error } = await (sb as any).rpc('cancel_debt_atomic', {
      _debt_id: debtId,
      _reason: reason,
    });
    if (error) {
      console.warn('[deleteDebtCloud] cancel_debt_atomic failed, fallback to client delete:', error);
      const success = await deleteFromSupabase('debts', debtId);
      if (!success) return false;
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
    const { error } = await (sb as any).rpc('writeoff_debt_atomic', {
      _debt_id: debtId,
      _reason: reason,
      _operation_id: operationId,
    });

    if (error) {
      console.warn('[writeOffDebtCloud] RPC failed, queuing for sync:', error);
      addToQueue('debt_writeoff', { debtId, reason, operationId });
    }

    // 2. عكس أرباح الشركاء المعلقة إن وجدت
    if (debt.invoiceId) {
      try {
        const { revertProfitDistributionCloud } = await import('./partners-cloud');
        await revertProfitDistributionCloud(debt.invoiceId);
      } catch (e) {
        console.error('[writeOffDebtCloud] revert partners failed:', e);
      }
    }

    invalidateDebtsCache();
    emitEvent(EVENTS.DEBTS_UPDATED, null);
    emitEvent(EVENTS.CUSTOMERS_UPDATED, null);
    emitEvent(EVENTS.EXPENSES_UPDATED, null);
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
      const bInv = (op.data?.bundle as any)?.invoiceNumber || op.data?.invoiceNumber;
      if (isOperationCancelled(opKey) || (bInv && isOperationCancelled(String(bInv)))) {
        continue;
      }
      const data = op.data as Record<string, any>;
      const bundle = (data?.bundle || {}) as Record<string, any>;
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

  // 1. Try Supabase debt_payments table
  if (navigator.onLine) {
    try {
      const startIso = `${dateStr}T00:00:00.000Z`;
      const endIso = `${dateStr}T23:59:59.999Z`;
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
  if (!foundInCloud && navigator.onLine) {
    try {
      const startIso = `${dateStr}T00:00:00.000Z`;
      const endIso = `${dateStr}T23:59:59.999Z`;
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
    const { getActivityLogs } = await import('@/lib/activity-log');
    const logs = getActivityLogs();
    const dayLogs = logs.filter(l => 
      (l.type === 'debt_payment' || l.type === 'debt_paid') &&
      (l.timestamp?.startsWith(dateStr) || l.timestamp?.split('T')[0] === dateStr)
    );
    if (dayLogs.length > 0) {
      const localTotal = dayLogs.reduce((s, l) => s + Number((l.details as any)?.amount || 0), 0);
      if (localTotal > 0 && !foundInCloud) {
        return round8(localTotal);
      }
    }
  } catch { /* silent */ }

  return round8(total);
};
