import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { MessageCircle, Headphones, AlertCircle, ArrowLeft, ArrowRight, Shield } from 'lucide-react';
import { useLanguage } from '@/hooks/use-language';
import { useLicense } from '@/hooks/use-license';
import { ContactLinksSection } from '@/components/settings/ContactLinksSection';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from '@/lib/sonner-bridge';
import { CURRENT_VERSION_NAME } from '@/lib/remote-updates';
import { checkTelegramRelease, compareReleaseVersions } from '@/lib/telegram-updates';
import { Download, Loader2 } from 'lucide-react';
import { InlineSupportChatPanel } from '@/components/support/InlineSupportChatPanel';

export default function ContactDeveloper() {
  const { direction, isRTL, language } = useLanguage();
  const isEn = language === 'en';
  const location = useLocation();
  const navigate = useNavigate();
  const supportReason = (location.state as any)?.supportReason as string | undefined;
  const userEmail = (location.state as any)?.email as string | undefined;
  const license = useLicense();
  const licenseState = (license as any)?.licenseState || license;
  const [chatOpen, setChatOpen] = useState(true);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [publishedVersion, setPublishedVersion] = useState<string>();

  const checkUpdate = async () => {
    setCheckingUpdate(true);
    try {
      const release = await checkTelegramRelease();
      setPublishedVersion(release.version);
      if (compareReleaseVersions(release.version, CURRENT_VERSION_NAME) > 0) {
        window.location.assign(release.url);
      } else {
        toast.info(isEn ? 'Your app is up to date.' : 'نسختك محدّثة.');
      }
    } catch {
      toast.error(isEn ? 'Could not check the latest version. Please try again.' : 'تعذّر فحص الإصدار المنشور. حاول مجدداً.');
    } finally {
      setCheckingUpdate(false);
    }
  };

  useEffect(() => {
    if ((location.state as any)?.openChat) {
      setChatOpen(true);
    }
  }, [location.state]);

  useEffect(() => {
    const handleOpenChat = () => setChatOpen(true);
    window.addEventListener('posflow:open-support-chat', handleOpenChat);
    return () => window.removeEventListener('posflow:open-support-chat', handleOpenChat);
  }, []);


  const reasonDetails = (() => {
    switch (supportReason) {
      case 'inactive':
        return {
          title: isEn ? 'Account Disabled' : 'الحساب معطل',
          desc: isEn ? 'This account has been disabled by administration. Please contact support or the developer to reactivate it.' : 'تم تعطيل هذا الحساب من قبل الإدارة. يرجى التواصل مع الدعم الفني أو المطور لإعادة التنشيط.',
          severity: 'destructive',
        };
      case 'owner_inactive':
        return {
          title: isEn ? 'Store Account Suspended' : 'حساب المتجر متوقف',
          desc: isEn ? 'The primary store account is suspended. Please contact your store manager or the developer.' : 'تم إيقاف حساب المتجر الأساسي التابع له. يرجى مراجعة إدارة متجرك أو التواصل مع المطور.',
          severity: 'destructive',
        };
      case 'revoked':
        return {
          title: isEn ? 'License Revoked' : 'تم إلغاء الترخيص',
          desc: isEn ? 'The license for this account or device has been revoked. Please contact the developer to restore access.' : 'تم إلغاء ترخيص هذا الحساب أو الجهاز. يرجى التواصل مع المطور لتسوية الترخيص وإعادة التفعيل.',
          severity: 'destructive',
        };
      case 'expired':
        return {
          title: isEn ? 'License Expired' : 'انتهت صلاحية الترخيص',
          desc: isEn ? 'Your license period (trial or annual) has expired. Please contact the developer to renew.' : 'انتهت فترة صلاحية الترخيص (تجريبي أو سنوي). يرجى التواصل مع المطور لتجديد الاشتراك.',
          severity: 'warning',
        };
      case 'activation_required':
        return {
          title: isEn ? 'Activation Code Required' : 'مطلوب كود التفعيل',
          desc: isEn ? 'An activation code is required to continue. Request one via the support channels below.' : 'يتطلب النظام كود تفعيل للمتابعة. يمكنك طلب كود التفعيل عبر قنوات الدعم أدناه.',
          severity: 'info',
        };
      default:
        return supportReason ? {
          title: isEn ? 'Support Review Required' : 'مطلوب مراجعة الدعم الفني',
          desc: isEn ? 'Your account requires contacting technical support to continue.' : 'يتطلب حسابك التواصل مع الدعم الفني لمتابعة الاستخدام.',
          severity: 'warning',
        } : null;
    }
  })();



  return (
    <div className="w-full min-w-0 max-w-none self-stretch px-4 pb-4 pt-12 space-y-5 md:mx-auto md:max-w-4xl md:p-8 md:pt-4" dir={direction}>
      {(supportReason === 'revoked' || supportReason === 'inactive' || supportReason === 'owner_inactive') ? null : (
        /* للعملاء العاديين: بطاقة تجديد وترقية الاشتراك (لا تُعرض للحساب الملغى/المحظور) */
        <div className="rounded-2xl border border-primary/30 bg-gradient-to-br from-primary/10 via-card to-background p-5 shadow-sm flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-primary/20 text-primary shrink-0">
              <Shield className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-foreground">{isEn ? "Renew & Upgrade Subscription" : "تجديد وترقية الاشتراك"}</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                {licenseState.isExpired 
                  ? (isEn ? 'Your current subscription has expired. Renew now to continue.' : 'انتهى اشتراكك الحالي. يمكنك التجديد فوراً لمتابعة العمل.')
                  : licenseState.remainingDays !== null && licenseState.remainingDays !== undefined
                    ? (isEn ? `Remaining in your subscription: ${licenseState.remainingDays} days` : `المتبقي في اشتراكك: ${licenseState.remainingDays} يوماً`)
                    : (isEn ? 'Choose the subscription plan that fits your store and product capacity' : 'اختر باقة الاشتراك المناسبة لمتجرك وسعة منتجاتك')}
              </p>
            </div>
          </div>
          <Button onClick={() => navigate('/renew')} className="gap-2 shrink-0 w-full sm:w-auto">
            {isEn ? "Renew / Upgrade Now" : "تجديد / ترقية الآن"}
            {isRTL ? <ArrowLeft className="w-4 h-4" /> : <ArrowRight className="w-4 h-4" />}
          </Button>
        </div>
      )}
      {/* Support Reason Alert Banner */}
      {reasonDetails && (
        <div className={`rounded-2xl border p-5 shadow-sm space-y-3 ${
          reasonDetails.severity === 'destructive'
            ? 'border-destructive/30 bg-destructive/10 text-destructive-foreground'
            : reasonDetails.severity === 'warning'
            ? 'border-amber-500/30 bg-amber-500/10 text-amber-950 dark:text-amber-100'
            : 'border-primary/30 bg-primary/10 text-foreground'
        }`}>
          <div className="flex items-start gap-3">
            <div className={`p-2.5 rounded-xl shrink-0 ${
              reasonDetails.severity === 'destructive'
                ? 'bg-destructive/20 text-destructive'
                : reasonDetails.severity === 'warning'
                ? 'bg-amber-500/20 text-amber-600 dark:text-amber-400'
                : 'bg-primary/20 text-primary'
            }`}>
              <AlertCircle className="w-5 h-5" />
            </div>
            <div className="flex-1 min-w-0 space-y-1">
              <h3 className="text-base font-bold text-foreground">
                {reasonDetails.title}
              </h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                {reasonDetails.desc}
              </p>
              {userEmail && (
                <div className="pt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>{isEn ? "Linked Email:" : "البريد الإلكتروني المرتبط:"}</span>
                  <code className="font-mono bg-background/80 px-2 py-0.5 rounded border border-border text-foreground font-semibold" dir="ltr">
                    {userEmail}
                  </code>
                </div>
              )}
            </div>
          </div>
          <div className="pt-2 border-t border-border/50 flex justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => navigate('/login')}
              className="gap-2 text-xs"
            >
              {isRTL ? <ArrowRight className="w-3.5 h-3.5" /> : <ArrowLeft className="w-3.5 h-3.5" />}
              {isEn ? "Back to Login" : "العودة لتسجيل الدخول"}
            </Button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-1.5">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold">{isEn ? "App Update" : "تحديث التطبيق"}</p>
          <p className="text-[11px] text-muted-foreground">
            {isEn ? "Installed" : "المثبّت"} <bdi>v{CURRENT_VERSION_NAME}</bdi>
            {publishedVersion && <> · {isEn ? "Latest" : "المنشور"} <bdi>v{publishedVersion}</bdi></>}
          </p>
        </div>
        <Button type="button" size="sm" className="h-8 shrink-0 gap-1 px-2 text-xs" disabled={checkingUpdate} onClick={() => void checkUpdate()}>
          {checkingUpdate ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          {checkingUpdate ? (isEn ? 'Checking…' : 'جاري الفحص…') : (isEn ? 'Check Updates' : 'فحص التحديثات')}
        </Button>
      </div>

      {/* Live Support Chat CTA */}
      {!chatOpen && <div className="rounded-2xl border border-primary/30 bg-primary/5 p-5 flex items-center gap-4">
        <div className="w-12 h-12 rounded-xl bg-primary/20 flex items-center justify-center shrink-0">
          <Headphones className="w-6 h-6 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <h2 className="text-sm font-bold text-foreground">
              {isEn ? "Live Technical Support" : "الدعم الفني المباشر"}
            </h2>
            <Badge className="text-[9px] px-1.5 py-0 h-4 bg-green-500/20 text-green-600 border-green-500/30">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse me-1 inline-block" />
              {isEn ? "Online" : "متصل"}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            {isEn ? "Chat directly with the developer — we will reply as soon as possible" : "تواصل مع المطور مباشرة — سنرد عليك في أقرب وقت ممكن"}
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => setChatOpen(true)}
          className="shrink-0 gap-1.5"
        >
          <MessageCircle className="w-3.5 h-3.5" />
          {isEn ? "Start Chat" : "ابدأ المحادثة"}
        </Button>
      </div>}

      {/* Embedded Inline Chat (opens when button is clicked) */}
      {chatOpen && (
        <InlineSupportChatPanel onClose={() => setChatOpen(false)} />
      )}

      {/* Social / Contact Links */}
      <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
        <ContactLinksSection />
      </div>
    </div>
  );
}
