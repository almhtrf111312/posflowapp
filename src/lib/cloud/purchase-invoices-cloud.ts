import { isLocalDataMode } from '@/hooks/use-network-status';
import { supabase } from '@/integrations/supabase/client';
import { round8 } from '@/lib/money-engine';
import { emitEvent, EVENTS } from '@/lib/events';
import { getOwnerIdForInsert, getCurrentUserId } from '@/lib/supabase-store';
import { getPendingOperations } from '@/lib/sync-queue';
import { isGuestDemoMode } from '@/lib/demo-data';
 
 export interface PurchaseInvoice {
   id: string;
   user_id: string;
   invoice_number: string;
  image_url?: string | null;
   supplier_name: string;
   supplier_company?: string;
  supplier_phone?: string;
  payment_type?: string;
   invoice_date: string;
   expected_items_count: number;
   expected_total_quantity: number;
   expected_grand_total: number;
   actual_items_count: number;
   actual_total_quantity: number;
   actual_grand_total: number;
   status: 'draft' | 'reconciled' | 'finalized' | 'superseded' | 'cancelled';
  payment_status?: string;
  payment_method?: string;
  supplier_id?: string | null;
  amount_paid?: number;
  paid_from?: 'drawer' | 'external' | null;
  paid_shift_id?: string | null;
  replaced_by?: string;
  operation_id?: string;
  edit_reason?: string;
   notes?: string;
   created_at: string;
   updated_at: string;
 }
 
 export interface PurchaseInvoiceItem {
   id: string;
   invoice_id: string;
   product_id?: string;
   product_name: string;
   barcode?: string;
   category?: string;
   quantity: number;
   cost_price: number;
   sale_price?: number;
   total_cost: number;
   created_at: string;
 }
 
 export interface CreatePurchaseInvoiceInput {
   invoice_number: string;
   supplier_name: string;
   supplier_company?: string;
   invoice_date: string;
   expected_items_count: number;
   expected_total_quantity: number;
   expected_grand_total: number;
   notes?: string;
  payment_method?: string;
  supplier_id?: string;
  amount_paid?: number;
  paid_from?: 'drawer' | 'external' | null;
  paid_shift_id?: string | null;
 }
 
 export interface CreatePurchaseInvoiceItemInput {
   invoice_id: string;
   product_id?: string;
   product_name: string;
   barcode?: string;
   category?: string;
   quantity: number;
   cost_price: number;
   sale_price?: number;
 }
 
// Local storage cache helpers
const LOCAL_CACHE_KEY = 'posflow_purchase_invoices_cache';

let purchaseInvoicesCache: PurchaseInvoice[] | null = null;
let purchaseCacheTimestamp = 0;
const PURCHASE_CACHE_TTL = 30000;

export const invalidatePurchaseInvoicesCache = () => {
  purchaseInvoicesCache = null;
  purchaseCacheTimestamp = 0;
};

const savePurchaseInvoicesLocally = (invoices: PurchaseInvoice[]) => {
  try {
    purchaseInvoicesCache = invoices;
    purchaseCacheTimestamp = Date.now();
    localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(invoices));
  } catch { /* ignore */ }
};

export const loadPurchaseInvoicesLocally = (): PurchaseInvoice[] | null => {
  try {
    const data = localStorage.getItem(LOCAL_CACHE_KEY);
    return data ? JSON.parse(data) : null;
  } catch { return null; }
};

let bgFetchingPurchases = false;
async function refreshPurchasesInBackground(): Promise<void> {
  if (bgFetchingPurchases || (typeof navigator !== 'undefined' && isLocalDataMode())) return;
  bgFetchingPurchases = true;
  try {
    const { data, error } = await supabase
      .from('purchase_invoices')
      .select('*')
      .order('created_at', { ascending: false });

    if (!error && data) {
      const fresh = data as PurchaseInvoice[];
      const oldCache = purchaseInvoicesCache || loadPurchaseInvoicesLocally() || [];
      const oldJson = JSON.stringify(oldCache);
      const newJson = JSON.stringify(fresh);
      if (oldJson !== newJson) {
        savePurchaseInvoicesLocally(fresh);
        emitEvent(EVENTS.PURCHASES_UPDATED, fresh);
      }
    }
  } catch (err) {
    console.warn('[purchase-invoices-cloud] background refresh error:', err);
  } finally {
    bgFetchingPurchases = false;
  }
}

