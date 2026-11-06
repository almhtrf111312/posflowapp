import React, { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/integrations/supabase/client';
import { showToast } from '@/lib/toast-config';
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
  const [password, setPassword] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [requestId, setRequestId] = useState<string | null>(null);
  const [isSendingOtp, setIsSendingOtp] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [otpSent, setOtpSent] = useState(false);

  // 1. تأكيد بالرقم المتاح عبر كلمة مرور الحساب
  const handleVerifyPassword = async () => {
    if (!password.trim()) {
      showToast.error('يرجى إدخال كلمة مرور حسابك للمتابعة');
      return;
    }

    setIsSubmitting(true);
    try {
      const { data: userData } = await supabase.auth.getUser();
      const userEmail = userData?.user?.email;
      if (!userEmail) throw new Error('تعذر العثور على بريد الحساب الحالي');

      // التحقق من صحة كلمة المرور عبر إعادة تسجيل الدخول
      const { error: authErr } = await supabase.auth.signInWithPassword({
        email: userEmail,
        password,
      });

      if (authErr) {
        showToast.error('كلمة المرور غير صحيحة');
        setIsSubmitting(false);
        return;
      }

      // ربط الرقم بالحساب والمتجر
      const { data: rpcRes, error: rpcErr } = await (supabase.rpc as any)('assign_store_and_profile_phone', {
        _phone: phone,
      });

      if (rpcErr || !rpcRes?.ok) {
        throw new Error(rpcErr?.message || rpcRes?.error || 'فشل حفظ الرقم');
      }

      showToast.success('تم تأكيد وربط الرقم بحسابك ومتجرك بنجاح');
      onSuccess();
      onOpenChange(false);
    } catch (err: any) {
      console.error('Password verify error:', err);
      showToast.error(err.message || 'حدث خطأ أثناء التحقق');
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
        throw new Error(data?.error || error?.message || 'فشل إرسال رمز التيليجرام');
      }

      setRequestId(data.request_id);
      setOtpSent(true);
      showToast.success('تم إرسال رمز التأكيد إلى تيليجرام الحساب المالك لهذا الرقم');
    } catch (err: any) {
      console.error('Send transfer OTP error:', err);
      showToast.error(err.message || 'تعذر إرسال الرمز');
    } finally {
      setIsSendingOtp(false);
    }
  };

  // 3. تأكيد كود تيليجرام ونقل الرقم
  const handleVerifyOtpAndTransfer = async () => {
    if (!requestId || otpCode.trim().length !== 6) {
      showToast.error('يرجى إدخال رمز التحقق المكون من 6 أرقام');
      return;
    }

    setIsSubmitting(true);
    try {
      const { data: transferRes, error: transferErr } = await (supabase.rpc as any)('complete_phone_transfer', {
        _request_id: requestId,
        _entered_code: otpCode.trim(),
      });

      if (transferErr || !transferRes?.ok) {
        throw new Error(transferErr?.message || transferRes?.error || 'رمز التحقق غير صحيح');
      }

      showToast.success('تم نقل ملكية الرقم وربطه بمتجرك وحسابك بنجاح');
      onSuccess();
      onOpenChange(false);
    } catch (err: any) {
      console.error('Transfer verify error:', err);
      showToast.error(err.message || 'فشل نقل الرقم');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px] rtl" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base font-semibold">
            {status === 'available' ? (
              <>
                <KeyRound className="w-5 h-5 text-primary" />
                تأكيد ملكية رقم الهاتف
              </>
            ) : (
              <>
                <ShieldAlert className="w-5 h-5 text-amber-500" />
                نقل رقم الهاتف من حساب آخر
              </>
            )}
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground pt-1">
            الرقم المراد اعتماده للمتجر: <span className="font-mono font-bold text-foreground">{phone}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="py-3 space-y-4">
          {status === 'available' ? (
            <div className="space-y-2">
              <Label className="text-sm font-medium">أدخل كلمة مرور حسابك لتأكيد ربط هذا الرقم بحسابك ومتجرك:</Label>
              <Input
                type="password"
                placeholder="كلمة المرور..."
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
              />
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground leading-relaxed">
                هذا الرقم مسجل مسبقاً بحساب مستخدم آخر. لحماية الأمان، يلزم تأكيد نقل الملكية عبر رمز يصل إلى بوت Telegram للحساب الأصلي.
              </p>

              {!otpSent ? (
                <Button
                  type="button"
                  onClick={handleRequestTelegramOtp}
                  disabled={isSendingOtp}
                  className="w-full gap-2"
                >
                  {isSendingOtp ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  إرسال رمز التأكيد إلى Telegram
                </Button>
              ) : (
                <div className="space-y-2 pt-1">
                  <Label className="text-xs font-medium">أدخل رمز التحقق (6 أرقام) الوارد إلى Telegram:</Label>
                  <Input
                    type="text"
                    maxLength={6}
                    placeholder="123456"
                    className="text-center font-mono text-lg tracking-widest"
                    value={otpCode}
                    onChange={(e) => setOtpCode(e.target.value)}
                    autoFocus
                  />
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="flex gap-2 sm:justify-start">
          {status === 'available' ? (
            <Button onClick={handleVerifyPassword} disabled={isSubmitting} className="gap-2">
              {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              تأكيد وحفظ
            </Button>
          ) : otpSent ? (
            <Button onClick={handleVerifyOtpAndTransfer} disabled={isSubmitting} className="gap-2">
              {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              تحقق ونقل الرقم
            </Button>
          ) : null}
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            إلغاء
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
