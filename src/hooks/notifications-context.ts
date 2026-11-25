import { createContext, useContext } from 'react';

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
    category?: string;
    version?: number;
  };
}
export interface NotificationsContextType {
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
export const ARCHIVED_STORAGE_KEY = 'posflow_archived_notifications';
/** A row of user_notifications as the cloud and realtime feeds deliver it. */
export type NotificationRow = {
  id: string;
  title: string;
  message: string;
  type?: string | null;
  is_read?: boolean | null;
  is_archived?: boolean | null;
  created_at: string;
  action_url?: string | null;
};
export const loadArchivedFromStorage = (): Notification[] => {
  try {
    const raw = localStorage.getItem(ARCHIVED_STORAGE_KEY);
    if (!raw) return [];
    return (JSON.parse(raw) as Array<Record<string, unknown> & { timestamp: string }>).map((n) => ({ ...n, timestamp: new Date(n.timestamp) })) as unknown as Notification[];
  } catch { return []; }
};
export const saveArchivedToStorage = (items: Notification[]) => {
  try {
    localStorage.setItem(ARCHIVED_STORAGE_KEY, JSON.stringify(items));
  } catch { /* intentionally empty */ }
};
// حالة "مقروء" لتنبيهات المخزون والديون الآلية تُحفظ محلياً حتى لا تعود غير مقروءة عند كل فحص
export const READ_ALERTS_KEY = 'hp_read_alert_ids';
export const loadReadAlertIds = (): Set<string> => {
  try { return new Set(JSON.parse(localStorage.getItem(READ_ALERTS_KEY) || '[]')); } catch { return new Set(); }
};
export const saveReadAlertIds = (ids: Iterable<string>) => {
  try {
    const merged = new Set([...loadReadAlertIds(), ...ids]);
    localStorage.setItem(READ_ALERTS_KEY, JSON.stringify([...merged].slice(-500)));
  } catch { /* ignore */ }
};
export const getExpiryStatus = (expiryDate: string): 'expired' | 'expiring_soon' | 'valid' => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expiry = new Date(expiryDate);
  expiry.setHours(0, 0, 0, 0);
  const diffDays = Math.ceil((expiry.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays < 0) return 'expired';
  if (diffDays <= 30) return 'expiring_soon';
  return 'valid';
};
export const defaultNotificationsContext: NotificationsContextType = {
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