// Load all purchase invoices — Cache-First / Zero-Wait pattern (0ms local return + silent SWR background sync)
export async function loadPurchaseInvoicesCloud(): Promise<PurchaseInvoice[]> {
  if (isGuestDemoMode()) {
    const local = loadPurchaseInvoicesLocally();
    return local || [];
  }

  // 1. Instant Cache-First return (0ms) - True SWR
  const cached = purchaseInvoicesCache || loadPurchaseInvoicesLocally();
  if (cached !== null) {
    // Launch background fetch silently without blocking UI
    if (typeof navigator !== 'undefined' && !isLocalDataMode()) {
      if (Date.now() - purchaseCacheTimestamp >= PURCHASE_CACHE_TTL) {
        void refreshPurchasesInBackground();
      }
    }
    return mergeSyncQueuePurchases(cached);
  }

  // Fast offline return
  if (typeof navigator !== 'undefined' && isLocalDataMode()) {
    const local = loadPurchaseInvoicesLocally();
    return mergeSyncQueuePurchases(local || []);
  }

  // 2. Cold start with zero cache: fetch from cloud
  try {
    const { data, error } = await supabase
      .from('purchase_invoices')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      console.warn('Error loading purchase invoices from cloud:', error);
      const local = loadPurchaseInvoicesLocally();
      return mergeSyncQueuePurchases(local || []);
    }

    const invoices = (data || []) as PurchaseInvoice[];
    savePurchaseInvoicesLocally(invoices);
    return mergeSyncQueuePurchases(invoices);
  } catch (err) {
    console.warn('Exception loading purchase invoices, falling back to local cache:', err);
    const local = loadPurchaseInvoicesLocally();
    return mergeSyncQueuePurchases(local || []);
  }
}
 
// Load single purchase invoice with items
export async function loadPurchaseInvoiceWithItems(invoiceId: string): Promise<{
  invoice: PurchaseInvoice | null;
  items: PurchaseInvoiceItem[];
}> {
  if (typeof navigator !== 'undefined' && isLocalDataMode()) {
    const local = loadPurchaseInvoicesLocally() || [];
    const invoice = local.find(i => i.id === invoiceId || i.invoice_number === invoiceId) || null;
    return { invoice, items: [] };
  }

  try {
    const { data: invoice, error: invoiceError } = await supabase
      .from('purchase_invoices')
      .select('*')
      .eq('id', invoiceId)
      .single();

    if (invoiceError) {
      console.warn('Error loading purchase invoice:', invoiceError);
      const local = loadPurchaseInvoicesLocally() || [];
      const cached = local.find(i => i.id === invoiceId || i.invoice_number === invoiceId) || null;
      return { invoice: cached, items: [] };
    }

    const { data: items, error: itemsError } = await supabase
      .from('purchase_invoice_items')
      .select('*')
      .eq('invoice_id', invoiceId)
      .order('created_at', { ascending: true });

    if (itemsError) {
      console.warn('Error loading purchase invoice items:', itemsError);
      return { invoice: invoice as PurchaseInvoice, items: [] };
    }

    return {
      invoice: invoice as PurchaseInvoice,
      items: (items || []) as PurchaseInvoiceItem[]
    };
  } catch (err) {
    console.warn('Exception loading purchase invoice with items:', err);
    const local = loadPurchaseInvoicesLocally() || [];
    const cached = local.find(i => i.id === invoiceId || i.invoice_number === invoiceId) || null;
    return { invoice: cached, items: [] };
  }
}

