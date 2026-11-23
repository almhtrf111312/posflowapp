import { useEffect, useState } from 'react';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { loadInStockSerials, getSelectedSerials, setSelectedSerials } from '@/lib/serials-store';

export interface SerialPickItem { id: string; name: string; quantity: number }

export function SerialPickerDialog({ open, items, onConfirm, onCancel }: {
  open: boolean; items: SerialPickItem[]; onConfirm: () => void; onCancel: () => void;
}) {
  const [available, setAvailable] = useState<Record<string, string[]>>({});
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const [input, setInput] = useState<Record<string, string>>({});
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setError('');
    setChosen(Object.fromEntries(items.map(i => [i.id, getSelectedSerials(i.id) || []])));
    Promise.all(items.map(async i => [i.id, await loadInStockSerials(i.id)] as const)).then(r => setAvailable(Object.fromEntries(r)));
  }, [open, items]);

  const add = (id: string, qty: number, raw: string) => {
    const v = raw.trim();
    if (!v) return;
    const match = (available[id] || []).find(s => s.toLowerCase() === v.toLowerCase());
    if (!match) { setError(`الرقم ${v} غير موجود في المخزون`); return; }
    setError('');
    setChosen(prev => {
      const cur = prev[id] || [];
      if (cur.some(s => s.toLowerCase() === match.toLowerCase()) || cur.length >= qty) return prev;
      return { ...prev, [id]: [...cur, match] };
    });
    setInput(p => ({ ...p, [id]: '' }));
  };
  const remove = (id: string, s: string) => setChosen(prev => ({ ...prev, [id]: (prev[id] || []).filter(x => x !== s) }));

  const complete = items.every(i => (chosen[i.id] || []).length === i.quantity);
  const confirm = () => {
    items.forEach(i => setSelectedSerials(i.id, chosen[i.id] || []));
    onConfirm();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent className="w-[min(calc(100vw-1.5rem),28rem)] max-h-[calc(100dvh-1.5rem)] flex flex-col p-0 overflow-hidden rounded-[24px]">
        <DialogHeader className="shrink-0 px-4 pt-4 pb-3 sm:px-6 sm:pt-5 border-b border-border/60 text-start pe-12"><DialogTitle>اختيار الأرقام التسلسلية / IMEI</DialogTitle></DialogHeader>
        <DialogBody className="space-y-4 py-4">
          {items.map(i => {
            const sel = chosen[i.id] || [];
            return (
              <div key={i.id} className="rounded-xl border border-border p-3 space-y-2">
                <div className="flex justify-between text-sm font-medium"><span>{i.name}</span><span dir="ltr" className="inline-block tabular-nums">{sel.length} / {i.quantity}</span></div>
                <Input dir="ltr" placeholder="امسح أو اكتب الرقم ثم Enter" value={input[i.id] || ''}
                  onChange={e => setInput(p => ({ ...p, [i.id]: e.target.value }))}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(i.id, i.quantity, input[i.id] || ''); } }} />
                <div className="flex flex-wrap gap-1.5">
                  {sel.map(s => (
                    <button key={s} type="button" dir="ltr" onClick={() => remove(i.id, s)} className="min-h-9 sm:min-h-8 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-mono tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{s} ✕</button>
                  ))}
                </div>
                <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
                  {(available[i.id] || []).filter(s => !sel.includes(s)).slice(0, 40).map(s => (
                    <button key={s} type="button" dir="ltr" onClick={() => add(i.id, i.quantity, s)} className="min-h-9 sm:min-h-8 rounded-full border border-border px-2.5 py-1 text-xs font-mono tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{s}</button>
                  ))}
                </div>
              </div>
            );
          })}
          {error && <p className="text-xs text-destructive">{error}</p>}
        </DialogBody>
        <DialogFooter className="shrink-0 px-4 py-3 sm:px-6 border-t border-border/60">
          <Button variant="outline" size="default" onClick={onCancel}>إلغاء</Button>
          <Button variant="default" size="default" className="flex-1 sm:flex-none" disabled={!complete} onClick={confirm}>متابعة البيع</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
