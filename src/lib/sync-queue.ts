/**
 * Sync Queue - PosFlow
 * ========================
 * نظام طابور التزامن الذكي للعمل offline-first
 * يحفظ العمليات محلياً أولاً ثم يرفعها للسحابة
 */

import { secureSet, secureGet, secureRemove } from './secure-storage';
import { emitEvent, EVENTS } from './events';
import { addToHistory, updateHistoryStatus } from './sync-history';
import { isGuestDemoMode } from './demo-data';
import { isCloudWriteBlocked } from './subscription-lock';
import { isOperationCancelled } from './cancellation-registry';
import { getCurrentUserId, getKnownTenantId, getOwnerIdForInsert, setCurrentUserId } from './supabase-store';
import { supabase } from '@/integrations/supabase/client';

// Storage key
const SYNC_QUEUE_KEY = 'sync_queue';
const SYNC_QUEUE_NAMESPACE = 'hp_sync';

/**
 * An operation tagged with a store is visible only to a session of that store.
 * Legacy operations without a known store or creator are retained for manual reconciliation.
 */
const isVisibleOperation = (op: QueuedOperation, tenantId: string | null): boolean =>
  !!tenantId && op?.tenantId === tenantId;

/** Operations hidden from this session (another store's): never shown, never uploaded, never dropped. */
const readHiddenOperations = (tenantId: string | null): QueuedOperation[] => {
  try {
    const stored = secureGet<QueuedOperation[]>(SYNC_QUEUE_KEY, { namespace: SYNC_QUEUE_NAMESPACE }) || [];
    return stored.filter(op => !isVisibleOperation(op, tenantId));
  } catch {
    return [];
  }
};

// ============= Types =============

export type OperationType = 
  | 'sale' 
  | 'expense' 
  | 'debt' 
  | 'debt_payment'
  | 'debt_sale_bundle' // Atomic debt sale operation (invoice + debt + stock + customer)
  | 'stock_update' 
  | 'customer_update'
  | 'customer_create'
  | 'expense_atomic'
  | 'customer_delete'
  | 'invoice_create'
  | 'profit_record' // legacy direct insert, kept only to drain old queued items
  | 'profit_snapshot' // server-side profit snapshot (record_sale_profit_snapshot)
  | 'profit_reverse'
  | 'shift_open'
  | 'shift_close'
  | 'shift_transaction'
  | 'cash_shift_upsert'
  | 'debt_writeoff'
  | 'quick_purchase'    // Quick single-item purchase (bakery mode)
  | 'purchase_invoice'  // Full purchase invoice with items
  | 'invoice_refund'    // Offline invoice refund (restores stock + reverses profit)
  | 'invoice_refund_partial' // Offline partial invoice refund
  | 'store_settings_update' // Offline store & print settings update
  | 'recurring_expense_create'
  | 'recurring_expense_update'
  | 'recurring_expense_delete'
  | 'category_create'
  | 'category_update'
  | 'category_delete'
  | 'expense_reverse'
  | 'partner_withdrawal' // Offline partner withdrawal (idempotent via operationId)
  | 'store_credit_op' // Store credit issue / pay a debt from credit / cash payout (idempotent via operationId)
  | 'maintenance_upsert'
  | 'maintenance_delete';

export interface QueuedOperation {
  id: string;
  type: OperationType;
  timestamp: string;
  data: Record<string, unknown>;
  retryCount: number;
  maxRetries: number;
  status: 'pending' | 'processing' | 'failed' | 'completed';
  error?: string;
  // 'reconciliation': the server refused because the operation's shift closed before it synced (F-20). Not retried;
  // it waits for the owner's manual reconciliation.
  errorClass?: 'retryable' | 'terminal' | 'reconciliation';
  createdAt: string;
  lastAttempt?: string;
  dependsOn?: string;
  /** Store (owner id) that created the operation. Missing on operations queued by older versions. */
  tenantId?: string;
  createdByUserId?: string;
}

/**
 * استخراج رسالة الخطأ الحقيقية من Supabase / PostgREST بدقة
 * يمنع تحويل أخطاء الخادم إلى 'Unknown error'
 */