// Create new purchase invoice
 export async function addPurchaseInvoiceCloud(input: CreatePurchaseInvoiceInput): Promise<PurchaseInvoice | null> {
   if (isGuestDemoMode()) {
     const tempId = `demo_pi_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
     const demoInvoice: PurchaseInvoice = {
       id: tempId,
       user_id: 'guest-demo-user',
       invoice_number: input.invoice_number,
       supplier_name: input.supplier_name,
       supplier_company: input.supplier_company,
       invoice_date: input.invoice_date,
       expected_items_count: input.expected_items_count,
       expected_total_quantity: input.expected_total_quantity,
       expected_grand_total: input.expected_grand_total,
       actual_items_count: 0,
       actual_total_quantity: 0,
       actual_grand_total: 0,
       status: 'draft',
       notes: input.notes,
       created_at: new Date().toISOString(),
       updated_at: new Date().toISOString(),
     };
     const local = loadPurchaseInvoicesLocally() || [];
     local.unshift(demoInvoice);
     savePurchaseInvoicesLocally(local);
     emitEvent(EVENTS.PURCHASES_UPDATED, null);
     return demoInvoice;
   }
   const { data: { user } } = await supabase.auth.getUser();
   if (!user) return null;
 
   // استخدام owner_id لضمان عزل الصلاحيات (الكاشير يكتب تحت حساب المالك)
   const ownerId = await getOwnerIdForInsert() || user.id;

   const { data, error } = await supabase
     .from('purchase_invoices')
     .insert({
       user_id: ownerId,
       ...input,
       status: 'draft',
       actual_items_count: 0,
       actual_total_quantity: 0,
       actual_grand_total: 0
     })
     .select()
     .single();
 
   if (error) {
     console.error('Error creating purchase invoice:', error);
     return null;
   }
 
   return data as PurchaseInvoice;
 }
 
 // Add item to purchase invoice
 export async function addPurchaseInvoiceItemCloud(input: CreatePurchaseInvoiceItemInput): Promise<PurchaseInvoiceItem | null> {
   if (isGuestDemoMode()) {
     const tempId = `demo_pii_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
     return {
       id: tempId,
       invoice_id: input.invoice_id,
       product_id: input.product_id,
       product_name: input.product_name,
       barcode: input.barcode,
       category: input.category,
       quantity: input.quantity,
       cost_price: input.cost_price,
       sale_price: input.sale_price,
       total_cost: input.quantity * input.cost_price,
       created_at: new Date().toISOString(),
     };
   }
   const total_cost = input.quantity * input.cost_price;
 
   const { data, error } = await supabase
     .from('purchase_invoice_items')
     .insert({
       ...input,
       total_cost
     })
     .select()
     .single();
 
   if (error) {
     console.error('Error adding purchase invoice item:', error);
     return null;
   }
 
   // Update invoice totals
   await updateInvoiceTotals(input.invoice_id);
 
   return data as PurchaseInvoiceItem;
 }
 
 // Update invoice totals based on items
 async function updateInvoiceTotals(invoiceId: string): Promise<void> {
   const { data: items } = await supabase
     .from('purchase_invoice_items')
     .select('quantity, total_cost')
     .eq('invoice_id', invoiceId);
 
   if (!items) return;
 
   const actual_items_count = items.length;
   const actual_total_quantity = items.reduce((sum, item) => sum + (item.quantity || 0), 0);
   const actual_grand_total = items.reduce((sum, item) => sum + (item.total_cost || 0), 0);
 
   await supabase
     .from('purchase_invoices')
     .update({
       actual_items_count,
       actual_total_quantity,
       actual_grand_total
     })
     .eq('id', invoiceId);
 }
 
 // Delete item from purchase invoice
 export async function deletePurchaseInvoiceItemCloud(itemId: string, invoiceId: string): Promise<boolean> {
   const { error } = await supabase
     .from('purchase_invoice_items')
     .delete()
     .eq('id', itemId);
 
   if (error) {
     console.error('Error deleting purchase invoice item:', error);
     return false;
   }
 
   await updateInvoiceTotals(invoiceId);
   return true;
 }
 
 // Finalize purchase invoice and update product stock
