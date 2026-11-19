import { useCallback, useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bell,
  Download,
  Megaphone,
  Wrench,
  AlertTriangle,
  RefreshCw,
  Eye,
  EyeOff,
  CheckCheck,
  Archive,
  Clock,
  ShieldCheck,
  Trash2,
  ArrowLeft,
  Package,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useNotifications, type Notification } from '@/hooks/use-notifications';
import { useAuth } from '@/hooks/use-auth';
import { toast } from '@/lib/sonner-bridge';
import { Badge } from '@/components/ui/badge';
import {
  fetchActiveBroadcasts,
  getCachedReleaseConfig,
  getSeenBroadcasts,
  syncSeenBroadcastsWithCloud,
  markBroadcastSeenCloud,
  openExternal,
  SEEN_KEY,
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

export default function Notifications() {
  const navigate = useNavigate();
  const { user } = useAuth();
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
        } as any,
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

  // تبديل حالة القراءة لإعلان البث
  const toggleBroadcastRead = (id: string) => {
    setSeenIds((prev) => {
      let next: string[];
      if (prev.includes(id)) {
        next = prev.filter((x) => x !== id);
      } else {
        next = [...prev, id];
        markBroadcastSeenCloud(id, user?.id);
      }
      localStorage.setItem(SEEN_KEY, JSON.stringify(next.slice(-200)));
      window.dispatchEvent(new Event('hp-broadcasts-updated'));
      return next;
    });
  };

  // تبديل القراءة لعنصر موحد
  const toggleItemRead = (item: UnifiedItem) => {
    if (item.source === 'broadcast') {
      toggleBroadcastRead(item.id);
    } else {
      if (!item.isRead) {
        markUserNotificationAsRead(item.id);
      }
    }
  };

  // تحديد الكل كمقروء
  const markAllRead = () => {
    const allIds = filteredBroadcasts.map((b) => b.id);
    const set = new Set([...seenIds, ...allIds]);
    const next = Array.from(set).slice(-200);
    setSeenIds(next);
    localStorage.setItem(SEEN_KEY, JSON.stringify(next));
    allIds.forEach((id) => markBroadcastSeenCloud(id, user?.id));
    window.dispatchEvent(new Event('hp-broadcasts-updated'));

    markAllUserNotificationsAsRead();
    toast.success('تم تحديد جميع الإشعارات كمقروءة');
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
        } as any,
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
    <div className="p-4 max-w-2xl mx-auto space-y-4" dir="rtl">
      {/* الشريط العلوي */}
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold text-foreground flex items-center gap-2">
          <Bell className="w-5 h-5 text-primary" />
          الإشعارات والتنبيهات
          {unreadCount > 0 && (
            <Badge variant="destructive" className="rounded-full px-2 py-0.5 text-xs">
              {unreadCount} جديد
            </Badge>
          )}
        </h1>
        <div className="flex items-center gap-1.5">
          {unreadCount > 0 && (
            <Button variant="ghost" size="sm" onClick={markAllRead} className="text-xs h-8 gap-1">
              <CheckCheck className="w-3.5 h-3.5 text-primary" />
              تحديد الكل كمقروء
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={load} aria-label="تحديث" className="h-8 w-8 p-0">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {/* كبسولات التصفية (الكل / غير المقروءة / المقروءة) */}
      <div className="flex gap-2 border-b border-border/60 pb-2">
        <Button
          variant={tab === 'all' ? 'default' : 'outline'}
          size="sm"
          className="rounded-full text-xs h-7"
          onClick={() => setTab('all')}
        >
          الكل ({allItems.length})
        </Button>
        <Button
          variant={tab === 'unread' ? 'default' : 'outline'}
          size="sm"
          className="rounded-full text-xs h-7"
          onClick={() => setTab('unread')}
        >
          غير مقروءة ({unreadCount})
        </Button>
        <Button
          variant={tab === 'read' ? 'default' : 'outline'}
          size="sm"
          className="rounded-full text-xs h-7"
          onClick={() => setTab('read')}
        >
          مقروءة ({readCount})
        </Button>
      </div>

      {/* شاشة فارغة */}
      {!loading && displayedItems.length === 0 && (
        <div className="rounded-2xl border border-border bg-card p-10 text-center text-sm text-muted-foreground space-y-2">
          <Bell className="w-8 h-8 text-muted-foreground/40 mx-auto" />
          <p>
            {tab === 'unread'
              ? 'لا توجد إشعارات غير مقروءة'
              : tab === 'read'
              ? 'لا توجد إشعارات مقروءة محفوظة'
              : 'لا توجد إشعارات حالياً'}
          </p>
        </div>
      )}

      {/* قائمة الإشعارات الموحدة */}
      <div className="space-y-2.5">
        {displayedItems.map((item) => {
          const Icon = getItemIcon(item);
          const isUpdate = item.kind === 'update';
          const link = item.link_url || (isUpdate ? updateUrl : '');

          return (
            <div
              key={item.id}
              className={`rounded-2xl border p-4 flex gap-3.5 transition-all ${
                item.kind === 'warning' || item.kind === 'inventory' || item.kind.includes('stock')
                  ? 'border-amber-500/40 bg-amber-500/5'
                  : isUpdate
                  ? 'border-primary/40 bg-primary/5'
                  : item.isRead
                  ? 'border-border/60 bg-card/60 opacity-80'
                  : 'border-border bg-card shadow-xs'
              }`}
            >
              <div
                className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 mt-0.5 ${
                  item.kind === 'warning' || item.kind === 'inventory' || item.kind.includes('stock')
                    ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                    : isUpdate
                    ? 'bg-primary/15 text-primary'
                    : 'bg-muted text-muted-foreground'
                }`}
              >
                <Icon className="w-5 h-5" />
              </div>

              <div className="flex-1 min-w-0 space-y-1.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-bold text-foreground break-words">{item.title}</p>
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                      {getItemBadge(item)}
                    </Badge>
                  </div>
                  <Badge variant={item.isRead ? 'secondary' : 'default'} className="text-[10px] px-1.5 py-0 shrink-0">
                    {item.isRead ? 'مقروء' : 'جديد'}
                  </Badge>
                </div>

                {item.body && (
                  <p className="text-xs text-muted-foreground break-words whitespace-pre-wrap leading-relaxed select-text">
                    {item.body}
                  </p>
                )}

                <p className="text-[11px] text-muted-foreground/80 font-mono" dir="ltr">
                  {new Date(item.created_at).toLocaleString('en-GB')}
                </p>

                <div className="flex flex-wrap gap-2 pt-1">
                  {link && (
                    <Button
                      size="sm"
                      className="h-8 gap-1.5 text-xs font-bold"
                      onClick={() => {
                        if (!item.isRead) toggleItemRead(item);
                        openExternal(link);
                      }}
                    >
                      <Download className="w-3.5 h-3.5" />
                      {isUpdate ? 'تحميل التحديث وتثبيته' : 'فتح الرابط'}
                    </Button>
                  )}

                  {item.actionUrl && (
                    <Button
                      size="sm"
                      variant="secondary"
                      className="h-8 gap-1.5 text-xs font-semibold"
                      onClick={() => navigate(item.actionUrl!)}
                    >
                      <ArrowLeft className="w-3.5 h-3.5" />
                      عرض التفاصيل
                    </Button>
                  )}

                  {!item.isRead && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 gap-1.5 text-xs"
                      onClick={() => toggleItemRead(item)}
                    >
                      <Eye className="w-3.5 h-3.5" />
                      تحديد كمقروء
                    </Button>
                  )}

                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 gap-1.5 text-xs text-muted-foreground hover:text-destructive"
                    onClick={() => handleDeleteOrArchive(item)}
                    title="حذف أو أرشفة"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    حذف
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
