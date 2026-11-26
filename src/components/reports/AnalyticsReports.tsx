/**
 * تقارير تحليلية مبنية من بيانات موجودة أصلاً (فواتير، منتجات، ديون) دون أي جدول جديد:
 * ربحية المنتجات، أعمار الديون، المرتجعات والخصومات، ملخص الضريبة، الأصناف الراكدة.
 * كل المبالغ بالدولار (عملة الأساس) وتُعرض/تُصدَّر بعملة التقرير.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { DollarSign, Clock, Undo2, Receipt, AlertTriangle, Package } from 'lucide-react';
import { ReportShell } from './ReportShell';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import type { Invoice } from '@/lib/cloud/invoices-cloud';
import type { Product } from '@/lib/cloud/products-cloud';
import type { Debt } from '@/lib/cloud/debts-cloud';
import { exportGenericToExcel, exportGenericToPDF, type ExportOptions } from '@/lib/reports/dataset-builder';
import { formatReportAmount, formatNumber, cn } from '@/lib/utils';
import { toLocalDateString, isDateInRange, getTodayLocal } from '@/lib/date-utils';
import { useNavigate } from 'react-router-dom';
import { invoicesLink } from '@/lib/report-links';
import { isSalesInvoice, invoiceNetSales, invoiceGrossSales, itemNetRevenue, itemProfit, itemUnitCost } from '@/lib/report-metrics';

type Range = { from: string; to: string };
const subtitleOf = (r: Range) => `الفترة من ${r.from} إلى ${r.to}`;
const runExport = (kind: 'pdf' | 'excel', opts: ExportOptions) =>
  kind === 'pdf' ? exportGenericToPDF(opts) : exportGenericToExcel(opts);
const findProduct = (products: Product[], it: { id?: string; name?: string }) =>
  products.find(p => p.id === it.id) || products.find(p => p.name === it.name);

function Empty({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <Card><CardContent className="py-12 text-center text-sm text-muted-foreground">
      <div className="w-10 h-10 mx-auto mb-3 opacity-40 flex items-center justify-center">{icon}</div>
      {text}
    </CardContent></Card>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="bg-card rounded-xl border border-border p-3">
      <p className={cn('text-base font-bold', tone)}>{value}</p>
      <p className="text-[11px] text-muted-foreground">{label}</p>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* 1) ربحية المنتجات                                                  */
