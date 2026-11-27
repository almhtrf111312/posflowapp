/**
 * Sync History - Tracks the last N sync operations for UI display
 */
import { secureSet, secureGet } from './secure-storage';
import { emitEvent } from './events';

const SYNC_HISTORY_KEY = 'sync_history';
const SYNC_HISTORY_NAMESPACE = 'hp_sync';
const MAX_HISTORY_ITEMS = 25;

export type SyncCategory = 'sale' | 'expense' | 'debt' | 'inventory' | 'purchase' | 'sync' | 'system';

export interface SyncHistoryMeta {
  operationTitle?: string;
  amountText?: string;
  partyOrItem?: string;
  details?: string;
}

export interface SyncHistoryItem {
  id: string;
  type: string;
  label: string; // Human-readable label
  timestamp: string;
  status: 'pending' | 'syncing' | 'synced' | 'failed';
  error?: string;
  category?: SyncCategory;
  meta?: SyncHistoryMeta;
}

export const SYNC_HISTORY_UPDATED = 'syncHistoryUpdated';

// Operation type labels (Arabic)
const TYPE_LABELS: Record<string, string> = {
  sale: 'عملية بيع',
  invoice_create: 'إنشاء فاتورة',
  invoice_update: 'تعديل فاتورة',
  invoice_refund: 'استرداد فاتورة',
  expense: 'مصروف',
  expense_create: 'إضافة مصروف',
  expense_update: 'تعديل مصروف',
  expense_delete: 'حذف مصروف',
  debt: 'دين',
  debt_payment: 'سداد دين',
  debt_sale_bundle: 'بيع آجل',
  stock_update: 'تحديث مخزون',
  customer_update: 'تحديث عميل',
  profit_record: 'تسجيل ربح',
  customer_create: 'إضافة عميل',
  expense_atomic: 'مصروف',
  customer_delete: 'حذف عميل',
  profit_snapshot: 'لقطة ربح',
  profit_reverse: 'عكس ربح',
  cash_shift_upsert: 'فتح وردية',
  debt_writeoff: 'شطب دين',
  recurring_expense_create: 'إضافة مصروف ثابت',
  recurring_expense_update: 'تعديل مصروف ثابت',
  recurring_expense_delete: 'حذف مصروف ثابت',
  category_create: 'إضافة تصنيف',
  category_update: 'تعديل تصنيف',
  category_delete: 'حذف تصنيف',
  expense_reverse: 'تراجع عن مصروف',
  partner_withdrawal: 'سحب شريك',
  store_credit_op: 'رصيد متجر',
  maintenance_upsert: 'فاتورة صيانة',
  maintenance_delete: 'حذف فاتورة صيانة',
  shift_open: 'فتح وردية',
  shift_close: 'إغلاق وردية',
  shift_transaction: 'حركة وردية',
  quick_purchase: 'شراء سريع',
  purchase_invoice: 'فاتورة شراء',
  invoice_refund_partial: 'استرداد جزئي للفاتورة',
  store_settings_update: 'تحديث إعدادات المتجر والطباعة',
  general_count: 'عدّ الصندوق العام',
  general_deposit: 'إيداع في الصندوق العام',
  supplier_payment: 'دفعة لمورد',
  supplier_refund: 'استرداد من مورد',
  purchase_return: 'مرتجع مشتريات',
  partner_deposit: 'إيداع شريك',
};

/**
 * ترجمة العمليات والمزامنات إلى لغة محاسبية دقيقة وتفادي إظهار أسماء الجداول
 */
