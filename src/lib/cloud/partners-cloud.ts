import { isAppOffline } from '@/hooks/use-network-status';
// Cloud Partners Store - Supabase-backed partners management
import { 
  fetchFromSupabase, 
  insertToSupabase, 
  updateInSupabase, 
  deleteFromSupabase,
  getCurrentUserId,
  isCashierUser
} from '../supabase-store';
import { emitEvent, EVENTS } from '../events';
import { supabase } from '@/integrations/supabase/client';
import type { SupabaseClient } from '@supabase/supabase-js';
type LooseSupabase = SupabaseClient<any, 'public', any>;
const sb = supabase as unknown as LooseSupabase;

export interface CategoryShare {
  categoryId: string;
  categoryName: string;
  percentage: number;
  enabled: boolean;
}

export interface Withdrawal {
  id: string;
  amount: number;
  type: 'profit' | 'capital';
  date: string;
  notes?: string;
}

export interface CapitalTransaction {
  id: string;
  amount: number;
  type: 'deposit' | 'withdrawal';
  date: string;
  notes?: string;
}

export interface PendingProfitDetail {
  invoiceId: string;
  amount: number;
  customerName: string;
  createdAt: string;
}

export interface ProfitRecord {
  id: string;
  invoiceId: string;
  amount: number;
  category: string;
  isDebt: boolean;
  createdAt: string;
}

export interface ExpenseRecord {
  expenseId: string;
  type: string;
  amount: number;
  date: string;
  notes?: string;
  createdAt: string;
}

export interface CloudPartner {
  id: string;
  user_id: string;
  name: string;
  phone: string | null;
  email: string | null;
  initial_capital: number;
  current_capital: number;
  share_percentage: number;
  expense_share_percentage: number | null;
  access_all: boolean;
  category_shares: CategoryShare[];
  total_profit_earned: number;
  total_withdrawn: number;
  current_balance: number;
  pending_profit: number;
  confirmed_profit: number;
  pending_profit_details: PendingProfitDetail[];
  profit_history: ProfitRecord[];
  expense_history: ExpenseRecord[];
  capital_history: CapitalTransaction[];
  withdrawal_history: Withdrawal[];
  joined_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface Partner {
  id: string;
  name: string;
  phone: string;
  email?: string;
  sharePercentage: number;
  expenseSharePercentage?: number;
  categoryShares: CategoryShare[];
  accessAll: boolean;
  sharesExpenses: boolean;
  initialCapital: number;
  currentCapital: number;
  capitalWithdrawals: Withdrawal[];
  capitalHistory: CapitalTransaction[];
  confirmedProfit: number;
  pendingProfit: number;
  pendingProfitDetails: PendingProfitDetail[];
  currentBalance: number;
  totalWithdrawn: number;
  totalExpensesPaid: number;
  totalProfitEarned: number;
  profitHistory: ProfitRecord[];
  withdrawalHistory: Withdrawal[];
  expenseHistory: ExpenseRecord[];
  joinedDate: string;
}

// Transform cloud to legacy
function toPartner(cloud: CloudPartner): Partner {
  return {
    id: cloud.id,
    name: cloud.name,
    phone: cloud.phone || '',
    email: cloud.email || undefined,
    sharePercentage: Number(cloud.share_percentage) || 0,
    expenseSharePercentage: cloud.expense_share_percentage ? Number(cloud.expense_share_percentage) : undefined,
    categoryShares: cloud.category_shares || [],
    accessAll: cloud.access_all,
    sharesExpenses: true,
    initialCapital: Number(cloud.initial_capital) || 0,
    currentCapital: Number(cloud.current_capital) || 0,
    capitalWithdrawals: cloud.withdrawal_history?.filter(w => w.type === 'capital') || [],
    capitalHistory: cloud.capital_history || [],
    confirmedProfit: Number(cloud.confirmed_profit) || 0,
    pendingProfit: Number(cloud.pending_profit) || 0,
    pendingProfitDetails: cloud.pending_profit_details || [],
    currentBalance: Number(cloud.current_balance) || 0,
    totalWithdrawn: Number(cloud.total_withdrawn) || 0,
    totalExpensesPaid: 0,
    totalProfitEarned: Number(cloud.total_profit_earned) || 0,
    profitHistory: cloud.profit_history || [],
    withdrawalHistory: cloud.withdrawal_history || [],
    expenseHistory: cloud.expense_history || [],
    joinedDate: cloud.joined_date || cloud.created_at,
  };
}

// Transform legacy to cloud updates
function toCloudPartner(partner: Partial<Partner>): Record<string, unknown> {
  const cloud: Record<string, unknown> = {};
  
  if (partner.name !== undefined) cloud.name = partner.name;
  if (partner.phone !== undefined) cloud.phone = partner.phone || null;
  if (partner.email !== undefined) cloud.email = partner.email || null;
  if (partner.sharePercentage !== undefined) cloud.share_percentage = partner.sharePercentage;
  if (partner.expenseSharePercentage !== undefined) cloud.expense_share_percentage = partner.expenseSharePercentage;
  if (partner.categoryShares !== undefined) cloud.category_shares = partner.categoryShares;
  if (partner.accessAll !== undefined) cloud.access_all = partner.accessAll;
  if (partner.initialCapital !== undefined) cloud.initial_capital = partner.initialCapital;
  if (partner.currentCapital !== undefined) cloud.current_capital = partner.currentCapital;
  if (partner.confirmedProfit !== undefined) cloud.confirmed_profit = partner.confirmedProfit;
  if (partner.pendingProfit !== undefined) cloud.pending_profit = partner.pendingProfit;
  if (partner.pendingProfitDetails !== undefined) cloud.pending_profit_details = partner.pendingProfitDetails;
  if (partner.currentBalance !== undefined) cloud.current_balance = partner.currentBalance;
  if (partner.totalWithdrawn !== undefined) cloud.total_withdrawn = partner.totalWithdrawn;
  if (partner.totalProfitEarned !== undefined) cloud.total_profit_earned = partner.totalProfitEarned;
  if (partner.profitHistory !== undefined) cloud.profit_history = partner.profitHistory;
  if (partner.withdrawalHistory !== undefined) cloud.withdrawal_history = partner.withdrawalHistory;
  if (partner.expenseHistory !== undefined) cloud.expense_history = partner.expenseHistory;
  if (partner.capitalHistory !== undefined) cloud.capital_history = partner.capitalHistory;
  if (partner.joinedDate !== undefined) cloud.joined_date = partner.joinedDate;
  
  return cloud;
}

// Local storage cache helpers
const LOCAL_CACHE_KEY = 'hyperpos_partners_cache';

const savePartnersLocally = (partners: Partner[]) => {
  try {
    localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(partners));
  } catch { /* ignore */ }
};