export async function finalizePurchaseInvoiceCloud(invoiceId: string): Promise<boolean> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;

  // Snapshot of the items, used only for the local cache update below (writes nothing)
  const { invoice, items } = await loadPurchaseInvoiceWithItems(invoiceId);
  if (!invoice || items.length === 0) return false;

  // One atomic server transaction: product linking/creation, WAC, stock, history and status.
  // A thrown error means nothing was applied; a retry on a finalized invoice is a no-op.
  const { data: rpcData, error: rpcError } = await (supabase as any).rpc('finalize_purchase_invoice_atomic', {
    _invoice_id: invoiceId,
  });
  if (rpcError) throw rpcError;

  const result = (rpcData || {}) as { success?: boolean; already_finalized?: boolean };
  if (!result.success) return false;

  if (!result.already_finalized) {
     // ⚖️ تحديث المخزون والتكلفة WAC محلياً وفورياً
     for (const item of items) {
       if (!item.product_id) continue;
       try {
         const productsCloud = (await import('./products-cloud')) as unknown as {
           loadProductsFromLocalCache?: () => any[] | null;
           saveProductsToLocalCache?: (p: any[]) => void;
           updateProductInIDB?: (id: string, patch: Record<string, unknown>) => Promise<void>;
         };
         const { loadProductsFromLocalCache, saveProductsToLocalCache, updateProductInIDB } = productsCloud;
         if (!loadProductsFromLocalCache || !saveProductsToLocalCache || !updateProductInIDB) break;
         const localProducts = loadProductsFromLocalCache() || [];
         const prodIndex = localProducts.findIndex(p => p.id === item.product_id);
         if (prodIndex !== -1) {
           const current = localProducts[prodIndex];
           const currentQty = Number(current.quantity) || 0;
           const currentCost = Number(current.cost_price) || 0;
           const purchasedQty = Number(item.quantity) || 0;
           const purchasedCost = Number(item.cost_price) || 0;

           let newCost = currentCost;
           if (currentQty <= 0) {
             newCost = purchasedCost > 0 ? purchasedCost : currentCost;
           } else if (purchasedCost > 0) {
             newCost = Math.round(((currentQty * currentCost) + (purchasedQty * purchasedCost)) / (currentQty + purchasedQty) * 100000000) / 100000000;
           }
           const newQty = currentQty + purchasedQty;

           localProducts[prodIndex] = {
             ...current,
             quantity: newQty,
             cost_price: newCost,
             status: newQty > 0 ? 'available' : 'out_of_stock'
           };
           saveProductsToLocalCache(localProducts);
           await updateProductInIDB(item.product_id, {
             quantity: newQty,
             cost_price: newCost,
             status: newQty > 0 ? 'available' : 'out_of_stock'
           });
         }
       } catch (e) {
         console.warn('[PurchaseInvoices] Local WAC update error:', e);
       }
     }
  }

  emitEvent(EVENTS.PRODUCTS_UPDATED, null);
  invalidatePurchaseInvoicesCache();
  emitEvent(EVENTS.PURCHASES_UPDATED, null);
  return true;
}

// Delete purchase invoice with full inventory deduction and financial reversal
 /**
 * إلغاء فاتورة المشتريات ذرياً عبر الخادم (Atomic Compensation Reversal)
 * يمنع الحذف المادي بـ DELETE تنفيذاً للقاعدة المالية الصارمة،
 * ويقوم بقفل المنتجات وعكس المخزون وحساب الـ WAC بدقة وتوثيق stock_movements (purchase_reversal)
 */
export async function cancelPurchaseInvoiceCloud(invoiceId: string, reason?: string): Promise<boolean> {
  try {
    const isOfflineInvoice = invoiceId.startsWith('local_');

    if (!isOfflineInvoice) {
      // 1. استدعاء دالة الإلغاء الذرية في السيرفر
      const { error } = await (supabase as any).rpc('cancel_purchase_invoice_atomic', {
        _invoice_id: invoiceId,
        _reason: reason || 'إلغاء فاتورة مشتريات'
      });

      if (error) {
        console.error('[cancelPurchaseInvoiceCloud] RPC error:', error);
        throw error;
      }
    }

    // 2. تحديث الكاش المحلي: وسم الفاتورة كملغاة بدلاً من مسحها مادياً
    const localInvoices = loadPurchaseInvoicesLocally();
    const updatedInvoices = localInvoices.map((inv) =>
      inv.id === invoiceId ? { ...inv, status: 'cancelled' as const } : inv
    );
    savePurchaseInvoicesLocally(updatedInvoices);

    if (purchaseInvoicesCache) {
      purchaseInvoicesCache = purchaseInvoicesCache.map((inv) =>
        inv.id === invoiceId ? { ...inv, status: 'cancelled' as const } : inv
      );
    }

    // 3. إشعار التطبيق بتحديث المشتريات والمخزون والمصاريف
    emitEvent(EVENTS.PURCHASES_UPDATED);
    emitEvent(EVENTS.PRODUCTS_UPDATED);
    emitEvent(EVENTS.EXPENSES_UPDATED);

    return true;
  } catch (error) {
    console.error('Error in cancelPurchaseInvoiceCloud:', error);
    return false;
  }
}

// إبقاء الاسم القديم للتوافقية الكاملة مع الواجهات
export const deletePurchaseInvoiceCloud = cancelPurchaseInvoiceCloud;

