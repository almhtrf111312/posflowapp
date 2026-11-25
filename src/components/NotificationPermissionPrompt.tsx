import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Bell, PackageX, Wallet, MessageCircle, Download } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useAuth } from '@/hooks/auth-context';
import { checkNotificationPermissionNative } from '@/lib/native-notifications';

/**
 * نافذة شرح إذن الإشعارات
 * لا يطلب التطبيق إذن الإشعارات من النظام عند الإقلاع. بدلاً من ذلك تظهر هذه النافذة مرة واحدة
 * بعد تجهيز المتجر، تشرح فائدة الإشعارات، وعند الموافقة تنقل المستخدم إلى قسم الإشعارات في الإعدادات
 * حيث يفعّلها بنفسه. عند اختيار «لاحقاً» لا تظهر مجدداً قبل 14 يوماً.
 */
const DISMISSED_KEY = 'hp_notif_prompt_dismissed_at';
const REMIND_AFTER_MS = 14 * 24 * 60 * 60 * 1000;
const SHOW_DELAY_MS = 6000;
const HIDDEN_PATHS = ['/login', '/signup', '/reset-password', '/settings'];

export function NotificationPermissionPrompt() {
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!user?.id) return;
    if (HIDDEN_PATHS.some(p => location.pathname.startsWith(p))) return;
    try {
      if (localStorage.getItem('posflow_setup_complete') !== 'true' && !localStorage.getItem('posflow_settings_v1')) return;
      const dismissedAt = Number(localStorage.getItem(DISMISSED_KEY) || 0);
      if (dismissedAt && Date.now() - dismissedAt < REMIND_AFTER_MS) return;
    } catch {
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      const status = await checkNotificationPermissionNative().catch(() => 'granted' as const);
      // يُعرض فقط إذا لم يقرر المستخدم بعد (لا مفعّل ولا مرفوض نهائياً)
      if (!cancelled && status !== 'granted' && status !== 'denied') {
        setOpen(true);
      }
    }, SHOW_DELAY_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [user?.id, location.pathname]);

  const remindLater = () => {
    try { localStorage.setItem(DISMISSED_KEY, String(Date.now())); } catch { /* ignore */ }
    setOpen(false);
  };

  const goToSettings = () => {
    try { localStorage.setItem(DISMISSED_KEY, String(Date.now())); } catch { /* ignore */ }
    setOpen(false);
    navigate('/settings?tab=notifications');
  };

  const benefits = [
    { icon: PackageX, text: 'تنبيه عند انخفاض المخزون أو نفاد منتج' },
    { icon: Wallet, text: 'تذكير بالديون المستحقة والمتأخرة على العملاء' },
    { icon: MessageCircle, text: 'ردود الدعم الفني وتفعيل أو تجديد اشتراكك' },
    { icon: Download, text: 'الإعلان عن التحديثات الجديدة للتطبيق' },
  ];

  return (
    <AlertDialog open={open} onOpenChange={(v) => { if (!v) remindLater(); }}>
      <AlertDialogContent className="w-[min(calc(100vw-1.5rem),28rem)] max-h-[calc(100dvh-1.5rem)] overflow-y-auto" dir="rtl">
        <AlertDialogHeader className="text-start">
          <div className="w-12 h-12 rounded-2xl bg-primary/10 text-primary flex items-center justify-center mb-2">
            <Bell className="w-6 h-6" />
          </div>
          <AlertDialogTitle className="text-start">فعّل الإشعارات لتبقى على اطلاع</AlertDialogTitle>
          <AlertDialogDescription className="text-start">
            يستخدم PosFlow الإشعارات فقط للأمور المهمة لعمل متجرك:
          </AlertDialogDescription>
        </AlertDialogHeader>

        <ul className="space-y-2.5 py-1">
          {benefits.map(({ icon: Icon, text }) => (
            <li key={text} className="flex items-center gap-2.5 text-sm text-foreground">
              <span className="w-8 h-8 rounded-xl bg-muted flex items-center justify-center shrink-0">
                <Icon className="w-4 h-4 text-primary" />
              </span>
              <span>{text}</span>
            </li>
          ))}
        </ul>
        <p className="text-[11px] text-muted-foreground">
          يمكنك اختيار التنبيهات التي تريدها أو إيقافها في أي وقت من الإعدادات.
        </p>

        <AlertDialogFooter className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <AlertDialogCancel onClick={remindLater} className="mt-0">لاحقاً</AlertDialogCancel>
          <AlertDialogAction onClick={goToSettings}>تفعيل الإشعارات</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
