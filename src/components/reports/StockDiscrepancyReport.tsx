import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, PackageSearch, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ReportShell } from './ReportShell';
import { listStockDiscrepancies, type StockDiscrepancy } from '@/lib/cloud/stock-discrepancies-cloud';
import { exportGenericToExcel, exportGenericToPDF } from '@/lib/reports/dataset-builder';
import { cn, formatNumber, formatReportAmount } from '@/lib/utils';
import { ReportCurrencyBanner } from './ReportCurrencyBanner';
import { toast } from '@/lib/sonner-bridge';
import { useLanguage } from '@/hooks/language-context';

interface Props {
  search: string;
  warehouseId: string;
}

const columns = [
  { key: 'product', label: 'المنتج' },
  { key: 'warehouse', label: 'الموقع' },
  { key: 'expected', label: 'المتوقع', kind: 'quantity' as const },
  { key: 'actual', label: 'الفعلي', kind: 'quantity' as const },
  { key: 'variance', label: 'الفرق', kind: 'quantity' as const },
  { key: 'varianceValue', label: 'قيمة الفرق', kind: 'money' as const },
  { key: 'lastMovement', label: 'آخر حركة' },
];

export function StockDiscrepancyReport({ search, warehouseId }: Props) {
  const { t } = useLanguage();
  const [rows, setRows] = useState<StockDiscrepancy[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await listStockDiscrepancies());
    } catch (error) {
      console.error('[StockDiscrepancyReport] Load failed:', error);
      toast.error('تعذر تحميل فروقات المخزون');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return rows.filter(row => {
      if (warehouseId !== 'all' && (row.warehouse_id || 'main') !== warehouseId) return false;
      if (!query) return true;
      return row.product_name.toLowerCase().includes(query)
        || (row.warehouse_name || 'المخزون الرئيسي').toLowerCase().includes(query);
    });
  }, [rows, search, warehouseId]);

  const mismatches = useMemo(() => filtered.filter(row => row.variance !== 0), [filtered]);
  const totalUnits = mismatches.reduce((sum, row) => sum + Math.abs(row.variance), 0);
  const totalValue = mismatches.reduce((sum, row) => sum + Math.abs(row.variance_value), 0);

  const exportRows = filtered.map(row => ({
    product: row.product_name,
    warehouse: row.warehouse_name || 'المخزون الرئيسي',
    expected: row.expected_quantity,
    actual: row.actual_quantity,
    variance: row.variance,
    varianceValue: row.variance_value,
    lastMovement: row.last_movement_at ? new Date(row.last_movement_at).toLocaleString('en-GB') : '-',
  }));

  const exportOptions = {
    title: t('reports.stockDiscrepancyTitle') || 'كاشف فروقات المخزون',
    subtitle: `المنتجات المختلفة: ${mismatches.length} — مجموع فرق الوحدات: ${formatNumber(totalUnits)}`,
    columns,
    rows: exportRows,
    summary: [
      { label: 'منتجات بفروقات', value: mismatches.length },
      { label: 'فرق الوحدات', value: totalUnits },
      { label: 'قيمة الفروقات', value: formatReportAmount(totalValue) },
    ],
  };

  return (
    <ReportShell
      icon={<PackageSearch className="w-5 h-5" />}
      title={t('reports.stockDiscrepancyTitle') || 'كاشف فروقات المخزون'}
      subtitle="يقارن الرصيد الفعلي بالرصيد المتوقع من سجل حركات المخزون"
      onExportPDF={filtered.length ? () => void exportGenericToPDF({ ...exportOptions, fileName: 'stock-discrepancies.pdf' }) : undefined}
      onExportExcel={filtered.length ? () => void exportGenericToExcel({ ...exportOptions, sheetName: 'فروقات المخزون', fileName: 'stock-discrepancies.xlsx' }) : undefined}
      exportDisabled={loading}
      hideExportToolbar={true}
    >
      <ReportCurrencyBanner />
      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading} className="gap-1.5">
          <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} /> تحديث
        </Button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 sm:gap-4">
        <Card><CardContent className="p-3"><p className="text-xs text-muted-foreground">منتجات بفروقات</p><p className="mt-1 text-lg font-bold text-destructive"><span dir="ltr" className="inline-block tabular-nums">{formatNumber(mismatches.length)}</span></p></CardContent></Card>
        <Card><CardContent className="p-3"><p className="text-xs text-muted-foreground">فرق الوحدات</p><p className="mt-1 text-lg font-bold"><span dir="ltr" className="inline-block tabular-nums">{formatNumber(totalUnits)}</span></p></CardContent></Card>
        <Card className="col-span-2 sm:col-span-1"><CardContent className="p-3"><p className="text-xs text-muted-foreground">قيمة الفروقات</p><p className="mt-1 text-lg font-bold text-destructive"><span dir="ltr" className="inline-block tabular-nums">{formatReportAmount(totalValue)}</span></p></CardContent></Card>
      </div>

      <Card><CardContent className="p-0">
        {loading ? (
          <p className="py-10 text-center text-sm text-muted-foreground">جاري فحص المخزون...</p>
        ) : mismatches.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            <CheckCircle2 className="w-10 h-10 mx-auto mb-3 text-success" />
            لا توجد فروقات ضمن النتائج الحالية
          </div>
        ) : (
          <div className="divide-y divide-border/40">
            {mismatches.map(row => (
              <div key={`${row.product_id}:${row.warehouse_id || 'main'}`} className="p-3 flex gap-3 items-start">
                <div className="w-9 h-9 rounded-lg bg-destructive/10 text-destructive flex items-center justify-center shrink-0"><AlertTriangle className="w-4 h-4" /></div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0"><p className="text-sm font-semibold truncate">{row.product_name}</p><p className="text-xs text-muted-foreground">{row.warehouse_name || 'المخزون الرئيسي'}</p></div>
                    <p className={cn('text-sm font-bold whitespace-nowrap', row.variance > 0 ? 'text-success' : 'text-destructive')}><span dir="ltr" className="inline-block tabular-nums">{row.variance > 0 ? '+' : ''}{formatNumber(row.variance)}</span></p>
                  </div>
                  <div className="grid grid-cols-3 gap-2 mt-2 text-xs">
                    <span className="text-muted-foreground">المتوقع: <b className="text-foreground"><span dir="ltr" className="inline-block tabular-nums">{formatNumber(row.expected_quantity)}</span></b></span>
                    <span className="text-muted-foreground">الفعلي: <b className="text-foreground"><span dir="ltr" className="inline-block tabular-nums">{formatNumber(row.actual_quantity)}</span></b></span>
                    <span className="text-muted-foreground">القيمة: <b className="text-foreground"><span dir="ltr" className="inline-block tabular-nums">{formatReportAmount(Math.abs(row.variance_value))}</span></b></span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent></Card>
    </ReportShell>
  );
}