/* ---------------------------------------------------------------- */
export function ProductProfitReport({ invoices, products, dateRange }: { invoices: Invoice[]; products: Product[]; dateRange: Range }) {
  const rows = useMemo(() => {
    const map = new Map<string, { id: string; name: string; category: string; qty: number; revenue: number; cost: number; profit: number }>();
    invoices.forEach(inv => {
      if (!isSalesInvoice(inv)) return;
      if (!isDateInRange(toLocalDateString(inv.createdAt), dateRange.from, dateRange.to)) return;
      (inv.items || []).forEach(it => {
        if (it.refunded) return;
        const p = findProduct(products, it);
        const key = it.id || it.name;
        const cur = map.get(key) || { id: key, name: it.name, category: p?.category || 'بدون تصنيف', qty: 0, revenue: 0, cost: 0, profit: 0 };
        cur.qty += Number(it.quantity || 0);
        cur.revenue += itemNetRevenue(it, inv);
        cur.cost += itemUnitCost(it, p?.costPrice) * Number(it.quantity || 0);
        cur.profit += itemProfit(it, inv, p?.costPrice);
        map.set(key, cur);
      });
    });
    return Array.from(map.values())
      .map(r => ({ ...r, margin: r.revenue > 0 ? (r.profit / r.revenue) * 100 : 0 }))
      .sort((a, b) => b.profit - a.profit);
  }, [invoices, products, dateRange.from, dateRange.to]);

  const totals = useMemo(() => ({
    revenue: rows.reduce((s, r) => s + r.revenue, 0),
    cost: rows.reduce((s, r) => s + r.cost, 0),
    profit: rows.reduce((s, r) => s + r.profit, 0),
    losing: rows.filter(r => r.profit < 0).length,
  }), [rows]);

  const exportAs = (kind: 'pdf' | 'excel') => runExport(kind, {
    title: 'ربحية المنتجات',
    subtitle: subtitleOf(dateRange),
    columns: [
      { key: 'name', label: 'المنتج' },
      { key: 'category', label: 'التصنيف' },
      { key: 'qty', label: 'الكمية المباعة', kind: 'quantity' },
      { key: 'revenue', label: 'الإيراد (بدون ضريبة)', kind: 'money' },
      { key: 'cost', label: 'التكلفة', kind: 'money' },
      { key: 'profit', label: 'الربح', kind: 'money' },
      { key: 'marginLabel', label: 'الهامش %' },
    ],
    rows: rows.map(r => ({ ...r, marginLabel: `${r.margin.toFixed(1)}%` })),
    totals: { revenue: totals.revenue, cost: totals.cost, profit: totals.profit },
    summary: [
      { label: 'عدد الأصناف', value: rows.length },
      { label: 'إجمالي الربح', value: formatReportAmount(totals.profit) },
      { label: 'أصناف بخسارة', value: totals.losing },
    ],
    fileName: `product-profit-${dateRange.from}-${dateRange.to}.${kind === 'pdf' ? 'pdf' : 'xlsx'}`,
  });

  return (
    <ReportShell
      icon={<DollarSign className="w-5 h-5" />}
      title="ربحية المنتجات"
      subtitle="ربح كل صنف بتكلفته لحظة البيع، والإيراد بدون الضريبة"
      onExportPDF={() => exportAs('pdf')}
      onExportExcel={() => exportAs('excel')}
      exportDisabled={rows.length === 0}
    >
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
        <Stat label="الإيراد" value={formatReportAmount(totals.revenue)} />
        <Stat label="التكلفة" value={formatReportAmount(totals.cost)} />
        <Stat label="الربح" value={formatReportAmount(totals.profit)} tone={totals.profit >= 0 ? 'text-success' : 'text-destructive'} />
        <Stat label="أصناف بخسارة" value={formatNumber(totals.losing)} tone={totals.losing > 0 ? 'text-destructive' : undefined} />
      </div>
      {rows.length === 0 ? <Empty icon={<Package />} text="لا توجد مبيعات في هذه الفترة" /> : (
        <Card><CardContent className="p-0 divide-y divide-border/40">
          {rows.map(r => (
            <div key={r.id} className="flex items-center gap-2 p-2.5">
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold truncate">{r.name}</p>
                <p className="text-xs text-muted-foreground">
                  {r.category} • كمية {formatNumber(r.qty)} • إيراد {formatReportAmount(r.revenue)} • تكلفة {formatReportAmount(r.cost)}
                </p>
              </div>
              <div className="text-end shrink-0">
                <p className={cn('text-xs font-bold', r.profit >= 0 ? 'text-success' : 'text-destructive')}><span dir="ltr" className="inline-block tabular-nums">{formatReportAmount(r.profit)}</span></p>
                <p className="text-xs text-muted-foreground"><span dir="ltr" className="inline-block tabular-nums">{r.margin.toFixed(1)}%</span></p>
              </div>
            </div>
          ))}
        </CardContent></Card>
      )}
    </ReportShell>
  );
}

/* ---------------------------------------------------------------- */
/* 2) أعمار الديون                                                    */
/* ---------------------------------------------------------------- */
const AGING_BUCKETS = [
  { id: 'notDue', label: 'لم يستحق بعد' },
  { id: 'd30', label: 'متأخر 1–30 يوماً' },
  { id: 'd60', label: 'متأخر 31–60 يوماً' },
  { id: 'd90', label: 'متأخر 61–90 يوماً' },
  { id: 'd90p', label: 'متأخر أكثر من 90 يوماً' },
] as const;
type BucketId = typeof AGING_BUCKETS[number]['id'];

