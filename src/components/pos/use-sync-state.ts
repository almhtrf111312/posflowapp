import { useEffect, useState } from 'react';
import { getQueueStatus } from '@/lib/sync-queue';
import { toast } from '@/lib/sonner-bridge';
import { isNotificationEventAllowed } from '@/lib/notification-events-config';
import { isSyncPendingSubscription, SYNC_PENDING_SUBSCRIPTION_MESSAGE } from '@/lib/subscription-lock';
import type { SyncState } from '@/components/pos/BackgroundSyncIndicator';

// Hook للاستخدام في CartPanel
export function useSyncState() {
  const [syncState, setSyncState] = useState<SyncState>('idle');
  const [syncMessage, setSyncMessage] = useState<string>('');
  const [delayTimer, setDelayTimer] = useState<ReturnType<typeof setTimeout> | null>(null);

  const startSync = (message?: string, showImmediateToast = false) => {
    // إلغاء أي تأخير سابق
    if (delayTimer) {
      clearTimeout(delayTimer);
      setDelayTimer(null);
    }
    
    setSyncState('syncing');
    setSyncMessage(message || '');
    
    // إظهار toast فوري فقط إذا طُلب (للعمليات الطويلة)
    if (showImmediateToast && message) {
      toast.info(message);
    }
  };

  const completeSync = (message = 'تمت المزامنة بنجاح', delay = 2000, triggerToast = false) => {
    if (delayTimer) {
      clearTimeout(delayTimer);
      setDelayTimer(null);
    }
    const timer = setTimeout(() => {
      const status = getQueueStatus();
      if (status.failedCount > 0) {
        setSyncState('error');
      } else if (status.pendingCount > 0) {
        setSyncState('idle');
      } else {
        setSyncState('success');
      }
      setSyncMessage(message);
      if (triggerToast && message && isNotificationEventAllowed('sync_completed_success')) {
        toast.success(message);
      }
      
      // العودة لـ idle بعد 3 ثوانٍ
      setTimeout(() => {
        setSyncState('idle');
        setSyncMessage('');
      }, 3000);
    }, delay);
    
    setDelayTimer(timer);
  };

  const failSync = (error = 'فشلت المزامنة', delay = 2000, triggerToast = false) => {
    if (isSyncPendingSubscription()) {
      error = SYNC_PENDING_SUBSCRIPTION_MESSAGE;
      triggerToast = false;
    }
    if (delayTimer) {
      clearTimeout(delayTimer);
      setDelayTimer(null);
    }
    const timer = setTimeout(() => {
      setSyncState('error');
      setSyncMessage(error);
      if (triggerToast && error) {
        toast.error(error);
      }
    }, delay);
    
    setDelayTimer(timer);
  };
  
  // تنظيف التأخيرات عند unmount
  useEffect(() => {
    return () => {
      if (delayTimer) clearTimeout(delayTimer);
    };
  }, [delayTimer]);

  return {
    syncState,
    syncMessage,
    startSync,
    completeSync,
    failSync,
    setSyncState,
  };
}
