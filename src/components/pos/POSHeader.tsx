import { ShoppingCart, Wrench, Store, Menu, MessageCircle, Settings } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { KeyboardShortcutsHelp } from './KeyboardShortcutsHelp';
import { useIsMobile } from '@/hooks/use-mobile';
import { useLanguage } from '@/hooks/use-language';
import { useUserRole } from '@/hooks/use-user-role';
import { useSupportUnread } from '@/hooks/use-support-unread';
import { cn } from '@/lib/utils';

interface POSHeaderProps {
  cartItemsCount: number;
  onCartClick: () => void;
  showCartButton?: boolean;
  activeMode?: 'products' | 'maintenance';
  onModeChange?: (mode: 'products' | 'maintenance') => void;
  hideMaintenance?: boolean;
  onMenuClick?: () => void; // إضافة زر المنيو المدمج
}

export function POSHeader({ 
  cartItemsCount, 
  onCartClick, 
  showCartButton = true,
  activeMode = 'products',
  onModeChange,
  hideMaintenance = false,
  onMenuClick
}: POSHeaderProps) {
  const isMobile = useIsMobile();
  const { t, tDynamic, language } = useLanguage();
  const isEn = language === 'en';
  const navigate = useNavigate();
  const { isBoss, isAdmin, canAccessSettings } = useUserRole();
  const supportUnread = useSupportUnread();

  return (
    <header className="h-auto min-h-[calc(3.5rem+var(--app-safe-top,0px))] md:min-h-20 flex items-center justify-between px-3 md:px-6 sticky top-0 z-20 pt-[var(--app-safe-top,0px)] shrink-0 bg-background/95 shadow-xs border-b border-border/40 transition-[transform,opacity] duration-300">
      {/* جهة اليمين (RTL): زر القائمة المدمج + عنوان نقطة البيع */}
      <div className="flex items-center gap-2 min-w-0 overflow-hidden">
        {/* زر فتح القائمة الجانبية المدمج للموبايل بدلاً من الزر العائم */}
        {isMobile && onMenuClick && (
          <button
            type="button"
            onClick={onMenuClick}
            aria-label={isEn ? "Main Menu" : "القائمة الرئيسية"}
            className="w-11 h-11 rounded-xl bg-muted/60 border border-border/40 text-foreground flex items-center justify-center shrink-0 hover:bg-muted active:scale-95 transition-opacity cursor-pointer"
          >
            <Menu className="w-5 h-5 text-foreground" />
          </button>
        )}

        {/* كبسولة العنوان */}
        <div className="flex items-center gap-2 px-2.5 py-1.5 md:px-3.5 md:py-1.5 rounded-xl md:rounded-full bg-muted/60 border border-border/40 shrink-0">
          <div className="w-6 h-6 md:w-7 md:h-7 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <Store className="w-3.5 h-3.5 md:w-4 md:h-4" />
          </div>
          <h1 className="text-xs md:text-base font-bold text-foreground whitespace-nowrap truncate tracking-tight" title={t('pos.title')}>
            {t('pos.title')}
          </h1>
        </div>


      </div>

      {/* جهة اليسار (RTL): التحكم المدمج للموبايل + اختصارات الديسكتوب والوصول السريع */}
      <div className="flex items-center gap-1.5 md:gap-2 shrink-0">
        {/* زر الدعم الفني والتواصل المباشر مع المطور */}
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate('/contact')}
          title={isEn ? "Contact Developer" : "التواصل مع المطور"}
          className="relative h-9 w-9 md:h-10 md:w-10 rounded-xl hover:bg-muted"
        >
          <MessageCircle className="w-4 h-4 md:w-5 md:h-5 text-muted-foreground hover:text-foreground transition-colors" />
          {supportUnread > 0 && (
            <span className="absolute top-1 end-1 min-w-[0.95rem] h-[0.95rem] px-0.5 rounded-full bg-destructive text-destructive-foreground text-[9px] font-bold flex items-center justify-center animate-pulse ring-2 ring-background">
              {supportUnread > 9 ? '9+' : supportUnread}
            </span>
          )}
        </Button>

        {/* زر الإعدادات السريعة للمدير */}
        {(isBoss || isAdmin || canAccessSettings) && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate('/settings')}
            title={isEn ? "Settings" : "الإعدادات"}
            className="h-9 w-9 md:h-10 md:w-10 rounded-xl hover:bg-muted"
          >
            <Settings className="w-4 h-4 md:w-5 md:h-5 text-muted-foreground hover:text-foreground transition-colors" />
          </Button>
        )}

        {/* زر اختصارات الكيبورد على الديسكتوب */}
        {!isMobile && <KeyboardShortcutsHelp />}
        
        {/* زر السلة على الموبايل إذا كان مطلوباً */}
        {showCartButton && (
          <Button
            variant="default"
            size="sm"
            onClick={onCartClick}
            className="md:hidden gap-1.5 h-11 px-3.5 rounded-xl relative cursor-pointer"
          >
            <ShoppingCart className="w-4 h-4" />
            <span className="text-xs">{t('pos.cart')}</span>
            {cartItemsCount > 0 && (
              <span className="absolute -top-1.5 ltr:-left-1.5 rtl:-right-1.5 w-5 h-5 rounded-full bg-destructive text-destructive-foreground text-[10px] flex items-center justify-center font-bold">
                {cartItemsCount}
              </span>
            )}
          </Button>
        )}
      </div>
    </header>
  );
}
