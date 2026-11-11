import { isLocalDataMode } from '@/hooks/use-network-status';
// Activity Log Store - Secure encrypted activity tracking
import { secureSet, secureGet, secureRemove } from './secure-storage';
import { supabase } from '@/integrations/supabase/client';

export type ActivityType = 
  | 'login'
  | 'expense_refund'
  | 'logout'
  | 'sale'
  | 'maintenance'
  | 'debt_created'
  | 'debt_paid'
  | 'debt_payment'
  | 'debt_writeoff'
  | 'debt_deleted'
  | 'product_added'
  | 'product_updated'
  | 'product_deleted'
  | 'customer_added'
  | 'customer_updated'
  | 'customer_deleted'
  | 'settings_changed'
  | 'user_added'
  | 'user_deleted'
  | 'password_changed'
  | 'backup_created'
  | 'invoice_created'
  | 'invoice_updated'
  | 'invoice_deleted'
  | 'invoice_refunded'
  | 'shift_opened'
  | 'shift_closed'
  | 'capital_added'
  | 'capital_withdrawn'
  | 'expense_added'
  | 'expense_deleted'
  | 'expense'
  | 'refund'
  | 'partial_refund'
  | 'partner_added'
  | 'partner_updated'
  | 'partner_deleted'
  | 'partner_withdrawal'
  | 'partner_investment';

// Device info for tracking action origin
interface DeviceInfo {
  platform: 'web' | 'android' | 'ios';
  userAgent: string;
  screenSize: string;
}

export interface ActivityLog {
  id: string;
  type: ActivityType;
  userId: string;
  userName: string;
  description: string;
  details?: Record<string, unknown>;
  timestamp: string;
  deviceInfo?: DeviceInfo;
}

const ACTIVITY_LOG_KEY = 'activity_log';
const STORAGE_NAMESPACE = 'hp_audit';
const MAX_LOGS = 500; // Keep last 500 activities
// Logs expire after 30 days for automatic cleanup
const LOG_EXPIRY = 30 * 24 * 60 * 60 * 1000;
const LOG_MAX_AGE_DAYS = 30;