export const loadPartnersLocally = (): Partner[] | null => {
  try {
    const data = localStorage.getItem(LOCAL_CACHE_KEY);
    return data ? JSON.parse(data) : null;
  } catch { return null; }
};

// Cache
let partnersCache: Partner[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 30000;

// Background refresh control
let bgPartnersRefreshing = false;
const refreshPartnersInBackground = async () => {
  if (bgPartnersRefreshing || isAppOffline()) return;
  if (await isCashierUser()) return;
  bgPartnersRefreshing = true;
  try {
    const cloudPartners = await fetchFromSupabase<CloudPartner>('partners', {
      column: 'created_at',
      ascending: true,
    });
    partnersCache = cloudPartners.map(toPartner);
    cacheTimestamp = Date.now();
    savePartnersLocally(partnersCache);
    emitEvent(EVENTS.PARTNERS_UPDATED, null);
  } catch (e) {
    console.warn('[partners-cloud] background refresh failed:', e);
  } finally {
    bgPartnersRefreshing = false;
  }
};

// Load partners — local-first
export const loadPartnersCloud = async (): Promise<Partner[]> => {
  if (await isCashierUser()) return [];
  const userId = getCurrentUserId();
  if (!userId) {
    const local = loadPartnersLocally();
    return local || [];
  }

  if (partnersCache && Date.now() - cacheTimestamp < CACHE_TTL) {
    return partnersCache;
  }

  const local = loadPartnersLocally();
  if (local) {
    partnersCache = local;
    cacheTimestamp = Date.now();
    if (!isAppOffline()) refreshPartnersInBackground();
    return local;
  }

  if (isAppOffline()) return [];

  const cloudPartners = await fetchFromSupabase<CloudPartner>('partners', {
    column: 'created_at',
    ascending: true,
  });

  partnersCache = cloudPartners.map(toPartner);
  cacheTimestamp = Date.now();
  savePartnersLocally(partnersCache);

  return partnersCache;
};

export const invalidatePartnersCache = () => {
  partnersCache = null;
  cacheTimestamp = 0;
};

// Save partners (full update)
export const savePartnersCloud = async (partners: Partner[]): Promise<void> => {
  for (const partner of partners) {
    await updateInSupabase('partners', partner.id, toCloudPartner(partner));
  }
  invalidatePartnersCache();
  emitEvent(EVENTS.PARTNERS_UPDATED, null);
};

// Get partner by ID
export const getPartnerByIdCloud = async (id: string): Promise<Partner | null> => {
  const partners = await loadPartnersCloud();
  return partners.find(p => p.id === id) || null;
};

// Add partner
export const addPartnerCloud = async (
  partnerData: Omit<Partner, 'id' | 'capitalWithdrawals' | 'capitalHistory' | 'pendingProfitDetails' | 'profitHistory' | 'withdrawalHistory' | 'expenseHistory'>
): Promise<Partner | null> => {
  const cleanName = (partnerData.name || '').trim();
  if (!cleanName) return null;

  // 🔒 التحقق السحابي لمنع تكرار اسم الشريك
  const existingPartners = await loadPartnersCloud();
  const isDuplicate = existingPartners.some(
    p => p.name.trim().toLowerCase() === cleanName.toLowerCase()
  );
  if (isDuplicate) {
    console.warn('[PartnersCloud] Duplicate partner name rejected:', cleanName);
    return null;
  }

  const inserted = await insertToSupabase<CloudPartner>('partners', {
    name: partnerData.name,
    phone: partnerData.phone || null,
    email: partnerData.email || null,
    share_percentage: partnerData.sharePercentage,
    expense_share_percentage: partnerData.expenseSharePercentage || null,
    category_shares: partnerData.categoryShares || [],
    access_all: partnerData.accessAll,
    initial_capital: partnerData.initialCapital || 0,
    current_capital: partnerData.currentCapital || 0,
    confirmed_profit: partnerData.confirmedProfit || 0,
    pending_profit: partnerData.pendingProfit || 0,
    pending_profit_details: [],
    current_balance: partnerData.currentBalance || 0,
    total_withdrawn: partnerData.totalWithdrawn || 0,
    total_profit_earned: partnerData.totalProfitEarned || 0,
    profit_history: [],
    expense_history: [],
    capital_history: [],
    withdrawal_history: [],
    joined_date: partnerData.joinedDate || new Date().toISOString().split('T')[0],
  });
  
  if (inserted) {
    invalidatePartnersCache();
    emitEvent(EVENTS.PARTNERS_UPDATED, null);
    return toPartner(inserted);
  }
  
  return null;
};

// Update partner
export const updatePartnerCloud = async (
  id: string, 
  updates: Partial<Partner>
): Promise<boolean> => {
  const success = await updateInSupabase('partners', id, toCloudPartner(updates));
  
  if (success) {
    invalidatePartnersCache();
    emitEvent(EVENTS.PARTNERS_UPDATED, null);
  }
  
  return success;
};

// Delete partner
export const deletePartnerCloud = async (id: string): Promise<boolean> => {
  const success = await deleteFromSupabase('partners', id);
  
  if (success) {
    invalidatePartnersCache();
    emitEvent(EVENTS.PARTNERS_UPDATED, null);
  }
  
  return success;
};

// Add capital
export const addCapitalCloud = async (
  partnerId: string,
  amount: number,
  notes?: string
): Promise<boolean> => {
  const partner = await getPartnerByIdCloud(partnerId);
  if (!partner || amount <= 0) return false;
  
  const roundedAmount = Math.round(amount * 100) / 100;
  
  const transaction: CapitalTransaction = {
    id: Date.now().toString(),
    amount: roundedAmount,
    type: 'deposit',
    date: new Date().toISOString(),
    notes: notes || 'إضافة رأس مال',
  };
  
  return updatePartnerCloud(partnerId, {
    initialCapital: partner.initialCapital + roundedAmount,
    currentCapital: partner.currentCapital + roundedAmount,
    capitalHistory: [...partner.capitalHistory, transaction],
  });
};

/**
 * ✅ دالة محسّنة: إضافة رأس مال مع تحديث الصندوق تلقائياً
 * هذه الدالة تضيف رأس المال للشريك + ترفع رصيد الصندوق (تعمل بدون وردية)
 */
export const addCapitalWithCashboxCloud = async (
  partnerId: string,
  partnerName: string,
  amountUsd: number,
  notes?: string,
  depositTarget: 'capital' | 'balance' = 'capital',
  currency: string = 'USD',
  originalAmount?: number,
  exchangeRate?: number
): Promise<boolean> => {
  try {
    const roundedUsd = Math.round(amountUsd * 100) / 100;
    const origAmt = originalAmount !== undefined ? Math.round(originalAmount * 100) / 100 : roundedUsd;
    const rate = exchangeRate || (currency !== 'USD' && roundedUsd > 0 ? Math.round((origAmt / roundedUsd) * 10000) / 10000 : 1.0);

    // جلب معرف الوردية النشطة إن وجدت
    let shiftId: string | null = null;
    try {
      const { getActiveShift } = await import('../cashbox-store');
      const activeShift = getActiveShift();
      if (activeShift?.id && activeShift.id.length >= 32) {
        shiftId = activeShift.id;
      }
    } catch (_) {}

    // 1. التنفيذ الذري في السحابة
    let rpcSuccess = false;
    if (!isAppOffline()) {
      try {
        const { data, error } = await sb.rpc('partner_deposit_atomic', {
          _partner_id: partnerId,
          _amount_usd: roundedUsd,
          _deposit_target: depositTarget,
          _notes: notes || null,
          _shift_id: shiftId,
          _currency: currency,
          _original_amount: origAmt,
          _exchange_rate: rate
        });
        if (!error && (data as any)?.success) {
          rpcSuccess = true;
        }
      } catch (e) {
        console.warn('[addCapitalWithCashboxCloud] RPC fallback:', e);
      }
    }

    // 2. تحديث التخزين المحلي والصندوق بالتوافق
    if (depositTarget === 'capital') {
      const { loadCapitalState, saveCapitalState } = await import('../capital-store');
      const state = loadCapitalState();
      state.currentCapital += roundedUsd;
      state.totalInvestments += roundedUsd;
      state.lastUpdated = new Date().toISOString();
      state.transactions.unshift({
        id: Date.now().toString(),
        type: 'partner_investment',
        amount: roundedUsd,
        partnerId,
        partnerName,
        description: notes || `إيداع رأس مال من ${partnerName}`,
        previousBalance: state.currentCapital - roundedUsd,
        newBalance: state.currentCapital,
        createdAt: new Date().toISOString(),
        createdBy: 'system',
      });
      saveCapitalState(state);
      emitEvent(EVENTS.CAPITAL_UPDATED, state);
    }

    // تحديث رصيد الشريك محلياً
    const partner = await getPartnerByIdCloud(partnerId);
    if (partner) {
      const capRecord: CapitalTransaction = {
        id: Date.now().toString(),
        amount: roundedUsd,
        type: 'deposit',
        date: new Date().toISOString(),
        notes: notes || (depositTarget === 'balance' ? 'إيداع رصيد للشريك' : 'إيداع رأس مال'),
      };

      if (depositTarget === 'balance') {
        partner.currentBalance = Math.round((partner.currentBalance + roundedUsd) * 100) / 100;
      } else {
        partner.initialCapital = Math.round((partner.initialCapital + roundedUsd) * 100) / 100;
        partner.currentCapital = Math.round((partner.currentCapital + roundedUsd) * 100) / 100;
      }
      partner.capitalHistory = [...(partner.capitalHistory || []), capRecord];

      if (partnersCache) {
        const idx = partnersCache.findIndex(p => p.id === partnerId);
        if (idx !== -1) partnersCache[idx] = partner;
        savePartnersLocally(partnersCache);
      }
      emitEvent(EVENTS.PARTNERS_UPDATED, partnersCache);
    }

    // إذا فشل الـ RPC وكان أوفلاين ولم يكن depositTarget = balance، نستدعي addCapitalCloud كاحتياط
    if (!rpcSuccess && depositTarget === 'capital') {
      await addCapitalCloud(partnerId, roundedUsd, notes);
    } else if (!rpcSuccess && depositTarget === 'balance' && partner) {
      await updatePartnerCloud(partnerId, {
        currentBalance: partner.currentBalance,
        capitalHistory: partner.capitalHistory,
      });
    }

    const { updateCashboxBalance } = await import('../cashbox-store');
    updateCashboxBalance(origAmt, 'deposit', currency as any);

    invalidatePartnersCache();
    return true;
  } catch (error) {
    console.error('Error in addCapitalWithCashboxCloud:', error);
    return false;
  }
};

// Withdraw profit
export const withdrawProfitCloud = async (
  partnerId: string,
  amount: number,
  notes?: string,
  allowNegative: boolean = false,
  currency: string = 'USD',
  originalAmount?: number,
  exchangeRate?: number
): Promise<boolean> => {
  const partner = await getPartnerByIdCloud(partnerId);
  if (!partner || amount <= 0) return false;
  
  if (!allowNegative && amount > partner.currentBalance) {
    return false;
  }

  const roundedAmount = Math.round(amount * 100) / 100;
  const origAmt = originalAmount !== undefined ? Math.round(originalAmount * 100) / 100 : roundedAmount;
  const rate = exchangeRate || (currency !== 'USD' && roundedAmount > 0 ? Math.round((origAmt / roundedAmount) * 10000) / 10000 : 1.0);
  const withdrawalNote = notes || ('سحب أرباح - ' + partner.name);

  // 1. Resolve active shift ID if any
  let shiftId: string | null = null;
  try {
    const { getActiveShift } = await import('../cashbox-store');
    const activeShift = getActiveShift();
    if (activeShift?.id && activeShift.id.length >= 32) {
      shiftId = activeShift.id;
    }
  } catch { /* silent */ }

  // 2. Attempt atomic server-side RPC execution
  let rpcSuccess = false;
  if (!isAppOffline()) {
    try {
      const { data, error } = await sb.rpc('partner_withdrawal_atomic', {
        _partner_id: partnerId,
        _amount: roundedAmount,
        _withdrawal_type: 'profit',
        _notes: withdrawalNote,
        _shift_id: shiftId,
        _currency: currency,
        _original_amount: origAmt,
        _exchange_rate: rate,
      });
      if (!error && (data as any)?.success) {
        rpcSuccess = true;
      }
    } catch (e) {
      console.warn('[withdrawProfitCloud] RPC partner_withdrawal_atomic failed, falling back:', e);
    }
  }

  const withdrawal: Withdrawal = {
    id: Date.now().toString(),
    amount: roundedAmount,
    type: 'profit',
    date: new Date().toISOString(),
    notes: withdrawalNote,
  };

  // 3. Fallback or update state
  if (rpcSuccess) {
    partner.currentBalance = Math.round((partner.currentBalance - roundedAmount) * 100) / 100;
    partner.totalWithdrawn = Math.round((partner.totalWithdrawn + roundedAmount) * 100) / 100;
    partner.withdrawalHistory = [...(partner.withdrawalHistory || []), withdrawal];

    if (partnersCache) {
      const idx = partnersCache.findIndex(p => p.id === partnerId);
      if (idx !== -1) partnersCache[idx] = partner;
      savePartnersLocally(partnersCache);
    }
    emitEvent(EVENTS.PARTNERS_UPDATED, partnersCache);

    // Update cash drawer locally
    try {
      const { updateCashboxBalance } = await import('../cashbox-store');
      updateCashboxBalance(origAmt, 'withdrawal', currency as any);
    } catch (e) {
      console.warn('[withdrawProfitCloud] cashbox update failed:', e);
    }

    return true;
  }

  // Fallback for offline or RPC failure
  const success = await updatePartnerCloud(partnerId, {
    currentBalance: partner.currentBalance - roundedAmount,
    totalWithdrawn: partner.totalWithdrawn + roundedAmount,
    withdrawalHistory: [...(partner.withdrawalHistory || []), withdrawal],
  });

  if (success) {
    try {
      const { updateCashboxBalance } = await import('../cashbox-store');
      updateCashboxBalance(origAmt, 'withdrawal', currency as any);
    } catch (e) {
      console.warn('[withdrawProfitCloud] cashbox update failed:', e);
    }

    try {
      const { syncActiveShiftTransactionCloud } = await import('./cashbox-cloud');
      await syncActiveShiftTransactionCloud('withdrawal', roundedAmount, currency as any, origAmt, partnerId, withdrawalNote);
    } catch (e) {
      console.warn('[withdrawProfitCloud] shift tx sync failed:', e);
    }
  }

  return success;
};

// Withdraw capital
export const withdrawCapitalCloud = async (
  partnerId: string,
  amount: number,
  notes?: string,
  currency: string = 'USD',
  originalAmount?: number,
  exchangeRate?: number
): Promise<boolean> => {
  const partner = await getPartnerByIdCloud(partnerId);
  if (!partner || amount <= 0) return false;

  if (amount > partner.currentCapital) return false;

  const roundedAmount = Math.round(amount * 100) / 100;
  const origAmt = originalAmount !== undefined ? Math.round(originalAmount * 100) / 100 : roundedAmount;
  const rate = exchangeRate || (currency !== 'USD' && roundedAmount > 0 ? Math.round((origAmt / roundedAmount) * 10000) / 10000 : 1.0);
  const withdrawalNote = notes || ('سحب رأس مال - ' + partner.name);

  // 1. Resolve active shift ID if any
  let shiftId: string | null = null;
  try {
    const { getActiveShift } = await import('../cashbox-store');
    const activeShift = getActiveShift();
    if (activeShift?.id && activeShift.id.length >= 32) {
      shiftId = activeShift.id;
    }
  } catch { /* silent */ }

  // 2. Attempt atomic server-side RPC execution
  let rpcSuccess = false;
  if (!isAppOffline()) {
    try {
      const { data, error } = await sb.rpc('partner_withdrawal_atomic', {
        _partner_id: partnerId,
        _amount: roundedAmount,
        _withdrawal_type: 'capital',
        _notes: withdrawalNote,
        _shift_id: shiftId,
        _currency: currency,
        _original_amount: origAmt,
        _exchange_rate: rate,
      });
      if (!error && (data as any)?.success) {
        rpcSuccess = true;
      }
    } catch (e) {
      console.warn('[withdrawCapitalCloud] RPC partner_withdrawal_atomic failed, falling back:', e);
    }
  }

  const withdrawal: Withdrawal = {
    id: Date.now().toString(),
    amount: roundedAmount,
    type: 'capital',
    date: new Date().toISOString(),
    notes: withdrawalNote,
  };

  const capitalTx: CapitalTransaction = {
    id: Date.now().toString() + '_cap',
    amount: roundedAmount,
    type: 'withdrawal',
    date: new Date().toISOString(),
    notes: withdrawalNote,
  };

  if (rpcSuccess) {
    partner.currentCapital = Math.round((partner.currentCapital - roundedAmount) * 100) / 100;
    partner.totalWithdrawn = Math.round((partner.totalWithdrawn + roundedAmount) * 100) / 100;
    partner.withdrawalHistory = [...(partner.withdrawalHistory || []), withdrawal];
    partner.capitalHistory = [...(partner.capitalHistory || []), capitalTx];

    if (partnersCache) {
      const idx = partnersCache.findIndex(p => p.id === partnerId);
      if (idx !== -1) partnersCache[idx] = partner;
      savePartnersLocally(partnersCache);
    }
    emitEvent(EVENTS.PARTNERS_UPDATED, partnersCache);

    try {
      const { updateCashboxBalance } = await import('../cashbox-store');
      updateCashboxBalance(origAmt, 'withdrawal', currency as any);
    } catch (e) {
      console.warn('[withdrawCapitalCloud] cashbox update failed:', e);
    }

    return true;
  }

  // Fallback for offline or RPC failure
  const success = await updatePartnerCloud(partnerId, {
    currentCapital: partner.currentCapital - roundedAmount,
    totalWithdrawn: partner.totalWithdrawn + roundedAmount,
    withdrawalHistory: [...(partner.withdrawalHistory || []), withdrawal],
    capitalHistory: [...(partner.capitalHistory || []), capitalTx],
  });

  if (success) {
    try {
      const { updateCashboxBalance } = await import('../cashbox-store');
      updateCashboxBalance(origAmt, 'withdrawal', currency as any);
    } catch (e) {
      console.warn('[withdrawCapitalCloud] cashbox update failed:', e);
    }

    try {
      const { syncActiveShiftTransactionCloud } = await import('./cashbox-cloud');
      await syncActiveShiftTransactionCloud('withdrawal', roundedAmount, currency as any, origAmt, partnerId, withdrawalNote);
    } catch (e) {
      console.warn('[withdrawCapitalCloud] shift tx sync failed:', e);
    }
  }

  return success;
};

export const getPartnersStatsCloud = async () => {
  const partners = await loadPartnersCloud();
  return {
    count: partners.length,
    totalCapital: partners.reduce((sum, p) => sum + p.currentCapital, 0),
    totalBalance: partners.reduce((sum, p) => sum + p.currentBalance, 0),
    totalWithdrawn: partners.reduce((sum, p) => sum + p.totalWithdrawn, 0),
    totalProfitEarned: partners.reduce((sum, p) => sum + p.totalProfitEarned, 0),
  };
};

// ✅ توزيع الأرباح على الشركاء - النسخة السحابية
export interface CategoryProfit {
  category: string;
  profit: number;
}

export interface ProfitDistribution {
  partnerId: string;
  partnerName: string;
  amount: number;
  percentage: number;
}

export const distributeDetailedProfitCloud = async (
  profits: CategoryProfit[],
  invoiceId: string,
  customerName: string,
  isDebt: boolean,
  invoiceUuid?: string
): Promise<ProfitDistribution[]> => {
  // ✅ المرحلة الأولى: محاولة التوزيع الذري عبر السيرفر مباشرة (يحل Race Condition + Cache Skew)
  if (invoiceUuid) {
    try {
      const { data, error } = await sb.rpc('distribute_invoice_partner_profits_atomic', {
        _invoice_id: invoiceUuid,
      });
      if (!error && (data as any)?.success) {
        invalidatePartnersCache();
        return ((data as any).distributions || []) as ProfitDistribution[];
      }
      if (error) {
        console.warn('[distributeDetailedProfitCloud] Server RPC warn:', error.message);
      }
    } catch (err) {
      console.error('[distributeDetailedProfitCloud] Atomic RPC call failed:', err);
    }
  }

  // ✅ Fallback: التوزيع من الواجهة (للحالات بدون invoiceUuid أو عند فشل RPC)
  const partners = await loadPartnersCloud();
  const allDistributions: ProfitDistribution[] = [];

  if (partners.length === 0 || profits.length === 0) return allDistributions;

  const updatedPartners: Map<string, Partner> = new Map();

  profits.forEach(({ category, profit }) => {
    if (profit <= 0) return;

    let remainingProfit = profit;

    const specializedPartners = partners.filter(partner =>
      !partner.accessAll && partner.categoryShares.some(cs => cs.enabled && cs.categoryName === category)
    );

    specializedPartners.forEach(partner => {
      const categoryShare = partner.categoryShares.find(
        cs => cs.enabled && cs.categoryName === category
      );

      if (categoryShare && categoryShare.percentage > 0) {
        const partnerShare = (profit * categoryShare.percentage) / 100;
        remainingProfit -= partnerShare;

        allDistributions.push({ partnerId: partner.id, partnerName: partner.name, amount: partnerShare, percentage: categoryShare.percentage });

        const updatedPartner = updatedPartners.get(partner.id) || { ...partner };
        const profitRecord: ProfitRecord = { id: Date.now().toString() + partner.id + category, invoiceId, amount: partnerShare, category, isDebt, createdAt: new Date().toISOString() };

        if (isDebt) {
          updatedPartner.pendingProfit += partnerShare;
          updatedPartner.pendingProfitDetails = [...updatedPartner.pendingProfitDetails, { invoiceId, amount: partnerShare, customerName, createdAt: new Date().toISOString() }];
        } else {
          updatedPartner.confirmedProfit += partnerShare;
          updatedPartner.currentBalance += partnerShare;
          updatedPartner.totalProfitEarned += partnerShare;
        }

        updatedPartner.profitHistory = [...updatedPartner.profitHistory, profitRecord];
        updatedPartners.set(partner.id, updatedPartner);
      }
    });

    if (remainingProfit > 0) {
      const fullPartners = partners.filter(partner => partner.accessAll);

      fullPartners.forEach(partner => {
        if (partner.sharePercentage > 0) {
          const partnerShare = (remainingProfit * partner.sharePercentage) / 100;

          allDistributions.push({ partnerId: partner.id, partnerName: partner.name, amount: partnerShare, percentage: partner.sharePercentage });

          const updatedPartner = updatedPartners.get(partner.id) || { ...partner };
          const profitRecord: ProfitRecord = { id: Date.now().toString() + partner.id + category, invoiceId, amount: partnerShare, category, isDebt, createdAt: new Date().toISOString() };

          if (isDebt) {
            updatedPartner.pendingProfit += partnerShare;
            updatedPartner.pendingProfitDetails = [...updatedPartner.pendingProfitDetails, { invoiceId, amount: partnerShare, customerName, createdAt: new Date().toISOString() }];
          } else {
            updatedPartner.confirmedProfit += partnerShare;
            updatedPartner.currentBalance += partnerShare;
            updatedPartner.totalProfitEarned += partnerShare;
          }

          updatedPartner.profitHistory = [...updatedPartner.profitHistory, profitRecord];
          updatedPartners.set(partner.id, updatedPartner);
        }
      });
    }
  });

  await Promise.all(
    Array.from(updatedPartners.values()).map(partner => updatePartnerCloud(partner.id, {
      confirmedProfit: partner.confirmedProfit,
      pendingProfit: partner.pendingProfit,
      pendingProfitDetails: partner.pendingProfitDetails,
      currentBalance: partner.currentBalance,
      totalProfitEarned: partner.totalProfitEarned,
      profitHistory: partner.profitHistory,
    }))
  );

  return allDistributions;
};
// ✅ تأكيد الأرباح المعلقة عند سداد الدين - النسخة السحابية
export const confirmPendingProfitCloud = async (invoiceId: string, ratio: number = 1): Promise<void> => {
  if (!invoiceId || invoiceId.startsWith('CASH_')) return;
  
  // 1. المحاولة الذرية عبر دالة الخادم confirm_partner_debt_profit_atomic
  try {
    const { data, error } = await sb.rpc('confirm_partner_debt_profit_atomic', {
      _invoice_id: invoiceId,
      _payment_ratio: ratio,
    });
    if (!error && (data as any)?.success) {
      invalidatePartnersCache();
      emitEvent(EVENTS.PARTNERS_UPDATED, null);
      return;
    }
  } catch (rpcErr) {
    console.warn('[confirmPendingProfitCloud] RPC fallback to client calculation:', rpcErr);
  }

  // 2. مسار التراجع الاحتياطي في حال تعذر استدعاء RPC
  const partners = await loadPartnersCloud();
  
  for (const partner of partners) {
    const pendingDetails = partner.pendingProfitDetails.filter(d => d.invoiceId === invoiceId);
    if (pendingDetails.length === 0) continue;
    
    let totalConfirmed = 0;
    const updatedDetails = partner.pendingProfitDetails.map(detail => {
      if (detail.invoiceId !== invoiceId) return detail;
      
      const amountToConfirm = Math.min(detail.amount, detail.amount * ratio);
      totalConfirmed += amountToConfirm;
      
      return { ...detail, amount: Math.max(0, detail.amount - amountToConfirm) };
    }).filter(d => d.amount > 0);
    
    if (totalConfirmed > 0) {
      // ✅ تحديث عناصر سجل تاريخ الأرباح لتصبح مؤكدة (غير معلقة كدين)
      const updatedProfitHistory = (partner.profitHistory || []).map(r => {
        if (r.invoiceId === invoiceId && r.isDebt) {
          return { ...r, isDebt: false };
        }
        return r;
      });

      await updatePartnerCloud(partner.id, {
        pendingProfit: Math.max(0, partner.pendingProfit - totalConfirmed),
        confirmedProfit: partner.confirmedProfit + totalConfirmed,
        currentBalance: partner.currentBalance + totalConfirmed,
        totalProfitEarned: partner.totalProfitEarned + totalConfirmed,
        pendingProfitDetails: updatedDetails,
        profitHistory: updatedProfitHistory,
      });
    }
  }
};

// ✅ عكس أرباح الشركاء سحابياً عند المرتجع — يستدعي الدالة الذرية على السيرفر
export const revertProfitDistributionCloud = async (invoiceId: string, ratio: number = 1.0): Promise<void> => {
  if (!invoiceId) return;

  try {
    // استدعاء دالة العكس الذرية بالسيرفر لضمان الأمان المحاسبي وقفل FOR UPDATE
    const { error } = await sb.rpc('revert_invoice_partner_profits_atomic', {
      _invoice_id: invoiceId,
      _revert_ratio: ratio,
    });
    if (error) {
      console.warn('[revertProfitDistributionCloud] Server RPC notice:', error.message);
    }
    invalidatePartnersCache();
  } catch (err) {
    console.error('[revertProfitDistributionCloud] Failed:', err);
  }
};
