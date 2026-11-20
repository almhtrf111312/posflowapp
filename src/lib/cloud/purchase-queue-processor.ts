import { invalidateProductsCache } from './products-cloud';
import { emitEvent, EVENTS } from '../events';
import { addWithdrawalFromShift, getActiveShift } from '../cashbox-store';
/**
 * Purchase Queue Processor - processes offline purchase operations
 * Handles quick_purchase and purchase_invoice types from the sync queue
 */

import { supabase } from '@/integrations/supabase/client';
import { finalizePurchaseInvoiceCloud, invalidatePurchaseInvoicesCache } from './purchase-invoices-cloud';
import { getOwnerIdForInsert, filterTablePayload } from '@/lib/supabase-store';
import { extractErrorMessage } from '@/lib/sync-queue';

const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

/** Finalize through the atomic server function; a false result must keep the operation in the queue. */
async function finalizeOrThrow(invoiceId: string): Promise<void> {
  const ok = await finalizePurchaseInvoiceCloud(invoiceId);
  if (!ok) throw new Error('فشل اعتماد فاتورة المشتريات على الخادم');
}

interface QuickPurchaseData {
  operationId?: string;
  productName: string;
  quantity: number;
  costPrice: number;
  paymentMethod?: 'cash' | 'credit';
  shiftId?: string;
}

interface PurchaseInvoiceData {
  invoiceNumber: string;
  supplierName: string;
  supplierCompany?: string;
  supplierId?: string;
  amountPaid?: number;
  paidFrom?: 'drawer' | 'external';
  paidShiftId?: string;
  invoiceDate: string;
  notes?: string;
  imageUrl?: string;
  items: Array<{
    product_name: string;
    barcode?: string;
    category?: string;
    quantity: number;
    cost_price: number;
    sale_price?: number;
    product_id?: string;
  }>;
  /** The invoice already exists in the cloud (created online as a draft): finalize it instead of creating a new one. */
  existingInvoiceId?: string;
}

export async function processQuickPurchaseFromQueue(data: QuickPurchaseData): Promise<boolean> {
  if (!isUuid(data.operationId) || !data.paymentMethod) {
    throw new Error('عملية شراء قديمة تحتاج مطابقة الفاتورة والمخزون قبل إعادة إرسالها');
  }
  const { data: result, error } = await supabase.rpc('process_quick_purchase_atomic' as never, {
    _operation_id: data.operationId,
    _purchase: data,
  } as never);
  if (error) throw new Error(extractErrorMessage(error));
  const confirmation = result as { success?: boolean; cash_amount?: number; shift_id?: string } | null;
  if (!confirmation?.success) throw new Error('لم يؤكد الخادم اعتماد الشراء السريع');

  // Reflect a server-confirmed movement locally at most once, including after a lost response.
  if (confirmation.shift_id && confirmation.shift_id === getActiveShift()?.id &&
      Number(confirmation.cash_amount) > 0) {
    const marker = 'hp_quick_purchase_cash_' + data.operationId;
    try {
      if (!localStorage.getItem(marker)) {
        localStorage.setItem(marker, '1');
        addWithdrawalFromShift(Number(confirmation.cash_amount), 'USD');
      }
    } catch (error) {
      console.warn('Quick purchase committed; local drawer display could not be refreshed:', error);
    }
  }
  invalidatePurchaseInvoicesCache();
  invalidateProductsCache();
  emitEvent(EVENTS.PURCHASES_UPDATED);
  emitEvent(EVENTS.PRODUCTS_UPDATED);
  return true;
}

export async function processPurchaseInvoiceFromQueue(data: PurchaseInvoiceData, operationId?: string): Promise<boolean> {
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) {
    throw new Error('المستخدم غير مسجل الدخول لمزامنة فاتورة المشتريات');
  }

  // استخدام owner_id لضمان عزل الصلاحيات
  const ownerId = await getOwnerIdForInsert() || user.id;

  // Stable invoice id: the existing cloud invoice when there is one, otherwise the queue operation id.
  // Either way a retry never creates a second invoice, and the queued items are the source of truth.
  const stableId = isUuid(data.existingInvoiceId)
    ? data.existingInvoiceId
    : (isUuid(operationId) ? operationId : undefined);
  let invoiceId: string | undefined;

  if (stableId) {
    const { data: existing, error: existingErr } = await supabase
      .from('purchase_invoices')
      .select('id, status')
      .eq('id', stableId)
      .maybeSingle();
    if (existingErr) {
      throw new Error(`تعذر التحقق من فاتورة المشتريات: ${extractErrorMessage(existingErr)}`);
    }
    if (existing) {
      if (existing.status === 'finalized') return true;
      // A previous attempt created the invoice but did not finish: rebuild its items
      const { error: clearErr } = await supabase
        .from('purchase_invoice_items')
        .delete()
        .eq('invoice_id', stableId);
      if (clearErr) {
        throw new Error(`تعذر تنظيف بنود الفاتورة: ${extractErrorMessage(clearErr)}`);
      }
      invoiceId = stableId;
    }
  }

  if (!invoiceId) {
    // Create the invoice
    const invPayload = filterTablePayload('purchase_invoices', {
      ...(stableId ? { id: stableId } : {}),
      user_id: ownerId,
      invoice_number: data.invoiceNumber,
      supplier_name: data.supplierName,
      supplier_company: data.supplierCompany || null,
      supplier_id: data.supplierId || null,
      amount_paid: data.amountPaid || 0,
      paid_from: data.amountPaid ? data.paidFrom || 'external' : null,
      paid_shift_id: data.paidFrom === 'drawer' ? data.paidShiftId || null : null,
      payment_method: data.amountPaid ? 'cash' : 'credit',
      invoice_date: data.invoiceDate,
      expected_items_count: 0,
      expected_total_quantity: 0,
      expected_grand_total: 0,
      actual_items_count: data.items.length,
      actual_total_quantity: data.items.reduce((s, i) => s + i.quantity, 0),
      actual_grand_total: data.items.reduce((s, i) => s + i.quantity * i.cost_price, 0),
      status: 'draft',
      notes: data.notes || null,
      image_url: data.imageUrl || null,
    });

    const { data: invoice, error: invError } = await supabase
      .from('purchase_invoices')
      .insert(invPayload as never)
      .select()
      .single();

    if (invError || !invoice) {
      throw new Error(`فشل إنشاء فاتورة المشتريات: ${extractErrorMessage(invError)}`);
    }
    invoiceId = invoice.id;
  }

  const itemRows = data.items.map(item => filterTablePayload('purchase_invoice_items', {
    invoice_id: invoiceId,
    product_name: item.product_name,
    barcode: item.barcode || null,
    category: item.category || null,
    quantity: item.quantity,
    cost_price: item.cost_price,
    sale_price: item.sale_price || 0,
    total_cost: item.quantity * item.cost_price,
    product_id: item.product_id || null,
  }));

  if (itemRows.length === 0) {
    throw new Error('Invalid item: purchase invoice has no items');
  }

  const { error: itemsError } = await supabase
    .from('purchase_invoice_items')
    .insert(itemRows as never);
  if (itemsError) {
    throw new Error(`فشل إضافة بنود الفاتورة: ${extractErrorMessage(itemsError)}`);
  }

  await finalizeOrThrow(invoiceId as string);
  return true;
}

