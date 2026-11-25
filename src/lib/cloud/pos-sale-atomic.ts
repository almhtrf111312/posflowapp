import { supabase } from '@/integrations/supabase/client';


import { emitEvent, EVENTS } from '@/lib/events';
import { getSelectedSerials, clearSelectedSerials, confirmSerialsSynced } from '@/lib/serials-store';

import { invalidateInvoicesCache } from './invoices-cloud';
import { invalidatePartnersCache } from './partners-cloud';

import { isGuestDemoMode } from '@/lib/demo-data';

import { round8 } from '@/lib/money-engine';
import { markSaleAsSyncedInNativeSQLite } from '@/lib/db/sales-storage-bridge';



const sb = supabase;



export interface AtomicSaleBundle {

  customerId?: string;

  customerName: string;

  paymentMethod?: 'cash' | 'digital';
  /** Open cash shift the sale's drawer movement is posted to in the SAME transaction (audit F1, 2026-11-24). */
  drawerShiftId?: string | null;
  /** Amount in the received currency for the drawer movement (optional; the server derives it from the rate). */
  drawerCurrencyAmount?: number | null;
  /** Time the sale was made (stamped on the client). Sent to the server only for a delayed posting, see saleAtForPosting (2026-11-24). */
  saleAt?: string | null;

  customerPhone?: string;

  taxMode?: 'inclusive' | 'exclusive';

  items: Array<{

    id: string;

    name: string;

    price: number;

    quantity: number;

    total?: number;

    costPrice?: number;

    profit?: number;

    unit?: 'piece' | 'bulk';

    conversionFactor?: number;

    serials?: string[];

  }>;

  stockItems: Array<{ productId: string; quantity: number; productName?: string }>;

  subtotal: number;

  discount: number;

  discountPercentage?: number;

  taxRate?: number;

  taxAmount?: number;

  total: number;

  currency: string;

  currencySymbol?: string;

  currencyName?: string;

  exchangeRate?: number;

  profit: number;

  warehouseId?: string;

  /** دفعة أولى مقبوضة نقداً عند البيع المؤجل (بالدولار) — تُخصم من الدين */

  downPayment?: number;

}





/**
 * Original sale time to post with, or null when the sale is posted right away (the server then uses its own time).
 * Only a sale posted more than 2 minutes after it was made carries its time, so an online sale never depends on the
 * device clock. Both times come from the same device clock, so a wrong clock cannot shift a sale made on time.
 */
export const saleAtForPosting = (saleAt: string | null | undefined, nowMs: number = Date.now()): string | null => {
  if (!saleAt) return null;
  const t = Date.parse(saleAt);
  if (!Number.isFinite(t)) return null;
  return nowMs - t > 2 * 60 * 1000 ? new Date(t).toISOString() : null;
};

export interface AtomicSaleResult {

  success: boolean;

  alreadyProcessed: boolean;
  /** True when the server posted the drawer movement together with the invoice (audit F1). */
  drawerPostedOnServer?: boolean;

  invoiceId: string;

  invoiceNumber: string;

  /** القيم المعتمدة من الخادم (بالدولار) — مصدر الحقيقة بعد المزامنة */

  subtotal?: number;

  discount?: number;

  taxAmount?: number;

  total?: number;

  cogs?: number;

  profit?: number;

  debtPaid?: number;

  debtRemaining?: number;

  /** البيع تجاوز المخزون المتاح (عجز مسجّل، لم يُوقف الفاتورة) */

  stockShortage?: boolean;

}



/**

 * التحقق مما إذا كان النص UUID صالحاً

 */

function isValidUUID(str: string): boolean {

  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(str);

}



/**

 * بناء مصفوفة الأصناف بالتنسيق الدقيق الذي تتوقعه دالة process_pos_sale_atomic

 */

