import { invoiceNetSales, isSalesInvoice, itemNetRevenue, itemProfit, itemUnitCost } from '../report-metrics';

function eq(actual: number | boolean, expected: number | boolean, message: string) {
  const ok = typeof expected === 'number' ? Math.abs(Number(actual) - expected) < 1e-6 : actual === expected;
  if (!ok) throw new Error(`${message}: expected ${expected}, got ${actual}`);
  console.log(`PASS ${message}`);
}

// المبيعات بدون الضريبة
eq(invoiceNetSales({ total: 118, taxAmount: 18 }), 100, 'net sales excludes tax');
// المعدومة ضمن المبيعات، المستردة والملغاة والمشتريات لا
eq(isSalesInvoice({ type: 'sale', status: 'written_off' }), true, 'written-off counts as sales');
eq(isSalesInvoice({ type: 'sale', status: 'refunded' }), false, 'refunded excluded');
eq(isSalesInvoice({ type: 'sale', status: 'cancelled' }), false, 'cancelled excluded');
eq(isSalesInvoice({ type: 'purchase', status: 'paid' }), false, 'purchase excluded');
// إيراد البند مع ضريبة شاملة 10%
eq(itemNetRevenue({ price: 110, quantity: 2, total: 220 }, { taxMode: 'inclusive', taxRate: 10 }), 200, 'inclusive tax removed from item');
eq(itemNetRevenue({ price: 100, quantity: 2 }, { taxMode: 'exclusive', taxRate: 10 }), 200, 'exclusive price already net');
// تكلفة لحظة البيع تتقدم على تكلفة الكتالوج الحالية
eq(itemUnitCost({ costPrice: 60 }, 80), 60, 'sale-time cost wins over catalog');
eq(itemUnitCost({}, 80), 80, 'catalog cost used when sale-time cost missing');
// البيع بخسارة يظهر سالباً
eq(itemProfit({ price: 50, quantity: 2, total: 100, costPrice: 70 }, {}), -40, 'loss shown as negative');
eq(itemProfit({ price: 50, quantity: 1, total: 50, profit: 12 }, {}), 12, 'stored item profit used');
