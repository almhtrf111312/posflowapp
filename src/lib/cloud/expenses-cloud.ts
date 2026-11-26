import { isLocalDataMode } from '@/hooks/use-network-status';
import { assertCurrencyUsable } from '../money-engine';
// Cloud Expenses Store - Supabase-backed expenses management
import { 
  fetchFromSupabase, 
  insertToSupabase, 
  deleteFromSupabase,
  getCurrentUserId,
  getOwnerIdForInsert,
  isCashierUser
} from '../supabase-store';
import { supabase } from '@/integrations/supabase/client';
const sb = supabase;
import { emitEvent, EVENTS } from '../events';
import { addToQueue } from '../sync-queue';
import { triggerAutoBackup } from '../local-auto-backup';
import { loadPartnersCloud, updatePartnerCloud, invalidatePartnersCache } from './partners-cloud';
import { removeOperatingExpense } from '../profits-store';
import { round8 } from '../utils';

export type ExpenseCategory = 'operational' | 'payroll' | 'utilities' | 'maintenance' | 'marketing' | 'other';
export type ExpenseType = 'rent' | 'utilities' | 'wages' | 'equipment' | 'internet' | 'electricity' | 'water' | 'gas' | 'phone' | 'insurance' | 'taxes' | 'supplies' | 'marketing' | 'transport' | 'maintenance' | 'cash_adjustment' | 'other';

export interface ExpenseDistribution {
  partnerId: string;
  partnerName: string;
  amount: number;
  percentage: number;
}

export interface CloudExpense {
  id: string;
  user_id: string;
  cashier_id: string | null; // ✅ Track which cashier created this
  expense_type: string;
  amount: number;
  description: string | null;
  date: string;
  notes: string | null;
  distributions: ExpenseDistribution[];
  created_at: string;
  is_reversed?: boolean;
  reversed_at?: string | null;
  original_currency?: string;
  original_amount?: number;
  exchange_rate?: number;
}

export interface Expense {
  id: string;
  type: ExpenseType;
  typeLabel: string;
  category: ExpenseCategory;
  customType?: string;
  amount: number;
  notes?: string;
  date: string;
  month: string;
  distributions: ExpenseDistribution[];
  createdAt: string;
  cashierId?: string;
  cashierName?: string;
  is_reversed?: boolean;
  reversedAt?: string | null;
  originalCurrency?: string;
  originalAmount?: number;
  exchangeRate?: number;
}

// Expense types with labels
export const expenseTypes: { value: ExpenseType; label: string; category: ExpenseCategory }[] = [
  { value: 'rent', label: 'إيجار', category: 'operational' },
  { value: 'utilities', label: 'مرافق', category: 'utilities' },
  { value: 'wages', label: 'أجور', category: 'payroll' },
  { value: 'equipment', label: 'معدات', category: 'operational' },
  { value: 'internet', label: 'إنترنت', category: 'utilities' },
  { value: 'electricity', label: 'كهرباء', category: 'utilities' },
  { value: 'water', label: 'مياه', category: 'utilities' },
  { value: 'gas', label: 'غاز', category: 'utilities' },
  { value: 'phone', label: 'هاتف', category: 'utilities' },
  { value: 'insurance', label: 'تأمين', category: 'operational' },
  { value: 'taxes', label: 'ضرائب', category: 'operational' },
  { value: 'supplies', label: 'مستلزمات', category: 'operational' },
  { value: 'marketing', label: 'تسويق', category: 'marketing' },
  { value: 'transport', label: 'نقل', category: 'operational' },
  { value: 'maintenance', label: 'صيانة', category: 'maintenance' },
  { value: 'cash_adjustment', label: 'تسوية صندوق', category: 'other' },
  { value: 'other', label: 'أخرى', category: 'other' },
];

export const getExpenseTypeLabel = (type: ExpenseType): string => {
  return expenseTypes.find(t => t.value === type)?.label || type;
};

