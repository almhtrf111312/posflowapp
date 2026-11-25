import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/auth-context';

/**
 * هوك تتبع عدد الرسائل غير المقروءة في الدعم الفني بالوقت الفعلي
 * يحسب ردود الدعم الفني الواردة غير المقروءة للمستخدم
 */
export function useSupportUnread(): number {
  const { user } = useAuth();
  const [unreadCount, setUnreadCount] = useState<number>(0);

  const fetchUnread = useCallback(async () => {
    if (!user?.id) {
      setUnreadCount(0);
      return;
    }

    try {
      // العميل العادي: جلب معرفات محادثاته ثم حساب الرسائل غير المقروءة من الدعم
      const { data: convData, error: convErr } = await supabase
        .from('support_conversations')
        .select('id')
        .eq('user_id', user.id);

      if (convErr || !convData || convData.length === 0) {
        setUnreadCount(0);
        return;
      }

      const convIds = convData.map((c) => c.id);
      const { count, error } = await supabase
        .from('support_messages')
        .select('id', { count: 'exact', head: true })
        .in('conversation_id', convIds)
        .in('sender_role', ['boss', 'admin'])
        .eq('is_read', false);

      if (!error && typeof count === 'number') {
        setUnreadCount(count);
      }
    } catch (err) {
      console.debug('[SupportUnread] Fetch error:', err);
    }
  }, [user?.id]);

  useEffect(() => {
    fetchUnread();

    // استخدام معرّف فريد للقناة لمنع تصادم الاشتراكات المتزامنة بين المكونات
    const channelId = `support_unread_${user?.id || 'guest'}_${Math.random().toString(36).slice(2, 8)}`;
    const channel = supabase
      .channel(channelId)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'support_messages',
        },
        () => {
          fetchUnread();
        }
      )
      .subscribe();

    // الاستماع لحدث فتح المحادثة محلياً لتصفير العداد فوراً
    const handleLocalRead = () => {
      fetchUnread();
    };
    window.addEventListener('posflow:support-read', handleLocalRead);

    return () => {
      supabase.removeChannel(channel);
      window.removeEventListener('posflow:support-read', handleLocalRead);
    };
  }, [fetchUnread, user?.id]);

  return unreadCount;
}
