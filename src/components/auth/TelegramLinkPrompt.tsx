/**
 * تنبيه ربط تيليجرام بعد إنشاء حساب جديد (بريد أو جوجل): يظهر مرة في بداية الإعداد.
 * الربط اختياري؛ التخطي مسموح لكن مع توضيح أن استعادة الحساب لن تكون فورية.
 */
import { useCallback, useEffect, useState } from 'react';
import { Loader2, Send, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useAuth } from '@/hooks/use-auth';
import { fetchTelegramLinked, getTelegramBotLink } from '@/lib/auth/phone-claim';

const DISMISS_KEY = 'hyperpos_telegram_prompt_dismissed';

export function TelegramLinkPrompt() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [stillUnlinked, setStillUnlinked] = useState(false);

  const phoneReady = !!String((user?.user_metadata as { phone?: string } | undefined)?.phone || '').trim();

  useEffect(() => {
    if (!user || !phoneReady) return;
    let justSignedUp = false;
    let dismissed = false;
    try {
      justSignedUp = sessionStorage.getItem('hyperpos_just_signed_up') === 'true';
      dismissed = sessionStorage.getItem(`${DISMISS_KEY}:${user.id}`) === '1';
    } catch { /* ignore */ }
    if (!justSignedUp || dismissed) return;
    let cancelled = false;
    void fetchTelegramLinked(user.id).then((linked) => {
      if (!cancelled && linked === false) setOpen(true);
    });
    return () => { cancelled = true; };
  }, [user, phoneReady]);

  const dismiss = useCallback(() => {
    try { if (user) sessionStorage.setItem(`${DISMISS_KEY}:${user.id}`, '1'); } catch { /* ignore */ }
    setOpen(false);
  }, [user]);

  const openBot = async () => {
    window.open(await getTelegramBotLink(), '_blank', 'noopener,noreferrer');
  };

  const recheck = async () => {
    if (!user) return;
    setChecking(true);
    const linked = await fetchTelegramLinked(user.id);
    setChecking(false);
    if (linked) dismiss();
    else setStillUnlinked(true);
  };

  if (!user) return null;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) dismiss(); }}>
      <DialogContent className="max-w-sm z-[10000]" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="w-5 h-5 text-amber-600" />
            اربط حسابك بتيليجرام
          </DialogTitle>
          <DialogDescription className="leading-relaxed text-start">
            عبر تيليجرام تستعيد حسابك في لحظات إن نسيت كلمة المرور. بدونه لا يمكن الاستعادة الفورية، وقد تستغرق من 24 إلى 48 ساعة.
          </DialogDescription>
        </DialogHeader>
        <p className="text-xs text-muted-foreground leading-relaxed">
          افتح البوت واضغط «مشاركة رقم الهاتف للتحقق» بنفس الرقم الذي سجّلته، فيتأكد البوت من ارتباطه بحسابك تلقائياً.
        </p>
        {stillUnlinked && <p className="text-xs text-amber-600 font-bold">لم يتم الربط بعد. أكمل الخطوات في البوت ثم اضغط «تحقّق».</p>}
        <DialogFooter className="gap-2 sm:gap-2 flex-col sm:flex-col">
          <Button type="button" onClick={openBot} className="w-full gap-1.5">
            <Send className="w-4 h-4" />
            فتح بوت تيليجرام
          </Button>
          <Button type="button" variant="outline" onClick={recheck} disabled={checking} className="w-full">
            {checking ? <Loader2 className="w-4 h-4 animate-spin" /> : 'تحقّق من الربط'}
          </Button>
          <Button type="button" variant="ghost" onClick={dismiss} className="w-full text-muted-foreground">
            لاحقاً (ليس لدي تيليجرام الآن)
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default TelegramLinkPrompt;
