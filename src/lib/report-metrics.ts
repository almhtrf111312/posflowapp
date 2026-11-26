/**
 * مقاييس موحّدة للتقارير (دالة نقية بلا تخزين ولا شبكة).
 *
 * القاعدة المعتمدة في كل التقارير:
 * - المبيعات المعروضة = إجمالي الفاتورة شاملاً الضريبة (قرار المالك 2026-11-26)، مثل الإغلاق اليومي.
 *   الضريبة تُعرض منفصلة في تقرير الضريبة، والربح يُحسب دائماً بدون الضريبة (F-07).
 * - الفاتورة المعدومة تبقى ضمن المبيعات؛ المستردة والملغاة تُستبعد.
 * - تكلفة البند هي تكلفته لحظة البيع (item.costPrice)، ولا يُرجع لتكلفة الكتالوج الحالية
 *   إلا إذا لم تُحفظ مع البند، حتى لا يتغير التاريخ عند تعديل سعر التكلفة لاحقاً.
 * - الربح السالب (بيع بخسارة) يظهر بقيمته ولا يُخفى كصفر.
 */

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export interface MetricInvoice {
  type?: string;
  status?: string;
  total?: number;
  taxAmount?: number;
  taxRate?: number;
  taxMode?: 'inclusive' | 'exclusive' | string;
}

export interface MetricItem {
  id?: string;
  name?: string;
  price?: number;
  quantity?: number;
  total?: number;
  costPrice?: number | null;
  profit?: number | null;
  refunded?: boolean;
}

/** هل تدخل الفاتورة في المبيعات؟ (بيع أو صيانة، غير مستردة ولا ملغاة) */
export function isSalesInvoice(inv: MetricInvoice): boolean {
  if (inv.status === 'refunded' || inv.status === 'cancelled') return false;
  if (inv.type && inv.type !== 'sale' && inv.type !== 'maintenance') return false;
  return true;
}

/** مبيعات الفاتورة شاملة الضريبة (الرقم المعروض كـ«المبيعات» في كل التقارير) */
export function invoiceGrossSales(inv: MetricInvoice): number {
  return num(inv.total);
}

/** مبيعات الفاتورة بدون الضريبة (تقرير الضريبة وإقفال الفترة فقط) */
export function invoiceNetSales(inv: MetricInvoice): number {
  return num(inv.total) - num(inv.taxAmount);
}

const isInclusive = (inv: MetricInvoice) =>
  inv.taxMode === 'inclusive' || Boolean((inv as { tax_inclusive?: boolean }).tax_inclusive);

/** إيراد البند بدون الضريبة */
export function itemNetRevenue(item: MetricItem, inv: MetricInvoice): number {
  const qty = num(item.quantity ?? 1);
  const gross = item.total !== undefined && item.total !== null ? num(item.total) : num(item.price) * qty;
  const rate = num(inv.taxRate);
  return isInclusive(inv) && rate > 0 ? gross / (1 + rate / 100) : gross;
}

/** تكلفة البند لحظة البيع، أو تكلفة الكتالوج إن لم تُحفظ مع البند */
export function itemUnitCost(item: MetricItem, catalogCost?: number | null): number {
  if (item.costPrice !== undefined && item.costPrice !== null && Number.isFinite(Number(item.costPrice))) {
    return Number(item.costPrice);
  }
  return num(catalogCost);
}

/** ربح البند: المحفوظ مع البند إن وُجد (بما فيه السالب)، وإلا الإيراد الصافي − التكلفة */
export function itemProfit(item: MetricItem, inv: MetricInvoice, catalogCost?: number | null): number {
  const stored = item.profit;
  if (stored !== undefined && stored !== null && Number.isFinite(Number(stored)) && Number(stored) !== 0) {
    return Number(stored);
  }
  return itemNetRevenue(item, inv) - itemUnitCost(item, catalogCost) * num(item.quantity ?? 1);
}