export function formatAccountingSyncLabel(
  type: string,
  rawLabelOrPayload?: string | { invoiceNumber?: string; id?: string; amountText?: string; totalInCurrency?: number; customerName?: string; supplierName?: string; name?: string; description?: string; category?: string; amount?: number | string; productName?: string }
): { title: string; subtitle?: string; category: SyncCategory } {
  const t = (type || '').toLowerCase();
  
  // Invoice refund
  if (t === 'invoice_refund' || t.includes('refund')) {
    let invNum = '';
    let amount = '';
    if (typeof rawLabelOrPayload === 'object' && rawLabelOrPayload !== null) {
      invNum = rawLabelOrPayload.invoiceNumber || rawLabelOrPayload.id || '';
      amount = rawLabelOrPayload.amountText || (rawLabelOrPayload.totalInCurrency ? `${rawLabelOrPayload.totalInCurrency}` : '');
    }
    const shortId = invNum ? `#${String(invNum).replace(/^inv[-_]?/i, '')}` : '';
    return {
      title: `تمت مزامنة استرداد فاتورة ${shortId}`.trim(),
      subtitle: amount ? `المبلغ المسترد: ${amount}` : undefined,
      category: 'sale'
    };
  }

  // Invoice update
  if (t === 'invoice_update') {
    let invNum = '';
    if (typeof rawLabelOrPayload === 'object' && rawLabelOrPayload !== null) {
      invNum = rawLabelOrPayload.invoiceNumber || rawLabelOrPayload.id || '';
    }
    const shortId = invNum ? `#${String(invNum).replace(/^inv[-_]?/i, '')}` : '';
    return {
      title: `تمت مزامنة تعديل فاتورة ${shortId}`.trim(),
      category: 'sale'
    };
  }

  // Sales and general invoices
  if (t === 'sale' || t === 'invoice_create' || t.includes('invoice') || t.includes('sale')) {
    let invNum = '';
    let customer = '';
    let amount = '';
    if (typeof rawLabelOrPayload === 'object' && rawLabelOrPayload !== null) {
      invNum = rawLabelOrPayload.invoiceNumber || rawLabelOrPayload.id || '';
      customer = rawLabelOrPayload.customerName || '';
      amount = rawLabelOrPayload.amountText || (rawLabelOrPayload.totalInCurrency ? `${rawLabelOrPayload.totalInCurrency}` : '');
    }
    const shortId = invNum ? `#${String(invNum).replace(/^inv[-_]?/i, '')}` : '';
    return {
      title: `تمت مزامنة فاتورة مبيعات ${shortId}`.trim(),
      subtitle: [customer ? `الزبون: ${customer}` : '', amount ? `المبلغ: ${amount}` : ''].filter(Boolean).join(' • '),
      category: 'sale'
    };
  }

  // Expense delete
  if (t === 'expense_delete') {
    let desc = '';
    if (typeof rawLabelOrPayload === 'object' && rawLabelOrPayload !== null) {
      desc = rawLabelOrPayload.name || rawLabelOrPayload.description || '';
    }
    return {
      title: `تمت مزامنة حذف مصروف: ${desc || 'مصروف'}`.trim(),
      category: 'expense'
    };
  }

  // Expense update
  if (t === 'expense_update') {
    let desc = '';
    let amount = '';
    if (typeof rawLabelOrPayload === 'object' && rawLabelOrPayload !== null) {
      desc = rawLabelOrPayload.name || rawLabelOrPayload.description || '';
      amount = rawLabelOrPayload.amountText || (rawLabelOrPayload.amount ? `${rawLabelOrPayload.amount}` : '');
    }
    return {
      title: `تمت مزامنة تعديل مصروف: ${desc || 'مصروف'}`.trim(),
      subtitle: amount ? `المبلغ المعدل: ${amount}` : undefined,
      category: 'expense'
    };
  }

  // Expense create / general
  if (t === 'expense' || t === 'expense_create' || t.includes('expense')) {
    let desc = '';
    let amount = '';
    if (typeof rawLabelOrPayload === 'object' && rawLabelOrPayload !== null) {
      desc = rawLabelOrPayload.name || rawLabelOrPayload.description || rawLabelOrPayload.category || '';
      amount = rawLabelOrPayload.amountText || (rawLabelOrPayload.amount ? `${rawLabelOrPayload.amount}` : '');
    }
    return {
      title: `تمت مزامنة إضافة مصروف: ${desc || 'مصروف تشغيلي'}`.trim(),
      subtitle: amount ? `المدفوع: ${amount}` : undefined,
      category: 'expense'
    };
  }

  // Debt payment
  if (t === 'debt_payment') {
    let party = '';
    let amount = '';
    if (typeof rawLabelOrPayload === 'object' && rawLabelOrPayload !== null) {
      party = rawLabelOrPayload.customerName || rawLabelOrPayload.supplierName || '';
      amount = rawLabelOrPayload.amountText || (rawLabelOrPayload.amount ? `${rawLabelOrPayload.amount}` : '');
    }
    return {
      title: `تمت مزامنة سداد دين${party ? `: ${party}` : ''}`,
      subtitle: amount ? `قيمة السداد: ${amount}` : undefined,
      category: 'debt'
    };
  }

  if (t === 'debt' || t === 'debt_sale_bundle' || t.includes('debt')) {
    let party = '';
    let amount = '';
    if (typeof rawLabelOrPayload === 'object' && rawLabelOrPayload !== null) {
      party = rawLabelOrPayload.customerName || rawLabelOrPayload.supplierName || '';
      amount = rawLabelOrPayload.amountText || (rawLabelOrPayload.amount ? `${rawLabelOrPayload.amount}` : '');
    }
    return {
      title: `تمت مزامنة حركة دين${party ? `: ${party}` : ''}`,
      subtitle: amount ? `قيمة الدفعة: ${amount}` : undefined,
      category: 'debt'
    };
  }

  if (t === 'stock_update' || t === 'inventory' || t.includes('stock') || t.includes('product')) {
    let item = '';
    if (typeof rawLabelOrPayload === 'object' && rawLabelOrPayload !== null) {
      item = rawLabelOrPayload.productName || rawLabelOrPayload.name || '';
    }
    return {
      title: `تمت مزامنة تحديث مخزون${item ? `: ${item}` : ''}`,
      category: 'inventory'
    };
  }

  if (t === 'purchase' || t.includes('purchase')) {
    return {
      title: 'تمت مزامنة فاتورة شراء',
      category: 'purchase'
    };
  }

  return {
    title: TYPE_LABELS[type] || 'تمت مزامنة البيانات',
    category: 'sync'
  };
}