const daysBetween = (fromDay: string, toDay: string) =>
  Math.round((new Date(toDay + 'T00:00:00').getTime() - new Date(fromDay + 'T00:00:00').getTime()) / 86400000);

export function ReceivablesAgingReport({ debts }: { debts: Debt[] }) {
  const navigate = useNavigate();
  const today = getTodayLocal();
  const rows = useMemo(() => debts
    .filter(d => !d.isWrittenOff && Number(d.remainingDebt || 0) > 0)
    .map(d => {
      // الاستحقاق من تاريخ الاستحقاق، وإن لم يوجد فمن تاريخ إنشاء الدين
      const dueDay = d.dueDate ? d.dueDate.slice(0, 10) : toLocalDateString(d.createdAt);
      const overdueDays = daysBetween(dueDay, today);
      const bucket: BucketId = overdueDays <= 0 ? 'notDue' : overdueDays <= 30 ? 'd30' : overdueDays <= 60 ? 'd60' : overdueDays <= 90 ? 'd90' : 'd90p';
      return {
        id: d.id, customer: d.customerName || 'عميل', phone: d.customerPhone || '-', dueDay,
        overdueDays: Math.max(0, overdueDays), remaining: Number(d.remainingDebt || 0), bucket,
        bucketLabel: AGING_BUCKETS.find(b => b.id === bucket)!.label,
      };
    })
    .sort((a, b) => b.overdueDays - a.overdueDays), [debts, today]);

  const byBucket = useMemo(() => AGING_BUCKETS.map(b => ({
    ...b,
    amount: rows.filter(r => r.bucket === b.id).reduce((s, r) => s + r.remaining, 0),
    count: rows.filter(r => r.bucket === b.id).length,
  })), [rows]);
  const total = rows.reduce((s, r) => s + r.remaining, 0);

  const exportAs = (kind: 'pdf' | 'excel') => runExport(kind, {
    title: 'أعمار الديون',
    subtitle: `حتى تاريخ ${today}`,
    columns: [
      { key: 'customer', label: 'العميل' },
      { key: 'phone', label: 'الهاتف' },
      { key: 'dueDay', label: 'تاريخ الاستحقاق' },
      { key: 'overdueDays', label: 'أيام التأخير', kind: 'quantity' },
      { key: 'bucketLabel', label: 'الفئة' },
      { key: 'remaining', label: 'المتبقي', kind: 'money' },
    ],
    rows,
    totals: { remaining: total },
    summary: byBucket.map(b => ({ label: b.label, value: formatReportAmount(b.amount) })),
    fileName: `receivables-aging-${today}.${kind === 'pdf' ? 'pdf' : 'xlsx'}`,
  });

  return (
    <ReportShell
      icon={<Clock className="w-5 h-5" />}
      title="أعمار الديون"
      subtitle="الديون المفتوحة مصنفة حسب مدة التأخير عن تاريخ الاستحقاق (المشطوبة مستبعدة)"
      onExportPDF={() => exportAs('pdf')}
      onExportExcel={() => exportAs('excel')}
      exportDisabled={rows.length === 0}
    >
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-3">
        {byBucket.map(b => (
          <div key={b.id}>
            <Stat label={`${b.label} (${b.count})`} value={formatReportAmount(b.amount)}
              tone={b.id === 'd90p' && b.amount > 0 ? 'text-destructive' : undefined} />
          </div>
        ))}
      </div>
      {rows.length === 0 ? <Empty icon={<Clock />} text="لا توجد ديون مفتوحة" /> : (
        <Card><CardContent className="p-0 divide-y divide-border/40">
          {rows.map(r => (
            <div key={r.id} className="flex items-center gap-2 p-2.5 cursor-pointer hover:bg-muted/40"
              onClick={() => navigate(invoicesLink({ payment: 'debt', q: r.customer }))}>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold truncate">{r.customer}</p>
                <p className="text-xs text-muted-foreground">استحقاق {r.dueDay} • {r.bucketLabel}</p>
              </div>
              <div className="text-end shrink-0">
                <p className="text-xs font-bold"><span dir="ltr" className="inline-block tabular-nums">{formatReportAmount(r.remaining)}</span></p>
                {r.overdueDays > 0 && <p className="text-xs text-destructive">{formatNumber(r.overdueDays)} يوم</p>}
              </div>
            </div>
          ))}
        </CardContent></Card>
      )}
    </ReportShell>
  );
}

