import { useState, useEffect } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/hooks/use-auth';
import { useLanguage } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from '@/lib/sonner-bridge';
import { Loader2, Store, Eye, EyeOff, Smartphone, RefreshCw, AlertTriangle, Mail, Sparkles, Send, KeyRound, ShieldCheck, ShieldAlert, CheckCircle2, ArrowRight, Lock } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { LanguageQuickSelector } from '@/components/auth/LanguageQuickSelector';
import { getDeviceId, getCanonicalDeviceId } from '@/lib/device-fingerprint';
import { getDeviceKey } from '@/lib/secure-storage';
import { ContactLinksSection, CHANNELS, type ContactLinks } from '@/components/settings/ContactLinksSection';
import { getAuthErrorMessage, isValidEmailFormat } from '@/lib/auth-errors';
import { injectGuestDemoData, clearGuestDemoData } from '@/lib/demo-data';
import { cn } from '@/lib/utils';

interface PasswordCriteria {
  hasUpper: boolean;
  hasLower: boolean;
  hasNumber: boolean;
  hasSpecial: boolean;
  hasMinLength: boolean;
}

const checkPasswordStrength = (pwd: string): PasswordCriteria => ({
  hasUpper: /[A-Z]/.test(pwd),
  hasLower: /[a-z]/.test(pwd),
  hasNumber: /[0-9]/.test(pwd),
  hasSpecial: /[^A-Za-z0-9]/.test(pwd),
  hasMinLength: pwd.length >= 8,
});

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [stayLoggedIn, setStayLoggedIn] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  // 1. تعريف حالة الحظر مع قراءة القيمة الأولية من sessionStorage فوراً لمنع وميض الاختفاء
  const [blockedState, setBlockedState] = useState<{
    isBlocked: boolean;
    userEmail?: string;
  } | null>(() => {
    try {
      const saved = sessionStorage.getItem('hyperpos_active_device_block');
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });
  const [isResettingDevice, setIsResettingDevice] = useState(false);
  const [showForgotDialog, setShowForgotDialog] = useState(false);
  const [contactLinks, setContactLinks] = useState<ContactLinks | null>(null);
  const [isLoadingContacts, setIsLoadingContacts] = useState(false);

  // Telegram Password Recovery State
  const [telegramStep, setTelegramStep] = useState<1 | 2>(1);
  const [tgIdentifier, setTgIdentifier] = useState('');
  const [tgCode, setTgCode] = useState('');
  const [tgNewPassword, setTgNewPassword] = useState('');
  const [tgConfirmPassword, setTgConfirmPassword] = useState('');
  const [tgShowNewPassword, setTgShowNewPassword] = useState(false);
  const [tgShowConfirmPassword, setTgShowConfirmPassword] = useState(false);
  const [isTgLoading, setIsTgLoading] = useState(false);
  const [tgBotLink, setTgBotLink] = useState<string | null>(null);
  const [tgNotLinkedError, setTgNotLinkedError] = useState(false);

  const isPasswordValid = (() => {
    const c = checkPasswordStrength(tgNewPassword);
    return c.hasUpper && c.hasLower && c.hasNumber && c.hasSpecial && c.hasMinLength;
  })();

  const { signIn } = useAuth();
  const { t, direction } = useLanguage();
  const navigate = useNavigate();

  const handleStartDemo = async () => {
    setIsLoading(true);
    try {
      await injectGuestDemoData();
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('guest-demo-started'));
      }
      toast.success('تم تفعيل وضع التجربة بنجاح (صالح لمدة 24 ساعة)');
      navigate('/');
    } catch (err) {
      console.error('Failed to start demo mode:', err);
      toast.error('فشل في بدء وضع التجربة');
    } finally {
      setIsLoading(false);
    }
  };
  const location = useLocation();

  useEffect(() => {
    if (location.state?.error) {
      toast.error(location.state.error);
    }
  }, [location.state?.error]);

  // جلب بيانات التواصل عند فتح نافذة نسيت كلمة المرور
  useEffect(() => {
    if (!showForgotDialog) return;
    const fetchContactLinks = async () => {
      setIsLoadingContacts(true);
      try {
        const { data: linksData } = await supabase
          .from('app_settings')
          .select('value')
          .eq('key', 'contact_links')
          .maybeSingle();

        if (linksData?.value) {
          const parsed = JSON.parse(linksData.value);
          const hasAnyLink = Object.values(parsed).some((v: unknown) => typeof v === 'string' && v.trim());
          setContactLinks(hasAnyLink ? parsed : null);
        } else {
          const { data: phoneData } = await supabase
            .from('app_settings')
            .select('value')
            .eq('key', 'developer_phone')
            .maybeSingle();
          setContactLinks(phoneData?.value ? { whatsapp: phoneData.value } : null);
        }
      } catch (err) {
        console.error('Failed to fetch contact links:', err);
        setContactLinks(null);
      } finally {
        setIsLoadingContacts(false);
      }
    };
    fetchContactLinks();

    // Auto-fill identifier from login email if available
    if (email && !tgIdentifier) {
      setTgIdentifier(email);
    }


    // Fetch Telegram bot info
    const fetchBotInfo = async () => {
      try {
        const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
        const anonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
        const res = await fetch(`${supabaseUrl}/functions/v1/telegram-auth`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: anonKey || '' },
          body: JSON.stringify({ action: 'get_bot_info' }),
        });
        const d = await res.json();
        if (d?.bot_link) {
          setTgBotLink(d.bot_link);
        }
      } catch (err) {
        console.warn('Failed to fetch bot info:', err);
      }
    };
    fetchBotInfo();
  }, [showForgotDialog, email]);

  // Handle Telegram OTP Request (Step 1)
  const handleRequestTelegramOTP = async () => {
    const trimmed = tgIdentifier.trim();
    if (!trimmed) {
      toast.error('يرجى إدخال البريد الإلكتروني أو رقم الهاتف المسجل');
      return;
    }

    setIsTgLoading(true);
    setTgNotLinkedError(false);
    try {
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const anonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
      const response = await fetch(`${supabaseUrl}/functions/v1/telegram-auth`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: anonKey || '',
        },
        body: JSON.stringify({
          action: 'request_otp',
          identifier: trimmed,
        }),
      });

      const resData = await response.json();

      if (!response.ok || !resData?.success) {
        if (resData?.not_linked) {
          setTgNotLinkedError(true);
          if (resData?.bot_link) {
            setTgBotLink(resData.bot_link);
          }
        }
        toast.error(resData?.error || 'فشل إرسال رمز التحقق إلى تيليغرام');
        return;
      }

      toast.success(resData?.message || 'تم إرسال رمز التحقق إلى تيليغرام بنجاح');
      setTelegramStep(2);
    } catch (err: any) {
      console.error('Request Telegram OTP error:', err);
      toast.error('تعذر الاتصال بخدمة تيليغرام، يرجى المحاولة لاحقاً');
    } finally {
      setIsTgLoading(false);
    }
  };

  // Handle Telegram Verify and Reset Password (Step 2)
  const handleVerifyAndResetPassword = async () => {
    const code = tgCode.trim();
    if (!code || code.length !== 6) {
      toast.error('يرجى إدخال رمز التحقق المكون من 6 أرقام');
      return;
    }

    if (!isPasswordValid) {
      toast.error('يرجى استيفاء جميع معايير كلمة المرور (حرف كبير، حرف صغير، رقم، رمز خاص، و8 خانات)');
      return;
    }

    if (tgNewPassword !== tgConfirmPassword) {
      toast.error('كلمة المرور وتأكيدها غير متطابقين');
      return;
    }

    setIsTgLoading(true);
    try {
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const anonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
      const response = await fetch(`${supabaseUrl}/functions/v1/telegram-auth`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: anonKey || '',
        },
        body: JSON.stringify({
          action: 'verify_and_reset',
          identifier: tgIdentifier.trim(),
          code: code,
          new_password: tgNewPassword,
        }),
      });

      const resData = await response.json();

      if (!response.ok || !resData?.success) {
        toast.error(resData?.error || 'فشل التحقق وتغيير كلمة المرور');
        return;
      }

      toast.success(resData?.message || 'تم تغيير كلمة المرور بنجاح! يمكنك الآن تسجيل الدخول.');
      setPassword(tgNewPassword);
      if (tgIdentifier.includes('@')) {
        setEmail(tgIdentifier.trim());
      }
      setShowForgotDialog(false);

      // Reset state for next time
      setTelegramStep(1);
      setTgCode('');
      setTgNewPassword('');
      setTgConfirmPassword('');
    } catch (err: any) {
      console.error('Verify and reset password error:', err);
      toast.error('حدث خطأ أثناء تغيير كلمة المرور');
    } finally {
      setIsTgLoading(false);
    }
  };

  // Check if device is blocked for a user
  const checkDeviceBinding = async (userId: string): Promise<{ blocked: boolean; allowMultiDevice: boolean }> => {
    try {
      const currentDeviceId = await getDeviceId();
      const currentDeviceKey = getDeviceKey();
      console.log('[DeviceCheck] Current device ID:', currentDeviceId, 'Device Key:', currentDeviceKey);
      console.log('[DeviceCheck] Checking for user:', userId);

      // استخراج رتبة المستخدم - استثناء الـ Boss حصراً من فحص الأجهزة
      const { data: roleData } = await supabase
        .from('user_roles')
        .select('role')
        .eq('user_id', userId)
        .maybeSingle();

      if (roleData?.role === 'boss') {
        return { blocked: false, allowMultiDevice: true };
      }

      // معرّف الجهاز الموحّد: نفس المعرّف الذي يُرسل لفحص الترخيص (منع الحظر الخاطئ بسبب اختلاف المعرّفين)
      const { data: ownLicense } = await supabase
        .from('app_licenses')
        .select('device_id')
        .eq('user_id', userId)
        .maybeSingle();
      const bindDeviceId = await getCanonicalDeviceId(ownLicense?.device_id ?? null);

      // استدعاء دالة السحابة الموثوقة لفحص وربط الجهاز
      const { data: bindResult, error: bindError } = await supabase.rpc(
        'check_and_bind_device' as never,
        { p_device_id: bindDeviceId } as never
      );
      const bind = bindResult as
        | { blocked?: boolean; allow_multi_device?: boolean }
        | null
        | undefined;

      if (!bindError && bind) {
        if (bind.blocked === true) {
          console.warn('[DeviceCheck] Device blocked by server:', bind);
          return { blocked: true, allowMultiDevice: false };
        }
        return { blocked: false, allowMultiDevice: bind.allow_multi_device === true };
      }

      // فحص احتياطي محلي في حال انقطاع RPC
      const { data: license } = await supabase
        .from('app_licenses')
        .select('id, device_id, allow_multi_device')
        .eq('user_id', userId)
        .eq('is_revoked', false)
        .maybeSingle();

      if (!license || license.allow_multi_device === true) {
        return { blocked: false, allowMultiDevice: true };
      }

      if (!license.device_id) {
        await supabase.from('app_licenses').update({ device_id: currentDeviceKey }).eq('id', license.id);
        return { blocked: false, allowMultiDevice: false };
      }

      const isMatch = license.device_id === currentDeviceId || license.device_id === currentDeviceKey;
      return { blocked: !isMatch, allowMultiDevice: false };
    } catch (error) {
      console.error('[DeviceCheck] Error:', error);
      return { blocked: false, allowMultiDevice: false };
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // فحص صحة صيغة الإيميل وقوة كلمة المرور
    if (!isValidEmailFormat(email)) {
      toast.error('صيغة البريد الإلكتروني غير صحيحة');
      return;
    }

    if (!password || password.length < 6) {
      toast.error('كلمة المرور ضعيفة (يجب أن تكون 6 أحرف على الأقل)');
      return;
    }

    setIsLoading(true);

    const { error, data, blockedReason } = await signIn(email, password, stayLoggedIn);

    if (error) {
      setIsLoading(false);
      if (blockedReason) {
        navigate('/contact-developer', {
          replace: true,
          state: { supportReason: blockedReason, email: email.trim() },
        });
        return;
      }
      const friendlyMessage = getAuthErrorMessage(error, 'login');
      toast.error(friendlyMessage);
      return;
    }

    // Check device binding after successful login
    if (data?.user) {
      const { blocked } = await checkDeviceBinding(data.user.id);

      if (blocked) {
        const blockData = {
          isBlocked: true,
          userEmail: email.trim(),
        };

        // حفظ الحالة محلياً في الجلسة حتى لا تختفي عند حدوث signOut
        sessionStorage.setItem('hyperpos_active_device_block', JSON.stringify(blockData));
        setBlockedState(blockData);

        // تسجيل الخروج فوراً لتأمين الجلسة السحابية ومنع استهلاك التوكن
        await supabase.auth.signOut();
        setIsLoading(false);
        return;
      }
    }

    // For existing account logins, bypass setup wizard and onboarding tour.
    // If the user arrived here from a new signup flow, preserve hyperpos_just_signed_up intact
    const isNewSignup = (() => {
      try {
        return sessionStorage.getItem('hyperpos_just_signed_up') === 'true';
      } catch { return false; }
    })();

    if (!isNewSignup) {
      try {
        localStorage.setItem('hyperpos_setup_complete', 'true');
      } catch {}
    }

    setIsLoading(false);
    toast.success(t('auth.loginSuccess'));
    navigate('/');
  };

  const handleResetDevice = async () => {
    const targetEmail = blockedState?.userEmail || email;
    if (!targetEmail || !password) {
      toast.error('يرجى كتابة كلمة المرور الخاصة بحسابك لإعادة التعيين والتأكيد');
      return;
    }

    setIsResettingDevice(true);

    try {
      const { data, error } = await supabase.functions.invoke('reset-own-device', {
        body: { email: targetEmail, password }
      });

      if (error) {
        let message = 'تعذر الاتصال بخدمة التحقق من الجهاز';
        try {
          const details = error instanceof FunctionsHttpError
            ? await error.context.text()
            : error.message;
          const parsed = JSON.parse(details);
          if (parsed?.error) message = parsed.error;
          else if (typeof details === 'string' && details.trim()) message = details;
        } catch {
          if (error.message) message = error.message;
        }
        console.error('Reset device error:', error);
        toast.error(message);
        return;
      }

      if (!data) {
        toast.error('تعذر الاتصال بخدمة التحقق من الجهاز');
        return;
      }

      if (!data.success) {
        // إظهار رسالة الخطأ القادمة من الـ SQL (مثل: متبقي X يوم أو ساعات)
        toast.error(data.error || 'فشلت عملية إعادة تعيين الجهاز');
        return;
      }

      toast.success(data.message || 'تم فك ارتباط الجهاز السابق بنجاح!');
      
      // مسح حالة الحظر
      sessionStorage.removeItem('hyperpos_active_device_block');
      setBlockedState(null);

      // تسجيل الدخول بالجهاز الجديد فوراً
      setIsLoading(true);
      await clearGuestDemoData(true);
      const { error: loginError, blockedReason: reauthBlockedReason } = await signIn(targetEmail, password, stayLoggedIn);

      if (loginError) {
        setIsLoading(false);
        if (reauthBlockedReason) {
          navigate('/contact-developer', {
            replace: true,
            state: { supportReason: reauthBlockedReason, email: targetEmail.trim() },
          });
          return;
        }
        toast.error(getAuthErrorMessage(loginError, 'login'));
        return;
      }

      toast.success(t('auth.loginSuccess'));
      navigate('/');
    } catch (err: any) {
      console.error('Reset device error:', err);
      toast.error('حدث خطأ غير متوقع أثناء تصفير الجهاز');
    } finally {
      setIsResettingDevice(false);
      setIsLoading(false);
    }
  };
  return (
    <div 
      className="min-h-screen w-full bg-background flex flex-col justify-between p-4 sm:p-6 md:justify-center md:items-center relative"
      dir={direction}
    >
      {/* ترويسة آمنة تأخذ بعين الاعتبار نوتش الجوال وSafe Area Insets */}
      <div className="w-full max-w-md mx-auto pt-[env(safe-area-inset-top,12px)] flex items-center justify-between pb-4">
        {/* شعار المتجر والعنوان المدمج */}
        <div className="flex items-center gap-2.5">
          <img 
            src="/app-icon.png" 
            alt="FlowPOS Pro" 
            className="w-10 h-10 rounded-2xl shadow-sm object-cover" 
          />
          <span className="font-bold text-sm sm:text-base text-foreground tracking-tight">FlowPOS Pro</span>
        </div>

        {/* زر اللغة الموحد والواضح تماماً — بعيداً عن حواف الشاشة والإشعارات */}
        <LanguageQuickSelector />
      </div>

      {/* المحتوى الرئيسي للنموذج — شاشة كاملة متجاوبة Native */}
      <div className="w-full max-w-md mx-auto flex-1 flex flex-col justify-center py-4 space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl sm:text-3xl font-black text-foreground tracking-tight">
            {t('auth.welcome') || 'مرحباً بك في FlowPOS Pro'}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t('auth.loginSubtitle') || 'سجل دخولك لإدارة مبيعاتك ومتجرك'}
          </p>
        </div>

        {location.state?.error && (
          <div className="p-3.5 rounded-2xl bg-destructive/10 border border-destructive/20 text-destructive text-sm flex items-center gap-2.5">
            <AlertTriangle className="w-5 h-5 flex-shrink-0" />
            <span className="font-medium">{location.state.error}</span>
          </div>
        )}

        {/* حقول الإدخال والأزرار المصممة بارتفاعات لمس مريحة (h-12) */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email" className="text-xs sm:text-sm font-bold text-foreground">
              {t('auth.email')}
            </Label>
            <Input
              id="email"
              type="email"
              placeholder="name@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              disabled={isLoading}
              className="h-12 rounded-xl text-sm sm:text-base px-3.5 border-border/80"
              dir="ltr"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="password" className="text-xs sm:text-sm font-bold text-foreground">
              {t('auth.password')}
            </Label>
            <div className="relative">
              <Input
                id="password"
                type={showPassword ? 'text' : 'password'}
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                disabled={isLoading}
                className="h-12 rounded-xl pe-11 text-sm sm:text-base px-3.5 border-border/80"
                dir="ltr"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute top-1/2 -translate-y-1/2 end-3 text-muted-foreground hover:text-foreground transition-colors p-1"
              >
                {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between pt-1">
            <button
              type="button"
              onClick={() => { if (email && !tgIdentifier) setTgIdentifier(email); setShowForgotDialog(true); }}
              className="text-xs sm:text-sm text-primary font-bold hover:underline cursor-pointer"
            >
              {t('auth.forgotPassword')}
            </button>
          </div>

          <Button
            type="submit"
            className="w-full h-12 rounded-2xl text-base font-bold shadow-md bg-gradient-primary hover:brightness-105 active:scale-98 text-primary-foreground transition-all cursor-pointer"
            disabled={isLoading}
          >
            {isLoading ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" />
                <span>{t('auth.loading')}</span>
              </>
            ) : (
              <span>{t('auth.login')}</span>
            )}
          </Button>

          <div className="relative w-full my-2">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t border-border" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-background px-2 text-muted-foreground font-medium">أو</span>
            </div>
          </div>

          <Button
            type="button"
            variant="outline"
            onClick={handleStartDemo}
            disabled={isLoading}
            className="w-full h-12 rounded-2xl border-dashed border-primary/50 hover:border-primary hover:bg-primary/5 text-primary font-bold flex items-center justify-center gap-2 transition-colors cursor-pointer text-sm"
          >
            <Sparkles className="w-4 h-4 text-primary" />
            <span>تجربة التطبيق بدون حساب (Demo Mode)</span>
          </Button>
        </form>
      </div>

      {/* التذييل السفلي: روابط الاستعادة وإنشاء حساب جديد */}
      <div className="w-full max-w-md mx-auto pb-[env(safe-area-inset-bottom,16px)] pt-4 text-center">
        <div className="flex items-center justify-center gap-2 text-xs sm:text-sm text-muted-foreground">
          <span>{t('auth.noAccount') || 'ليس لديك حساب؟'}</span>
          <Link to="/signup" className="text-primary font-bold hover:underline">
            {t('auth.signup') || 'إنشاء حساب جديد'}
          </Link>
        </div>
      </div>

      {/* ========================================================================= */}
      {/* نافذة استعادة كلمة المرور عبر تيليغرام والتواصل مع المطور حصراً */}
      {/* ========================================================================= */}
      <Dialog open={showForgotDialog} onOpenChange={(open) => {
        setShowForgotDialog(open);
        if (!open) {
          setTelegramStep(1);
          setTgCode('');
          setTgNewPassword('');
          setTgConfirmPassword('');
          setTgNotLinkedError(false);
        }
      }}>
        <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto" dir={direction}>
          <DialogHeader className="text-center sm:text-center pb-2">
            <div className="mx-auto w-14 h-14 rounded-2xl flex items-center justify-center mb-2.5 transition-colors shadow-xs bg-sky-500/10 text-sky-500 border border-sky-500/20">
              <Send className="w-7 h-7" />
            </div>
            <DialogTitle className="text-lg font-bold">
              استعادة كلمة المرور عبر تيليغرام
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground leading-relaxed">
              يتم إرسال رمز الأمان (OTP) مباشرة وبشكل فوري إلى حسابك في بوت تيليغرام
            </DialogDescription>
          </DialogHeader>

          {/* محتوى الاستعادة عبر تيليغرام */}
          <div className="space-y-4 pt-1">
            {telegramStep === 1 ? (
              /* الخطوة 1: إدخال البريد أو الهاتف لطلب الرمز */
              <div className="space-y-3.5">
                <div className="space-y-1.5">
                  <Label htmlFor="tgIdentifier" className="text-xs font-semibold text-foreground">
                    البريد الإلكتروني أو رقم الهاتف المسجل
                  </Label>
                  <div className="relative">
                    <Input
                      id="tgIdentifier"
                      type="text"
                      placeholder="name@example.com أو 0770..."
                      value={tgIdentifier}
                      onChange={(e) => {
                        setTgIdentifier(e.target.value);
                        setTgNotLinkedError(false);
                      }}
                      disabled={isTgLoading}
                      className="h-11 rounded-xl text-sm"
                      dir="ltr"
                    />
                  </div>
                  <p className="text-[11px] text-muted-foreground leading-normal">
                    أدخل بيانات حسابك لإرسال رمز التحقق فوراً إلى محادثة البوت الخاصة بك.
                  </p>
                </div>

                {/* تنبيه إذا كان الحساب غير مربوط بعد */}
                {tgNotLinkedError && (
                  <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-2xl text-xs space-y-2 text-amber-700 dark:text-amber-400">
                    <div className="flex items-center gap-2 font-bold">
                      <AlertTriangle className="w-4 h-4 shrink-0" />
                      <span>حسابك غير مربوط بالبوت بعد</span>
                    </div>
                    <p className="text-[11px] leading-relaxed">
                      لم يتم ربط رقم هاتفك ببوت التحقق حتى الآن. افتح البوت واضغط <strong>/start</strong> ثم <strong>«مشاركة رقم الهاتف للتحقق»</strong>.
                    </p>
                    {tgBotLink && (
                      <a
                        href={tgBotLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center justify-center gap-2 w-full py-2 px-3 bg-sky-500 hover:bg-sky-600 text-white rounded-xl font-bold text-xs transition-colors shadow-sm"
                      >
                        <Send className="w-3.5 h-3.5" />
                        <span>فتح البوت في تيليغرام الآن</span>
                      </a>
                    )}
                  </div>
                )}

                <Button
                  onClick={handleRequestTelegramOTP}
                  disabled={isTgLoading || !tgIdentifier.trim()}
                  className="w-full h-11 rounded-xl font-bold bg-sky-500 hover:bg-sky-600 active:scale-98 text-white shadow-sm cursor-pointer"
                >
                  {isTgLoading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>جاري إرسال الرمز...</span>
                    </>
                  ) : (
                    <>
                      <Send className="w-4 h-4 me-1.5" />
                      <span>إرسال رمز التحقق إلى تيليغرام</span>
                    </>
                  )}
                </Button>
              </div>
            ) : (
              /* الخطوة 2: إدخال رمز التحقق وتعيين كلمة المرور الجديدة */
              <div className="space-y-3.5">
                <div className="p-3 bg-sky-500/10 border border-sky-500/20 rounded-2xl text-xs space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-sky-700 dark:text-sky-300">تم إرسال الرمز إلى تيليغرام</span>
                    <button
                      type="button"
                      onClick={() => setTelegramStep(1)}
                      className="text-[11px] text-muted-foreground hover:text-foreground underline cursor-pointer"
                    >
                      تغيير الحساب
                    </button>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    راجع محادثة البوت وأدخل الرمز المكون من 6 أرقام هنا.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="tgCode" className="text-xs font-semibold">رمز التحقق (6 أرقام)</Label>
                  <Input
                    id="tgCode"
                    type="text"
                    maxLength={6}
                    placeholder="123456"
                    value={tgCode}
                    onChange={(e) => setTgCode(e.target.value.replace(/\D/g, ''))}
                    disabled={isTgLoading}
                    className="h-11 rounded-xl font-mono text-center tracking-widest text-lg font-bold"
                    dir="ltr"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="tgNewPassword" className="text-xs font-semibold">كلمة المرور الجديدة</Label>
                  <Input
                    id="tgNewPassword"
                    type="password"
                    placeholder="8 خانات على الأقل"
                    value={tgNewPassword}
                    onChange={(e) => setTgNewPassword(e.target.value)}
                    disabled={isTgLoading}
                    className="h-11 rounded-xl text-sm"
                    dir="ltr"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="tgConfirmPassword" className="text-xs font-semibold">تأكيد كلمة المرور</Label>
                  <Input
                    id="tgConfirmPassword"
                    type="password"
                    placeholder="أعد إدخال كلمة المرور"
                    value={tgConfirmPassword}
                    onChange={(e) => setTgConfirmPassword(e.target.value)}
                    disabled={isTgLoading}
                    className="h-11 rounded-xl text-sm"
                    dir="ltr"
                  />
                </div>

                <Button
                  onClick={handleVerifyAndResetPassword}
                  disabled={isTgLoading || tgCode.length !== 6 || !tgNewPassword || !tgConfirmPassword}
                  className="w-full h-11 rounded-xl font-bold bg-gradient-primary text-primary-foreground shadow-sm cursor-pointer"
                >
                  {isTgLoading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>جاري حفظ كلمة المرور...</span>
                    </>
                  ) : (
                    <span>حفظ كلمة المرور الجديدة والدخول</span>
                  )}
                </Button>
              </div>
            )}

            {/* بطاقة الدعم: التواصل مع المطور والدعم الفني */}
            <div className="pt-2 border-t border-border/50">
              <div className="bg-muted/40 rounded-2xl p-3 flex items-center justify-between gap-2 border border-border/40">
                <div className="space-y-0.5">
                  <p className="text-xs font-bold text-foreground">تواجه مشكلة بالاسترداد؟</p>
                  <p className="text-[11px] text-muted-foreground">تواصل مباشرة مع المطور للمساعدة اليدوية</p>
                </div>
                <Link
                  to="/contact-developer"
                  onClick={() => setShowForgotDialog(false)}
                  className="px-3 py-1.5 bg-background hover:bg-muted text-xs font-bold rounded-xl border border-border text-foreground transition-colors shrink-0"
                >
                  التواصل مع المطور
                </Link>
              </div>
            </div>
          </div>

          <DialogFooter className="border-t border-border/40 pt-2.5 mt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setShowForgotDialog(false)}
              className="w-full h-10 rounded-xl text-xs font-semibold cursor-pointer"
            >
              إلغاء
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* ========================================================================= */}
      {/* بطاقة الحظر الدائمة - تظل ثابتة أمام المستخدم حتى يقوم بالإغلاق أو التصفير */}
      {/* ========================================================================= */}
      {blockedState?.isBlocked && (
        <div 
          className="fixed inset-0 z-[250] bg-background/90 backdrop-blur-md flex items-center justify-center p-4"
          dir={direction}
        >
          <div className="w-full max-w-md bg-card border border-destructive/30 rounded-3xl p-6 sm:p-7 shadow-2xl space-y-5 animate-in zoom-in-95 duration-200">
            
            {/* الترويسة والأيقونة */}
            <div className="text-center space-y-2.5">
              <div className="w-16 h-16 bg-destructive/10 text-destructive border border-destructive/20 rounded-2xl flex items-center justify-center mx-auto shadow-inner">
                <ShieldAlert className="w-9 h-9" />
              </div>
              <h3 className="text-xl sm:text-2xl font-black text-foreground tracking-tight">
                الحساب مقترن بجهاز آخر
              </h3>
              <p className="text-xs sm:text-sm text-muted-foreground leading-relaxed px-2">
                حسابك مسجل ومرتبط بهاتف آخر مسبقاً. حماية للترخيص ولبياناتك لا يمكن فتح الحساب على جهازين بنفس الوقت.
              </p>
            </div>

            {/* الحساب المستهدف */}
            <div className="p-3 bg-muted/50 rounded-2xl border border-border/50 text-center">
              <span className="text-xs text-muted-foreground block mb-0.5">البريد الإلكتروني المرتبط:</span>
              <span className="font-mono font-bold text-xs sm:text-sm text-foreground select-all">
                {blockedState.userEmail || email}
              </span>
            </div>

            {/* الأزرار والإجراءات */}
            <div className="space-y-2.5 pt-1">
              {/* زر التصفير المباشر (خاضع لمهلة الـ 5 أيام) */}
              <Button 
                type="button"
                onClick={handleResetDevice} 
                disabled={isResettingDevice} 
                className="w-full h-12 rounded-xl font-bold bg-primary hover:bg-primary/90 text-primary-foreground flex items-center justify-center gap-2 shadow-md transition-all active:scale-98 cursor-pointer"
              >
                {isResettingDevice ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>جاري التحقق وفك الارتباط...</span>
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-4 h-4" />
                    <span>تصفير وربط هذا الجهاز (كل 5 أيام)</span>
                  </>
                )}
              </Button>

              {/* زر التصفير عبر بوت Telegram الرسمي */}
              <Button 
                type="button"
                variant="outline"
                onClick={() => {
                  const botUser = tgBotLink || 'https://t.me/Flowpos_pro_bot';
                  window.open(botUser, '_blank');
                }}
                className="w-full h-11 rounded-xl font-bold border-sky-500/30 text-sky-600 dark:text-sky-400 hover:bg-sky-500/10 flex items-center justify-center gap-2 transition-all cursor-pointer"
              >
                <Send className="w-4 h-4" />
                <span>التصفير عبر بوت تيليغرام (/reset_device)</span>
              </Button>

              {/* زر إغلاق التنبيه */}
              <Button 
                type="button"
                variant="ghost" 
                onClick={() => {
                  sessionStorage.removeItem('hyperpos_active_device_block');
                  setBlockedState(null);
                }} 
                className="w-full h-10 rounded-xl text-muted-foreground hover:text-foreground text-xs font-semibold cursor-pointer"
              >
                إغلاق التنبيه وتجربة حساب آخر
              </Button>
            </div>

            <p className="text-[11px] text-center text-muted-foreground leading-normal">
              🔒 يُسمح بنقل الترخيص وتغيير الجهاز مرة واحدة كل 5 أيام كحد أقصى لأمان النظام.
            </p>
          </div>
        </div>
      )}

    </div>
  );
}
