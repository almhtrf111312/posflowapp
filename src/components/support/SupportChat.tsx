/**
 * SupportChat — In-App Live Support Chat
 * =======================================
 * - FAB (Floating Action Button) ثابت في أسفل الشاشة
 * - نافذة دردشة منبثقة مع Realtime عبر Supabase
 * - دعم كامل للغة العربية (RTL)
 */

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  type KeyboardEvent,
} from 'react';
import {
  MessageCircle,
  X,
  Send,
  Loader2,
  ChevronDown,
  Headphones,
  Users,
  ArrowRight,
  Paperclip,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { compressImage } from '@/lib/image-upload';
import { useAuth } from '@/hooks/use-auth';
import { useLanguage } from '@/hooks/use-language';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { formatTime, parseMessageContent } from '@/components/support/support-helpers';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SupportMessage {
  id: string;
  conversation_id: string;
  sender_id: string;
  sender_role: string; // 'user' | 'boss' | 'admin'
  message: string;
  is_read: boolean;
  created_at: string;
}

export interface SupportConversation {
  id: string;
  user_id: string;
  user_name: string | null;
  user_email: string | null;
  user_phone: string | null;
  store_name: string | null;
  status: string;
  last_message_at: string | null;
}

// ─── Helper ──────────────────────────────────────────────────────────────────

// ─── Chat Messages Panel ──────────────────────────────────────────────────────

export function ChatMessages({
  conversationId,
  currentUserId,
}: {
  conversationId: string;
  currentUserId: string;
}) {
  const { language } = useLanguage();
  const isEn = language === 'en';
  const [messages, setMessages] = useState<SupportMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Initial load
  useEffect(() => {
    if (!conversationId) return;
    setLoading(true);
    supabase
      .from('support_messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(200)
      .then(({ data }) => {
        const latestChronological = ((data as SupportMessage[]) || []).slice().reverse();
        setMessages(latestChronological);
        setLoading(false);
      });
  }, [conversationId]);

  // Realtime subscription
  useEffect(() => {
    if (!conversationId) return;

    const channel = supabase
      .channel(`chat-${conversationId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'support_messages',
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const newMsg = payload.new as SupportMessage;
          setMessages((prev) => {
            // prevent duplicates
            if (prev.some((m) => m.id === newMsg.id)) return prev;
            return [...prev, newMsg];
          });
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [conversationId]);

  // Auto-scroll to bottom
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-primary" />
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground text-xs gap-2 p-6 text-center">
        <MessageCircle className="h-10 w-10 opacity-20 text-primary" />
        <p>{isEn ? "Start your conversation with Technical Support" : "ابدأ محادثتك مع فريق الدعم الفني"}</p>
        <p className="opacity-60">{isEn ? "We will reply as soon as possible" : "سنرد عليك في أقرب وقت ممكن"}</p>
      </div>
    );
  }

  return (
    <>
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2.5">
        {messages.map((msg) => {
          const isMe = msg.sender_id === currentUserId;
          const isSupport = msg.sender_role === 'boss' || msg.sender_role === 'admin';
          const { imageUrl, textContent } = parseMessageContent(msg.message);

          return (
            <div
              key={msg.id}
              className={cn(
                'flex gap-2 items-end',
                isMe ? 'flex-row-reverse' : 'flex-row',
              )}
            >
              {/* Avatar badge for support */}
              {!isMe && (
                <div className="w-6 h-6 rounded-full bg-primary/20 flex items-center justify-center shrink-0 mb-0.5">
                  <Headphones className="w-3.5 h-3.5 text-primary" />
                </div>
              )}

              <div
                className={cn(
                  'max-w-[78%] rounded-2xl px-3.5 py-2 text-xs leading-relaxed break-words',
                  isMe
                    ? 'bg-primary text-primary-foreground rounded-ee-sm shadow-sm'
                    : 'bg-muted text-foreground rounded-es-sm border border-border/50',
                )}
              >
                {/* Support label */}
                {isSupport && !isMe && (
                  <p className="text-[10px] font-bold text-primary mb-1">
                    {isEn ? "Technical Support Team" : "فريق الدعم الفني"}
                  </p>
                )}
                {imageUrl && imageUrl.startsWith('data:application/pdf') && (
                  <div className="mb-1.5 rounded-xl bg-black/10 px-3 py-2 text-xs font-bold">{isEn ? "📄 Attached PDF" : "📄 ملف PDF مرفق"}</div>
                )}
                {imageUrl && !imageUrl.startsWith('data:application/pdf') && (
                  <div className="mb-1.5 overflow-hidden rounded-xl cursor-pointer group">
                    <img
                      src={imageUrl}
                      alt={isEn ? "Attached image" : "صورة مرفقة"}
                      onClick={() => setLightboxImage(imageUrl)}
                      className="max-h-56 max-w-full rounded-xl object-contain bg-black/10 hover:opacity-90 transition-opacity"
                      loading="lazy"
                    />
                  </div>
                )}
                {textContent && <p className="whitespace-pre-wrap">{textContent}</p>}
                <p
                  className={cn(
                    'text-[10px] mt-1 select-none',
                    isMe ? 'text-primary-foreground/60 text-end' : 'text-muted-foreground',
                  )}
                >
                  {formatTime(msg.created_at)}
                </p>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* Lightbox Modal */}
      {lightboxImage && (
        <div
          className="fixed inset-0 z-[999] bg-black/90 flex items-center justify-center p-4 animate-in fade-in duration-200"
          onClick={() => setLightboxImage(null)}
        >
          <button
            type="button"
            onClick={() => setLightboxImage(null)}
            className="absolute top-4 end-4 p-2.5 rounded-full bg-white/20 text-white hover:bg-white/30 transition-colors z-10"
            title={isEn ? "Close" : "إغلاق"}
            aria-label={isEn ? "Close" : "إغلاق"}
          >
            <X className="w-6 h-6" />
          </button>
          <img
            src={lightboxImage}
            alt={isEn ? "Full-size image preview" : "عرض الصورة بالحجم الكامل"}
            className="max-w-[95vw] max-h-[90vh] object-contain rounded-xl shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}

// ─── Input Bar ────────────────────────────────────────────────────────────────

export function InputBar({
  conversationId,
  onConversationCreated,
}: {
  conversationId: string | null;
  onConversationCreated: (id: string) => void;
}) {
  const { language, direction } = useLanguage();
  const isEn = language === 'en';
  const [text, setText] = useState('');
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [compressing, setCompressing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setCompressing(true);
      const reader = new FileReader();
      reader.onload = async (ev) => {
        const rawBase64 = ev.target?.result as string;
        if (rawBase64) {
          // ضغط الصورة تلقائياً لتكون خفيفة وسريعة التحميل (≤60KB و 800x800)
          const compressed = await compressImage(rawBase64, 60, 800, 800);
          setSelectedImage(compressed);
        }
        setCompressing(false);
      };
      reader.onerror = () => setCompressing(false);
      reader.readAsDataURL(file);
    } catch (err) {
      console.error('[SupportChat] Image selection failed', err);
      setCompressing(false);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const send = useCallback(async () => {
    const trimmed = text.trim();
    if ((!trimmed && !selectedImage) || submitting || compressing) return;
    setSubmitting(true);

    let messageToSend = '';
    if (selectedImage && trimmed) {
      messageToSend = `[IMAGE]${selectedImage}[/IMAGE]\n${trimmed}`;
    } else if (selectedImage) {
      messageToSend = `[IMAGE]${selectedImage}[/IMAGE]`;
    } else {
      messageToSend = trimmed;
    }

    setText('');
    setSelectedImage(null);

    try {
      const { data, error } = await supabase.rpc('send_support_message', {
        _message: messageToSend,
        _conversation_id: conversationId || null,
      } as { _message: string; _conversation_id?: string });

      if (error) {
        console.error('[SupportChat] RPC error:', error);
      } else if (!conversationId && data) {
        // first message — newly created conversation id returned
        const newId = typeof data === 'string' ? data : (data as Record<string, string>)?.conversation_id;
        if (newId) onConversationCreated(newId);
      }
    } catch (err) {
      console.error('[SupportChat] send error:', err);
    } finally {
      setSubmitting(false);
    }
  }, [text, selectedImage, submitting, compressing, conversationId, onConversationCreated]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="border-t border-border bg-muted/20">
      {/* معاينة الصورة المرفقة قبل الإرسال */}
      {selectedImage && (
        <div className="p-2 pb-0 flex items-center gap-2">
          <div className="relative inline-block border border-border bg-card rounded-lg p-1 shadow-xs">
            <img
              src={selectedImage}
              alt={isEn ? "Image preview" : "معاينة الصورة"}
              className="w-14 h-14 object-cover rounded-md"
            />
            <button
              type="button"
              onClick={() => setSelectedImage(null)}
              className="absolute -top-1.5 -end-1.5 bg-destructive text-destructive-foreground rounded-full p-0.5 shadow-sm hover:opacity-90 transition-opacity"
              title={isEn ? "Remove image" : "إزالة الصورة"}
            >
              <X className="w-3 h-3" />
            </button>
          </div>
          <span className="text-[11px] text-muted-foreground font-medium">{isEn ? "Image ready to send" : "صورة جاهزة للإرسال"}</span>
        </div>
      )}

      <div className="p-2.5 flex items-center gap-1.5">
        <input
          type="file"
          ref={fileInputRef}
          accept="image/*"
          className="hidden"
          onChange={handleFileChange}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => fileInputRef.current?.click()}
          disabled={submitting || compressing}
          className="shrink-0 text-muted-foreground hover:text-foreground"
          title={isEn ? "Attach image" : "إرفاق صورة"}
          aria-label={isEn ? "Attach image" : "إرفاق صورة"}
        >
          {compressing ? (
            <Loader2 className="w-4 h-4 animate-spin text-primary" />
          ) : (
            <Paperclip className="w-4 h-4" />
          )}
        </Button>

        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={isEn ? "Type your message here..." : "اكتب رسالتك هنا..."}
          disabled={submitting || compressing}
          className="bg-card flex-1"
          dir={direction}
        />

        <Button
          onClick={send}
          disabled={submitting || compressing || (!text.trim() && !selectedImage)}
          size="icon"
          className="shrink-0"
          title={isEn ? "Send" : "إرسال"}
          aria-label={isEn ? "Send" : "إرسال"}
        >
          {submitting ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Send className="w-3.5 h-3.5" />
          )}
        </Button>
      </div>
    </div>
  );
}
