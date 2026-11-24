import { isLocalDataMode } from '@/hooks/use-network-status';
// Clear all demo/user data from localStorage and IndexedDB
// This module handles complete data reset locally and on the cloud via RPC reset_user_store_data

import { supabase } from '@/integrations/supabase/client';
import { clearProductsIDB } from './indexeddb-cache';

export const STORAGE_KEYS_TO_CLEAR = [
  'posflow_products_v1',
  'posflow_invoices_v1', 
  'posflow_purchase_invoices_v1',
  'posflow_maintenance_v1',
  'posflow_services_v1',
  'posflow_customers_v1',
  'posflow_debts_v1',
  'posflow_expenses_v1',
  'posflow_recurring_expenses_v1',
  'posflow_partners_v1',
  'posflow_cashbox_v1',
  'posflow_shifts_v1',
  'posflow_capital_v1',
  'posflow_demo_loaded_v2',
  'posflow_profit_records_v1',
  'posflow_expense_records_v1',
  'posflow_warehouses_v1',
  'posflow_stock_transfers_v1',
  'posflow_held_carts_v1',
  'posflow_temp_cart',
  'posflow_cart_customer',
  'posflow_cart_discount',
  'posflow_refund_meta_v1',
  'posflow_dashboard_stats_cache_v1',
  'posflow_pending_scan',
  'posflow_scan_target',
  'posflow_product_form_temp',
  'posflow_restored_image_temp',
  'posflow_categories_v1',
];

const PRESERVED_KEYS = new Set([
  'posflow_language',
  'posflow_theme',
  'posflow_stay_logged_in',
  'posflow_session_cache',
  'posflow_setup_complete',
  'posflow_privacy_accepted',
  'posflow_privacy_version',
  'posflow_clear_version',
  'posflow_settings_layout_mode',
]);

// Version key to track if data has been cleared
const CLEAR_VERSION_KEY = 'posflow_clear_version';
const CURRENT_CLEAR_VERSION = '4'; // Increment this to trigger a new clear

/**
 * مسح جميع مخازن IndexedDB التابعة للبيانات
 */
export const clearIndexedDBData = async (): Promise<void> => {
  try {
    await clearProductsIDB();
  } catch (e) {
    console.warn('[ClearData] clearProductsIDB error:', e);
  }

  if (typeof window !== 'undefined' && window.indexedDB) {
    const dbsToDelete = ['posflow_cache', 'posflow_images_cache', 'posflow_cache_db'];
    for (const dbName of dbsToDelete) {
      try {
        const req = indexedDB.deleteDatabase(dbName);
        await new Promise((resolve) => {
          req.onsuccess = () => resolve(true);
          req.onerror = () => resolve(false);
          req.onblocked = () => resolve(false);
        });
      } catch (e) {
        console.warn(`[ClearData] deleteDatabase(${dbName}) error:`, e);
      }
    }
  }
};

/**
 * مسح جميع مفاتيح localStorage التابعة للبيانات مع الاحتفاظ بإعدادات الحساب والجلسة
 */
export const clearLocalStorageData = (): void => {
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      // Do not touch Supabase auth sessions
      if (key.startsWith('sb-')) continue;
      // Do not touch preserved settings
      if (PRESERVED_KEYS.has(key)) continue;
      // KD-08: the offline queue holds operations not yet sent to the cloud; wiping it loses those sales
      if (key.startsWith('posflow_sync_pending_')) continue;

      if (key.startsWith('posflow_')) {
        keysToRemove.push(key);
      }
    }

    keysToRemove.forEach(key => {
      localStorage.removeItem(key);
    });

    STORAGE_KEYS_TO_CLEAR.forEach(key => {
      localStorage.removeItem(key);
    });

    // إعادة تعيين الصندوق لصفر
    localStorage.setItem('posflow_cashbox_v1', JSON.stringify({
      currentBalance: 0,
      lastUpdated: new Date().toISOString(),
    }));

    // إعادة تعيين رأس المال لصفر
    localStorage.setItem('posflow_capital_v1', JSON.stringify({
      initialCapital: 0,
      currentCapital: 0,
      totalInvestments: 0,
      totalWithdrawals: 0,
      transactions: [],
      lastUpdated: new Date().toISOString(),
    }));

    console.log('[ClearData] LocalStorage data cleared successfully');
  } catch (e) {
    console.warn('[ClearData] Error clearing localStorage:', e);
  }
};

