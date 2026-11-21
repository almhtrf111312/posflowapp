import { useState, useEffect, useCallback, createContext, useContext, ReactNode } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './use-auth';
import { showToast } from '@/lib/toast-config';
import { loadProductsCloud, getStatus } from '@/lib/cloud/products-cloud';
import { loadDebtsCloud } from '@/lib/cloud/debts-cloud';
import { sendLocalNotification } from '@/lib/native-notifications';
import { formatMoney } from '@/lib/utils';

export type NotificationCategory = 'sale' | 'expense' | 'debt' | 'inventory' | 'purchase' | 'sync' | 'system';

export interface NotificationMeta {
  operationTitle?: string;
  amountText?: string;
  partyOrItem?: string;
  syncState?: 'synced' | 'pending' | 'failed';
  details?: string;
}

export interface Notification {
  id: string;
  type: 'debt_overdue' | 'debt_due_today' | 'low_stock' | 'out_of_stock' | 'expired' | 'expiring_soon' | 'license_status' | 'license_expiring' | 'sale' | 'expense' | 'debt' | 'inventory' | 'purchase' | 'sync' | 'system';
  category?: NotificationCategory;
  meta?: NotificationMeta;
  title: string;
  message: string;
  timestamp: Date;
  read: boolean;
  persistent?: boolean;
  actionUrl?: string;
  data?: {
    customerId?: string;
    customerName?: string;
    productId?: string;
    productName?: string;
    amount?: number;
    quantity?: number;
    expiryDate?: string;
    licenseExpiresAt?: string;
    licenseDaysRemaining?: number;
  };
}

interface NotificationsContextType {
  notifications: Notification[];
  archivedNotifications: Notification[];
  unreadCount: number;
  markAsRead: (id: string) => void;
  markAllAsRead: () => void;
  clearNotification: (id: string) => void;
  clearAllNotifications: () => void;
  archiveNotification: (id: string) => void;
  addArchivedNotification: (notification: Notification) => void;
  restoreNotification: (id: string) => void;
  deleteArchivedNotification: (id: string) => void;
  clearAllArchived: () => void;
  addNotification: (notification: Omit<Notification, 'id' | 'timestamp' | 'read'>, silent?: boolean) => void;
  refreshNotifications: () => void;
  checkLicenseStatus: (expiresAt: string | null, remainingDays: number | null, isTrial?: boolean) => void;
}

export const NotificationsContext = createContext<NotificationsContextType | undefined>(undefined);

const ARCHIVED_STORAGE_KEY = 'posflow_archived_notifications';

const loadArchivedFromStorage = (): Notification[] => {
  try {
    const raw = localStorage.getItem(ARCHIVED_STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw).map((n: any) => ({ ...n, timestamp: new Date(n.timestamp) }));
  } catch { return []; }
};

const saveArchivedToStorage = (items: Notification[]) => {
  try {
    localStorage.setItem(ARCHIVED_STORAGE_KEY, JSON.stringify(items));
  } catch {}
};

// حالة "مقروء" لتنبيهات المخزون والديون الآلية تُحفظ محلياً حتى لا تعود غير مقروءة عند كل فحص
const READ_ALERTS_KEY = 'hp_read_alert_ids';
const loadReadAlertIds = (): Set<string> => {
  try { return new Set(JSON.parse(localStorage.getItem(READ_ALERTS_KEY) || '[]')); } catch { return new Set(); }
};
const saveReadAlertIds = (ids: Iterable<string>) => {
  try {
    const merged = new Set([...loadReadAlertIds(), ...ids]);
    localStorage.setItem(READ_ALERTS_KEY, JSON.stringify([...merged].slice(-500)));
  } catch { /* ignore */ }
};

