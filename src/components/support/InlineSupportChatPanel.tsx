import { useState, useEffect } from 'react';
import { Headphones, X } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useLanguage } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ChatMessages, InputBar } from './SupportChat';

export function InlineSupportChatPanel({ onClose }: { onClose: () => void }) {
  const { user } = useAuth();
  const { language, direction } = useLanguage();
  const isEn = language === 'en';
  const [conversationId, setConversationId] = useState<string | null>(null);

  // Load existing user conversation
  useEffect(() => {
    if (!user) return;
    supabase
      .from('support_conversations')
      .select('id')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => {
        if (data?.id) setConversationId(data.id);
      });
  }, [user]);

  // Mark as read when opened inline
  useEffect(() => {
    if (conversationId && user) {
      supabase
        .from('support_messages')
        .update({ is_read: true })
        .eq('conversation_id', conversationId)
        .neq('sender_id', user.id)
        .then(() => {
          window.dispatchEvent(new CustomEvent('posflow:support-read'));
        });
    }
  }, [conversationId, user]);

  if (!user) return null;

  return (
    <div
      className={cn(
        'w-full min-w-0 max-w-none rounded-2xl shadow-sm border border-border bg-card flex flex-col',
        'animate-in zoom-in-95 fade-in duration-200',
        'h-[35.7rem] overflow-hidden'
      )}
      dir={direction}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-primary/5 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <div className="size-8 rounded-xl bg-primary/20 flex items-center justify-center">
            <Headphones className="w-4 h-4 text-primary" />
          </div>
          <div>
            <p className="text-sm font-bold text-foreground leading-none">{isEn ? "Technical Support" : "الدعم الفني"}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{isEn ? "We will reply as soon as possible" : "سنرد عليك في أقرب وقت"}</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground hover:bg-destructive/10"
            onClick={onClose}
            title={isEn ? "Close Chat" : "إغلاق المحادثة"}
            aria-label={isEn ? "Close Chat" : "إغلاق المحادثة"}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Body */}
      {conversationId ? (
        <>
          <ChatMessages conversationId={conversationId} currentUserId={user.id} />
          <InputBar conversationId={conversationId} onConversationCreated={setConversationId} />
        </>
      ) : (
        <>
          <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground text-sm gap-2 p-6 text-center">
            <Headphones className="h-12 w-12 opacity-20 text-primary mb-2" />
            <p className="font-bold text-foreground text-base">{isEn ? "Welcome to Technical Support" : "مرحباً بك في الدعم الفني"}</p>
            <p className="opacity-70 max-w-sm">{isEn ? "Send your first message and the developer will reply as soon as possible" : "أرسل رسالتك الأولى وسيرد عليك المطور في أقرب وقت ممكن"}</p>
          </div>
          <InputBar conversationId={null} onConversationCreated={setConversationId} />
        </>
      )}
    </div>
  );
}