export function extractErrorMessage(error: unknown): string {
  if (!error) return 'خطأ غير محدد';
  if (typeof error === 'string') return error;
  if (error instanceof Error) {
    return error.message || 'خطأ غير معروف في المعالجة';
  }
  if (typeof error === 'object') {
    const err = error as Record<string, unknown>;
    const code = err.code ? `[كود: ${err.code}] ` : '';
    const message = (err.message || err.error || err.error_description || '') as string;
    const details = err.details ? ` (${err.details})` : '';
    const hint = err.hint ? ` [تلميح: ${err.hint}]` : '';
    const combined = `${code}${message}${details}${hint}`.trim();
    if (combined) return combined;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

const isTerminalSyncError = (message: string): boolean => {
  const normalized = message.toLowerCase();
  return [
    'insufficient stock',
    'product not found',
    'invalid item',
    'invalid sale item',
    'invalid stock quantity',
    'invalid item quantity',
    'invalid operation id',
    'invalid payment type',
    'invalid financial',
    'sale items are required',
    'warehouse not found',
    'missing sale operation id',
    'missing invoice item',
    // رفض صلاحية من الخادم (المرحلة 1): إعادة المحاولة لا تغيّر النتيجة
    'ليست لديك صلاحية الاسترداد',
    'مخصص لمالك المتجر فقط',
    'بصلاحية مالك المتجر فقط',
    // دين أو فاتورة مشطوبة (المرحلة 2): الخادم يرفض أي دفعة أو استرداد عليها نهائياً
    'مشطوب',
    // أخطاء مخطط أو قيود دائمة في PostgreSQL/PostgREST: إعادة المحاولة لن تصلحها، تُعزل فوراً دون تجميد الطابور
    'pgrst204',
    '42703',
    '22p02',
    '23502',
    '23503',
    'an open cash shift for this purchase is required',
    'الوردية غير موجودة',
    'عملية شراء قديمة',
    // manual debt refused by create_manual_debt_atomic (closed period, invalid amount...): the same replay gets the same answer
    'دين مرفوض من الخادم',
    // S-2 guards (migration 20261126170000): direct tampering with financial rows is refused for good
    'حركات الصندوق سجل ثابت',
    'مبلغ حركة الصندوق يجب أن يكون أكبر من الصفر',
    'الوردية غير موجودة لهذا المتجر',
    'الدين يُنشأ عبر العملية الذرية فقط',
    'مبالغ الدين وحالته تتغير',
    'سجل الربح يكتبه الخادم فقط',
    'لا يمكن تعديل سجل الربح مباشرة',
    'الوردية مغلقة ولا تُعدَّل',
    'رصيد الافتتاح والإغلاق يتغيران',
    'الوردية تُفتح فقط',
    'مخصص لمدير المتجر',
  ].some(fragment => normalized.includes(fragment));
};

/** أخطاء الشبكة (لا علاقة لها ببيانات العملية): لا تُحسب كمحاولة فاشلة */
const NETWORK_ERROR_FRAGMENTS = [
  'failed to fetch',
  'networkerror',
  'network request failed',
  'network error',
  'load failed',
  'fetch failed',
  'err_internet_disconnected',
  'err_network',
  'err_name_not_resolved',
  'err_connection',
  'err_timed_out',
  'the internet connection appears to be offline',
  'the network connection was lost',
  'no internet',
  'timed out',
  'aborted',
];

export const isNetworkSyncError = (message: string): boolean => {
  const normalized = message.toLowerCase();
  return NETWORK_ERROR_FRAGMENTS.some(fragment => normalized.includes(fragment));
};

/**
 * ربط طبقة الشبكة (يُضبط من CloudSyncProvider):
 * - isOffline: هل الإنترنت الفعلي مقطوع الآن؟
 * - probe: فحص فعلي متجاوز للكاش، يُستدعى بعد فشل عملية لتمييز "فشل الخادم" عن "انقطاع الإنترنت"
 */
interface SyncNetworkHooks {
  isOffline: () => boolean;
  probe: () => Promise<boolean>;
}
let syncNetworkHooks: SyncNetworkHooks | null = null;
export const configureSyncNetwork = (hooks: SyncNetworkHooks | null): void => {
  syncNetworkHooks = hooks;
};


export interface SyncQueueStatus {
  pendingCount: number;
  failedCount: number;
  processingCount: number;
  isProcessing: boolean;
  lastSyncTime?: string;
}

// ============= State =============

let isProcessing = false;
let processingStartedAt: number | null = null;
let lastSyncTime: string | null = null;
const PROCESSING_LOCK_STALE_MS = 60_000;
const OPERATION_TIMEOUT_MS = 25_000;

// ============= Core Functions =============

/**
 * تحميل الطابور من التخزين الآمن
 */
export const mergePendingQueue = () => {
  const queue = loadQueue();
  let merged = false;
  const keysToDelete = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith('posflow_sync_pending_')) {
      merged = true;
      keysToDelete.push(key);
    }
  }
  if (merged && saveQueue(queue)) {
    keysToDelete.forEach(k => {
      const id = k.replace('posflow_sync_pending_', '');
      if (queue.find(x => x.id === id)) localStorage.removeItem(k);
    });
  }
};

