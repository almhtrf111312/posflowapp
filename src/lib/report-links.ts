/**
 * روابط الانتقال من التقارير إلى صفحة الفواتير مع الفلاتر نفسها،
 * ومع الوقوف على فاتورة محددة عند تمرير معرّفها.
 */
export interface InvoiceLinkParams {
  type?: 'sale' | 'maintenance' | 'purchase' | string;
  payment?: 'cash' | 'debt' | 'card' | string;
  from?: string;
  to?: string;
  refunded?: boolean;
  invoice?: string;
  /** نص بحث (مثل اسم العميل) */
  q?: string;
}

export function invoicesLink(p: InvoiceLinkParams): string {
  const q = new URLSearchParams();
  if (p.type) q.set('type', p.type);
  if (p.payment) q.set('payment', p.payment);
  if (p.from) q.set('from', p.from);
  if (p.to) q.set('to', p.to);
  if (p.refunded) q.set('refunded', '1');
  if (p.invoice) q.set('invoice', p.invoice);
  if (p.q) q.set('q', p.q);
  const s = q.toString();
  return s ? `/invoices?${s}` : '/invoices';
}

/** صنف بطاقة/صف قابل للنقر بشكل موحد */
export const clickableClass = 'cursor-pointer hover:border-primary/50 hover:bg-primary/5 active:scale-[0.99] transition-[colors,transform]';