export const clearDemoDataOnce = () => {
  try {
    const clearedVersion = localStorage.getItem(CLEAR_VERSION_KEY);
    
    // Only clear if we haven't cleared this version yet
    if (clearedVersion !== CURRENT_CLEAR_VERSION) {
      clearLocalStorageData();
      
      // Mark as cleared
      localStorage.setItem(CLEAR_VERSION_KEY, CURRENT_CLEAR_VERSION);
      console.log('Demo data cleared for version', CURRENT_CLEAR_VERSION);
    }
  } catch {
    // Ignore errors
  }
};

// Function to manually clear all data (can be called from settings)
export const clearAllUserData = () => {
  try {
    clearLocalStorageData();
    clearIndexedDBData().catch(() => {});
    return true;
  } catch {
    return false;
  }
};

/**
 * ✅ مسح شامل للبيانات:
 * 1. استدعاء (supabase.rpc as any)('reset_user_store_data') لمسح السحابة دفعة واحدة بأمان
 * 2. مسح جميع مفاتيح localStorage ومخازن IndexedDB التابعة للبيانات فوراً بعد نجاح الاستدعاء
 */
export const clearAllDataCompletely = async (): Promise<boolean> => {
  // KD-08: the cloud purge must succeed FIRST. The local copy is cleared only after the server confirmed success.
  // Offline reset is refused: otherwise the device would be emptied while the cloud still holds the data.
  if (isLocalDataMode()) return false;

  try {
    const { data, error } = await (supabase as unknown as { rpc: (fn: string) => Promise<{ data: { success?: boolean; error?: string; deleted?: unknown } | null; error: { message?: string } | null }> }).rpc('reset_user_store_data');
    if (error) throw new Error(error.message || 'reset_user_store_data failed');
    if (!data || data.success !== true) {
      throw new Error((data && data.error) || 'reset_user_store_data returned no success');
    }
    console.log('[ClearData] Cloud store data reset successfully', data.deleted);

    clearLocalStorageData();
    await clearIndexedDBData();

    try {
      const { invalidateAllCaches } = await import('./cloud');
      await invalidateAllCaches();
    } catch {
      // ignore
    }
    return true;
  } catch (error) {
    console.error('[ClearData] Failed to clear data (nothing local was removed):', error);
    return false;
  }
};

/**
 * تنفيذ مسح السحابة المعلق (يُستدعى عند عودة الإنترنت)
 */
export const executePendingCloudClear = async (): Promise<void> => {
  const PENDING_CLOUD_CLEAR_KEY = 'posflow_pending_cloud_clear';
  const isPending = localStorage.getItem(PENDING_CLOUD_CLEAR_KEY);
  if (!isPending) return;
  try {
    const { data, error } = await (supabase as unknown as { rpc: (fn: string) => Promise<{ data: { success?: boolean; error?: string } | null; error: { message?: string } | null }> }).rpc('reset_user_store_data');
    if (error || !data || data.success !== true) {
      console.warn('[ClearData] pending cloud clear not confirmed, keeping it for the next attempt:', error || data);
      return;
    }
    localStorage.removeItem(PENDING_CLOUD_CLEAR_KEY);
    console.log('[ClearData] Pending cloud clear executed successfully');
  } catch (error) {
    console.error('[ClearData] Failed to execute pending cloud clear:', error);
  }
};