export const loadQueue = (): QueuedOperation[] => {
    try {
      const tenantId = getKnownTenantId();
      const queue = secureGet<QueuedOperation[]>(SYNC_QUEUE_KEY, { namespace: SYNC_QUEUE_NAMESPACE }) || [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('posflow_sync_pending_')) {
          try {
            const op = JSON.parse(localStorage.getItem(key) || 'null');
            if (op && !queue.find(x => x.id === op.id)) queue.push(op);
          } catch { /* intentionally empty */ }
        }
      }
      if (!queue.length) return [];
    const staleBefore = Date.now() - 5 * 60 * 1000;
    let recovered = false;
    const normalized = queue.map(stored => {
      let operation = stored;
      if (!operation.tenantId && tenantId && operation.createdByUserId &&
          operation.createdByUserId === getCurrentUserId()) {
        operation = { ...operation, tenantId };
        recovered = true;
      }
      const lastAttempt = operation.lastAttempt ? Date.parse(operation.lastAttempt) : 0;
      if (operation.status === 'processing' && (!lastAttempt || lastAttempt < staleBefore)) {
        recovered = true;
        return { ...operation, status: 'pending' as const, error: undefined };
      }
      return operation;
    });
    if (recovered) secureSet(SYNC_QUEUE_KEY, normalized, { namespace: SYNC_QUEUE_NAMESPACE });
    return normalized.filter(op => isVisibleOperation(op, tenantId));
  } catch (error) {
    console.error('Error loading sync queue:', error);
    return [];
  }
};

/**
 * حفظ الطابور في التخزين الآمن
 */
const saveQueue = (queue: QueuedOperation[]): boolean => {
  try {
    const hidden = readHiddenOperations(getKnownTenantId());
    const saved = secureSet(SYNC_QUEUE_KEY, [...hidden, ...queue], { namespace: SYNC_QUEUE_NAMESPACE });
    if (saved) emitEvent(EVENTS.SYNC_QUEUE_UPDATED, getQueueStatus());
    return saved;
  } catch (error) {
    console.error('Error saving sync queue:', error);
    return false;
  }
};

/**
 * إضافة عملية للطابور
 */
