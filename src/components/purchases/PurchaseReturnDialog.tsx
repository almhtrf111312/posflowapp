import { useEffect, useRef, useState } from 'react';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Loader2 } from 'lucide-react';
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

  // One operation id per return, reused if the user retries after an error (F-20).
  const opIdRef = useRef<string>((typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `op-${Date.now()}-${Math.random().toString(36).slice(2)}`));

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
      await purchaseReturnCloud(invoiceId, lines, reason || 'مرتجع مشتريات', opIdRef.current);
      opIdRef.current = (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `op-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      toast.success('تم تسجيل مرتجع المشتريات');
      onDone?.();
      onOpenChange(false);
    } catch (e) {
      toast.error(extractErrorMessage(e) || 'حدث خطأ');
    } finally { setBusy(false); }
  };

  const isDirty = busy || Boolean(reason.trim()) || Object.values(qty).some(Boolean);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[min(calc(100vw-1.5rem),32rem)] max-h-[calc(100dvh-1.5rem)] flex flex-col p-0 overflow-hidden rounded-[24px]"
        onPointerDownOutside={(e) => { if (isDirty) e.preventDefault(); }}
        onEscapeKeyDown={(e) => { if (isDirty) e.preventDefault(); }}
      >
        <DialogHeader className="shrink-0 px-4 pt-4 pb-3 sm:px-6 sm:pt-5 border-b border-border/60 text-start pe-12">
          <DialogTitle>مرتجع مشتريات</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {items.map(i => {
            const isTracked = !!(i.product_id && tracked[i.product_id]);
            return (
              <div key={i.id} className="rounded-xl border border-border p-3 space-y-2">
                <div className="flex justify-between gap-2 text-sm">
                  <span className="font-medium">{i.product_name}</span>
                  <span className="text-muted-foreground">المشتراة: <span dir="ltr" className="inline-block tabular-nums">{i.quantity}</span></span>
                </div>
                <Input dir="ltr" className="tabular-nums" type="number" inputMode="decimal" placeholder="الكمية المرتجعة" value={qty[i.id] || ''} onChange={e => setQty(p => ({ ...p, [i.id]: e.target.value }))} />
                {isTracked && (
                  <>
                    <Textarea dir="ltr" rows={2} className="text-xs font-mono"
                      placeholder="الأرقام التسلسلية المرتجعة (بعدد الكمية)" value={serials[i.id] || ''} onChange={e => setSerials(p => ({ ...p, [i.id]: e.target.value }))} />
                    <div className="flex flex-wrap gap-1.5 max-h-20 overflow-y-auto">
                      {(stock[i.product_id!] || []).slice(0, 30).map(s => (
                        <Badge key={s} variant="outline" className="font-mono text-xs">
                          <span dir="ltr" className="inline-block tabular-nums">{s}</span>
                        </Badge>
                      ))}
                    </div>
                  </>
                )}
              </div>
            );
          })}
          <Input placeholder="سبب المرتجع" value={reason} onChange={e => setReason(e.target.value)} />
        </DialogBody>
        <DialogFooter className="shrink-0 px-4 py-3 sm:px-6 border-t border-border/60">
          <Button variant="outline" size="default" disabled={busy} onClick={() => onOpenChange(false)}>إلغاء</Button>
          <Button variant="default" size="default" disabled={busy} onClick={submit}>
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            تأكيد المرتجع
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
