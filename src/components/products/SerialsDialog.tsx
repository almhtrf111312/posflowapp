import { useCallback, useEffect, useState } from 'react';
import { Hash, Loader2 } from 'lucide-react';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/lib/sonner-bridge';
import { supabase } from '@/integrations/supabase/client';
import { extractErrorMessage } from '@/lib/sync-queue';
import { lookupSerialCloud, type SerialLookupRow } from '@/lib/serials-store';
import { cn } from '@/lib/utils';

const STATUS: Record<string, string> = { in_stock: 'في المخزون', sold: 'مباع', defective: 'تالف', returned_to_supplier: 'مرتجع للمورد' };
const EVENT: Record<string, string> = { received: 'استلام', sold: 'بيع', customer_return: 'مرتجع عميل', returned_to_supplier: 'مرتجع لمورد' };
const db = supabase as unknown as { from: (t: string) => any; rpc: (fn: string, args: Record<string, unknown>) => any };

const STATUS_BADGE_CLASS: Record<string, string> = {
  in_stock: 'bg-success/15 text-success border-success/30',
  sold: 'bg-info/15 text-info border-info/30',
  defective: 'bg-destructive/15 text-destructive border-destructive/30',
  returned_to_supplier: 'bg-warning/15 text-warning border-warning/30',
};

interface Row { serial: string; status: string; sold_invoice_number?: string | null; customer_name?: string | null; warranty_until?: string | null }

export function SerialsDialog({ product, onOpenChange }: { product: { id: string; name: string } | null; onOpenChange: (o: boolean) => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<SerialLookupRow[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!product) return;
    const { data } = await db.from('product_serials').select('serial, status, sold_invoice_number, customer_name, warranty_until').eq('product_id', product.id).order('created_at', { ascending: false }).limit(300);
    setRows(data || []);
  }, [product]);

  useEffect(() => { setText(''); setFound(null); setQuery(''); void load(); }, [load]);

  const register = async () => {
    if (!product) return;
    const list = text.split(/[\n,;\s]+/).map(s => s.trim()).filter(Boolean);
    if (list.length === 0) return;
    setBusy(true);
    try {
      const { error } = await db.rpc('register_serials_atomic', { _product_id: product.id, _serials: list });
      if (error) throw error;
      toast.success(`تم تسجيل ${list.length} رقم`);
      setText(''); await load();
    } catch (e) { toast.error(extractErrorMessage(e) || 'حدث خطأ'); } finally { setBusy(false); }
  };

  const search = async () => {
    if (!query.trim()) return;
    try { setFound(await lookupSerialCloud(query.trim())); } catch (e) { toast.error(extractErrorMessage(e) || 'حدث خطأ'); }
  };

  const preventClose = busy || text.trim().length > 0;

  return (
    <Dialog open={!!product} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[min(calc(100vw-1.5rem),32rem)] max-h-[calc(100dvh-1.5rem)] flex flex-col p-0 overflow-hidden rounded-[24px]"
        onPointerDownOutside={(e) => { if (preventClose) e.preventDefault(); }}
        onEscapeKeyDown={(e) => { if (preventClose) e.preventDefault(); }}
      >
        <DialogHeader className="shrink-0 px-4 pt-4 pb-3 sm:px-6 sm:pt-5 border-b border-border/60 text-start pe-12">
          <DialogTitle>الأرقام التسلسلية: {product?.name}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div className="rounded-xl border border-border p-3 space-y-2">
            <div className="text-xs font-semibold">بحث عن رقم (يعرض تاريخه وضمانه)</div>
            <div className="flex gap-2">
              <Input
                dir="ltr"
                className="tabular-nums"
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void search(); }}
              />
              <Button onClick={search}>بحث</Button>
            </div>
            {found && found.length === 0 && <div className="text-xs text-muted-foreground">لا يوجد رقم بهذا الاسم.</div>}
            {found?.map((f, i) => (
              <div key={i} className="rounded-lg border border-border p-2.5 text-xs space-y-1.5">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="font-semibold">
                    <span dir="ltr" className="inline-block font-mono font-bold tabular-nums">{f.serial}</span> — {f.product_name}
                  </div>
                  <Badge variant="outline" className={cn(STATUS_BADGE_CLASS[f.status])}>
                    {STATUS[f.status] || f.status}
                  </Badge>
                </div>
                {f.sold_invoice_number && (
                  <div>
                    فاتورة <span dir="ltr" className="inline-block font-mono tabular-nums">{f.sold_invoice_number}</span>
                    {f.customer_name ? ` · ${f.customer_name}` : ''}
                    {f.warranty_until ? (
                      <> · الضمان حتى <span dir="ltr" className="inline-block tabular-nums">{f.warranty_until}</span></>
                    ) : ''}
                  </div>
                )}
                <div className="text-muted-foreground">{(f.events || []).map((e) => `${EVENT[e.event] || e.event} (${new Date(e.at).toLocaleDateString('ar')})`).join(' ← ')}</div>
              </div>
            ))}
          </div>

          <div className="rounded-xl border border-border p-3 space-y-2">
            <div className="text-xs font-semibold">تسجيل أرقام لمخزون موجود (لا يغيّر الكمية)</div>
            <Textarea
              dir="ltr"
              rows={3}
              className="rounded-[14px] text-xs font-mono tabular-nums"
              value={text}
              onChange={e => setText(e.target.value)}
              placeholder="رقم في كل سطر"
            />
            <Button disabled={busy || !text.trim()} onClick={register}>
              {busy && <Loader2 className="w-4 h-4 animate-spin" />}
              تسجيل
            </Button>
          </div>

          <div className="space-y-1.5">
            {rows.length === 0 ? (
              <div className="flex flex-col items-center justify-center text-center py-10 px-4 rounded-2xl border border-dashed border-border/70 bg-muted/20">
                <Hash className="w-12 h-12 text-muted-foreground/50 mb-3" />
                <p className="text-sm sm:text-base font-semibold text-foreground">لا توجد أرقام تسلسلية مسجلة</p>
              </div>
            ) : (
              rows.map(r => (
                <div key={r.serial} className="flex items-center justify-between gap-2 text-xs rounded-lg border border-border px-3 py-2">
                  <span dir="ltr" className="inline-block font-mono tabular-nums">{r.serial}</span>
                  <div className="flex items-center gap-2 shrink-0">
                    {r.sold_invoice_number && (
                      <span dir="ltr" className="inline-block font-mono tabular-nums text-muted-foreground">
                        {r.sold_invoice_number}
                      </span>
                    )}
                    <Badge variant="outline" className={cn(STATUS_BADGE_CLASS[r.status])}>
                      {STATUS[r.status] || r.status}
                    </Badge>
                  </div>
                </div>
              ))
            )}
          </div>
        </DialogBody>
        <DialogFooter className="shrink-0 px-4 py-3 sm:px-6 border-t border-border/60">
          <Button variant="outline" size="default" onClick={() => onOpenChange(false)} disabled={busy}>
            إغلاق
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