export const addToQueue = (
  type: OperationType,
  data: Record<string, unknown>,
  maxRetries: number = 3
): QueuedOperation => {
  const candidateOpKey = String(data.uniqueKey || data.operationId || data.localId || '');
  const candidateInvoiceNum = (data.bundle as { invoiceNumber?: string } | undefined)?.invoiceNumber || data.invoiceNumber;
  if ((candidateOpKey && isOperationCancelled(candidateOpKey)) || (candidateInvoiceNum && isOperationCancelled(String(candidateInvoiceNum)))) {
    console.warn('[SyncQueue] Blocked adding cancelled operation to queue:', candidateOpKey || candidateInvoiceNum);
    return {
      id: `blocked_cancelled_${Date.now()}`,
      type,
      timestamp: new Date().toISOString(),
      data,
      retryCount: 0,
      maxRetries,
      status: 'failed',
      error: 'العملية مسجلة كملغاة مسبقاً',
      createdAt: new Date().toISOString(),
    };
  }

  if (isGuestDemoMode()) {
    return {
      id: `demo_op_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      type,
      timestamp: new Date().toISOString(),
      data,
      retryCount: 0,
      maxRetries,
      status: 'completed',
      createdAt: new Date().toISOString(),
    };
  }

  const queue = loadQueue();
  
  const operation: QueuedOperation = {
    id: typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `op_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
    type,
    timestamp: new Date().toISOString(),
    data,
    retryCount: 0,
    maxRetries,
    status: 'pending',
    createdAt: new Date().toISOString(),
    dependsOn: (data?.dependsOn as string) || undefined,
    tenantId: getKnownTenantId() || undefined,
    createdByUserId: getCurrentUserId() || undefined,
  };

  localStorage.setItem('posflow_sync_pending_' + operation.id, JSON.stringify(operation));
    setTimeout(mergePendingQueue, 0);
  
  // Track in history for UI display
  addToHistory(operation.id, type, undefined, operation.data as Parameters<typeof addToHistory>[3]);
  
  console.log(`[SyncQueue] Added operation: ${type}`, operation.id);

  return operation;
};

/** Add a business operation once, using its stable server idempotency key. */
export const addUniqueOperation = (
  type: OperationType,
  data: Record<string, unknown>,
  uniqueKey: string,
  maxRetries: number = 10,
): QueuedOperation => {
  const existing = addToQueueIfNotExists(type, data, uniqueKey, maxRetries);
  if (existing) return existing;
  return addToQueue(type, { ...data, uniqueKey }, maxRetries);
};

/**
 * إضافة أو دمج عملية تحديث إعدادات المتجر في الطابور
 * إذا كانت هناك عملية سابقة معلقة، يتم دمج البيانات بها لتجنب التكرار وضمان شمول التحديث
 */
export const enqueueStoreSettingsUpdate = (
  data: Record<string, unknown>,
  maxRetries: number = 5
): QueuedOperation => {
  const queue = loadQueue();
  const existingIndex = queue.findIndex(
    op => op.type === 'store_settings_update' && (op.status === 'pending' || op.status === 'failed')
  );

  if (existingIndex !== -1) {
    const existingOp = queue[existingIndex];
    const prevSync = (existingOp.data.sync_settings as Record<string, unknown>) || {};
    const newSync = (data.sync_settings as Record<string, unknown>) || {};
    existingOp.data = {
      ...existingOp.data,
      ...data,
      sync_settings: {
        ...prevSync,
        ...newSync,
      },
    };
    existingOp.status = 'pending';
    existingOp.timestamp = new Date().toISOString();
    saveQueue(queue);
    try {
      localStorage.setItem('posflow_sync_pending_' + existingOp.id, JSON.stringify(existingOp));
    } catch {
      // ignore
    }
    console.log('[SyncQueue] Merged store_settings_update into existing queued operation:', existingOp.id);
    return existingOp;
  }

  return addToQueue('store_settings_update', data, maxRetries);
};


/**
 * تحديث حالة عملية
 */
export const updateOperationStatus = (
  operationId: string,
  status: QueuedOperation['status'],
  error?: string
): void => {
  const queue = loadQueue();
  const index = queue.findIndex(op => op.id === operationId);
  
  if (index !== -1) {
    queue[index].status = status;
    queue[index].lastAttempt = new Date().toISOString();
    
    if (error) {
      queue[index].error = error;
    }
    
    if (status === 'failed') {
      queue[index].retryCount += 1;
    }
    
    saveQueue(queue);
  }
};

/**
 * حذف عملية من الطابور
 */
const removePendingRecoveryKey = (operationId: string): void => {
  try {
    localStorage.removeItem('posflow_sync_pending_' + operationId);
    localStorage.removeItem('hyperpos_sync_pending_' + operationId);
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.startsWith('posflow_sync_pending_') || k.startsWith('hyperpos_sync_pending_'))) {
        try {
          const parsed = JSON.parse(localStorage.getItem(k) || 'null');
          if (parsed?.id === operationId) toRemove.push(k);
        } catch { /* ignore */ }
      }
    }
    toRemove.forEach(k => localStorage.removeItem(k));
  } catch { /* ignore */ }
};

export const removeFromQueue = (operationId: string): void => {
  // حذف نسخة الاسترداد من localStorage أولاً قبل saveQueue حتى لا يعيد getQueueStatus/loadQueue قراءتها كعنصر معلق
  removePendingRecoveryKey(operationId);
  const queue = loadQueue();
  const filtered = queue.filter(op => op.id !== operationId);
  saveQueue(filtered);
};

