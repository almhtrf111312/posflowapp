import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/lib/sonner-bridge';
import { extractErrorMessage } from '@/lib/sync-queue';
import { purchaseReturnCloud } from '@/lib/cloud/suppliers-cloud';
import { loadTrackedProducts, loadInStockSerials } from '@/lib/serials-store';

interface Item { id: string; product_id?: string | null; product_name: string; quantity: number }

export function PurchaseReturnDialog({ open, onOpenChange, invoiceId, items, onDone }: {
  open: boolean; onOpenChange: (o: boolean) => void; invoiceId: string; items: Item[]; onDone?: () => void;
}) {
  const [qty, setQty] = useState<Record<string, string>>({});
  const [serials, setSerials] = useState<Record<string, string>>({});
  const [tracked, setTracked] = useState<Record<string, boolean>>({});
  const [stock, setStock] = useState<Record<string, string[]>>({});
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setQty({}); setSerials({}); setReason('');
    const ids = items.map(i => i.product_id).filter(Boolean) as string[];
    loadTrackedProducts(ids).then(async t => {
      setTracked(t);
      const entries = await Promise.all(ids.filter(id => t[id]).map(async id => [id, await loadInStockSerials(id)] as const));
      setStock(Object.fromEntries(entries));
    });
  }, [open, items]);

  const submit = async () => {
    const lines = items
      .map(i => ({ item: i, q: Number(qty[i.id] || 0) }))
      .filter(x => x.q > 0)
      .map(x => {
        const isTracked = !!(x.item.product_id && tracked[x.item.product_id]);
        const list = (serials[x.item.id] || '').split(/[\n,;\s]+/).map(s => s.trim()).filter(Boolean);
        return { item_id: x.item.id, quantity: x.q, ...(isTracked ? { serials: list } : {}) };
      });
    if (lines.length === 0) { toast.error('حدد كمية مرتجعة لبند واحد على الأقل'); return; }
    setBusy(true);
    try {
      await purchaseReturnCloud(invoiceId, lines, reason || 'مرتجع مشتريات');
      toast.success('تم تسجيل مرتجع المشتريات');
      onDone?.();
      onOpenChange(false);
    } catch (e) {
      toast.error(extractErrorMessage(e) || 'حدث خطأ');
    } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto" dir="rtl">
        <DialogHeader><DialogTitle>مرتجع مشتريات</DialogTitle></DialogHeader>
        <div className="space-y-3">
          {items.map(i => {
            const isTracked = !!(i.product_id && tracked[i.product_id]);
            return (
              <div key={i.id} className="rounded-xl border p-3 space-y-2">
                <div className="flex justify-between text-sm"><span className="font-medium">{i.product_name}</span><span className="text-muted-foreground">المشتراة: {i.quantity}</span></div>
                <Input type="number" inputMode="decimal" placeholder="الكمية المرتجعة" value={qty[i.id] || ''} onChange={e => setQty(p => ({ ...p, [i.id]: e.target.value }))} />
                {isTracked && (
                  <>
                    <textarea dir="ltr" rows={2} className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono"
                      placeholder="الأرقام التسلسلية المرتجعة (بعدد الكمية)" value={serials[i.id] || ''} onChange={e => setSerials(p => ({ ...p, [i.id]: e.target.value }))} />
                    <div className="flex flex-wrap gap-1 max-h-16 overflow-y-auto">
                      {(stock[i.product_id!] || []).slice(0, 30).map(s => <span key={s} className="rounded-full border px-2 py-0.5 text-[10px] font-mono">{s}</span>)}
                    </div>
                  </>
                )}
              </div>
            );
          })}
          <Input placeholder="سبب المرتجع" value={reason} onChange={e => setReason(e.target.value)} />
          <div className="flex gap-2">
            <Button className="flex-1" disabled={busy} onClick={submit}>تأكيد المرتجع</Button>
            <Button variant="outline" onClick={() => onOpenChange(false)}>إلغاء</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