// Get device info for activity tracking
const getDeviceInfo = (): DeviceInfo => {
  const isCapacitor = typeof window !== 'undefined' && 
    !!(window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  
  let platform: 'web' | 'android' | 'ios' = 'web';
  if (isCapacitor) {
    platform = /android/i.test(ua) ? 'android' : 'ios';
  }
  
  return {
    platform,
    userAgent: ua.substring(0, 100), // Limit length for storage efficiency
    screenSize: typeof window !== 'undefined' 
      ? `${window.screen?.width || 0}x${window.screen?.height || 0}` 
      : '0x0',
  };
};

export type FieldChanges = Record<string, { from: unknown; to: unknown }>;

export const diffFields = <T extends object>(before: T, after: T, keys: (keyof T)[]): FieldChanges => {
  const changes: FieldChanges = {};
  for (const key of keys) {
    if (before[key] !== after[key]) changes[String(key)] = { from: before[key], to: after[key] };
  }
  return changes;
};

export function loadActivityLogs(): ActivityLog[] {
  try {
    const logs = secureGet<ActivityLog[]>(ACTIVITY_LOG_KEY, { namespace: STORAGE_NAMESPACE });
    return logs || [];
  } catch {
    return [];
  }
}

export function saveActivityLogs(logs: ActivityLog[]) {
  try {
    // Keep only last MAX_LOGS
    const trimmedLogs = logs.slice(0, MAX_LOGS);
    secureSet(ACTIVITY_LOG_KEY, trimmedLogs, { 
      namespace: STORAGE_NAMESPACE,
      expiresIn: LOG_EXPIRY 
    });
  } catch {
    // Ignore storage errors
  }
}

export function addActivityLog(
  type: ActivityType,
  userId: string,
  userName: string,
  description: string,
  details?: Record<string, unknown>
): ActivityLog {
  const log: ActivityLog = {
    id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
    type,
    userId,
    userName,
    description,
    details,
    timestamp: new Date().toISOString(),
    deviceInfo: getDeviceInfo(),
  };

  // Load existing logs and filter out old ones (log rotation - 30 days)
  const now = Date.now();
  const logs = loadActivityLogs().filter(existingLog => {
    const logDate = new Date(existingLog.timestamp).getTime();
    const daysDiff = (now - logDate) / (1000 * 60 * 60 * 24);
    return daysDiff <= LOG_MAX_AGE_DAYS;
  });
  
  logs.unshift(log); // Add to beginning
  saveActivityLogs(logs);

  // رفع صامت في الخلفية لجدول activity_log ليتمكن المالك من مراجعة السجل من أي جهاز
  if (typeof navigator !== 'undefined' && !isLocalDataMode()) {
    import('./supabase-store').then(async ({ getOwnerIdForInsert }) => {
      const ownerId = await getOwnerIdForInsert();
      if (!ownerId) return;
      await (supabase as any).from('activity_log').insert({
        user_id: ownerId,
        actor_id: userId && /^[0-9a-f-]{36}$/i.test(userId) ? userId : null,
        actor_name: userName,
        action_type: type,
        description,
        metadata: (details ? { ...details, deviceInfo: log.deviceInfo } : { deviceInfo: log.deviceInfo }) as any,
      });
    }).catch(() => {});
  }

  return log;
}

export function getActivityLogsByUser(userId: string): ActivityLog[] {
  return loadActivityLogs().filter(log => log.userId === userId);
}

export function getActivityLogsByType(type: ActivityType): ActivityLog[] {
  return loadActivityLogs().filter(log => log.type === type);
}

export function getActivityLogsByDateRange(startDate: Date, endDate: Date): ActivityLog[] {
  return loadActivityLogs().filter(log => {
    const logDate = new Date(log.timestamp);
    return logDate >= startDate && logDate <= endDate;
  });
}

export function clearActivityLogs() {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(ACTIVITY_LOG_KEY);
}

export const activityTypeLabels: Record<ActivityType, { ar: string; en: string; tr: string; fr?: string }> = {
  expense_refund: { ar: 'استرداد وتراجع عن مصروف', en: 'Expense Refunded', tr: 'Gider İadesi', fr: 'Remboursement de dépense' },
  login: { ar: 'تسجيل دخول', en: 'Login', tr: 'Giriş Yapıldı', fr: 'Connexion' },
  logout: { ar: 'تسجيل خروج', en: 'Logout', tr: 'Çıkış Yapıldı', fr: 'Déconnexion' },
  sale: { ar: 'عملية بيع', en: 'Sale', tr: 'Satış İşlemi', fr: 'Vente' },
  maintenance: { ar: 'خدمة صيانة', en: 'Maintenance', tr: 'Bakım Hizmeti', fr: 'Maintenance' },
  debt_created: { ar: 'إنشاء دين', en: 'Debt Created', tr: 'Borç Oluşturuldu', fr: 'Dette Créée' },
  debt_paid: { ar: 'تسديد دين', en: 'Debt Paid', tr: 'Borç Ödendi', fr: 'Dette Payée' },
  debt_payment: { ar: 'تسديد دفعة', en: 'Debt Payment', tr: 'Taksit Ödemesi', fr: 'Paiement Dette' },
  debt_writeoff: { ar: 'إتلاف دين', en: 'Debt Write-off', tr: 'Borç Silindi', fr: 'Annulation Dette' },
  debt_deleted: { ar: 'حذف دين', en: 'Debt Deleted', tr: 'Borç Kaydı Silindi', fr: 'Dette Supprimée' },
  product_added: { ar: 'إضافة منتج', en: 'Product Added', tr: 'Ürün Eklendi', fr: 'Produit Ajouté' },
  product_updated: { ar: 'تعديل منتج', en: 'Product Updated', tr: 'Ürün Güncellendi', fr: 'Produit Modifié' },
  product_deleted: { ar: 'حذف منتج', en: 'Product Deleted', tr: 'Ürün Silindi', fr: 'Produit Supprimé' },
  customer_added: { ar: 'إضافة زبون', en: 'Customer Added', tr: 'Müşteri Eklendi', fr: 'Client Ajouté' },
  customer_updated: { ar: 'تعديل زبون', en: 'Customer Updated', tr: 'Müşteri Güncellendi', fr: 'Client Modifié' },
  customer_deleted: { ar: 'حذف زبون', en: 'Customer Deleted', tr: 'Müşteri Silindi', fr: 'Client Supprimé' },
  settings_changed: { ar: 'تغيير إعدادات', en: 'Settings Changed', tr: 'Ayarlar Değiştirildi', fr: 'Paramètres Modifiés' },
  user_added: { ar: 'إضافة مستخدم', en: 'User Added', tr: 'Kullanıcı Eklendi', fr: 'Utilisateur Ajouté' },
  user_deleted: { ar: 'حذف مستخدم', en: 'User Deleted', tr: 'Kullanıcı Silindi', fr: 'Utilisateur Supprimé' },
  password_changed: { ar: 'تغيير كلمة مرور', en: 'Password Changed', tr: 'Şifre Değiştirildi', fr: 'Mot de passe Changé' },
  backup_created: { ar: 'إنشاء نسخة احتياطية', en: 'Backup Created', tr: 'Yedekleme Oluşturuldu', fr: 'Sauvegarde Créée' },
  invoice_created: { ar: 'إنشاء فاتورة', en: 'Invoice Created', tr: 'Fatura Oluşturuldu', fr: 'Facture Créée' },
  invoice_updated: { ar: 'تعديل فاتورة', en: 'Invoice Updated', tr: 'Fatura Güncellendi', fr: 'Facture Modifiée' },
  invoice_deleted: { ar: 'حذف فاتورة', en: 'Invoice Deleted', tr: 'Fatura Silindi', fr: 'Facture Supprimée' },
  invoice_refunded: { ar: 'استرداد فاتورة', en: 'Invoice Refunded', tr: 'Fatura İade Edildi', fr: 'Facture Remboursée' },
  shift_opened: { ar: 'فتح وردية', en: 'Shift Opened', tr: 'Vardiya Açıldı', fr: 'Quart Ouvert' },
  shift_closed: { ar: 'إغلاق وردية', en: 'Shift Closed', tr: 'Vardiya Kapatıldı', fr: 'Quart Fermé' },
  capital_added: { ar: 'إيداع رصيد / رأس مال', en: 'Capital/Balance Deposit', tr: 'Sermaye/Bakiye Ekleme', fr: 'Capital Ajouté' },
  capital_withdrawn: { ar: 'سحب رأس مال', en: 'Capital Withdrawal', tr: 'Sermaye Çekimi', fr: 'Capital Retiré' },
  expense_added: { ar: 'تسجيل مصروف', en: 'Expense Added', tr: 'Gider Eklendi', fr: 'Dépense Ajoutée' },
  expense_deleted: { ar: 'حذف مصروف', en: 'Expense Deleted', tr: 'Gider Silindi', fr: 'Dépense Supprimée' },
  expense: { ar: 'مصروف', en: 'Expense', tr: 'Gider', fr: 'Dépense' },
  refund: { ar: 'مرتجع', en: 'Refund', tr: 'İade', fr: 'Remboursement' },
  partial_refund: { ar: 'استرداد جزئي', en: 'Partial refund', tr: 'Kısmi İade', fr: 'Remboursement partiel' },
  partner_added: { ar: 'إضافة شريك جديد', en: 'Partner Added', tr: 'Yeni Ortak Eklendi', fr: 'Partenaire Ajouté' },
  partner_updated: { ar: 'تعديل بيانات شريك', en: 'Partner Updated', tr: 'Ortak Güncellendi', fr: 'Partenaire Modifié' },
  partner_deleted: { ar: 'حذف شريك', en: 'Partner Deleted', tr: 'Ortak Silindi', fr: 'Partenaire Supprimé' },
  partner_investment: { ar: 'إيداع رأس مال شريك', en: 'Partner Capital Deposit', tr: 'Ortak Sermaye Girişi', fr: 'Investissement Partenaire' },
  partner_withdrawal: { ar: 'سحب أرباح شريك', en: 'Partner Profit Withdrawal', tr: 'Ortak Kâr Çekimi', fr: 'Retrait Partenaire' },
};

/**
 * دالة مساعدة موحدة لترجمة نوع النشاط حسب لغة التطبيق الحالية
 */
export const getActivityTypeLabel = (type: ActivityType, lang: string = 'ar'): string => {
  const item = activityTypeLabels[type];
  if (!item) return type;
  if (lang === 'ar') return item.ar;
  if (lang === 'tr') return item.tr || item.en;
  if (lang === 'fr' && (item as any).fr) return (item as any).fr;
  return item.en;
};

/**
 * Convenience helper: log an activity automatically resolving the current Supabase user.
 * Safe to call without awaiting.
 */
export async function logActivity(
  type: ActivityType,
  description: string,
  details?: Record<string, unknown>
): Promise<void> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    let userName = user.email || 'مستخدم';
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: profile } = await (supabase as any)
        .from('profiles')
        .select('full_name')
        .eq('user_id', user.id)
        .maybeSingle();
      if (profile?.full_name) userName = profile.full_name;
    } catch { /* ignore */ }
    addActivityLog(type, user.id, userName, description, details);
    // Also persist to cloud activity_log (best-effort, non-blocking)
    try {
      let actorRole: string | null = null;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: roleRow } = await (supabase as any)
          .from('user_roles')
          .select('role, owner_id')
          .eq('user_id', user.id)
          .maybeSingle();
        actorRole = roleRow?.role || null;
        const ownerId = roleRow?.owner_id || user.id;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (supabase as any).from('activity_log').insert({
          user_id: ownerId,
          actor_id: user.id,
          actor_name: userName,
          actor_role: actorRole,
          action_type: type,
          entity_type: (details?.entityType as string) || null,
          entity_id: (details?.entityId as string) || null,
          entity_name: (details?.entityName as string) || null,
          description,
          metadata: details || {},
        });
      } catch { /* offline — local log is enough */ }
    } catch { /* ignore */ }
  } catch (e) {
    console.warn('[activity-log] logActivity failed:', e);
  }
}
