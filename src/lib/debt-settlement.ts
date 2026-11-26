import { round8 } from './money-engine';

interface DebtBalance {
  totalDebt: number;
  remainingDebt: number;
  totalPaid: number;
}

/** F-26: the ledger settles the exact balance when the credit is within five cents. */
export function applyLocalDebtSettlement(debt: DebtBalance, credit: number) {
  const difference = round8(debt.remainingDebt - credit);
  if (difference < -0.05) throw new Error('المبلغ المدخل يتجاوز إجمالي الدين المتبقي');
  if (debt.remainingDebt <= 0) throw new Error('لا يمكن تسديد دين مغلق');
  if (difference <= 0.05) {
    return { totalPaid: debt.totalDebt, remainingDebt: 0, status: 'fully_paid' as const };
  }
  return { totalPaid: round8(debt.totalPaid + credit), remainingDebt: difference, status: 'partially_paid' as const };
}
