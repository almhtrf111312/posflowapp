import { useCallback, useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/lib/sonner-bridge';
import { supabase } from '@/integrations/supabase/client';
import { extractErrorMessage } from '@/lib/sync-queue';
import { lookupSerialCloud } from '@/lib/serials-store';

const STATUS: Record<string, string> = { in_stock: 'في المخزون', sold: 'مباع', defective: 'تالف', returned_to_supplier: 'مرتجع للمورد' };
const EVENT: Record<string, string> = { received: 'استلام', sold: 'بيع', customer_return: 'مرتجع عميل', returned_to_supplier: 'مرتجع لمورد' };
const db = supabase as any;

interface Row { serial: string; status: string; sold_invoice_number?: string | null; customer_name?: string | null; warranty_until?: string | null }

export function SerialsDialog({ product, onOpenChange }: { product: { id: string; name: string } | null; onOpenChange: (o: boolean) => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<any[] | null>(null);
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

  return (
    <Dialog open={!!product} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto" dir="rtl">
        <DialogHeader><DialogTitle>الأرقام التسلسلية: {product?.name}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="rounded-xl border p-3 space-y-2">
            <div className="text-xs font-semibold">بحث عن رقم (يعرض تاريخه وضمانه)</div>
            <div className="flex gap-2"><Input dir="ltr" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void search(); }} /><Button onClick={search}>بحث</Button></div>
            {found && found.length === 0 && <div className="text-xs text-muted-foreground">لا يوجد رقم بهذا الاسم.</div>}
            {found?.map((f, i) => (
              <div key={i} className="rounded-lg border p-2 text-xs space-y-1">
                <div className="font-mono font-bold">{f.serial} — {f.product_name} — {STATUS[f.status] || f.status}</div>
                {f.sold_invoice_number && <div>فاتورة {f.sold_invoice_number}{f.customer_name ? ` · ${f.customer_name}` : ''}{f.warranty_until ? ` · الضمان حتى ${f.warranty_until}` : ''}</div>}
                <div className="text-muted-foreground">{(f.events || []).map((e: any) => `${EVENT[e.event] || e.event} (${new Date(e.at).toLocaleDateString('ar')})`).join(' ← ')}</div>
              </div>
            ))}
          </div>

          <div className="rounded-xl border p-3 space-y-2">
            <div className="text-xs font-semibold">تسجيل أرقام لمخزون موجود (لا يغيّر الكمية)</div>
            <textarea dir="ltr" rows={3} className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono" value={text} onChange={e => setText(e.target.value)} placeholder="رقم في كل سطر" />
            <Button disabled={busy || !text.trim()} onClick={register}>تسجيل</Button>
          </div>

          <div className="space-y-1">
            {rows.map(r => (
              <div key={r.serial} className="flex justify-between text-xs rounded-lg border px-3 py-1.5">
                <span className="font-mono">{r.serial}</span>
                <span className="text-muted-foreground">{STATUS[r.status] || r.status}{r.sold_invoice_number ? ` · ${r.sold_invoice_number}` : ''}</span>
              </div>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