/* ---------------------------------------------------------------- */
/* 3) المرتجعات والخصومات                                             */
/* ---------------------------------------------------------------- */
export function ReturnsDiscountsReport({ invoices, dateRange }: { invoices: Invoice[]; dateRange: Range }) {
  const navigate = useNavigate();
  const [view, setView] = useState<'returns' | 'discounts'>('returns');

  const returns = useMemo(() => invoices
    .filter(inv => (inv.type === 'sale' || inv.type === 'maintenance') && inv.status === 'refunded')
    // تاريخ الاسترداد = آخر تعديل للفاتورة المستردة
    .map(inv => ({ inv, day: toLocalDateString(inv.updatedAt || inv.createdAt) }))
    .filter(r => isDateInRange(r.day, dateRange.from, dateRange.to))
    .map(({ inv, day }) => ({
      id: inv.id, day, saleDay: toLocalDateString(inv.createdAt),
      customer: inv.customerName || 'عميل نقدي', cashier: inv.cashierName || '-',
      amount: invoiceGrossSales(inv),
    }))
    .sort((a, b) => b.day.localeCompare(a.day)), [invoices, dateRange.from, dateRange.to]);

  const discounts = useMemo(() => invoices
    .filter(inv => isSalesInvoice(inv) && Number(inv.discount || 0) > 0)
    .filter(inv => isDateInRange(toLocalDateString(inv.createdAt), dateRange.from, dateRange.to))
    .map(inv => ({
      id: inv.id, day: toLocalDateString(inv.createdAt),
      customer: inv.customerName || 'عميل نقدي', cashier: inv.cashierName || '-',
      amount: Number(inv.discount || 0), invoiceTotal: invoiceGrossSales(inv),
    }))
    .sort((a, b) => b.day.localeCompare(a.day)), [invoices, dateRange.from, dateRange.to]);

  const totalReturns = returns.reduce((s, r) => s + r.amount, 0);
  const totalDiscounts = discounts.reduce((s, r) => s + r.amount, 0);
  const list = view === 'returns' ? returns : discounts;

  const exportAs = (kind: 'pdf' | 'excel') => runExport(kind, {
    title: view === 'returns' ? 'المرتجعات' : 'الخصومات',
    subtitle: subtitleOf(dateRange),
    columns: view === 'returns'
      ? [
        { key: 'day', label: 'تاريخ الاسترداد' },
        { key: 'saleDay', label: 'تاريخ البيع' },
        { key: 'customer', label: 'العميل' },
        { key: 'cashier', label: 'الكاشير' },
        { key: 'amount', label: 'المبلغ المسترد (بدون ضريبة)', kind: 'money' },
      ]
      : [
        { key: 'day', label: 'التاريخ' },
        { key: 'customer', label: 'العميل' },
        { key: 'cashier', label: 'الكاشير' },
        { key: 'invoiceTotal', label: 'صافي الفاتورة', kind: 'money' },
        { key: 'amount', label: 'الخصم', kind: 'money' },
      ],
    rows: list,
    totals: { amount: view === 'returns' ? totalReturns : totalDiscounts },
    summary: [
      { label: 'عدد المرتجعات', value: returns.length },
      { label: 'قيمة المرتجعات', value: formatReportAmount(totalReturns) },
      { label: 'عدد الفواتير المخصومة', value: discounts.length },
      { label: 'قيمة الخصومات', value: formatReportAmount(totalDiscounts) },
    ],
    fileName: `${view}-${dateRange.from}-${dateRange.to}.${kind === 'pdf' ? 'pdf' : 'xlsx'}`,
  });

  return (
    <ReportShell
      icon={<Undo2 className="w-5 h-5" />}
      title="المرتجعات والخصومات"
      subtitle="الفواتير المستردة خلال الفترة، والخصومات الممنوحة على المبيعات"
      onExportPDF={() => exportAs('pdf')}
      onExportExcel={() => exportAs('excel')}
      exportDisabled={list.length === 0}
      filters={
        <div className="flex gap-1.5">
          <Button size="sm" variant={view === 'returns' ? 'default' : 'outline'} className="text-xs rounded-xl flex-1" onClick={() => setView('returns')}>المرتجعات (<span dir="ltr" className="inline-block tabular-nums">{returns.length}</span>)</Button>
          <Button size="sm" variant={view === 'discounts' ? 'default' : 'outline'} className="text-xs rounded-xl flex-1" onClick={() => setView('discounts')}>الخصومات (<span dir="ltr" className="inline-block tabular-nums">{discounts.length}</span>)</Button>
        </div>
      }
    >
      <div className="grid grid-cols-2 gap-2 mb-3">
        <Stat label="قيمة المرتجعات" value={formatReportAmount(totalReturns)} tone="text-destructive" />
        <Stat label="قيمة الخصومات" value={formatReportAmount(totalDiscounts)} tone="text-warning" />
      </div>
      {list.length === 0 ? <Empty icon={<Undo2 />} text={view === 'returns' ? 'لا توجد مرتجعات في هذه الفترة' : 'لا توجد خصومات في هذه الفترة'} /> : (
        <Card><CardContent className="p-0 divide-y divide-border/40">
          {list.map(r => (
            <div key={r.id} className="flex items-center gap-2 p-2.5 cursor-pointer hover:bg-muted/40"
              onClick={() => navigate(invoicesLink({ invoice: r.id, refunded: view === 'returns' }))}>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold truncate">{r.customer}</p>
                <p className="text-xs text-muted-foreground">#{r.id} • {r.day} • {r.cashier}</p>
              </div>
              <p className="text-xs font-bold shrink-0"><span dir="ltr" className="inline-block tabular-nums">{formatReportAmount(r.amount)}</span></p>
            </div>
          ))}
        </CardContent></Card>
      )}
    </ReportShell>
  );
}

