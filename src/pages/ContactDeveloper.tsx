import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { MessageCircle, Phone, Globe, User, Headphones, AlertCircle, ArrowLeft, ArrowRight, Shield } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useLanguage } from '@/hooks/use-language';
import { useLicense } from '@/hooks/use-license';
import { ContactLinksSection } from '@/components/settings/ContactLinksSection';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from '@/lib/sonner-bridge';
import { getCachedReleaseConfig, fetchReleaseConfig, openExternal, CURRENT_VERSION_NAME, CURRENT_VERSION_CODE, type ReleaseConfig } from '@/lib/remote-updates';
import { Download, Send } from 'lucide-react';
import { InlineSupportChatPanel } from '@/components/support/InlineSupportChatPanel';

interface DevInfo { name?: string; phone?: string; website?: string }

export default function ContactDeveloper() {
  const { t, direction, isRTL } = useLanguage();
  const location = useLocation();
  const navigate = useNavigate();
  const supportReason = (location.state as any)?.supportReason as string | undefined;
  const userEmail = (location.state as any)?.email as string | undefined;
  const license = useLicense();
  const licenseState = (license as any)?.licenseState || license;
  const [info, setInfo] = useState<DevInfo>({});
  const isDirectChatOpen = Boolean((location.state as any)?.openChat);
  const [chatOpen, setChatOpen] = useState(true);
  const [rel, setRel] = useState<ReleaseConfig>(getCachedReleaseConfig());
  useEffect(() => { fetchReleaseConfig().then(setRel).catch(() => {}); }, []);

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

  useEffect(() => {
    supabase.from('app_settings').select('value').eq('key', 'contact_links').maybeSingle().then(({ data }) => {
      if (!data?.value) return;
      try {
        const p = JSON.parse(data.value);
        setInfo({ name: p._developer_name, phone: p._phone, website: p._website });
      } catch { /* ignore */ }
    });
  }, []);

  const reasonDetails = (() => {
    switch (supportReason) {
      case 'inactive':
        return {
          title: 'الحساب معطل',
          desc: 'تم تعطيل هذا الحساب من قبل الإدارة. يرجى التواصل مع الدعم الفني أو المطور لإعادة التنشيط.',
          severity: 'destructive',
        };
      case 'owner_inactive':
        return {
          title: 'حساب المتجر متوقف',
          desc: 'تم إيقاف حساب المتجر الأساسي التابع له. يرجى مراجعة إدارة متجرك أو التواصل مع المطور.',
          severity: 'destructive',
        };
      case 'revoked':
        return {
          title: 'تم إلغاء الترخيص',
          desc: 'تم إلغاء ترخيص هذا الحساب أو الجهاز. يرجى التواصل مع المطور لتسوية الترخيص وإعادة التفعيل.',
          severity: 'destructive',
        };
      case 'expired':
        return {
          title: 'انتهت صلاحية الترخيص',
          desc: 'انتهت فترة صلاحية الترخيص (تجريبي أو سنوي). يرجى التواصل مع المطور لتجديد الاشتراك.',
          severity: 'warning',
        };
      case 'activation_required':
        return {
          title: 'مطلوب كود التفعيل',
          desc: 'يتطلب النظام كود تفعيل للمتابعة. يمكنك طلب كود التفعيل عبر قنوات الدعم أدناه.',
          severity: 'info',
        };
      default:
        return supportReason ? {
          title: 'مطلوب مراجعة الدعم الفني',
          desc: 'يتطلب حسابك التواصل مع الدعم الفني لمتابعة الاستخدام.',
          severity: 'warning',
        } : null;
    }
  })();

  const phoneValue = (info.phone || '').trim();
  const phoneIsLink = /^(https?:\/\/|t\.me\/|telegram\.me\/|wa\.me\/|@)/i.test(phoneValue);
  const phoneUrl = phoneValue.startsWith('@') ? `https://t.me/${phoneValue.slice(1)}` : (/^https?:\/\//i.test(phoneValue) ? phoneValue : `https://${phoneValue}`);
  const phoneDigits = phoneValue.replace(/[^\d+]/g, '');
  const site = info.website?.trim();
  const siteUrl = site ? (site.startsWith('http') ? site : `https://${site}`) : '';

  return (
    <div className="p-4 md:p-8 max-w-2xl mx-auto space-y-5 pt-12 md:pt-4" dir={direction}>
      {(supportReason === 'revoked' || supportReason === 'inactive' || supportReason === 'owner_inactive') ? null : (
        /* للعملاء العاديين: بطاقة تجديد وترقية الاشتراك (لا تُعرض للحساب الملغى/المحظور) */
        <div className="rounded-2xl border border-primary/30 bg-gradient-to-br from-primary/10 via-card to-background p-5 shadow-sm flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-primary/20 text-primary shrink-0">
              <Shield className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-foreground">تجديد وترقية الاشتراك</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                {licenseState.isExpired 
                  ? 'انتهى اشتراكك الحالي. يمكنك التجديد فوراً لمتابعة العمل.'
                  : licenseState.remainingDays !== null && licenseState.remainingDays !== undefined
                    ? `المتبقي في اشتراكك: ${licenseState.remainingDays} يوماً`
                    : 'اختر باقة الاشتراك المناسبة لمتجرك وسعة منتجاتك'}
              </p>
            </div>
          </div>
          <Button onClick={() => navigate('/renew')} className="gap-2 shrink-0 w-full sm:w-auto">
            تجديد / ترقية الآن
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
                  <span>البريد الإلكتروني المرتبط:</span>
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
              العودة لتسجيل الدخول
            </Button>
          </div>
        </div>
      )}

      {/* Developer Info Card */}
      <div className="rounded-2xl border border-border bg-card p-6 text-center space-y-3 shadow-sm">
        <div className="w-16 h-16 mx-auto rounded-2xl bg-primary/10 flex items-center justify-center">
          <MessageCircle className="w-8 h-8 text-primary" />
        </div>
        <h1 className="text-xl font-bold text-foreground">{t('license.contactDeveloper')}</h1>
        {info.name && (
          <p className="flex items-center justify-center gap-2 text-muted-foreground">
            <User className="w-4 h-4" /> {info.name}
          </p>
        )}
        <div className="flex flex-wrap justify-center gap-2 pt-1">
          {phoneValue && (
            phoneIsLink ? (
              <button type="button" onClick={() => openExternal(phoneUrl)} className="inline-flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm hover:bg-muted" dir="ltr">
                <Send className="w-4 h-4 text-primary" /> {phoneValue.replace(/^https?:\/\//, '')}
              </button>
            ) : phoneDigits.length > 3 ? (
              <a href={`tel:${phoneDigits}`} className="inline-flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm hover:bg-muted" dir="ltr">
                <Phone className="w-4 h-4 text-primary" /> {phoneValue}
              </a>
            ) : null
          )}
          {siteUrl && (
            <a href={siteUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm hover:bg-muted" dir="ltr">
              <Globe className="w-4 h-4 text-primary" /> {site}
            </a>
          )}
        </div>
      </div>

      {/* App update */}
      <div className="rounded-2xl border border-border bg-card p-4 flex flex-wrap items-center gap-2">
        <div className="flex-1 min-w-[8rem]">
          <p className="text-sm font-bold text-foreground">تحديث التطبيق</p>
          <p className="text-xs text-muted-foreground" dir="ltr">
            v{CURRENT_VERSION_NAME}
            {rel.latest_version_code && rel.latest_version_code > CURRENT_VERSION_CODE && rel.latest_version_name && rel.latest_version_name !== CURRENT_VERSION_NAME
              ? ` → v${rel.latest_version_name} (تحديث جديد متوفر)`
              : ' (أحدث إصدار مثبت)'}
          </p>
        </div>
        <Button
          size="sm"
          className="gap-1.5"
          disabled={!rel.update_url && !rel.telegram_url}
          onClick={() => openExternal(rel.update_url || rel.telegram_url)}
        >
          <Download className="w-3.5 h-3.5" />
          {rel.latest_version_code && rel.latest_version_code > CURRENT_VERSION_CODE ? 'تحميل التحديث' : 'فحص التحديثات'}
        </Button>
        {rel.telegram_url && (
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => openExternal(rel.telegram_url)}>
            <Send className="w-3.5 h-3.5" /> Telegram
          </Button>
        )}
      </div>

      {/* Live Support Chat CTA */}
      {!chatOpen && <div className="rounded-2xl border border-primary/30 bg-primary/5 p-5 flex items-center gap-4">
        <div className="w-12 h-12 rounded-xl bg-primary/20 flex items-center justify-center shrink-0">
          <Headphones className="w-6 h-6 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <h2 className="text-sm font-bold text-foreground">
              الدعم الفني المباشر
            </h2>
            <Badge className="text-[9px] px-1.5 py-0 h-4 bg-green-500/20 text-green-600 border-green-500/30">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse me-1 inline-block" />
              متصل
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            تواصل مع المطور مباشرة — سنرد عليك في أقرب وقت ممكن
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => setChatOpen(true)}
          className="shrink-0 gap-1.5"
        >
          <MessageCircle className="w-3.5 h-3.5" />
          ابدأ المحادثة
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