function buildRpcItems(bundle: AtomicSaleBundle) {

  // الاعتماد مباشرة على bundle.items بالكميات المباعة الفعلية لمنع مضاعفة معامل التحويل

  return bundle.items.map(item => {

    if (!item.id || !isValidUUID(item.id)) {

      throw new Error(`Invalid item: product "${item.name}" is not synced yet`);

    }



    const quantity = Math.round(Number(item.quantity) * 1000) / 1000;

    if (!Number.isFinite(quantity) || quantity <= 0) {

      throw new Error(`Invalid item quantity for ${item.name}`);

    }



    const lineTotalUSD = round8(item.total ?? (item.price * item.quantity));

    return {

      product_id: item.id,

      product_name: item.name,

      quantity,

      price: round8(item.price),
      unit_price: round8(item.price),

      cost_price: round8(item.costPrice || 0),

      amount_original: lineTotalUSD,

      amount_usd: lineTotalUSD,

      profit: round8(item.profit || 0),

      unit: item.unit || 'piece',

      conversion_factor: item.conversionFactor || 1,
      ...((item.serials?.length ? item.serials : getSelectedSerials(item.id))?.length ? { serials: (item.serials?.length ? item.serials : getSelectedSerials(item.id)) } : {}),

    };

  });

}



export async function processPosSaleAtomic(

  operationId: string,

  paymentType: 'cash' | 'debt',

  bundle: AtomicSaleBundle,

): Promise<AtomicSaleResult> {

  if (isGuestDemoMode()) {

    return {

      success: true,

      alreadyProcessed: false,

      invoiceId: operationId,

      invoiceNumber: `INV-DEMO-${Date.now().toString().slice(-4)}`,

      subtotal: bundle.subtotal,

      discount: bundle.discount,

      taxAmount: bundle.taxAmount || 0,

      total: bundle.total,

      cogs: 0,

      profit: bundle.profit,

      debtPaid: bundle.downPayment || 0,

      debtRemaining: Math.max(0, bundle.total - (bundle.downPayment || 0)),

      stockShortage: false,

    };

  }



  if (!operationId || operationId.length < 8) throw new Error('Missing or invalid sale operation id');



  const rpcItems = buildRpcItems(bundle);



  // ✅ المحاولة الأولى: استدعاء الدالة الذرية process_pos_sale_atomic

  try {

    // audit F1 (2026-11-24): a cash sale with an open shift posts the invoice and its drawer movement in one transaction.
    // Every sale now uses the wrapper (it also takes the sale time, migration 20261124080600); without a shift it only posts the invoice.
    const useDrawerRpc = paymentType === 'cash' && bundle.paymentMethod !== 'digital' && Boolean(bundle.drawerShiftId);
    const { data, error } = await sb.rpc('process_pos_sale_with_drawer_atomic', {

      _operation_id: operationId,

      _payment_type: paymentType,

      _customer_name: bundle.customerName,

      _customer_phone: bundle.customerPhone || '',

      _subtotal: round8(bundle.subtotal),

      _discount: round8(bundle.discount),

      _discount_percentage: bundle.discountPercentage || 0,

      _tax_rate: bundle.taxRate || 0,

      _tax_amount: round8(bundle.taxAmount || 0),

      _total: round8(bundle.total),

      _profit: round8(bundle.profit),

      _currency: bundle.currency,

      _warehouse_id: (bundle.warehouseId && isValidUUID(bundle.warehouseId)) ? bundle.warehouseId : null,

      _items: rpcItems,

      _down_payment: paymentType === 'debt'

        ? Math.max(0, Math.min(Number(bundle.downPayment || 0), Number(bundle.total || 0)))

        : 0,

      _exchange_rate: Number(bundle.exchangeRate) || 1,

      _tax_mode: bundle.taxMode || 'exclusive',
      _shift_id: useDrawerRpc ? (bundle.drawerShiftId ?? null) : null,
      _currency_amount: useDrawerRpc ? (bundle.drawerCurrencyAmount ?? null) : null,
      _sale_at: saleAtForPosting(bundle.saleAt),
    });



    if (error) {

      const errorObj = error as unknown as Record<string, unknown>;

      const detailedMsg = error.message || (typeof errorObj?.details === 'string' ? errorObj.details : '') || 'فشل تنفيذ البيع الذري';

      console.error('[AtomicSale] RPC error:', detailedMsg, error);

      throw new Error(detailedMsg);

    }



    const row = Array.isArray(data) ? data[0] : data;
    const drawerPostedOnServer = useDrawerRpc;

    if (!row?.success || !row.invoice_id || !row.invoice_number) {

      throw new Error('Atomic sale returned an invalid result');

    }



    clearSelectedSerials(bundle.items.map(i => i.id));
    confirmSerialsSynced(bundle.items.flatMap(i => i.serials || []));
    invalidateInvoicesCache();
    invalidatePartnersCache();

    emitEvent(EVENTS.INVOICES_UPDATED, null);

    if (paymentType === 'debt') emitEvent(EVENTS.DEBTS_UPDATED, null);
    markSaleAsSyncedInNativeSQLite(row.invoice_id, row.invoice_number, operationId).catch(() => {});
    if (bundle.paymentMethod === 'digital') {
      try {
        const { error: dErr } = await sb.rpc('mark_invoice_digital', { _invoice_number: row.invoice_number });
        if (dErr) throw dErr;
      } catch {
        try {
          const k = 'posflow_pending_digital_marks';
          const q: string[] = JSON.parse(localStorage.getItem(k) || '[]');
          if (!q.includes(row.invoice_number)) q.push(row.invoice_number);
          localStorage.setItem(k, JSON.stringify(q));
        } catch { /* ignore */ }
      }
    }
    // إعادة محاولة وسم الفواتير الرقمية التي فشل وسمها سابقاً
    try {
      const k = 'posflow_pending_digital_marks';
      const q: string[] = JSON.parse(localStorage.getItem(k) || '[]');
      if (q.length > 0) {
        const left: string[] = [];
        for (const n of q) {
          const { error: e2 } = await sb.rpc('mark_invoice_digital', { _invoice_number: n });
          if (e2) left.push(n);
        }
        localStorage.setItem(k, JSON.stringify(left));
      }
    } catch { /* ignore */
    }



    if (row.stock_shortage) {

      console.warn('[AtomicSale] Sale synced with stock shortage (negative stock recorded):', row.invoice_number);

    }



    // audit F2 (2026-11-24): the server is the authority for tax and total. A different total is shown and logged,
    // never silently replaced on the device.
    if (!row.already_processed && Math.abs((Number(row.total) || 0) - round8(bundle.total)) > 0.005) {
      const serverTotal = Number(row.total) || 0;
      import('@/lib/sonner-bridge').then(({ toast }) => toast.warning(
        `تعديل من الخادم: إجمالي الفاتورة ${row.invoice_number} أصبح ${serverTotal} (كان ${round8(bundle.total)} على الجهاز). راجع الفاتورة.`,
        { duration: 9000 },
      )).catch(() => {});
      import('@/lib/activity-log').then(({ logActivity }) => logActivity(
        'sale_total_mismatch',
        `فاتورة ${row.invoice_number}: إجمالي الجهاز ${round8(bundle.total)} والخادم ${serverTotal}`,
        { invoiceNumber: row.invoice_number, deviceTotal: round8(bundle.total), serverTotal, taxRate: (row as { tax_rate?: number | null }).tax_rate ?? null },
      )).catch(() => {});
    }

    return {

      success: true,

      alreadyProcessed: Boolean(row.already_processed),
      drawerPostedOnServer,

      invoiceId: row.invoice_id,

      invoiceNumber: row.invoice_number,

      subtotal: Number(row.subtotal) || 0,

      discount: Number(row.discount) || 0,

      taxAmount: Number(row.tax_amount) || 0,

      total: Number(row.total) || 0,

      cogs: Number(row.cogs) || 0,

      profit: Number(row.profit) || 0,

      debtPaid: Number(row.debt_paid) || 0,

      debtRemaining: Number(row.debt_remaining) || 0,

      stockShortage: Boolean(row.stock_shortage),

    };

  } catch (rpcError) {

    // ⚠️ تم تعطيل الإدراج البديل المباشر: كان يحفظ الفاتورة بدون خصم مخزون

    // (يستدعي دالة غير موجودة) وبأعمدة غير صحيحة للبنود. العملية الذرية آمنة

    // للتكرار، لذا نترك العملية في طابور المزامنة لإعادة المحاولة.

    console.warn('[AtomicSale] RPC failed, keeping operation queued for retry:', rpcError);

    throw rpcError instanceof Error ? rpcError : new Error(String(rpcError));

  }

}