/** إعادة عملية واحدة لحالة الانتظار حتى تُعاد محاولتها فوراً ووضعها في بداية الطابور */
export const resetOperationForRetry = (operationId: string): boolean => {
  const queue = loadQueue();
  const index = queue.findIndex(op => op.id === operationId);
  if (index === -1) return false;
  const opCandidate = queue[index];
  const retryOpKey = String(opCandidate.data.uniqueKey || opCandidate.data.operationId || opCandidate.data.localId || opCandidate.id);
  const retryInvNum = (opCandidate.data?.bundle as { invoiceNumber?: string } | undefined)?.invoiceNumber || opCandidate.data?.invoiceNumber;
  if (isOperationCancelled(retryOpKey) || (retryInvNum && isOperationCancelled(String(retryInvNum)))) {
    console.warn('[SyncQueue] Cannot retry cancelled operation:', operationId);
    return false;
  }

  const [op] = queue.splice(index, 1);
  op.status = 'pending';
  op.retryCount = 0;
  op.error = undefined;
  op.errorClass = undefined;
  // أولوية: وضع العملية في مقدمة الطابور لتتم معالجتها أولاً
  queue.unshift(op);
  saveQueue(queue);
  emitEvent(EVENTS.SYNC_QUEUE_UPDATED, getQueueStatus());
  return true;
};


/**
 * الحصول على العمليات المعلقة
 */
export const getPendingOperations = (): QueuedOperation[] => {
  const queue = loadQueue();
  return queue.filter(op => 
    op.status === 'pending' || 
    (op.status === 'failed' && op.retryCount < op.maxRetries)
  );
};

/**
 * For actions that wipe local data (device transfer): counts EVERY operation the server has not confirmed — pending, processing
 * and failed at any retry count, for any tenant on this device. Throws when a stored queue exists but cannot be read, so the
 * caller stops instead of treating an unreadable queue as empty (invariant 5).
 */
export const countUnsyncedOperationsStrict = (): number => {
  const raw = localStorage.getItem(`${SYNC_QUEUE_NAMESPACE}_${SYNC_QUEUE_KEY}`);
  const stored = secureGet<QueuedOperation[]>(SYNC_QUEUE_KEY, { namespace: SYNC_QUEUE_NAMESPACE });
  if (raw && !Array.isArray(stored)) throw new Error('sync queue unreadable');
  const ids = new Set<string>();
  let count = 0;
  for (const op of stored || []) {
    ids.add(op.id);
    if (op.status !== 'completed') count++;
  }
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith('posflow_sync_pending_')) continue;
    const op = JSON.parse(localStorage.getItem(key) || 'null') as QueuedOperation | null; // a corrupt entry throws: stop
    if (op && !ids.has(op.id) && op.status !== 'completed') count++;
  }
  return count;
};

/**
 * الحصول على العمليات الفاشلة
 */
export const getFailedOperations = (): QueuedOperation[] => {
  const queue = loadQueue();
  return queue.filter(op => 
    op.status === 'failed' && op.retryCount >= op.maxRetries
  );
};

/**
 * الحصول على حالة الطابور
 */
export const getQueueStatus = (): SyncQueueStatus => {
  const queue = loadQueue();
  
  return {
    pendingCount: queue.filter(op => op.status === 'pending').length,
    failedCount: queue.filter(op => op.status === 'failed' && op.retryCount >= op.maxRetries).length,
    processingCount: queue.filter(op => op.status === 'processing').length,
    isProcessing,
    lastSyncTime: lastSyncTime || undefined,
  };
};

/**
 * معالجة الطابور
 * يتم استدعاؤها عند عودة الإنترنت أو عند طلب المزامنة يدوياً
 */
