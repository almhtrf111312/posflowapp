import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useUserRole } from '@/hooks/use-user-role';

/**
 * هوك تتبع عدد الرسائل غير المقروءة في الدعم الفني بالوقت الفعلي
 * - للمدير العام: يحسب استفسارات العملاء الواردة غير المقروءة
 * - للمستخدم العادي: يحسب ردود الدعم الفني الواردة غير المقروءة
 */
export function useSupportUnread(): number {
  const { user } = useAuth();
  const { isBoss } = useUserRole();
  const [unreadCount, setUnreadCount] = useState<number>(0);

  const fetchUnread = useCallback(async () => {
    if (!user?.id) {
      setUnreadCount(0);
      return;
    }

    try {
      if (isBoss) {
        // المدير العام: حساب الرسائل غير المقروءة من المستخدمين
        const { count, error } = await supabase
          .from('support_messages')
          .select('id', { count: 'exact', head: true })
          .eq('is_read', false)
          .eq('sender_role', 'user');

        if (!error && typeof count === 'number') {
          setUnreadCount(count);
        }
      } else {
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
      }
    } catch (err) {
      console.debug('[SupportUnread] Fetch error:', err);
    }
  }, [user?.id, isBoss]);

  useEffect(() => {
    fetchUnread();

    // استماع لحظي لتحديثات جدول الرسائل (إضافة رسائل جديدة أو تعديل حالة القراءة)
    const channel = supabase
      .channel('support_unread_badge_listener')
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
    window.addEventListener('flowpos:support-read', handleLocalRead);

    return () => {
      supabase.removeChannel(channel);
      window.removeEventListener('flowpos:support-read', handleLocalRead);
    };
  }, [fetchUnread]);

  return unreadCount;
}
