import { useEffect } from 'react';
import { getDueExpenses, executeAutoPayRecurringExpenses } from '@/lib/recurring-expenses-store';
import { toast } from '@/lib/sonner-bridge';
import { formatNumber, formatMoney } from '@/lib/utils';

export function useDueExpensesChecker() {
  useEffect(() => {
    let manualAlertShown = false; // the manual-due reminder is shown once per session, not on every re-check
    const checkAndAutoPay = async () => {
      try {
        // 1. تنفيذ الدفع التلقائي للمصاريف المجدولة مع ضمان عدم التكرار (Idempotency)
        const autoPaidCount = await executeAutoPayRecurringExpenses();
        if (autoPaidCount > 0) {
          toast.info('دفع تلقائي لمصروف دوري', {
            id: 'auto-pay-due-expenses',
            description: `تم خصم وسداد ${autoPaidCount} مصروف دوري مستحق تلقائياً من الصندوق`,
            duration: 4500,
          });
        }

        // 2. التنبيه بالمصاريف المستحقة التي تتطلب مراجعة وسداد يدوي
        const manualDue = getDueExpenses().filter(e => !e.autoPay);
        if (manualDue.length > 0 && !manualAlertShown) {
          manualAlertShown = true;
          const totalAmount = manualDue.reduce((sum, e) => sum + e.amount, 0);
          toast.warning(`تنبيه: يوجد ${manualDue.length} مصروف مستحق السداد اليوم`, {
            id: 'manual-due-expenses-alert',
            description: `إجمالي المستحق: ${formatMoney(totalAmount, undefined, 2)} - اضغط للمراجعة والسداد`,
            duration: 6000,
            action: {
              label: 'مراجعة وسداد',
              onClick: () => {
                window.location.hash = '#/expenses';
              },
            },
          });
        }
      } catch (err) {
        console.error('[DueExpensesChecker] Error:', err);
      }
    };

    // The first run happens before login / before the recurring list is loaded from the cloud, so it can find nothing.
    // Re-check after the session is ready and then every 5 minutes (payment stays idempotent: lastPaidDate + lock).
    const timers = [setTimeout(checkAndAutoPay, 2000), setTimeout(checkAndAutoPay, 20000)];
    const interval = setInterval(checkAndAutoPay, 5 * 60 * 1000);
    return () => { timers.forEach(clearTimeout); clearInterval(interval); };
  }, []);
}
