import React, { useState, useEffect, useCallback } from 'react';
import { useAppLock } from '@/hooks/use-app-lock';
import { useAuth } from '@/hooks/use-auth';
import { useLanguage } from '@/hooks/use-language';
import { App as CapApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { Lock, ShieldCheck, Delete, RotateCcw, Check, LogOut, AlertTriangle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
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

export function AppLockOverlay() {
  const { isLocked, unlockApp, isLockedOut, lockoutRemainingSeconds } = useAppLock();
  const { user, signOut } = useAuth();
  const { isRTL } = useLanguage();

  const [enteredPin, setEnteredPin] = useState<string>('');
  const [isVerifying, setIsVerifying] = useState<boolean>(false);
  const [isShaking, setIsShaking] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showExitConfirm, setShowExitConfirm] = useState<boolean>(false);

  // إعادة ضبط المدخلات عند فتح القفل أو تغييره
  useEffect(() => {
    if (!isLocked) {
      setEnteredPin('');
      setErrorMessage(null);
      setIsVerifying(false);
    }
  }, [isLocked]);

  // مصيدة زر الرجوع في أندرويد (Hardware Back Button Trap)
  useEffect(() => {
    if (!isLocked) return;

    let cleanup: (() => void) | null = null;

    if (Capacitor.isNativePlatform()) {
      CapApp.addListener('backButton', () => {
        // الخروج الآمن من التطبيق عند ضغط زر الرجوع أثناء القفل
        CapApp.exitApp();
      }).then((handle) => {
        cleanup = () => handle.remove();
      }).catch((err) => {
        console.warn('[AppLockOverlay] Failed to bind native backButton:', err);
      });
    }

    return () => {
      cleanup?.();
    };
  }, [isLocked]);

  const handleDigitPress = (digit: string) => {
    if (isLockedOut || isVerifying) return;
    if (enteredPin.length >= 8) return;
    setErrorMessage(null);
    setEnteredPin((prev) => prev + digit);
  };

  const handleBackspace = () => {
    if (isLockedOut || isVerifying) return;
    setErrorMessage(null);
    setEnteredPin((prev) => prev.slice(0, -1));
  };

  const handleClear = () => {
    if (isLockedOut || isVerifying) return;
    setErrorMessage(null);
    setEnteredPin('');
  };

  const handleSubmit = useCallback(async () => {
    if (isLockedOut || isVerifying || enteredPin.length < 4) return;

    setIsVerifying(true);
    setErrorMessage(null);

    try {
      const success = await unlockApp(enteredPin);
      if (!success) {
        setIsShaking(true);
        setErrorMessage('رمز PIN غير صحيح');
        setEnteredPin('');
        setTimeout(() => setIsShaking(false), 500);
      }
    } catch (err) {
      console.error('[AppLockOverlay] Verification error:', err);
      setErrorMessage('حدث خطأ أثناء التحقق');
      setEnteredPin('');
    } finally {
      setIsVerifying(false);
    }
  }, [enteredPin, isLockedOut, isVerifying, unlockApp]);

  // إرسال تلقائي عندما يصل الرمز إلى 4 أو أكثر ويضغط Enter
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (isLockedOut) return;
    if (e.key >= '0' && e.key <= '9') {
      handleDigitPress(e.key);
    } else if (e.key === 'Backspace') {
      handleBackspace();
    } else if (e.key === 'Enter') {
      void handleSubmit();
    }
  };

  if (!isLocked || !user) {
    return null;
  }

  return (
    <div
      role="dialog"
      data-state="open"
      aria-modal="true"
      aria-labelledby="app-lock-title"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className="fixed inset-0 z-[9999] flex flex-col items-center justify-between p-6 bg-background/95 backdrop-blur-md select-none touch-none animate-in fade-in duration-200"
      style={{ direction: isRTL ? 'rtl' : 'ltr' }}
    >
      {/* رأس الشاشة مع أيقونة الأمان */}
      <div className="flex flex-col items-center mt-6 text-center">
        <div className="relative mb-3 flex items-center justify-center w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 shadow-inner">
          <ShieldCheck className="w-9 h-9 text-primary animate-pulse" />
          <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-emerald-500 border-2 border-background flex items-center justify-center">
            <Lock className="w-2.5 h-2.5 text-white" />
          </div>
        </div>
        <h2 id="app-lock-title" className="text-xl font-bold tracking-tight text-foreground">
          {isRTL ? 'قفل أمان نقطة البيع' : 'POS Terminal Security Lock'}
        </h2>
        <p className="text-xs text-muted-foreground mt-1 max-w-[260px]">
          {isRTL
            ? 'يرجى إدخال رمز PIN لحماية ومتابعة سلة المبيعات الجارية'
            : 'Enter cashier PIN to resume active checkout terminal'}
        </p>
      </div>

      {/* مؤشر النقاط ورسائل الخطأ */}
      <div className="flex flex-col items-center my-auto w-full max-w-xs">
        {/* مؤشر النقاط للرمز */}
        <div
          className={`flex items-center justify-center gap-3 py-3 px-6 rounded-2xl bg-muted/40 border border-border/60 transition-transform ${
            isShaking ? 'animate-bounce' : ''
          }`}
        >
          {Array.from({ length: Math.max(4, enteredPin.length) }).map((_, i) => {
            const isFilled = i < enteredPin.length;
            return (
              <div
                key={i}
                className={`w-3.5 h-3.5 rounded-full transition-all duration-200 ${
                  isFilled
                    ? 'bg-primary scale-110 shadow-sm'
                    : 'bg-muted-foreground/30 scale-90'
                }`}
              />
            );
          })}
        </div>

        {/* رسائل التنبيه والخطأ */}
        <div className="h-7 mt-2 flex items-center justify-center text-center">
          {isLockedOut ? (
            <p className="text-xs font-semibold text-destructive animate-pulse flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5" />
              {isRTL
                ? `محاولات خاطئة متعددة. يرجى الانتظار ${lockoutRemainingSeconds} ثانية`
                : `Too many attempts. Wait ${lockoutRemainingSeconds}s`}
            </p>
          ) : errorMessage ? (
            <p className="text-xs font-medium text-destructive animate-in fade-in">
              {errorMessage}
            </p>
          ) : null}
        </div>

        {/* لوحة الأرقام اللمسية المحسنة للكاشير */}
        <div className="grid grid-cols-3 gap-3 w-full max-w-[280px] mt-2">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
            <Button
              key={digit}
              type="button"
              variant="outline"
              disabled={isLockedOut || isVerifying}
              onClick={() => handleDigitPress(digit)}
              className="h-14 rounded-2xl text-xl font-bold font-mono border-border/80 bg-card hover:bg-muted active:scale-95 transition-all shadow-sm"
            >
              {digit}
            </Button>
          ))}

          {/* زر مسح الكل */}
          <Button
            type="button"
            variant="ghost"
            disabled={isLockedOut || isVerifying || enteredPin.length === 0}
            onClick={handleClear}
            className="h-14 rounded-2xl text-xs font-medium text-muted-foreground hover:bg-muted/80 active:scale-95 transition-all"
            title={isRTL ? 'مسح الكل' : 'Clear All'}
          >
            <RotateCcw className="w-5 h-5" />
          </Button>

          {/* الرقم صفر */}
          <Button
            type="button"
            variant="outline"
            disabled={isLockedOut || isVerifying}
            onClick={() => handleDigitPress('0')}
            className="h-14 rounded-2xl text-xl font-bold font-mono border-border/80 bg-card hover:bg-muted active:scale-95 transition-all shadow-sm"
          >
            0
          </Button>

          {/* زر المسح التراجعي */}
          <Button
            type="button"
            variant="ghost"
            disabled={isLockedOut || isVerifying || enteredPin.length === 0}
            onClick={handleBackspace}
            className="h-14 rounded-2xl text-muted-foreground hover:bg-muted/80 active:scale-95 transition-all"
            title={isRTL ? 'مسح' : 'Backspace'}
          >
            <Delete className="w-5 h-5" />
          </Button>
        </div>

        {/* زر التأكيد والدخول الواضح */}
        <Button
          type="button"
          disabled={isLockedOut || isVerifying || enteredPin.length < 4}
          onClick={() => void handleSubmit()}
          className="w-full max-w-[280px] h-13 mt-4 rounded-xl text-base font-bold bg-emerald-600 hover:bg-emerald-700 text-white shadow-md active:scale-98 transition-all flex items-center justify-center gap-2"
        >
          {isVerifying ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : (
            <>
              <Check className="w-5 h-5 stroke-[2.5]" />
              <span>{isRTL ? 'تأكيد ودخول' : 'Confirm & Unlock'}</span>
            </>
          )}
        </Button>
      </div>

      {/* زر الطوارئ لتسجيل الخروج وتبديل الحساب */}
      <div className="mb-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setShowExitConfirm(true)}
          className="text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-lg flex items-center gap-1.5"
        >
          <LogOut className="w-3.5 h-3.5" />
          <span>{isRTL ? 'نسيت الرمز؟ تسجيل الخروج والتبديل' : 'Forgot PIN? Sign Out & Switch'}</span>
        </Button>
      </div>

      {/* حوار تأكيد الخروج الطارئ لحماية الفواتير المفتوحة */}
      <AlertDialog open={showExitConfirm} onOpenChange={setShowExitConfirm}>
        <AlertDialogContent className="rounded-2xl max-w-sm" style={{ direction: isRTL ? 'rtl' : 'ltr' }}>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="w-5 h-5" />
              <span>{isRTL ? 'تأكيد تسجيل الخروج' : 'Confirm Sign Out'}</span>
            </AlertDialogTitle>
            <AlertDialogDescription className="text-xs text-muted-foreground leading-relaxed mt-2">
              {isRTL
                ? 'سيؤدي تسجيل الخروج إلى تفريغ سلة المبيعات الجارية المفتوحة في الذاكرة ونقلك لشاشة تسجيل الدخول بالبريد وكلمة المرور. هل ترغب في المتابعة؟'
                : 'Signing out will clear any unsaved in-memory cart items and return you to the email/password login screen. Continue?'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2 sm:gap-0 mt-4">
            <AlertDialogCancel className="rounded-xl text-xs">
              {isRTL ? 'إلغاء والعودة' : 'Cancel'}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setShowExitConfirm(false);
                void signOut();
              }}
              className="rounded-xl text-xs bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isRTL ? 'نعم، تسجيل الخروج' : 'Yes, Sign Out'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
