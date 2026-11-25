import React, { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogBody } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/integrations/supabase/client';
import { toast as showToast } from '@/lib/sonner-bridge';
import { useLanguage } from '@/hooks/language-context';
import { KeyRound, Send, ShieldAlert, CheckCircle2, Loader2 } from 'lucide-react';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  phone: string;
  status: 'available' | 'requires_telegram_verification';
  onSuccess: () => void;
}

export const StorePhoneVerificationDialog: React.FC<Props> = ({
  open,
  onOpenChange,
  phone,
  status,
  onSuccess,
}) => {
  const { t, direction } = useLanguage();
  const [password, setPassword] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [requestId, setRequestId] = useState<string | null>(null);
  const [isSendingOtp, setIsSendingOtp] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [otpSent, setOtpSent] = useState(false);

  // 1. تأكيد بالرقم المتاح عبر كلمة مرور الحساب
  const handleVerifyPassword = async () => {
    if (!password.trim()) {
      showToast.error(t('phoneVerify.enterPasswordPrompt'));
      return;
    }

    setIsSubmitting(true);
    try {
      const { data: userData } = await supabase.auth.getUser();
      const userEmail = userData?.user?.email;
      if (!userEmail) throw new Error(t('phoneVerify.emailNotFound'));

      // التحقق من صحة كلمة المرور عبر إعادة تسجيل الدخول
      const { error: authErr } = await supabase.auth.signInWithPassword({
        email: userEmail,
        password,
      });

      if (authErr) {
        showToast.error(t('phoneVerify.wrongPassword'));
        setIsSubmitting(false);
        return;
      }

      // ربط الرقم بالحساب والمتجر
      const { data: rpcRes, error: rpcErr } = await (supabase as unknown as { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: { ok?: boolean; error?: string } | null; error: { message?: string } | null }> }).rpc('assign_store_and_profile_phone', {
        _phone: phone,
      });

      if (rpcErr || !rpcRes?.ok) {
        throw new Error(rpcErr?.message || rpcRes?.error || t('phoneVerify.saveFailed'));
      }

      showToast.success(t('phoneVerify.linkSuccess'));
      onSuccess();
      onOpenChange(false);
    } catch (err: unknown) {
      console.error('Password verify error:', err);
      const msg = typeof err === 'object' && err !== null && 'message' in err && typeof (err as { message?: unknown }).message === 'string' ? (err as { message: string }).message : '';
      showToast.error(msg || t('phoneVerify.verifyError'));
    } finally {
      setIsSubmitting(false);
    }
  };

  // 2. طلب كود تيليجرام إذا كان الرقم لحساب آخر
  const handleRequestTelegramOtp = async () => {
    setIsSendingOtp(true);
    try {
      const { data, error } = await supabase.functions.invoke('telegram-auth', {
        body: {
          action: 'request_phone_transfer_otp',
          phone,
        },
      });

      if (error || data?.error) {
        throw new Error(data?.error || error?.message || t('phoneVerify.otpSendFailed'));
      }

      setRequestId(data.request_id);
      setOtpSent(true);
      showToast.success(t('phoneVerify.otpSentSuccess'));
    } catch (err: unknown) {
      console.error('Send transfer OTP error:', err);
      const msg = typeof err === 'object' && err !== null && 'message' in err && typeof (err as { message?: unknown }).message === 'string' ? (err as { message: string }).message : '';
      showToast.error(msg || t('phoneVerify.otpSendError'));
    } finally {
      setIsSendingOtp(false);
    }
  };

  // 3. تأكيد كود تيليجرام ونقل الرقم
  const handleVerifyOtpAndTransfer = async () => {
    if (!requestId || otpCode.trim().length !== 6) {
      showToast.error(t('phoneVerify.otpInvalidLength'));
      return;
    }

    setIsSubmitting(true);
    try {
      const { data: transferRes, error: transferErr } = await (supabase as unknown as { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: { ok?: boolean; error?: string } | null; error: { message?: string } | null }> }).rpc('complete_phone_transfer', {
        _request_id: requestId,
        _entered_code: otpCode.trim(),
      });

      if (transferErr || !transferRes?.ok) {
        throw new Error(transferErr?.message || transferRes?.error || t('phoneVerify.otpInvalid'));
      }

      showToast.success(t('phoneVerify.transferSuccess'));
      onSuccess();
      onOpenChange(false);
    } catch (err: unknown) {
      console.error('Transfer verify error:', err);
      const msg = typeof err === 'object' && err !== null && 'message' in err && typeof (err as { message?: unknown }).message === 'string' ? (err as { message: string }).message : '';
      showToast.error(msg || t('phoneVerify.transferFailed'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(calc(100vw-1.5rem),28rem)] max-h-[calc(100dvh-1.5rem)] flex flex-col p-0 overflow-hidden rounded-[24px]" dir={direction}>
        <DialogHeader className="shrink-0 px-4 pt-4 pb-3 sm:px-6 sm:pt-5 border-b border-border/60 text-start pe-12">
          <DialogTitle className="flex items-center gap-2">
            {status === 'available' ? (
              <>
                <KeyRound className="w-5 h-5 text-primary shrink-0" />
                {t('phoneVerify.titleConfirm')}
              </>
            ) : (
              <>
                <ShieldAlert className="w-5 h-5 text-warning shrink-0" />
                {t('phoneVerify.titleTransfer')}
              </>
            )}
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground pt-1">
            {t('phoneVerify.storePhoneLabel')} <span className="inline-block tabular-nums font-mono font-bold text-foreground" dir="ltr">{phone}</span>
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          {status === 'available' ? (
            <div className="space-y-1.5">
              <Label className="text-sm font-medium">{t('phoneVerify.enterPasswordLabel')}</Label>
              <Input
                type="password"
                placeholder={t('phoneVerify.passwordPlaceholder')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                dir="ltr"
                autoFocus
              />
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground leading-relaxed">
                {t('phoneVerify.transferDesc')}
              </p>

              {!otpSent ? (
                <Button
                  type="button"
                  onClick={handleRequestTelegramOtp}
                  disabled={isSendingOtp}
                  className="w-full gap-2"
                >
                  {isSendingOtp ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  {t('phoneVerify.sendOtpBtn')}
                </Button>
              ) : (
                <div className="space-y-1.5 pt-1">
                  <Label className="text-xs font-medium">{t('phoneVerify.enterOtpLabel')}</Label>
                  <Input
                    type="text"
                    maxLength={6}
                    placeholder="123456"
                    className="text-center font-mono text-lg tracking-widest tabular-nums"
                    dir="ltr"
                    value={otpCode}
                    onChange={(e) => setOtpCode(e.target.value)}
                    autoFocus
                  />
                </div>
              )}
            </div>
          )}
        </DialogBody>

        <DialogFooter className="shrink-0 px-4 py-3 sm:px-6 border-t border-border/60">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            {t('password.cancel')}
          </Button>
          {status === 'available' ? (
            <Button onClick={handleVerifyPassword} disabled={isSubmitting} className="gap-2">
              {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              {t('phoneVerify.confirmSaveBtn')}
            </Button>
          ) : otpSent ? (
            <Button onClick={handleVerifyOtpAndTransfer} disabled={isSubmitting} className="gap-2">
              {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              {t('phoneVerify.verifyTransferBtn')}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