export const getExpenseCategory = (type: ExpenseType): ExpenseCategory => {
  return expenseTypes.find(t => t.value === type)?.category || 'other';
};

// Cache for cashier names
const cashierNamesCache: Record<string, string> = {};

// Transform cloud to legacy
function toExpense(cloud: CloudExpense & { cashier_name?: string }): Expense {
  const type = cloud.expense_type as ExpenseType;
  return {
    id: cloud.id,
    type,
    typeLabel: getExpenseTypeLabel(type),
    category: getExpenseCategory(type),
    customType: cloud.description || undefined,
    amount: Number(cloud.amount) || 0,
    notes: cloud.notes || undefined,
    date: cloud.date,
    month: (cloud.date || '').substring(0, 7),
    distributions: cloud.distributions || [],
    createdAt: cloud.created_at,
    cashierId: cloud.cashier_id || undefined,
    cashierName: cloud.cashier_name || cashierNamesCache[cloud.cashier_id || ''] || undefined,
    is_reversed: !!cloud.is_reversed,
    reversedAt: cloud.reversed_at ?? null,
    originalCurrency: cloud.original_currency || 'USD',
    originalAmount: cloud.original_amount !== undefined ? Number(cloud.original_amount) : undefined,
    exchangeRate: cloud.exchange_rate !== undefined ? Number(cloud.exchange_rate) : undefined,
  };
}

// Local storage cache helpers
const LOCAL_CACHE_KEY = 'posflow_expenses_cache';

const saveExpensesLocally = (expenses: Expense[]) => {
  try {
    localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(expenses));
  } catch { /* ignore */ }
};

export const loadExpensesLocally = (): Expense[] | null => {
  try {
    const data = localStorage.getItem(LOCAL_CACHE_KEY);
    return data ? JSON.parse(data) : null;
  } catch { return null; }
};

// Cache
let expensesCache: Expense[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 30000;

// Load expenses - cashiers see only their expenses, owners see all
const fetchFresh_loadExpensesCloud = async (opts: { includeReversed?: boolean } = {}): Promise<Expense[]> => {
  const userId = getCurrentUserId();
  if (!userId) return [];

  if (!opts.includeReversed && expensesCache && Date.now() - cacheTimestamp < CACHE_TTL) {
    return expensesCache;
  }

  // Offline: return local cache
  if (isLocalDataMode()) {
    const local = loadExpensesLocally();
    if (local) {
      expensesCache = local;
      cacheTimestamp = Date.now();
      return local;
    }
    return [];
  }

  // Check if user is cashier for filtering
  const isCashier = await isCashierUser();
  
  let cloudExpenses: (CloudExpense & { cashier_name?: string })[];
  
  if (isCashier) {
    // Cashiers see only their own expenses
    const { data, error } = await sb
      .from('expenses')
      .select('*')
      .eq('cashier_id', userId)
      .order('created_at', { ascending: false });
    
    if (error) {
      console.error('Error fetching cashier expenses:', error);
      cloudExpenses = [];
    } else {
      cloudExpenses = (data || []) as unknown as CloudExpense[];
    }
  } else {
    // Owners see all expenses (via RLS)
    cloudExpenses = await fetchFromSupabase<CloudExpense>('expenses', {
      column: 'created_at',
      ascending: false,
    });
  }

  // Fetch cashier names for expenses with cashier_id
  const cashierIds = [...new Set(cloudExpenses.filter(e => e.cashier_id).map(e => e.cashier_id!))];
  if (cashierIds.length > 0) {
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
      
      cloudExpenses = cloudExpenses.map(e => ({
        ...e,
        cashier_name: e.cashier_id ? nameMap[e.cashier_id] : undefined,
      }));
    }
  }

  // Lists exclude reversed expenses. Reports keep them (with reversed_at) so earlier periods stay correct.
  if (opts.includeReversed) {
    return (cloudExpenses || []).map(toExpense);
  }
  cloudExpenses = (cloudExpenses || []).filter(e => !e.is_reversed);

  expensesCache = cloudExpenses.map(toExpense);
  cacheTimestamp = Date.now();
  saveExpensesLocally(expensesCache);
  
  return expensesCache;
};