const getExpiryStatus = (expiryDate: string): 'expired' | 'expiring_soon' | 'valid' => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expiry = new Date(expiryDate);
  expiry.setHours(0, 0, 0, 0);
  const diffDays = Math.ceil((expiry.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays < 0) return 'expired';
  if (diffDays <= 30) return 'expiring_soon';
  return 'valid';
};

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [archivedNotifications, setArchivedNotifications] = useState<Notification[]>(loadArchivedFromStorage);
  const [hasCheckedInitial, setHasCheckedInitial] = useState(false);

  // جلب الإشعارات المحفوظة في السحابة عند تسجيل الدخول
  useEffect(() => {
    if (!user?.id) return;

    async function loadCloudNotifications() {
      try {
        const { data, error } = await supabase
          .from('user_notifications')
          .select('*')
          .eq('user_id', user.id)
          .eq('is_archived', false)
          .order('created_at', { ascending: false })
          .limit(50);

        if (error) {
          console.warn('Failed to load cloud notifications:', error);
          return;
        }

        if (data && data.length > 0) {
          const formatted: Notification[] = data.map((n: any) => ({
            id: n.id,
            title: n.title,
            message: n.message,
            type: n.type || 'system',
            read: !!n.is_read,
            timestamp: new Date(n.created_at),
            actionUrl: n.action_url,
          }));
          setNotifications(prev => {
            const existingIds = new Set(prev.map(p => p.id));
            // تجاهل النسخة السحابية لإشعار أضافه هذا الجهاز نفسه للتو (معرّف محلي مختلف)
            const newOnes = formatted.filter(f =>
              !existingIds.has(f.id) &&
              !prev.some(p => p.title === f.title && p.message === f.message &&
                Math.abs(p.timestamp.getTime() - f.timestamp.getTime()) < 15000)
            );
            return [...newOnes, ...prev];
          });
        }
      } catch (err) {
        console.warn('Error loading cloud notifications:', err);
      }
    }

    loadCloudNotifications();

    // استقبال الإشعارات السحابية الجديدة فور وصولها (طلبات التجديد للمدير، تفعيل الاشتراك للعميل...)
    const channel = supabase
      .channel(`user_notifications_${user.id}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'user_notifications', filter: `user_id=eq.${user.id}` },
        (payload) => {
          const n = payload.new as any;
          if (!n?.id || n.is_archived) return;
          setNotifications(prev => {
            if (prev.some(p => p.id === n.id)) return prev;
            // تجاهل النسخة السحابية لإشعار أضافه هذا الجهاز نفسه للتو
            const createdMs = new Date(n.created_at).getTime();
            if (prev.some(p => p.title === n.title && p.message === n.message && Math.abs(p.timestamp.getTime() - createdMs) < 15000)) {
              return prev;
            }
            return [{
              id: n.id,
              title: n.title,
              message: n.message,
              type: n.type || 'system',
              read: !!n.is_read,
              timestamp: new Date(n.created_at),
              actionUrl: n.action_url,
            }, ...prev];
          });
          const type = String(n.type || '');
          if (type.startsWith('license')) {
            window.dispatchEvent(new Event('posflow:license-changed'));
          }
          if (type.startsWith('license') || type === 'subscription_request') {
            showToast.info(n.title, { description: n.message });
          }
        }
      )
      .subscribe();

    // تحديث القائمة عند العودة إلى التطبيق (في حال انقطع الاتصال اللحظي)
    const handleVisible = () => {
      if (document.visibilityState === 'visible') loadCloudNotifications();
    };
    document.addEventListener('visibilitychange', handleVisible);

    return () => {
      supabase.removeChannel(channel);
      document.removeEventListener('visibilitychange', handleVisible);
    };
  }, [user?.id]);

  // Sync archived to localStorage
  useEffect(() => {
    saveArchivedToStorage(archivedNotifications);
  }, [archivedNotifications]);

  const addNotification = useCallback((notification: Omit<Notification, 'id' | 'timestamp' | 'read'> & { id?: string }, silent = false) => {
    const newId = notification.id || (Date.now().toString() + Math.random().toString(36).substr(2, 9));
    const newNotification: Notification = {
      ...notification,
      id: newId,
      timestamp: new Date(),
      read: false,
    };

    setNotifications(prev => {
      const exists = prev.some(n => {
        if (n.id === newId) return true;
        if (n.type !== notification.type) return false;
        if (notification.data?.productId && n.data?.productId === notification.data.productId) return true;
        if (notification.data?.customerId && n.data?.customerId === notification.data.customerId) return true;
        if (n.type === 'license_status' || n.type === 'license_expiring') {
          return notification.type === 'license_status' || notification.type === 'license_expiring';
        }
        return false;
      });
      if (exists) return prev;
      return [newNotification, ...prev];
    });

    // حفظ الإشعار في جدول user_notifications بالسحابة فقط للإشعارات الصريحة (تجنب الإشعارات الصامتة الآلية لمنع تكرار الإشعارات)
    if (user?.id && !silent) {
      supabase.from('user_notifications').insert({
        user_id: user.id,
        title: notification.title,
        message: notification.message,
        type: notification.type || 'system',
        is_read: false,
        is_archived: false,
        action_url: notification.actionUrl || null,
      }).then(({ error }) => {
        if (error) console.warn('[Notifications] Cloud persistence error:', error);
      });
    }

    if (!silent && notification.type !== 'license_status') {
      const toastType = notification.type.includes('overdue') ||
                       notification.type === 'out_of_stock' ||
                       notification.type === 'expired'
        ? 'error' : 'warning';
      const structuredOptions = {
        description: notification.message,
        operation: notification.type === 'low_stock' ? 'تنبيه مخزون حرج'
                 : notification.type === 'out_of_stock' ? 'نفاد المخزون'
                 : notification.type === 'debt_overdue' ? 'دين متأخر'
                 : notification.type === 'debt_due_today' ? 'دين مستحق اليوم'
                 : notification.title,
        itemName: notification.data?.productName,
        stockQuantity: notification.data?.quantity,
        isMultiple: false,
      };
      // ✅ إشعار تفاعلي فوري داخل التطبيق حصراً (In-App Only) عبر Dynamic Island SmartToast
      if (toastType === 'error') {
        showToast.error(notification.title, structuredOptions);
      } else {
        showToast.warning(notification.title, structuredOptions);
      }
    }
  }, [user?.id]);


  const markAsRead = useCallback(async (id: string) => {
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: true } : n));
    if (id.startsWith('alert_') || id.startsWith('license_')) saveReadAlertIds([id]);
    if (id.startsWith('alert_') || id.startsWith('license_')) return;
    if (user?.id) {
      try {
        await supabase.from('user_notifications').update({ is_read: true }).eq('id', id).eq('user_id', user.id);
      } catch { /* ignore offline */ }
    }
  }, [user?.id]);

  const markAllAsRead = useCallback(async () => {
    setNotifications(prev => {
      saveReadAlertIds(prev.filter(n => n.id.startsWith('alert_') || n.id.startsWith('license_')).map(n => n.id));
      return prev.map(n => ({ ...n, read: true }));
    });
    if (user?.id) {
      try {
        await supabase.from('user_notifications').update({ is_read: true }).eq('user_id', user.id);
      } catch { /* ignore offline */ }
    }
  }, [user?.id]);

  const clearNotification = useCallback(async (id: string) => {
    setNotifications(prev => prev.filter(n => n.id !== id));
    if (user?.id) {
      try {
        await supabase.from('user_notifications').delete().eq('id', id).eq('user_id', user.id);
      } catch { /* ignore offline */ }
    }
  }, [user?.id]);

  const clearAllNotifications = useCallback(async () => {
    setNotifications(prev => prev.filter(n => n.persistent));
    if (user?.id) {
      try {
        await supabase.from('user_notifications').delete().eq('user_id', user.id);
      } catch { /* ignore offline */ }
    }
  }, [user?.id]);

  const archiveNotification = useCallback((id: string) => {
    setNotifications(prev => {
      const notification = prev.find(n => n.id === id);
      if (notification) {
        setArchivedNotifications(archived => [notification, ...archived]);
      }
      return prev.filter(n => n.id !== id);
    });
  }, []);

  const restoreNotification = useCallback((id: string) => {
    setArchivedNotifications(prev => {
      const notification = prev.find(n => n.id === id);
      if (notification) {
        setNotifications(active => [notification, ...active]);
      }
      return prev.filter(n => n.id !== id);
    });
  }, []);

  const deleteArchivedNotification = useCallback((id: string) => {
    setArchivedNotifications(prev => prev.filter(n => n.id !== id));
  }, []);

  const addArchivedNotification = useCallback((notification: Notification) => {
    setArchivedNotifications(prev => {
      if (prev.some(n => n.id === notification.id)) return prev;
      const updated = [notification, ...prev].slice(0, 300);
      saveArchivedToStorage(updated);
      return updated;
    });
  }, []);

  const clearAllArchived = useCallback(() => {
    setArchivedNotifications([]);
  }, []);

  const unreadCount = notifications.filter(n => !n.read).length;

  const checkLicenseStatus = useCallback((expiresAt: string | null, remainingDays: number | null, isTrial?: boolean) => {
    if (!user?.id || !expiresAt || remainingDays === null) return;
    const expiryDate = new Date(expiresAt).toLocaleDateString('ar-SA', {
      year: 'numeric', month: 'long', day: 'numeric',
    });
    const expiring = remainingDays <= 7;
    const type = expiring ? 'license_expiring' : 'license_status';
    const id = `${type}_${user.id}_${expiresAt}`;
    const trialPrefix = isTrial ? '(تجريبي) ' : '';
    const showRemaining = remainingDays <= 30 || isTrial;
    const title = expiring ? `⚠️ ${trialPrefix}الترخيص ينتهي قريباً`
      : showRemaining ? `🔑 ${trialPrefix}حالة الترخيص` : '✅ الترخيص مفعّل';
    const message = expiring ? `متبقي ${remainingDays} ${remainingDays === 1 ? 'يوم' : 'أيام'} على انتهاء الترخيص`
      : isTrial ? `متبقي ${remainingDays} يوم من الفترة التجريبية`
      : showRemaining ? `الترخيص صالح حتى ${expiryDate} (متبقي ${remainingDays} يوم)` : `الترخيص صالح حتى ${expiryDate}`;
    const wasRead = loadReadAlertIds().has(id);

    setNotifications(prev => {
      const current = prev.find(n => n.id === id);
      if (current?.title === title && current.message === message) return prev;
      const notification: Notification = {
        id, type, title, message,
        timestamp: current?.timestamp ?? new Date(),
        read: current?.read ?? (wasRead || !showRemaining),
        persistent: true,
        data: { licenseExpiresAt: expiresAt, licenseDaysRemaining: remainingDays },
      };
      return [notification, ...prev.filter(n => !n.id.startsWith('license_'))];
    });
  }, [user?.id]);

  const checkAlerts = useCallback(async () => {
    try {
      // تُجمع التنبيهات أولاً ثم تُستبدل دفعة واحدة: لا تفرغ القائمة مؤقتاً (كان ذلك سبب الوميض)
      const collected: Notification[] = [];
      const readAlerts = loadReadAlertIds();
      const pushAlert = (n: Omit<Notification, 'timestamp' | 'read'> & { id: string }) => {
        collected.push({ ...n, timestamp: new Date(), read: readAlerts.has(n.id) } as Notification);
      };
      const [products, debts] = await Promise.all([loadProductsCloud(), loadDebtsCloud()]);
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      // 🛡️ تُضاف كل التنبيهات بصمت (silent) لمنع انهمار عشرات الـ toast عند الإقلاع
      let alertsCount = 0;

      debts.forEach(debt => {
        if (debt.remainingDebt > 0 && debt.dueDate) {
          const dueDate = new Date(debt.dueDate);
          dueDate.setHours(0, 0, 0, 0);
          const diffDays = Math.ceil((dueDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
          if (diffDays < 0) {
            alertsCount++;
            pushAlert({
              id: 'alert_debt_overdue_' + debt.id,
              type: 'debt_overdue', title: 'دين متأخر',
              message: `الدين المستحق من ${debt.customerName} بقيمة ${formatMoney(debt.remainingDebt)} متأخر عن موعد السداد`,
              data: { customerId: debt.id, customerName: debt.customerName, amount: debt.remainingDebt },
            });
          } else if (diffDays === 0) {
            alertsCount++;
            pushAlert({
              id: 'alert_debt_due_' + debt.id,
              type: 'debt_due_today', title: 'دين مستحق اليوم',
              message: `الدين المستحق من ${debt.customerName} بقيمة ${formatMoney(debt.remainingDebt)} يستحق اليوم`,
              data: { customerId: debt.id, customerName: debt.customerName, amount: debt.remainingDebt },
            });
          }
        }
      });

      products.filter(p => p.status === 'low_stock').forEach(product => {
        alertsCount++;
        pushAlert({
          id: 'alert_low_stock_' + product.id,
          type: 'low_stock', title: 'مخزون منخفض',
          message: `المنتج "${product.name}" لديه كمية منخفضة (${product.quantity} فقط)`,
          data: { productId: product.id, productName: product.name, quantity: product.quantity },
        });
      });

      products.filter(p => p.status === 'out_of_stock').forEach(product => {
        alertsCount++;
        pushAlert({
          id: 'alert_out_of_stock_' + product.id,
          type: 'out_of_stock', title: 'نفذ المخزون',
          message: `المنتج "${product.name}" نفذ من المخزون`,
          data: { productId: product.id, productName: product.name, quantity: 0 },
        });
      });

      products.forEach(product => {
        if (product.expiryDate) {
          const status = getExpiryStatus(product.expiryDate);
          if (status === 'expired') {
            alertsCount++;
            pushAlert({
              id: 'alert_expired_' + product.id,
              type: 'expired', title: 'منتج منتهي الصلاحية ⚠️',
              message: `المنتج "${product.name}" انتهت صلاحيته في ${product.expiryDate}`,
              data: { productId: product.id, productName: product.name, expiryDate: product.expiryDate },
            });
          } else if (status === 'expiring_soon') {
            alertsCount++;
            pushAlert({
              id: 'alert_expiring_soon_' + product.id,
              type: 'expiring_soon', title: 'صلاحية قريبة الانتهاء',
              message: `المنتج "${product.name}" ستنتهي صلاحيته في ${product.expiryDate}`,
              data: { productId: product.id, productName: product.name, expiryDate: product.expiryDate },
            });
          }
        }
      });

      setNotifications(prev => {
        const prevById = new Map(prev.map(n => [n.id, n]));
        const fresh = collected.map(n => {
          const old = prevById.get(n.id);
          return old ? { ...n, timestamp: old.timestamp, read: old.read || n.read } : n;
        });
        const others = prev.filter(n => !n.id.startsWith('alert_'));
        return [...others, ...fresh];
      });

      // إشعار مُجمّع ذكي: لا نكرر ظهور التنبيه إلا إذا زاد عدد التنبيهات أو مضت 12 ساعة
      if (alertsCount > 0) {
        const lastToastTime = Number(localStorage.getItem('hp_last_alert_toast_time') || 0);
        const lastAlertCount = Number(localStorage.getItem('hp_last_alert_count') || 0);
        const twelveHoursMs = 12 * 60 * 60 * 1000;
        const now = Date.now();

        if (alertsCount > lastAlertCount || now - lastToastTime > twelveHoursMs) {
          localStorage.setItem('hp_last_alert_toast_time', String(now));
          localStorage.setItem('hp_last_alert_count', String(alertsCount));
          showToast.warning('تنبيهات جديدة', {
            description: `لديك ${alertsCount} تنبيه بحاجة للمراجعة. افتح قائمة الإشعارات للتفاصيل.`,
          });
        }
      } else {
        localStorage.setItem('hp_last_alert_count', '0');
      }
    } catch (error) {
      console.error('Failed to check alerts:', error);
    }
  }, []);


  const refreshNotifications = useCallback(() => {
    // يعيد حساب تنبيهات المخزون والديون فقط ويستبدلها ذرياً، دون مسح إشعارات السحابة أو الترخيص
    checkAlerts();
  }, [checkAlerts]);

  useEffect(() => {
    if (hasCheckedInitial) return;
    setHasCheckedInitial(true);
    const timer = setTimeout(checkAlerts, 1000);
    return () => clearTimeout(timer);
  }, [hasCheckedInitial, checkAlerts]);

  return (
    <NotificationsContext.Provider value={{
      notifications,
      archivedNotifications,
      unreadCount,
      markAsRead,
      markAllAsRead,
      clearNotification,
      clearAllNotifications,
      archiveNotification,
      addArchivedNotification,
      restoreNotification,
      deleteArchivedNotification,
      clearAllArchived,
      addNotification,
      refreshNotifications,
      checkLicenseStatus,
    }}>
      {children}
    </NotificationsContext.Provider>
  );
}

const defaultNotificationsContext: NotificationsContextType = {
  notifications: [],
  archivedNotifications: [],
  unreadCount: 0,
  markAsRead: () => {},
  markAllAsRead: () => {},
  clearNotification: () => {},
  clearAllNotifications: () => {},
  archiveNotification: () => {},
  addArchivedNotification: () => {},
  restoreNotification: () => {},
  deleteArchivedNotification: () => {},
  clearAllArchived: () => {},
  addNotification: () => {},
  refreshNotifications: () => {},
  checkLicenseStatus: () => {},
};

export function useNotifications() {
  const context = useContext(NotificationsContext);
  if (!context) {
    console.warn('useNotifications called outside NotificationsProvider, using default values');
    return defaultNotificationsContext;
  }
  return context;
}
