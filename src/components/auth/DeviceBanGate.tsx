/**
 * بوابة حظر الجهاز: إن كان الجهاز محظوراً تُعرض شاشة الحظر فقط بدل التطبيق كله،
 * مهما كان الإيميل المستخدم. تُفحص عند الإقلاع وعند العودة للتطبيق وكل 5 دقائق.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ShieldOff, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { checkDeviceBanned, isDeviceBannedLocally } from '@/lib/device-ban';

const DEVELOPER_URL = 'https://t.me/flowpospro';
const RECHECK_MS = 5 * 60 * 1000;

export function DeviceBanGate({ children }: { children: ReactNode }) {
  const [devUrl, setDevUrl] = useState(DEVELOPER_URL);
  const [banned, setBanned] = useState<boolean>(() => isDeviceBannedLocally());

  const recheck = useCallback(async () => {
    const res = await checkDeviceBanned();
    if (res !== null) setBanned(res);
  }, []);

  useEffect(() => {
    void recheck();
    const t = setInterval(() => { void recheck(); }, RECHECK_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') void recheck(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
    };
  }, [recheck]);

  useEffect(() => {
    if (!banned) return;
    supabase.from('app_settings').select('value').eq('key', 'contact_links').maybeSingle().then(({ data }) => {
      try {
        const p = JSON.parse(data?.value || '{}');
        const c = String(p._phone || p.telegram || '').trim();
        if (/^https?:\/\//i.test(c)) setDevUrl(c);
        else if (c.startsWith('@')) setDevUrl(`https://t.me/${c.slice(1)}`);
        else if (/^(t\.me|telegram\.me)\//i.test(c)) setDevUrl(`https://${c}`);
      } catch { /* ignore */ }
    });
  }, [banned]);

  if (!banned) return <>{children}</>;

  return (
    <div
      className="fixed inset-0 z-[100000] bg-background flex items-center justify-center p-6 pt-[calc(env(safe-area-inset-top,0px)+1.5rem)] pb-[calc(env(safe-area-inset-bottom,0px)+1.5rem)]"
      dir="rtl"
    >
      <div className="max-w-sm w-full text-center space-y-4 rounded-2xl border border-destructive/40 bg-card p-6 shadow-2xl">
        <ShieldOff className="w-14 h-14 mx-auto text-destructive" />
        <h1 className="text-xl font-black text-foreground">جهازك محظور</h1>
        <p className="text-sm text-muted-foreground leading-relaxed">
          تم حظر هذا الجهاز من استخدام التطبيق، ولا يمكن الدخول منه بأي حساب. للاستفسار تواصل مع المطور.
        </p>
        <Button className="w-full gap-2" onClick={() => window.open(devUrl, '_blank', 'noopener,noreferrer')}>
          <Send className="w-4 h-4" /> تواصل مع المطور
        </Button>
      </div>
    </div>
  );
}

export default DeviceBanGate;
