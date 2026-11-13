/**
 * حالة ربط تيليجرام للحساب: مؤكد / غير مؤكد، مع زر فتح البوت.
 * التيليجرام هو وسيلة استعادة كلمة المرور وتأكيد نقل الرقم، لذا نُنبّه العميل لربطه.
 */
import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Loader2, RefreshCw, Send, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/use-auth';
import { fetchTelegramLinked, getTelegramBotLink } from '@/lib/auth/phone-claim';
import { cn } from '@/lib/utils';

export function TelegramLinkCard({ className }: { className?: string }) {
  const { user } = useAuth();
  const [linked, setLinked] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setLinked(await fetchTelegramLinked(user.id));
    setLoading(false);
  }, [user]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!user) return null;

  const openBot = async () => {
    const link = await getTelegramBotLink();
    window.open(link, '_blank', 'noopener,noreferrer');
  };

  return (
    <div
      dir="rtl"
      className={cn(
        'rounded-2xl border p-3.5 space-y-2.5',
        linked ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-amber-500/50 bg-amber-500/10',
        className,
      )}
    >
      <div className="flex items-start gap-2.5">
        {linked ? <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" /> : <ShieldAlert className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />}
        <div className="space-y-0.5">
          <p className="text-sm font-bold text-foreground">
            {linked === null ? 'ربط تيليجرام' : linked ? 'تيليجرام مؤكَّد ✓' : 'تيليجرام غير مؤكَّد'}
          </p>
          <p className="text-xs text-muted-foreground leading-relaxed">
            {linked
              ? 'حسابك مربوط بتيليجرام: يمكنك استعادة كلمة المرور وتأكيد العمليات الحساسة من خلاله.'
              : 'اربط حسابك بتيليجرام الآن حتى تستطيع استعادة كلمة المرور إن نسيتها. افتح البوت واضغط «مشاركة رقم الهاتف للتحقق» بنفس الرقم المسجَّل في حسابك.'}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        {!linked && (
          <Button type="button" size="sm" className="h-8 rounded-xl text-xs gap-1.5" onClick={openBot}>
            <Send className="w-3.5 h-3.5" />
            فتح بوت تيليجرام
          </Button>
        )}
        <Button type="button" size="sm" variant="outline" className="h-8 rounded-xl text-xs gap-1.5" onClick={refresh} disabled={loading}>
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          تحديث الحالة
        </Button>
      </div>
    </div>
  );
}
