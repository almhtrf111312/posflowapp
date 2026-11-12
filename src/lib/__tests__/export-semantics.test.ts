import { moneyTone, statusTone, statusMark } from '../export-semantics';

function eq(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`);
  console.log(`PASS ${message}`);
}

eq(moneyTone('profit', 'الربح', 25), 'positive', 'profit green');
eq(moneyTone('profit', 'الربح', -10), 'negative', 'loss red');
eq(moneyTone('remainingDebt', 'المتبقي', 40), 'negative', 'unpaid debt red');
eq(moneyTone('remainingDebt', 'المتبقي', 0), 'positive', 'fully paid debt green');
eq(moneyTone('totalPaid', 'المدفوع', 60), 'positive', 'paid green');
eq(moneyTone('loss', 'الخسارة', 28), 'negative', 'bad-debt loss red');
eq(moneyTone('total', 'الإجمالي', 100), 'neutral', 'plain total stays neutral');
eq(moneyTone('total', 'الإجمالي', -5), 'negative', 'any negative amount red');
eq(moneyTone('totalDebt', 'إجمالي الدين', 100), 'neutral', 'total debt neutral');
eq(statusTone('مسدد'), 'positive', 'paid status green');
eq(statusTone('✔ مسدد'), 'positive', 'existing mark ignored');
eq(statusTone('متأخر'), 'negative', 'overdue red');
eq(statusTone('مسدد جزئياً'), 'warning', 'partial amber');
eq(statusTone('مشطوب'), 'muted', 'written-off grey');
eq(statusTone('أحمد مسدد'), 'neutral', 'customer names never colored');
eq(statusMark('positive'), '✔', 'check mark for paid');
eq(statusMark('negative'), '✘', 'cross mark for unpaid');

import { amountFromText, cellTone } from '../export-semantics';
eq(amountFromText('$1,250.50'), 1250.5, 'formatted amount parsed');
eq(amountFromText('-35 ل.س'), -35, 'negative formatted amount parsed');
eq(amountFromText('2026-11-12'), null, 'dates are not amounts');
eq(cellTone('profit', 'الربح', '$12.00', false), 'positive', 'formatted profit green');
eq(cellTone('profit', 'الربح', '-$4.00', false), 'negative', 'formatted loss red');
eq(cellTone('name', 'العميل', '$12', false), 'neutral', 'non-money column untouched');
