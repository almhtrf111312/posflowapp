/**
 * تنبيه ربط تيليجرام بعد إنشاء حساب جديد (بريد أو جوجل): يظهر مرة في بداية الإعداد.
 * الربط اختياري؛ التخطي مسموح لكن مع توضيح أن استعادة الحساب لن تكون فورية.
 */
import { useCallback, useEffect, useState } from 'react';
import { Loader2, Send, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogBody } from '@/components/ui/dialog';
import { useAuth } from '@/hooks/use-auth';
import { useLanguage } from '@/hooks/use-language';
import { fetchTelegramLinked, getTelegramBotLink } from '@/lib/auth/phone-claim';

const DISMISS_KEY = 'posflow_telegram_prompt_dismissed';

export function TelegramLinkPrompt() {
  const { user } = useAuth();
  const { t, direction } = useLanguage();
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [stillUnlinked, setStillUnlinked] = useState(false);

  const phoneReady = !!String((user?.user_metadata as { phone?: string } | undefined)?.phone || '').trim();

  useEffect(() => {
    if (!user || !phoneReady) return;
    let justSignedUp = false;
    let dismissed = false;
    try {
      justSignedUp = sessionStorage.getItem('posflow_just_signed_up') === 'true';
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
      <DialogContent className="w-[min(calc(100vw-1.5rem),28rem)] max-h-[calc(100dvh-1.5rem)] flex flex-col p-0 overflow-hidden rounded-[24px] z-[10000]" dir={direction}>
        <DialogHeader className="shrink-0 px-4 pt-4 pb-3 sm:px-6 sm:pt-5 border-b border-border/60 text-start pe-12">
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="w-5 h-5 text-warning shrink-0" />
            {t('telegram.promptTitle')}
          </DialogTitle>
          <DialogDescription className="leading-relaxed text-start">
            {t('telegram.promptDesc')}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <p className="text-xs text-muted-foreground leading-relaxed">
            {t('telegram.promptSteps')}
          </p>
          {stillUnlinked && <p className="text-xs text-warning font-bold">{t('telegram.stillUnlinked')}</p>}
        </DialogBody>
        <DialogFooter className="shrink-0 px-4 py-3 sm:px-6 border-t border-border/60 flex-col-reverse sm:flex-col-reverse gap-2">
          <Button type="button" variant="ghost" onClick={dismiss} className="w-full text-muted-foreground">
            {t('telegram.laterNoTelegram')}
          </Button>
          <Button type="button" variant="outline" onClick={recheck} disabled={checking} className="w-full">
            {checking ? <Loader2 className="w-4 h-4 animate-spin" /> : t('telegram.checkLink')}
          </Button>
          <Button type="button" onClick={openBot} className="w-full gap-1.5">
            <Send className="w-4 h-4" />
            {t('telegram.openBot')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default TelegramLinkPrompt;
