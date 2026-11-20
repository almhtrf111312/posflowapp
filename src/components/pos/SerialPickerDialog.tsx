import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
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
      <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto" dir="rtl">
        <DialogHeader><DialogTitle>اختيار الأرقام التسلسلية / IMEI</DialogTitle></DialogHeader>
        <div className="space-y-4">
          {items.map(i => {
            const sel = chosen[i.id] || [];
            return (
              <div key={i.id} className="rounded-xl border p-3 space-y-2">
                <div className="flex justify-between text-sm font-medium"><span>{i.name}</span><span>{sel.length} / {i.quantity}</span></div>
                <Input dir="ltr" placeholder="امسح أو اكتب الرقم ثم Enter" value={input[i.id] || ''}
                  onChange={e => setInput(p => ({ ...p, [i.id]: e.target.value }))}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(i.id, i.quantity, input[i.id] || ''); } }} />
                <div className="flex flex-wrap gap-1">
                  {sel.map(s => (
                    <button key={s} type="button" onClick={() => remove(i.id, s)} className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-mono">{s} ✕</button>
                  ))}
                </div>
                <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto">
                  {(available[i.id] || []).filter(s => !sel.includes(s)).slice(0, 40).map(s => (
                    <button key={s} type="button" onClick={() => add(i.id, i.quantity, s)} className="rounded-full border px-2 py-0.5 text-xs font-mono">{s}</button>
                  ))}
                </div>
              </div>
            );
          })}
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex gap-2">
            <Button className="flex-1" disabled={!complete} onClick={confirm}>متابعة البيع</Button>
            <Button variant="outline" onClick={onCancel}>إلغاء</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
