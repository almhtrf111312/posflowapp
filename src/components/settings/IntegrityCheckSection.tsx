import { useState } from 'react';
import { Loader2, ShieldCheck, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';

type Check = { check: string; severity: 'high' | 'medium'; count: number; sample: string[] };
type Report = { checked_at: string; issues_total: number; checks: Check[] };

const LABELS: Record<string, string> = {
  negative_stock: 'منتجات بمخزون سالب',
  customer_debt_mismatch: 'دين عميل لا يطابق ديونه المفتوحة',
  open_debt_on_refunded_invoice: 'دين مفتوح لفاتورة مرتجعة أو ملغاة',
  invoice_debt_vs_debts: 'متبقي الفاتورة لا يطابق جدول الديون',
  debt_math: 'دين: الكلي − المسدد ≠ المتبقي',
  invoice_profit_vs_items: 'ربح الفاتورة ≠ مجموع ربح البنود',
  partner_pending_vs_details: 'أرباح الشركاء المعلقة ≠ تفاصيلها',
};

/** فحص نزاهة أساسي للقراءة فقط (مالك المتجر) */
export function IntegrityCheckSection() {
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setLoading(true);
    setError(null);
    const { data, error } = await (supabase as any).rpc('posflow_integrity_check');
    if (error) setError(error.message || 'تعذّر تنفيذ الفحص');
    else setReport(data as Report);
    setLoading(false);
  };

  return (
    <div className="space-y-3">
      <div className="bg-card border border-border/50 rounded-2xl p-4 space-y-3">
        <div className="flex items-center gap-2 font-bold">
          <ShieldCheck className="w-5 h-5 text-primary" />
          فحص سلامة البيانات
        </div>
        <p className="text-xs text-muted-foreground">فحص للقراءة فقط: لا يغيّر أي بيانات، ويعرض التناقضات المحاسبية إن وُجدت.</p>
        <Button onClick={run} disabled={loading} className="w-full">
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'تشغيل الفحص'}
        </Button>
        {error && <div className="text-sm text-destructive">{error}</div>}
      </div>
      {report && (
        <div className="space-y-2">
          <div className={report.issues_total === 0 ? 'text-sm font-bold text-success' : 'text-sm font-bold text-warning'}>
            {report.issues_total === 0 ? 'لا توجد تناقضات ✅' : `عدد التناقضات: ${report.issues_total}`}
          </div>
          {report.checks.map((c) => (
            <div key={c.check} className="bg-card border border-border/40 rounded-xl p-3 flex items-start justify-between gap-2">
              <div className="text-sm">
                <div className="flex items-center gap-1.5">
                  {c.count > 0 && <AlertTriangle className={c.severity === 'high' ? 'w-4 h-4 text-destructive' : 'w-4 h-4 text-warning'} />}
                  {LABELS[c.check] || c.check}
                </div>
                {c.count > 0 && <div className="text-[11px] text-muted-foreground mt-1 break-all">{c.sample.join('، ')}</div>}
              </div>
              <span className="font-bold tabular-nums">{c.count}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