/* ---------------------------------------------------------------- */
/* 4) ملخص الضريبة                                                    */
/* ---------------------------------------------------------------- */
export function TaxSummaryReport({ invoices, dateRange }: { invoices: Invoice[]; dateRange: Range }) {
  const navigate = useNavigate();
  const { byRate, byDay, totals } = useMemo(() => {
    const rateMap = new Map<string, { rate: string; invoices: number; netSales: number; tax: number }>();
    const dayMap = new Map<string, { day: string; invoices: number; netSales: number; tax: number }>();
    invoices.forEach(inv => {
      if (!isSalesInvoice(inv)) return;
      const day = toLocalDateString(inv.createdAt);
      if (!isDateInRange(day, dateRange.from, dateRange.to)) return;
      const tax = Number(inv.taxAmount || 0);
      const net = invoiceNetSales(inv);
      const rate = `${Number(inv.taxRate || 0)}%`;
      const r = rateMap.get(rate) || { rate, invoices: 0, netSales: 0, tax: 0 };
      r.invoices += 1; r.netSales += net; r.tax += tax; rateMap.set(rate, r);
      const d = dayMap.get(day) || { day, invoices: 0, netSales: 0, tax: 0 };
      d.invoices += 1; d.netSales += net; d.tax += tax; dayMap.set(day, d);
    });
    const byRate = Array.from(rateMap.values()).sort((a, b) => b.tax - a.tax);
    const byDay = Array.from(dayMap.values()).sort((a, b) => a.day.localeCompare(b.day));
    return {
      byRate, byDay,
      totals: {
        invoices: byDay.reduce((s, d) => s + d.invoices, 0),
        netSales: byDay.reduce((s, d) => s + d.netSales, 0),
        tax: byDay.reduce((s, d) => s + d.tax, 0),
      },
    };
  }, [invoices, dateRange.from, dateRange.to]);

  const exportAs = (kind: 'pdf' | 'excel') => runExport(kind, {
    title: 'ملخص الضريبة',
    subtitle: subtitleOf(dateRange),
    columns: [
      { key: 'day', label: 'اليوم' },
      { key: 'invoices', label: 'عدد الفواتير', kind: 'quantity' },
      { key: 'netSales', label: 'المبيعات بدون ضريبة', kind: 'money' },
      { key: 'tax', label: 'الضريبة', kind: 'money' },
    ],
    rows: byDay,
    totals: { invoices: totals.invoices, netSales: totals.netSales, tax: totals.tax },
    summary: [
      { label: 'المبيعات بدون ضريبة', value: formatReportAmount(totals.netSales) },
      { label: 'إجمالي الضريبة', value: formatReportAmount(totals.tax) },
      ...byRate.map(r => ({ label: `ضريبة بنسبة ${r.rate}`, value: formatReportAmount(r.tax) })),
    ],
    fileName: `tax-summary-${dateRange.from}-${dateRange.to}.${kind === 'pdf' ? 'pdf' : 'xlsx'}`,
  });

  return (
    <ReportShell
      icon={<Receipt className="w-5 h-5" />}
      title="ملخص الضريبة"
      subtitle="الضريبة المحصلة على المبيعات خلال الفترة، حسب النسبة وحسب اليوم"
      onExportPDF={() => exportAs('pdf')}
      onExportExcel={() => exportAs('excel')}
      exportDisabled={byDay.length === 0}
    >
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-3">
        <Stat label="المبيعات بدون ضريبة" value={formatReportAmount(totals.netSales)} />
        <Stat label="إجمالي الضريبة" value={formatReportAmount(totals.tax)} tone="text-primary" />
        <Stat label="عدد الفواتير" value={formatNumber(totals.invoices)} />
      </div>
      {byDay.length === 0 ? <Empty icon={<Receipt />} text="لا توجد مبيعات في هذه الفترة" /> : (
        <div className="space-y-3">
          <Card><CardContent className="p-0 divide-y divide-border/40">
            <p className="p-2.5 text-xs font-bold">حسب النسبة</p>
            {byRate.map(r => (
              <div key={r.rate} className="flex items-center justify-between p-2.5 text-xs">
                <span>{r.rate} • {formatNumber(r.invoices)} فاتورة</span>
                <span className="font-bold">{formatReportAmount(r.tax)}</span>
              </div>
            ))}
          </CardContent></Card>
          <Card><CardContent className="p-0 divide-y divide-border/40">
            <p className="p-2.5 text-xs font-bold">حسب اليوم</p>
            {byDay.map(d => (
              <div key={d.day} className="flex items-center justify-between p-2.5 text-xs cursor-pointer hover:bg-muted/40"
                onClick={() => navigate(invoicesLink({ from: d.day, to: d.day }))}>
                <span>{d.day} • مبيعات {formatReportAmount(d.netSales)}</span>
                <span className="font-bold">{formatReportAmount(d.tax)}</span>
              </div>
            ))}
          </CardContent></Card>
        </div>
      )}
    </ReportShell>
  );
}