export const processQueue = async (
  processor: (operation: QueuedOperation) => Promise<boolean>,
  targetOperationId?: string,
): Promise<{ processed: number; failed: number; targetSuccess?: boolean }> => {
  if (isGuestDemoMode()) {
    return { processed: 0, failed: 0 };
  }

  if (isProcessing) {
    if (processingStartedAt && Date.now() - processingStartedAt > PROCESSING_LOCK_STALE_MS) {
      console.warn('[SyncQueue] Stale processing lock detected (>60s), resetting lock');
      isProcessing = false;
      processingStartedAt = null;
    } else {
      console.log('[SyncQueue] Already processing, skipping...');
      return { processed: 0, failed: 0 };
    }
  }

  // الحساب غير مدفوع (تجربة/منتهٍ/غير مفعّل): لا إرسال، والعمليات تبقى في الطابور كما هي
  if (isCloudWriteBlocked()) {
    console.log('[SyncQueue] Cloud writes blocked (no active paid subscription) - queue kept intact');
    return { processed: 0, failed: 0 };
  }

  let sessionUserId = getCurrentUserId();
  if (!sessionUserId) {
    try {
      const { data } = await supabase.auth.getSession();
      if (data?.session?.user?.id) {
        sessionUserId = data.session.user.id;
        setCurrentUserId(sessionUserId);
      }
    } catch { /* resolved on the next run */ }
  }
  if (!getKnownTenantId()) {
    try { await getOwnerIdForInsert(); } catch { /* resolved on the next run */ }
  }
  const sessionTenant = getKnownTenantId();
  if (!sessionUserId || !sessionTenant || isProcessing || getCurrentUserId() !== sessionUserId) {
    return { processed: 0, failed: 0 };
  }

  // لا توجد إنترنت فعلي: نؤجل الطابور كاملاً دون استهلاك أي محاولة
  if (syncNetworkHooks?.isOffline()) {
    console.log('[SyncQueue] Internet unreachable - deferring queue without counting retries');
    return { processed: 0, failed: 0 };
  }
  
  isProcessing = true;
  processingStartedAt = Date.now();
  emitEvent(EVENTS.SYNC_QUEUE_UPDATED, getQueueStatus());
  
  let processed = 0;
  let failed = 0;
  let targetSuccess: boolean | undefined = undefined;
  
  try {
    let pending = getPendingOperations();
    if (targetOperationId) {
      // إعطاء الأولوية للعملية المستهدفة ليتم رفعها أولاً فوراً
      const targetOp = pending.find(op => op.id === targetOperationId);
      if (targetOp) {
        pending = [targetOp, ...pending.filter(op => op.id !== targetOperationId)];
      }
    }
    // ضمان رفع المنتجات المضافة أوفلاين أولاً قبل فواتير البيع لتفادي تعليق الفواتير
    // الرفع من الأقدم إلى الأحدث (createdAt تصاعدياً) مع بقاء العملية المستهدفة أولاً
    const firstTarget = targetOperationId ? pending.find(op => op.id === targetOperationId) : undefined;
    const sortedRest = pending
      .filter(op => op !== firstTarget)
      .sort((a, b) => {
        const aIsProdAdd = a.type === 'sale' && a.data?._operation === 'product_add' ? 0 : 1;
        const bIsProdAdd = b.type === 'sale' && b.data?._operation === 'product_add' ? 0 : 1;
        if (aIsProdAdd !== bIsProdAdd) return aIsProdAdd - bIsProdAdd;
        const at = Date.parse(a.createdAt || a.timestamp) || 0;
        const bt = Date.parse(b.createdAt || b.timestamp) || 0;
        return at - bt;
      });
    pending = firstTarget ? [firstTarget, ...sortedRest] : sortedRest;

    console.log(`[SyncQueue] Processing ${pending.length} operations...`);

    // إعادة العملية للانتظار دون زيادة retryCount، ثم إيقاف الدفعة لأن الشبكة مقطوعة
    const deferForNetwork = (operation: QueuedOperation) => {
      console.warn(`[SyncQueue] Network unavailable - deferring ${operation.id} without counting a retry`);
      updateOperationStatus(operation.id, 'pending');
      updateHistoryStatus(operation.id, 'pending', 'بانتظار عودة الإنترنت');
      if (operation.id === targetOperationId) {
        targetSuccess = false;
      }
    };
    
    for (const operation of pending) {
      if (getCurrentUserId() !== sessionUserId || getKnownTenantId() !== sessionTenant) break;
      if (!isVisibleOperation(operation, sessionTenant)) continue;
      // إذا كانت العملية تعتمد على عملية أب ما زالت معلقة في الطابور، نؤجل معالجتها لمنع حدوث خطأ نهائي
      if (operation.dependsOn) {
        const parentPending = pending.some(
          op => (op.id === operation.dependsOn || op.data?.operationId === operation.dependsOn || op.data?.uniqueKey === operation.dependsOn) && op.id !== operation.id
        );
        if (parentPending) {
          console.warn(`[SyncQueue] Skipping dependent operation ${operation.id} until parent ${operation.dependsOn} completes`);
          updateOperationStatus(operation.id, 'pending');
          continue;
        }
      }

      const opKey = String(operation.data.uniqueKey || operation.data.operationId || operation.data.localId || operation.id);
      const bInv = (operation.data?.bundle as { invoiceNumber?: string } | undefined)?.invoiceNumber || operation.data?.invoiceNumber;
      if (isOperationCancelled(opKey) || (bInv && isOperationCancelled(String(bInv)))) {
        console.warn(`[SyncQueue] Skipping upload for cancelled operation: ${operation.id} (${opKey})`);
        removeFromQueue(operation.id);
        try { localStorage.removeItem('posflow_sync_pending_' + operation.id); } catch { /* intentionally empty */ }
        updateHistoryStatus(operation.id, 'failed', 'تم إلغاء العملية محلياً ومنع رفعها للسحابة');
        continue;
      }

      updateOperationStatus(operation.id, 'processing');
      updateHistoryStatus(operation.id, 'syncing');
      
      try {
        const success = await Promise.race([
          processor(operation),
          new Promise<boolean>((_, reject) =>
            setTimeout(() => reject(new Error('Operation timed out after 25s')), OPERATION_TIMEOUT_MS)
          ),
        ]);
        if (getCurrentUserId() !== sessionUserId || getKnownTenantId() !== sessionTenant) break;
        
        if (success) {
          removeFromQueue(operation.id);
          if (operation.type === 'store_settings_update') {
            // أي نسخ قديمة مكررة من تحديث الإعدادات أصبحت متجاوزة بعد نجاح الرفع الأخير
            const remainingSettingsOps = loadQueue().filter(
              op => op.type === 'store_settings_update' && op.id !== operation.id
            );
            remainingSettingsOps.forEach(op => removeFromQueue(op.id));
          }
          updateHistoryStatus(operation.id, 'synced');
          processed++;
          if (operation.id === targetOperationId) {
            targetSuccess = true;
          }
          console.log(`[SyncQueue] Processed: ${operation.id}`);
        } else {
          if (syncNetworkHooks && !(await syncNetworkHooks.probe())) {
            deferForNetwork(operation);
            break;
          }
          updateOperationStatus(operation.id, 'failed', 'Processing returned false');
          updateHistoryStatus(operation.id, 'failed', 'Processing returned false');
          failed++;
          if (operation.id === targetOperationId) {
            targetSuccess = false;
          }
        }
      } catch (error) {
        const errorMessage = extractErrorMessage(error);
        if (isNetworkSyncError(errorMessage)) {
          const isTimeoutOnly = errorMessage.toLowerCase().includes('timed out') || errorMessage.toLowerCase().includes('aborted');
          if (!isTimeoutOnly || !syncNetworkHooks || !(await syncNetworkHooks.probe())) {
            deferForNetwork(operation);
            break;
          }
          // الإنترنت فعّال لكن العملية وحدها استغرقت مهلة طويلة: تُحسب محاولة فاشلة كي لا تجمّد الطابور للأبد
        }
        // رفض الخادم بسبب الاشتراك (trigger a_paid_write_gate): تأجيل بلا احتساب محاولة، وإيقاف الدفعة
        if (errorMessage.toLowerCase().includes('subscription_required')) {
          console.warn(`[SyncQueue] Subscription required - deferring ${operation.id} without counting a retry`);
          updateOperationStatus(operation.id, 'pending');
          updateHistoryStatus(operation.id, 'pending', 'بانتظار تفعيل الاشتراك');
          break;
        }
        if (errorMessage.includes('(F-20)')) {
          const queue = loadQueue();
          const index = queue.findIndex(item => item.id === operation.id);
          if (index !== -1) {
            queue[index].status = 'failed';
            queue[index].retryCount = queue[index].maxRetries;
            queue[index].error = errorMessage;
            queue[index].errorClass = 'reconciliation';
            queue[index].lastAttempt = new Date().toISOString();
            saveQueue(queue);
          }
          updateHistoryStatus(operation.id, 'failed', errorMessage);
          failed++;
          if (operation.id === targetOperationId) targetSuccess = false;
          console.warn(`[SyncQueue] Operation ${operation.id} awaits manual reconciliation (closed shift, F-20)`);
          continue;
        }
        const terminal = isTerminalSyncError(errorMessage);
        if (terminal) {
          const queue = loadQueue();
          const index = queue.findIndex(item => item.id === operation.id);
          if (index !== -1) {
            queue[index].status = 'failed';
            queue[index].retryCount = queue[index].maxRetries;
            queue[index].error = errorMessage;
            queue[index].errorClass = 'terminal';
            queue[index].lastAttempt = new Date().toISOString();
            saveQueue(queue);
          }
          const uniqueKey = String(operation.data.uniqueKey || operation.data.operationId || operation.data.localId || '');
          if (uniqueKey && (operation.type === 'invoice_create' || operation.type === 'debt_sale_bundle')) {
            const { rollbackPendingStockDeduction } = await import('./cloud/products-cloud');
            await rollbackPendingStockDeduction(uniqueKey);
          }
        } else {
          updateOperationStatus(operation.id, 'failed', errorMessage);
        }
        updateHistoryStatus(operation.id, 'failed', errorMessage);
        failed++;
        if (operation.id === targetOperationId) {
          targetSuccess = false;
        }
        console.error(`[SyncQueue] Failed operation ${operation.id} (${operation.type}):`, errorMessage);
      }
    }
    
    lastSyncTime = new Date().toISOString();
    
  } finally {
    isProcessing = false;
    processingStartedAt = null;
    emitEvent(EVENTS.SYNC_QUEUE_UPDATED, getQueueStatus());
  }
  
  return { processed, failed, targetSuccess };
};