/** Expenses for the reports and closings, including reversed ones (use expenseIsCounted to apply the period rule). */
export const loadExpensesForReportsCloud = async (): Promise<Expense[]> => {
  return fetchFresh_loadExpensesCloud({ includeReversed: true });
};


let bgFetchingExpenses = false;
const refreshExpensesInBackground = async () => {
  if (bgFetchingExpenses || (typeof navigator !== 'undefined' && isLocalDataMode())) return;
  bgFetchingExpenses = true;
  try {
    const oldCache = expensesCache || loadExpensesLocally() || [];
    const fresh = await fetchFresh_loadExpensesCloud();
    if (fresh) {
      const oldLen = oldCache.length;
      const newLen = fresh.length;
      const oldLatest = oldCache[0]?.id;
      const newLatest = fresh[0]?.id;
      if (oldLen !== newLen || oldLatest !== newLatest) {
        emitEvent(EVENTS.EXPENSES_UPDATED, fresh);
      }
    }
  } catch (err) {
    console.warn('[ExpensesCloud] Background refresh failed:', err);
  } finally {
    bgFetchingExpenses = false;
  }
};

// Load expenses — Cache-First / Zero-Wait pattern (0ms local return + silent SWR background sync)
export const loadExpensesCloud = async (): Promise<Expense[]> => {
  // 1. Cache-First: Serve local copy immediately (0ms)
  const local = loadExpensesLocally();
  const cachedData = (local && local.length > 0) ? local : expensesCache;

  if (cachedData && cachedData.length > 0) {
    expensesCache = cachedData;
    if (typeof navigator !== 'undefined' && !isLocalDataMode()) {
      if (Date.now() - cacheTimestamp >= CACHE_TTL) {
        void refreshExpensesInBackground();
      }
    }
    return cachedData;
  }

  if (typeof navigator !== 'undefined' && isLocalDataMode()) {
    return cachedData || [];
  }

  // 2. Cold start with zero cache: fetch fresh from cloud
  return fetchFresh_loadExpensesCloud();
};

export const invalidateExpensesCache = () => {
  expensesCache = null;
  cacheTimestamp = 0;
};

