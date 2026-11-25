import { useCallback, useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bell,
  Download,
  Megaphone,
  Wrench,
  AlertTriangle,
  RefreshCw,
  CheckCheck,
  Clock,
  ShieldCheck,
  Trash2,
  ArrowRight,
  Package,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/components/layout/PageHeader';
import { useLanguage } from '@/hooks/language-context';
import { useNotifications, type Notification } from '@/hooks/notifications-context';
import { useAuth } from '@/hooks/auth-context';
import { toast } from '@/lib/sonner-bridge';
import {
  fetchActiveBroadcasts,
  getCachedReleaseConfig,
  getSeenBroadcasts,
  syncSeenBroadcastsWithCloud,
  markBroadcastSeenCloud,
  openExternal,
  CURRENT_VERSION_CODE,
  type Broadcast,
} from '@/lib/remote-updates';

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000; // 72 ساعة

export interface UnifiedItem {
  id: string;
  source: 'broadcast' | 'store';
  title: string;
  body: string;
  kind: string;
  created_at: string;
  isRead: boolean;
  link_url?: string | null;
  target_version_code?: number | null;
  actionUrl?: string;
  rawBroadcast?: Broadcast;
  rawNotification?: Notification;
}

const stripImageTags = (t: string) =>
  t.replace(/\[IMAGE\][\s\S]*?\[\/IMAGE\]/g, '📷 صورة').replace(/\[IMAGE\][A-Za-z0-9+/=:;,._-]{40,}/g, '📷 صورة').trim();

export default function Notifications() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { direction } = useLanguage();
  const {
    notifications,
    markAsRead: markUserNotificationAsRead,
    markAllAsRead: markAllUserNotificationsAsRead,
    clearNotification,
    addArchivedNotification,
    refreshNotifications,
  } = useNotifications();

  const [rawItems, setRawItems] = useState<Broadcast[]>([]);
  const [seenIds, setSeenIds] = useState<string[]>(getSeenBroadcasts);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'all' | 'unread' | 'read'>('all');

  const releaseConfig = getCachedReleaseConfig();
  const latestBuildCode = releaseConfig.latest_version_code || releaseConfig.min_version_code || CURRENT_VERSION_CODE;
  const updateUrl = releaseConfig.update_url || releaseConfig.telegram_url || 'https://t.me/posflowapp';

  // جلب إعلانات البث النشطة من السحابة ومزامنة المقروء
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await fetchActiveBroadcasts();
      setRawItems(list);
      if (user?.id) {
        await syncSeenBroadcastsWithCloud(user.id);
      }
      setSeenIds(getSeenBroadcasts());
      if (refreshNotifications) refreshNotifications();
    } catch {
      /* وضع عدم الاتصال */
    } finally {
      setLoading(false);
    }
  }, [refreshNotifications, user?.id]);

  useEffect(() => {
    load();
    // حدث تحديث المقروء يحدّث الحالة فقط؛ إعادة التحميل هنا كانت تصنع حلقة لا تنتهي (سبب الوميض)
    const h = () => {
      setSeenIds(getSeenBroadcasts());
    };
    window.addEventListener('hp-broadcasts-updated', h);
    return () => window.removeEventListener('hp-broadcasts-updated', h);
  }, [load]);

  // تصفية إعلانات البث
  const filteredBroadcasts = useMemo(() => {
    const now = Date.now();

    return rawItems.filter((b) => {
      const isUpdate = b.kind === 'update';
      const targetCode = b.target_version_code || latestBuildCode;

      if (isUpdate) {
        if (CURRENT_VERSION_CODE >= targetCode) return false;
        return true;
      }

      if (b.target_version_code && CURRENT_VERSION_CODE >= b.target_version_code) return false;
      const createdAt = new Date(b.created_at).getTime();
      const isOlderThan3Days = now - createdAt > THREE_DAYS_MS;
      if (isOlderThan3Days) {
        return false;
      }

      return true;
    });
  }, [rawItems, latestBuildCode]);

  // أرشفة إعلانات البث الأقدم من 3 أيام خارج مرحلة الرسم (كانت تُنفَّذ داخل useMemo فتسبب إعادة رسم إضافية)
  useEffect(() => {
    const now = Date.now();
    for (const b of rawItems) {
      if (b.kind === 'update') continue;
      if (now - new Date(b.created_at).getTime() <= THREE_DAYS_MS) continue;
      addArchivedNotification({
        id: b.id,
        type: 'system',
        category: 'system',
        title: b.title,
        message: b.body || '',
        timestamp: new Date(b.created_at),
        read: true,
        data: {
          category: b.kind,
          version: b.target_version_code,
        },
      });
    }
  }, [rawItems, addArchivedNotification]);

  // دمج إعلانات البث وإشعارات المتجر والنظام في قائمة موحدة
  const allItems: UnifiedItem[] = useMemo(() => {
    const list: UnifiedItem[] = [];

    // 1. إعلانات البث الإدارية
    for (const b of filteredBroadcasts) {
      list.push({
        id: b.id,
        source: 'broadcast',
        title: b.title,
        body: b.body || '',
        kind: b.kind,
        created_at: b.created_at,
        isRead: seenIds.includes(b.id),
        link_url: b.link_url,
        target_version_code: b.target_version_code,
        rawBroadcast: b,
      });
    }

    // 2. إشعارات النظام والمتجر (المخزون، الديون، الترخيص، العمليات)
    for (const n of notifications) {
      list.push({
        id: n.id,
        source: 'store',
        title: n.title,
        body: n.message,
        kind: n.category || n.type || 'system',
        created_at: n.timestamp instanceof Date ? n.timestamp.toISOString() : String(n.timestamp),
        isRead: n.read,
        actionUrl: n.actionUrl,
        rawNotification: n,
      });
    }

    return list.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }, [filteredBroadcasts, seenIds, notifications]);

  const markItemRead = (item: UnifiedItem) => {
    if (item.isRead) return;
    if (item.source === 'broadcast') {
      markBroadcastSeenCloud(item.id, user?.id);
      setSeenIds(getSeenBroadcasts());
    } else {
      void markUserNotificationAsRead(item.id);
    }
  };

  const markAllRead = () => {
    for (const broadcast of filteredBroadcasts) {
      if (!seenIds.includes(broadcast.id)) markBroadcastSeenCloud(broadcast.id, user?.id);
    }
    setSeenIds(getSeenBroadcasts());
    void markAllUserNotificationsAsRead();
  };

  // أرشفة أو حذف الإشعار
  const handleDeleteOrArchive = (item: UnifiedItem) => {
    if (item.source === 'broadcast' && item.rawBroadcast) {
      addArchivedNotification({
        id: item.rawBroadcast.id,
        type: 'system',
        category: 'system',
        title: item.rawBroadcast.title,
        message: item.rawBroadcast.body || '',
        timestamp: new Date(item.rawBroadcast.created_at || Date.now()),
        read: true,
        data: {
          category: item.rawBroadcast.kind,
          version: item.rawBroadcast.target_version_code,
        },
      });
      setRawItems((prev) => prev.filter((x) => x.id !== item.id));
      toast.success('تم نقل الإشعار إلى الأرشيف');
    } else {
      clearNotification(item.id);
      toast.success('تم حذف الإشعار بنجاح');
    }
  };

  const unreadCount = allItems.filter((i) => !i.isRead).length;
  const readCount = allItems.filter((i) => i.isRead).length;

  const displayedItems = useMemo(() => {
    if (tab === 'unread') return allItems.filter((i) => !i.isRead);
    if (tab === 'read') return allItems.filter((i) => i.isRead);
    return allItems;
  }, [allItems, tab]);

  const getItemIcon = (item: UnifiedItem) => {
    if (item.kind === 'update') return Download;
    if (item.kind === 'warning' || item.kind === 'inventory' || item.kind.includes('stock')) return Package;
    if (item.kind === 'maintenance') return Wrench;
    if (item.kind === 'debt' || item.kind.includes('debt')) return Clock;
    if (item.kind.includes('license')) return ShieldCheck;
    return Megaphone;
  };

  const getItemBadge = (item: UnifiedItem) => {
    if (item.source === 'broadcast') {
      if (item.kind === 'update') return 'تحديث النظام';
      if (item.kind === 'maintenance') return 'صيانة مجدولة';
      return 'إعلان إداري';
    }
    if (item.kind === 'inventory' || item.kind.includes('stock')) return 'المخزون';
    if (item.kind === 'debt' || item.kind.includes('debt')) return 'الديون';
    if (item.kind.includes('license')) return 'الترخيص';
    return 'تنبيه النظام';
  };

  return (
    <div className="w-full min-w-0 max-w-3xl mx-auto p-3 sm:p-4 md:p-6 space-y-4 md:space-y-6 min-h-[70vh]" dir={direction}>
      <PageHeader
        title="الإشعارات والتنبيهات"
        icon={<Bell className="w-5 h-5" />}
        actions={
          <div className="flex shrink-0 items-center gap-1">
            <Button variant="ghost" size="icon" onClick={markAllRead} disabled={unreadCount === 0}
              aria-label="تحديد الكل كمقروء" title="تحديد الكل كمقروء">
              <CheckCheck className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" onClick={load} aria-label="تحديث">
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        }
      />

      {/* كبسولات التصفية (الكل / غير المقروءة / المقروءة) */}
      <div className="grid grid-cols-3 gap-2 border-b border-border/60 pb-2 w-full">
        <Button
          variant={tab === 'all' ? 'default' : 'outline'}
          size="sm"
          className="rounded-xl text-xs min-h-10 sm:min-h-9 w-full px-2"
          onClick={() => setTab('all')}
        >
          الكل ({allItems.length})
        </Button>
        <Button
          variant={tab === 'unread' ? 'default' : 'outline'}
          size="sm"
          className="rounded-xl text-xs min-h-10 sm:min-h-9 w-full px-2"
          onClick={() => setTab('unread')}
        >
          غير مقروءة ({unreadCount})
        </Button>
        <Button
          variant={tab === 'read' ? 'default' : 'outline'}
          size="sm"
          className="rounded-xl text-xs min-h-10 sm:min-h-9 w-full px-2"
          onClick={() => setTab('read')}
        >
          مقروءة ({readCount})
        </Button>
      </div>

      {/* شاشة فارغة */}
      {!loading && displayedItems.length === 0 && (
        <div className="flex flex-col items-center justify-center text-center py-10 px-4 rounded-2xl border border-dashed border-border/70 bg-muted/20">
          <Bell className="w-12 h-12 text-muted-foreground/50 mb-3" />
          <p className="text-sm sm:text-base font-semibold text-foreground">
            {tab === 'unread'
              ? 'لا توجد إشعارات غير مقروءة'
              : tab === 'read'
              ? 'لا توجد إشعارات مقروءة محفوظة'
              : 'لا توجد إشعارات حالياً'}
          </p>
        </div>
      )}

      {/* قائمة الإشعارات الموحدة */}
      <div className="space-y-2.5 w-full">
        {displayedItems.map((item) => {
          const Icon = getItemIcon(item);
          const isUpdate = item.kind === 'update';
          const link = item.link_url || (isUpdate ? updateUrl : '');

          return (
            <div
              key={item.id}
              className={`rounded-2xl border p-4 transition-colors ${
                item.kind === 'warning' || item.kind === 'inventory' || item.kind.includes('stock')
                  ? 'border-warning/40 bg-warning/10'
                  : isUpdate
                  ? 'border-primary/40 bg-primary/5'
                  : item.isRead
                  ? 'border-border/60 bg-card/60 opacity-80'
                  : 'border-border bg-card shadow-xs'
              }`}
            >
              <button type="button" onClick={() => markItemRead(item)}
                className="flex w-full items-start gap-3 rounded-xl text-start"
                aria-label={item.isRead ? item.title : `تحديد كمقروء: ${item.title}`}>
                <span
                  className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 mt-0.5 ${
                    item.kind === 'warning' || item.kind === 'inventory' || item.kind.includes('stock')
                      ? 'bg-warning/15 text-warning'
                      : isUpdate
                      ? 'bg-primary/15 text-primary'
                      : 'bg-muted text-muted-foreground'
                  }`}
                >
                  <Icon className="w-5 h-5" />
                </span>

                <span className="flex-1 min-w-0 space-y-1.5">
                  <span className="flex items-start justify-between gap-2">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-bold text-foreground break-words">{item.title}</span>
                      <Badge variant="outline">
                        {getItemBadge(item)}
                      </Badge>
                    </span>
                    {!item.isRead && (
                      <Badge variant="destructive" className="shrink-0 tabular-nums" aria-label="غير مقروء">
                        1
                      </Badge>
                    )}
                  </span>

                  {item.body && (
                    <span className="block text-xs text-muted-foreground break-words whitespace-pre-wrap leading-relaxed select-text">
                      {stripImageTags(item.body)}
                    </span>
                  )}

                  <span className="block text-xs text-muted-foreground font-mono tabular-nums" dir="ltr">
                    {new Date(item.created_at).toLocaleString('en-GB')}
                  </span>

                </span>
              </button>

              <div className="flex flex-wrap gap-2 pt-2 ps-12">
                  {link && (
                    <Button
                      size="sm"
                      className="gap-1.5 text-xs font-bold"
                      onClick={() => {
                        markItemRead(item);
                        openExternal(link);
                      }}
                    >
                      <Download className="w-4 h-4" />
                      {isUpdate ? 'تحميل التحديث وتثبيته' : 'فتح الرابط'}
                    </Button>
                  )}

                  {item.actionUrl && (
                    <Button
                      size="sm"
                      variant="secondary"
                      className="gap-1.5 text-xs font-semibold"
                      onClick={() => { markItemRead(item); navigate(item.actionUrl!); }}
                    >
                      <ArrowRight className="w-4 h-4 rtl:rotate-180" />
                      عرض التفاصيل
                    </Button>
                  )}

                  <Button
                    size="sm"
                    variant="ghost"
                    className="gap-1.5 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
                    onClick={() => handleDeleteOrArchive(item)}
                    title="حذف أو أرشفة"
                  >
                    <Trash2 className="w-4 h-4" />
                    حذف
                  </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
