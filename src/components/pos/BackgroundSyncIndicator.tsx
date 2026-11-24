import { isLocalDataMode } from '@/hooks/use-network-status';
import { isSyncPendingSubscription, SYNC_PENDING_SUBSCRIPTION_MESSAGE } from '@/lib/subscription-lock';
/**
 * مؤشر المزامنة في الخلفية - يظهر حالة المعالجة
 */
import { useEffect, useState, useContext } from 'react';
import { Cloud, CloudOff, Loader2, Check, AlertTriangle, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useLanguage } from '@/hooks/use-language';
import { EVENTS } from '@/lib/events';
import { getQueueStatus, SyncQueueStatus, loadQueue, resetOperationForRetry, QueuedOperation } from '@/lib/sync-queue';
import { toast } from '@/lib/sonner-bridge';
import { isNotificationEventAllowed } from '@/lib/notification-events-config';
import { CloudSyncContext } from '@/providers/CloudSyncProvider';
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

export type SyncState = 'idle' | 'syncing' | 'success' | 'error' | 'offline';

interface BackgroundSyncIndicatorProps {
  state?: SyncState;
  message?: string;
  className?: string;
}

export function BackgroundSyncIndicator({ 
  state: externalState, 
  message: externalMessage,
  className 
}: BackgroundSyncIndicatorProps) {
  const { isRTL } = useLanguage();
  const [internalState, setInternalState] = useState<SyncState>('idle');
  const [queueStatus, setQueueStatus] = useState<SyncQueueStatus>(getQueueStatus());
  const syncContext = useContext(CloudSyncContext);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [failedOps, setFailedOps] = useState<QueuedOperation[]>([]);
  const [isRetrying, setIsRetrying] = useState(false);
  
  // Listen to sync queue updates
  useEffect(() => {
    const handleUpdate = (e: Event) => {
      const customEvent = e as CustomEvent<SyncQueueStatus>;
      if (customEvent.detail) {
        setQueueStatus(customEvent.detail);
        
        // Update state based on queue
        if (customEvent.detail.isProcessing || customEvent.detail.processingCount > 0) {
          setInternalState('syncing');
        } else if (customEvent.detail.failedCount > 0) {
          setInternalState('error');
        } else if (customEvent.detail.pendingCount === 0) {
          setInternalState('success');
          // Reset to idle after 3 seconds
          setTimeout(() => setInternalState('idle'), 3000);
        }
      }
    };

    window.addEventListener(EVENTS.SYNC_QUEUE_UPDATED, handleUpdate);
    
    // Check online status
    const handleOnline = () => {
      if (internalState === 'offline') setInternalState('idle');
    };
    const handleOffline = () => setInternalState('offline');
    
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    
    // Initial offline check
    if (isLocalDataMode()) setInternalState('offline');

    return () => {
      window.removeEventListener(EVENTS.SYNC_QUEUE_UPDATED, handleUpdate);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [internalState]);

  const state = externalState || internalState;
  
  // Don't show if idle and no queue items
  if (state === 'idle' && queueStatus.pendingCount === 0 && queueStatus.failedCount === 0) {
    return null;
  }

  const handleOpenDialog = () => {
    const queue = loadQueue();
    const ops = queue.filter(op => op.status === 'failed' || !!op.error || op.status === 'pending');
    setFailedOps(ops);
    setDialogOpen(true);
  };

  const handleRetryAll = async () => {
    setIsRetrying(true);
    try {
      const queue = loadQueue();
      for (const op of queue) {
        if (op.status === 'failed') {
          resetOperationForRetry(op.id);
        }
      }
      toast.info(isRTL ? 'جاري إعادة المحاولة' : 'Retrying...', { description: isRTL ? 'يتم رفع العمليات المعلقة الآن...' : 'Uploading pending operations...' });
      if (syncContext?.syncNow) {
        await syncContext.syncNow();
      }
      const updatedQueue = loadQueue();
      const remainingFailed = updatedQueue.filter(op => op.status === 'failed' || !!op.error);
      setFailedOps(remainingFailed);
      if (remainingFailed.length === 0) {
        setDialogOpen(false);
      }
    } catch {
      toast.error(isRTL ? 'فشل بدء إعادة المحاولة' : 'Failed to start retry');
    } finally {
      setIsRetrying(false);
    }
  };

  const getOpTypeLabel = (type: string) => {
    switch (type) {
      case 'invoice_create': return isRTL ? 'فاتورة مبيعات نقدية' : 'Cash Sales Invoice';
      case 'debt_sale_bundle': return isRTL ? 'فاتورة مبيعات ذمة (آجلة)' : 'Credit Sales Invoice';
      case 'invoice_refund': return isRTL ? 'استرداد فاتورة' : 'Invoice Refund';
      case 'invoice_refund_partial': return isRTL ? 'استرداد جزئي' : 'Partial Refund';
      case 'quick_purchase': return isRTL ? 'شراء سريع' : 'Quick Purchase';
      case 'purchase_invoice': return isRTL ? 'فاتورة مشتريات' : 'Purchase Invoice';
      case 'stock_update': return isRTL ? 'تحديث مخزون' : 'Stock Update';
      default: return type;
    }
  };

  const getIcon = () => {
    switch (state) {
      case 'syncing':
        return <Loader2 className="h-4 w-4 animate-spin" />;
      case 'success':
        return <Check className="h-4 w-4" />;
      case 'error':
        return <AlertTriangle className="h-4 w-4" />;
      case 'offline':
        return <CloudOff className="h-4 w-4" />;
      default:
        return <Cloud className="h-4 w-4" />;
    }
  };

  const getMessage = () => {
    if (externalMessage) return externalMessage;
    
    switch (state) {
      case 'syncing': {
        const count = queueStatus.processingCount + queueStatus.pendingCount;
        return isRTL ? `جاري المزامنة... (${count})` : `Syncing... (${count})`;
      }
      case 'success':
        return isRTL ? 'تمت المزامنة ✓' : 'Synced ✓';
      case 'error':
        return isRTL ? `فشل (${queueStatus.failedCount}) - انقر للتفاصيل` : `Failed (${queueStatus.failedCount}) - Click details`;
      case 'offline':
        return isRTL ? 'غير متصل' : 'Offline';
      default:
        if (queueStatus.pendingCount > 0) {
          return isRTL ? `معلق (${queueStatus.pendingCount})` : `Pending (${queueStatus.pendingCount})`;
        }
        return '';
    }
  };

  const getStateStyles = () => {
    switch (state) {
      case 'syncing':
        return 'bg-primary/10 text-primary border-primary/20';
      case 'success':
        return 'bg-success/10 text-success border-success/20';
      case 'error':
        return 'bg-destructive/10 text-destructive border-destructive/20 cursor-pointer hover:bg-destructive/20';
      case 'offline':
        return 'bg-warning/10 text-warning border-warning/20';
      default:
        return 'bg-muted text-muted-foreground border-border cursor-pointer hover:bg-muted/80';
    }
  };

  const isClickable = queueStatus.failedCount > 0 || queueStatus.pendingCount > 0;

  return (
    <>
      <div
        role={isClickable ? "button" : undefined}
        tabIndex={isClickable ? 0 : undefined}
        onClick={isClickable ? handleOpenDialog : undefined}
        onKeyDown={isClickable ? (e) => e.key === 'Enter' && handleOpenDialog() : undefined}
        className={cn(
          "flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium border transition-[color,background-color,border-color] duration-150 select-none",
          isClickable && "min-h-11 sm:min-h-8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          getStateStyles(),
          className
        )}
        title={isClickable ? (isRTL ? "انقر لعرض تفاصيل العمليات المعلقة" : "Click to view queue details") : undefined}
      >
        {getIcon()}
        <span>{getMessage()}</span>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="w-[min(calc(100vw-1.5rem),28rem)] max-h-[calc(100dvh-1.5rem)] flex flex-col p-0 overflow-hidden rounded-[24px]" dir={isRTL ? "rtl" : "ltr"}>
          <DialogHeader className="shrink-0 px-4 pt-4 pb-3 sm:px-6 sm:pt-5 border-b border-border/60 text-start pe-12">
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive shrink-0" />
              <span>{isRTL ? 'حالة طابور المزامنة والعمليات المعلقة' : 'Sync Queue & Pending Operations'}</span>
            </DialogTitle>
          </DialogHeader>

          <DialogBody className="space-y-2.5 py-4">
            {failedOps.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                {isRTL ? 'لا توجد عمليات معلقة أو فاشلة حالياً' : 'No pending or failed operations'}
              </p>
            ) : (
              failedOps.map((op) => (
                <div key={op.id} className="p-3 rounded-xl border border-border bg-muted/40 space-y-1.5 text-xs">
                  <div className="flex items-center justify-between font-semibold">
                    <span className="text-foreground">{getOpTypeLabel(op.type)}</span>
                    <span className={cn(
                      "px-2 py-0.5 rounded-full text-xs",
                      op.status === 'failed' ? "bg-destructive/15 text-destructive" : "bg-primary/15 text-primary"
                    )}>
                      {op.status === 'failed' ? (isRTL ? 'فشلت' : 'Failed') : (isRTL ? 'قيد الانتظار' : 'Pending')}
                    </span>
                  </div>
                  {op.error && (
                    <div className="bg-destructive/10 text-destructive p-2 rounded text-xs font-mono break-words leading-tight">
                      <strong>{isRTL ? 'سبب الرفض: ' : 'Reason: '}</strong>
                      {op.error}
                    </div>
                  )}
                  <div className="flex justify-between items-center text-xs text-muted-foreground pt-1">
                    <span dir="ltr" className="inline-block tabular-nums">{new Date(op.createdAt).toLocaleTimeString('ar-SA')}</span>
                    {op.retryCount > 0 && (
                      <span>{isRTL ? 'محاولات: ' : 'Retries: '}<span dir="ltr" className="inline-block tabular-nums">{op.retryCount}/{op.maxRetries}</span></span>
                    )}
                  </div>
                </div>
              ))
            )}
          </DialogBody>

          <DialogFooter className="shrink-0 px-4 py-3 sm:px-6 border-t border-border/60">
            <Button variant="outline" size="default" onClick={() => setDialogOpen(false)}>
              {isRTL ? 'إغلاق' : 'Close'}
            </Button>
            {failedOps.some(op => op.status === 'failed') && (
              <Button variant="default" size="default" onClick={handleRetryAll} disabled={isRetrying} className="gap-1.5">
                <RefreshCw className={cn("h-4 w-4 shrink-0", isRetrying && "animate-spin")} />
                <span>{isRTL ? 'إعادة المحاولة الآن' : 'Retry Now'}</span>
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
