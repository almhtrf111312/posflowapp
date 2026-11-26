// Which expenses this device paid from its local drawer, per shift (plan K-05/K-06 finding, 2026-11-26).
// An expense reversed while offline is queued, and the server refund happens later, so the local drawer was never given the
// cash back: the device then expected less cash than the cloud (the shift close showed $511 while the server had $526).
// A mark is written when the expense leaves the local drawer and taken exactly once when its reversal is queued.

type KV = { getItem(k: string): string | null; setItem(k: string, v: string): void };
const KEY = 'posflow_drawer_expense_marks';

function read(store: KV): Record<string, string[]> {
  try { return JSON.parse(store.getItem(KEY) || '{}') || {}; } catch { return {}; }
}

export function markExpensePaidFromDrawer(shiftId: string, expenseId: string, store: KV = localStorage): void {
  if (!shiftId || !expenseId) return;
  const all = read(store);
  const list = all[shiftId] || [];
  if (!list.includes(expenseId)) list.push(expenseId);
  all[shiftId] = list;
  try { store.setItem(KEY, JSON.stringify(all)); } catch { /* storage full: the reversal then waits for the server refund */ }
}

/** True once if this device took the expense out of the given shift's local drawer; the mark is removed. */
export function takeExpensePaidFromDrawer(shiftId: string | null | undefined, expenseId: string, store: KV = localStorage): boolean {
  if (!shiftId || !expenseId) return false;
  const all = read(store);
  const list = all[shiftId] || [];
  if (!list.includes(expenseId)) return false;
  all[shiftId] = list.filter(id => id !== expenseId);
  try { store.setItem(KEY, JSON.stringify(all)); } catch { /* ignore */ }
  return true;
}