export async function updatePurchaseInvoiceStatusCloud(
   invoiceId: string, 
   status: 'draft' | 'reconciled' | 'finalized'
 ): Promise<boolean> {
   const { error } = await supabase
     .from('purchase_invoices')
     .update({ status })
     .eq('id', invoiceId);
 
   if (error) {
     console.error('Error updating purchase invoice status:', error);
     return false;
   }
 
   return true;
 }
/** Merge pending (not yet synced) purchase invoices from the sync queue into the list. */
function mergeSyncQueuePurchases(list: PurchaseInvoice[]): PurchaseInvoice[] {
  try {
    const existing = new Set(list.map(i => i.invoice_number));
    const pending = getPendingOperations()
      .filter(op => op.type === 'purchase_invoice')
      .map(op => {
        const d = op.data as Record<string, any>;
        return {
          id: `queued-${op.id}`,
          user_id: '',
          invoice_number: String(d.invoiceNumber ?? ''),
          supplier_name: String(d.supplierName ?? ''),
          supplier_company: d.supplierCompany,
          invoice_date: String(d.invoiceDate ?? op.createdAt?.slice(0, 10) ?? ''),
          expected_items_count: Number(d.expectedItemsCount ?? 0),
          expected_total_quantity: Number(d.expectedTotalQuantity ?? 0),
          expected_grand_total: Number(d.expectedGrandTotal ?? 0),
          status: 'draft',
          notes: d.notes,
          created_at: op.createdAt,
        } as unknown as PurchaseInvoice;
      })
      .filter(p => p.invoice_number && !existing.has(p.invoice_number));
    return pending.length ? [...pending, ...list] : list;
  } catch {
    return list;
  }
}


export interface EditPurchaseInvoiceLine {
  product_id?: string;
  product_name: string;
  barcode?: string;
  category?: string;
  quantity: number;
  cost_price: number;
  cost_price_before?: number;
  sale_price?: number;
}

/**
 * Atomic server-side purchase invoice editing function.
 * Reverses old stock, verifies non-negative stock, adds new lines,
 * recalculates weighted average cost, marks old invoice superseded,
 * and maintains full audit log and idempotency.
 */
export async function editPurchaseInvoiceAtomic(
  invoiceId: string,
  newLines: EditPurchaseInvoiceLine[],
  opId?: string,
  reason: string = 'تعديل فاتورة شراء'
): Promise<{ success: boolean; newInvoiceId?: string; error?: string }> {
  const finalOpId = opId || `edit_pi_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    if (isGuestDemoMode()) {
      const local = loadPurchaseInvoicesLocally();
      const orig = local.find(i => i.id === invoiceId);
      if (!orig) return { success: false, error: 'الفاتورة غير موجودة' };
      orig.status = 'superseded' as any;
      const newInv: PurchaseInvoice = {
        ...orig,
        id: `demo_pi_${Date.now()}`,
        invoice_number: `${orig.invoice_number}-REV`,
        status: orig.status === 'finalized' ? 'finalized' : 'draft',
        actual_items_count: newLines.length,
        actual_total_quantity: newLines.reduce((s, l) => s + (l.quantity || 0), 0),
        actual_grand_total: newLines.reduce((s, l) => s + (l.quantity * l.cost_price || 0), 0),
        notes: `${orig.notes || ''} [تعديل للفاتورة #${orig.invoice_number}]`,
        updated_at: new Date().toISOString(),
      };
      local.unshift(newInv);
      savePurchaseInvoicesLocally(local);
      emitEvent(EVENTS.PURCHASES_UPDATED, null);
      emitEvent(EVENTS.PRODUCTS_UPDATED, null);
      return { success: true, newInvoiceId: newInv.id };
    }

    const { data, error } = await (supabase as any).rpc('edit_purchase_invoice_atomic', {
      _invoice_id: invoiceId,
      _new_lines: newLines,
      _op_id: finalOpId,
      _reason: reason
    });

    if (error) {
      console.error('Error in edit_purchase_invoice_atomic RPC:', error);
      return { success: false, error: error.message || 'فشل تعديل الفاتورة' };
    }

    emitEvent(EVENTS.PURCHASES_UPDATED, null);
    emitEvent(EVENTS.PRODUCTS_UPDATED, null);
    return { success: true, newInvoiceId: data as string };
  } catch (err: any) {
    console.error('Exception in editPurchaseInvoiceAtomic:', err);
    return { success: false, error: err?.message || 'حدث خطأ أثناء الاتصال بالخادم' };
  }
}