/**
 * إعادة تنشيط كافة العمليات الفاشلة والمتعثرة لتجهيزها للمزامنة الجماعية
 */
export const retryFailedOperations = (): number => {
  const queue = loadQueue();
  let revivedCount = 0;

  queue.forEach(op => {
    if (op.status === 'failed' || op.retryCount >= op.maxRetries) {
      op.status = 'pending';
      op.retryCount = 0;
      op.error = undefined;
      op.errorClass = undefined;
      revivedCount++;
    }
  });

  if (revivedCount > 0) {
    saveQueue(queue);
    emitEvent(EVENTS.SYNC_QUEUE_UPDATED, getQueueStatus());
  }

  return revivedCount;
};

/**
 * مسح الطابور
 */
export const clearQueue = (): void => {
  const hidden = readHiddenOperations(getKnownTenantId());
  if (hidden.length) {
    secureSet(SYNC_QUEUE_KEY, hidden, { namespace: SYNC_QUEUE_NAMESPACE });
  } else {
    secureRemove(SYNC_QUEUE_KEY, { namespace: SYNC_QUEUE_NAMESPACE });
  }
  emitEvent(EVENTS.SYNC_QUEUE_UPDATED, getQueueStatus());
};

/**
 * مسح العمليات المكتملة فقط
 */