/* ---------------------------------------------------------------- */
/* 5) الأصناف الراكدة                                                 */
/* ---------------------------------------------------------------- */
export function SlowMovingStockReport({ invoices, products, dateRange }: { invoices: Invoice[]; products: Product[]; dateRange: Range }) {
  const rows = useMemo(() => {
    const soldInRange = new Map<string, number>();
    const lastSale = new Map<string, string>();
    invoices.forEach(inv => {
      if (!isSalesInvoice(inv)) return;
      const day = toLocalDateString(inv.createdAt);
      const inRange = isDateInRange(day, dateRange.from, dateRange.to);
      (inv.items || []).forEach(it => {
        const p = findProduct(products, it);
        if (!p) return;
        if (inRange) soldInRange.set(p.id, (soldInRange.get(p.id) || 0) + Number(it.quantity || 0));
        if ((lastSale.get(p.id) || '') < day) lastSale.set(p.id, day);
      });
    });
    return products
      .filter(p => Number(p.quantity || 0) > 0 && !soldInRange.get(p.id))
      .map(p => ({
        id: p.id, name: p.name, category: p.category || 'بدون تصنيف', barcode: p.barcode || '-',
        quantity: Number(p.quantity || 0),
        value: Number(p.quantity || 0) * Number(p.costPrice || 0),
        lastSale: lastSale.get(p.id) || 'لم يُبع أبداً',
      }))
      .sort((a, b) => b.value - a.value);
  }, [invoices, products, dateRange.from, dateRange.to]);

  const totalValue = rows.reduce((s, r) => s + r.value, 0);

  const exportAs = (kind: 'pdf' | 'excel') => runExport(kind, {
    title: 'الأصناف الراكدة',
    subtitle: `أصناف لديها رصيد ولم تُبع ${subtitleOf(dateRange)}`,
    columns: [
      { key: 'name', label: 'المنتج' },
      { key: 'category', label: 'التصنيف' },
      { key: 'barcode', label: 'الباركود' },
      { key: 'quantity', label: 'الرصيد', kind: 'quantity' },
      { key: 'value', label: 'قيمة الرصيد (تكلفة)', kind: 'money' },
      { key: 'lastSale', label: 'آخر بيع' },
    ],
    rows,
    totals: { quantity: rows.reduce((s, r) => s + r.quantity, 0), value: totalValue },
    summary: [
      { label: 'عدد الأصناف الراكدة', value: rows.length },
      { label: 'قيمة المخزون الراكد', value: formatReportAmount(totalValue) },
    ],
    fileName: `slow-moving-${dateRange.from}-${dateRange.to}.${kind === 'pdf' ? 'pdf' : 'xlsx'}`,
  });

  return (
    <ReportShell
      icon={<AlertTriangle className="w-5 h-5" />}
      title="الأصناف الراكدة"
      subtitle="أصناف لديها رصيد ولم يُبع منها شيء خلال الفترة المختارة، مرتبة حسب قيمة الرصيد"
      onExportPDF={() => exportAs('pdf')}
      onExportExcel={() => exportAs('excel')}
      exportDisabled={rows.length === 0}
    >
      <div className="grid grid-cols-2 gap-2 mb-3">
        <Stat label="أصناف راكدة" value={formatNumber(rows.length)} tone={rows.length > 0 ? 'text-warning' : undefined} />
        <Stat label="قيمة المخزون الراكد" value={formatReportAmount(totalValue)} />
      </div>
      {rows.length === 0 ? <Empty icon={<Package />} text="كل الأصناف التي لديها رصيد بيع منها خلال الفترة" /> : (
        <Card><CardContent className="p-0 divide-y divide-border/40">
          {rows.map(r => (
            <div key={r.id} className="flex items-center gap-2 p-2.5">
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold truncate">{r.name}</p>
                <p className="text-xs text-muted-foreground">{r.category} • رصيد {formatNumber(r.quantity)} • آخر بيع: {r.lastSale}</p>
              </div>
              <p className="text-xs font-bold shrink-0">{formatReportAmount(r.value)}</p>
            </div>
          ))}
        </CardContent></Card>
      )}
    </ReportShell>
  );
}