// Add expense
export const addExpenseCloud = async (expenseData: {
  type: ExpenseType;
  customType?: string;
  amount: number;
  notes?: string;
  date: string;
  originalCurrency?: string;
  originalAmount?: number;
  exchangeRate?: number;
  shiftId?: string | null;
  paidFrom?: string | null;
}): Promise<Expense | null> => {
  // Server does expense + partner shares (+ optional shift drawer tx) together, idempotent by operation UUID.
  const operationId = crypto.randomUUID();
  const currentUid = getCurrentUserId() || '';
  const ownerId = (await getOwnerIdForInsert()) || currentUid;
  const nowIso = new Date().toISOString();
  const roundedAmount = round8(expenseData.amount);
  const originalCurrency = expenseData.originalCurrency || 'USD';
  assertCurrencyUsable(originalCurrency); // F-05: never record a foreign expense at a silent rate of 1
  const exchangeRate = expenseData.exchangeRate || 1;
  const originalAmount = expenseData.originalAmount ?? roundedAmount;

  let resolvedShiftId: string | null = expenseData.shiftId ?? null;
  if (!resolvedShiftId && expenseData.paidFrom === 'drawer') {
    try {
      const { getActiveShift } = await import('../cashbox-store');
      resolvedShiftId = getActiveShift()?.id || null;
    } catch { /* ignore */ }
  }

  const payload = {
    _operation_id: operationId,
    _expense_type: expenseData.type,
    _amount: roundedAmount,
    _description: expenseData.customType || null,
    _date: expenseData.date,
    _notes: expenseData.notes || null,
    _shift_id: resolvedShiftId,
    _paid_from: expenseData.paidFrom ?? (resolvedShiftId ? 'drawer' : null),
    _original_currency: originalCurrency,
    _original_amount: originalAmount,
    _exchange_rate: exchangeRate,
  };

  const localExpense = toExpense({
    id: operationId,
    user_id: ownerId,
    expense_type: expenseData.type,
    amount: roundedAmount,
    description: payload._description,
    date: expenseData.date,
    notes: payload._notes,
    distributions: [],
    created_at: nowIso,
    cashier_id: currentUid || null,
    original_currency: expenseData.originalCurrency || 'USD',
    original_amount: expenseData.originalAmount ?? roundedAmount,
    exchange_rate: expenseData.exchangeRate || 1,
  } as unknown as CloudExpense);

  const saveToLocalAndQueue = () => {
    addToQueue('expense_atomic', payload, 10);
    const existing = expensesCache || loadExpensesLocally() || [];
    const list = [localExpense, ...existing.filter(e => e.id !== localExpense.id)];
    expensesCache = list;
    cacheTimestamp = Date.now();
    saveExpensesLocally(list);
    invalidatePartnersCache();
    emitEvent(EVENTS.EXPENSES_UPDATED, null);
    emitEvent(EVENTS.PARTNERS_UPDATED, null);
    triggerAutoBackup(`مصروف جديد: ${expenseData.type}`);
    return localExpense;
  };

  // 1. Offline fallback
  if (isLocalDataMode()) {
    return saveToLocalAndQueue();
  }

  // 2. Atomic RPC (the only write path). Database rejections are surfaced to the user as-is.
  let rpcError: { message?: string; code?: string } | null = null;
  try {
    const res = await sb.rpc('add_expense_atomic', payload);
    rpcError = res.error as { message?: string; code?: string } | null;
  } catch (ex) {
    // استثناء في النقل (لا اتصال مثلاً): نحفظ محلياً ونضعه في طابور المزامنة الذري
    console.warn('[addExpenseCloud] Transport exception, queueing for safe retry:', ex);
    return saveToLocalAndQueue();
  }

  if (rpcError) {
    // رفض صريح من قاعدة البيانات (فترة مغلقة، وردية، صلاحية...) ⇒ نعرض الخطأ الحقيقي ولا نخفيه في الطابور
    if (rpcError.code) {
      console.warn('[addExpenseCloud] Database rejected expense:', rpcError);
      throw new Error(rpcError.message || 'رفض الخادم حفظ المصروف');
    }
    // فشل في النقل فقط: طابور المزامنة الذري يعيد المحاولة لاحقاً
    console.warn('[addExpenseCloud] Transport failed, queueing for safe retry:', rpcError);
    return saveToLocalAndQueue();
  }

  invalidateExpensesCache();
  invalidatePartnersCache(); // ⬅️ تفريغ كاش الشركاء حتى يظهر الاستقطاع فورياً
  const existing = expensesCache || loadExpensesLocally() || [];
  const list = [localExpense, ...existing.filter(e => e.id !== localExpense.id)];
  expensesCache = list;
  cacheTimestamp = Date.now();
  saveExpensesLocally(list);
  emitEvent(EVENTS.EXPENSES_UPDATED, null);
  emitEvent(EVENTS.PARTNERS_UPDATED, null);
  triggerAutoBackup(`مصروف جديد: ${expenseData.type}`);
  return localExpense;
};

interface ExpenseReversal {
  queued: boolean;
  alreadyReversed: boolean;
  cashRefunded: boolean;
  shiftId?: string;
  cashAmount?: number;
  cashCurrency?: string;
  cashCurrencyAmount?: number;
}