export const clearCompletedOperations = (): void => {
  const queue = loadQueue();
  const filtered = queue.filter(op => op.status !== 'completed');
  saveQueue(filtered);
};

/**
 * التحقق من وجود عمليات معلقة لنوع معين
 */
export const hasPendingOperations = (type?: OperationType): boolean => {
  const pending = getPendingOperations();
  if (type) {
    return pending.some(op => op.type === type);
  }
  return pending.length > 0;
};

/**
 * الحصول على عمليات بحسب التوقيع الزمني
 * يمنع التكرار عند إعادة التزامن
 */
export const getOperationByTimestamp = (timestamp: string): QueuedOperation | undefined => {
  const queue = loadQueue();
  return queue.find(op => op.timestamp === timestamp);
};

/**
 * إضافة عملية مع منع التكرار
 */
export const addToQueueIfNotExists = (
  type: OperationType,
  data: Record<string, unknown>,
  uniqueKey: string,
  maxRetries: number = 3,
): QueuedOperation | null => {
  const queue = loadQueue();
  
  // التحقق من عدم وجود عملية مشابهة
  const exists = queue.some(op => 
    op.type === type && 
    op.data.uniqueKey === uniqueKey &&
    (op.status === 'pending' || op.status === 'processing' ||
      (op.status === 'failed' && op.retryCount < op.maxRetries))
  );
  
  if (exists) {
    console.log(`[SyncQueue] Operation already exists: ${type} - ${uniqueKey}`);
    return queue.find(op => op.type === type && op.data.uniqueKey === uniqueKey) || null;
  }
  
  return addToQueue(type, { ...data, uniqueKey }, maxRetries);
};
