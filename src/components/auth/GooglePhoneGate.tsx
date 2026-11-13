/**
 * بوابة إكمال حساب جوجل الجديد (الاسم + الهاتف) — جزء من وحدة جوجل القابلة للإزالة.
 * تعمل على مستوى التطبيق كله، فلا تختفي عند انتقال التطبيق من شاشة الدخول، وتعود إذا أُعيد فتح التطبيق.
 */
import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from '@/lib/sonner-bridge';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import {
  GOOGLE_SIGN_IN_ENABLED,
  completeGoogleSignup,
  isGoogleOnlyUser,
  isValidSignupPhone,
  nativeGoogleSignOut,
} from '@/lib/auth/google-sign-in';

export function GooglePhoneGate() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [phone, setPhone] = useState('');
  const [fullName, setFullName] = useState('');
  const [saving, setSaving] = useState(false);

  const meta = (user?.user_metadata || {}) as { phone?: string; full_name?: string; name?: string };
  const needsPhone = GOOGLE_SIGN_IN_ENABLED && !!user && isGoogleOnlyUser(user) && !String(meta.phone || '').trim();

  useEffect(() => {
    if (needsPhone) setFullName((prev) => prev || String(meta.full_name || meta.name || ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsPhone]);

  if (!needsPhone || !user) return null;

  const cancel = async () => {
    if (saving) return;
    await supabase.auth.signOut();
    await nativeGoogleSignOut();
    navigate('/login', { replace: true });
  };

  const submit = async () => {
    if (saving) return;
    if (!fullName.trim()) {
      toast.error('أدخل الاسم الكامل');
      return;
    }
    if (!isValidSignupPhone(phone)) {
      toast.error('رقم الهاتف غير صالح', { description: 'أرقام فقط (من 9 إلى 15 رقماً) بدون مسافات أو رموز.' });
      return;
    }
    setSaving(true);
    try {
      const { error } = await completeGoogleSignup(user.id, phone, fullName);
      if (error) {
        toast.error('تعذّر حفظ البيانات', { description: error.message.slice(0, 200) });
        return;
      }
      try {
        sessionStorage.setItem('hyperpos_just_signed_up', 'true');
      } catch { /* ignore */ }
      // user_metadata.phone صار موجوداً → تُغلق البوابة تلقائياً
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={() => { /* لا يُغلق بالنقر خارجه؛ الإلغاء يخرج من الحساب */ }}>
      <DialogContent className="max-w-sm z-[10000]" dir="rtl" onInteractOutside={(e) => e.preventDefault()} onEscapeKeyDown={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>إكمال إنشاء الحساب</DialogTitle>
          <DialogDescription>أدخل اسمك ورقم هاتفك لإنشاء متجرك.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="gate-name">الاسم الكامل</Label>
            <Input id="gate-name" value={fullName} onChange={(e) => setFullName(e.target.value)} maxLength={100} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="gate-phone">رقم الهاتف</Label>
            <Input id="gate-phone" type="tel" inputMode="tel" dir="ltr" placeholder="+963..." value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={16} />
          </div>
        </div>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button type="button" onClick={submit} disabled={saving} className="flex-1">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'متابعة'}
          </Button>
          <Button type="button" variant="outline" onClick={() => void cancel()} disabled={saving} className="flex-1">
            إلغاء وتسجيل الخروج
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default GooglePhoneGate;