export const loadHistory = (): SyncHistoryItem[] => {
  try {
    return secureGet<SyncHistoryItem[]>(SYNC_HISTORY_KEY, { namespace: SYNC_HISTORY_NAMESPACE }) || [];
  } catch {
    return [];
  }
};

const saveHistory = (items: SyncHistoryItem[]): void => {
  try {
    // Keep only last MAX_HISTORY_ITEMS
    const trimmed = items.slice(-MAX_HISTORY_ITEMS);
    secureSet(SYNC_HISTORY_KEY, trimmed, { namespace: SYNC_HISTORY_NAMESPACE });
    emitEvent(SYNC_HISTORY_UPDATED, trimmed);
  } catch (e) {
    console.error('[SyncHistory] Save error:', e);
  }
};

/** Add a new operation to history as 'pending' */
export const addToHistory = (
  id: string, 
  type: string, 
  customLabel?: string, 
  meta?: SyncHistoryMeta, 
  category?: SyncCategory
): void => {
  const history = loadHistory();
  
  // Don't duplicate
  if (history.some(h => h.id === id)) return;
  
  const accounting = formatAccountingSyncLabel(type, meta || customLabel);
  
  history.push({
    id,
    type,
    label: customLabel || accounting.title || TYPE_LABELS[type] || type,
    timestamp: new Date().toISOString(),
    status: 'pending',
    category: category || accounting.category,
    meta: meta || (accounting.subtitle ? { partyOrItem: accounting.subtitle } : undefined),
  });
  
  saveHistory(history);
};

/** Update status of a history item */
export const updateHistoryStatus = (
  id: string, 
  status: SyncHistoryItem['status'], 
  error?: string
): void => {
  const history = loadHistory();
  const item = history.find(h => h.id === id);
  if (item) {
    item.status = status;
    if (error) item.error = error;
    saveHistory(history);
  }
};

/** Mark all pending items as synced */
export const markAllSynced = (): void => {
  const history = loadHistory();
  let changed = false;
  history.forEach(h => {
    if (h.status === 'pending' || h.status === 'syncing') {
      h.status = 'synced';
      changed = true;
    }
  });
  if (changed) saveHistory(history);
};

/** Clear synced items older than 1 hour */
export const cleanupSyncedItems = (): void => {
  const history = loadHistory();
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const filtered = history.filter(h => {
    if (h.status === 'synced') {
      return new Date(h.timestamp).getTime() > oneHourAgo;
    }
    return true; // Keep pending/failed
  });
  if (filtered.length !== history.length) {
    saveHistory(filtered);
  }
};

/**
 * Records an operation that went to the server directly (online, not through the queue), so the sync log lists every
 * operation: 'synced' on success, 'failed' with the server message on refusal. Never throws.
 */
export const logDirectSync = (
  id: string,
  type: string,
  label: string,
  ok: boolean,
  error?: string,
  meta?: SyncHistoryMeta,
  category?: SyncCategory,
): void => {
  try {
    addToHistory(id, type, label, meta, category);
    updateHistoryStatus(id, ok ? 'synced' : 'failed', ok ? undefined : (error || 'رفض الخادم العملية'));
  } catch (e) {
    console.warn('[SyncHistory] direct log failed:', e);
  }
};
