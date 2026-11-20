import { useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { LocalNotifications } from '@capacitor/local-notifications';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import {
  sendLocalNotification,
  checkNotificationPermissionNative,
  requestNotificationPermissionNative,
} from '@/lib/native-notifications';

export function useNativeChatAlerts() {
  const { user } = useAuth();
  const navigate = useNavigate();

  // 1. لا يُطلب إذن الإشعارات تلقائياً عند الإقلاع:
  //    نافذة NotificationPermissionPrompt تشرح الفائدة وتنقل المستخدم لتفعيلها من الإعدادات

  // 2. فحص الرسائل غير المقروءة عند إيقاظ التطبيق من الخلفية (App Lifecycle / Doze Mode)
  const checkUnreadMessagesAndAlert = useCallback(async () => {
    if (!user?.id) return;
    try {
      // لا ننبّه إلا عن الرسائل الحديثة: الرسائل الأقدم من 24 ساعة تبقى في المحادثة والشارة فقط
      const recentCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      // العميل العادي: جلب محادثاته ثم فحص الردود غير المشعرة
      const { data: convData } = await supabase
        .from('support_conversations')
        .select('id')
        .eq('user_id', user.id);

      if (convData && convData.length > 0) {
        const convIds = convData.map((c) => c.id);
        const { data: unnotifiedReplies, error } = await supabase
          .from('support_messages')
          .select('id, conversation_id, sender_id, sender_role, message, created_at')
          .in('conversation_id', convIds)
          .in('sender_role', ['boss', 'admin'])
          .eq('notified_native', false)
          .gte('created_at', recentCutoff)
          .order('created_at', { ascending: false })
          .limit(5);

        if (!error && unnotifiedReplies && unnotifiedReplies.length > 0) {
          for (const msg of unnotifiedReplies) {
            await sendLocalNotification(
              '💬 رد من الدعم الفني (PosFlow)',
              msg.message ? msg.message.substring(0, 120) : 'تم إرسال إشعار تفعيل أو تحديث لحسابك',
              'critical',
              { action: 'open_support_chat', conversationId: msg.conversation_id }
            );
          }
          const ids = unnotifiedReplies.map((m) => m.id);
          await supabase
            .from('support_messages')
            .update({ notified_native: true })
            .in('id', ids);
        }
      }
    } catch (err) {
      console.debug('[ChatAlerts] Doze check skipped:', err);
    }
  }, [user?.id]);

  // 3. الاستماع لدورة حياة التطبيق (Capacitor App State + Window Focus)
  useEffect(() => {
    checkUnreadMessagesAndAlert();

    let appListenerHandle: any = null;
    if (Capacitor.isNativePlatform()) {
      CapApp.addListener('appStateChange', ({ isActive }) => {
        if (isActive) {
          checkUnreadMessagesAndAlert();
        }
      }).then((h) => {
        appListenerHandle = h;
      }).catch(() => {});
    }

    const handleFocus = () => {
      checkUnreadMessagesAndAlert();
    };
    window.addEventListener('focus', handleFocus);

    return () => {
      if (appListenerHandle) {
        appListenerHandle.remove();
      }
      window.removeEventListener('focus', handleFocus);
    };
  }, [checkUnreadMessagesAndAlert]);

  // 4. الاستماع لحدث النقر على الإشعار المنسدل في أندرويد لفتح المحادثة مباشرة (Deep-Linking)
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;

    let notifListenerHandle: any = null;
    LocalNotifications.addListener('localNotificationActionPerformed', (notification) => {
      const extra = notification.notification.extra;
      if (extra?.action === 'open_support_chat') {
        window.dispatchEvent(new CustomEvent('posflow:open-support-chat', { detail: extra }));
        navigate('/contact', { state: { openChat: true, conversationId: extra.conversationId } });
      }
    }).then((h) => {
      notifListenerHandle = h;
    }).catch(() => {});

    return () => {
      if (notifListenerHandle) {
        notifListenerHandle.remove();
      }
    };
  }, [navigate]);

  // 5. الاشتراك اللحظي Realtime عند وصول أي رسالة جديدة عبر WebSocket
  useEffect(() => {
    if (!user?.id) return;

    const channel = supabase
      .channel('native_support_alerts')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'support_messages',
        },
        async (payload) => {
          const newMsg = payload.new as any;
          if (!newMsg) return;

          // تجاهل الرسائل التي أرسلتها أنا بنفسي
          if (newMsg.sender_id === user.id) return;

          // الرسالة من الدعم الفني
          if (newMsg.sender_role === 'boss' || newMsg.sender_role === 'admin') {
            await sendLocalNotification(
              '💬 رد من الدعم الفني (PosFlow)',
              newMsg.message ? newMsg.message.substring(0, 120) : 'تم إرسال إشعار تفعيل أو تحديث لحسابك',
              'critical',
              { action: 'open_support_chat', conversationId: newMsg.conversation_id }
            );
            // تمييز الرسالة كمشعرة
            supabase
              .from('support_messages')
              .update({ notified_native: true })
              .eq('id', newMsg.id)
              .then(() => {});
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user?.id]);
}