export const reverseExpenseWithResultCloud = async (
  id: string,
  reason: string,
  shiftId?: string | null,
): Promise<ExpenseReversal> => {
  let result: ExpenseReversal;
  if (isLocalDataMode()) {
    addToQueue('expense_reverse', { id, reason, shiftId: shiftId ?? null });
    result = { queued: true, alreadyReversed: false, cashRefunded: false };
  } else {
    const { data: rpcData, error } = await sb.rpc('delete_expense_atomic', {
      _expense_id: id,
      _reason: reason,
      _shift_id: shiftId ?? null,
    });
    // The function returns a JSON object; read it through its known shape
    const data = rpcData as {
      success?: boolean; error?: string; already_reversed?: boolean; cash_refunded?: boolean; shift_id?: string | null;
      cash_amount?: number | string | null; cash_currency?: string | null; cash_currency_amount?: number | string | null;
    } | null;
    if (error || !data?.success) {
      throw new Error(error?.message || data?.error || 'رفض الخادم التراجع عن المصروف');
    }
    result = {
      queued: false,
      alreadyReversed: data.already_reversed === true,
      cashRefunded: data.cash_refunded === true,
      shiftId: data.shift_id || undefined,
      cashAmount: data.cash_amount == null ? undefined : Number(data.cash_amount),
      cashCurrency: data.cash_currency || undefined,
      cashCurrencyAmount: data.cash_currency_amount == null ? undefined : Number(data.cash_currency_amount),
    };
  }

  try { removeOperatingExpense(id); } catch { /* noop */ }
  invalidateExpensesCache();
  invalidatePartnersCache();
  const existing = expensesCache || loadExpensesLocally() || [];
  const list = existing.filter(e => e.id !== id);
  expensesCache = list;
  saveExpensesLocally(list);
  emitEvent(EVENTS.EXPENSES_UPDATED, null);
  emitEvent(EVENTS.PARTNERS_UPDATED, null);
  return result;
};

// Existing callers consume a boolean, while the expense screen uses the posting receipt.
export const deleteExpenseCloud = async (id: string, reason: string = 'تراجع بواسطة المستخدم', shiftId?: string | null): Promise<boolean> => {
  await reverseExpenseWithResultCloud(id, reason, shiftId);
  return true;
};

export const reverseExpenseCloud = deleteExpenseCloud;

// Get expense stats
export const getExpenseStatsCloud = async () => {
  const allExpenses = await loadExpensesCloud();
  // ✅ استثناء المصاريف المستردة أو الملغاة تماماً من الإحصائيات الشهرية والإجمالية
  const expenses = allExpenses.filter(e => !e.is_reversed);
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  
  const monthlyExpenses = expenses.filter(e => {
    const expMonth = (e.month || (e.date ? e.date.substring(0, 7) : '') || '').substring(0, 7);
    return expMonth === currentMonth;
  });
  const totalThisMonth = monthlyExpenses.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
  
  const byType: Record<string, number> = {};
  monthlyExpenses.forEach(e => {
    const key = e.type || e.customType || e.typeLabel || 'other';
    byType[key] = (byType[key] || 0) + (Number(e.amount) || 0);
  });
  
  return {
    totalExpenses: expenses.reduce((sum, e) => sum + (Number(e.amount) || 0), 0),
    totalThisMonth,
    expenseCount: expenses.length,
    monthlyCount: monthlyExpenses.length,
    byType,
  };
};

/** المصاريف المستردة/الملغاة فقط (تُستثنى من التحميل العادي) — للأرشيف */
export const loadReversedExpensesCloud = async (): Promise<Expense[]> => {
  try {
    const { data, error } = await sb
      .from('expenses')
      .select('*')
      .eq('is_reversed', true)
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw error;
    return ((data || []) as unknown as CloudExpense[]).map(toExpense);
  } catch (e) {
    console.warn('[expenses-cloud] loadReversedExpensesCloud failed:', e);
    return [];
  }
};
